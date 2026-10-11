/** SDK/CLI wire fixtures: actual remote worker and real child processes, no cloud calls.
 * These prove mapping and transport behavior, NOT that vendor APIs accepted a request.
 */
import { promises as fs } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import { DaytonaProvider } from '../dist/providers/daytona.js';
import { ModalProvider } from '../dist/providers/modal.js';
import { E2BProvider } from '../dist/providers/e2b.js';
import { SshProvider } from '../dist/providers/ssh.js';
import { SkyPilotProvider } from '../dist/providers/skypilot.js';
const notFound=()=>Object.assign(new Error('fixture not found'),{status:404});
function native(argv, cwd) {
  const child=spawn(argv[0],argv.slice(1),{cwd,stdio:'pipe',detached:true});
  child.stdin.on('error',()=>{});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??143));});
  void done.catch(()=>{});
  const stdin=new WritableStream({
    write:data=>new Promise((resolve,reject)=>child.stdin.write(Buffer.from(data),e=>e?reject(e):resolve())),
    close:()=>{child.stdin.end();},
  });
  return {child,done,stdin,stdout:child.stdout,stderr:child.stderr};
}
export async function providerFixture(id,f,t) {
  const records={created:[],idle:[],commands:[],deleted:0,blockStdin:false,blockedWrites:0,nativeStdinCloses:0};let state='missing',sandbox, generation=0;
  if(id==='modal') {
    class ModalClient {
      apps={fromName:async(name,opts)=>({name,opts})};images={fromRegistry:name=>({name})};
      volumes={fromName:async name=>({name})};secrets={fromName:async name=>({name})};
      sandboxes={
        fromId:async()=>{if(!sandbox||state==='missing')throw notFound();return sandbox;},
        fromName:async()=>{if(!sandbox||state==='missing')throw notFound();return sandbox;},
        create:async(app,image,options)=>{
          records.created.push({app,image,...options});state='running';
          sandbox={sandboxId:'modal-fixture-'+(++generation),poll:async()=>state==='running'?null:0,
            terminate:async()=>{state='stopped';records.deleted++;},tunnels:async()=>({3000:{url:'https://fixture.modal.invalid'}}),
            exec:async(argv,options)=>{
              records.commands.push({argv,options});const p=native(argv),writer=p.stdin.getWriter();
              const stdin=new WritableStream({write:data=>{if(records.blockStdin){records.blockedWrites++;return new Promise(()=>{});}return writer.write(data);},close:()=>writer.close()});
              return {stdin,stdout:p.stdout,stderr:p.stderr,wait:()=>p.done,closeStdin:async()=>{records.nativeStdinCloses++;p.child.stdin.end();}};
            }};
          return sandbox;
        }
      };
    }
    return {provider:new ModalProvider({volumeMount:f.remote},async()=>({ModalClient})),records};
  }
  if(id==='e2b') {
    let processes=new Map();
    const SDK={
      list:()=>({hasNext:false,nextItems:async()=>[]}),
      getInfo:async()=>{if(state==='missing')throw notFound();return {state:state==='stopped'?'paused':state};},
      connect:async()=>{if(state==='missing')throw notFound();state='running';return sandbox;},
      create:async(template,options)=>{
        records.created.push({template,...options});state='running';
        sandbox={sandboxId:'e2b-fixture',setTimeout:async ms=>records.idle.push(ms),pause:async()=>{state='stopped';return true;},kill:async()=>{state='missing';records.deleted++;return true;},getHost:port=>`${port}.e2b.invalid`,
          commands:{
            run:async(command,options)=>{
              records.commands.push({command,options});
              const p=native(['/bin/sh','-c',command.replaceAll('/home/user/reroute',f.remote)]);processes.set(p.child.pid,p);
              p.stdout.on('data',data=>options.onStdout(data.toString()));p.stderr.on('data',data=>options.onStderr(data.toString()));
              return {pid:p.child.pid,wait:async()=>{const exitCode=await p.done; if(exitCode!==0)throw Object.assign(new Error('exit'),{exitCode});return {exitCode};}};
            },
            sendStdin:async(pid,data)=>new Promise((resolve,reject)=>processes.get(pid).child.stdin.write(Buffer.from(data),e=>e?reject(e):resolve())),
            closeStdin:async pid=>processes.get(pid).child.stdin.end(),
            kill:async pid=>{const p=processes.get(pid);try{process.kill(-pid,'SIGTERM');}catch{}await p.done;return true;}
          }};return sandbox;
      }
    };
    return {provider:new E2BProvider({},async()=>({Sandbox:SDK})),records};
  }
  const bin=join(f.directory,'bin');await fs.mkdir(bin,{recursive:true});
  const old=process.env.PATH;process.env.PATH=bin+delimiter+old;t.after(()=>{process.env.PATH=old;});
  const dispatch=`#!/usr/bin/env python3\nimport os,sys\ncommand=sys.argv[-1].replace('/tmp/reroute/',${JSON.stringify(f.remote + '/')})\nos.execv('/bin/sh',['sh','-c',command])\n`;
  await fs.writeFile(join(bin,'ssh'),dispatch,{mode:0o700});
  if(id==='ssh')return {provider:new SshProvider({host:'fixture',remoteRoot:f.remote}),records};
  if(id==='skypilot') {
    await fs.writeFile(join(bin,'sky'),`#!/usr/bin/env python3\nimport sys\nif sys.argv[1]=='status':print('fixture UP')\n`,{mode:0o700});
    return {provider:new SkyPilotProvider({remoteRoot:f.remote}),records};
  }
  class DaytonaNotFoundError extends Error { statusCode = 404; }
  class Daytona {
    async get(){if(!sandbox||state==='missing')throw new DaytonaNotFoundError('fixture not found');return sandbox;}
    async create(options){records.created.push(options);state='running';records.refresh=0;records.autoDelete=[];sandbox={id:'daytona-fixture',state:'started',labels:options.labels,sandboxClass:'container',gpu:0,spot:false,autoDeleteInterval:options.autoDeleteInterval,
      start:async()=>{state='running';sandbox.state='started';},stop:async()=>{state='stopped';sandbox.state='stopped';},
      setAutoDeleteInterval:async value=>{records.autoDelete.push(value);sandbox.autoDeleteInterval=value;},refreshActivity:async()=>{records.refresh++;},
      setAutostopInterval:async value=>records.idle.push(value),createSshAccess:async()=>({token:'temporary-fixture-token',sshCommand:'ssh temporary-fixture-token@ssh.app.daytona.io',expiresAt:new Date(Date.now()+30*60000)}),getPreviewLink:async()=>({url:'https://fixture.daytona.invalid',token:'preview-fixture-token'}),getSignedPreviewUrl:async()=>({url:'https://fixture.daytona.invalid',token:'preview-fixture-token'})};return sandbox;}
    async delete(){state='missing';records.deleted++;}
  }
  return {provider:new DaytonaProvider({},async()=>({Daytona,DaytonaNotFoundError})),records};
}
