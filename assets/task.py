"""One-shot Linux input verifier / descendant supervisor. No daemon or sync protocol.
Files travel through rsync or the provider's filesystem API. Never copy source back.
"""
import base64
import ctypes
import hashlib
import gzip
import io
import json
import os
import pathlib
import re
import shutil
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


def read(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write(path, value):
    temp = str(path) + '.tmp-' + str(os.getpid())
    with open(temp, 'x', encoding='utf-8') as f:
        json.dump(value, f)
    os.replace(temp, path)


def safe(path):
    if not isinstance(path, str) or not path or path.startswith('/') or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path) or any(p in ('', '.', '..') for p in path.split('/')):
        raise ValueError('Unsafe input or artifact path')
    return path


def clean_path(path):
    path = pathlib.Path(path)
    for p in [path] + list(path.parents):
        if p.is_symlink():
            raise ValueError('Symlink path refused: ' + str(p))
    return path


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(262144), b''):
            h.update(chunk)
    return h.hexdigest()


def entries(directory):
    found = {}
    for folder, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            p = pathlib.Path(folder) / name
            if p.is_symlink() or not (p.is_file() or p.is_dir()):
                raise ValueError('Non-regular input/artifact: ' + str(p))
        for name in files:
            p = pathlib.Path(folder) / name
            found[p.relative_to(directory).as_posix()] = p
    return found


def verify(directory, manifest):
    actual = entries(directory)
    if set(actual) != set(manifest):
        raise ValueError('Incomplete or unexpected input files; execution refused')
    for name, info in manifest.items():
        p = actual[name]
        if p.stat().st_size != info['size'] or sha(p) != info['sha256']:
            raise ValueError('Input checksum mismatch: ' + name)
        os.chmod(p, info['mode'] & 0o777)


def proc(pid):
    try:
        s = pathlib.Path('/proc', str(pid), 'stat').read_text()
        fields = s[s.rfind(')') + 2:].split()
        return {'state': fields[0], 'parent': int(fields[1]), 'group': int(fields[2]), 'start': fields[19]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def group_alive(group):
    for p in pathlib.Path('/proc').iterdir():
        if p.name.isdigit():
            s = proc(int(p.name))
            if s and s['group'] == group and s['state'] not in ('Z', 'X'):
                return True
    return False


def descendants():
    processes = {int(p.name): proc(int(p.name)) for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()}
    owned = {os.getpid()}
    while True:
        added = {pid for pid, info in processes.items() if info and info['parent'] in owned} - owned
        if not added:
            break
        owned.update(added)
    return {pid: info for pid, info in processes.items() if pid != os.getpid() and pid in owned and info and info['state'] not in ('Z', 'X')}


def terminate_group(group):
    for sig, delay in [(signal.SIGTERM, 1.0), (signal.SIGKILL, 2.0)]:
        until = time.monotonic() + delay
        while time.monotonic() < until:
            children = descendants()
            if not group_alive(group) and not children:
                return True
            # A reused PGID is not task ownership; signal only verified descendants.
            for pid, info in children.items():
                current = proc(pid)
                if current and current['start'] == info['start']:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            time.sleep(.05)
    return not group_alive(group) and not descendants()


# Only download stores cross sandbox lifetimes; build output stays on local scratch.
DOWNLOAD_DIRS = ('npm/_cacache', 'pnpm', 'bun', 'cargo/registry', 'cargo/git')
CACHE_EXCLUDED = {'node_modules', 'cargo-target', 'work', 'jobs'}
CACHE_ARCHIVE_LIMIT = 256 * 1024 * 1024
CACHE_EXPANDED_LIMIT = 1024 * 1024 * 1024
CACHE_SECONDS_LIMIT = 120
CACHE_VOLUME_PATH = pathlib.Path('/var/reroute-cache')
MODAL_VOLUME_ROOT = pathlib.Path('/__modal/volumes')


def cache_operation(operation, *args):
    # Both cache phases must fit the provider's five-minute execution safety margin.
    def expired(signum, frame):
        raise TimeoutError('Cache operation exceeded its time limit')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, CACHE_SECONDS_LIMIT)
    try:
        return operation(*args)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def download_path(name):
    safe(name)
    if any(part in CACHE_EXCLUDED for part in name.split('/')) or not any(name == p or name.startswith(p + '/') for p in DOWNLOAD_DIRS):
        raise ValueError('Not a download cache path: ' + name)
    return name


