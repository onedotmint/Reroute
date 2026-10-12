import test from 'node:test';
import assert from 'node:assert/strict';
import { rawCapture } from '../../dist/providers/common.js';
import { spawnRaw } from '../../dist/platform/process.js';

function fake(events, extra = {}) {
  let killed = 0;
  return { events, closeInput: async()=>{}, wait: async()=>0, kill: async()=>{killed++;}, get killed(){return killed;}, ...extra };
}
test('control output limit kills its transport', async () => {
  const raw = fake((async function*(){yield {stream:'stdout',data:Buffer.alloc(1024*1024)};})());
  await assert.rejects(rawCapture(raw), e=>e.code==='CONTROL_OUTPUT_LIMIT'); assert.equal(raw.killed,1);
});
test('deadline covers stalled input closure and requests transport cleanup', async () => {
  const raw = fake((async function*(){})(),{closeInput:()=>new Promise(()=>{})});
  await assert.rejects(rawCapture(raw,20), e=>e.code==='CONTROL_TIMEOUT' && e.exitCode===124); assert.equal(raw.killed,1);
});
test('deadline stops a real nonterminating control process group', async () => {
  const raw = spawnRaw(process.execPath,['-e','setInterval(()=>{},1000)']);
  await assert.rejects(rawCapture(raw,100), e=>e.code==='CONTROL_TIMEOUT');
  assert.notEqual(await raw.wait(),0);
});
test('normal capture preserves output and cleans timeout without killing', async () => {
  const raw = fake((async function*(){yield {stream:'stdout',data:Buffer.from('ok')};})());
  assert.equal(await rawCapture(raw,100),'ok'); assert.equal(raw.killed,0);
});
