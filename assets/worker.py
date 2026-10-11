"""Reroute remote supervisor and guarded source transport; Python 3 standard library only.

Not a security sandbox: the provider supplies isolation. This process supplies process-group
cleanup, framed binary stdio, source path checks and compare-before-write synchronization.
"""
import base64
import fnmatch
import hashlib
import json
import os
import queue
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


def excluded(path, policy):
    parts = path.split('/')
    if any(p in EXCLUDED or p in SECRET_FILES or p.startswith('.reroute-tmp-') or p == '.env' or p.startswith('.env.')
           or p.lower().endswith(('.pem', '.key', '.p12', '.pfx', '.keystore')) for p in parts):
        return True
    return any(fnmatch.fnmatchcase(path, pattern) or any(fnmatch.fnmatchcase(p, pattern) for p in parts)
               for pattern in policy.get('excludes', []))


def safe_path(root, relative, policy):
    if not isinstance(relative, str) or not relative or '\\' in relative or '\0' in relative:
        raise ValueError('UNSAFE_PATH')
    parts = relative.split('/')
    if any(p in ('', '.', '..', '__proto__', 'prototype', 'constructor') for p in parts) or ':' in parts[0] or excluded(relative, policy):
        raise ValueError('UNSAFE_PATH')
    path = root
    for part in parts:
        path = os.path.join(path, part)
        if os.path.islink(path):
            raise ValueError('SYMLINK')
    return path


def digest(path, allow_directory=False):
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    if stat.S_ISLNK(info.st_mode):
        raise ValueError('SYMLINK')
    if allow_directory and stat.S_ISDIR(info.st_mode):
        return None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('NOT_REGULAR_FILE')
    h = hashlib.sha256()
    with open(path, 'rb') as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def scan(root, policy):
    result = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(directory, root)
        prefix = '' if rel_dir == '.' else rel_dir.replace(os.sep, '/') + '/'
        directories[:] = [d for d in directories if not excluded(prefix + d, policy)]
        for entry in directories:
            if os.path.islink(os.path.join(directory, entry)):
                raise ValueError('SYMLINK_SOURCE: ' + prefix + entry)
        for name in files:
            rel = prefix + name
            if excluded(rel, policy):
                continue
            path = safe_path(root, rel, policy)
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('NOT_REGULAR_SOURCE')
            if info.st_size > policy['maxFileBytes']:
                raise ValueError('FILE_TOO_LARGE: ' + rel)
            result[rel] = {'hash': digest(path), 'size': info.st_size, 'mode': info.st_mode & 0o777}
            if len(result) > policy['maxFiles']:
                raise ValueError('TOO_MANY_FILES')
    return result


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
    action = request['action']
    if action == 'scan':
        return scan(root, policy)
    if action == 'read':
        result = {}
        for rel in request['paths']:
            path = safe_path(root, rel, policy)
            if os.stat(path).st_size > policy['maxFileBytes']:
                raise ValueError('FILE_TOO_LARGE')
            with open(path, 'rb') as source:
                result[rel] = base64.b64encode(source.read()).decode('ascii')
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
                    process.stdin.close()
                    return
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
    else:
        raise ValueError('UNKNOWN_OPERATION')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        emit({'type': 'error', 'code': 'REMOTE_WORKER', 'message': str(error)[:240]})
        sys.exit(74)
