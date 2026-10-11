import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const cli = resolve('bin/reroute.mjs');
const daemon = resolve('bin/rerouted.mjs');
const clientURL = pathToFileURL(resolve('dist/daemon/client.js')).href;
const serverURL = pathToFileURL(resolve('dist/daemon/server.js')).href;
const protocolURL = pathToFileURL(resolve('dist/daemon/protocol.js')).href;

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function kill(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'fixture wait timed out');
    await sleep(25);
  }
}
async function exists(path) {
  try { await fs.stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Legacy wire behavior: ping stays successful during slow shutdown, and the
// shutdown acknowledgement contains only stopping:true (no PID or exit receipt).
const legacyFixture = `
import net from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { endpoint, lines, send } from ${JSON.stringify(protocolURL)};
const home = process.env.REROUTE_HOME, token = 'a'.repeat(64);
await fs.mkdir(home, { recursive: true, mode: 0o700 });
await fs.writeFile(join(home, 'ipc-token'), token, { mode: 0o600 });
await fs.writeFile(join(home, 'daemon.json'), JSON.stringify({ pid: process.pid, protocol: 1 }));
const mode = process.env.FIXTURE_MODE;
if (mode === 'unreachable') {
  setInterval(() => {}, 1000);
} else {
  let stopping = false;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    lines(socket, packet => {
      void (async () => {
        if (packet.token !== token || packet.v !== 1) {
          await send(socket, { type: 'error', code: 'IPC_AUTH', message: 'IPC authentication/version mismatch', exitCode: 70 });
        } else if (packet.op === 'ping') {
          await send(socket, { type: 'result', value: { pid: process.pid, version: 1 } });
        } else if (packet.op === 'shutdown') {
          await send(socket, { type: 'result', value: { stopping: true } });
          if (!stopping) {
            stopping = true;
            await fs.writeFile(join(home, 'shutdown-requested'), 'yes');
            if (mode !== 'timeout') void (async () => {
              await sleep(900);
              const closed = new Promise(resolve => server.close(resolve));
              for (const connection of sockets) connection.destroy();
              await closed;
              if (process.platform !== 'win32') await fs.rm(endpoint(), { force: true });
              await fs.rm(join(home, 'daemon.json'), { force: true });
              await fs.writeFile(join(home, 'gap'), 'socket closed but process still alive');
              await sleep(600);
              await fs.writeFile(join(home, 'cleanup-complete'), 'yes');
            })();
          }
        }
        socket.end();
      })().catch(error => { console.error(error); process.exitCode = 1; socket.destroy(); });
    }, () => socket.destroy());
  });
  await new Promise(resolve => server.listen(endpoint(), resolve));
}
await fs.writeFile(join(home, 'fixture-ready'), 'yes');
`;

async function context(run) {
  const root = await fs.mkdtemp(join(tmpdir(), 'reroute-reload-'));
  const home = join(root, 'home'), agentHome = join(root, 'agents');
  const children = [];
  const capture = join(root, 'spawned.jsonl');
  const preload = join(root, 'capture.mjs'), teardown = join(root, 'teardown');
  const env = { ...process.env, HOME: root, USERPROFILE: root, REROUTE_HOME: home, REROUTE_AGENT_HOME: agentHome, RELOAD_FIXTURE_ENV: 'new' };
  try {
    await fs.mkdir(home, { mode: 0o700 });
    await fs.mkdir(agentHome);
    // Observe only our real replacement daemon, including one that fails readiness.
    await fs.writeFile(preload, `import { appendFileSync, existsSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(daemon)}) {
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ pid: process.pid, environment: process.env.RELOAD_FIXTURE_ENV }) + '\\n');
  if (existsSync(${JSON.stringify(teardown)})) process.exit(0);
}\n`);
    env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    function launch(args, overrides = {}) {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      });
      // Observe rejection immediately even if a fixture setup fails before awaiting done.
      void done.catch(() => {});
      children.push({ child, done });
      return { child, done };
    }
    async function fixture(mode = 'legacy') {
      const started = launch(['--input-type=module', '-e', legacyFixture], { FIXTURE_MODE: mode, RELOAD_FIXTURE_ENV: 'old' });
      await waitFor(() => exists(join(home, 'fixture-ready')));
      return started;
    }
    async function spawned() {
      if (!await exists(capture)) return [];
      return (await fs.readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    const reload = () => launch([cli, 'auth', 'reload']);
    const ensure = (overrides = {}) => launch(['--input-type=module', '-e', `
import { ensureDaemon } from ${JSON.stringify(clientURL)};
try { await ensureDaemon(); } catch (error) { console.error(error.code + ': ' + error.message); process.exitCode = error.exitCode || 1; }
`], overrides);
    await run({ home, launch, fixture, spawned, reload, ensure });
  } finally {
    try {
      // A detached spawn whose preload runs late must not outlive test teardown.
      await fs.writeFile(teardown, 'yes');
      // Kill/reap our explicit children before removing state; never use the user's home.
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(children.map(({ done }) => done));
      // Detached replacements are recorded by our preload, not discovered globally.
      if (await exists(capture)) {
        const records = (await fs.readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        for (const { pid } of records) {
          if (alive(pid)) kill(pid, 'SIGTERM');
          const deadline = Date.now() + 2000;
          while (alive(pid) && Date.now() < deadline) await sleep(25);
          if (alive(pid)) kill(pid, 'SIGKILL');
        }
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
}

test('auth reload waits beyond 400ms for real exit, and old-env clients cannot win the startup gap', async () => {
  await context(async f => {
    const old = await f.fixture();
    const before = Date.now(), reloading = f.reload();
    await waitFor(() => exists(join(f.home, 'shutdown-requested')));
    await sleep(450);
    assert.equal(alive(old.child.pid), true);
    assert.deepEqual(await f.spawned(), [], 'reload started a replacement before the old daemon exited');
    await waitFor(() => exists(join(f.home, 'gap')));
    const competitor = f.ensure({ RELOAD_FIXTURE_ENV: 'old' });
    const result = await reloading.done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Date.now() - before >= 1500);
    assert.equal((await old.done).code, 0);
    assert.equal(alive(old.child.pid), false);
    assert.equal(await exists(join(f.home, 'cleanup-complete')), true);
    assert.equal((await competitor.done).code, 0);
    const report = JSON.parse(result.stdout);
    assert.notEqual(report.daemon.pid, old.child.pid);
    assert.deepEqual(await f.spawned(), [{ pid: report.daemon.pid, environment: 'new' }]);
  });
});

test('auth reload fails nonzero on bounded exit timeout, without starting a replacement', async () => {
  await context(async f => {
    const old = await f.fixture('timeout'), before = Date.now();
    const result = await f.reload().done;
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(result.signal, null, 'CLI was killed by the fixture watchdog instead of reporting failure');
    assert.match(result.stderr, /Old daemon did not exit before the reload deadline/);
    assert.ok(Date.now() - before < 18000);
    assert.equal(alive(old.child.pid), true);
    assert.deepEqual(await f.spawned(), []);
    assert.equal(await exists(join(f.home, 'daemon-start.lock')), false);
  });
});

test('auth reload with no daemon starts normally from the current CLI environment', async () => {
  await context(async f => {
    const result = await f.reload().done;
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(await f.spawned(), [{ pid: report.daemon.pid, environment: 'new' }]);
    assert.equal(alive(report.daemon.pid), true);
  });
});

test('IPC authentication failures are not treated as an absent daemon by reload or lazy startup', async () => {
  await context(async f => {
    const old = await f.fixture();
    await fs.writeFile(join(f.home, 'ipc-token'), 'b'.repeat(64));
    for (const result of [await f.reload().done, await f.ensure().done]) {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /IPC authentication\/version mismatch/);
    }
    assert.equal(alive(old.child.pid), true);
    assert.equal(await exists(join(f.home, 'shutdown-requested')), false);
    assert.deepEqual(await f.spawned(), []);
  });
});

test('a live but unreachable recorded process fails closed', async () => {
  await context(async f => {
    const old = await f.fixture('unreachable');
    const result = await f.reload().done;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /alive but its IPC is not responding/);
    assert.equal(alive(old.child.pid), true);
    assert.deepEqual(await f.spawned(), []);
  });
});

test('server rejects ping/new work as soon as shutdown starts and repeated close shares completion', async () => {
  await context(async f => {
    const result = await f.launch(['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from ${JSON.stringify(serverURL)};
import { request } from ${JSON.stringify(clientURL)};
let release, calls = 0;
const blocked = new Promise(resolve => { release = resolve; });
const server = await serve({ recover: async () => {}, shutdown: async () => { calls++; await blocked; } });
try {
  assert.deepEqual(await request({ op: 'shutdown' }, false), { stopping: true });
  await assert.rejects(request({ op: 'ping' }, false), { code: 'DAEMON_STOPPING' });
  await assert.rejects(request({ op: 'status' }, false), { code: 'DAEMON_STOPPING' });
  const first = server.close(), second = server.close();
  assert.equal(first, second);
  let finished = false; void first.then(() => { finished = true; });
  await sleep(100);
  assert.equal(calls, 1); assert.equal(finished, false);
  release(); await first; assert.equal(finished, true);
} finally { release(); await server.close(); }
`]).done;
    assert.equal(result.code, 0, result.stderr);
  });
});
