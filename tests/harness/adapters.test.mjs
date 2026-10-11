import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { transformHook } from '../../dist/adapters/hooks.js';
import { bridgeCommand } from '../../dist/core/activation.js';
import { registerPi } from '../../adapters/pi.mjs';
import omp from '../../adapters/omp.mjs';
import opencode from '../../adapters/opencode.mjs';
import { rerouteExecutor } from '../../adapters/deepseek.mjs';
import { mergeHookFile, installHarness, HARNESSES } from '../../dist/cli/setup.js';
import { fixture } from '../helpers.mjs';
for(const host of ['claude','codex','cursor']) {
  test(host+' normal Bash wire schema with all unrelated fields preserved',()=>{
    const packet={hook_event_name:host==='cursor'?'preToolUse':'PreToolUse',tool_name:'Bash',tool_input:{command:'cd front && pnpm test',timeout:123,description:'tests'}};
    const result=transformHook(host,packet), input=host==='cursor'?result.updated_input:result.hookSpecificOutput.updatedInput;
    assert.equal(input.command,bridgeCommand(packet.tool_input.command));assert.equal(input.timeout,123);assert.equal(input.description,'tests');
    assert.deepEqual(transformHook(host,{...packet,tool_input:input}),{});
    if(host==='codex')assert.equal(result.hookSpecificOutput.permissionDecision,'allow');
    if(host==='claude')assert.equal(result.hookSpecificOutput.permissionDecision,undefined);
    assert.deepEqual(transformHook(host,{tool_name:'Read',tool_input:{path:'x'}}),{});
    assert.throws(()=>transformHook(host,{tool_name:'Bash',tool_input:{command:[]}}));
  });
}
test('Pi retains native Bash definition and user-shell options',async()=>{
  const callbacks={};let registered,config,seen;
  const sdk={createBashTool:(cwd,options)=>{config=options;return {name:'bash',parameters:{native:true},cwd};},createLocalBashOperations:()=>({exec:async(...args)=>{seen=args;return {exitCode:13};}})};
  registerPi({registerTool:tool=>registered=tool,on:(name,fn)=>callbacks[name]=fn},sdk);
  assert.equal(registered.name,'bash');assert.equal(registered.parameters.native,true);
  const spawned=config.spawnHook({command:'cargo test',cwd:'/local',env:{PATH:'/usr/bin',TEST:'x'}});
  assert.equal(spawned.command,'cargo test');assert.ok(spawned.env.PATH.endsWith('/usr/bin'));assert.equal(spawned.env.TEST,'x');
  const options={signal:new AbortController().signal,onData:()=>{},timeout:3};
  const result=await callbacks.user_bash().operations.exec('pytest','/local',options);
  assert.equal(result.exitCode,13);assert.equal(seen[2],options);assert.equal(seen[0],bridgeCommand('pytest'));
});
test('OMP uses current input replacement, not the incompatible Pi operation surface',()=>{
  let callback;omp({on:(name,cb)=>{assert.equal(name,'tool_call');callback=cb;}});
  assert.equal(callback({toolName:'read'}),undefined);
  const result=callback({toolName:'bash',input:{command:'pytest',timeout:20}});
  assert.equal(result.input.command,bridgeCommand('pytest'));assert.equal(result.input.timeout,20);
  assert.equal(callback({toolName:'bash',input:{}}).block,true);
});
test('OpenCode v2 hooks only shell creation and keeps command fields',async()=>{
  let callback;await opencode.setup({shell:{hook:async(name,fn)=>{assert.equal(name,'create.before');callback=fn;}}});
  const event={command:'pnpm test',cwd:'/project',timeout:90,env:{PATH:'/bin',MY_VALUE:'x'}};callback(event);
  assert.equal(event.command,'pnpm test');assert.equal(event.timeout,90);assert.ok(event.env.PATH.includes('shims'));assert.equal(event.env.MY_VALUE,'x');
  await assert.rejects(()=>opencode.setup({}),/requires OpenCode v2/);
});
test('DeepSeek preserves native foreground/background handle and trusted environment',async()=>{
  const handle={done:Promise.resolve(),result:()=>({exitCode:7})};let received;
  class Native { static inject=['subprocess']; resolve(x){return x;} execute(spec){received=spec;return handle;} }
  const Executor=rerouteExecutor(Native),executor=new Executor();
  const spec={command:'cargo test',env:{FOO:'bar'},dshEnv:{DSH_SESSION_ID:'native'},signal:new AbortController().signal,onExpiry:'none'};
  assert.equal(executor.execute(spec),handle);assert.equal(received.signal,spec.signal);assert.equal(received.dshEnv,spec.dshEnv);assert.equal(received.onExpiry,'none');assert.deepEqual(Executor.inject,['subprocess']);
});
test('hook installation is idempotent and preserves unrelated settings',async t=>{
  const f=await fixture(t),old=process.env.REROUTE_HOME;process.env.REROUTE_HOME=join(f.directory,'home');t.after(()=>{if(old===undefined)delete process.env.REROUTE_HOME;else process.env.REROUTE_HOME=old;});
  const file=join(f.local,'settings.json');const foreign={matcher:'Bash',hooks:[{type:'command',command:'other-policy-tool'}]};
  await fs.writeFile(file,JSON.stringify({theme:'custom',hooks:{PreToolUse:[foreign]}}));
  await mergeHookFile(file,'claude');await mergeHookFile(file,'claude');const result=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(result.theme,'custom');assert.deepEqual(result.hooks.PreToolUse[0],foreign);assert.equal(result.hooks.PreToolUse.length,2);
  await fs.writeFile(file,'not JSON');await assert.rejects(()=>mergeHookFile(file,'claude'));assert.equal(await fs.readFile(file,'utf8'),'not JSON');
});
test('all seven adapter installation paths are produced without editing unrelated files',async t=>{
  const f=await fixture(t),oldHome=process.env.REROUTE_HOME,oldAgent=process.env.REROUTE_AGENT_HOME;
  process.env.REROUTE_HOME=join(f.directory,'home');process.env.REROUTE_AGENT_HOME=f.local;
  t.after(()=>{for(const [key,value] of [['REROUTE_HOME',oldHome],['REROUTE_AGENT_HOME',oldAgent]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  for(const id of HARNESSES)assert.equal(typeof await installHarness(id),'string');
  assert.ok((await fs.readFile(join(f.local,'.pi/agent/extensions/reroute.ts'),'utf8')).includes('registerPi'));
  const cursor=JSON.parse(await fs.readFile(join(f.local,'.cursor/hooks.json'),'utf8'));assert.equal(cursor.hooks.preToolUse[0].failClosed,true);
});