def cache_archive(volume, key):
    if not isinstance(key, str) or not re.fullmatch('[a-f0-9]{64}', key):
        raise ValueError('Invalid cache key')
    volume = pathlib.Path(volume)
    if volume == CACHE_VOLUME_PATH and volume.is_symlink():
        # Only Modal's fixed mount alias is trusted; targets and cache files must remain link-free.
        clean_path(volume.parent)
        target = pathlib.Path(os.readlink(volume))
        if target.parent != MODAL_VOLUME_ROOT or not re.fullmatch('vo-[A-Za-z0-9]+', target.name):
            raise ValueError('Unexpected cache Volume mount')
        volume = target
    return clean_path(volume / (key + '.tgz'))


class CacheReader(io.BufferedReader):
    def __init__(self, source):
        super().__init__(source)
        self.size = 0
        self.tail = b''

    def read(self, size=None):
        remaining = CACHE_EXPANDED_LIMIT - self.size + 1
        chunk = super().read(remaining if size is None or size < 0 else min(size, remaining))
        self.size += len(chunk)
        self.tail = (self.tail + chunk)[-1024:]
        if self.size > CACHE_EXPANDED_LIMIT:
            raise ValueError('Cache exceeds 1 GiB expanded limit')
        return chunk


def cache_generations(volume, key):
    legacy = cache_archive(volume, key)
    if not legacy.parent.is_dir():
        raise ValueError('Cache Volume directory is unavailable')
    pattern = re.compile(re.escape(key) + r'\.[a-f0-9]{32}\.([a-f0-9]{64})\.tgz')
    found = []
    for path in legacy.parent.glob(key + '.*.tgz'):
        match = pattern.fullmatch(path.name)
        if match:
            path = clean_path(path)
            found.append((path, match[1]))
    return sorted(found, key=lambda item: item[0].stat().st_mtime_ns, reverse=True)


class CacheFailure(RuntimeError):
    pass


def cache_failure(stage, error):
    # Exceptions may contain private source paths or provider credentials; never serialize them.
    detail = type(error).__name__
    if isinstance(error, CacheFailure):
        return str(error)
    if isinstance(error, OSError) and error.errno is not None:
        detail += ' errno=' + str(error.errno) + ' (' + os.strerror(error.errno) + ')'
    elif isinstance(error, TimeoutError):
        detail += ' (time limit)'
    elif str(error) in ('Cache exceeds 1 GiB expanded limit', 'Cache exceeds 256 MiB archive limit'):
        detail += ': ' + str(error)
    return stage + ': ' + detail


