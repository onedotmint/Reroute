import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { activeProfile, loadConfig, listJobs, saveConfig } from './config.js';
import { runRemote, inspectJob, downloadArtifact, cleanupJob, resourceAction } from './engine.js';
import { ruleRouter } from './router.js';
import { setup, installPi } from './setup.js';
import { doctor } from './doctor.js';
import { shell, processExec } from './util.js';
import { createProvider } from './providers/index.js';
export const HELP = `Reroute 0.3 - local source, native remote compute

  reroute setup                         Interactive project + Pi configuration
  reroute setup --non-interactive --provider ssh --id user@host [--no-pi]
  reroute exec [--timeout SECONDS] [--stdin] -- cargo test   Force remote
  reroute run -- cargo test              Conservative automatic routing
  reroute local -- cargo test            Force local
  reroute explain -- cargo test          Explain the routing decision
  reroute exec --shell 'cmd && cmd'       Explicitly trusted compound command
  reroute doctor [--connect] [--json]     Local prerequisites; optional live check
  reroute status [JOB_ID] [--json]        Read-only resource / job status
  reroute jobs [--json]                  Local receipts (no cloud calls)
  reroute cancel JOB_ID                  Request and verify remote termination
  reroute artifacts JOB_ID PATH --to FILE.tgz   Explicit archive; never overwrite
  reroute cleanup JOB_ID --yes           Remove a confirmed terminal task only
  reroute profile NAME                   Select an existing profile
  reroute mode auto|local                Set routing mode
  reroute resource stop|destroy --yes
  reroute resource resume --yes --allow-cost
  reroute pi install                    Register the owned Pi extension entry

Global: --cwd DIR. Setup: --name NAME --root /remote/path --port N
  --identity KEYFILE --app MODAL_APP --tasks build,test,check,benchmark
  --ignore-legacy (isolated v3; old data retained). Nothing is provisioned by setup.
Exit: task exit code, 124 confirmed timeout, 130 confirmed cancellation,
  125 infrastructure failure / unknown / incomplete output. Never local retry.
`;
function output(value:unknown){console.log(JSON.stringify(value,null,2));}
export async function main(argv=process.argv.slice(2)): Promise<void> {
  try {
    const boundary=argv.indexOf('--'), payload=boundary<0?[]:argv.slice(boundary+1), prefix=boundary<0?argv:argv.slice(0,boundary);
    const {values:v,positionals:a}=parseArgs({args:prefix,allowPositionals:true,strict:true,options:{
      help:{type:'boolean',short:'h'},version:{type:'boolean'},json:{type:'boolean'},cwd:{type:'string'},shell:{type:'string'},timeout:{type:'string'},stdin:{type:'boolean'},connect:{type:'boolean'},yes:{type:'boolean'},'allow-cost':{type:'boolean'},
      'non-interactive':{type:'boolean'},provider:{type:'string'},id:{type:'string'},name:{type:'string'},root:{type:'string'},port:{type:'string'},identity:{type:'string'},app:{type:'string'},tasks:{type:'string'},'no-pi':{type:'boolean'},'ignore-legacy':{type:'boolean'},to:{type:'string'},
    }});
    const command=a[0], cwd=resolve(v.cwd??process.cwd());
    if(v.version){console.log('0.3.0-native.2');return;}
    if(v.help||!command){console.log(HELP);return;}
    if(command==='setup'){const config=await setup(cwd,{nonInteractive:v['non-interactive'],provider:v.provider,id:v.id,name:v.name,root:v.root,port:v.port,identity:v.identity,app:v.app,tasks:v.tasks,noPi:v['no-pi'],ignoreLegacy:v['ignore-legacy']});if(v['non-interactive'])output({saved:true,active:config.active,pi:!v['no-pi']});return;}
    if(command==='pi'&&a[1]==='install'){output({entry:await installPi()});return;}
    if(command==='doctor'){const r=await doctor(cwd,v.connect);output(r);process.exitCode=r.ok?0:1;return;}
    if(command==='jobs'){const {root}=await loadConfig(cwd);output((await listJobs()).filter(j=>j.project===root));return;}
    if(['exec','run','local','explain'].includes(command)){
      if(v.shell!==undefined&&payload.length)throw new Error('Use either --shell or -- argument list, not both');
      const raw=v.shell??(payload.length?shell(payload):'');if(!raw.trim())throw new Error('Command required after -- (or provide --shell)');
      const {root,config}=command==='local'?{root:cwd,config:undefined}:await loadConfig(cwd);
      const decision=command==='exec'?{route:'remote',reason:'explicit-remote'}:command==='local'?{route:'local',reason:'explicit-local'}:config?await ruleRouter(raw,cwd,config):{route:'local',reason:'not-configured'};
      if(command==='explain'){output({...decision,command:raw});return;}
      const timeoutMs=v.timeout===undefined?undefined:Number(v.timeout)*1000;
      if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>86400000))throw new Error('--timeout must be a number in (0,86400] seconds');
      const controller=new AbortController(), abort=()=>controller.abort(); process.once('SIGINT',abort);process.once('SIGTERM',abort);
      try {
        const streams={stdout:(b:Buffer)=>{process.stdout.write(b);},stderr:(b:Buffer)=>{process.stderr.write(b);},signal:controller.signal,timeoutMs,stdin:v.stdin?process.stdin:undefined};
        if(decision.route==='local'){const result=await processExec('bash',['-lc',raw],{...streams,cwd});process.exitCode=result.code;}
        else {const result=await runRemote(raw,{...streams,root,config,cwd,onJob:j=>process.stderr.write(`[reroute ${j.id} -> ${j.profile.provider}]\n`)});process.exitCode=result.code;if(result.job.error)process.stderr.write(result.job.error+'\n');if(result.job.status!=='exited')process.stderr.write(`[reroute ${result.job.status}]\n`);}
      }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}return;
    }
    if(command==='status'&&a[1]){output(await inspectJob(a[1]));return;}
    if(command==='cancel'){if(!a[1])throw new Error('Job ID required');const r=await inspectJob(a[1],'cancel');output(r);if(r.status!=='cancelled'&&r.status!=='exited')process.exitCode=125;return;}
    if(command==='artifacts'){if(!a[1]||!a[2]||!v.to)throw new Error('Use artifacts JOB_ID PATH --to FILE.tgz');output({file:await downloadArtifact(a[1],a[2],v.to)});return;}
    if(command==='cleanup'){if(!v.yes||!a[1])throw new Error('Use cleanup JOB_ID --yes');await cleanupJob(a[1]);output({removed:a[1]});return;}
    const {root,config}=await loadConfig(cwd);if(!config)throw new Error('No project configuration; run reroute setup');
    if(command==='status'){const provider=createProvider(activeProfile(config));try{output({profile:config.active,provider:provider.profile.provider,id:provider.profile.id,resource:await provider.status(),mode:config.mode});}finally{await provider.close?.();}return;}
    if(command==='profile'){if(!a[1]||!config.profiles[a[1]])throw new Error('Choose an existing profile: '+Object.keys(config.profiles).join(', '));config.active=a[1];await saveConfig(root,config);output({active:config.active});return;}
    if(command==='mode'){if(a[1]!=='auto'&&a[1]!=='local')throw new Error('Mode must be auto or local');config.mode=a[1];await saveConfig(root,config);output({mode:config.mode});return;}
    if(command==='resource'){
      const action=a[1];if(!['stop','resume','destroy'].includes(action??'')||!v.yes)throw new Error('Use resource stop|resume|destroy --yes');
      if(action==='resume'&&!v['allow-cost'])throw new Error('Explicit resume can incur charges; add --allow-cost');
      await resourceAction(root,config,action as 'stop'|'resume'|'destroy');output({action,completed:true,id:activeProfile(config).id});return;
    }
    throw new Error('Unknown command. Run reroute --help');
  } catch(error){process.stderr.write(`reroute: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=125;}
}
