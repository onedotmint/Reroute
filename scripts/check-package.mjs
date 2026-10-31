import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp, rm, access, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const source = JSON.parse(await readFile('package.json', 'utf8'));
// Keep the locked 1.1 development contract; test current independently installed hosts too.
const hostVersion = process.env.REROUTE_TEST_PI_VERSION ?? '1.4.0';
assert.match(hostVersion, /^\d+\.\d+\.\d+$/, 'Use an exact Pi host test version');
const output = resolve('.artifacts');
await mkdir(output, { recursive: true });
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr || result.stdout || result.error}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
};
const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', output]));
// npm 11 emits an array; npm 12 keys the result by package name.
const pack = Array.isArray(packed) ? packed[0] : packed[source.name];
assert.equal(pack?.name, source.name, 'npm pack must return this package');
for (const file of ['dist/cli.js', 'assets/task.py', 'adapters/pi.ts', 'README.md', 'DELIVERY.md', 'NOTICE', 'LICENSE']) {
  assert.ok(pack.files.some(entry => entry.path === file), `Package missing ${file}`);
}
for (const file of pack.files) {
  assert.ok(/^(bin\/reroute\.mjs|dist\/|src\/|adapters\/|assets\/|docs\/|package\.json$|README\.md$|DELIVERY\.md$|LICENSE$|NOTICE$)/.test(file.path), file.path);
  assert.ok(!/(^|\/)(node_modules|\.git|\.env|\.reroute|\.npmrc|npm-shrinkwrap\.json|package-lock\.json|rerouted|sync-back)(\/|$)/.test(file.path), file.path);
}
assert.equal(source.scripts.preinstall, undefined);
assert.equal(source.scripts.install, undefined);
assert.equal(source.scripts.postinstall, undefined);
const clean = await mkdtemp(join(tmpdir(), 'reroute-install-'));
try {
  // Do not inherit credentials, personal npm config, NODE_PATH or the checkout's module roots.
  const env = { PATH: process.env.PATH, CI: 'true', HOME: clean, USERPROFILE: clean,
    PI_OFFLINE: '1', REROUTE_LIVE: '0', PI_CODING_AGENT_DIR: join(clean, 'agent'),
    XDG_CONFIG_HOME: join(clean, 'config'), XDG_DATA_HOME: join(clean, 'data'),
    XDG_STATE_HOME: join(clean, 'state'), XDG_CACHE_HOME: join(clean, 'cache'),
    REROUTE_STATE_DIR: join(clean, 'reroute-state'),
    npm_config_userconfig: join(clean, 'user.npmrc'), npm_config_globalconfig: join(clean, 'global.npmrc'),
    npm_config_cache: join(clean, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org/' };
  for (const dir of ['agent', 'project', 'host']) await mkdir(join(clean, dir));
  await writeFile(env.npm_config_userconfig, '');
  await writeFile(env.npm_config_globalconfig, '');
  const options = { cwd: clean, env };
  const npm = run('npm', ['--version'], options).trim();
  // The real host is installed independently, never resolved from the source checkout or global Pi.
  const host = join(clean, 'host');
  run('npm', ['install', '--prefix', host, '--ignore-scripts', '--no-audit', '--no-fund',
    `@earendil-works/pi-coding-agent@${hostVersion}`], options);
  await copyFile('scripts/probe-installed.mjs', join(clean, 'probe.mjs'));
  await copyFile('tests/smoke.mjs', join(clean, 'smoke.mjs'));
  const installs = [];
  for (const mode of ['default-policy', 'no-scripts']) {
    const prefix = join(clean, mode);
    await mkdir(prefix);
    const started = performance.now();
    const installLog = run('npm', ['install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund',
      ...(mode === 'no-scripts' ? ['--ignore-scripts'] : []), join(output, pack.filename)], options);
    await writeFile(join(output, `install-${mode}.log`), installLog);
    const installMs = Math.round(performance.now() - started);
    const packageDir = join(prefix, 'node_modules', source.name);
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, source.name);
    assert.equal(pkg.version, source.version);
    for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@google/genai', 'esbuild', 'typescript']) {
      await assert.rejects(access(join(prefix, 'node_modules', name)), { code: 'ENOENT' }, `Unexpected production dependency: ${name}`);
    }
    for (const lock of ['npm-shrinkwrap.json', 'package-lock.json']) await assert.rejects(access(join(packageDir, lock)), { code: 'ENOENT' });
    const smoke = run(process.execPath, [join(clean, 'smoke.mjs'), join(packageDir, 'bin/reroute.mjs')], options);
    const probe = run(process.execPath, [join(clean, 'probe.mjs'), packageDir, host, join(clean, 'project'), env.PI_CODING_AGENT_DIR], options);
    const tree = run('npm', ['ls', '--prefix', prefix, '--all', '--parseable'], options);
    const installedPackages = new Set(tree.trim().split('\n')).size - 1;
    // du measures actual Linux allocation, not tarball bytes or all-platform lock entries.
    const nodeModulesKiB = Number(run('du', ['-sk', join(prefix, 'node_modules')], options).trim().split(/\s+/)[0]);
    assert.ok(Number.isSafeInteger(nodeModulesKiB) && nodeModulesKiB > 0);
    // A fresh consumer resolution has its own audit gate, independent of the repository lock.
    const audit = run('npm', ['audit', '--prefix', prefix, '--omit=dev', '--audit-level=high', '--json'], options);
    await writeFile(join(output, `audit-consumer-${mode}.json`), audit);
    installs.push({ mode, installMs, installedPackages, nodeModulesKiB, smoke: JSON.parse(smoke), probe: JSON.parse(probe), vulnerabilities: JSON.parse(audit).metadata.vulnerabilities });
  }
  const commit = process.env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']).trim();
  const sourceTreeDirty = run('git', ['status', '--porcelain', '--untracked-files=normal']).trim().length > 0;
  const report = { commit, sourceTreeDirty, name: source.name, version: source.version, tarball: pack.filename,
    integrity: pack.integrity, shasum: pack.shasum, packageBytes: pack.size, unpackedBytes: pack.unpackedSize,
    cleanInstall: true, smoke: true, node: process.version, npm, hostVersion, installs };
  await writeFile(join(output, 'COMMIT.txt'), commit + '\n');
  await writeFile(join(output, 'package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  await rm(clean, { recursive: true, force: true });
}
