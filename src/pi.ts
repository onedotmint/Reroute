import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { StringDecoder } from 'node:string_decoder';
import { activeProfile, defaults, hasLegacy, loadConfig, saveConfig, listJobs, validate } from './config.js';
import { credentialStatus, forgetProviderSecrets } from './auth.js';
import { discoverExisting } from './discovery.js';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Job } from './types.js';
import { runRemote, resourceAction } from './engine.js';
import { ruleRouter } from './router.js';
import { doctor } from './doctor.js';
// Keep the Pi entry independent of Bash: local decisions are refusals, never implicit execution.
export function createRerouteTool(execute = runRemote) {
  return defineTool({
    name: 'reroute_run',
    label: 'Reroute',
    description: "Run build, test, check and other eligible compute tasks using the project's configured Reroute execution environment. Uses conservative routing; local-mode, unconfigured and ineligible commands are not executed. Use bash for ordinary shell operations, deployment, authentication, interactive shells and unknown side effects. Never retry a failed or uncertain remote task locally without user authorization.",
    promptSnippet: 'Run eligible build/test/check/compute tasks in the configured Reroute environment; ordinary shell operations use bash.',
    promptGuidelines: [
      'Prefer reroute_run for eligible compute tasks; use bash for file operations, deployment, authentication, interactive shells and commands with unknown side effects.',
      'reroute_run respects project routing and may decline a task. It never provisions or resumes resources automatically, or falls back to local execution.',
      'After a remote failure or unknown state, inspect the reported Job ID; do not rerun locally without user authorization. Tool selection is not deterministic command interception.',
    ],
    exposure: 'direct',
    defaultActive: true,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: 'A single eligible compute command, evaluated by the project router.' }),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86400, description: 'Task timeout in seconds; defaults to project configuration.' })),
    }),
    outputSchema: Type.Object({
      status: Type.String(), exitCode: Type.Union([Type.Number(), Type.Null()]),
      jobId: Type.Union([Type.String(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]),
      stdout: Type.String(), stderr: Type.String(), outputTruncated: Type.Boolean(),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      let job: Job | undefined;
      let stdout = '', stderr = '', outputTruncated = false, lastUpdate = 0;
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
      const append = (channel: 'stdout' | 'stderr', text: string) => {
        const value = (channel === 'stdout' ? stdout : stderr) + text;
        outputTruncated ||= value.length > 8192;
        if (channel === 'stdout') stdout = value.slice(-8192); else stderr = value.slice(-8192);
      };
      const result = (status: string, exitCode: number | null, reason?: string, isError = false) => {
        if (reason && reason.length > 8192) { reason = '[Diagnostic truncated] ' + reason.slice(-8192); outputTruncated = true; }
        const details = { status, exitCode, jobId: job?.id ?? null, reason: reason ?? null, stdout, stderr, outputTruncated };
        const text = ['Reroute status: ' + status, 'Exit code: ' + (exitCode ?? 'not available'),
          ...(job ? ['Job ID: ' + job.id] : []), ...(reason ? [reason] : []),
          ...(stdout ? ['stdout:\n' + stdout] : []), ...(stderr ? ['stderr:\n' + stderr] : []),
          ...(outputTruncated ? ['[Output truncated: only the last 8192 characters per stream/diagnostic are retained. Full output is not saved by this tool.]'] : []),
        ].join('\n');
        return { content: [{ type: 'text' as const, text }], details, structuredContent: details, isError };
      };
      const progress = () => {
        if (onUpdate && Date.now() - lastUpdate >= 250) {
          lastUpdate = Date.now();
          onUpdate(result(job?.status ?? 'preparing', null));
        }
      };
      try {
        signal?.throwIfAborted();
        if (!params.command.trim()) throw new Error('Command must not be blank');
        if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > 86400))
          throw new Error('Task timeout must be in (0, 86400] seconds');
        const { root, config } = await loadConfig(ctx.cwd);
        const decision = config ? await ruleRouter(params.command, ctx.cwd, config) : { route: 'local', reason: 'not-configured' };
        if (decision.route === 'local') return result('not_started', null,
          decision.reason + '. Nothing executed. Use bash if local execution is intended; configure /reroute for eligible remote tasks.', true);
        const remote = await execute(params.command, {
          root, config, cwd: ctx.cwd, signal,
          timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000,
          onJob: value => { job = value; progress(); },
          stdout: chunk => { append('stdout', outDecoder.write(chunk)); progress(); },
          stderr: chunk => { append('stderr', errDecoder.write(chunk)); progress(); },
        });
        job = remote.job;
        append('stdout', outDecoder.end()); append('stderr', errDecoder.end());
        // Providers normally stream; retain bounded returned output if no callbacks were made.
        if (!stdout) append('stdout', remote.stdout);
        if (!stderr) append('stderr', remote.stderr);
        outputTruncated ||= !!(remote.stdoutTruncated || remote.stderrTruncated);
        return result(job.status, remote.code, job.error,
          remote.code !== 0 || job.status !== 'exited' || !!job.error);
      } catch (error) {
        append('stdout', outDecoder.end()); append('stderr', errDecoder.end());
        return result(job?.status ?? (signal?.aborted ? 'cancelled' : 'failed'), job ? 125 : null,
          String(error) + '. Never retried locally.', true);
      }
    },
  });
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
export function registerPi(pi: ExtensionAPI): void {
  pi.registerTool(createRerouteTool());
  pi.registerCommand('reroute',{description:'Reroute provider, routing and resource controls (no model calls)',handler:async(_args,ctx)=>panel(ctx)});
}
