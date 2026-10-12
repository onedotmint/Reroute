import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A temporary compile lets this gate run without replacing shared dist/.
const moduleURL = path => process.env.REROUTE_TEST_DIST
  ? pathToFileURL(join(resolve(process.env.REROUTE_TEST_DIST), path)).href
  : new URL('../../dist/' + path, import.meta.url).href;
const { setup, uninstall, installHarness, doctor, HARNESSES } = await import(moduleURL('cli/setup.js'));
const { serve } = await import(moduleURL('daemon/server.js'));
const read = path => fs.readFile(path, 'utf8');
const json = async path => JSON.parse(await read(path));
const write = async (path, value) => { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, JSON.stringify(value)); };
const absent = async path => assert.rejects(fs.lstat(path), { code: 'ENOENT' });

async function context(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'reroute-setup-'));
  const home = join(root, 'user'), state = join(root, 'state');
  const values = { HOME: home, USERPROFILE: home, REROUTE_HOME: state, REROUTE_AGENT_HOME: home, PATH: join(root, 'empty-bin') };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  let server;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await fs.mkdir(home); await fs.mkdir(values.PATH);
  // Ping-only local IPC. No provider or harness can execute in these tests.
  server = await serve({ recover: async () => {}, shutdown: async () => {} });
  const paths = {
    pi: join(home, '.pi/agent/extensions/reroute.ts'), omp: join(home, '.omp/agent/extensions/reroute.ts'),
    claude: join(home, '.claude/settings.json'), codex: join(home, '.codex/hooks.json'), cursor: join(home, '.cursor/hooks.json'),
    opencode: join(state, 'adapters/opencode.mjs'), deepseek: join(state, 'adapters/deepseek.mjs'),
  };
  return { root, home, state, paths, registry: join(state, 'installed-hooks.json') };
}

test('default setup discovers harnesses without installing; explicit setup survives later default setup', async t => {
  const f = await context(t);
  for (const dir of ['.pi/agent', '.omp/agent', '.claude', '.codex', '.cursor', '.dsh', '.config/opencode']) await fs.mkdir(join(f.home, dir), { recursive: true });
  const userSettings = '{"theme":"mine","hooks":{"Other":[{"command":"keep"}]}}';
  await fs.writeFile(f.paths.claude, userSettings);
  const report = await setup({});
  assert.deepEqual(new Set(report.detected), new Set(HARNESSES));
  assert.deepEqual(report.installed, {}); assert.match(report.note, /not installed automatically/);
  for (const id of HARNESSES.filter(id => id !== 'claude')) await absent(f.paths[id]);
  assert.equal(await read(f.paths.claude), userSettings); await absent(f.registry);
  const explicit = await setup({ harnesses: ['pi'] }); assert.deepEqual(Object.keys(explicit.installed), ['pi']);
  await setup({});
  assert.deepEqual(Object.keys((await json(join(f.state, 'setup.json'))).installed), ['pi']);
  assert.equal(HARNESSES.includes('omp'), false); await absent(f.paths.omp);
  const skipped = await setup({ harnesses: ['pi'], skipAdapters: true }); assert.deepEqual(skipped.installed, {});
  const declined = await setup({ harnesses: ['codex'] }); assert.deepEqual(declined.installed, {}); assert.equal(declined.warnings.length, 1); await absent(f.paths.codex);
  assert.deepEqual(Object.keys((await setup({ harnesses: ['codex'], allowCodexHook: true })).installed), ['codex']);
});

test('uninstall removes only unchanged owned extensions/plugins and is idempotent', async t => {
  const f = await context(t), ids = ['pi', 'opencode', 'deepseek'];
  for (const id of ids) { await installHarness(id); await installHarness(id); }
  const foreign = join(dirname(f.paths.pi), 'other.ts'); await fs.writeFile(foreign, 'user extension');
  await write(join(f.state, 'config.json'), { user: 'keep' }); await write(join(f.state, 'projects/keep.json'), { runtime: 'untouched' });
  const report = await uninstall(); assert.deepEqual(new Set(report.removed), new Set(ids.map(id => f.paths[id]))); assert.deepEqual(report.preserved, []);
  for (const id of ids) await absent(f.paths[id]);
  assert.equal(await read(foreign), 'user extension'); assert.deepEqual(await json(join(f.state, 'config.json')), { user: 'keep' });
  assert.deepEqual(await json(join(f.state, 'projects/keep.json')), { runtime: 'untouched' });
  const again = await uninstall(); assert.deepEqual(again.removed, []); assert.deepEqual(again.preserved, []);
  assert.deepEqual((await json(f.registry)).entries, []);
});

