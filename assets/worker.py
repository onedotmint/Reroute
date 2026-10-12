"""Reroute remote supervisor and guarded source transport; Python 3 standard library only.

Not a security sandbox: the provider supplies isolation. This process supplies process-group
cleanup, framed binary stdio, source path checks and compare-before-write synchronization.
"""
import base64
from contextlib import contextmanager
import re
import hashlib
import hmac
import json
import os
import queue
import select
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

WRITE_LOCK = threading.Lock()
# Keep legacy machine-local state out of source transport during migration.
EXCLUDED = {'.git', '.reroute', '.reroute-runtime', '.outboard', '.outboard-runtime', 'node_modules', 'target', '.venv',
            'venv', 'dist', 'build', '.next', '.nuxt', '.turbo', 'coverage', '__pycache__',
            '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.gradle', '.idea',
            '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.npm', '.rustup', '.claude', '.codex', '.cursor', '.pi', '.omp', '.dsh', 'gcloud'}
SECRET_FILES = {'.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials',
                'credentials.json', 'secrets.json', 'id_rsa', 'id_ed25519', 'id_ecdsa',
                'service-account.json', 'application_default_credentials.json', '.modal.toml', 'auth.json'}


def emit(packet):
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(packet, separators=(',', ':')) + '\n')
        sys.stdout.flush()


def valid_sync_pattern(value):
    if not isinstance(value, str) or not value or re.search(r'[\[\]{}!\\\x00-\x1f\x7f]', value) or re.search(r'[?*+@]\(', value) or '..' in value or value.startswith('/'):
        return False
    parts = value.removesuffix('/').split('/')
    return all(p not in ('', '.') and ('**' not in p or p == '**') for p in parts)


def glob(pattern):
    if not valid_sync_pattern(pattern):
        raise ValueError('UNSUPPORTED_SYNC_PATTERN: use literals, *, ?, or a complete ** path segment')
    parts = pattern.removesuffix('/').split('/')
    source = ''
    for i, part in enumerate(parts):
        if part == '**':
            source += r'[\s\S]*' if i == len(parts) - 1 else r'(?:[^/]+/)*'
        else:
            source += ''.join('[^/]*' if c == '*' else '[^/]' if c == '?' else re.escape(c) for c in part)
            if i < len(parts) - 1:
                source += '/'
    return re.compile(source)


def validate_policy(policy):
    if not isinstance(policy, dict):
        raise ValueError('INVALID_SYNC_POLICY')
    if not isinstance(policy.get('excludes'), list) or not all(valid_sync_pattern(p) for p in policy['excludes']):
        raise ValueError('UNSUPPORTED_SYNC_PATTERN')
    if policy.get('hashMode', 'strict') not in ('strict', 'metadata'):
        raise ValueError('INVALID_HASH_MODE')
    if any(type(policy.get(k)) is not int or not 0 < policy[k] <= 9007199254740991 for k in ('maxFiles', 'maxFileBytes')):
        raise ValueError('INVALID_SYNC_LIMIT')


def excluded(path, policy):
    parts = path.split('/')
    if any(p in EXCLUDED or p in SECRET_FILES or p.startswith('.reroute-tmp-') or p == '.env' or p.startswith('.env.')
           or p.lower().endswith(('.pem', '.key', '.p12', '.pfx', '.keystore')) for p in parts):
        return True
    # Basename patterns apply at any depth; path patterns also protect descendants.
    for pattern in policy.get('excludes', []):
        matcher = glob(pattern)
        candidates = ['/'.join(parts[:i + 1]) for i in range(len(parts))] if '/' in pattern.removesuffix('/') else parts
        if any(matcher.fullmatch(p) for p in candidates):
            return True
    return False


