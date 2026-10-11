import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.mjs';
import { providerFixture } from '../provider-fixtures.mjs';
import { DEFAULT_CONFIG } from '../../dist/config/config.js';

test('Modal fallback closes only the worker stdin independently of a stuck SDK writer', { timeout: 15000 }, async t => {
  const f = await fixture(t), { provider, records } = await providerFixture('modal', f, t);
  const runtime = await provider.ensureReady(f.project, DEFAULT_CONFIG.runtime);
  const input = { argv: ['python3', '-u', '-c', "import time;print('ready');time.sleep(30)"], cwd: runtime.root, env: {} };
  const peer = await provider.exec(runtime, input);
  await peer.endInput();
  let peerEnded = false;
  void peer.wait().then(() => { peerEnded = true; });
  const peerOutput = (async () => { for await (const _event of peer.events) {} })();
  const handle = await provider.exec(runtime, input);
  let ready;
  const first = new Promise(resolve => { ready = resolve; });
  const output = (async () => {
    for await (const event of handle.events) if (event.data.toString().includes('ready')) ready();
  })();
  await first;
  t.after(async () => { records.blockStdin = false; await Promise.all([handle.cancel(), peer.cancel()]); });
  records.blockStdin = true;
  const before = Date.now();
  await handle.cancel();
  await output;
  assert.ok(Date.now() - before < 7500, 'Modal cancellation remained blocked on WritableStream');
  assert.equal((await handle.wait()).cancelled, true);
  assert.equal(records.blockedWrites, 1, 'fallback must not write another cancel into the blocked stream');
  assert.equal(records.nativeStdinCloses, 1);
  assert.equal(records.deleted, 0);
  assert.equal(peerEnded, false, 'cancelling one command must not terminate its peer');
  records.blockStdin = false;
  await peer.cancel();
  await peerOutput;
});
