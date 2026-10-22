import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../dist/setup.js';
import { presets } from '../dist/resources.js';
import { hash } from '../dist/util.js';

const managed = { nonInteractive:true, provider:'daytona', managed:true, preset:'small', image:'my-toolchain:reviewed', cpuHourUsd:'0.0504', memoryHourUsd:'0.0162' };
async function project(fn) {
  const root = await mkdtemp(join(tmpdir(), 'reroute-managed-setup-'));
  try { await fn(root); } finally { await rm(root, {recursive:true, force:true}); }
}

test('managed setup is local-only, needs no ID, uses shared presets and defaults to unauthorized', async()=>{
  await project(async root=>{
    const config = await setup(root, {...managed, credential:'build-account', preset:'medium'});
    const profile = config.profiles.default;
    assert.equal(profile.provider, 'daytona');
    assert.equal(profile.id, 'auto');
    assert.equal(profile.credential, 'build-account');
    assert.equal(profile.image, managed.image);
    assert.deepEqual(profile.compute, presets.medium);
    assert.deepEqual(profile.managed, {
      authorized:false, maxCpu:8, maxMemoryGiB:16, monthlyUsd:3, maxTaskUsd:0.5,
      cpuHourUsd:0.0504, memoryGiBHourUsd:0.0162, storageMonthUsd:0.01, idleMinutes:5,
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, '.reroute.json'), 'utf8')), config);
  });
});

test('Modal custom sizing and explicit billing authorization save without a live account', async()=>{
  await project(async root=>{
    const config = await setup(root, {...managed, provider:'modal', preset:'custom', cpu:'0.5', memory:'1.5',
      authorize:true, maxCpu:'2', maxMemory:'8', monthlyUsd:'12', maxTaskUsd:'0.2',
      cpuHourUsd:'0.141912', memoryHourUsd:'0.024012', storageMonthUsd:'0', idleMinutes:'1'});
    assert.deepEqual(config.profiles.default.compute, {cpu:0.5, memoryGiB:1.5});
    assert.deepEqual(config.profiles.default.managed, {
      authorized:true, maxCpu:2, maxMemoryGiB:8, monthlyUsd:12, maxTaskUsd:0.2,
      cpuHourUsd:0.141912, memoryGiBHourUsd:0.024012, storageMonthUsd:0, idleMinutes:1,
    });
  });
});

test('managed setup rejects missing rates, invalid input and incompatible policies without changing saved config', async()=>{
  await project(async root=>{
    await setup(root, {nonInteractive:true, provider:'ssh', id:'offline-fixture'});
    const before = await readFile(join(root, '.reroute.json'), 'utf8');
    const bad = [
      {image:undefined}, {image:''}, {image:'bad\nimage'}, {cpuHourUsd:undefined}, {memoryHourUsd:undefined},
      {preset:'unknown'}, {preset:''}, {preset:'toString'}, {preset:'small',cpu:'2'},
      {preset:'custom',cpu:'1'}, {preset:'custom',cpu:'1.5',memory:'2'},
      {preset:'custom',cpu:'1',memory:'2.5'}, {provider:'ssh'},
      {maxCpu:'0.5'}, {maxMemory:'1'}, {idleMinutes:'1.5'}, {idleMinutes:'1441'},
      {credential:'../other'}, {id:'existing-sandbox'},
    ];
    for (const key of ['cpuHourUsd','memoryHourUsd','monthlyUsd','maxTaskUsd','storageMonthUsd','idleMinutes','maxCpu','maxMemory']) {
      for (const value of ['', 'not-a-number', 'Infinity', '-1']) bad.push({[key]:value});
    }
    for (const patch of bad) {
      await assert.rejects(setup(root, {...managed, name:'new-cloud', ...patch}), undefined, JSON.stringify(patch));
      assert.equal(await readFile(join(root, '.reroute.json'), 'utf8'), before, JSON.stringify(patch));
    }
  });
});

test('existing providers and profile edits stay compatible; misplaced managed flags are not silently ignored', async()=>{
  await project(async root=>{
    await setup(root, {nonInteractive:true, provider:'ssh', id:'offline-fixture', name:'existing'});
    const config = await setup(root, {nonInteractive:true, name:'existing', tasks:'none'});
    assert.equal(config.profiles.existing.id, 'offline-fixture');
    assert.equal(config.profiles.existing.managed, undefined);
    assert.deepEqual(config.tasks, []);
    const cloud = await setup(root, {nonInteractive:true, provider:'daytona', name:'cloud', id:'existing-sandbox', credential:'account-b'});
    assert.equal(cloud.profiles.cloud.id, 'existing-sandbox');
    assert.equal(cloud.profiles.cloud.credential, 'account-b');
    await assert.rejects(setup(root, {nonInteractive:true, name:'existing', monthlyUsd:'bad'}), /require --managed/);
  });
});

test('editing managed policy requires explicit rates and does not carry prior authorization forward', async()=>{
  await project(async root=>{
    await setup(root, {...managed, authorize:true});
    await assert.rejects(setup(root, {nonInteractive:true}), /cpu-hour-usd/);
    const config = await setup(root, {nonInteractive:true, cpuHourUsd:'0.0504', memoryHourUsd:'0.0162'});
    assert.equal(config.profiles.default.managed.authorized, false);
    assert.deepEqual(config.profiles.default.compute, presets.small);
  });
});