def safe_path(root, relative, policy, artifact=False, check_links=True):
    if not isinstance(relative, str) or not relative or '\\' in relative or '\0' in relative:
        raise ValueError('UNSAFE_PATH')
    parts = relative.split('/')
    if artifact and (len(parts) < 2 or parts[0] not in ('target', 'dist', 'build', 'coverage', '.next', '.nuxt') or re.search(r'[\x00-\x1f\x7f*?\[\]{}]', relative)):
        raise ValueError('UNSAFE_ARTIFACT_PATH')
    blocked = excluded('/'.join(parts[1:]), policy) if artifact else excluded(relative, policy)
    if any(p in ('', '.', '..', '__proto__', 'prototype', 'constructor') for p in parts) or ':' in parts[0] or blocked:
        raise ValueError('UNSAFE_PATH')
    path = root
    for part in parts:
        path = os.path.join(path, part)
        if check_links and os.path.islink(path):
            raise ValueError('SYMLINK')
    return path


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_mtime_ns, info.st_size, info.st_mode)


@contextmanager
def file_parent(path, directory_fd=None):
    if directory_fd is not None:
        yield directory_fd, os.path.basename(path)
        return
    parts = os.path.abspath(path).split(os.sep)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    parent = os.open(os.sep, flags)
    try:
        for part in parts[1:-1]:
            child = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = child
        yield parent, parts[-1]
    finally:
        os.close(parent)


def read_stable(path, limit=None, consume=None, begin=None, allow_directory=False, directory_fd=None):
    with file_parent(path, directory_fd) as (parent, name):
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('SYMLINK')
        if allow_directory and stat.S_ISDIR(info.st_mode):
            return None
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('NOT_REGULAR_FILE')
        if limit is not None and info.st_size > limit:
            raise ValueError('FILE_TOO_LARGE')
        # Nonblocking open also rejects a regular-file-to-FIFO race without hanging.
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        h, size = hashlib.sha256(), 0
        with os.fdopen(fd, 'rb') as source:
            before = os.fstat(source.fileno())
            if fingerprint(info) != fingerprint(before) or not stat.S_ISREG(before.st_mode):
                raise ValueError('FILE_CHANGED')
            if begin:
                begin(before)
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > before.st_size or (limit is not None and size > limit):
                    raise ValueError('FILE_CHANGED_OR_TOO_LARGE')
                h.update(chunk)
                if consume:
                    consume(chunk)
            after = os.fstat(source.fileno())
        if size != before.st_size or fingerprint(before) != fingerprint(after) or fingerprint(before) != fingerprint(os.stat(name, dir_fd=parent, follow_symlinks=False)):
            raise ValueError('FILE_CHANGED')
        # A scan revalidates its shared directory fd after all files; other reads rewalk now.
        if directory_fd is None:
            with file_parent(path) as (current_parent, current_name):
                if fingerprint(before) != fingerprint(os.stat(current_name, dir_fd=current_parent, follow_symlinks=False)):
                    raise ValueError('FILE_CHANGED')
        return {'hash': h.hexdigest(), 'size': size, 'mode': before.st_mode & 0o777}


def digest(path, allow_directory=False):
    try:
        entry = read_stable(path, allow_directory=allow_directory)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return entry['hash'] if entry is not None else None


def ext4_root(root):
    # Linux mountinfo is read once; different-device nested mounts never reuse hashes.
    if not sys.platform.startswith('linux'):
        return False
    try:
        best, kind = '', None
        with open('/proc/self/mountinfo', encoding='utf8') as mounts:
            for line in mounts:
                before, after = line.rstrip().split(' - ', 1)
                mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), before.split()[4])
                if (root == mount or root.startswith(mount.rstrip('/') + '/')) and len(mount) > len(best):
                    best, kind = mount, after.split()[0]
        return kind == 'ext4'
    except (OSError, ValueError, IndexError):
        return False


