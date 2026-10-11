import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createProvider } from '../../dist/providers/index.js';
import { loadConfig } from '../../dist/config/config.js';
import { Synchronizer } from '../../dist/sync/sync.js';
import { fixture, collect } from '../helpers.mjs';
const selected=new Set((process.env.REROUTE_LIVE_PROVIDERS??'').split(','));
for(const id of ['daytona','ssh','skypilot','modal','e2b']) test(id+' LIVE provider (explicit opt-in; may incur charges)',async t=>{
  if(process.env.REROUTE_LIVE!=='1'||!selected.has(id)){t.skip('SKIPPED: provider not configured for an explicit live run');return;}
  if((id==='daytona'&&!process.env.DAYTONA_API_KEY)||(id==='e2b'&&!process.env.E2B_API_KEY)||(id==='ssh'&&!process.env.REROUTE_SSH_HOST)){
    t.skip('SKIPPED: provider credentials/target not configured');return;
  }
  if(id==='modal'&&!process.env.MODAL_TOKEN_ID){try{await fs.access(join(homedir(),'.modal.toml'));}catch{t.skip('SKIPPED: Modal native credentials not configured');return;}}
  const f=await fixture(t);
  const override={provider:id,...(id==='ssh'?{providers:{ssh:{host:process.env.REROUTE_SSH_HOST}}}:{})};
  const config=await loadConfig(process.env.REROUTE_LIVE_CONFIG_ROOT??f.local,override),provider=createProvider(config);
  let runtime;
  t.after(async()=>{if(runtime)await provider.destroy(runtime);});
  await fs.writeFile(join(f.local,'live-source.txt'),'reroute-live-source');
  runtime=await provider.ensureReady(f.project,config.runtime);
  assert.equal(runtime.provider,id);assert.equal(await provider.status(runtime),'running');
  await provider.applyIdlePolicy(runtime,{active:true,minutes:10});
  const sync=new Synchronizer(f.local,config.sync);await sync.reconcile(provider.files(runtime));
  const handle=await provider.exec(runtime,{argv:['python3','-u','-c',"import os,sys,pathlib;assert pathlib.Path('live-source.txt').read_text()=='reroute-live-source';print(sys.stdin.read());print('live-stderr',file=sys.stderr);pathlib.Path('generated.lock').write_text('live');sys.exit(17)"],cwd:runtime.root,env:{},timeoutMs:30000});
  const result=await collect(handle,'live-stdin');assert.equal(result.code,17);assert.equal(result.stdout.toString(),'live-stdin\n');assert.equal(result.stderr.toString(),'live-stderr\n');
  await sync.reconcile(provider.files(runtime));assert.equal(await fs.readFile(join(f.local,'generated.lock'),'utf8'),'live');
  await provider.applyIdlePolicy(runtime,{active:false,minutes:10});
});
