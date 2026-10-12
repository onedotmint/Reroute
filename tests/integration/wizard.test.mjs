import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const driver = String.raw`import os,pty,subprocess,select,time,sys,json,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,70,0,0))
child=subprocess.Popen([sys.argv[1],sys.argv[2],'setup'],stdin=slave,stdout=slave,stderr=slave)
os.close(slave); text=b''; steps=json.loads(sys.argv[3]); index=0; deadline=time.monotonic()+15
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],.05)
  if ready:
   try: data=os.read(master,65536)
   except OSError: break
   if not data: break
   text+=data
   if index<len(steps) and steps[index][0].encode() in text:
    time.sleep(.05);os.write(master,steps[index][1].encode());index+=1
  if child.poll() is not None and not ready: break
 try: code=child.wait(timeout=max(.1,deadline-time.monotonic()))
 except subprocess.TimeoutExpired: child.kill();raise RuntimeError('wizard blocked: '+text.decode())
 print(json.dumps({'code':code,'steps':index,'output':text.decode()}))
finally:
 if child.poll() is None: child.kill();child.wait()
 os.close(master)
`;
async function run(t, steps, config) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'reroute-wizard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'), home = join(dir, 'home');
  await fs.mkdir(project); await fs.mkdir(home);
  if (config) await fs.writeFile(join(project, 'reroute.toml'), config);
  const env = { ...process.env, HOME: home, USERPROFILE: home, REROUTE_AGENT_HOME: home, REROUTE_HOME: join(dir, 'state'), CI: '', TERM: 'xterm', ACCESSIBLE: '0' };
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn('python3', ['-c', driver, process.execPath, resolve('bin/reroute.mjs'), JSON.stringify(steps)], { cwd: project, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', code => code === 0 ? resolveRun(JSON.parse(stdout)) : reject(new Error(stderr + stdout)));
  });
  return { result, dir, project, home };
}
for (const key of ['\x1b', '\x03']) {
  test(`Clack safe cancellation (${key === '\x1b' ? 'Esc' : 'Ctrl+C'}) has no side effects`, async t => {
    const f = await run(t, [['Target provider', key]]);
    assert.equal(f.result.code, 130, f.result.output);
    assert.match(f.result.output, /No configuration or resource changes/);
    assert.deepEqual(await fs.readdir(f.project), []);
    await assert.rejects(fs.stat(join(f.dir, 'state')), { code: 'ENOENT' });
  });
}
test('existing provider/host/tasks are prefilled and summary cancellation preserves TOML byte-for-byte', async t => {
  const config = 'provider = "ssh"\n[providers.ssh]\nhost = "existing-host"\n[routing]\nmode = "tasks"\ntasks = ["test"]\n';
  const f = await run(t, [['Target provider', '\r'], ['Existing OpenSSH host alias', '\r'], ['Automatically offload task categories', '\r'], ['Save configuration?', '\x1b']], config);
  assert.equal(f.result.code, 130, f.result.output);
  assert.match(f.result.output, /existing-host/);
  assert.match(f.result.output, /Routing: tasks \(test\)/);
  assert.equal(await fs.readFile(join(f.project, 'reroute.toml'), 'utf8'), config);
  assert.deepEqual(await fs.readdir(f.project), ['reroute.toml']);
  await assert.rejects(fs.stat(join(f.dir, 'state')), { code: 'ENOENT' });
});