def scan(root, policy, cache_request=None):
    validate_policy(policy)
    result, tokens = {}, {}
    cached_scan = cache_request is not None
    root_info = os.lstat(root)
    root_stamp = [str(x) for x in (root_info.st_dev, root_info.st_ino, root_info.st_ctime_ns)]
    cache_request = cache_request if isinstance(cache_request, dict) else {}
    key_text = cache_request.get('key', '')
    key = bytes.fromhex(key_text) if isinstance(key_text, str) and re.fullmatch('[a-f0-9]{64}', key_text) else b''
    old = cache_request.get('files', {})
    old = old if isinstance(old, dict) else {}
    trusted = bool(key) and policy.get('hashMode') == 'metadata' and ext4_root(root)

    def signature(rel, stamp, entry):
        data = json.dumps([root_stamp, rel, stamp, entry], sort_keys=True, separators=(',', ':')).encode('utf8')
        return hmac.new(key, data, hashlib.sha256).hexdigest()

    def inspect(path, rel, directory_fd):
        with file_parent(path, directory_fd) as (parent, name):
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('NOT_REGULAR_SOURCE')
            if before.st_size > policy['maxFileBytes']:
                raise ValueError('FILE_TOO_LARGE')
            stamp = [str(x) for x in fingerprint(before)]
            precise = before.st_mtime_ns % 1000000000 != 0 and before.st_ctime_ns % 1000000000 != 0
            eligible = trusted and precise and before.st_dev == root_info.st_dev
            token = old.get(rel)
            token = token if isinstance(token, dict) else {}
            cached = token.get('entry')
            valid = isinstance(cached, dict) and isinstance(cached.get('hash'), str) and re.fullmatch('[a-f0-9]{64}', cached['hash']) and type(cached.get('size')) is int and cached['size'] == before.st_size and type(cached.get('mode')) is int and cached['mode'] == before.st_mode & 0o777
            if eligible and valid and token.get('stamp') == stamp and isinstance(token.get('mac'), str) and hmac.compare_digest(token['mac'], signature(rel, stamp, cached)):
                assert isinstance(cached, dict)
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if fingerprint(os.fstat(fd)) != fingerprint(before) or fingerprint(os.stat(name, dir_fd=parent, follow_symlinks=False)) != fingerprint(before):
                        raise ValueError('FILE_CHANGED')
                finally:
                    os.close(fd)
                entry = {'hash': cached['hash'], 'size': cached['size'], 'mode': cached['mode']}
            else:
                entry = read_stable(path, limit=policy['maxFileBytes'], directory_fd=directory_fd)
            if fingerprint(os.stat(name, dir_fd=parent, follow_symlinks=False)) != fingerprint(before):
                raise ValueError('FILE_CHANGED')
            if eligible:
                tokens[rel] = {'stamp': stamp, 'entry': entry, 'mac': signature(rel, stamp, entry)}
            return entry

    def scan_error(error):
        raise error

    for directory, directories, files in os.walk(root, followlinks=False, onerror=scan_error):
        rel_dir = os.path.relpath(directory, root)
        prefix = '' if rel_dir == '.' else rel_dir.replace(os.sep, '/') + '/'
        directories[:] = [d for d in directories if not excluded(prefix + d, policy)]
        for entry in directories:
            if os.path.islink(os.path.join(directory, entry)):
                raise ValueError('SYMLINK_SOURCE: ' + prefix + entry)
        anchor = os.path.join(directory, '.reroute-tmp-scan-anchor')
        with file_parent(anchor) as (directory_fd, _):
            directory_info = os.fstat(directory_fd)
            for name in files:
                rel = prefix + name
                if excluded(rel, policy):
                    continue
                # The opened parent and no-follow file fd supply the link checks for this scan.
                path = safe_path(root, rel, policy, check_links=False)
                if len(result) >= policy['maxFiles']:
                    raise ValueError('TOO_MANY_FILES')
                result[rel] = inspect(path, rel, directory_fd) if trusted else read_stable(path, limit=policy['maxFileBytes'], directory_fd=directory_fd)
            with file_parent(anchor) as (named_fd, _):
                if fingerprint(directory_info) != fingerprint(os.fstat(named_fd)) or fingerprint(directory_info) != fingerprint(os.fstat(directory_fd)):
                    raise ValueError('DIRECTORY_CHANGED')
    if cached_scan:
        after = os.lstat(root)
        if root_stamp != [str(x) for x in (after.st_dev, after.st_ino, after.st_ctime_ns)]:
            tokens = {}
        return {'manifest': result, 'cache': tokens}
    return result


