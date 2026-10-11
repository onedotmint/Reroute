import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDist } from '../../scripts/check-dist.mjs';
import { checkPackage } from '../../scripts/check-package.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('freshness check detects stale source without rebuilding delivered dist', t => {
  const project = mkdtempSync(join(tmpdir(), 'reroute-dist-fixture-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, 'dist'));
  symlinkSync(join(root, '.tools'), join(project, '.tools'), 'dir');
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', rootDir: 'src', outDir: 'dist', declaration: true, types: [] }, include: ['src/**/*.ts'] }));
  writeFileSync(join(project, 'src/value.ts'), 'export const value = 1;\n');
  writeFileSync(join(project, 'dist/value.js'), 'export const value = 1;\n');
  writeFileSync(join(project, 'dist/value.d.ts'), 'export declare const value = 1;\n');
  checkDist(project);
  writeFileSync(join(project, 'src/value.ts'), 'export const value = 2;\n');
  assert.throws(() => checkDist(project), /dist does not match src:.*value/);
  assert.equal(readFileSync(join(project, 'dist/value.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(readFileSync(join(project, 'dist/value.d.ts'), 'utf8'), 'export declare const value = 1;\n');
  writeFileSync(join(project, 'src/value.ts'), 'export const value = 1;\n');
  rmSync(join(project, 'dist/value.d.ts'));
  writeFileSync(join(project, 'dist/obsolete.js'), 'obsolete\n');
  assert.throws(() => checkDist(project), /dist does not match src:.*obsolete.js.*value.d.ts|dist does not match src:.*value.d.ts.*obsolete.js/);
  assert.deepEqual(readdirSync(join(project, 'dist')).sort(), ['obsolete.js', 'value.js']);
});

test('npm package installs offline without touching inherited HOME, npm config or cache', t => {
  const ambient = mkdtempSync(join(tmpdir(), 'reroute-npm-ambient-'));
  const config = join(ambient, 'user.npmrc');
  writeFileSync(config, 'registry=http://127.0.0.1:1\n');
  const overrides = { HOME: ambient, NPM_CONFIG_USERCONFIG: config, npm_config_cache: join(ambient, 'cache'), REROUTE_HOME: join(ambient, 'state') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(ambient, { recursive: true, force: true });
  });
  checkPackage(root);
  assert.deepEqual(readdirSync(ambient), ['user.npmrc']);
  assert.equal(readFileSync(config, 'utf8'), 'registry=http://127.0.0.1:1\n');
  for (const [key, value] of Object.entries(overrides)) assert.equal(process.env[key], value);
});
