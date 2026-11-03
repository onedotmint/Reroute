import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Type stripping does not remap source .js imports; keep this test independent of generated dist.
const source = new URL('../src/', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(source) && specifier.startsWith('./') && specifier.endsWith('.js')) specifier = specifier.slice(0, -3) + '.ts';
  return nextResolve(specifier, context);
} });
const { defaults, projectRoot, loadConfig, saveUserConfig } = await import('../src/config.ts');
hook.deregister();

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'reroute-boundary-')));
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, 'private');
  t.after(async () => {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  const boundary = join(dir, 'trusted'), cwd = join(boundary, 'src');
  await mkdir(cwd, { recursive: true });
  const config = { ...defaults(), active: 'ssh', profiles: { ssh: { provider: 'ssh', id: 'fixture.invalid' } } };
  return { dir, boundary, cwd, config };
}

function configProbes(t) {
  const paths = [];
  for (const name of ['access', 'readFile']) {
    const original = fs[name];
    t.mock.method(fs, name, async function (path, ...args) {
      paths.push(String(path));
      return original.call(this, path, ...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return paths;
}

const initGit = path => promisify(execFile)('git', ['init', '--quiet', path]);

test('bounded discovery rejects outside cwd, sibling prefixes and symlink escapes', async t => {
  const { dir, boundary, cwd } = await fixture(t);
  const sibling = join(dir, 'trusted-other'); await mkdir(sibling);
  const escape = join(boundary, 'escape'); await symlink(sibling, escape, 'dir');
  const paths = configProbes(t);
  for (const outside of [dir, sibling, escape]) {
    await assert.rejects(projectRoot(outside, boundary), /Working directory.*outside.*boundary/);
    await assert.rejects(loadConfig(outside, boundary), /Working directory.*outside.*boundary/);
  }
  assert.deepEqual(paths, []);
  await assert.rejects(projectRoot(cwd, join(dir, 'missing')), { code: 'ENOENT' });
});

test('an outer Git root fails before any config probe, even with nested reroute roots', async t => {
  const { dir, boundary, cwd, config } = await fixture(t);
  await initGit(dir);
  for (const root of [dir, boundary, cwd]) await writeFile(join(root, '.reroute.json'), JSON.stringify(config));
  assert.equal(await projectRoot(cwd), cwd);
  assert.equal((await loadConfig(cwd)).root, cwd);
  const paths = configProbes(t);
  await assert.rejects(projectRoot(cwd, boundary), /Git project root.*outside.*boundary/);
  await assert.rejects(loadConfig(cwd, boundary), /Git project root.*outside.*boundary/);
  assert.deepEqual(paths, []);
});

test('bounded Git discovery keeps the Git root and independent nested reroute precedence', async t => {
  const { dir, boundary, cwd, config } = await fixture(t);
  await initGit(boundary);
  await writeFile(join(dir, '.reroute.json'), '{broken outside boundary');
  assert.equal(await projectRoot(cwd, boundary), boundary);
  assert.equal(await projectRoot(cwd, dir), boundary);
  assert.equal(await projectRoot(cwd), boundary);
  await writeFile(join(boundary, '.reroute.json'), JSON.stringify(config));
  const nested = join(cwd, 'independent'), leaf = join(nested, 'deep'); await mkdir(leaf, { recursive: true });
  const independent = { ...config, timeoutSeconds: 42 };
  await writeFile(join(nested, '.reroute.json'), JSON.stringify(independent));
  await saveUserConfig({ ...config, timeoutSeconds: 99 });
  const alias = join(dir, 'alias'); await symlink(boundary, alias, 'dir');
  for (const [start, limit] of [[leaf, boundary], [join(alias, 'src', 'independent', 'deep'), boundary], [leaf, alias]]) {
    assert.equal(await projectRoot(start, limit), nested);
    assert.deepEqual(await loadConfig(start, limit), { root: nested, config: independent, source: 'merged' });
  }
  assert.equal(await projectRoot(leaf), nested);
  assert.equal(await projectRoot(alias, alias), boundary);
});

test('bounded non-Git discovery neither probes nor reads ancestor reroute config; unbounded behavior remains', async t => {
  const { dir, boundary, cwd, config } = await fixture(t);
  await writeFile(join(dir, '.reroute.json'), '{broken outside boundary');
  await saveUserConfig(config);
  const paths = configProbes(t);
  assert.equal(await projectRoot(cwd, boundary), cwd);
  assert.deepEqual(await loadConfig(cwd, boundary), { root: cwd, config, source: 'global' });
  assert.ok(!paths.includes(join(dir, '.reroute.json')));
  assert.equal(await projectRoot(cwd), dir);
  await assert.rejects(loadConfig(cwd), SyntaxError);
});

for (const manifest of ['package.json', 'Cargo.toml', 'pyproject.toml']) {
  test(`non-Git ${manifest} discovery includes the boundary, never ancestors, and keeps legacy precedence`, async t => {
    const { dir, boundary, cwd, config } = await fixture(t);
    const leaf = join(cwd, 'deep'); await mkdir(leaf);
    await writeFile(join(dir, manifest), '');
    const paths = configProbes(t);
    assert.equal(await projectRoot(leaf, boundary), leaf);
    assert.ok(!paths.includes(join(dir, manifest)));
    await writeFile(join(boundary, manifest), '');
    assert.equal(await projectRoot(leaf, boundary), boundary);
    await writeFile(join(cwd, manifest), '');
    assert.equal(await projectRoot(leaf, boundary), cwd);
    assert.equal(await projectRoot(leaf), cwd);
    // An ancestor reroute root still takes precedence over a nearer non-Git manifest.
    await writeFile(join(boundary, '.reroute.json'), JSON.stringify(config));
    assert.equal(await projectRoot(leaf, boundary), boundary);
    assert.deepEqual(await loadConfig(leaf, boundary), { root: boundary, config, source: 'project' });
    const alias = join(dir, 'alias'); await symlink(boundary, alias, 'dir');
    assert.equal(await projectRoot(join(alias, 'src', 'deep'), alias), boundary);
    assert.equal(await projectRoot(boundary, alias), boundary);
    await writeFile(join(boundary, '.reroute.json'), '{broken inside boundary');
    await assert.rejects(loadConfig(leaf, boundary), SyntaxError);
  });
}