def stream_input():
    pending = b''
    deadline = time.monotonic() + 30
    while True:
        if not select.select([0], [], [], max(0, deadline - time.monotonic()))[0]:
            raise ValueError('STREAM_IDLE_TIMEOUT')
        chunk = os.read(0, 4096)
        if not chunk:
            raise ValueError('STREAM_DISCONNECTED')
        pending += chunk
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            if len(line) > 100 * 1024:
                raise ValueError('STREAM_FRAME_LIMIT')
            frame = json.loads(line)
            if not isinstance(frame, dict):
                raise ValueError('INVALID_STREAM_FRAME')
            yield frame
            deadline = time.monotonic() + 30
        if len(pending) > 100 * 1024:
            raise ValueError('STREAM_FRAME_LIMIT')


def read_stream(request, root, controls):
    if request.get('action') != 'read_stream' or type(request.get('artifact', False)) is not bool:
        raise ValueError('INVALID_STREAM_REQUEST')
    policy = request['policy']
    validate_policy(policy)
    artifact = request.get('artifact', False)
    if artifact and policy['maxFileBytes'] > 32 * 1024 * 1024:
        raise ValueError('ARTIFACT_LIMIT')
    relative = request['path']
    path = safe_path(root, relative, policy, artifact=artifact)
    if len(relative.encode('utf8')) > 4096:
        raise ValueError('STREAM_PATH_LIMIT')
    sequence = 0

    def begin(info):
        emit({'type': 'file_start', 'path': relative, 'size': info.st_size, 'mode': info.st_mode & 0o777})

    def consume(chunk):
        nonlocal sequence
        emit({'type': 'file_chunk', 'path': relative, 'seq': sequence, 'data': base64.b64encode(chunk).decode('ascii')})
        ack = next(controls)
        if type(ack.get('seq')) is not int or ack != {'type': 'file_ack', 'path': relative, 'seq': sequence}:
            raise ValueError('INVALID_STREAM_ACK')
        sequence += 1

    entry = read_stable(path, limit=policy['maxFileBytes'], consume=consume, begin=begin)
    assert isinstance(entry, dict)
    safe_path(root, relative, policy, artifact=artifact)
    emit({'type': 'file_end', 'path': relative, 'seq': sequence, 'hash': entry['hash'], 'size': entry['size'], 'mode': entry['mode']})
    emit({'type': 'file_result', 'path': relative, 'ok': True})


def remove_empty_tree(root, relative, policy):
    directories = []

    def visit(rel):
        path = safe_path(root, rel, policy)
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise ValueError('NOT_EMPTY_DIRECTORY: ' + rel)
        # Validate the whole tree first, including excluded entries, before any removal.
        for name in os.listdir(path):
            visit(rel + '/' + name)
        directories.append(rel)

    visit(relative)
    for rel in directories:
        os.rmdir(safe_path(root, rel, policy))


