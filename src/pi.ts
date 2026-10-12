import type { BashOperations, ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { activeProfile, defaults, hasLegacy, loadConfig, saveConfig, listJobs, validate } from './config.js';
import { credentialStatus, forgetProviderSecrets } from './auth.js';
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

/** Local-only summary. Opening /reroute never contacts a provider or resumes compute. */
export function describeProfiles(config: Config, jobs: Job[] = [], sources: Record<string, string> = {}): string {
  const rows = Object.entries(config.profiles).map(([name, profile]) => {
    const related = jobs.filter(j => j.profile.provider === profile.provider && j.profile.id === profile.id);
    const unresolved = related.filter(j => ['preparing', 'running', 'unknown'].includes(j.status)).length;
    return (name === config.active ? '* ' : '  ') + name + ' | ' + profile.provider + ' | ' + profile.id +
      ' | auth: ' + (sources[name] ?? 'not inspected') +
      ' | jobs: ' + related.length + (unresolved ? ' (' + unresolved + ' active/unresolved)' : '');
  });
  return 'Mode: ' + config.mode + '\n' + rows.join('\n');
}

async function credentialSources(config: Config): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const [name, profile] of Object.entries(config.profiles)) {
    try { sources[name] = await credentialStatus(profile.provider); }
    catch { sources[name] = 'credential file needs attention'; }
  }
  return sources;
}

async function editProfile(ctx: ExtensionCommandContext, root: string, config: Config, selectedName?: string): Promise<boolean> {
  const name = selectedName ?? await ctx.ui.input('Profile name (add or edit)', 'Example: daytona-build');
  if (!name) return false;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Profile name: letters, digits, dot, dash or underscore only');

  const previous = config.profiles[name];
  const keep = previous ? 'Keep current (' + previous.provider + ')' : undefined;
  const choice = await ctx.ui.select('Compute provider for ' + name, [...(keep ? [keep] : []), ...PROVIDERS]);
  if (!choice) return false;
  const provider = (choice === keep ? previous!.provider : choice) as ProviderId;
  const profile: Partial<Profile> = previous?.provider === provider ? { ...previous } : {};
  profile.provider = provider;

  if (provider !== 'ssh')
    ctx.ui.notify(provider + ' has offline contract coverage; external live verification is still pending. Select only existing resources.', 'info');
  const id = await ctx.ui.input('Existing resource ID' + (profile.id ? ' (current: ' + profile.id + '; blank keeps it)' : ''),
    provider === 'ssh' ? 'SSH alias or user@host' : provider === 'skypilot' ? 'SkyPilot cluster / SSH alias' : 'Existing sandbox ID');
  if (id === undefined) return false;
  profile.id = id.trim() || profile.id;
  if (!profile.id) throw new Error('Enter an existing resource ID; Reroute does not provision compute.');

  if (provider === 'modal') {
    const app = await ctx.ui.input('Modal app name (blank keeps existing)', profile.app ?? 'Existing app name');
    if (app === undefined) return false;
    profile.app = app.trim() || profile.app;
    if (!profile.app) throw new Error('Modal requires an existing app name for snapshot resume.');
  }
  if (provider === 'ssh' || provider === 'skypilot') {
    const identity = await ctx.ui.input('SSH private key path (blank keeps ssh-agent/config)', profile.identityFile ?? 'Absolute path, optional');
    if (identity === undefined) return false;
    if (identity.trim()) profile.identityFile = identity.trim();
    const port = await ctx.ui.input('SSH port (blank keeps existing/SSH config)', profile.port ? String(profile.port) : '1-65535, optional');
    if (port === undefined) return false;
    if (port.trim()) profile.port = Number(port);
  }
  const path = await ctx.ui.input('Isolated remote storage root (blank keeps existing)', profile.root ?? '/tmp/reroute-v3');
  if (path === undefined) return false;
  profile.root = path.trim() || profile.root || '/tmp/reroute-v3';

  const next: Config = { ...config, profiles: { ...config.profiles, [name]: profile as Profile }, active: name };
  validate(next);
  if (!await ctx.ui.confirm('Save project profile?', name + ' | ' + provider + ' | ' + profile.id + '\nNo cloud resources will be created or resumed.')) return false;
  await saveConfig(root, next);
  ctx.ui.notify('Saved ' + name + '. For masked API-key entry, use the optional reroute setup CLI.', 'info');
  return true;
}

