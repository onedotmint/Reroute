import { loadConfig, activeProfile } from './config.js';
import { processExec, requireSuccess, shell } from './util.js';
import { createProvider } from './providers/index.js';
export async function doctor(cwd: string, connect = false) {
  const {root, config} = await loadConfig(cwd);
  const checks: Record<string,unknown> = {node:process.version,platform:process.platform,project:root,configured:!!config,cloudConnections:connect?'requested':'not attempted'};
  const [major,minor]=process.versions.node.split('.').map(Number);
  let ok = process.platform !== 'win32' && (major! > 22 || (major === 22 && minor! >= 19));
  checks.supportedNode=ok;
  if(!ok)checks.required='Linux or WSL2, Node >=22.19.0';
  const tools = ['git','bash', ...(config && ['ssh','skypilot'].includes(activeProfile(config).provider) ? ['ssh','rsync', ...(activeProfile(config).provider==='skypilot'?['sky']:[])] : [])];
  for (const tool of tools) { const r=await processExec('sh',['-c','command -v '+tool],{timeoutMs:5000}); checks[tool]=r.code===0?'found':'missing'; if(r.code!==0)ok=false; }
  if (!config) checks.next='Run reroute setup in this project. No remote test performed.';
  if(config) {
    const profile=activeProfile(config); checks.profile=config.active; checks.provider=profile.provider;
    if(connect) {
      const provider=createProvider(profile);
      try {
        const status=await provider.status(); checks.resource=status;
        if(status==='running') {
          const command=shell(['python3','-c','import os,sys; assert sys.platform.startswith("linux"); assert os.path.isdir("/proc"); print("Linux/Python supervisor prerequisites ready")']);
          checks.remotePrerequisites=(await requireSuccess(provider.exec(command,{timeoutMs:20000}))).stdout.trim();
        } else { ok=false; checks.note='Resource not running; no connection with resume semantics was attempted.'; }
      } catch(e) {ok=false;checks.error=String(e);} finally {await provider.close?.();}
    }
  }
  return {ok,checks};
}