def rpc(request, root):
    policy = request['policy']
    validate_policy(policy)
    action = request['action']
    if action == 'artifact':
        if not 0 < policy['maxFileBytes'] <= 32 * 1024 * 1024:
            raise ValueError('ARTIFACT_LIMIT')
        path = safe_path(root, request['path'], policy, artifact=True)
        data = bytearray()
        entry = read_stable(path, limit=policy['maxFileBytes'], consume=data.extend)
        assert isinstance(entry, dict)
        return {'data': base64.b64encode(data).decode('ascii'), 'hash': entry['hash'], 'size': entry['size'], 'mode': entry['mode']}
    if action == 'scan':
        return scan(root, policy)
    if action == 'scan_cached':
        return scan(root, policy, request.get('cache', {}))
    if action == 'read':
        result = {}
        if not isinstance(request['paths'], list) or len(request['paths']) > policy['maxFiles']:
            raise ValueError('TOO_MANY_FILES')
        for rel in request['paths']:
            path = safe_path(root, rel, policy)
            data = bytearray()
            read_stable(path, limit=policy['maxFileBytes'], consume=data.extend)
            result[rel] = base64.b64encode(data).decode('ascii')
        return result
    if action == 'apply':
        prepared = []
        for change in request['changes']:
            path = safe_path(root, change['path'], policy)
            if digest(path, allow_directory=True) != change['expected']:
                raise ValueError('SYNC_RACE: ' + change['path'])
            data = None if change['data'] is None else base64.b64decode(change['data'], validate=True)
            if data is not None and len(data) > policy['maxFileBytes']:
                raise ValueError('FILE_TOO_LARGE')
            prepared.append((change, path, data))
        # Preparation is read-only; replacements happen only after planned deletions.
        prepared.sort(key=lambda item: item[2] is not None)
        for change, path, data in prepared:
            safe_path(root, change['path'], policy)
            current = digest(path, allow_directory=True)
            if current != change['expected']:
                raise ValueError('SYNC_RACE: ' + change['path'])
            if current is not None:
                backup_dir = os.path.join(root, '.reroute-runtime', 'backups')
                os.makedirs(backup_dir, mode=0o700, exist_ok=True)
                with open(path, 'rb') as source, open(os.path.join(backup_dir, str(uuid.uuid4())), 'xb') as backup:
                    backup.write(source.read())
            if data is None:
                safe_path(root, change['path'], policy)
                if digest(path, allow_directory=True) != change['expected']:
                    raise ValueError('SYNC_RACE: ' + change['path'])
                if current is not None:
                    os.unlink(path)
            else:
                if os.path.isdir(path):
                    remove_empty_tree(root, change['path'], policy)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                safe_path(root, change['path'], policy)
                temp = os.path.join(os.path.dirname(path), '.reroute-tmp-' + str(uuid.uuid4()) + '.tmp')
                try:
                    with open(temp, 'xb') as target:
                        target.write(data)
                    os.chmod(temp, change.get('mode', 0o644) & 0o777)
                    safe_path(root, change['path'], policy)
                    if digest(path, allow_directory=True) != change['expected']:
                        raise ValueError('SYNC_RACE: ' + change['path'])
                    os.replace(temp, path)
                finally:
                    if os.path.exists(temp):
                        os.unlink(temp)
        return {'ok': True}
    raise ValueError('UNKNOWN_RPC')


