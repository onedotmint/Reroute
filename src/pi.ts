import type { BashOperations, ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { activeProfile, loadConfig, saveConfig, listJobs, validate } from './config.js';
import { credentialStatus } from './auth.js';
import { discoverExisting } from './discovery.js';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Job } from './types.js';
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

/** Only local config, recent receipts and private credential availability; never contacts any cloud on panel open. */
export function describeProfiles(config: Config, jobs: Job[] = [], sources: Record<string,string> = {}): string {
  const rows = Object.entries(config.profiles).map(([name, p]) => {
    const relevant = jobs.filter(j => j.profile.provider === p.provider && j.profile.id === p.id);
    const active = relevant.filter(j => j.status === 'preparing' || j.status === 'running' || j.status === 'unknown').length;
    return (name === config.active ? '* ' : '  ') + name + ' | ' + p.provider + ' | ' + p.id +
      ' | auth: ' + (sources[name] || 'not inspected') +
      ' | jobs: ' + relevant.length + (active ? ' (' + active + ' active/unresolved)' : '');
  });
  return 'Mode: ' + config.mode + '\n' + rows.join('\n');
}
async function sourcesFor(config: Config): Promise<Record<string,string>> {
  const out: Record<string,string> = {};
  for (const [name, item] of Object.entries(config.profiles)) {
    try { out[name] = await credentialStatus(item.provider); }
    catch { out[name] = 'credential file needs attention'; }
  }
  return out;
}
async function editFromPi(ctx: ExtensionCommandContext, root: string, config: Config, editName?: string): Promise<boolean> {
  const name = editName ?? await ctx.ui.input('New profile name', 'Example: daytona-build');
  if (!name) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Profile name: letters, digits, dot, dash or underscore only');
  const old = config.profiles[name];
  const keep = old ? 'Keep current (' + old.provider + ')' : undefined;
  const choice = await ctx.ui.select('Compute provider for ' + name, [...(keep ? [keep] : []), ...PROVIDERS]);
  if (!choice) return false;
  const picked = (choice === keep ? old!.provider : choice) as ProviderId;
  const profile: Partial<Profile> = old?.provider === picked ? {...old} : {provider:picked};
  profile.provider = picked;
  const resource = await ctx.ui.input('Existing resource ID' + (profile.id ? ' (current: ' + profile.id + '; blank keeps it)' : ''),
    picked === 'ssh' ? 'SSH alias or user@host' : picked === 'skypilot' ? 'SkyPilot cluster / SSH alias' : 'Existing sandbox ID');
  if (resource === undefined && !profile.id) return false;
  if (resource?.trim()) profile.id = resource.trim();
  if (!profile.id) throw new Error('Resource ID is required. This action does not create remote resources.');
  if (picked === 'modal') {
    const app = await ctx.ui.input('Existing Modal app name (current: ' + (profile.app ?? 'none') + '; blank keeps it)', 'Existing app name');
    if (app === undefined && !profile.app) return false;
    if (app?.trim()) profile.app = app.trim();
    if (!profile.app) throw new Error('Modal requires an existing app name for snapshot resume.');
  }
  if (picked === 'ssh' || picked === 'skypilot') {
    const identity = await ctx.ui.input('SSH private key path (current: ' + (profile.identityFile ?? 'ssh-agent') + '; blank keeps it)', 'Absolute path, optional');
    if (identity?.trim()) profile.identityFile = identity.trim();
    const port = await ctx.ui.input('SSH port (current: ' + (profile.port ?? 'SSH config') + '; blank keeps it)', '1-65535, optional');
    if (port?.trim()) profile.port = Number(port);
  }
  const location = await ctx.ui.input('Remote root (current: ' + (profile.root ?? '/tmp/reroute-v3') + '; blank keeps it)', 'Absolute isolated path');
  profile.root = location?.trim() || profile.root || '/tmp/reroute-v3';
  const next: Config = { ...config, profiles: {...config.profiles, [name]: profile as Profile}, active: name };
  validate(next);
  if (!await ctx.ui.confirm('Save local profile?', name + ' | ' + picked + ' | ' + profile.id +
    '\nThis only changes this project config. No resource will be created or resumed.')) return false;
  await saveConfig(root, next);
  ctx.ui.notify('Saved and selected ' + name + '. API key entry uses reroute setup in a terminal (masked).', 'info');
  return true;
}
async function manageProviders(ctx: ExtensionCommandContext, root: string, config: Config): Promise<boolean> {
  for (;;) {
    const selected = await ctx.ui.select('Configured profiles (' + Object.keys(config.profiles).length + ')', [
      'Add provider', 'Edit provider', 'Discover existing resources', 'Switch active provider', 'Remove local profile', 'Credentials help', 'Back',
    ]);
    if (!selected || selected === 'Back') return false;
    if (selected === 'Add provider') return editFromPi(ctx, root, config);
    if (selected === 'Credentials help') {
      ctx.ui.notify('Use reroute setup in your terminal to enter masked keys, store them in a private 0600 file, or use native provider login. Pi input is not masked: never paste API keys here.', 'info');
    } else if (selected === 'Discover existing resources') {
      const name = await ctx.ui.select('Discover resources for which profile?', Object.keys(config.profiles));
      if (!name) continue;
      const profile = config.profiles[name]!;
      if (!await ctx.ui.confirm('List existing '+profile.provider+' resources?', 'Read-only listing may contact its control plane. No compute will be provisioned or resumed.')) continue;
      let resources: Awaited<ReturnType<typeof discoverExisting>>;
      try { resources = await discoverExisting(profile.provider); }
      catch { ctx.ui.notify('Resource listing failed. Check credentials with reroute setup; you can still enter an ID manually.', 'error'); continue; }
      if (!resources.length) { ctx.ui.notify('No listed resources. Use Add / Edit provider to enter an existing ID manually.', 'info'); continue; }
      const labels = resources.map(r => r.id + ' (' + r.state + ')');
      const choice = await ctx.ui.select('Select existing '+profile.provider+' resource', labels);
      if (!choice) continue;
      const chosen = resources[labels.indexOf(choice)];
      if (!chosen || chosen.id === profile.id) continue;
      if (await ctx.ui.confirm('Use '+chosen.id+' for '+name+'?', 'Only the local profile ID changes. The remote resource remains untouched.')) {
        profile.id = chosen.id;
        await saveConfig(root, config);
        ctx.ui.notify('Selected existing resource '+chosen.id, 'info');
        return true;
      }
    } else if (selected === 'Edit provider') {
      const name = await ctx.ui.select('Edit which profile?', Object.keys(config.profiles));
      if (name) return editFromPi(ctx, root, config, name);
    } else if (selected === 'Switch active provider') {
      const name = await ctx.ui.select('Active provider', Object.keys(config.profiles).map(n=>n + ' (' + config.profiles[n]!.provider + ')'));
      if (name) {
        const selectedName = name.slice(0, name.indexOf(' ('));
        config.active = selectedName;
        await saveConfig(root, config);
        return true;
      }
    } else if (selected === 'Remove local profile') {
      if (Object.keys(config.profiles).length < 2) { ctx.ui.notify('Keep at least one profile. Remote resources are untouched.', 'info'); continue; }
      const name = await ctx.ui.select('Remove saved LOCAL profile only (remote resources remain)', Object.keys(config.profiles));
      if (!name) continue;
      if (await ctx.ui.confirm('Remove local profile ' + name + '?', 'This only forgets the local profile. It will NOT destroy remote compute or delete credentials.')) {
        delete config.profiles[name];
        if (config.active === name) config.active = Object.keys(config.profiles)[0]!;
        await saveConfig(root, config);
        ctx.ui.notify('Forgot local profile ' + name + '; remote resources and credentials were not changed.', 'info');
        return true;
      }
    }
  }
}
export async function panel(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) throw new Error('/reroute requires interactive Pi terminal. Use reroute status --json in scripts.');
  const resourceChecks = new Map<string,string>();
  for (;;) {
    const {root,config} = await loadConfig(ctx.cwd);
    if (!config) {
      ctx.ui.notify('No Reroute profile in this project. Run reroute setup to choose SSH, Daytona, SkyPilot, Modal or E2B. No resources were contacted.', 'info');
      return;
    }
    const profile = activeProfile(config), key = config.active + ':' + profile.id;
    const auth = await sourcesFor(config), current = resourceChecks.get(key) ?? 'not checked';
    const configured = Object.keys(config.profiles).map(name => (name === config.active ? '*' : '') + name + ':' + config.profiles[name]!.provider).join(', ');
    const title = 'Reroute | ' + profile.provider + ' (' + config.active + ')\n' +
      'Resource: ' + profile.id + ' [' + current + ']\n' +
      'Mode: ' + config.mode + ' | Auth: ' + auth[config.active] + '\n' +
      'Profiles: ' + (configured.length > 100 ? configured.slice(0,97) + '...' : configured);
    const selected = await ctx.ui.select(title, [
      'Overview', 'Manage providers', 'Check connection', 'Routing mode',
      'Recent jobs', 'Stop resource', 'Resume resource', 'Destroy resource', 'Close',
    ]);
    if (!selected || selected === 'Close') return;
    try {
      if (selected === 'Overview') {
        const jobs = (await listJobs()).filter(j => j.project === root);
        ctx.ui.notify(describeProfiles(config, jobs, auth) + '\nResource status ('+config.active+'): '+current+'\nNo cloud calls made to view this overview.', 'info');
      } else if (selected === 'Manage providers') {
        if (await manageProviders(ctx, root, config)) resourceChecks.clear();
      } else if (selected === 'Check connection') {
        const r = await doctor(ctx.cwd, true);
        const status = String(r.checks.resource ?? (r.ok ? 'running' : 'unavailable'));
        resourceChecks.set(key, status);
        ctx.ui.notify('Profile: ' + config.active + ' (' + profile.provider + ')\nResource: ' + status +
          '\nConnection: ' + (r.ok ? 'verified' : 'not ready') + '\nCheck with reroute doctor --connect for more detail.', r.ok ? 'info' : 'error');
      } else if (selected === 'Routing mode') {
        const mode = await ctx.ui.select('Mode', ['auto','local']);
        if (mode) { config.mode = mode as 'auto'|'local'; await saveConfig(root, config); }
      } else if (selected === 'Recent jobs') {
        const jobs = (await listJobs()).filter(j=>j.project===root).slice(0,8);
        ctx.ui.notify(jobs.map(j=>j.id + ' | ' + j.status + (j.code === undefined ? '' : ' (' + j.code + ')') +
          ' | ' + j.profile.provider + ' | ' + j.command +
          (j.metrics ? '\n  input: ' + j.metrics.inputBytes + ' B; transferred: ' + j.metrics.transferredBytes + ' B' : '')).join('\n') || 'No tasks recorded', 'info');
      } else {
        const action = selected === 'Stop resource' ? 'stop' : selected === 'Resume resource' ? 'resume' : 'destroy';
        const warning = action === 'resume' ?
          'Resume compute? This may incur charges. Modal may recreate compute from its saved snapshot.' :
          action === 'destroy' ? 'Permanently destroy the configured remote resource and its data?' :
          'Stop the resource? Active/unresolved Reroute jobs must be resolved first.';
        if (await ctx.ui.confirm(action + ': ' + profile.id, warning)) {
          await resourceAction(root,config,action);
          resourceChecks.delete(key);
          ctx.ui.notify('Provider operation completed; use Check connection to refresh.', 'info');
        }
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : 'Operation failed', 'error');
    }
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
