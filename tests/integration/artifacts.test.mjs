import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fetchArtifacts, validArtifactPath } from '../../dist/sync/artifacts.js';
import { Synchronizer } from '../../dist/sync/sync.js';
import { validateConfig, merge, DEFAULT_CONFIG } from '../../dist/config/config.js';
import { fixture, transport, policy } from '../helpers.mjs';

for (const path of ['../target/a','target','src/a','target/../a','target/*.bin','build/.env','dist/key.pem','build/.git/config','target/.reroute/project.json','build/node_modules/a','build/a\nb']) test('artifact scope refuses '+JSON.stringify(path), () => {
  assert.equal(validArtifactPath(path),false);
  assert.throws(()=>validateConfig(merge(structuredClone(DEFAULT_CONFIG),{artifacts:{paths:[path]}})), /artifacts/);
});
test('explicit artifact read leaves source/cache/baseline separate and never overwrites previous downloads', async t => {
  const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
  await fs.writeFile(join(f.local,'src.txt'),'source'); await sync.reconcile(files);
  const baseline = await fs.readFile(join(f.local,'.reroute/sync-base.json'));
  await fs.mkdir(join(f.remote,'target/release'),{recursive:true});
  await fs.writeFile(join(f.remote,'target/release/app'), Buffer.from([0,255,1,2]));
  await fs.mkdir(join(f.local,'target/release'),{recursive:true}); await fs.writeFile(join(f.local,'target/release/app'),'local cache');
  const artifactPolicy = {paths:['target/release/app'],maxFileBytes:10};
  const first = await fetchArtifacts(f.local,artifactPolicy,files), second = await fetchArtifacts(f.local,artifactPolicy,files);
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await fs.readFile(join(first.directory,'target/release/app')), Buffer.from([0,255,1,2]));
  assert.equal(await fs.readFile(join(f.local,'target/release/app'),'utf8'),'local cache');
  assert.deepEqual(await fs.readFile(join(f.local,'.reroute/sync-base.json')),baseline);
  assert.deepEqual(Object.keys(await files.scan(policy)), ['src.txt']);
  assert.equal((await fs.stat(join(first.directory,'target/release/app'))).mode & 0o111, 0);
});
for (const kind of ['directory','oversize','symlink','ancestor-symlink']) test('worker artifact rejects '+kind+' without writing source', async t => {
  const f = await fixture(t); await fs.mkdir(join(f.remote,'build')); const path = join(f.remote,'build/output');
  if (kind === 'directory') await fs.mkdir(path);
  if (kind === 'oversize') await fs.writeFile(path,'too large');
  if (kind === 'symlink') { await fs.writeFile(join(f.remote,'source'),'no'); await fs.symlink(join(f.remote,'source'),path); }
  if (kind === 'ancestor-symlink') { await fs.rm(join(f.remote,'build'),{recursive:true}); await fs.symlink(f.local,join(f.remote,'build')); }
  await assert.rejects(fetchArtifacts(f.local,{paths:['build/output'],maxFileBytes:3},transport(f.runtime)), /Artifact retrieval failed/);
  await assert.rejects(fs.stat(join(f.local,'build/output')), {code:'ENOENT'});
});
test('corrupt transfer and local state symlink are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(fetchArtifacts(f.local,{paths:['dist/app'],maxFileBytes:10},{readArtifact:async()=>({data:'YQ==',size:1,hash:'0'.repeat(64),mode:0o644})}), /invalid/);
  await fs.rm(join(f.local,'.reroute'),{recursive:true}); await fs.symlink(f.remote,join(f.local,'.reroute'));
  await assert.rejects(fetchArtifacts(f.local,{paths:['dist/app'],maxFileBytes:10},transport(f.runtime)), /symlink/);
  assert.deepEqual(await fs.readdir(f.remote), []);
});

test('source scan enforces the exact file-count boundary', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.local,'a'),'a'); await fs.writeFile(join(f.local,'b'),'b');
  const { scanLocal } = await import('../../dist/sync/sync.js');
  assert.equal(Object.keys(await scanLocal(f.local,{...policy,maxFiles:2})).length,2);
  await assert.rejects(scanLocal(f.local,{...policy,maxFiles:1}), /file-count limit/);
});
