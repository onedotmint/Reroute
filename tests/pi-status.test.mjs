import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRerouteStatusTool } from '../dist/pi.js';
import { defaults, getJob, jobPath, saveConfig, saveJob } from '../dist/config.js';

async function fixture(t, status = 'running') {
  const base = await mkdtemp(join(tmpdir(), 'reroute-pi-status-'));
  const root = join(base, 'project'), cwd = join(root, 'nested');
  await mkdir(cwd, { recursive: true });
  const previous = process.env.REROUTE_STATE_DIR;
  process.env.REROUTE_STATE_DIR = join(base, 'state');
  t.after(async () => {
    if (previous === undefined) delete process.env.REROUTE_STATE_DIR;
    else process.env.REROUTE_STATE_DIR = previous;
    await rm(base, { recursive: true, force: true });
  });
  await saveConfig(root, { ...defaults(), active: 'fixture', profiles: { fixture: { provider: 'ssh', id: 'offline-host' } } });
  const job = { id: randomUUID(), project: root, profile: { provider: 'ssh', id: 'offline-host' },
    root: join(base, 'remote'), command: 'cargo test', cwd: '.', createdAt: new Date().toISOString(), status };
  await saveJob(job);
  return { base, root, cwd, job };
}

const query = (tool, jobId, cwd, signal) => tool.execute('status', { jobId }, signal, undefined, { cwd });

test('native status separates history from confirmed task receipt, including nonzero exit', async t => {
  const { root, cwd, job } = await fixture(t);
  job.error = 'old transport failure'; await saveJob(job);
  const tool = createRerouteStatusTool(async (id, action, options) => {
    assert.equal(id, job.id); assert.equal(action, 'status'); assert.equal(options.project, root);
    assert.ok(options.signal instanceof AbortSignal);
    const current = { ...job, status: 'exited', code: 7, error: undefined };
    options.onConfirmed(current); return current;
  });
  const r = await query(tool, job.id, cwd);
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent, r.details);
  assert.equal(r.details.recordedStatus, 'running');
  assert.equal(r.details.recordedExitCode, null);
  assert.equal(r.details.recordedError, 'old transport failure');
  assert.equal(r.details.remoteConfirmed, true); assert.equal(r.details.remoteStatus, 'exited');
  assert.equal(r.details.exitCode, 7); assert.equal(r.details.error, null);
  assert.match(r.content[0].text, /Remote status confirmed: yes/);
  assert.equal('profile' in r.details, false); assert.equal('project' in r.details, false);
});

test('unreachable, thrown or unconfirmed queries retain history without claiming current status', async t => {
  const { cwd, job } = await fixture(t);
  for (const status of ['exited', 'running', 'unknown']) {
    const recorded = { ...job, status, ...(status === 'exited' ? { code: 0 } : {}) };
    await saveJob(recorded);
    for (const throws of [false, true]) {
      const tool = createRerouteStatusTool(async () => {
        if (throws) throw Error('provider timed out');
        return { ...recorded, error: 'resource unreachable; last recorded state shown' };
      });
      const r = await query(tool, job.id, cwd);
      assert.equal(r.isError, true); assert.equal(r.details.recordedStatus, status);
      assert.equal(r.details.remoteConfirmed, false); assert.equal(r.details.remoteStatus, null);
      assert.equal(r.details.exitCode, recorded.code ?? null);
      assert.match(r.details.error, /timed out|unreachable/);
      assert.match(r.content[0].text, /Remote status: not confirmed/);
    }
  }
});

test('nested cwd and canonical project aliases are allowed; nested configured projects are separate', async t => {
  const { base, root, cwd, job } = await fixture(t);
  const alias = join(base, 'alias'); await symlink(root, alias, 'dir');
  job.project = join(root, 'nested', '..'); await saveJob(job);
  let calls = 0;
  const tool = createRerouteStatusTool(async (_id, _action, options) => {
    calls++; options.onConfirmed(job); return job;
  });
  assert.equal((await query(tool, job.id, join(alias, 'nested'))).details.remoteConfirmed, true);
  await saveConfig(cwd, { ...defaults(), active: 'nested', profiles: { nested: { provider: 'ssh', id: 'nested-host' } } });
  const r = await query(tool, job.id, cwd);
  assert.equal(r.isError, true); assert.equal(r.details.recordedStatus, null); assert.equal(calls, 1);
});

test('unknown, invalid and cross-project IDs fail before inspection without revealing foreign records', async t => {
  const { base, root, cwd, job } = await fixture(t);
  let calls = 0;
  const tool = createRerouteStatusTool(async () => { calls++; throw Error('must not query'); });
  for (const id of ['../escape', '', randomUUID()]) {
    const r = await query(tool, id, cwd);
    assert.equal(r.isError, true); assert.equal(r.details.recordedStatus, null);
    assert.match(r.details.error, /Invalid job ID|Unknown job ID/);
  }
  await writeFile(jobPath(job.id), JSON.stringify({ ...job, id: randomUUID() }));
  const mismatched = await query(tool, job.id, cwd);
  assert.equal(mismatched.isError, true); assert.equal(mismatched.details.recordedStatus, null);
  const foreign = join(base, 'foreign'); await mkdir(foreign);
  job.project = foreign; job.status = 'exited'; job.code = 23; job.error = 'PRIVATE_DIAGNOSTIC';
  await saveJob(job);
  let r = await query(tool, job.id, root);
  assert.equal(r.isError, true); assert.equal(r.details.recordedStatus, null); assert.equal(r.details.exitCode, null);
  assert.doesNotMatch(r.content[0].text, /PRIVATE_DIAGNOSTIC|foreign/);
  await rm(foreign, { recursive: true });
  r = await query(tool, job.id, cwd);
  assert.match(r.details.error, /does not belong/); assert.doesNotMatch(r.content[0].text, /foreign/);
  await writeFile(jobPath(job.id), '{"PRIVATE_DIAGNOSTIC":');
  r = await query(tool, job.id, cwd);
  assert.match(r.details.error, /Could not read/); assert.doesNotMatch(r.content[0].text, /PRIVATE_DIAGNOSTIC/);
  assert.equal(calls, 0);
});

test('pre-aborted query does not inspect; persistence failure can still report received confirmation', async t => {
  const { cwd, job } = await fixture(t);
  let calls = 0;
  const tool = createRerouteStatusTool(async (_id, _action, options) => {
    calls++; options.onConfirmed({ ...job, status: 'exited', code: 0 }); throw Error('local receipt save failed');
  });
  const controller = new AbortController(); controller.abort();
  assert.equal((await query(tool, job.id, cwd, controller.signal)).details.remoteConfirmed, false);
  assert.equal(calls, 0);
  const r = await query(tool, job.id, cwd);
  assert.equal(r.isError, true); assert.equal(r.details.remoteConfirmed, true);
  assert.equal(r.details.remoteStatus, 'exited'); assert.match(r.details.error, /save failed/);
  assert.equal((await getJob(job.id)).status, 'running');
});