test('selective uninstall preserves edits even with the managed marker, and never recreates removed adapters', async t => {
  const f = await context(t); await setup({ harnesses: ['pi', 'opencode'] });
  await fs.appendFile(f.paths.pi, '// user edit\n'); const edited = await read(f.paths.pi);
  const report = await uninstall({ harnesses: ['pi'] }); assert.deepEqual(report.removed, []); assert.equal(report.preserved[0].reason, 'MODIFIED');
  assert.equal(await read(f.paths.pi), edited); assert.ok(await read(f.paths.opencode));
  await assert.rejects(installHarness('pi'), /unowned or modified/); assert.equal(await read(f.paths.pi), edited);
  await uninstall({ harnesses: ['opencode'] }); await absent(f.paths.opencode);
  const checks = (await doctor(f.home, true, false)).checks;
  assert.equal(checks.find(item => item.check === 'harness pi').state, 'MODIFIED');
  assert.equal(checks.find(item => item.check === 'harness opencode').state, 'NOT INSTALLED');
  assert.equal(await read(f.paths.pi), edited); await absent(f.paths.opencode);
  assert.deepEqual(Object.keys((await json(join(f.state, 'setup.json'))).installed), ['pi']);
  await assert.rejects(uninstall({ harnesses: ['unknown'] }), /Unknown harness/);
});

for (const host of ['claude', 'codex', 'cursor']) {
  const event = host === 'cursor' ? 'preToolUse' : 'PreToolUse';
  test(`${host} uninstall removes an exact owned entry, not other hooks or settings`, async t => {
    const f = await context(t), path = f.paths[host];
    const foreign = host === 'cursor' ? { command: 'custom-reroute-helper', extra: true } : { matcher: 'Bash', hooks: [{ type: 'command', command: 'custom-reroute-helper' }] };
    const original = { theme: 'custom', version: 7, hooks: { [event]: [foreign], Other: [{ command: 'keep' }] }, permissions: { deny: ['secret'] } };
    await write(path, original); await installHarness(host); await installHarness(host);
    const settings = await json(path), owned = settings.hooks[event][1];
    // Merely sharing our command does not establish ownership of a different entry.
    const similar = structuredClone(owned); similar.userField = 'keep'; settings.hooks[event].push(similar, structuredClone(owned));
    await write(path, settings);
    const backup = await read(path + '.reroute-backup');
    await assert.rejects(installHarness(host), /unowned hook/);
    assert.deepEqual(await json(path), settings);
    const result = await uninstall({ harnesses: [host] }); assert.deepEqual(result.removed, [path]); assert.deepEqual(result.preserved, []);
    assert.deepEqual(await json(path), { ...original, hooks: { ...original.hooks, [event]: [foreign, similar, owned] } });
    assert.equal(await read(path + '.reroute-backup'), backup);
    assert.deepEqual((await uninstall({ harnesses: [host] })).removed, []);
  });
  test(`${host} edited owned hook is preserved by reinstall, doctor fix and uninstall`, async t => {
    const f = await context(t), path = f.paths[host]; await installHarness(host);
    const settings = await json(path);
    if (host === 'cursor') settings.hooks[event][0].failClosed = false;
    else settings.hooks[event][0].hooks[0].timeout = 123;
    await write(path, settings); const edited = await read(path);
    await assert.rejects(installHarness(host), /changed or removed/);
    const checks = (await doctor(f.home, true, false)).checks;
    assert.equal(checks.find(item => item.check === 'harness ' + host).state, 'MODIFIED');
    const result = await uninstall({ harnesses: [host] }); assert.deepEqual(result.removed, []); assert.equal(result.preserved[0].reason, 'MODIFIED');
    assert.equal(await read(path), edited);
  });
}

test('doctor reports explicit ownership, fixes missing owned files, and does not install detected harnesses', async t => {
  const f = await context(t); await fs.mkdir(join(f.home, '.omp/agent'), { recursive: true });
  await installHarness('pi'); const original = await read(f.paths.pi); await fs.unlink(f.paths.pi);
  const before = (await doctor(f.home, false, false)).checks;
  assert.equal(before.find(item => item.check === 'harness pi').state, 'MISSING');
  const after = (await doctor(f.home, true, false)).checks;
  assert.equal(after.find(item => item.check === 'harness pi').state, 'INSTALLED');
  assert.equal(after.some(item => item.check === 'harness omp'), false);
  assert.equal(await read(f.paths.pi), original); await absent(f.paths.omp);
  await fs.unlink(f.paths.pi); assert.deepEqual((await uninstall()).removed, []);
  await doctor(f.home, true, false); await absent(f.paths.pi);
});

