import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '../../dist/daemon/server.js';
import { request } from '../../dist/daemon/client.js';
import { endpoint, lines, send } from '../../dist/daemon/protocol.js';
import { Coordinator } from '../../dist/core/coordinator.js';
import { quote } from '../../dist/platform/process.js';
import { fixture, FixtureProvider } from '../helpers.mjs';
const cli=resolve('bin/reroute.mjs');
function childRun(argv,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(argv[0],argv.slice(1),{cwd:options.cwd,env:options.env??process.env,stdio:['pipe','pipe','pipe']});
    // A short command may close its unused stdin before our empty EOF write.
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');child.stdin.destroy();reject(new Error('CLI did not exit: '+argv.slice(1,3).join(' ')+'\n'+stderr));},20000);
    child.stdout.on('data',data=>{stdout+=data;options.onOutput?.(data.toString(),child);});child.stderr.on('data',data=>{stderr+=data;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
    if(!options.openInput)child.stdin.end(options.input??'');
  });
}
async function context(t) {
  const cleanup = [], f=await fixture({ after: fn => cleanup.push(fn) }),old=process.env.REROUTE_HOME,oldAgent=process.env.REROUTE_AGENT_HOME;
  process.env.REROUTE_HOME=join(f.directory,'home');process.env.REROUTE_AGENT_HOME=join(f.directory,'agents');
  const provider=new FixtureProvider(f.remote),core=new Coordinator(()=>provider),server=await serve(core);
  t.after(async()=>{try { await server.close(); } finally { for(const [key,value]of [['REROUTE_HOME',old],['REROUTE_AGENT_HOME',oldAgent]]){if(value===undefined)delete process.env[key];else process.env[key]=value;} for (const fn of cleanup.reverse()) await fn(); }});
  const reroute=(...args)=>childRun([process.execPath,cli,...args],{cwd:f.local});
  return {...f,core,provider,server,reroute};
}
test('CLI setup discovers Pi, enables a real IPC project, routes shell and keeps Git local',async t=>{
  const f=await context(t);await fs.mkdir(join(process.env.REROUTE_AGENT_HOME,'.pi/agent'),{recursive:true});
  const setup=await f.reroute('setup','--harness','pi');assert.equal(setup.code,0,setup.stderr);const report=JSON.parse(setup.stdout);assert.ok(report.detected.includes('pi'));assert.deepEqual(Object.keys(report.installed),['pi']);
  assert.equal((await childRun(['git','init'],{cwd:f.local})).code,0);
  const enabled=await f.reroute('enable','--provider','ssh','--host','fixture');assert.equal(enabled.code,0,enabled.stderr);
  await fs.mkdir(join(f.local,'src'));await fs.writeFile(join(f.local,'src/input'),'source');await fs.writeFile(join(f.local,'.env'),'FAKE_SECRET=must_not_sync');
  const program="import os,pathlib;assert pathlib.Path('input').read_text()=='source';assert os.environ['INLINE_VALUE']=='kept';print('RUNTIME='+os.getcwd());pathlib.Path('generated.lock').write_text('new');pathlib.Path('target').mkdir(exist_ok=True);pathlib.Path('target/cache').write_text('remote only')";
  const shell='cd src && INLINE_VALUE=kept python3 -c '+quote(program)+' && git rev-parse --show-toplevel';
  const executed=await f.reroute('shell','--',shell);assert.equal(executed.code,0,executed.stderr);
  assert.ok(executed.stdout.includes('RUNTIME='+join(f.remote,'src')),executed.stdout);assert.ok(executed.stdout.includes(f.local));
  assert.equal(await fs.readFile(join(f.local,'src/generated.lock'),'utf8'),'new');
  await assert.rejects(fs.stat(join(f.local,'src/target')),{code:'ENOENT'});await assert.rejects(fs.stat(join(f.remote,'.env')),{code:'ENOENT'});await assert.rejects(fs.stat(join(f.remote,'.git')),{code:'ENOENT'});
  const piped=await f.reroute('shell','--',"printf 'binary-input' | python3 -c "+quote('import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'));
  assert.equal(piped.code,0,piped.stderr);assert.equal(piped.stdout,'binary-input');
  const exited=await f.reroute('exec','--','python3','-c',"import sys;print('out');print('err',file=sys.stderr);sys.exit(23)");assert.equal(exited.code,23,exited.stderr);assert.match(exited.stdout,/out/);assert.match(exited.stderr,/err/);
  const status=JSON.parse((await f.reroute('status')).stdout);assert.equal(status.active,0);assert.equal(f.provider.readyCount,1);
  assert.equal((await f.reroute('doctor')).code,0);assert.equal((await f.reroute('disable')).code,0);
});
test('CLI enabled-provider failure cannot fall back; explicit local remains usable',async t=>{
  const f=await context(t);assert.equal((await f.reroute('enable','--provider','ssh','--host','fixture')).code,0);
  f.provider.ensureReady=async()=>{throw new Error('offline provider fixture');};
  const script="open('MUST_NOT_EXIST','w').write('bad')";const result=await f.reroute('exec','--','python3','-c',script);assert.notEqual(result.code,0);
  await assert.rejects(fs.stat(join(f.local,'MUST_NOT_EXIST')),{code:'ENOENT'});
  const local=await f.reroute('local','--','python3','-c',"open('explicit-local','w').write('ok')");assert.equal(local.code,0,local.stderr);assert.equal(await fs.readFile(join(f.local,'explicit-local'),'utf8'),'ok');
});
test('IPC rejects invalid authentication and secret forwarding before execution',async t=>{
  const f=await context(t);
  const reply=await new Promise((resolve,reject)=>{const socket=net.createConnection(endpoint());let data='';socket.on('error',reject);socket.on('data',x=>{data+=x;});socket.on('end',()=>resolve(JSON.parse(data)));socket.on('connect',()=>socket.write(JSON.stringify({v:1,token:'not-the-token',op:'ping'})+'\n'));});
  assert.equal(reply.type,'error');assert.equal(reply.code,'IPC_AUTH');
  await assert.rejects(()=>request({op:'run',cwd:f.local,argv:['python3','-c','pass'],env:{AWS_SECRET_ACCESS_KEY:'synthetic-only'}}),/Unsafe environment/);
  assert.equal(f.provider.readyCount,0);
});
test('client crash cancels a running process group and releases daemon lease',async t=>{
  const f=await context(t);await f.reroute('enable','--provider','ssh','--host','fixture');
  const program="import time,pathlib;print('client-ready',flush=True);time.sleep(3);pathlib.Path('MUST_NOT_EXIST').write_text('orphan')";
  const result=await childRun([process.execPath,cli,'exec','--','python3','-u','-c',program],{cwd:f.local,onOutput:(data,child)=>{if(data.includes('client-ready'))child.kill('SIGKILL');}});
  assert.equal(result.signal,'SIGKILL');let active=1,deadline=Date.now()+6000;
  while((active=(await f.core.status(f.local)).active)!==0&&Date.now()<deadline)await sleep(25);
  assert.equal(active,0);await assert.rejects(fs.stat(join(f.remote,'MUST_NOT_EXIST')),{code:'ENOENT'});
});
test('CLI exits when the command does not read its still-open stdin pipe',async t=>{
  const f=await context(t);await f.reroute('enable','--provider','ssh','--host','fixture');
  const result=await childRun([process.execPath,cli,'exec','--','python3','-c',"print('done')"],{cwd:f.local,openInput:true});
  assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'done\n');
});
test('reenable refreshes coordinator configuration without replacing project identity',async t=>{
  const f=await context(t);await f.reroute('enable','--provider','ssh','--host','fixture');
  const before=await f.core.start(f.local);
  await f.core.enable(f.local,'ssh',{providers:{ssh:{host:'fixture'}},routing:{commands:['python3','custom-runtime']}});
  const after=await f.core.start(f.local);assert.equal(before.project.id,after.project.id);
  // Routing accepts the refreshed group and reaches the provider rather than rejecting it as control-plane.
  const result=await f.core.run({cwd:f.local,argv:['custom-runtime'],env:{}});assert.equal(result.code,127);
});