async function manageProfiles(ctx: ExtensionCommandContext, root: string, config: Config): Promise<boolean> {
  const names = Object.keys(config.profiles);
  const selected = await ctx.ui.select('Profiles (' + names.length + ')', [
    'Add provider', 'Edit provider', 'Switch active provider', 'Discover existing resources', 'Remove local profile', 'Back',
  ]);
  if (!selected || selected === 'Back') return false;
  if (selected === 'Add provider') return editProfile(ctx, root, config);

  const name = await ctx.ui.select('Select profile', names);
  if (!name) return false;
  if (selected === 'Edit provider') return editProfile(ctx, root, config, name);
  if (selected === 'Switch active provider') {
    if (name === config.active) return false;
    await saveConfig(root, { ...config, active: name });
    return true;
  }
  if (selected === 'Remove local profile') {
    if (names.length === 1) { ctx.ui.notify('At least one profile must remain.', 'info'); return false; }
    if (!await ctx.ui.confirm('Forget local profile ' + name + '?', 'Remote resources and credentials will NOT be changed.')) return false;
    const profiles = { ...config.profiles };
    delete profiles[name];
    await saveConfig(root, { ...config, profiles, active: config.active === name ? Object.keys(profiles)[0]! : config.active });
    return true;
  }
  if (!await ctx.ui.confirm('List existing ' + config.profiles[name]!.provider + ' resources?', 'Explicit read-only discovery. No provisioning, start or resume.')) return false;
  let resources: Awaited<ReturnType<typeof discoverExisting>>;
  try { resources = await discoverExisting(config.profiles[name]!.provider); }
  catch { ctx.ui.notify('Listing unavailable. Check native credentials or use the masked CLI wizard.', 'error'); return false; }
  if (!resources.length) { ctx.ui.notify('No existing resources returned; enter an ID with Edit provider.', 'info'); return false; }
  const labels = resources.map(r => r.id + ' (' + r.state + ')');
  const selectedId = await ctx.ui.select('Choose existing resource', labels);
  if (!selectedId) return false;
  const resource = resources[labels.indexOf(selectedId)];
  if (!resource || resource.id === config.profiles[name]!.id) return false;
  if (!await ctx.ui.confirm('Use existing resource ' + resource.id + '?', 'Only the local resource ID will change.')) return false;
  await saveConfig(root, { ...config, profiles: { ...config.profiles, [name]: { ...config.profiles[name]!, id: resource.id } } });
  return true;
}

async function advanced(ctx: ExtensionCommandContext, root: string, config: Config): Promise<boolean> {
  const choice = await ctx.ui.select('Advanced (explicit actions; compute may be billable)', [
    'Credential sources', 'Forget saved API key', 'Stop resource', 'Resume resource', 'Destroy resource', 'Back',
  ]);
  if (!choice || choice === 'Back') return false;
  if (choice === 'Credential sources') {
    ctx.ui.notify(describeProfiles(config, [], await credentialSources(config)) +
      '\nAPI keys are never displayed. Use reroute setup for masked key entry.', 'info');
    return false;
  }
  if (choice === 'Forget saved API key') {
    const provider = activeProfile(config).provider;
    if (provider === 'ssh' || provider === 'skypilot') {
      ctx.ui.notify('This provider uses native authentication. Reroute stores no API key.', 'info'); return false;
    }
    if (await ctx.ui.confirm('Forget locally stored ' + provider + ' key?', 'Environment credentials remain; revoke leaked tokens at the provider.')) {
      const changed = await forgetProviderSecrets(provider);
      ctx.ui.notify(changed ? 'Local key forgotten. Provider-issued key remains valid until revoked.' : 'No Reroute-stored key found.', 'info');
    }
    return false;
  }
  const action = choice === 'Stop resource' ? 'stop' : choice === 'Resume resource' ? 'resume' : 'destroy';
  const warning = action === 'resume' ? 'May incur charges. Modal may recreate compute from a snapshot.' :
    action === 'destroy' ? 'Permanently destroy this remote resource and its data?' :
      'Stop compute? Active/unresolved jobs must be resolved first.';
  if (!await ctx.ui.confirm(choice + ': ' + activeProfile(config).id, warning)) return false;
  await resourceAction(root, config, action);
  ctx.ui.notify('Provider operation completed. Run Check connection to refresh status.', 'info');
  return true;
}