test('legacy markers and command history cannot authorize removal or overwrite', async t => {
  const f = await context(t); await installHarness('pi'); await installHarness('claude');
  const history = await json(f.registry); await write(f.registry, { commands: history.commands });
  await write(join(f.state, 'setup.json'), { installed: { pi: f.paths.pi, claude: f.paths.claude } });
  const pi = await read(f.paths.pi), claude = await read(f.paths.claude);
  const report = await uninstall(); assert.deepEqual(report.removed, []); assert.equal(report.warnings.length, 1);
  await assert.rejects(installHarness('pi'), /unowned or modified/); await assert.rejects(installHarness('claude'), /unowned hook/);
  await doctor(f.home, true, false);
  assert.equal(await read(f.paths.pi), pi); assert.equal(await read(f.paths.claude), claude);
});

test('invalid JSON is left byte-for-byte intact', async t => {
  const f = await context(t); await installHarness('claude'); await fs.writeFile(f.paths.claude, '{broken');
  await assert.rejects(installHarness('claude'), /Invalid JSON/);
  assert.equal((await uninstall()).preserved[0].reason, 'UNSAFE'); assert.equal(await read(f.paths.claude), '{broken');
  await fs.writeFile(f.registry, '{broken registry');
  await assert.rejects(uninstall()); assert.equal(await read(f.registry), '{broken registry');
});

test('uninstall reports corrupt metadata without touching it or losing the removal report', async t => {
  const f = await context(t); await installHarness('pi'); const path = join(f.state, 'setup.json');
  await fs.writeFile(path, '{broken setup');
  const result = await uninstall(); assert.deepEqual(result.removed, [f.paths.pi]); assert.equal(result.warnings.length, 1);
  assert.equal(await read(path), '{broken setup'); await absent(f.paths.pi);
});

test('hook installation rejects a symlink backup without touching its target', async t => {
  const f = await context(t), path = f.paths.claude, target = join(f.root, 'backup-target');
  await write(path, { theme: 'mine' }); const original = await read(path); await fs.writeFile(target, 'do not touch');
  await fs.symlink(target, path + '.reroute-backup');
  await assert.rejects(installHarness('claude'), /symlink/); assert.equal(await read(path), original); assert.equal(await read(target), 'do not touch');
});

test('symlinks and registry paths outside the current homes cannot authorize deletion', async t => {
  const f = await context(t); await installHarness('pi');
  const contents = await read(f.paths.pi), target = join(f.root, 'outside.ts'); await fs.writeFile(target, contents);
  await fs.unlink(f.paths.pi); await fs.symlink(target, f.paths.pi);
  assert.equal((await uninstall()).preserved[0].reason, 'UNSAFE'); assert.equal(await read(target), contents);
  await assert.rejects(installHarness('pi'), /symlink/);
  await fs.unlink(f.paths.pi); await fs.rmdir(dirname(f.paths.pi));
  const outsideDir = join(f.root, 'outside'); await fs.mkdir(outsideDir); await fs.writeFile(join(outsideDir, 'reroute.ts'), contents);
  await fs.symlink(outsideDir, dirname(f.paths.pi));
  assert.equal((await uninstall()).preserved[0].reason, 'UNSAFE'); assert.equal(await read(join(outsideDir, 'reroute.ts')), contents);
  const registry = await json(f.registry); registry.entries[0].path = target; await write(f.registry, registry);
  assert.equal((await uninstall()).preserved[0].reason, 'UNSAFE'); assert.equal(await read(target), contents);
  await fs.unlink(f.registry); await fs.symlink(target, f.registry); await assert.rejects(uninstall(), /symlink/); assert.equal(await read(target), contents);
});

async function legacyOMP(f) {
  const content = '// Managed by Reroute\nexport { default } from "file:///old-reroute/adapters/omp.mjs";\n';
  await fs.mkdir(dirname(f.paths.omp), { recursive: true }); await fs.writeFile(f.paths.omp, content);
  const registry = await json(f.registry).catch(error => { if (error.code === 'ENOENT') return { commands: [], entries: [] }; throw error; });
  registry.entries.push({ harness: 'omp', path: f.paths.omp, kind: 'file', hash: createHash('sha256').update(content).digest('hex') });
  await write(f.registry, registry);
  await write(join(f.state, 'setup.json'), { installed: { omp: f.paths.omp } });
  return content;
}

test('OMP cannot be installed, even by JS callers or with skipAdapters', async t => {
  const f = await context(t);
  await assert.rejects(installHarness('omp'), /OMP is uninstall-only/);
  for (const skipAdapters of [false, true]) await assert.rejects(setup({ harnesses: ['omp'], skipAdapters }), /OMP is uninstall-only/);
  await absent(f.paths.omp); await absent(f.registry); await absent(join(f.state, 'setup.json'));
});