test('IPC cancel bypasses queued stdin writes to a non-reading process', { timeout: 12000 }, async t => {
  const f = await context(t);
  await f.reroute('enable', '--provider', 'ssh', '--host', 'fixture');
  const token = await fs.readFile(join(process.env.REROUTE_HOME, 'ipc-token'), 'utf8');
  const socket = net.createConnection(endpoint());
  t.after(() => socket.destroy());
  const before = Date.now();
  const result = await new Promise((resolve, reject) => {
    let timer;
    socket.once('connect', () => {
      void send(socket, { v: 1, token, op: 'run', cwd: f.local, env: {}, argv: ['python3', '-u', '-c', "import pathlib,time;print('ready');time.sleep(4);pathlib.Path('MUST_NOT_EXIST').write_text('late')"] }).catch(reject);
    });
    socket.on('error', reject);
    lines(socket, packet => {
      if (packet.type === 'ready') {
        const data = Buffer.alloc(32768).toString('base64');
        for (let i = 0; i < 128; i++) socket.write(JSON.stringify({ type: 'stdin', data }) + '\n');
        timer = setTimeout(() => { void send(socket, { type: 'cancel' }).catch(reject); }, 100);
        t.after(() => clearTimeout(timer));
      } else if (packet.type === 'exit') { socket.end(); resolve(packet); }
      else if (packet.type === 'error') reject(new Error(packet.message));
    }, reject);
  });
  assert.equal(result.cancelled, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - before < 2500);
  await assert.rejects(fs.stat(join(f.remote, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
});

for (const action of ['timeout', 'cancel']) {
  test(`CLI ${action} cannot report success when the program handles TERM with exit 0`, { timeout: 10000 }, async t => {
    const f = await context(t);
    await f.reroute('enable', '--provider', 'ssh', '--host', 'fixture');
    const program = "import signal,sys,time;signal.signal(signal.SIGTERM,lambda *_:sys.exit(0));print('ready',flush=True);time.sleep(30)";
    const args = ['exec', ...(action === 'timeout' ? ['--timeout-ms', '1000'] : []), '--', 'python3', '-u', '-c', program];
    const result = await childRun([process.execPath, cli, ...args], {
      cwd: f.local,
      onOutput: (data, child) => { if (action === 'cancel' && data.includes('ready')) child.kill('SIGINT'); }
    });
    assert.match(result.stdout, /ready/);
    assert.equal(result.code, action === 'timeout' ? 124 : 130, result.stderr);
  });
}
