import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { exec, fixture } from '../helpers.mjs';
import { execute } from '../../dist/providers/channel.js';
import { AsyncQueue } from '../../dist/core/queue.js';

async function blockedInput(t, options = {}) {
  const f = await fixture(t);
  const handle = await exec(f.runtime, ['python3', '-u', '-c',
    "import pathlib,time;print('ready',flush=True);time.sleep(4);pathlib.Path('MUST_NOT_EXIST').write_text('not cancelled')"], options);
  t.after(() => handle.cancel());
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const output = (async () => {
    for await (const event of handle.events) if (event.data.toString().includes('ready')) ready();
  })();
  await started;
  const writing = handle.write(Buffer.alloc(4 * 1024 * 1024)).then(() => null, error => error);
  return { ...f, handle, writing, output };
}

test('cancel bypasses a full child stdin pipe and prevents delayed writes', { timeout: 12000 }, async t => {
  const f = await blockedInput(t);
  await sleep(100);
  const before = Date.now();
  await f.handle.cancel();
  await Promise.all([f.writing, f.output]);
  const result = await f.handle.wait();
  assert.ok(Date.now() - before < 2500, 'cancel waited for the unread stdin or command completion');
  assert.equal(result.cancelled, true);
  assert.notEqual(result.code, 0);
  await assert.rejects(fs.stat(join(f.remote, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
});

test('timeout still terminates a command whose stdin pipe is full', { timeout: 12000 }, async t => {
  const f = await blockedInput(t, { timeoutMs: 300 });
  await Promise.all([f.writing, f.output]);
  const result = await f.handle.wait();
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  await assert.rejects(fs.stat(join(f.remote, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
});

test('cancel deadline starts even when the transport never finishes sending', { timeout: 10000 }, async t => {
  const events = new AsyncQueue();
  events.push({ stream: 'stdout', data: Buffer.from('{"type":"started"}\n') });
  let killed = false;
  const raw = {
    events,
    write: () => new Promise(() => {}),
    closeInput: async () => {},
    wait: async () => 0,
    kill: async () => {
      killed = true;
      events.push({ stream: 'stdout', data: Buffer.from('{"type":"exit","code":143,"cancelled":true}\n') });
      events.end();
    }
  };
  const handle = await execute(async () => raw, { root: '/fixture' }, { argv: ['python3'], cwd: '/fixture', env: {} });
  const watchdog = setTimeout(() => { void raw.kill(); }, 8000);
  t.after(() => { clearTimeout(watchdog); });
  const eof = handle.endInput();
  await handle.cancel();
  await eof;
  assert.equal(killed, true);
  assert.equal((await handle.wait()).cancelled, true);
});

test('bounded stdin preserves concurrent write ordering and EOF for a slow reader', async t => {
  const f = await fixture(t);
  const handle = await exec(f.runtime, ['python3', '-u', '-c',
    "import hashlib,sys,time;h=hashlib.sha256()\nwhile True:\n data=sys.stdin.buffer.read(4096)\n if not data:break\n h.update(data);time.sleep(.001)\nprint(h.hexdigest())"]);
  const first = Buffer.alloc(256 * 1024, 1), second = Buffer.alloc(256 * 1024, 2);
  const writing = Promise.all([handle.write(first), handle.write(second), handle.endInput()]);
  let output = '';
  for await (const event of handle.events) output += event.data;
  await writing;
  assert.equal((await handle.wait()).code, 0);
  assert.equal(output.trim(), createHash('sha256').update(first).update(second).digest('hex'));
});
