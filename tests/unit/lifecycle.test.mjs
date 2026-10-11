import test from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../../dist/core/lifecycle.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(t, apply) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], errors = []; let idle = 0;
  const provider = { async applyIdlePolicy(_runtime, policy) { calls.push(policy); await apply?.(policy, calls.length); } };
  const lifecycle = new Lifecycle(provider, {}, 10, () => idle++, error => errors.push(error));
  t.after(() => lifecycle.dispose());
  return { lifecycle, calls, errors, get idle() { return idle; } };
}

test('renewal is completion-paced, with no concurrent or accumulated requests', async t => {
  const gate = deferred();
  const f = setup(t, async (_policy, count) => { if (count === 2) await gate.promise; });
  const release = await f.lifecycle.acquire();
  t.mock.timers.tick(60000); await flush();
  assert.equal(f.calls.length, 2);
  t.mock.timers.tick(24 * 3600000); await flush();
  assert.equal(f.calls.length, 2);
  gate.resolve(); await flush();
  t.mock.timers.tick(59999); await flush(); assert.equal(f.calls.length, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(f.calls.length, 3);
  await release();
});

test('renewal failure reports the original error once, retaining the pending lease', async t => {
  const failure = new Error('network');
  const f = setup(t, async (_policy, count) => { if (count === 2) throw failure; });
  const release = await f.lifecycle.acquire();
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(f.errors, [failure]); assert.equal(f.lifecycle.active, 1);
  t.mock.timers.tick(3600000); await flush(); assert.equal(f.calls.length, 2);
  await release(); assert.equal(f.lifecycle.active, 0);
});

test('dispose invalidates in-flight and queued renewal and idle work', async t => {
  const gate = deferred();
  const f = setup(t, async (_policy, count) => { if (count === 2) await gate.promise; });
  const release = await f.lifecycle.acquire();
  t.mock.timers.tick(60000); await flush();
  f.lifecycle.dispose(); gate.resolve(); await flush();
  await release(); t.mock.timers.tick(3600000); await flush();
  assert.equal(f.calls.length, 2); assert.equal(f.idle, 0);
  await assert.rejects(f.lifecycle.acquire(), /disposed/);
});

test('an idle deadline queued before acquire cannot stop an active lease', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], scheduled = []; let idle = 0;
  const f = new Lifecycle({ async applyIdlePolicy(_r, p) { calls.push(p); } }, {}, 1, () => idle++, e => { throw e; }, op => { scheduled.push(op); return Promise.resolve(); });
  t.after(() => f.dispose());
  await f.arm(); t.mock.timers.tick(60000); await flush();
  const release = await f.acquire(); await scheduled[0]();
  assert.equal(idle, 0); assert.equal(calls.filter(p => !p.active && p.minutes === 0).length, 0);
  await release();
});

test('an idle policy waiting behind renewal is invalidated by a new lease', async t => {
  const gate = deferred();
  const f = setup(t, async (_p, count) => { if (count === 2) await gate.promise; });
  const release = await f.lifecycle.acquire();
  t.mock.timers.tick(60000); await flush();
  const releasing = release(); const acquiring = f.lifecycle.acquire();
  gate.resolve(); await releasing; const nextRelease = await acquiring;
  assert.equal(f.calls.some(p => !p.active), false);
  await nextRelease();
});

test('concurrent initial acquisitions share activation failure without leaking leases', async t => {
  const gate = deferred(), failure = new Error('activation failed');
  const f = setup(t, async () => { await gate.promise; throw failure; });
  const first = f.lifecycle.acquire(), second = f.lifecycle.acquire();
  const results = Promise.allSettled([first, second]); gate.resolve();
  assert.deepEqual((await results).map(r => r.reason), [failure, failure]);
  assert.equal(f.lifecycle.active, 0); assert.equal(f.calls.length, 1);
});
