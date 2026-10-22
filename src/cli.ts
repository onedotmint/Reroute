import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { activeProfile, loadConfig, listJobs, saveConfig } from './config.js';
import { runRemote, inspectJob, downloadArtifact, cleanupJob, resourceAction } from './engine.js';
import { ruleRouter } from './router.js';
import { setup } from './setup.js';
import { doctor } from './doctor.js';
import { shell, processExec } from './util.js';
import { createProvider } from './providers/index.js';
import { credentialStatus, forgetProviderSecrets } from './auth.js';
import { PROVIDERS, type ProviderId } from './types.js';
import { cloudPlan, cloudSummary, presets } from './resources.js';
export const HELP = `Reroute 0.3 - local source, native remote compute

  reroute setup                         Multi-select Daytona/Modal/SSH; masked credentials, reviewed defaults
  reroute setup --advanced              Edit accounts, existing targets and other providers
  reroute setup --non-interactive --provider ssh --id user@host
  reroute exec [--timeout SECONDS] [--stdin] -- cargo test   Force remote
  reroute run -- cargo test              Conservative automatic routing
  reroute local -- cargo test            Force local
  reroute explain -- cargo test          Explain the routing decision
  reroute plan [--cpu N --memory GiB] -- cargo test  Offline cost/spec recommendation
  reroute exec --shell 'cmd && cmd'       Explicitly trusted compound command
  reroute doctor [--connect] [--json]     Local prerequisites; optional live check
  reroute credentials                     Show auth source, never secrets
  reroute credentials forget --provider daytona --yes  Forget saved local key only
  reroute status [JOB_ID] [--json]        Read-only resource / job status
  reroute jobs [--json]                  Local receipts (no cloud calls)
  reroute cancel JOB_ID                  Request and verify remote termination
  reroute artifacts JOB_ID PATH --to FILE.tgz   Explicit archive; never overwrite
  reroute cleanup JOB_ID --yes           Remove a confirmed terminal task only
  reroute profile NAME                   Select an existing profile
  reroute mode auto|local                Set routing mode
  reroute resource stop|destroy|recover --yes
  reroute resource resume --yes --allow-cost
  Pi-native extension install:
    pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native
    pi list -l / pi remove -l <source> / pi update --extensions

Global: --cwd DIR. Setup: --name NAME --root /remote/path --port N
  --identity KEYFILE --app MODAL_APP --tasks build,test,check,benchmark
  Managed setup: --managed --provider daytona|modal --credential ACCOUNT
    --image reroute:node-rust-v1 --preset small|medium|large (or --cpu N --memory GiB)
    --cpu-hour-usd RATE --memory-hour-usd RATE --monthly-usd 3 --max-task-usd 0.5
    --storage-month-usd 0.01 --idle-minutes 5 --max-cpu 8 --max-memory 16
    --authorize (explicit future paid creation/start; default is unauthorized)
  Per-task sizing: exec/run --cpu N --memory GiB or --preset NAME; defaults unchanged.
  Modal CPU means physical cores. Credit is unknown; estimates are not hard bill caps.
  --ignore-legacy (isolated v3; old data retained). --no-pi is accepted as a legacy no-op.
  Project config and Pi extension installation are separate; no global entry is written.
Exit: task exit code, 124 confirmed timeout, 130 confirmed cancellation,
  125 infrastructure failure / unknown / incomplete output. Never local retry.
`;
function output(value:unknown){console.log(JSON.stringify(value,null,2));}
export async function main(argv=process.argv.slice(2)): Promise<void> {
  try {
    const boundary=argv.indexOf('--'), payload=boundary<0?[]:argv.slice(boundary+1), prefix=boundary<0?argv:argv.slice(0,boundary);
    const {values:v,positionals:a}=parseArgs({args:prefix,allowPositionals:true,strict:true,options:{
      help:{type:'boolean',short:'h'},version:{type:'boolean'},json:{type:'boolean'},cwd:{type:'string'},shell:{type:'string'},timeout:{type:'string'},stdin:{type:'boolean'},connect:{type:'boolean'},yes:{type:'boolean'},'allow-cost':{type:'boolean'},
      advanced:{type:'boolean'},managed:{type:'boolean'},authorize:{type:'boolean'},credential:{type:'string'},image:{type:'string'},cpu:{type:'string'},memory:{type:'string'},preset:{type:'string'},
      'monthly-usd':{type:'string'},'max-task-usd':{type:'string'},'cpu-hour-usd':{type:'string'},'memory-hour-usd':{type:'string'},'storage-month-usd':{type:'string'},'idle-minutes':{type:'string'},'max-cpu':{type:'string'},'max-memory':{type:'string'},
      'non-interactive':{type:'boolean'},provider:{type:'string'},id:{type:'string'},name:{type:'string'},root:{type:'string'},port:{type:'string'},identity:{type:'string'},app:{type:'string'},tasks:{type:'string'},'no-pi':{type:'boolean'},'ignore-legacy':{type:'boolean'},to:{type:'string'},
    }});
    const command=a[0], cwd=resolve(v.cwd??process.cwd());
    if(v.version){console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);return;}
    if(v.help||!command){console.log(HELP);return;}
    if(command==='setup'){const config=await setup(cwd,{advanced:v.advanced,nonInteractive:v['non-interactive'],provider:v.provider,id:v.id,name:v.name,root:v.root,port:v.port,identity:v.identity,app:v.app,tasks:v.tasks,noPi:v['no-pi'],ignoreLegacy:v['ignore-legacy'],managed:v.managed,credential:v.credential,image:v.image,cpu:v.cpu,memory:v.memory,preset:v.preset,authorize:v.authorize,monthlyUsd:v['monthly-usd'],maxTaskUsd:v['max-task-usd'],cpuHourUsd:v['cpu-hour-usd'],memoryHourUsd:v['memory-hour-usd'],storageMonthUsd:v['storage-month-usd'],idleMinutes:v['idle-minutes'],maxCpu:v['max-cpu'],maxMemory:v['max-memory']});if(v['non-interactive'])output({saved:true,active:config.active,pi:'managed-by-native-pi'});return;}
    if(command==='pi')throw new Error('Reroute no longer writes Pi extension files. Install the native Pi package with: pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native');
    if(command==='doctor'){const r=await doctor(cwd,v.connect);output(r);process.exitCode=r.ok?0:1;return;}
    if(command==='credentials'){
      if(!a[1]||a[1]==='status'){
        const status: Record<string,string> = {};
        for(const provider of PROVIDERS)status[provider]=await credentialStatus(provider, v.credential);
        output({credentialSources:status,notes:'No secrets shown. Native or detected credentials are not a connection check.'});return;
      }
      if(a[1]==='forget'){
        if(!v.yes||!v.provider||!PROVIDERS.includes(v.provider as ProviderId))throw new Error('Use reroute credentials forget --provider daytona|modal|e2b --yes');
        if(!['daytona','modal','e2b'].includes(v.provider))throw new Error('SSH and SkyPilot use native authentication, not stored Reroute API keys');
        const forgotten=await forgetProviderSecrets(v.provider as ProviderId, v.credential);
        output({provider:v.provider,forgotten,scope:'Reroute local private file only; environment variables and provider-issued tokens remain valid'});return;
      }
      throw new Error('Use reroute credentials or reroute credentials forget --provider NAME --yes');
    }
    if(command==='jobs'){const {root}=await loadConfig(cwd);output((await listJobs()).filter(j=>j.project===root));return;}
    if(['exec','run','local','explain','plan'].includes(command)){
      if(v.shell!==undefined&&payload.length)throw new Error('Use either --shell or -- argument list, not both');
      const raw=v.shell??(payload.length?shell(payload):'');if(!raw.trim())throw new Error('Command required after -- (or provide --shell)');
      const {root,config}=command==='local'?{root:cwd,config:undefined}:await loadConfig(cwd);
      const decision=command==='exec'?{route:'remote',reason:'explicit-remote'}:command==='local'?{route:'local',reason:'explicit-local'}:config?await ruleRouter(raw,cwd,config):{route:'local',reason:'not-configured'};
      if(command==='explain'){output({...decision,command:raw});return;}
      if(v.preset && !Object.hasOwn(presets,v.preset)) throw new Error('Choose preset small|medium|large');
      const compute = v.cpu === undefined && v.memory === undefined && !v.preset ? undefined : { ...presets[v.preset ?? ''], ...(v.cpu === undefined ? {} : {cpu:Number(v.cpu)}), ...(v.memory === undefined ? {} : {memoryGiB:Number(v.memory)}) };
      if(command==='plan'){if(!config)throw new Error('Configure a profile first');output({...cloudPlan(config,raw,compute,v.timeout===undefined?undefined:Number(v.timeout)*1000),notes:'Estimate only. No official remaining credit or preflight quota claim; provider enforces quota. No resource created.'});return;}
      const timeoutMs=v.timeout===undefined?undefined:Number(v.timeout)*1000;
      if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>86400000))throw new Error('--timeout must be a number in (0,86400] seconds');
      const controller=new AbortController(), abort=()=>controller.abort(); process.once('SIGINT',abort);process.once('SIGTERM',abort);
      try {
        const streams={stdout:(b:Buffer)=>{process.stdout.write(b);},stderr:(b:Buffer)=>{process.stderr.write(b);},signal:controller.signal,timeoutMs,stdin:v.stdin?process.stdin:undefined};
        if(decision.route==='local'){const result=await processExec('bash',['-lc',raw],{...streams,cwd});process.exitCode=result.code;}
        else {const result=await runRemote(raw,{...streams,root,config,cwd,compute,onJob:j=>process.stderr.write(`[reroute ${j.id} -> ${j.profile.provider}]\n`)});process.exitCode=result.code;if(result.job.error)process.stderr.write(result.job.error+'\n');if(result.job.cacheWarning)process.stderr.write('[cache warning] '+result.job.cacheWarning+'\n');if(result.job.status!=='exited')process.stderr.write(`[reroute ${result.job.status}]\n`);}
      }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}return;
    }
    if(command==='status'&&a[1]){output(await inspectJob(a[1]));return;}
    if(command==='cancel'){if(!a[1])throw new Error('Job ID required');const r=await inspectJob(a[1],'cancel');output(r);if(r.status!=='cancelled'&&r.status!=='exited')process.exitCode=125;return;}
    if(command==='artifacts'){if(!a[1]||!a[2]||!v.to)throw new Error('Use artifacts JOB_ID PATH --to FILE.tgz');output({file:await downloadArtifact(a[1],a[2],v.to)});return;}
    if(command==='cleanup'){if(!v.yes||!a[1])throw new Error('Use cleanup JOB_ID --yes');await cleanupJob(a[1]);output({removed:a[1]});return;}
    const {root,config}=await loadConfig(cwd);if(!config)throw new Error('No project configuration; run reroute setup');
    if(command==='status'&&activeProfile(config).managed){output(await cloudSummary(activeProfile(config)));return;}
    if(command==='status'){const provider=createProvider(activeProfile(config));try{output({profile:config.active,provider:provider.profile.provider,id:provider.profile.id,resource:await provider.status(),mode:config.mode});}finally{await provider.close?.();}return;}
    if(command==='profile'){if(!a[1]||!Object.hasOwn(config.profiles,a[1]))throw new Error('Choose an existing profile: '+Object.keys(config.profiles).join(', '));config.active=a[1];await saveConfig(root,config);output({active:config.active});return;}
    if(command==='mode'){if(a[1]!=='auto'&&a[1]!=='local')throw new Error('Mode must be auto or local');config.mode=a[1];await saveConfig(root,config);output({mode:config.mode});return;}
    if(command==='resource'){
      const action=a[1];if(!['stop','resume','destroy','recover'].includes(action??'')||!v.yes)throw new Error('Use resource stop|resume|destroy|recover --yes');
      if(action==='resume'&&!v['allow-cost'])throw new Error('Explicit resume can incur charges; add --allow-cost');
      await resourceAction(root,config,action as 'stop'|'resume'|'destroy'|'recover');output({action,completed:true,id:activeProfile(config).id});return;
    }
    throw new Error('Unknown command. Run reroute --help');
  } catch(error){process.stderr.write(`reroute: ${error instanceof Error?error.message:String(error)}\n`);process.exitCode=125;}
}
