import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Coordinator } from '../../dist/core/coordinator.js';
import { fixture, FixtureProvider, exec } from '../helpers.mjs';

for (const kind of ['foreground', 'dev']) {
  test(`${kind} executes from an empty nested local directory`, { timeout: 10000 }, async t => {
    const f = await fixture(t), old = process.env.REROUTE_HOME;
    process.env.REROUTE_HOME = join(f.directory, 'home');
    const core = new Coordinator(() => new FixtureProvider(f.remote));
    t.after(async () => { await core.shutdown(); if (old === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = old; });
    await core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture' } } });
    const cwd = join(f.local, 'empty', 'nested');
    await fs.mkdir(cwd, { recursive: true });
    const input = { cwd, argv: ['python3', '-u', '-c', "import os,time;print(os.getcwd(),flush=True);" + (kind === 'dev' ? 'time.sleep(30)' : '')], env: {} };
    const expected = join(f.remote, 'empty', 'nested');
    if (kind === 'foreground') {
      let output = '';
      const result = await core.run(input, { onOutput: event => { output += event.data; } });
      assert.equal(result.code, 0);
      assert.equal(output.trim(), expected);
    } else {
      await core.devStart(input);
      let output = '', deadline = Date.now() + 5000;
      while (!(output = await core.devLogs(cwd)).includes(expected) && Date.now() < deadline) await sleep(20);
      assert.ok(output.includes(expected), output);
      await core.devStop(cwd);
    }
    assert.ok((await fs.stat(expected)).isDirectory());
  });
}

for (const kind of ['outside', 'symlink', 'file']) {
  test(`worker rejects ${kind} cwd without following it or blaming Python`, async t => {
    const f = await fixture(t);
    let cwd;
    if (kind === 'outside') cwd = join(f.directory, 'outside', 'new');
    else if (kind === 'symlink') {
      await fs.mkdir(join(f.remote, 'real'));
      await fs.symlink(join(f.remote, 'real'), join(f.remote, 'link'));
      cwd = join(f.remote, 'link', 'new');
    } else {
      await fs.writeFile(join(f.remote, 'file'), 'must stay');
      cwd = join(f.remote, 'file', 'new');
    }
    await assert.rejects(exec(f.runtime, ['python3', '-c', 'pass'], { cwd }), error => error.code === 'REMOTE_WORKER' && /CWD_OUTSIDE_PROJECT|SYMLINK_CWD|CWD_NOT_DIRECTORY/.test(error.message));
    if (kind === 'outside') await assert.rejects(fs.stat(join(f.directory, 'outside')), { code: 'ENOENT' });
    if (kind === 'symlink') await assert.rejects(fs.stat(join(f.remote, 'real', 'new')), { code: 'ENOENT' });
    if (kind === 'file') assert.equal(await fs.readFile(join(f.remote, 'file'), 'utf8'), 'must stay');
  });
}

for (const kind of ['missing', 'permission']) {
  test(`valid empty cwd preserves ${kind} executable error classification`, async t => {
    const f = await fixture(t);
    const command = join(f.remote, 'tool');
    if (kind === 'permission') { await fs.writeFile(command, '#!/bin/sh\nexit 0\n'); await fs.chmod(command, 0o600); }
    const handle = await exec(f.runtime, [command], { cwd: join(f.remote, 'empty', 'nested') });
    let stderr = '';
    for await (const event of handle.events) if (event.stream === 'stderr') stderr += event.data;
    assert.equal((await handle.wait()).code, kind === 'missing' ? 127 : 126);
    assert.match(stderr, kind === 'missing' ? /Executable not found/ : /executable permission denied/);
    assert.ok((await fs.stat(join(f.remote, 'empty', 'nested'))).isDirectory());
  });
}
