import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function checkPackage(project = root) {
  const temporary = mkdtempSync(join(tmpdir(), 'reroute-npm-check-'));
  try {
    const home = join(temporary, 'home'), prefix = join(temporary, 'install');
    mkdirSync(home);
    const userconfig = join(temporary, 'user.npmrc'), globalconfig = join(temporary, 'global.npmrc');
    writeFileSync(userconfig, '');
    writeFileSync(globalconfig, '');
    // Ignore inherited npm config and never read/write the user's HOME or npm cache.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: join(temporary, 'cache'), REROUTE_HOME: join(home, '.reroute'), REROUTE_AGENT_HOME: home, REROUTE_LIVE: '0', NPM_CONFIG_CACHE: join(temporary, 'npm-cache'), NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig, NPM_CONFIG_UPDATE_NOTIFIER: 'false' });
    delete env.NODE_OPTIONS;
    const run = (command, args, cwd = temporary) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
      if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr + result.stdout}`);
      return result.stdout;
    };
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@clack/prompts'], 'only the standalone setup UI adds a runtime dependency');
    assert.deepEqual(manifest.bundleDependencies, ['@clack/prompts'], 'bundle the small prompt library for offline installation');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const [packed] = JSON.parse(run(npm, ['pack', project, '--pack-destination', temporary, '--ignore-scripts', '--json', '--offline']));
    const paths = packed.files.map(file => file.path);
    const bundled = ['@clack/core', '@clack/prompts', 'fast-string-truncated-width', 'fast-string-width', 'fast-wrap-ansi', 'sisteransi'];
    assert.deepEqual([...packed.bundled].sort(), bundled, 'do not bundle host runtimes or provider SDKs');
    for (const id of bundled) assert(paths.some(path => path.toLowerCase() === `node_modules/${id}/license`), `missing bundled license: ${id}`);
    for (const required of ['bin/reroute.mjs', 'bin/rerouted.mjs', 'dist/cli/main.js', 'dist/core/contracts.js', 'assets/worker.py', 'package.json', 'README.md', 'LICENSE', 'NOTICE']) {
      assert(paths.includes(required), `npm tarball is missing ${required}`);
    }
    for (const path of paths) {
      if (path.startsWith('node_modules/')) assert(bundled.some(id => path.startsWith(`node_modules/${id}/`)), `unexpected bundled path: ${path}`);
      assert(!path.split('/').some(part => ['.git', '.tools', '.reroute', '..'].includes(part) || part === '.env' || part.startsWith('.env.')) && !/\.(key|pem|p12|pfx)$/.test(path), `unsafe npm tarball path: ${path}`);
    }
    // Bundled Clack and its transitive dependencies need no registry access.
    run(npm, ['install', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', join(temporary, packed.filename)]);
    const installed = join(prefix, 'node_modules', manifest.name);
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, manifest.version);
    const cli = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'reroute.cmd' : 'reroute');
    assert(existsSync(cli), 'npm did not install the reroute executable');
    assert(existsSync(join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'rerouted.cmd' : 'rerouted')), 'npm did not install the rerouted executable');
    assert.match(run(cli, ['--help'], prefix), /Reroute.*local source, remote project execution/);
    run(process.execPath, ['--input-type=module', '-e', "await import('reroute'); await import('./node_modules/reroute/dist/cli/wizard.js')"], prefix);
    console.log('npm tarball, clean offline prefix install, installed CLI and core export passed.');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkPackage(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