def prepare_cwd(requested, root):
    if not isinstance(requested, str) or '\0' in requested or not os.path.isabs(requested):
        raise ValueError('INVALID_CWD')
    cwd = os.path.abspath(requested)
    if os.path.commonpath([root, cwd]) != root:
        raise ValueError('CWD_OUTSIDE_PROJECT')
    relative = os.path.relpath(cwd, root)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in ([] if relative == '.' else relative.split(os.sep)):
            # Directory-relative creation cannot follow a substituted symlink parent.
            try:
                os.mkdir(part, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            info = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('SYMLINK_CWD')
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError('CWD_NOT_DIRECTORY')
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
    finally:
        os.close(descriptor)
    return cwd


def execute(request, root):
    argv = request['argv']
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) and '\0' not in v for v in argv):
        raise ValueError('INVALID_ARGV')
    cwd = prepare_cwd(request['cwd'], root)
    env = os.environ.copy()
    env.update(request.get('env', {}))
    env['REROUTE_REMOTE'] = '1'
    try:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, bufsize=0)
    except (FileNotFoundError, PermissionError) as error:
        if not os.path.isdir(cwd):
            code, message = 72, 'Remote working directory unavailable: ' + cwd + '\n'
        else:
            code = 127 if isinstance(error, FileNotFoundError) else 126
            message = ('Executable not found on remote runtime' if code == 127 else 'Remote executable permission denied') + ': ' + argv[0] + '\n'
        emit({'type': 'output', 'stream': 'stderr', 'data': base64.b64encode(message.encode()).decode('ascii')})
        emit({'type': 'exit', 'code': code, 'timedOut': False, 'cancelled': False})
        return
    last_ping = [time.monotonic()]
    cause = [None]
    stopped = threading.Event()
    stdin_frames = queue.Queue(maxsize=8)

    def terminate(reason):
        if cause[0] is None:
            cause[0] = reason
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def handle_signal(_sig, _frame):
        terminate('cancelled')

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGHUP, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    def input_lines():
        # Avoid BufferedReader locks held by a daemon thread at interpreter exit.
        pending = b''
        while True:
            chunk = os.read(0, 32768)
            if not chunk:
                return
            pending += chunk
            if len(pending) > 1024 * 1024:
                raise ValueError('STDIN_FRAME_LIMIT')
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                yield line

    def controls():
        try:
            for line in input_lines():
                if len(line) > 1024 * 1024:
                    terminate('protocol')
                    return
                frame = json.loads(line)
                if not isinstance(frame, dict):
                    raise ValueError('INVALID_CONTROL_FRAME')
                kind = frame.get('type')
                if kind == 'ping':
                    last_ping[0] = time.monotonic()
                elif kind == 'cancel':
                    terminate('cancelled')
                elif kind == 'stdin':
                    data = base64.b64decode(frame['data'], validate=True)
                    if len(data) > 32768:
                        raise ValueError('STDIN_FRAME_LIMIT')
                    stdin_frames.put_nowait(data)
                elif kind == 'eof':
                    stdin_frames.put_nowait(None)
                else:
                    raise ValueError('UNKNOWN_CONTROL_FRAME')
            if not stopped.is_set():
                terminate('disconnected')
        except (ValueError, OSError, TypeError, KeyError, queue.Full):
            terminate('protocol')

    def write_stdin():
        # A bounded acknowledged window keeps stdin from blocking control-frame reads.
        try:
            while not stopped.is_set():
                data = stdin_frames.get()
                if data is None:
                    assert process.stdin is not None
                    process.stdin.close()
                    return
                assert process.stdin is not None
                view = memoryview(data)
                try:
                    while view:
                        view = view[os.write(process.stdin.fileno(), view):]
                except BrokenPipeError:
                    pass
                emit({'type': 'stdin_ack'})
        except (ValueError, OSError):
            if not stopped.is_set():
                terminate('disconnected')

    def output(stream, name):
        while True:
            data = os.read(stream.fileno(), 32768)
            if not data:
                return
            try:
                emit({'type': 'output', 'stream': name, 'data': base64.b64encode(data).decode('ascii')})
            except (BrokenPipeError, OSError):
                terminate('disconnected')
                return

    emit({'type': 'started'})
    threading.Thread(target=controls, daemon=True).start()
    threading.Thread(target=write_stdin, daemon=True).start()
    threads = [threading.Thread(target=output, args=(process.stdout, 'stdout'), daemon=True),
               threading.Thread(target=output, args=(process.stderr, 'stderr'), daemon=True)]
    for thread in threads:
        thread.start()
    started = time.monotonic()
    timeout = request.get('timeoutMs', 0) / 1000
    terminated_at = None
    while process.poll() is None:
        now = time.monotonic()
        if timeout and now - started >= timeout:
            terminate('timeout')
        if now - last_ping[0] > 45:
            terminate('disconnected')
        if cause[0] and terminated_at is None:
            terminated_at = now
        if terminated_at is not None and now - terminated_at > 2:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.05)
    stopped.set()
    # Kill descendants that inherited output pipes or were backgrounded by the command.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for thread in threads:
        thread.join(timeout=2)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    code = process.returncode
    result = {'type': 'exit', 'code': code if code >= 0 else 128 - code,
              'timedOut': cause[0] == 'timeout', 'cancelled': cause[0] in ('cancelled', 'disconnected')}
    if code < 0:
        result['signal'] = signal.Signals(-code).name
    emit(result)


def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    if request['op'] == 'rpc_stream':
        root_path = request['root']
        frame = sys.stdin.buffer.readline(64 * 1024 * 1024)
        if not frame.endswith(b'\n'):
            raise ValueError('RPC_FRAME_LIMIT')
        request = json.loads(frame)
        request['root'] = root_path
    root = os.path.abspath(os.path.expanduser(request['root']))
    if os.path.realpath(root) != root:
        raise ValueError('SYMLINK_ROOT')
    if not os.path.isdir(root):
        raise ValueError('WORKSPACE_MISSING: restart the runtime before retrying')
    if request['op'] == 'exec':
        execute(request, root)
    elif request['op'] == 'rpc':
        emit({'type': 'rpc', 'value': rpc(request, root)})
    elif request['op'] == 'file_stream':
        controls = stream_input()
        read_stream(next(controls), root, controls)
    else:
        raise ValueError('UNKNOWN_OPERATION')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        emit({'type': 'error', 'code': 'REMOTE_WORKER', 'message': str(error)[:240]})
        sys.exit(74)
