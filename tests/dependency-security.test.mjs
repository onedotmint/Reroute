import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { supportedNode } from '../dist/doctor.js';

// Lockfile regression only: absence of known packages is not a general malware scan.
test('security baseline excludes the removed vulnerable glob chain and known compromised Axios releases', async () => {
 const lock = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
 const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
 assert.equal(lock.packages[''].engines.node, manifest.engines.node);
 assert.equal(manifest.engines.node, '^22.23.4 || ^24.22.1 || >=26.12.1');
 assert.equal((await readFile(new URL('../.nvmrc', import.meta.url), 'utf8')).trim(), '24.22.1');
 for (const [path, pkg] of Object.entries(lock.packages)) {
  assert.ok(!/(?:^|\/)node_modules\/(?:braces|micromatch|fast-glob|plain-crypto-js)$/.test(path), path);
  if (path.endsWith('node_modules/axios')) assert.ok(!['1.14.1','0.30.4'].includes(pkg.version), path);
 }
});

test('doctor rejects pre-security and end-of-life runtime lines while accepting patched releases', () => {
 for (const version of ['22.19.0','22.23.3','24.21.0','24.22.0','26.12.0','20.20.0','23.11.0','25.9.0','24.22.1-rc.1','invalid']) {
  assert.equal(supportedNode(version), false, version);
 }
 for (const version of ['22.23.4','22.24.0','24.22.1','v24.22.2','24.23.0','26.12.1','26.13.0','27.0.0']) {
  assert.equal(supportedNode(version), true, version);
 }
});
