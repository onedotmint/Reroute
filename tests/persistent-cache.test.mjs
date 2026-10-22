import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../assets/task.py', import.meta.url));
// Native component coverage only: no SDK, build output, cloud, or real mounted Volume.
const setup = String.raw`
import gzip, hashlib, importlib.util, io, json, os, pathlib, shutil, sys, tarfile, uuid
spec = importlib.util.spec_from_file_location('reroute_task', sys.argv[1])
task = importlib.util.module_from_spec(spec)
spec.loader.exec_module(task)
base = pathlib.Path(sys.argv[2])
root, volume = base / 'scratch', base / 'volume'
volume.mkdir()
key = 'a' * 64
restore, save = task.restore_cache, task.save_cache

def restore_local(cache, mounted, cache_key):
    assert mounted == '/var/reroute-cache'
    return restore(cache, volume, cache_key)

def save_local(cache, mounted, cache_key):
    assert mounted == '/var/reroute-cache'
    owner = (root / 'lock' / 'owner').read_text()
    process = task.read(root / 'jobs' / owner / 'process.json')
    assert not task.group_alive(process['child']), 'saved before process group stopped'
    return save(cache, volume, cache_key)

task.restore_cache, task.save_cache = restore_local, save_local

def run(command, **extra):
    task.main('boot', {'root': str(root)})
    identity = str(uuid.uuid4())
    data = {'root': str(root), 'id': identity}
    task.main('acquire', data)
    job = root / 'jobs' / identity
    content = b'private project source\n'
    request = {'files': [{'path': 'source.txt', 'sha256': hashlib.sha256(content).hexdigest(), 'size': len(content), 'mode': 0o600}],
               'command': command, 'cwd': '.', 'timeoutSeconds': 5, 'cacheKey': key, 'persistentCache': '/var/reroute-cache', **extra}
    task.write(job / 'request.json', request)
    task.main('stage', data)
    (root / 'input' / 'source.txt').write_bytes(content)
    task.main('seal', data)
    result = task.main('run', data)
    assert task.read(job / 'receipt.json') == result
    if result['status'] != 'unknown':
        assert not (root / 'lock').exists()
    return result

def saved_archive():
    return next(volume.glob(key + '.*.tgz'))

def archive(members):
    for path in volume.glob(key + '.*.tgz'):
        path.unlink()
    with tarfile.open(volume / (key + '.tgz'), 'w:gz') as tf:
        for name, kind, payload in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                info.linkname = str(base / 'escaped')
            info.size = len(payload) if kind == tarfile.REGTYPE else 0
            tf.addfile(info, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
`;