test('legacy OMP registry stays compatible but cleanup requires explicit selection and exact ownership', async t => {
  const f = await context(t), content = await legacyOMP(f);
  await installHarness('pi');
  const settings = join(f.home, '.omp/agent/settings.json'), foreign = join(dirname(f.paths.omp), 'other.ts');
  await write(settings, { theme: 'keep', extensions: ['reroute.ts'] }); await fs.writeFile(foreign, 'user extension');
  const originalSettings = await read(settings);
  const checks = (await doctor(f.home, true, false)).checks;
  assert.equal(checks.find(item => item.check === 'harness omp').state, 'LEGACY');
  assert.equal(await read(f.paths.omp), content);
  await uninstall(); await absent(f.paths.pi); assert.equal(await read(f.paths.omp), content);
  const result = await uninstall({ harnesses: ['omp'] });
  assert.deepEqual(result.removed, [f.paths.omp]); assert.deepEqual(result.preserved, []); await absent(f.paths.omp);
  assert.equal(await read(settings), originalSettings); assert.equal(await read(foreign), 'user extension');
  assert.deepEqual((await json(f.registry)).entries, []); assert.deepEqual((await json(join(f.state, 'setup.json'))).installed, {});
  assert.deepEqual((await uninstall({ harnesses: ['omp'] })).removed, []);
  await doctor(f.home, true, false); await absent(f.paths.omp);
});

test('doctor warns on missing legacy OMP without reinstalling it; explicit cleanup drops only stale ownership', async t => {
  const f = await context(t); await legacyOMP(f); await fs.unlink(f.paths.omp);
  const checks = (await doctor(f.home, true, false)).checks;
  const legacy = checks.find(item => item.check === 'harness omp');
  assert.equal(legacy.state, 'LEGACY'); assert.deepEqual(legacy.detail.states, ['MISSING']); await absent(f.paths.omp);
  const result = await uninstall({ harnesses: ['omp'] }); assert.deepEqual(result.removed, []); assert.deepEqual(result.preserved, []);
  assert.deepEqual((await json(f.registry)).entries, []); await absent(f.paths.omp);
});

test('unrecorded legacy OMP is warned about, not claimed, reinstalled or removed', async t => {
  const f = await context(t); const content = await legacyOMP(f); await fs.unlink(f.registry);
  const checks = (await doctor(f.home, true, false)).checks;
  const legacy = checks.find(item => item.check === 'harness omp');
  assert.equal(legacy.state, 'LEGACY'); assert.deepEqual(legacy.detail.states, []); assert.match(legacy.detail.note, /unrecorded/);
  assert.deepEqual((await uninstall({ harnesses: ['omp'] })).removed, []); assert.equal(await read(f.paths.omp), content);
  assert.deepEqual((await json(join(f.state, 'setup.json'))).installed, { omp: f.paths.omp });
});

for (const change of ['modified', 'symlink', 'parent symlink', 'outside path', 'wrong kind']) {
  test(`legacy OMP ${change} is preserved by doctor fix and explicit uninstall`, async t => {
    const f = await context(t), content = await legacyOMP(f), outside = join(f.root, 'outside.ts');
    await fs.writeFile(outside, content);
    if (change === 'modified') await fs.appendFile(f.paths.omp, '// user edit\n');
    if (change === 'symlink') { await fs.unlink(f.paths.omp); await fs.symlink(outside, f.paths.omp); }
    if (change === 'parent symlink') {
      await fs.unlink(f.paths.omp); await fs.rmdir(dirname(f.paths.omp));
      const folder = join(f.root, 'outside-dir'); await fs.mkdir(folder); await fs.writeFile(join(folder, 'reroute.ts'), content);
      await fs.symlink(folder, dirname(f.paths.omp));
    }
    if (change === 'outside path' || change === 'wrong kind') {
      const registry = await json(f.registry);
      if (change === 'outside path') registry.entries[0].path = outside;
      else registry.entries[0] = { harness: 'omp', path: f.paths.omp, kind: 'hook', event: 'PreToolUse', entry: {} };
      await write(f.registry, registry);
    }
    const original = await read(f.paths.omp), registry = await read(f.registry), metadata = await read(join(f.state, 'setup.json'));
    assert.equal((await doctor(f.home, true, false)).checks.find(item => item.check === 'harness omp').state, 'LEGACY');
    const result = await uninstall({ harnesses: ['omp'] }); assert.deepEqual(result.removed, []);
    assert.equal(result.preserved[0].reason, change === 'modified' ? 'MODIFIED' : 'UNSAFE');
    assert.equal(await read(f.paths.omp), original); assert.equal(await read(outside), content);
    assert.equal(await read(f.registry), registry); assert.equal(await read(join(f.state, 'setup.json')), metadata);
  });
}