export async function panel(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) throw new Error('/reroute requires an interactive Pi terminal.');
  const checked = new Map<string, string>();
  for (;;) {
    const { root, config } = await loadConfig(ctx.cwd);
    if (!config) {
      if (await hasLegacy(root)) {
        ctx.ui.notify('Legacy Reroute state found. Recover old work before using --ignore-legacy; nothing was overwritten.', 'error');
        return;
      }
      const choice = await ctx.ui.select('Reroute | No configuration in this project', [
        'Configure this project', 'How to configure API credentials', 'Close',
      ]);
      if (choice === 'Configure this project') {
        if (await editProfile(ctx, root, defaults())) continue;
      } else if (choice === 'How to configure API credentials') {
        ctx.ui.notify('Use provider-native authentication or the optional reroute setup CLI for masked entry. Never paste secrets into Pi text fields.', 'info');
      }
      return;
    }

    const profile = activeProfile(config);
    const key = config.active + ':' + profile.id;
    const current = checked.get(key) ?? 'not checked';
    const sources = await credentialSources(config);
    const title = 'Reroute | ' + profile.provider + ' (' + config.active + ')' +
      '\nResource: ' + profile.id + ' [' + current + '] | Mode: ' + config.mode +
      ' | Auth: ' + sources[config.active] +
      '\nProfiles: ' + Object.keys(config.profiles).length;
    const action = await ctx.ui.select(title, [
      'Overview', 'Manage providers', 'Check connection', 'Routing mode', 'Recent jobs', 'Advanced', 'Close',
    ]);
    if (!action || action === 'Close') return;
    try {
      if (action === 'Overview') {
        const jobs = (await listJobs()).filter(j => j.project === root);
        ctx.ui.notify(describeProfiles(config, jobs, sources) + '\nResource (' + config.active + '): ' + current +
          '\nNo cloud calls made to view this overview.', 'info');
      } else if (action === 'Manage providers') {
        if (await manageProfiles(ctx, root, config)) checked.clear();
      } else if (action === 'Routing mode') {
        const mode = await ctx.ui.select('Mode', ['auto', 'local']);
        if (mode) await saveConfig(root, { ...config, mode: mode as Config['mode'] });
      } else if (action === 'Check connection') {
        const result = await doctor(ctx.cwd, true);
        const status = String(result.checks.resource ?? 'unavailable');
        checked.set(key, status);
        ctx.ui.notify('Resource: ' + status + ' | Connection: ' + (result.ok ? 'verified' : 'not ready') +
          '\nDetailed diagnostics: reroute doctor --connect', result.ok ? 'info' : 'error');
      } else if (action === 'Recent jobs') {
        const jobs = (await listJobs()).filter(j => j.project === root).slice(0, 8);
        ctx.ui.notify(jobs.map(j => j.id + ' | ' + j.status + ' | ' + j.profile.provider +
          ' | ' + j.command + (j.metrics ? '\n  transferred: ' + j.metrics.transferredBytes + ' B' : '')).join('\n') || 'No tasks recorded', 'info');
      } else if (action === 'Advanced') {
        if (await advanced(ctx, root, config)) checked.clear();
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
