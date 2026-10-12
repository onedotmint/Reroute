#!/usr/bin/env node
// Offline benchmark: production sync + worker, never a provider or coordinator.
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, totalmem, release, tmpdir } from 'node:os';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const MiB = 1024 * 1024;
const scenarios = [
  { name: 'small', files: 32, bytes: 4096 },
  { name: 'medium', files: 256, bytes: 32768 },
  { name: 'many-small', files: 2048, bytes: 1024 },
  { name: 'few-large', files: 4, bytes: 16 * MiB }
];
const fileName = i => `source/group-${Math.floor(i / 64)}/file-${String(i).padStart(5, '0')}.dat`;
const policyFor = s => ({ excludes: ['ignored/**', '*.local'], maxFiles: s.files + 8, maxFileBytes: s.bytes + 1 });

async function worker(inputPath) {
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const { Synchronizer } = await import(pathToFileURL(join(input.runtime, 'dist/sync/sync.js')));
  const { fileTransport } = await import(pathToFileURL(join(input.runtime, 'dist/providers/channel.js')));
  const { spawnRaw } = await import(pathToFileURL(join(input.runtime, 'dist/platform/process.js')));
  const runtime = { id: 'benchmark', projectId: 'benchmark', provider: 'ssh', root: input.remote, meta: {} };
  const transport = fileTransport(async (_runtime, argv) => spawnRaw(argv[0], argv.slice(1)), runtime);
  const rpcCalls = { scan: 0, read: 0, apply: 0 };
  for (const method of Object.keys(rpcCalls)) {
    const original = transport[method];
    transport[method] = async (...args) => { rpcCalls[method]++; return original(...args); };
  }
  // Count actual Node source/state content reads, not Python reads or protocol bytes.
  let localSourceReadBytes = 0, localStateReadBytes = 0;
  const readFile = fs.readFile;
  fs.readFile = async (path, ...args) => {
    const data = await readFile(path, ...args);
    if (typeof path === 'string' && path.startsWith(input.local + sep)) {
      const bytes = Buffer.byteLength(data);
      if (relative(input.local, path).startsWith('.reroute' + sep)) localStateReadBytes += bytes;
      else localSourceReadBytes += bytes;
    }
    return data;
  };
  try {
    const result = await new Synchronizer(input.local, input.policy).reconcile(transport);
    console.log(JSON.stringify({ ...result, rpcCalls, localSourceReadBytes, localStateReadBytes }));
  } finally { fs.readFile = readFile; }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function treeDigest(root) {
  const hash = createHash('sha256');
  async function walk(path, prefix = '') {
    for (const name of (await fs.readdir(path)).sort()) {
      const full = join(path, name), rel = prefix + name;
      if ((await fs.lstat(full)).isDirectory()) await walk(full, rel + '/');
      else { hash.update(rel + '\0'); hash.update(await fs.readFile(full)); }
    }
  }
  await walk(root);
  return hash.digest('hex');
}
async function generate(local, remote, s) {
  await fs.mkdir(local, { recursive: true }); await fs.mkdir(remote, { recursive: true });
  const data = Buffer.alloc(s.bytes, 0x61);
  for (let i = 0; i < s.files; i++) {
    const path = join(local, fileName(i));
    await fs.mkdir(dirname(path), { recursive: true });
    data.writeUInt32LE(i, 0);
    await fs.writeFile(path, data, { mode: 0o644 });
  }
  for (const path of ['.env', 'ignored/private.dat', 'note.local']) {
    await fs.mkdir(dirname(join(local, path)), { recursive: true });
    await fs.writeFile(join(local, path), 'must not transfer');
  }
}
async function verify(local, remote, s) {
  // Outside the measured subprocess: check bytes, permissions, baseline and exclusions.
  const base = JSON.parse(await fs.readFile(join(local, '.reroute/sync-base.json'), 'utf8'));
  assert.equal(Object.keys(base).length, s.files);
  for (let i = 0; i < s.files; i++) {
    const rel = fileName(i), left = join(local, rel), right = join(remote, rel);
    const leftHash = await digest(left);
    assert.equal(await digest(right), leftHash, rel);
    assert.equal(base[rel].hash, leftHash, rel);
    assert.equal((await fs.stat(left)).mode & 0o777, (await fs.stat(right)).mode & 0o777, rel);
  }
  for (const path of ['.env', 'ignored', 'note.local']) {
    await assert.rejects(fs.lstat(join(remote, path)), { code: 'ENOENT' });
  }
}
async function mutate(root, count, value) {
  for (let i = 0; i < count; i++) {
    const handle = await fs.open(join(root, fileName(i)), 'r+');
    try { await handle.write(Buffer.from([value]), 0, 1, 4); } finally { await handle.close(); }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = { baseline: 'e2c77e2', repeats: 3, commandSamples: 15, tempDir: tmpdir(), selfTest: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (['--baseline', '--repeats', '--command-samples', '--temp-dir'].includes(arg)) {
      assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `Missing value: ${arg}`);
      const key = { '--baseline': 'baseline', '--repeats': 'repeats', '--command-samples': 'commandSamples', '--temp-dir': 'tempDir' }[arg];
      options[key] = ['repeats', 'commandSamples'].includes(key) ? Number(args[++i]) : args[++i];
    } else if (arg === '--help') {
      console.log('node scripts/benchmark.mjs [--baseline e2c77e2] [--repeats 3] [--command-samples 15] [--temp-dir /var/tmp] [--self-test]\nJSON to stdout; progress to stderr. Requires Linux, Python 3, git, tar and GNU /usr/bin/time. No cloud/dependencies.');
      return;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  for (const key of ['repeats', 'commandSamples']) assert.ok(Number.isSafeInteger(options[key]) && options[key] > 0 && options[key] <= 100, `Invalid ${key}`);
  assert.equal(process.platform, 'linux', 'Resource accounting currently requires Linux/GNU time');
  await exec('/usr/bin/time', ['--version']);
  const baselineCommit = (await exec('git', ['rev-parse', '--verify', `${options.baseline}^{commit}`], { cwd: repo })).stdout.trim();
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const scratch = await fs.mkdtemp(join(resolve(options.tempDir), 'reroute-benchmark-'));
  try {
    const report = { schema: 1, startedAt: new Date().toISOString(), selfTest: options.selfTest,
      environment: { node: process.version, python: (await exec('python3', ['--version'])).stdout.trim(), kernel: release(), platform: process.platform,
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), tempParent: resolve(options.tempDir),
        filesystem: (await exec('df', ['-T', scratch])).stdout.trim(), head,
        gitStatus: (await exec('git', ['status', '--short'], { cwd: repo })).stdout.trim(),
        cache: 'OS cache not dropped; generation/verification warm it; each measurement starts a fresh Node process' },
      options, implementations: {}, sync: [], commands: [] };
    const snapshots = { baseline: join(scratch, 'baseline'), current: join(scratch, 'current') };
    await fs.mkdir(snapshots.baseline); await fs.mkdir(snapshots.current);
    const archive = await exec('git', ['archive', '--format=tar', baselineCommit, 'dist', 'bin', 'assets', 'package.json'], { cwd: repo, encoding: 'buffer', maxBuffer: 32 * MiB });
    const archivePath = join(scratch, 'baseline.tar');
    await fs.writeFile(archivePath, archive.stdout);
    await exec('tar', ['-xf', archivePath, '-C', snapshots.baseline]);
    for (const path of ['dist', 'bin', 'assets', 'package.json']) await fs.cp(join(repo, path), join(snapshots.current, path), { recursive: true });
    for (const [label, root] of Object.entries(snapshots)) {
      report.implementations[label] = { commit: label === 'baseline' ? baselineCommit : head, runtimeSha256: await treeDigest(root),
        syncSha256: await digest(join(root, 'dist/sync/sync.js')), note: label === 'current' ? 'Frozen working-tree runtime; not an implicit rebuild of src' : 'git archive of committed runtime' };
    }
    report.identicalRuntimes = report.implementations.baseline.runtimeSha256 === report.implementations.current.runtimeSha256;
    const home = join(scratch, 'home'); await fs.mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, REROUTE_HOME: join(home, '.reroute'), XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), LANG: 'C.UTF-8', REROUTE_NO_OPEN: '1', PYTHONDONTWRITEBYTECODE: '1' };
    let measurement = 0;
    async function measure(argv, cwd) {
      const metrics = join(scratch, `time-${measurement++}.json`);
      const start = process.hrtime.bigint();
      const result = await exec('/usr/bin/time', ['-o', metrics, '-f', '{"userSeconds":%U,"systemSeconds":%S,"maxProcessRssKiB":%M,"inputBlocks":%I,"outputBlocks":%O}', ...argv], { cwd, env, maxBuffer: 8 * MiB });
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
      const resource = JSON.parse(await fs.readFile(metrics, 'utf8'));
      return { stdout: result.stdout, wallMs, ...resource, cpuMs: (resource.userSeconds + resource.systemSeconds) * 1000,
        blockReadBytes: resource.inputBlocks * 512, blockWriteBytes: resource.outputBlocks * 512 };
    }
    const selected = options.selfTest ? scenarios.map(s => ({ ...s, files: 3, bytes: 4096 })) : scenarios;
    const repeats = options.selfTest ? 1 : options.repeats;
    for (const s of selected) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        // Alternate order to avoid giving one implementation every first/cache-biased run.
        const labels = repeat % 2 ? ['current', 'baseline'] : ['baseline', 'current'];
        for (const label of labels) {
          const caseRoot = join(scratch, `${s.name}-${repeat}-${label}`);
          const local = join(caseRoot, 'local'), remote = join(caseRoot, 'remote');
          await generate(local, remote, s);
          const changed = Math.max(1, Math.floor(s.files / 100));
          const inputPath = join(caseRoot, 'input.json');
          await fs.writeFile(inputPath, JSON.stringify({ runtime: snapshots[label], local, remote, policy: policyFor(s) }));
          for (const phase of ['initial', 'unchanged-1', 'unchanged-2', 'incremental-push', 'incremental-pull']) {
            if (phase === 'incremental-push') await mutate(local, changed, 0x62);
            if (phase === 'incremental-pull') await mutate(remote, changed, 0x63);
            process.stderr.write(`${s.name} ${repeat + 1}/${repeats} ${label} ${phase}\n`);
            const { stdout, ...metrics } = await measure([process.execPath, script, '--worker', inputPath], caseRoot);
            const result = JSON.parse(stdout);
            const expected = phase === 'initial' ? { pushed: s.files, pulled: 0 } : phase === 'incremental-push' ? { pushed: changed, pulled: 0 } : phase === 'incremental-pull' ? { pushed: 0, pulled: changed } : { pushed: 0, pulled: 0 };
            assert.equal(result.pushed, expected.pushed); assert.equal(result.pulled, expected.pulled);
            assert.equal(result.rpcCalls.scan, 1);
            assert.ok(expected.pushed === 0 ? result.rpcCalls.apply === 0 : result.rpcCalls.apply > 0 && result.rpcCalls.apply <= expected.pushed, 'confirmed writes may use bounded batch RPCs');
            assert.equal(result.rpcCalls.read, expected.pulled);
            assert.ok(result.localSourceReadBytes >= s.files * s.bytes);
            await verify(local, remote, s);
            report.sync.push({ scenario: s.name, files: s.files, fileBytes: s.bytes, treeBytes: s.files * s.bytes,
              changedFiles: phase.startsWith('incremental') ? changed : 0, repeat, implementation: label, phase, ...metrics, ...result });
          }
          await fs.rm(caseRoot, { recursive: true, force: true });
        }
      }
    }
    const commandCwd = join(scratch, 'commands'); await fs.mkdir(commandCwd);
    const samples = options.selfTest ? 2 : options.commandSamples;
    for (let sample = 0; sample < samples; sample++) {
      for (const label of sample % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        const cli = join(snapshots[label], 'bin/reroute.mjs');
        const nodeArgs = [process.execPath, '-e', "process.stdout.write('ok')"];
        const commands = { 'bare-node': nodeArgs, 'reroute-local-node': [process.execPath, cli, 'local', '--', ...nodeArgs],
          'bare-git': ['git', '--version'], 'reroute-shim-git': [process.execPath, cli, 'shim', 'git', '--version'] };
        for (const [name, argv] of Object.entries(commands)) {
          const { stdout, ...metrics } = await measure(argv, commandCwd);
          if (name.includes('node')) assert.equal(stdout, 'ok'); else assert.match(stdout, /^git version /);
          report.commands.push({ implementation: label, name, sample, ...metrics });
        }
      }
    }
    report.finishedAt = new Date().toISOString();
    report.verification = 'Every sync phase checked byte hashes, permissions, agreed baseline, exclusions, transfer counts and RPC counts; every local command checked output/exit';
    console.log(JSON.stringify(report, null, 2));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

try {
  if (process.argv[2] === '--worker') await worker(process.argv[3]);
  else await main();
} catch (error) { console.error(error); process.exitCode = 1; }
