#!/usr/bin/env node
// Offline scanner benchmark; no provider, daemon, credentials, persisted hash cache or build.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const options = { runtime: resolve('.'), tempDir: '/var/tmp', files: 2048, bytes: 1024, scans: 3, repeats: 3 };
const keys = { '--runtime': 'runtime', '--temp-dir': 'tempDir', '--files': 'files', '--bytes': 'bytes', '--scans': 'scans', '--repeats': 'repeats' };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--help') { console.log('node scripts/benchmark-hash-reuse.mjs [--runtime FROZEN_ROOT] [--temp-dir /var/tmp|/mnt/c] [--files 2048] [--bytes 1024] [--scans 3] [--repeats 3]\nStrict and opt-in metadata scans in the same process/session; reports local and real Python CPU/RSS/read/transfer telemetry separately. JSON stdout.'); process.exit(0); }
  const key = keys[process.argv[i]]; assert.ok(key, 'Unknown argument'); const value = process.argv[++i]; assert.ok(value, 'Missing value'); options[key] = typeof options[key] === 'number' ? Number(value) : resolve(value);
}
for (const key of ['files', 'bytes', 'scans', 'repeats']) assert.ok(Number.isSafeInteger(options[key]) && options[key] > 0);
const root = await fs.mkdtemp(join(options.tempDir, 'reroute-hash-benchmark-'));
process.env.REROUTE_HOME = join(root, 'home'); process.env.HOME = join(root, 'home'); await fs.mkdir(process.env.HOME);
const { scanLocal } = await import(pathToFileURL(join(options.runtime, 'dist/sync/sync.js')));
const { fileTransport } = await import(pathToFileURL(join(options.runtime, 'dist/providers/channel.js')));
const { spawnRaw } = await import(pathToFileURL(join(options.runtime, 'dist/platform/process.js')));
let HashCache;
try { ({ HashCache } = await import(pathToFileURL(join(options.runtime, 'dist/sync/hash-cache.js')))); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const trace = source => `import os, sys, json, base64, atexit, resource, builtins
r5_root = json.loads(base64.b64decode(sys.argv[1]))['root']
r5_reads = [0]
r5_open, r5_fdopen = builtins.open, os.fdopen
class R5File:
 def __init__(self, file, path): self.file, self.path = file, str(path)
 def __getattr__(self, name): return getattr(self.file, name)
 def __iter__(self): return iter(self.file)
 def __enter__(self): self.file.__enter__(); return self
 def __exit__(self, *args): return self.file.__exit__(*args)
 def read(self, *args):
  data = self.file.read(*args)
  if self.path.startswith(r5_root + '/'): r5_reads[0] += len(data) if isinstance(data, bytes) else len(data.encode())
  return data
def r5_count_open(path, *args, **kwargs): return R5File(r5_open(path, *args, **kwargs), path)
def r5_count_fdopen(fd, *args, **kwargs):
 try: path = os.readlink('/proc/self/fd/' + str(fd))
 except OSError: path = ''
 return R5File(r5_fdopen(fd, *args, **kwargs), path)
builtins.open, os.fdopen = r5_count_open, r5_count_fdopen
def r5_finish():
 u = resource.getrusage(resource.RUSAGE_SELF)
 try:
  with r5_open('/proc/self/io') as file: io = dict((k, int(v)) for k, v in (line.split(':') for line in file.read().splitlines()))
 except OSError: io = None
 sys.stderr.write('R5SCAN:' + json.dumps({'logicalReadBytes': r5_reads[0], 'cpuMs': (u.ru_utime + u.ru_stime) * 1000, 'maxRssKiB': u.ru_maxrss, 'inputBlocks': u.ru_inblock, 'outputBlocks': u.ru_oublock, 'io': io}) + '\\n')
atexit.register(r5_finish)
` + source;
const report = { options, platform: process.platform, node: process.version, filesystemType: (await fs.statfs(root)).type.toString(16), python: spawnSync('python3', ['--version'], { encoding: 'utf8' }).stdout.trim(), measurement: 'Warm OS cache; logical reads instrument real file APIs. Remote telemetry includes interpreter/protocol startup. RSS is process high-water, not simultaneous family sum. Per-row CPU/read/transfer are separate; no disk-cache flush or wall-time significance claim.', rows: [] };
const open = fs.open, readFile = fs.readFile; let localReads = 0, measuring = false;
fs.open = async (path, ...args) => {
  const file = await open(path, ...args), read = file.read.bind(file);
  file.read = async (...args) => { const result = await read(...args); if (measuring && String(path).includes('/local/')) localReads += result.bytesRead; return result; }; return file;
};
fs.readFile = async (path, ...args) => { const data = await readFile(path, ...args); if (measuring && String(path).includes('/local/')) localReads += Buffer.byteLength(data); return data; };
try {
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    const local = join(root, String(repeat), 'local'), remote = join(root, String(repeat), 'remote'); await fs.mkdir(local, { recursive: true }); await fs.mkdir(remote, { recursive: true });
    const chunk = Buffer.alloc(Math.min(options.bytes, 65536), 1), digest = createHash('sha256');
    for (let offset = 0; offset < options.bytes; offset += chunk.length) digest.update(chunk.subarray(0, Math.min(chunk.length, options.bytes - offset)));
    const expectedHash = digest.digest('hex');
    for (const dir of [local, remote]) for (let i = 0; i < options.files; i++) {
      const fd = await open(join(dir, 'file-' + i), 'wx', 0o644);
      try { for (let offset = 0; offset < options.bytes; offset += chunk.length) await fd.write(chunk.subarray(0, Math.min(chunk.length, options.bytes - offset))); } finally { await fd.close(); }
    }
    const runtime = { id: 'synthetic', projectId: 'synthetic', provider: 'ssh', root: remote, meta: {} }; let telemetry, received = 0, sent = 0;
    const files = fileTransport(async (_runtime, argv) => {
      const args = [...argv]; args[3] = trace(args[3]); const raw = spawnRaw(args[0], args.slice(1));
      return { ...raw, write: async data => { sent += data.length; return raw.write(data); }, events: { async *[Symbol.asyncIterator]() {
        let stderr = ''; for await (const event of raw.events) { if (event.stream === 'stderr') stderr += event.data.toString(); else received += event.data.length; yield event; }
        const line = stderr.split('\n').find(line => line.startsWith('R5SCAN:')); assert.ok(line, 'Missing Python telemetry: ' + stderr);
        telemetry = JSON.parse(line.slice(7));
      } } };
    }, runtime);
    for (const hashMode of ['strict', 'metadata']) {
      const cache = HashCache ? new HashCache() : undefined, policy = { excludes: [], maxFiles: options.files, maxFileBytes: options.bytes, hashMode };
      for (let scan = 0; scan < options.scans; scan++) {
        localReads = 0; received = 0; sent = 0; measuring = true;
        const cpu = process.cpuUsage(), usage = process.resourceUsage(), before = performance.now(); let peakRss = process.memoryUsage().rss;
        const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
        try {
        const localStart = performance.now(), localManifest = await scanLocal(local, policy, cache), localMs = performance.now() - localStart;
        const localCpu = process.cpuUsage(cpu), localUsage = process.resourceUsage(), remoteStart = performance.now(), remoteManifest = await files.scan(policy), remoteMs = performance.now() - remoteStart;
        clearInterval(timer); measuring = false;
        assert.deepEqual({ ...localManifest }, { ...remoteManifest }); assert.equal(Object.keys(localManifest).length, options.files);
        for (const entry of Object.values(localManifest)) { assert.equal(entry.hash, expectedHash); assert.equal(entry.size, options.bytes); }
        const localBytes = localReads, expectedBytes = options.files * options.bytes;
        assert.ok(localBytes % options.bytes === 0 && localBytes <= expectedBytes); assert.ok(telemetry.logicalReadBytes % options.bytes === 0 && telemetry.logicalReadBytes <= expectedBytes);
        if (hashMode === 'strict' || scan === 0 || !HashCache) { assert.equal(localBytes, expectedBytes); assert.equal(telemetry.logicalReadBytes, expectedBytes); }
        report.rows.push({ repeat, hashMode, scan, totalMs: performance.now() - before, localMs, remoteMs, localCpuMs: (localCpu.user + localCpu.system) / 1000, localReadBytes: localBytes, localInputBlocks: localUsage.fsRead - usage.fsRead, localOutputBlocks: localUsage.fsWrite - usage.fsWrite, nodePeakRssBytes: Math.max(peakRss, process.memoryUsage().rss), sentBytes: sent, receivedBytes: received, remote: telemetry });
        } finally { clearInterval(timer); measuring = false; }
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { fs.open = open; fs.readFile = readFile; await fs.rm(root, { recursive: true, force: true }); }
