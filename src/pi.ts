import type { BashOperations, ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { activeProfile, loadConfig, saveConfig, listJobs } from './config.js';
import { runRemote, resourceAction } from './engine.js';
import { ruleRouter } from './router.js';
import { doctor } from './doctor.js';
type PiSDK = Pick<typeof import('@earendil-works/pi-coding-agent'), 'createBashTool' | 'createBashToolDefinition' | 'createLocalBashOperations'>;
export function createRerouteOperations(local: BashOperations, execute = runRemote): BashOperations {
  return {exec:async(command,cwd,options)=>{
    const {root,config}=await loadConfig(cwd);
    if (!config || (await ruleRouter(command,cwd,config)).route==='local') return local.exec(command,cwd,options);
    const result=await execute(command,{root,config,cwd,signal:options.signal,timeoutMs:options.timeout===undefined?undefined:options.timeout*1000,
      stdout:options.onData,stderr:options.onData});
    if(result.job.error)options.onData(Buffer.from(`\n[Reroute ${result.job.id}: ${result.job.status}] ${result.job.error}\n`));
    else if(result.job.status!=='exited')options.onData(Buffer.from(`\n[Reroute ${result.job.id}: ${result.job.status}]\n`));
    return {exitCode:result.code};
  }};
}
export async function panel(ctx: ExtensionCommandContext): Promise<void> {
  if(!ctx.hasUI)throw new Error('/reroute needs an interactive Pi terminal. Use reroute status --json in scripts.');
  let status='Not checked';
  for(;;) {
    const {root,config}=await loadConfig(ctx.cwd);
    if(!config){ctx.ui.notify('Run reroute setup in this project, then /reroute. No remote resources were contacted.','info');return;}
    const profile=activeProfile(config);
    const selected=await ctx.ui.select(`Reroute | ${config.active} (${profile.provider}) | ${config.mode}\n${profile.id} | Resource: ${status}`,['Check connection','Switch profile','Routing mode','Recent jobs','Stop resource','Resume resource','Destroy resource','Close']);
    if(!selected||selected==='Close')return;
    try {
      if(selected==='Check connection'){const r=await doctor(ctx.cwd,true);status=String(r.checks.resource??r.checks.error??'unknown');ctx.ui.notify(JSON.stringify(r.checks,null,2),r.ok?'info':'error');}
      else if(selected==='Switch profile'){const name=await ctx.ui.select('Profile',Object.keys(config.profiles));if(name){config.active=name;await saveConfig(root,config);status='Not checked';}}
      else if(selected==='Routing mode'){const mode=await ctx.ui.select('Mode',['auto','local']);if(mode){config.mode=mode as 'auto'|'local';await saveConfig(root,config);}}
      else if(selected==='Recent jobs'){const jobs=(await listJobs()).filter(j=>j.project===root).slice(0,8);ctx.ui.notify(jobs.map(j=>`${j.id} | ${j.status}${j.code===undefined?'':` (${j.code})`} | ${j.command}`).join('\n')||'No tasks recorded','info');}
      else {
        const action=selected==='Stop resource'?'stop':selected==='Resume resource'?'resume':'destroy';
        const warning=action==='resume'?'Resume compute? This may incur charges. Modal recreates a sandbox from its saved filesystem snapshot.':action==='destroy'?'Permanently destroy this configured resource and its data?':'Stop this resource? Running/unresolved Reroute tasks must be resolved first.';
        if(await ctx.ui.confirm(`${action}: ${profile.id}`,warning)){await resourceAction(root,config,action);status=action==='resume'?'Resume requested':'Stopped/destroyed';ctx.ui.notify('Native provider operation completed. Use Check connection to refresh.','info');}
      }
    }catch(error){ctx.ui.notify(String(error),'error');}
  }
}
export function registerPi(pi: ExtensionAPI, sdk: PiSDK): void {
  if(typeof sdk.createBashTool!=='function'||typeof sdk.createLocalBashOperations!=='function')throw new Error('Reroute needs Pi native BashOperations support; no fallback shim was installed');
  const operations=createRerouteOperations(sdk.createLocalBashOperations());
  const factory=sdk.createBashToolDefinition??sdk.createBashTool;
  pi.registerTool(factory(process.cwd(),{operations}));
  pi.on('user_bash',()=>({operations}));
  pi.registerCommand('reroute',{description:'Reroute provider, routing and resource controls (no model calls)',handler:async(_args,ctx)=>panel(ctx)});
}
