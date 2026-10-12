#!/usr/bin/env node
// Offline real-runtime measurements. Never build, git archive, contact a provider, or read user credentials.
import assert from 'node:assert/strict';
import nativeFS, { promises as fs, createReadStream } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, totalmem, release } from 'node:os';
import { Session } from 'node:inspector';
const exec = promisify(execFile), script = fileURLToPath(import.meta.url), MiB = 1048576;
const datasets = [{ name: 'few-large', files: 4, bytes: 16 * MiB }, { name: 'large-64', files: 1, bytes: 64 * MiB },
  { name: 'large-128', files: 1, bytes: 128 * MiB }, { name: 'many-small', files: 2048, bytes: 1024 }];
const name = i => `source/group-${Math.floor(i / 64)}/file-${String(i).padStart(5, '0')}.dat`;
const policy = s => ({ excludes: ['ignored/**', '*.local'], maxFiles: s.files + 8, maxFileBytes: s.bytes + 1 });
const ioParse = text => Object.fromEntries(text.trim().split('\n').map(l => { const [k, v] = l.split(':'); return [k, Number(v.trim())]; }));
async function io(pid = process.pid) { try { return ioParse(await fs.readFile(`/proc/${pid}/io`, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function delta(a, b) { return a && b ? Object.fromEntries(Object.keys(b).map(k => [k, b[k] - (a[k] ?? 0)])) : null; }
function countSourceReads(root) {
  const totals = { source: 0, state: 0, methods: {} }, descriptors = new Map();
  const count = (path, bytes, method) => { if (typeof path !== 'string' || !path.startsWith(root + '/')) return; const key = path.slice(root.length + 1).startsWith('.reroute/') ? 'state' : 'source'; totals[key] += bytes; totals.methods[method] = (totals.methods[method] ?? 0) + bytes; };
  const readFile = fs.readFile, open = fs.open, callbackOpen = nativeFS.open, read = nativeFS.read;
  fs.readFile = async (p, ...args) => { const result = await readFile(p, ...args); count(p, Buffer.byteLength(result), 'promises.readFile'); return result; };
  fs.open = async (p, ...args) => { const handle = await open(p, ...args); const readHandle = handle.read.bind(handle), readHandleFile = handle.readFile.bind(handle);
    handle.read = async (...params) => { const result = await readHandle(...params); count(p, result.bytesRead, 'FileHandle.read'); return result; };
    handle.readFile = async (...params) => { const result = await readHandleFile(...params); count(p, Buffer.byteLength(result), 'FileHandle.readFile'); return result; };
    // FileHandle streams call handle.read; counting data events as well would double-count.
    return handle; };
  nativeFS.open = (...args) => { const cb = args.pop(), p = args[0]; return callbackOpen(...args, (err, fd) => { if (!err) descriptors.set(fd, p); cb(err, fd); }); };
  nativeFS.read = (...args) => { const cb = args.pop(), fd = args[0]; return read(...args, (err, bytes, data) => { if (!err) count(descriptors.get(fd), bytes, 'fs.read(stream)'); cb(err, bytes, data); }); };
  syncBuiltinESMExports(); return totals;
}
async function hash(path) { const h = createHash('sha256'); for await (const c of createReadStream(path)) h.update(c); return h.digest('hex'); }
async function fingerprint(root) {
  const h = createHash('sha256');
  async function walk(path, prefix) { for (const n of (await fs.readdir(path)).sort()) { const p = join(path, n), rel = prefix + n;
    if ((await fs.lstat(p)).isDirectory()) await walk(p, rel + '/'); else { h.update(rel + '\0'); for await (const c of createReadStream(p)) h.update(c); } } }
  for (const p of ['dist', 'assets', 'bin', 'package.json']) { const full = join(root, p); if ((await fs.lstat(full)).isDirectory()) await walk(full, p + '/'); else { h.update(p + '\0'); h.update(await fs.readFile(full)); } }
  return h.digest('hex');
}
// Profiling is a separate run: execute unchanged worker source; capture allocation/IO before Python exits.
const pythonProfile = source => `import tracemalloc, resource, atexit, builtins, os
tracemalloc.start(16)
benchmark_reads = {'source': 0, 'state': 0}
benchmark_checkpoints = []
benchmark_open, benchmark_fdopen = builtins.open, os.fdopen
class BenchmarkFile:
 def __init__(self, f, p): self.f, self.p = f, str(p)
 def __getattr__(self, k): return getattr(self.f, k)
 def __iter__(self): return iter(self.f)
 def __enter__(self): self.f.__enter__(); return self
 def __exit__(self, *args): return self.f.__exit__(*args)
 def read(self, *args):
  data = self.f.read(*args)
  if self.p.startswith(benchmark_root+'/'): benchmark_reads['state' if '/.reroute' in self.p else 'source'] += len(data) if isinstance(data, bytes) else len(data.encode())
  return data
def benchmark_count_open(p, *args, **kw): return BenchmarkFile(benchmark_open(p, *args, **kw), p)
def benchmark_count_fdopen(fd, *args, **kw):
 try: path = os.readlink('/proc/self/fd/'+str(fd))
 except OSError: path = ''
 return BenchmarkFile(benchmark_fdopen(fd, *args, **kw), path)
import sys, json, base64
benchmark_root = json.loads(base64.b64decode(sys.argv[1]))['root']
builtins.open, os.fdopen = benchmark_count_open, benchmark_count_fdopen
def benchmark_checkpoint(frame, event, arg):
 if event != 'return' or frame.f_code.co_filename != 'worker.py' or frame.f_code.co_name not in ('rpc', 'emit', 'digest', 'read_stable', 'read_stream'): return
 packet = frame.f_locals.get('packet', {})
 if packet.get('type') == 'file_chunk' and packet.get('seq', 0) % 64: return
 current, peak = tracemalloc.get_traced_memory()
 benchmark_checkpoints.append({'function': frame.f_code.co_name, 'current': current, 'peak': peak, 'top': [{'site': str(s.traceback), 'bytes': s.size} for s in tracemalloc.take_snapshot().statistics('lineno')[:8]]})
sys.setprofile(benchmark_checkpoint)
def benchmark_finish():
 current, peak = tracemalloc.get_traced_memory()
 top = [{'site': str(s.traceback), 'bytes': s.size, 'count': s.count} for s in tracemalloc.take_snapshot().statistics('lineno')[:12]]
 try:
  with benchmark_open('/proc/self/io') as f: disk = f.read()
 except OSError: disk = None
 usage = resource.getrusage(resource.RUSAGE_SELF)
 sys.stderr.write('ROUND5_PROFILE '+json.dumps({'pid': os.getpid(), 'rssKiB': usage.ru_maxrss, 'inputBlocks': usage.ru_inblock, 'outputBlocks': usage.ru_oublock, 'tracedCurrent': current, 'tracedPeak': peak, 'top': top, 'io': disk, 'logicalReads': benchmark_reads, 'checkpoints': benchmark_checkpoints})+'\\n')
atexit.register(benchmark_finish)
exec(compile(${JSON.stringify(source)}, 'worker.py', 'exec'))
`;
async function worker(input) {
  const { Synchronizer } = await import(pathToFileURL(join(input.runtime, 'dist/sync/sync.js')));
  const { fileTransport } = await import(pathToFileURL(join(input.runtime, 'dist/providers/channel.js')));
  const { spawnRaw } = await import(pathToFileURL(join(input.runtime, 'dist/platform/process.js')));
  const sourceReads = countSourceReads(input.local);
  if (input.selfTest) {
    const p = join(input.local, name(0)), size = (await fs.stat(p)).size;
    await fs.readFile(p); for await (const chunk of createReadStream(p)) assert.ok(chunk.length);
    const handle = await fs.open(p, 'r'); try { await handle.read(Buffer.alloc(size), 0, size, null); await handle.readFile(); } finally { await handle.close(); }
    const readFileHandle = await fs.open(p, 'r'); try { await readFileHandle.readFile(); } finally { await readFileHandle.close(); }
    const streamingHandle = await fs.open(p, 'r'); try { for await (const chunk of streamingHandle.createReadStream({ autoClose: false })) assert.ok(chunk.length); } finally { await streamingHandle.close(); }
    // One EOF readFile contributes zero; the independent handle reads a complete file.
    assert.equal(sourceReads.source, size * 5, `readFile + streams counted exactly once: ${JSON.stringify(sourceReads.methods)}`);
    sourceReads.source = 0; sourceReads.state = 0; sourceReads.methods = {};
  }
  const startIO = await io(), rpcCalls = {}, wire = { sent: 0, received: 0, stderr: 0, maxOutboundFrame: 0, maxInboundFrame: 0 }, python = [];
  const peaks = {}, samples = []; let session;
  function sample(label) { const m = process.memoryUsage(); for (const [k, v] of Object.entries(m)) peaks[k] = Math.max(peaks[k] ?? 0, v);
    if (samples.length < 1500) samples.push({ ms: performance.now(), label, ...m }); }
  if (input.profile) { session = new Session(); session.connect(); await promisify(session.post.bind(session))('HeapProfiler.startSampling', { samplingInterval: 32768, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
  const timer = setInterval(() => sample('timer'), input.interval); sample('start');
  const runtime = { id: 'benchmark', projectId: 'benchmark', provider: 'ssh', root: input.remote, meta: {} };
  const transport = fileTransport(async (_runtime, argv) => {
    const args = argv.slice(1); if (input.profile) args[2] = pythonProfile(args[2]);
    const raw = spawnRaw(argv[0], args); let outbound = 0, inbound = 0, stderr = '';
    const count = (data, direction) => { let cursor = 0, end;
      while ((end = data.indexOf(10, cursor)) >= 0) { if (direction === 'out') { outbound += end - cursor + 1; wire.maxOutboundFrame = Math.max(wire.maxOutboundFrame, outbound); outbound = 0; }
        else { inbound += end - cursor + 1; wire.maxInboundFrame = Math.max(wire.maxInboundFrame, inbound); inbound = 0; } cursor = end + 1; }
      if (direction === 'out') { outbound += data.length - cursor; wire.maxOutboundFrame = Math.max(wire.maxOutboundFrame, outbound); }
      else { inbound += data.length - cursor; wire.maxInboundFrame = Math.max(wire.maxInboundFrame, inbound); } };
    return { ...raw, write: async data => { wire.sent += data.length; count(data, 'out'); return raw.write(data); },
      events: { async *[Symbol.asyncIterator]() { for await (const e of raw.events) {
        if (e.stream === 'stdout') { wire.received += e.data.length; count(e.data, 'in'); } else { wire.stderr += e.data.length; if (input.profile) stderr += e.data.toString(); }
        // Do not retain or copy payloads: the real channel consumes the original event.
        yield e;
      } if (input.profile) for (const l of stderr.split('\n')) if (l.startsWith('ROUND5_PROFILE ')) python.push(JSON.parse(l.slice(15))); } } };
  }, runtime);
  for (const key of Object.keys(transport)) if (typeof transport[key] === 'function') { const original = transport[key]; transport[key] = async (...args) => {
    rpcCalls[key] = (rpcCalls[key] ?? 0) + 1; sample(`${key}:before`); try { return await original(...args); } finally { sample(`${key}:after`); } }; }
  let result, error, heapProfile;
  try { result = await new Synchronizer(input.local, input.policy).reconcile(transport); }
  catch (e) { error = { code: e.code, message: e.message, stack: e.stack }; }
  finally { clearInterval(timer); sample('finish'); if (session) { heapProfile = (await promisify(session.post.bind(session))('HeapProfiler.stopSampling')).profile; session.disconnect(); } }
  const endIO = await io();
  if (heapProfile) await fs.writeFile(input.profilePath, JSON.stringify(heapProfile));
  console.log(JSON.stringify({ result, error, rpcCalls, wire, nodeMemoryPeaks: peaks, nodeMemorySamples: samples, python, sourceReads, io: delta(startIO, endIO), resource: process.resourceUsage(), heapProfilePath: heapProfile ? input.profilePath : undefined }));
}
async function generate(local, remote, s) {
  await fs.mkdir(local, { recursive: true }); await fs.mkdir(remote, { recursive: true });
  const chunk = Buffer.alloc(Math.min(s.bytes, MiB), 0x61);
  for (let i = 0; i < s.files; i++) { const p = join(local, name(i)); await fs.mkdir(dirname(p), { recursive: true }); const fd = await fs.open(p, 'w', 0o644);
    try { for (let offset = 0; offset < s.bytes; offset += chunk.length) await fd.write(chunk, 0, Math.min(chunk.length, s.bytes - offset), offset); await fd.write(Buffer.from([i & 255, (i >> 8) & 255, 0, 0]), 0, 4, 0); } finally { await fd.close(); } }
  for (const p of ['.env', 'ignored/private.dat', 'note.local']) { await fs.mkdir(dirname(join(local, p)), { recursive: true }); await fs.writeFile(join(local, p), 'synthetic excluded sentinel; not a credential'); }
}
async function mutate(root, count, value) { for (let i = 0; i < count; i++) { const f = await fs.open(join(root, name(i)), 'r+'); try { await f.write(Buffer.from([value]), 0, 1, 4); } finally { await f.close(); } } }
async function verify(local, remote, s) {
  const base = JSON.parse(await fs.readFile(join(local, '.reroute/sync-base.json'), 'utf8')); assert.equal(Object.keys(base).length, s.files);
  for (let i = 0; i < s.files; i++) { const p = name(i), expected = await hash(join(local, p)); assert.equal(await hash(join(remote, p)), expected, p); assert.equal(base[p].hash, expected); assert.equal(base[p].size, s.bytes);
    assert.equal((await fs.stat(join(local, p))).mode & 0o111, (await fs.stat(join(remote, p))).mode & 0o111); }
  for (const p of ['.env', 'ignored', 'note.local']) await assert.rejects(fs.lstat(join(remote, p)), { code: 'ENOENT' });
}
async function proc(pid) {
  try { const [status, stats, disk] = await Promise.all([fs.readFile(`/proc/${pid}/status`, 'utf8'), fs.readFile(`/proc/${pid}/stat`, 'utf8'), io(pid)]);
    const fields = stats.slice(stats.lastIndexOf(')') + 2).split(' ');
    return { pid, name: status.match(/^Name:\s+(.+)$/m)?.[1], rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
      highWater: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024, userTicks: Number(fields[11]), systemTicks: Number(fields[12]), io: disk };
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
}
async function descendants(pid) { const ids = [pid]; for (let i = 0; i < ids.length; i++) { try { const text = await fs.readFile(`/proc/${ids[i]}/task/${ids[i]}/children`, 'utf8'); for (const child of text.trim().split(/\s+/).filter(Boolean).map(Number)) if (!ids.includes(child)) ids.push(child); } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; } } return ids; }
async function measure(inputs, root, options) {
  const started = performance.now(), children = [], outputs = [], perProcess = new Map(), timeline = []; let familyPeak = 0, controllerPeak = 0, combinedPeak = 0, polling = false;
  for (let i = 0; i < inputs.length; i++) {
    const p = join(root, `input-${i}.json`), time = join(root, `time-${i}.json`); await fs.writeFile(p, JSON.stringify(inputs[i]));
    const child = spawn('/usr/bin/time', ['-o', time, '-f', '{"userSeconds":%U,"systemSeconds":%S,"maxProcessRssKiB":%M,"inputBlocks":%I,"outputBlocks":%O}', process.execPath, options.runner, '--worker', p], { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); outputs.push(new Promise((resolveOutput, reject) => { let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); child.once('error', reject); child.once('close', async code => { try { resolveOutput({ code, stderr, ...JSON.parse(stdout), time: JSON.parse(await fs.readFile(time, 'utf8')) }); } catch (e) { reject(new Error(`Measurement child exit=${code}: ${stderr}\n${e.message}`)); } }); }));
  }
  async function sample() { if (polling) return; polling = true;
    try { const ids = [...new Set((await Promise.all(children.map(c => descendants(c.pid)))).flat())], rows = (await Promise.all(ids.map(proc))).filter(Boolean), controller = await proc(process.pid), sum = rows.reduce((n, r) => n + r.rss, 0);
      familyPeak = Math.max(familyPeak, sum); controllerPeak = Math.max(controllerPeak, controller?.rss ?? 0); combinedPeak = Math.max(combinedPeak, sum + (controller?.rss ?? 0));
      for (const row of rows) { const previous = perProcess.get(row.pid); perProcess.set(row.pid, { ...row, peakRss: Math.max(previous?.peakRss ?? 0, row.rss), highWater: Math.max(previous?.highWater ?? 0, row.highWater) }); }
      timeline.push({ ms: performance.now() - started, familyRss: sum, controllerRss: controller?.rss, processes: rows.map(r => ({ pid: r.pid, name: r.name, rss: r.rss })) });
    } finally { polling = false; } }
  const timer = setInterval(() => { void sample().catch(e => { process.stderr.write(`sampler: ${e.message}\n`); }); }, options.interval);
  let results; try { await sample(); results = await Promise.all(outputs); } finally { clearInterval(timer); while (polling) await new Promise(r => setTimeout(r, 1)); }
  const wallMs = performance.now() - started;
  await fs.writeFile(join(root, 'samples.json'), JSON.stringify(timeline));
  const cpuMs = results.reduce((n, r) => n + 1000 * (r.time.userSeconds + r.time.systemSeconds), 0);
  return { wallMs, cpuMs, familyPeakBytes: familyPeak, controllerPeakBytes: controllerPeak, combinedPeakBytes: combinedPeak,
    budgetBytes: options.budgetMiB * MiB, budgetPassed: familyPeak <= options.budgetMiB * MiB, sampledIntervalMs: options.interval, sampleCount: timeline.length,
    processes: [...perProcess.values()], samplesPath: join(root, 'samples.json'), results };
}
async function main() {
  const options = { runtime: '', label: 'baseline', tempDir: '/var/tmp', reportDir: '', repeats: 3, interval: 10, budgetMiB: 512, scenarios: datasets.map(s => s.name).join(','), parallel: '2,4', profile: false, selfTest: false };
  const keys = { '--runtime': 'runtime', '--label': 'label', '--temp-dir': 'tempDir', '--report-dir': 'reportDir', '--repeats': 'repeats', '--interval-ms': 'interval', '--budget-mib': 'budgetMiB', '--scenarios': 'scenarios', '--parallel': 'parallel' };
  for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a === '--profile') options.profile = true; else if (a === '--self-test') options.selfTest = true;
    else if (a === '--help') { console.log('node scripts/benchmark-round5.mjs --runtime FROZEN_ROOT [--label baseline|current] [--temp-dir /var/tmp|/mnt/c] [--report-dir PRIVATE_DIR] [--repeats 3] [--interval-ms 10] [--budget-mib 512] [--scenarios few-large,large-64,large-128,many-small] [--parallel 2,4|none] [--profile] [--self-test]\nOne immutable runtime per invocation; never uses git HEAD. JSON stdout and report.json; retained raw profiles/samples, deleted datasets. Profile rows must not be pooled with ordinary performance rows.'); return; }
    else { assert.ok(keys[a] && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Invalid/missing option ${a}`); const k = keys[a], v = process.argv[++i]; options[k] = ['repeats', 'interval', 'budgetMiB'].includes(k) ? Number(v) : v; } }
  assert.equal(process.platform, 'linux'); assert.ok(options.runtime, '--runtime required'); options.runtime = resolve(options.runtime);
  for (const k of ['repeats', 'interval', 'budgetMiB']) assert.ok(Number.isSafeInteger(options[k]) && options[k] > 0 && options[k] <= 8192, `Invalid ${k}`);
  const parallel = options.parallel === 'none' ? [] : options.parallel.split(',').map(Number); assert.ok(parallel.every(n => n === 2 || n === 4));
  let selected = options.scenarios.split(',').map(n => { const s = datasets.find(s => s.name === n); assert.ok(s, `Unknown scenario ${n}`); return s; });
  if (options.selfTest) { selected = [{ name: 'self-test', files: 3, bytes: 4096 }]; options.repeats = 1; assert.deepEqual(ioParse('rchar: 12\nread_bytes: 0'), { rchar: 12, read_bytes: 0 }); }
  const scratch = await fs.mkdtemp(join(resolve(options.tempDir), 'reroute-round5-data-'));
  const reportRoot = options.reportDir ? resolve(options.reportDir) : await fs.mkdtemp('/var/tmp/reroute-round5-report-'); await fs.mkdir(reportRoot, { recursive: true });
  options.runner = join(reportRoot, 'benchmark-runner.mjs'); await fs.copyFile(script, options.runner);
  const home = join(scratch, 'home'); await fs.mkdir(home); options.env = { PATH: process.env.PATH, HOME: home, REROUTE_HOME: join(home, '.reroute'), XDG_CONFIG_HOME: join(home, '.config'), LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', REROUTE_NO_OPEN: '1' };
  const report = { schema: 5, startedAt: new Date().toISOString(), options: { ...options, env: undefined }, runtimeSha256: await fingerprint(options.runtime),
    environment: { node: process.version, python: (await exec('python3', ['--version'])).stdout.trim(), kernel: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), filesystem: (await exec('df', ['-T', scratch])).stdout.trim(), clockTicks: Number((await exec('getconf', ['CLK_TCK'])).stdout.trim()), procIOAvailable: (await io()) !== null, cache: 'Warm cache; no drops, generation and streaming verification outside measured child' }, rows: [] };
  const persist = async () => fs.writeFile(join(reportRoot, 'report.json'), JSON.stringify(report, null, 2));
  let caseId = 0;
  try {
    for (const s of selected) for (let repeat = 0; repeat < options.repeats; repeat++) for (const lanes of [1, ...(s.name === 'many-small' ? [] : parallel)]) {
      const caseRoot = join(scratch, `case-${caseId++}`); await fs.mkdir(caseRoot); const trees = [];
      for (let lane = 0; lane < lanes; lane++) { const local = join(caseRoot, `local-${lane}`), remote = join(caseRoot, `remote-${lane}`); await generate(local, remote, s); trees.push({ runtime: options.runtime, local, remote, policy: policy(s), interval: options.interval, profile: options.profile, selfTest: options.selfTest }); }
      let ready = false;
      // Parallel cases measure full return of independent projects, not shared lanes/state.
      const phases = lanes === 1 ? ['initial', 'unchanged-1', 'unchanged-2', 'incremental-push', 'incremental-pull', ...(s.name === 'many-small' ? [] : ['all-pull'])] : ['seed', 'all-pull'];
      for (const phase of phases) {
        if (phase === 'seed' || (!ready && phase !== 'initial')) { for (const t of trees) for (let i = 0; i < s.files; i++) { await fs.mkdir(dirname(join(t.remote, name(i))), { recursive: true }); await fs.copyFile(join(t.local, name(i)), join(t.remote, name(i))); } }
        const changed = phase === 'all-pull' ? s.files : phase.startsWith('incremental') ? Math.max(1, Math.floor(s.files / 100)) : 0;
        for (const t of trees) { if (phase === 'incremental-push') await mutate(t.local, changed, 0x62); if (phase === 'incremental-pull' || phase === 'all-pull') await mutate(t.remote, changed, phase === 'all-pull' ? 0x64 : 0x63); }
        const raw = join(reportRoot, `${s.name}-${repeat}-${lanes}-${phase}`); await fs.mkdir(raw);
        const inputs = trees.map((t, i) => ({ ...t, profilePath: join(raw, `node-${i}.heapprofile`) }));
        process.stderr.write(`${options.label} ${s.name} repeat=${repeat} lanes=${lanes} ${phase}\n`);
        const row = { scenario: s.name, files: s.files, fileBytes: s.bytes, treeBytes: s.files * s.bytes, repeat, lanes, phase, changedFilesPerLane: changed, ...await measure(inputs, raw, options) };
        const errors = row.results.filter(r => r.error || r.code); row.status = errors.length ? 'failed' : 'passed'; report.rows.push(row); await persist();
        if (errors.length) { assert.ok(errors.every(r => /PROTOCOL_LIMIT|RPC_FRAME_LIMIT|frame exceeded|TRANSPORT_LOST|STDIN_CLOSED|EPIPE/.test(JSON.stringify(r))), 'Unexpected runtime error; inspect report'); ready = false;
          // Do not increase the 64 MiB frame bound. A failed large push gets an independent equal-tree seed for scans/return testing.
          if (phase === 'incremental-push') { for (const t of trees) for (let i = 0; i < changed; i++) await fs.copyFile(join(t.remote, name(i)), join(t.local, name(i))); ready = true; continue; }
          if (phase !== 'initial') break; continue; }
        const expectedPush = phase === 'initial' ? s.files : phase === 'incremental-push' ? changed : 0;
        const expectedPull = ['incremental-pull', 'all-pull'].includes(phase) ? changed : 0;
        for (let i = 0; i < trees.length; i++) { const r = row.results[i]; assert.equal(r.result.pushed, expectedPush); assert.equal(r.result.pulled, expectedPull); assert.equal(r.rpcCalls.scan, 1); await verify(trees[i].local, trees[i].remote, s); }
        ready = true; row.verified = true; await persist();
      }
      await fs.rm(caseRoot, { recursive: true, force: true });
    }
    assert.equal(await fingerprint(options.runtime), report.runtimeSha256, 'Runtime changed while measuring; freeze it first');
    report.finishedAt = new Date().toISOString(); report.verification = 'Successful phases: streamed SHA256, baseline count/hash/size, executable permission agreement, exclusion absence, transfer counts, real worker scan. Failed rows retained explicitly, never claimed successful.';
    await persist(); console.log(JSON.stringify(report, null, 2));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); process.stderr.write(`Raw report: ${join(reportRoot, 'report.json')}\n`); }
}
try { if (process.argv[2] === '--worker') await worker(JSON.parse(await fs.readFile(process.argv[3], 'utf8'))); else await main(); }
catch (e) { console.error(e); process.exitCode = 1; }