async function python(t, body) {
  const base = await mkdtemp(join(tmpdir(), 'reroute-persistent-cache-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = await exec('python3', ['-B', '-c', setup + '\n' + body, helper, base], { timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.stderr, '');
}

test('download caches survive cold/warm runs and scratch reconstruction, but target/source/jobs never persist', async t => {
  await python(t, String.raw`
cold = run('''
set -eu
mkdir -p "$npm_config_cache/_cacache" "$npm_config_store_dir/node_modules" "$BUN_INSTALL_CACHE_DIR" "$CARGO_HOME/registry" "$CARGO_HOME/git" "$CARGO_TARGET_DIR" node_modules
printf npm > "$npm_config_cache/_cacache/blob"
printf pnpm > "$npm_config_store_dir/blob"
printf bun > "$BUN_INSTALL_CACHE_DIR/blob"
printf registry > "$CARGO_HOME/registry/blob"
printf git > "$CARGO_HOME/git/blob"
printf compiled > "$CARGO_TARGET_DIR/compiled"
printf secret > node_modules/private
printf secret > "$npm_config_store_dir/node_modules/private"
printf log > "$npm_config_cache/task.log"
''')
assert cold['code'] == 0 and cold['status'] == 'exited'
assert cold['metrics']['cacheHit'] is False
for metric in ('cacheRestoreMs', 'cacheSaveMs', 'executionMs'):
    assert cold['metrics'][metric] > 0, cold
assert 'cacheWarning' not in cold
with tarfile.open(saved_archive()) as tf:
    names = tf.getnames()
    assert {'npm/_cacache/blob', 'pnpm/blob', 'bun/blob', 'cargo/registry/blob', 'cargo/git/blob'} <= set(names)
    for name in names:
        assert not {'node_modules', 'cargo-target', 'source.txt', 'work', 'jobs', 'task.log'} & set(name.split('/')), name
    assert all(m.isdir() or m.isreg() for m in tf)
warm = run('test "$(cat "$CARGO_TARGET_DIR/compiled")" = compiled; test "$(cat "$CARGO_HOME/registry/blob")" = registry')
assert warm['code'] == 0 and warm['metrics']['cacheHit'] is True
shutil.rmtree(root)
rebuilt = run('''
set -eu
test ! -e "$CARGO_TARGET_DIR/compiled"
test "$(cat "$npm_config_cache/_cacache/blob")" = npm
test "$(cat "$npm_config_store_dir/blob")" = pnpm
test "$(cat "$BUN_INSTALL_CACHE_DIR/blob")" = bun
test "$(cat "$CARGO_HOME/registry/blob")" = registry
test "$(cat "$CARGO_HOME/git/blob")" = git
test ! -e node_modules
test ! -e "$npm_config_store_dir/node_modules"
''')
assert rebuilt['code'] == 0 and rebuilt['metrics']['cacheHit'] is True, rebuilt
assert not list(volume.glob('.cache-*'))
`);
});

test('streaming restore refuses traversal, links, special files and non-download paths without partial cache writes', async t => {
  await python(t, String.raw`
cache = root / 'cache' / key
(cache / 'npm' / '_cacache').mkdir(parents=True)
(cache / 'npm' / '_cacache' / 'existing').write_text('keep')
bad = [
    ('../escaped', tarfile.REGTYPE),
    (str(base / 'escaped'), tarfile.REGTYPE),
    ('npm/_cacache/../../escaped', tarfile.REGTYPE),
    ('npm//_cacache/blob', tarfile.REGTYPE),
    ('npm\\_cacache\\blob', tarfile.REGTYPE),
    ('npm/_cacache/link', tarfile.SYMTYPE),
    ('npm/_cacache/link', tarfile.LNKTYPE),
    ('npm/_cacache/fifo', tarfile.FIFOTYPE),
    ('npm/_cacache/device', tarfile.CHRTYPE),
    ('npm/_cacache/device', tarfile.BLKTYPE),
    ('cargo-target/compiled', tarfile.REGTYPE),
    ('pnpm/node_modules/source', tarfile.REGTYPE),
    ('source.txt', tarfile.REGTYPE),
    ('work/source.txt', tarfile.REGTYPE),
    ('jobs/receipt.json', tarfile.REGTYPE),
]
bad += [(name, tarfile.REGTYPE) for name in task.DOWNLOAD_DIRS]
for name, kind in bad:
    archive([('npm/_cacache/partial', tarfile.REGTYPE, b'not committed'), (name, kind, b'bad')])
    try:
        restore(cache, volume, key)
        raise AssertionError('accepted malicious archive: ' + name)
    except (ValueError, tarfile.TarError):
        pass
    assert (cache / 'npm' / '_cacache' / 'existing').read_text() == 'keep'
    assert not (cache / 'npm' / '_cacache' / 'partial').exists()
    assert not (base / 'escaped').exists()
assert not list(cache.parent.glob('.cache-restore-*'))
# Existing on-disk symlinks must not redirect an otherwise valid cache entry.
archive([('npm/_cacache/blob', tarfile.REGTYPE, b'valid')])
shutil.rmtree(cache / 'npm')
(cache / 'npm').symlink_to(base, target_is_directory=True)
try:
    restore(cache, volume, key)
    raise AssertionError('accepted symlink destination')
except ValueError:
    pass
assert not (base / '_cacache').exists()
`);
});

test('damaged gzip/tar and declared oversized downloads are explicit safe misses, never false hits', async t => {
  await python(t, String.raw`
path = volume / (key + '.tgz')
archive([('npm/_cacache/blob', tarfile.REGTYPE, b'valid')])
valid = path.read_bytes()
# Include checksum-only damage after tar's end marker, not just a corrupt header.
corruptions = [b'not gzip', valid[:len(valid)//2], valid[:-8] + bytes([valid[-8] ^ 255]) + valid[-7:], gzip.compress(gzip.decompress(valid)[:1024])]
for content in corruptions:
    for generation in volume.glob(key + '.*.tgz'):
        generation.unlink()
    path.write_bytes(content)
    result = run('exit 0')
    assert result['code'] == 0 and result['metrics']['cacheHit'] is False, result
    assert 'Cache restore failed (miss)' in result['cacheWarning'], result
    assert not (root / 'cache' / key / 'npm' / '_cacache' / 'blob').exists()
# A declared size is checked before reading/allocating its payload.
for generation in volume.glob(key + '.*.tgz'):
    generation.unlink()
with gzip.open(path, 'wb') as compressed:
    info = tarfile.TarInfo('pnpm/huge')
    info.size = task.CACHE_EXPANDED_LIMIT + 1
    compressed.write(info.tobuf())
result = run('exit 0')
assert result['metrics']['cacheHit'] is False and 'expanded limit' in result['cacheWarning'], result
`);
});

test('archive/save limits and write failures retain the last good archive and the task exit code', async t => {
  await python(t, String.raw`
first = run('mkdir -p "$CARGO_HOME/registry"; printf keep > "$CARGO_HOME/registry/blob"')
assert first['code'] == 0
path = saved_archive()
previous = path.read_bytes()
# Lower constants only inside this imported test module, never through request data.
task.CACHE_ARCHIVE_LIMIT = 1
failed = run('exit 7')
assert failed['status'] == 'exited' and failed['code'] == 7, failed
assert failed['metrics']['cacheHit'] is False and failed['metrics']['cacheSaveMs'] > 0
assert 'Cache restore failed' in failed['cacheWarning'] and 'Cache save failed' in failed['cacheWarning']
assert path.read_bytes() == previous
assert not list(volume.glob('.cache-save-*'))
task.CACHE_ARCHIVE_LIMIT = 256 * 1024 * 1024
task.CACHE_EXPANDED_LIMIT = 1
failed = run('exit 9')
assert failed['code'] == 9 and 'expanded limit' in failed['cacheWarning'], failed
assert path.read_bytes() == previous
# A read-only/unavailable Volume must not turn exit 11 into a supervisor error.
def unavailable(*args):
    raise OSError('volume unavailable')
task.save_cache = unavailable
failed = run('exit 11')
assert failed['code'] == 11 and 'save: OSError' in failed['cacheWarning'], failed
assert failed['metrics']['cacheSaved'] is False
`);
});

test('background children terminate before saving; timeout and cancellation keep their receipt status', async t => {
  await python(t, String.raw`
result = run('sleep 30 & exit 7')
assert result['code'] == 7 and 'cacheWarning' not in result, result
result = run('sleep 30', timeoutSeconds=0.1)
assert result['status'] == 'timed_out' and result['code'] == 124, result
assert result['metrics']['executionMs'] >= 100
assert 'cacheWarning' not in result
result = run('touch ../jobs/"$REROUTE_JOB_ID"/cancel; sleep 30')
assert result['status'] == 'cancelled' and result['code'] == 130, result
assert 'cacheWarning' not in result
`);
});

test('production requests cannot choose an arbitrary persistent path; local target reuse works without persistence', async t => {
  await python(t, String.raw`
for value in (str(volume), '', False, {}, ['/var/reroute-cache']):
    try:
        run('touch SHOULD_NOT_RUN', persistentCache=value)
        raise AssertionError('accepted arbitrary persistent cache: ' + str(value))
    except ValueError as error:
        assert 'Persistent cache must be /var/reroute-cache' in str(error)
    assert not (root / 'work' / 'SHOULD_NOT_RUN').exists()
    shutil.rmtree(root)
first = run('printf local > "$CARGO_TARGET_DIR/compiled"', persistentCache=None)
second = run('test "$(cat "$CARGO_TARGET_DIR/compiled")" = local', persistentCache=None)
assert first['code'] == second['code'] == 0
assert second['metrics']['cacheSaveMs'] == second['metrics']['cacheRestoreMs'] == 0
assert not list(volume.iterdir())
`);
});

test('unconfirmed termination or changed work ownership retain locks and never publish a cache', async t => {
  await python(t, String.raw`
terminate = task.terminate_group
task.terminate_group = lambda group: False
result = run('exit 0')
assert result['status'] == 'unknown' and result['code'] == 125, result
assert (root / 'lock').exists() and (root / 'work').exists()
assert result['metrics']['cacheSaveMs'] == 0 and not list(volume.iterdir())
shutil.rmtree(root)
task.terminate_group = terminate
result = run('printf changed > ../work-owner')
assert result['status'] == 'unknown' and result['code'] == 125, result
assert (root / 'lock').exists() and (root / 'work').exists()
assert result['metrics']['cacheSaveMs'] == 0 and not list(volume.iterdir())
`);
});

test('slow Volume operations are bounded misses/warnings and cannot consume the task or leave an alarm armed', async t => {
  await python(t, String.raw`
import time, signal
task.CACHE_SECONDS_LIMIT = 0.05
original_restore = task.restore_cache
previous = signal.getsignal(signal.SIGALRM)
def stalled(*args):
    time.sleep(10)
task.restore_cache = stalled
result = run('sleep 0.2; exit 0')
assert result['code'] == 0 and result['metrics']['cacheHit'] is False, result
assert 'Cache restore failed' in result['cacheWarning'] and 'time limit' in result['cacheWarning'], result
assert signal.getsignal(signal.SIGALRM) == previous and signal.getitimer(signal.ITIMER_REAL)[0] == 0
task.restore_cache = original_restore
task.save_cache = stalled
result = run('exit 7')
assert result['code'] == 7 and result['status'] == 'exited', result
assert 'Cache save failed' in result['cacheWarning'] and 'time limit' in result['cacheWarning'], result
assert signal.getsignal(signal.SIGALRM) == previous and signal.getitimer(signal.ITIMER_REAL)[0] == 0
`);
});

test('FUSE-like Volume rejects directory/metadata/rename operations but saves and restores downloads', async t => {
  await python(t, String.raw`
import errno
from unittest.mock import patch
attempts = []
def on_volume(path):
    return pathlib.Path(path).is_relative_to(volume)
def restricted(name):
    original = getattr(os, name)
    def call(*args, **kwargs):
        path = pathlib.Path('/proc/self/fd', str(args[0])).resolve() if name == 'fchmod' else pathlib.Path(args[0])
        if on_volume(path) and (name != 'mkdir' or path != volume):
            attempts.append(name)
            raise PermissionError(errno.EPERM, 'Operation not permitted', str(path))
        return original(*args, **kwargs)
    return call
from contextlib import ExitStack
with ExitStack() as patches:
    for name in ('mkdir', 'chmod', 'fchmod', 'chown', 'rename', 'replace', 'symlink'):
        patches.enter_context(patch.object(os, name, restricted(name)))
    cold = run('mkdir -p "$npm_config_cache/_cacache"; printf download > "$npm_config_cache/_cacache/blob"')
    assert cold['code'] == 0 and 'cacheWarning' not in cold, cold
    assert cold['metrics']['cacheSaved'] is True, cold
    shutil.rmtree(root)
    warm = run('test "$(cat "$npm_config_cache/_cacache/blob")" = download')
    assert warm['code'] == 0 and warm['metrics']['cacheHit'] is True, warm
    assert warm['metrics']['cacheSaved'] is True, warm
assert not attempts, attempts
`);
});

test('failed archive publication preserves prior cache, records the stage/errno and redacts exception paths', async t => {
  await python(t, String.raw`
import errno
from unittest.mock import patch
run('mkdir -p "$CARGO_HOME/registry"; printf keep > "$CARGO_HOME/registry/blob"')
prior = saved_archive()
previous = prior.read_bytes()
private = '/private/customer/CREDENTIAL_VALUE'
def failure():
    return PermissionError(errno.EPERM, 'PRIVATE_TOKEN', private)
original_open, original_copy, original_fdopen, original_sha = os.open, shutil.copyfileobj, os.fdopen, task.sha
for stage in ('volume-open', 'volume-write', 'volume-close', 'volume-readback'):
    def opening(path, *args, **kwargs):
        if pathlib.Path(path).is_relative_to(volume):
            raise failure()
        return original_open(path, *args, **kwargs)
    def copying(source, target, *args, **kwargs):
        if pathlib.Path('/proc/self/fd', str(target.fileno())).resolve().is_relative_to(volume):
            target.write(b'partial')
            raise failure()
        return original_copy(source, target, *args, **kwargs)
    class Closing:
        def __init__(self, file): self.file = file
        def __enter__(self): return self.file.__enter__()
        def __exit__(self, *args):
            self.file.__exit__(*args)
            raise failure()
    def fdopening(fd, *args, **kwargs):
        remote = pathlib.Path('/proc/self/fd', str(fd)).resolve().is_relative_to(volume)
        file = original_fdopen(fd, *args, **kwargs)
        return Closing(file) if remote else file
    def hashing(path):
        if pathlib.Path(path).is_relative_to(volume) and pathlib.Path(path) != prior:
            raise failure()
        return original_sha(path)
    target, name, replacement = {
        'volume-open': (os, 'open', opening),
        'volume-write': (shutil, 'copyfileobj', copying),
        'volume-close': (os, 'fdopen', fdopening),
        'volume-readback': (task, 'sha', hashing),
    }[stage]
    with patch.object(target, name, replacement):
        failed = run('printf changed > "$CARGO_HOME/registry/blob"; exit 7')
    assert failed['status'] == 'exited' and failed['code'] == 7, failed
    assert failed['metrics']['cacheSaved'] is False and failed['metrics']['cacheSaveMs'] > 0, failed
    assert stage in failed['cacheWarning'] and 'errno=1' in failed['cacheWarning'], failed
    assert private not in json.dumps(failed) and 'PRIVATE_TOKEN' not in json.dumps(failed), failed
    assert prior.read_bytes() == previous and list(volume.iterdir()) == [prior]
    assert not list((root / 'cache').glob('.cache-save-*'))
shutil.rmtree(root)
restored = run('test "$(cat "$CARGO_HOME/registry/blob")" = keep')
assert restored['code'] == 0 and restored['metrics']['cacheHit'] is True, restored
`);
});

test('unverified interrupted generations never become hits; legacy archives remain readable', async t => {
  await python(t, String.raw`
archive([('npm/_cacache/blob', tarfile.REGTYPE, b'legacy')])
legacy = volume / (key + '.tgz')
# Simulate interruption, where no exception handler got to discard a partial generation.
partial = volume / (key + '.' + uuid.uuid4().hex + '.' + 'b' * 64 + '.tgz')
partial.write_bytes(b'incomplete')
result = run('test "$(cat "$npm_config_cache/_cacache/blob")" = legacy')
assert result['code'] == 0 and result['metrics']['cacheHit'] is True, result
assert result['metrics']['cacheSaved'] is True and not partial.exists(), result
legacy.unlink()
for path in volume.iterdir():
    path.write_bytes(b'incomplete')
shutil.rmtree(root)
result = run('test ! -e "$npm_config_cache/_cacache/blob"; exit 0')
assert result['code'] == 0 and result['metrics']['cacheHit'] is False, result
assert 'Cache restore failed' in result['cacheWarning'], result
`);
});

test('cache pruning failure warns separately after verified publication, without a false save failure', async t => {
  await python(t, String.raw`
import errno
from unittest.mock import patch
run('exit 0')
prior = saved_archive()
run('exit 0')
unlink = pathlib.Path.unlink
def denied(path, *args, **kwargs):
    if path == prior:
        raise PermissionError(errno.EPERM, 'PRIVATE_TOKEN', '/private/source')
    return unlink(path, *args, **kwargs)
with patch.object(pathlib.Path, 'unlink', denied):
    result = run('exit 0')
assert result['code'] == 0 and result['metrics']['cacheSaved'] is True, result
assert 'Cache cleanup failed: volume-prune' in result['cacheWarning'], result
assert 'Cache save failed' not in result['cacheWarning'] and '/private' not in result['cacheWarning'], result
assert prior.exists() and len(list(volume.iterdir())) == 3
`);
});

test('successful publication retains one verified fallback and bounds generations for the same key', async t => {
  await python(t, String.raw`
run('mkdir -p "$CARGO_HOME/registry"; printf first > "$CARGO_HOME/registry/blob"')
first = saved_archive()
run('printf second > "$CARGO_HOME/registry/blob"')
assert first.exists() and len(list(volume.iterdir())) == 2
second = next(path for path in volume.iterdir() if path != first)
run('printf third > "$CARGO_HOME/registry/blob"')
assert not first.exists() and second.exists() and len(list(volume.iterdir())) == 2
latest = next(path for path in volume.iterdir() if path != second)
# A new mount may not expose the most recent write; the verified prior generation remains usable.
latest.unlink()
shutil.rmtree(root)
result = run('test "$(cat "$CARGO_HOME/registry/blob")" = second')
assert result['code'] == 0 and result['metrics']['cacheHit'] is True, result
`);
});

test('unreadable download subtrees fail saving instead of silently publishing an incomplete archive', async t => {
  await python(t, String.raw`
import errno
from unittest.mock import patch
run('mkdir -p "$CARGO_HOME/registry/nested"; printf keep > "$CARGO_HOME/registry/nested/blob"')
prior = saved_archive()
previous = prior.read_bytes()
scandir = os.scandir
def unreadable(path):
    if not isinstance(path, int) and pathlib.Path(path) == root / 'cache' / key / 'cargo/registry/nested':
        raise PermissionError(errno.EACCES, 'PRIVATE_TOKEN', '/private/customer')
    return scandir(path)
with patch.object(os, 'scandir', unreadable):
    result = run('exit 7')
assert result['status'] == 'exited' and result['code'] == 7, result
assert result['metrics']['cacheSaved'] is False, result
assert 'scratch-archive' in result['cacheWarning'] and 'errno=13' in result['cacheWarning'], result
assert 'PRIVATE_TOKEN' not in result['cacheWarning'] and '/private' not in result['cacheWarning'], result
assert prior.read_bytes() == previous and list(volume.iterdir()) == [prior]
`);
});

test('cancellation during cache restore never starts the project command',async t=>{
  await python(t, String.raw`
def cancel_during_restore(cache, mounted, cache_key):
    owner = (root / 'lock' / 'owner').read_text()
    (root / 'jobs' / owner / 'cancel').touch()
    return False

task.restore_cache = cancel_during_restore
result = run('touch SHOULD_NOT_START')
assert result['status'] == 'cancelled' and result['code'] == 130, result
assert not list(root.glob('jobs/*/work/SHOULD_NOT_START'))
assert not list(root.glob('jobs/*/process.json'))
assert not list(volume.iterdir())
`);
});

test('unsupported descendant supervision fails closed before executing project code',async t=>{
  await python(t, String.raw`
class NoSubreaper:
    def prctl(self, *args):
        return -1

task.ctypes.CDLL = lambda *args, **kwargs: NoSubreaper()
task.ctypes.set_errno(1)
try:
    run('touch SHOULD_NOT_START')
    raise AssertionError('started without descendant supervision')
except OSError as error:
    assert error.errno == 1
assert not list(root.glob('jobs/*/process.json'))
assert not list(root.glob('jobs/*/work/SHOULD_NOT_START'))
assert (root / 'lock').is_dir()
assert not list(volume.iterdir())
`);
});

test('cleanup never signals a process group with no supervised descendants',async t=>{
 await python(t, String.raw`
calls = []
task.descendants = lambda: {}
task.group_alive = lambda group: True
task.os.killpg = lambda group, sig: calls.append((group, sig))
clock = [0.0]
def tick():
    clock[0] += 0.25
    return clock[0]
task.time.monotonic = tick
task.time.sleep = lambda seconds: None
assert task.terminate_group(12345) is False
assert calls == [], 'signalled a group without any owned descendants'
`);
});