def restore_cache(cache, volume, key):
    archive = cache_archive(volume, key)
    generations = cache_generations(volume, key)
    invalid = False
    for candidate, digest in generations:
        if candidate.is_file() and candidate.stat().st_size <= CACHE_ARCHIVE_LIMIT and sha(candidate) == digest:
            archive = candidate
            break
        invalid = True
    else:
        if not archive.exists():
            if invalid:
                raise ValueError('No complete cache generation')
            return False
    if not archive.is_file() or archive.stat().st_size > CACHE_ARCHIVE_LIMIT:
        raise ValueError('Invalid or oversized cache archive')
    cache = clean_path(cache)
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Stage the entire archive before touching a usable local cache on a corrupt miss.
    with tempfile.TemporaryDirectory(prefix='.cache-restore-', dir=cache.parent) as temporary:
        stage = pathlib.Path(temporary)
        total = end = 0
        with gzip.open(archive, 'rb') as compressed:
            stream = CacheReader(compressed)
            with tarfile.open(fileobj=stream, mode='r|') as tf:
                for member in tf:
                    name = safe(member.name)
                    if name in DOWNLOAD_DIRS and not member.isdir():
                        raise ValueError('Download cache root must be a directory')
                    if not (member.isdir() and any(p.startswith(name + '/') for p in DOWNLOAD_DIRS)):
                        download_path(name)
                    if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or member.sparse is not None or member.size < 0 or (member.isdir() and member.size):
                        raise ValueError('Non-regular cache member: ' + name)
                    total += member.size
                    end = member.offset_data + ((member.size + 511) // 512) * 512
                    if total > CACHE_EXPANDED_LIMIT:
                        raise ValueError('Cache exceeds 1 GiB expanded limit')
                    destination = clean_path(stage / name)
                    if member.isdir():
                        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                    else:
                        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        source = tf.extractfile(member)
                        if source is None:
                            raise ValueError('Missing cache file payload: ' + name)
                        with source, open(destination, 'xb') as output:
                            shutil.copyfileobj(source, output, 262144)
                        os.chmod(destination, 0o600 | (member.mode & 0o100))
            # tar's end marker alone does not validate the gzip checksum/trailer.
            while stream.read(262144):
                pass
            if stream.size < end + 1024 or stream.tail != bytes(1024):
                raise ValueError('Incomplete cache tar trailer')
        for name in DOWNLOAD_DIRS:
            source = stage / name
            destination = clean_path(cache / name)
            if source.exists():
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if destination.exists():
                    shutil.rmtree(destination)
                source.rename(destination)
    return True


def save_cache(cache, volume, key):
    stage = 'volume-list'
    published = None
    verified = False
    def scan_failed(error):
        raise error
    try:
        generations = cache_generations(volume, key)
        cache = clean_path(cache)
        stage = 'scratch-stage'
        # FUSE Volumes are not POSIX scratch: stage privately, publish only ordinary files.
        with tempfile.TemporaryDirectory(prefix='.cache-save-', dir=cache.parent) as temporary:
            output = pathlib.Path(temporary) / 'cache.tgz'
            total = 0
            stage = 'scratch-archive'
            with open(output, 'xb') as raw:
                os.fchmod(raw.fileno(), 0o600)
                with tarfile.open(fileobj=raw, mode='w:gz', dereference=False) as tf:
                    for name in DOWNLOAD_DIRS:
                        source = clean_path(cache / name)
                        if not source.exists():
                            continue
                        if not source.is_dir():
                            raise ValueError('Download cache must be a directory: ' + name)
                        for folder, dirs, files in os.walk(source, followlinks=False, onerror=scan_failed):
                            dirs[:] = [n for n in dirs if n not in CACHE_EXCLUDED]
                            for path in [pathlib.Path(folder)] + [pathlib.Path(folder) / n for n in files if n not in CACHE_EXCLUDED]:
                                path = clean_path(path)
                                relative = download_path(path.relative_to(cache).as_posix())
                                info = tf.gettarinfo(str(path), arcname=relative)
                                if not (info.isdir() or info.isreg()):
                                    raise ValueError('Non-regular download cache: ' + relative)
                                total += info.size
                                if total > CACHE_EXPANDED_LIMIT:
                                    raise ValueError('Cache exceeds 1 GiB expanded limit')
                                if info.isreg():
                                    with open(path, 'rb') as data:
                                        tf.addfile(info, data)
                                else:
                                    tf.addfile(info)
                                if tf.offset + 10240 > CACHE_EXPANDED_LIMIT:
                                    raise ValueError('Cache exceeds 1 GiB expanded limit')
                                if raw.tell() > CACHE_ARCHIVE_LIMIT:
                                    raise ValueError('Cache exceeds 256 MiB archive limit')
                if raw.tell() > CACHE_ARCHIVE_LIMIT:
                    raise ValueError('Cache exceeds 256 MiB archive limit')
                stage = 'scratch-fsync'
                raw.flush()
                os.fsync(raw.fileno())
            digest = sha(output)
            destination = cache_archive(volume, key).with_name(key + '.' + uuid.uuid4().hex + '.' + digest + '.tgz')
            stage = 'volume-open'
            with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as target:
                published = destination
                stage = 'volume-write'
                with open(output, 'rb') as source:
                    shutil.copyfileobj(source, target, 262144)
                stage = 'volume-close'
            stage = 'volume-readback'
            if destination.stat().st_size != output.stat().st_size or sha(destination) != digest:
                raise ValueError('Cache readback mismatch')
            verified = True
            stage = 'scratch-cleanup'
        # Only a verified new generation permits retiring old ones; no rename/overwrite on FUSE.
        try:
            retained = False
            for path, old_digest in generations:
                if not retained and path.is_file() and path.stat().st_size <= CACHE_ARCHIVE_LIMIT and sha(path) == old_digest:
                    retained = True
                    continue
                path.unlink()
        except Exception as error:
            return 'Cache cleanup failed: ' + cache_failure('volume-prune', error)
    except Exception as error:
        message = cache_failure(stage, error)
        if published is not None and not verified:
            try:
                published.unlink(missing_ok=True)
            except Exception as cleanup:
                message += '; ' + cache_failure('volume-discard', cleanup)
        raise CacheFailure(message) from error



def main(action, data):
    root = clean_path(data['root'])
    if not root.is_absolute() or root == pathlib.Path('/'):
        raise ValueError('Absolute isolated workspace required')
    if action == 'boot':
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
        clean_path(root)
        if root.stat().st_uid != os.getuid():
            raise ValueError('Workspace belongs to a different user')
        marker = root / '.reroute-v3'
        if not marker.exists():
            if any(root.iterdir()):
                raise ValueError('Refusing to adopt a nonempty unmarked workspace')
            try:
                with open(marker, 'x') as f:
                    f.write('reroute-v3\n')
            except FileExistsError:
                pass
        if marker.read_text() != 'reroute-v3\n':
            raise ValueError('Unknown workspace marker')
        os.chmod(root, 0o700)
        for folder in ['input', 'jobs', 'cache']:
            (root / folder).mkdir(exist_ok=True, mode=0o700)
        return {'ready': True}
    if not (root / '.reroute-v3').is_file() or (root / '.reroute-v3').read_text() != 'reroute-v3\n':
        raise ValueError('Not a Reroute v3 workspace')
    identity = data['id']
    if not re.fullmatch('[0-9a-f-]{36}', identity):
        raise ValueError('Invalid task ID')
    job = clean_path(root / 'jobs' / identity)
    lock = root / 'lock'
    receipt = job / 'receipt.json'
    work = clean_path(root / 'work')
    work_owner = clean_path(root / 'work-owner')

    metrics = {'cacheHit': False, 'cacheSaved': False, 'cacheRestoreMs': 0, 'cacheSaveMs': 0, 'executionMs': 0}
    cache_warning = []
    cache = persistent = None

    def unlock():
        if lock.is_dir() and (lock / 'owner').read_text() == identity:
            shutil.rmtree(lock)

    def finish(status, code):
        result = {'status': status, 'code': code, 'scope': 'supervised-descendants', 'finishedAt': time.time()}
        if status != 'unknown' and work.exists():
            if not work_owner.is_file() or work_owner.read_text() != identity:
                status, code = 'unknown', 125
                result.update(status=status, code=code, error='Execution directory ownership is unconfirmed; retained without changes')
            else:
                # Archive only this task after descendant termination is confirmed.
                clean_path(work).rename(job / 'work')
                work_owner.unlink()
        if status != 'unknown' and persistent:
            started = time.monotonic()
            try:
                warning = cache_operation(save_cache, cache, persistent, key)
                metrics['cacheSaved'] = True
                if warning:
                    cache_warning.append(warning)
            except Exception as error:
                cache_warning.append('Cache save failed: ' + cache_failure('save', error))
            finally:
                metrics['cacheSaveMs'] = (time.monotonic() - started) * 1000
        result['metrics'] = metrics
        if cache_warning:
            result['cacheWarning'] = '; '.join(cache_warning)
        write(receipt, result)
        if status != 'unknown':
            unlock()
        return result

    if action == 'acquire':
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            raise RuntimeError('BUSY: this project has an active or unresolved task; inspect reroute jobs')
        (lock / 'owner').write_text(identity)
        job.mkdir(mode=0o700)
        return {'acquired': True}
    if action == 'status':
        if receipt.exists():
            return read(receipt)
        info = read(job / 'process.json') if (job / 'process.json').exists() else None
        if info:
            current = proc(info['supervisor'])
            return {'status': 'running' if current and current['start'] == info['start'] and current['state'] not in ('Z','X') else 'unknown'}
        return {'status': 'preparing' if job.exists() else 'unknown'}
    if action == 'cancel':
        if receipt.exists():
            return read(receipt)
        (job / 'cancel').touch(exist_ok=True)
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if receipt.exists():
                return read(receipt)
            time.sleep(.1)
        return {'status': 'unknown', 'error': 'Cancellation requested, but termination is not confirmed'}
    if action == 'artifact':
        if not receipt.exists() or read(receipt)['status'] == 'unknown':
            raise ValueError('Artifacts require a confirmed terminal task')
        name = safe(data['path'])
        base = job / ('outputs' if name.startswith('@outputs/') else 'work')
        name = name[len('@outputs/'):] if name.startswith('@outputs/') else name
        source = clean_path(base / safe(name))
        if not source.exists():
            raise ValueError('Artifact not found')
        if source.is_dir():
            entries(source)
        elif not source.is_file():
            raise ValueError('Artifact is not a regular file/directory')
        output = job / ('artifact-' + str(uuid.uuid4()) + '.tgz')
        with open(output, 'xb') as archive, tarfile.open(fileobj=archive, mode='w:gz', dereference=False) as tf:
            tf.add(source, arcname=source.name, recursive=True)
        if output.stat().st_size > 256 * 1024 * 1024:
            output.unlink()
            raise ValueError('Artifact exceeds 256 MiB transfer limit')
        return {'path': str(output), 'bytes': output.stat().st_size, 'sha256': sha(output)}
    if action == 'cleanup':
        if not receipt.exists() or read(receipt)['status'] == 'unknown':
            raise ValueError('Unresolved task retained; do not delete active or unknown state')
        shutil.rmtree(job)
        return {'removed': identity}
    if not lock.is_dir() or (lock / 'owner').read_text() != identity:
        raise ValueError('Task does not own the workspace lock')
    if action == 'abort-prepare':
        if (job / 'process.json').exists():
            raise ValueError('Cannot abort preparation after process start')
        return finish('cancelled', 130)
    request = read(job / 'request.json')
    manifest = {}
    for item in request['files']:
        name = safe(item['path'])
        if name in manifest or not re.fullmatch('[a-f0-9]{64}', item['sha256']) or not isinstance(item['size'], int) or item['size'] < 0 or not isinstance(item['mode'], int):
            raise ValueError('Invalid manifest')
        manifest[name] = item
    seed = clean_path(root / 'input')
    if action == 'stage':
        existing = entries(seed)
        for name, path in existing.items():
            if name not in manifest:
                path.unlink()
        for folder, dirs, files in os.walk(seed, topdown=False):
            for name in dirs:
                path = pathlib.Path(folder) / name
                if not any(path.iterdir()):
                    path.rmdir()
        for name in manifest:
            (seed / name).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        previous = read(root / 'baseline.json') if (root / 'baseline.json').exists() else {}
        return {'needed': [name for name, item in manifest.items() if previous.get(name) != item or not (seed / name).is_file()]}
    if action == 'seal':
        try:
            verify(seed, manifest)
            write(root / 'baseline.json', manifest)
            if work.exists():
                raise ValueError('Unresolved execution directory retained; refusing to overwrite it')
            if work_owner.exists():
                raise ValueError('Stale execution ownership marker retained')
            with open(work_owner, 'x') as f:
                f.write(identity)
            shutil.copytree(seed, work)
            (job / 'outputs').mkdir(mode=0o700)
            (job / 'sealed').touch()
            return {'sealed': True}
        except Exception:
            finish('failed', 125)
            raise
    if action != 'run':
        raise ValueError('Unknown supervisor operation')
    if receipt.exists() or (job / 'process.json').exists() or not (job / 'sealed').exists():
        raise ValueError('Task already started or input not sealed')
    if (job / 'cancel').exists():
        return finish('cancelled', 130)
    if not work_owner.is_file() or work_owner.read_text() != identity:
        raise ValueError('Task does not own the execution directory')
    verify(work, manifest)
    key = request['cacheKey']
    if not re.fullmatch('[a-f0-9]{64}', key):
        raise ValueError('Invalid cache key')
    persistent = request.get('persistentCache')
    if persistent is not None and persistent != '/var/reroute-cache':
        raise ValueError('Persistent cache must be /var/reroute-cache')
    cache = clean_path(root / 'cache' / key)
    for directory in ['npm','pnpm','cargo','cargo-target','xdg','pycache','bun']:
        clean_path(cache / directory).mkdir(parents=True, exist_ok=True, mode=0o700)
    if persistent:
        started = time.monotonic()
        try:
            metrics['cacheHit'] = cache_operation(restore_cache, cache, persistent, key)
        except Exception as error:
            cache_warning.append('Cache restore failed (miss): ' + cache_failure('restore', error))
        finally:
            metrics['cacheRestoreMs'] = (time.monotonic() - started) * 1000
    cwd = request['cwd']
    workdir = work if cwd == '.' else clean_path(work / safe(cwd))
    env = dict(os.environ)
    env.update({'CARGO_HOME': str(cache / 'cargo'), 'CARGO_TARGET_DIR': str(cache / 'cargo-target'), 'npm_config_cache': str(cache / 'npm'), 'npm_config_store_dir': str(cache / 'pnpm'), 'XDG_CACHE_HOME': str(cache / 'xdg'), 'PYTHONPYCACHEPREFIX': str(cache / 'pycache'), 'REROUTE_ARTIFACTS': str(job / 'outputs'), 'REROUTE_JOB_ID': identity, 'BUN_INSTALL_CACHE_DIR': str(cache / 'bun'), 'PATH': str(workdir / 'node_modules' / '.bin') + os.pathsep + str(work / 'node_modules' / '.bin') + os.pathsep + env.get('PATH', '')})
    timeout = float(request['timeoutSeconds'])
    if not 0 < timeout <= 86400:
        raise ValueError('Invalid task timeout')
    command = request['command']
    prepare = request.get('prepare')
    if prepare:
        directory = prepare['cwd']
        directory = work if directory == '.' else clean_path(work / safe(directory))
        argv = prepare['argv']
        if argv[0] not in ('npm', 'pnpm', 'yarn', 'bun'):
            raise ValueError('Unsupported dependency preparation')
        if argv[0] == 'pnpm':
            argv += ['--store-dir', str(cache / 'pnpm')]
        # Per-task dependency directories avoid stale workspace symlinks; downloads are cached.
        command = '(cd ' + shlex.quote(str(directory)) + ' && ' + shlex.join(argv) + ') && ' + command
    if (job / 'cancel').exists():
        persistent = None
        return finish('cancelled', 130)
    # Adopt daemonized orphans too; PGID alone misses setsid()/setpgid() descendants.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'Cannot supervise task descendants')
    execution_started = time.monotonic()
    child = subprocess.Popen(['bash', '-c', command], cwd=workdir, env=env, start_new_session=True)
    write(job / 'process.json', {'supervisor': os.getpid(), 'start': proc(os.getpid())['start'], 'child': child.pid})
    until = time.monotonic() + timeout
    interrupted = [False]
    def interrupt(signum, frame):
        interrupted[0] = True
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupt)
    reason = None
    while child.poll() is None:
        if interrupted[0] or (job / 'cancel').exists():
            reason = 'cancelled'
            break
        if time.monotonic() >= until:
            reason = 'timed_out'
            break
        time.sleep(.05)
    # Reap background and detached descendants before publishing caches or a terminal receipt.
    confirmed = terminate_group(child.pid)
    metrics['executionMs'] = (time.monotonic() - execution_started) * 1000
    if not confirmed:
        return finish('unknown', 125)
    try:
        code = child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return finish('unknown', 125)
    metrics['executionMs'] = (time.monotonic() - execution_started) * 1000
    if code < 0:
        code = 128 - code
    return finish(reason or 'exited', 130 if reason == 'cancelled' else 124 if reason == 'timed_out' else code)


if __name__ == '__main__':
    try:
        result = main(sys.argv[1], json.loads(base64.b64decode(sys.argv[2])))
        if sys.argv[1] != 'run':
            print(json.dumps(result))
        sys.exit(result.get('code', 0) if sys.argv[1] == 'run' else 0)
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(125)
