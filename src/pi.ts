import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { StringDecoder } from 'node:string_decoder';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { shell } from './util.js';
import { activeProfile, defaults, hasLegacy, loadConfig, loadUserConfig, saveUserConfig, saveProjectOverrides, projectAuthorized, authorizeProject, revokeProject, listJobs, getJob, projectRoot, validate } from './config.js';
import { credentialStatus, forgetProviderSecrets } from './auth.js';
import { discoverExisting } from './discovery.js';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Job } from './types.js';
import { runRemote, resourceAction, inspectJob } from './engine.js';
import { ruleRouter } from './router.js';
import { doctor } from './doctor.js';
import { cloudPlan, cloudSummary, presets } from './resources.js';
import { TOOLCHAIN_IMAGE } from './toolchain.js';
import { HISTORY_PREFIX, projectExecutionHints } from './history.js';
import { inspectEnvironment, type EnvironmentInspection } from './environment.js';
const ENVIRONMENT_PREFIX = 'Reroute environment: ';
function starterWarning(environment: EnvironmentInspection, profile: Profile): string[] {
  return profile.image === TOOLCHAIN_IMAGE && environment.lines.some(line => /(?:pnpm|yarn|bun)/.test(line))
    ? ['The starter toolchain does not include pnpm/yarn/bun. Use a reviewed compatible image; no implicit installation is performed.'] : [];
}
// Keep the Pi entry independent of Bash: local decisions are refusals, never implicit execution.
async function confirmProject(ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>, root: string, config: Config, signal?: AbortSignal): Promise<boolean> {
  if (await projectAuthorized(root, config)) return true;
  if (!ctx.hasUI) return false;
  const profile = activeProfile(config), canonical = await realpath(root);
  const accepted = await ctx.ui.confirm('Authorize this project for remote execution?',
    'Canonical project root: ' + canonical + '\nProvider/account: ' + profile.provider + ' / ' + (profile.credential ?? '(environment/native default)') +
    '\nResource: ' + profile.id + '\nSource code will be uploaded. Project scripts and lifecycle hooks are trusted code and will execute remotely without recursive auditing.' +
    '\nRemote compute and retained storage may incur fees; credit is unknown. This project authorization does not replace the managed spending policy. Authorize until revoked or the target changes?', { signal });
  signal?.throwIfAborted();
  if (!accepted) return false;
  await authorizeProject(canonical, config);
  return true;
}
const authorizationHelp = 'Project remote execution is not authorized. Nothing executed or uploaded. Open /reroute or run reroute authorize --yes after reviewing the canonical project, provider/account, source upload, trusted script execution and fees. No local retry is authorized.';
export function createRerouteTool(execute = runRemote) {
  return defineTool({
    name: 'reroute_run',
    label: 'Reroute',
    description: "Run one independent heavy build, full test suite or CPU/memory-intensive check in the project's configured Reroute execution environment. Prefer Pi/AFT bash for quick checks, Git, files and ordinary shell work. Project scripts and their hooks are trusted code, not recursively audited. No &&, pipes, redirects. Unconfigured, ineligible or local-mode calls execute nothing; a refusal is not permission for local retry. After failure/unknown use reroute_status; never retry locally without user authorization.",
    promptSnippet: 'Prefer for full builds/test suites and heavy compute; quick checks and ordinary shell/Git/files stay with Pi/AFT bash.',
    promptGuidelines: [
      'Choose from task/project context. Choose remote directly for clearly heavy work; no local trial is required. Quick checks, shell/Git/files, deployment, authentication and interactive work stay with Pi/AFT bash.',
      'Submit one independent command (no &&, pipes, redirects). Reviewed project scripts may contain sequences internally. For dependent tasks, wait for the previous task to succeed; stop dependent tasks on failure/unknown.',
      'After failure/unknown, first call reroute_status with the Job ID; never retry locally without user authorization. A refusal executes nothing, not a local fallback.',
      'Only authorized managed profiles may create/start compute; routing and budgets still apply. Honor requested cpu/memoryGiB. Modal CPU is physical cores; Daytona is vCPU.',
    ],
    exposure: 'direct',
    defaultActive: true,
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: 'A single eligible compute command, evaluated by the project router.' }),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 86400, description: 'Task timeout in seconds; defaults to project configuration.' })),
      cpu: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Explicit per-task CPU override for managed compute; respects project quota/budget limits.' })),
      memoryGiB: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Explicit per-task memory in GiB for managed compute.' })),
    }),
    outputSchema: Type.Object({
      status: Type.String(), exitCode: Type.Union([Type.Number(), Type.Null()]),
      jobId: Type.Union([Type.String(), Type.Null()]), reason: Type.Union([Type.String(), Type.Null()]),
      stdout: Type.String(), stderr: Type.String(), outputTruncated: Type.Boolean(),
      metrics: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
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
        const details = { status, exitCode, jobId: job?.id ?? null, reason: reason ?? null, stdout, stderr, outputTruncated, ...(job?.metrics ? { metrics: job.metrics } : {}) };
        const text = ['Reroute status: ' + status, 'Exit code: ' + (exitCode ?? 'not available'),
          ...(job?.profile?.compute ? [job.profile.provider + ': ' + job.profile.compute.cpu + ' CPU / ' + job.profile.compute.memoryGiB + ' GiB'] : []),
          ...(job?.cost ? ['Reserved estimate: $' + job.cost.estimatedUsd.toFixed(4) + ' (not actual billing; credit unknown)'] : []),
          ...(job?.cacheWarning ? ['Cache warning: ' + job.cacheWarning] : []),
          ...(job?.metrics ? [measured(job)] : []),
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
        if ([params.cpu, params.memoryGiB].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) throw new Error('CPU and memoryGiB overrides must be finite positive numbers');
        const { root, config } = await loadConfig(ctx.cwd);
        const decision = config ? await ruleRouter(params.command, ctx.cwd, config) : { route: 'local', reason: 'not-configured' };
        if (decision.route === 'local') return result('not_started', null,
          decision.reason + '. Nothing executed. This tool does not fall back locally. ' +
          (decision.reason === 'complex-or-ambiguous-shell'
            ? 'Submit one command without shell operators/expansion, or invoke a reviewed project script containing the sequence.'
            : 'Inspect project mode, command restrictions and configuration before retrying.'), true);
        if (!config || !await confirmProject(ctx, root, config, signal)) return result('not_started', null, authorizationHelp, true);
        const remote = await execute(params.command, {
          root, config, cwd: ctx.cwd, signal,
          timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000,
          compute: params.cpu === undefined && params.memoryGiB === undefined ? undefined : {
            ...(params.cpu === undefined ? {} : { cpu: params.cpu }), ...(params.memoryGiB === undefined ? {} : { memoryGiB: params.memoryGiB }),
          },
          onJob: value => { job = value; progress(); },
          onProgress: value => { if (onUpdate) onUpdate(result(value.stage, null, value.message)); },
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

/** Query only this project's jobs; a saved record is not a fresh remote confirmation. */
export function createRerouteStatusTool(inspect = inspectJob) {
  return defineTool({
    name: 'reroute_status',
    label: 'Reroute status',
    description: "Query a Job belonging to the current Pi project without the optional CLI. Separates the last local record from a fresh remote task receipt; an online resource alone is not task confirmation. Read-only remotely: never starts/resumes resources, runs/retries/cancels/cleans tasks or changes project configuration. A failed check does not prove the task stopped; never rerun locally without user authorization.",
    promptSnippet: 'Check failed or uncertain Reroute jobs by Job ID, without a standalone CLI; distinguish recorded history from remote confirmation.',
    promptGuidelines: [
      'After reroute_run fails or reports unknown, use reroute_status with its Job ID before deciding what to do next.',
      'Only remoteConfirmed=true establishes a fresh remote task status. Recorded history is not current confirmation, and query success does not mean the task succeeded.',
      'If verification fails or the task remains unknown, do not infer completion or retry locally without user authorization.',
    ],
    exposure: 'direct',
    defaultActive: true,
    parameters: Type.Object({ jobId: Type.String({ minLength: 1, description: 'Job ID returned by reroute_run in this project.' }) }, { additionalProperties: false }),
    outputSchema: Type.Object({
      jobId: Type.String(), recordedStatus: Type.Union([Type.String(), Type.Null()]),
      recordedExitCode: Type.Union([Type.Number(), Type.Null()]), recordedError: Type.Union([Type.String(), Type.Null()]),
      remoteConfirmed: Type.Boolean(), remoteStatus: Type.Union([Type.String(), Type.Null()]),
      exitCode: Type.Union([Type.Number(), Type.Null()]), error: Type.Union([Type.String(), Type.Null()]),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      let recorded: Job | undefined, confirmed: Job | undefined, error: string | null = null;
      const diagnostic = (value: unknown) => String(value).slice(-8192);
      try {
        signal?.throwIfAborted();
        const root = await realpath(await projectRoot(await realpath(ctx.cwd)));
        let job: Job;
        try { job = await getJob(params.jobId); }
        catch (cause) {
          if (cause instanceof Error && ['Invalid job ID', 'Unknown job ID'].includes(cause.message)) throw cause;
          throw new Error('Could not read the local Job record');
        }
        if (!job || job.id !== params.jobId || await realpath(job.project).catch(() => null) !== root)
          throw new Error('Job does not belong to the current Pi project');
        recorded = job;
        const querySignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
        const current = await inspect(params.jobId, 'status', {
          project: root, signal: querySignal, onConfirmed: value => { confirmed = value; },
        });
        if (current.error) error = diagnostic(current.error);
        else if (!confirmed) error = 'Remote task status could not be confirmed. Last recorded state shown.';
      } catch (cause) { error = diagnostic(cause); }
      const details = {
        jobId: params.jobId, recordedStatus: recorded?.status ?? null,
        recordedExitCode: recorded?.code ?? null, recordedError: recorded?.error ? diagnostic(recorded.error) : null,
        remoteConfirmed: !!confirmed, remoteStatus: confirmed?.status ?? null,
        exitCode: (confirmed ? confirmed.code : recorded?.code) ?? null, error,
      };
      const text = [
        'Job ID: ' + details.jobId,
        'Last recorded status: ' + (details.recordedStatus ?? 'not available'),
        'Last recorded exit code: ' + (details.recordedExitCode ?? 'not available'),
        'Remote status confirmed: ' + (details.remoteConfirmed ? 'yes' : 'no'),
        'Remote status: ' + (details.remoteStatus ?? 'not confirmed'),
        'Known exit code (' + (confirmed ? 'remote receipt' : 'last local record') + '): ' + (details.exitCode ?? 'not available'),
        ...(details.recordedError ? ['Recorded diagnostic: ' + details.recordedError] : []),
        ...(error ? ['Verification diagnostic: ' + error] : []),
      ].join('\n');
      return { content: [{ type: 'text' as const, text }], details, structuredContent: details, isError: !!error || !confirmed };
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
    try { sources[name] = await credentialStatus(profile.provider, profile.credential); }
    catch { sources[name] = 'credential file needs attention'; }
  }
  return sources;
}

async function editCloudSettings(ctx: ExtensionCommandContext, profile: Profile): Promise<boolean> {
  const modal = profile.provider === 'modal';
  const initial = { credential: profile.credential, app: modal ? profile.app ?? 'reroute' : undefined,
    image: profile.image ?? TOOLCHAIN_IMAGE, compute: profile.compute ?? presets.medium,
    managed: profile.managed ?? { authorized: false, maxCpu: 8, maxMemoryGiB: 16, monthlyUsd: 3, maxTaskUsd: 0.5,
      cpuHourUsd: modal ? 0.141912 : 0.0504, memoryGiBHourUsd: modal ? 0.024012 : 0.0162,
      storageMonthUsd: 0.01, idleMinutes: 5 } };
  const text = await ctx.ui.editor('Compute & budget — NO secrets. Review USD rates; credit UNKNOWN. authorized=true permits future paid creation/start. Set a real toolchain image. Modal CPU=physical cores.', JSON.stringify(initial, null, 2));
  if (text === undefined) return false;
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid compute/budget JSON; no settings saved'); }
  if (!data || typeof data !== 'object' || Object.keys(data).some(key => !['credential','app','image','compute','managed'].includes(key))) throw new Error('Only non-secret compute/budget fields are accepted');
  Object.assign(profile, data);
  if (!profile.managed || !profile.image) throw new Error('Set a toolchain image and explicit managed policy before saving');
  return true;
}

async function saveSettings(root: string, config: Config, projectOnly: boolean): Promise<void> {
  if (!projectOnly) { await saveUserConfig(config); return; }
  const before = (await loadConfig(root)).config;
  if (!before) { await saveProjectOverrides(root, config); return; }
  const patch: Partial<Config> = {};
  for (const key of Object.keys(config) as (keyof Config)[]) {
    if (key === 'profiles') {
      const profiles = Object.fromEntries(Object.entries(config.profiles).filter(([name, p]) => JSON.stringify(p) !== JSON.stringify(before.profiles[name])));
      if (Object.keys(profiles).length) patch.profiles = profiles;
    } else if (JSON.stringify(config[key]) !== JSON.stringify(before[key])) Object.assign(patch, { [key]: config[key] });
  }
  if (Object.keys(patch).length) await saveProjectOverrides(root, patch);
}

async function editProfile(ctx: ExtensionCommandContext, root: string, config: Config, selectedName?: string, projectOnly = false): Promise<boolean> {
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
    ctx.ui.notify('Provider connection and task execution have not been verified for this configuration. Daytona/Modal support opt-in managed resources; no keys in Pi text fields.', 'info');
  const id = await ctx.ui.input('Existing resource ID' + (profile.id ? ' (current: ' + profile.id + '; blank keeps it)' : ''),
    provider === 'ssh' ? 'SSH alias or user@host' : provider === 'skypilot' ? 'SkyPilot cluster / SSH alias' : 'auto for managed Daytona/Modal, or an existing sandbox ID');
  if (id === undefined) return false;
  profile.id = id.trim() || profile.id;
  if (!profile.id) throw new Error('Enter auto for managed Daytona/Modal, or an existing resource ID.');
  if (profile.id !== 'auto') { delete profile.managed; delete profile.compute; delete profile.owner; delete profile.cacheVolume; }
  if (previous?.id !== profile.id) { delete profile.pendingResume; delete profile.snapshot; }
  if (profile.id === 'auto') {
    if (!['daytona','modal'].includes(provider)) throw new Error('Managed creation supports Daytona and Modal only');
    if (!await editCloudSettings(ctx, profile as Profile)) return false;
  }

  if (provider === 'modal' && !profile.managed) {
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

  if (previous?.managed && (profile.provider !== previous.provider || profile.id !== 'auto' || profile.credential !== previous.credential)) {
    if ((await cloudSummary(previous)).resources.some(r => r.state !== 'destroyed')) throw new Error('Destroy managed compute before detaching this profile/account. Volumes remain retained and may cost money.');
    delete profile.owner; delete profile.cacheVolume;
  }
  const next: Config = { ...config, profiles: { ...config.profiles, [name]: profile as Profile }, active: name };
  validate(next);
  if (!await ctx.ui.confirm(projectOnly ? 'Save project profile override?' : 'Save global provider defaults?', name + ' | ' + provider + ' | ' + profile.id + (profile.managed?.authorized ? '\nAuthorizes future cloud creation/start within these estimated limits. Credit is UNKNOWN; extra bills remain possible. Project remote authorization is still required.' : '\nNo cloud resources will be created or resumed by this save. Saving credentials is not authentication or project remote authorization.'))) return false;
  await saveSettings(root, next, projectOnly);
  ctx.ui.notify('Saved ' + name + '. For masked API-key entry, use the optional reroute setup CLI.', 'info');
  return true;
}

function showSetup(ctx: ExtensionCommandContext, root: string, projectOnly = false): void {
  const command = shell(['node', fileURLToPath(new URL('../bin/reroute.mjs', import.meta.url)), 'setup', '--cwd', root, ...(projectOnly ? ['--project'] : [])]);
  ctx.ui.notify('Run once in a WSL terminal (not a Pi text field):\n' + command +
    '\n' + (projectOnly ? 'Project-specific overrides.' : 'Recommended: global user defaults, reused by projects; setup defaults to global scope.') + '\nSpace selects multiple providers. Daytona/Modal credentials are masked; SSH only needs your existing host. Saving credentials is not authentication or project authorization. No cloud creation during setup. Return to /reroute after saving.', 'info');
}

async function manageProfiles(ctx: ExtensionCommandContext, root: string, config: Config, projectOnly = false): Promise<boolean> {
  const names = Object.keys(config.profiles);
  const selected = await ctx.ui.select((projectOnly ? 'Project overrides' : 'Global provider defaults') + ' (' + names.length + ')', [
    'Configure providers / API keys (masked terminal)', 'Add provider', 'Edit provider', 'Switch active provider', 'Discover existing resources', 'Remove local profile', 'Back',
  ]);
  if (!selected || selected === 'Back') return false;
  if (selected === 'Configure providers / API keys (masked terminal)') { showSetup(ctx, root, projectOnly); return false; }
  if (selected === 'Add provider') return editProfile(ctx, root, config, undefined, projectOnly);

  const name = await ctx.ui.select('Select profile', names);
  if (!name) return false;
  if (selected === 'Edit provider') return editProfile(ctx, root, config, name, projectOnly);
  if (selected === 'Switch active provider') {
    if (name === config.active) return false;
    await saveSettings(root, { ...config, active: name }, projectOnly);
    return true;
  }
  if (selected === 'Remove local profile') {
    if (projectOnly) throw new Error('Remove profiles from global defaults; project overrides only add or override provider settings.');
    if (config.profiles[name]!.managed && (await cloudSummary(config.profiles[name]!)).resources.some(r => r.state !== 'destroyed')) throw new Error('Destroy managed compute before removing its profile; retained Volumes may still cost money');
    if (names.length === 1) { ctx.ui.notify('At least one profile must remain.', 'info'); return false; }
    if (!await ctx.ui.confirm('Forget local profile ' + name + '?', 'Remote resources and credentials will NOT be changed.')) return false;
    const profiles = { ...config.profiles };
    delete profiles[name];
    await saveSettings(root, { ...config, profiles, active: config.active === name ? Object.keys(profiles)[0]! : config.active }, projectOnly);
    return true;
  }
  if (!await ctx.ui.confirm('List existing ' + config.profiles[name]!.provider + ' resources?', 'Explicit read-only discovery. No provisioning, start or resume.')) return false;
  let resources: Awaited<ReturnType<typeof discoverExisting>>;
  try { resources = await discoverExisting(config.profiles[name]!.provider, {}, config.profiles[name]!.credential); }
  catch { ctx.ui.notify('Listing unavailable. Check native credentials or use the masked CLI wizard.', 'error'); return false; }
  if (!resources.length) { ctx.ui.notify('No existing resources returned; enter an ID with Edit provider.', 'info'); return false; }
  const labels = resources.map(r => r.id + ' (' + r.state + ')');
  const selectedId = await ctx.ui.select('Choose existing resource', labels);
  if (!selectedId) return false;
  const resource = resources[labels.indexOf(selectedId)];
  if (!resource || resource.id === config.profiles[name]!.id) return false;
  if (config.profiles[name]!.managed && (await cloudSummary(config.profiles[name]!)).resources.some(r => r.state !== 'destroyed')) throw new Error('Destroy managed compute before attaching an external resource to this profile');
  if (!await ctx.ui.confirm('Use existing resource ' + resource.id + '?', 'Only the local resource ID will change.')) return false;
  await saveSettings(root, { ...config, profiles: { ...config.profiles, [name]: { ...config.profiles[name]!, id: resource.id, managed: undefined, owner: undefined, cacheVolume: undefined } } }, projectOnly);
  return true;
}

async function advanced(ctx: ExtensionCommandContext, root: string, config: Config): Promise<boolean> {
  const choice = await ctx.ui.select('Advanced (explicit actions; compute may be billable)', [
    'Credential sources', 'Forget saved API key', 'Stop resource', 'Resume resource', 'Destroy resource', 'Recover resource state', 'Back',
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
      const changed = await forgetProviderSecrets(provider, activeProfile(config).credential);
      ctx.ui.notify(changed ? 'Local key forgotten. Provider-issued key remains valid until revoked.' : 'No Reroute-stored key found.', 'info');
    }
    return false;
  }
  const action = choice === 'Stop resource' ? 'stop' : choice === 'Resume resource' ? 'resume' : choice === 'Recover resource state' ? 'recover' : 'destroy';
  const warning = action === 'resume' ? 'May incur charges. Modal may recreate compute from a snapshot.' :
    action === 'destroy' ? 'Permanently destroy this remote resource and its data?' :
      'Stop compute? Active/unresolved jobs must be resolved first.';
  if (!await ctx.ui.confirm(choice + ': ' + activeProfile(config).id, warning)) return false;
  await resourceAction(root, config, action);
  ctx.ui.notify('Provider operation completed. Run Check connection to refresh status.', 'info');
  return true;
}

function measured(job: Job): string {
  const m = job.metrics;
  if (!m) return 'Timing not measured';
  return 'Measured: source ' + (m.inputMs ?? '?') + ' ms; transfer ' + (m.transferMs ?? '?') + ' ms / ' + (m.transferredBytes ?? '?') +
    ' B; execution ' + (m.executionMs ?? '?') + ' ms; provision ' + (m.provisionMs ?? '?') + ' ms' +
    '\n  pack ' + (m.packMs ?? '?') + ' ms / ' + (m.archiveBytes ?? '?') + ' B; upload ' + (m.uploadMs ?? '?') + ' ms / ' + (m.uploadedBytes ?? '?') +
    ' B; remote unpack/verify ' + (m.remoteUnpackMs ?? '?') + '/' + (m.remoteVerifyMs ?? '?') + ' ms' +
    '\n  cache restore ' + (m.cacheRestoreMs ?? '?') + ' ms / ' + (m.cacheRestoreBytes ?? '?') + ' B; cache save ' + (m.cacheSaveMs ?? '?') + ' ms / ' + (m.cacheSaveBytes ?? '?') +
    ' B; cleanup/release ' + (m.cleanupMs ?? '?') + '/' + (m.releaseMs ?? '?') + ' ms; download cache: ' +
    (m.cacheHit === true ? 'archive restored' : m.cacheHit === false ? 'archive not restored' : 'unmeasured');
}

/** An explicit acceptance task, never run on panel open or connection checks. */
export async function smoke(ctx: ExtensionCommandContext, root: string, config: Config, execute = runRemote): Promise<void> {
  if (!ctx.hasUI) throw new Error('Smoke requires interactive user confirmation in /reroute.');
  if (config.mode === 'local') throw new Error('Project routing is local. Enable auto mode before requesting a remote smoke test.');
  const command = shell(['python3', '-c', 'print("REROUTE_SMOKE_OK")']);
  const timeoutMs = 30000, plan = cloudPlan(config, command, undefined, timeoutMs);
  const estimate = plan.profile.managed ? '$' + plan.estimatedUsd.toFixed(4) + ' conservative reservation' : 'unavailable for this existing resource (NOT free)';
  if (!await ctx.ui.confirm('Run one optional billable smoke task?',
    'Canonical project root: ' + await realpath(root) + '\nProvider/account: ' + plan.profile.provider + ' / ' + (plan.profile.credential ?? '(environment/native default)') +
    '\nCommand: ' + command + '\nTask timeout: 30 seconds. Offline cost estimate: ' + estimate +
    '. Credit and actual charges are unknown; startup, idle time and retained storage may be billable. Source is uploaded; trusted project preparation/scripts may execute. ' +
    'This confirms only this smoke task; project authorization and managed spending policy still gate execution.')) return;
  if (!await confirmProject(ctx, root, config)) { ctx.ui.notify(authorizationHelp, 'error'); return; }
  let started: Job | undefined;
  let result;
  try {
    result = await execute(command, { root, config, cwd: ctx.cwd, timeoutMs, onJob: job => { started = job; },
      onProgress: p => ctx.ui.notify(p.stage + ': ' + p.message, 'info') });
  } catch (error) {
    throw new Error(String(error) + (started ? '\nJob ID: ' + started.id + '. Inspect with reroute_status before any retry.' : '') + '\nNever retried locally.');
  }
  ctx.ui.notify('Smoke task: ' + result.job.status + ' | exit: ' + result.code + ' | Job ID: ' + result.job.id +
    '\n' + measured(result.job) + (result.job.error ? '\n' + result.job.error : '') +
    (result.job.status === 'exited' ? '' : '\nInspect with reroute_status before any retry. No local retry authorized.'),
    result.code === 0 && result.job.status === 'exited' && !result.job.error ? 'info' : 'error');
}

export async function panel(ctx: ExtensionCommandContext, checked = new Map<string, string>()): Promise<void> {
  if (!ctx.hasUI) throw new Error('/reroute requires an interactive Pi terminal.');
  for (;;) {
    const { root, config, source } = await loadConfig(ctx.cwd);
    if (!config) {
      if (await hasLegacy(root)) {
        ctx.ui.notify('Legacy Reroute state found. Recover old work before using --ignore-legacy; nothing was overwritten.', 'error');
        return;
      }
      const choice = await ctx.ui.select('Reroute | No configuration | Global setup recommended', [
        'Configure Daytona / Modal / SSH (masked terminal)', 'Configure this project', 'How to configure API credentials', 'Close',
      ]);
      if (choice === 'Configure Daytona / Modal / SSH (masked terminal)') { showSetup(ctx, root); return; }
      if (choice === 'Configure this project') {
        if (await editProfile(ctx, root, defaults(), undefined, true)) continue;
      } else if (choice === 'How to configure API credentials') {
        showSetup(ctx, root);
      }
      return;
    }

    const profile = activeProfile(config), canonical = await realpath(root);
    const key = JSON.stringify([canonical, config.active, profile]);
    const current = checked.get(key) ?? 'not checked this session';
    const sources = await credentialSources(config);
    const authorized = await projectAuthorized(canonical, config);
    const jobs = (await listJobs()).filter(j => j.project === canonical);
    const successful = jobs.filter(j => j.status === 'exited' && j.code === 0 && !j.error);
    const title = 'Reroute | ' + profile.provider + ' (' + config.active + ') | Config: ' + source +
      '\nProject: ' + canonical + '\nResource: ' + profile.id + ' | Mode: ' + config.mode +
      '\nCredential source: ' + sources[config.active] + ' (saved is not authenticated)' +
      '\nConnection (this session): ' + current + ' | Project remote authorization: ' + (authorized ? 'authorized' : 'NOT authorized') +
      '\nSuccessful actual tasks (local receipts): ' + successful.length + (successful[0] ? ' | latest: ' + successful[0].id : '') +
      (profile.compute ? '\n' + profile.compute.cpu + ' CPU / ' + profile.compute.memoryGiB + ' GiB' : '') +
      (profile.managed ? ' | Budget: $' + profile.managed.monthlyUsd + '/month (local estimate; credit unknown)' : '');
    let action = await ctx.ui.select(title, [
      'Overview', 'Manage providers', 'Compute & budget', 'Check connection', 'Authorize project remote execution', 'Revoke project authorization',
      'Optional low-cost smoke test', 'Routing mode', 'Project overrides', 'Recent jobs', 'Advanced', 'Close',
    ]);
    if (!action || action === 'Close') return;
    try {
      const projectOnly = action === 'Project overrides';
      if (projectOnly) {
        action = await ctx.ui.select('Project-only exceptions (minimal overrides; global defaults stay unchanged)', [
          'Manage providers', 'Compute & budget', 'Routing mode', 'Masked setup for this project', 'Back',
        ]);
        if (!action || action === 'Back') continue;
        if (action === 'Masked setup for this project') { showSetup(ctx, root, true); continue; }
      }
      // Never copy effective project overrides into global defaults while editing user settings.
      const settings = ['Manage providers', 'Compute & budget', 'Routing mode'].includes(action)
        ? projectOnly ? config : await loadUserConfig() ?? defaults() : config;
      if (Object.keys(settings.profiles).length) validate(settings);
      if (action === 'Overview') {
        const cloud = profile.managed ? '\nLocal resource estimates (NOT live status):\n' + JSON.stringify(await cloudSummary(profile), null, 2) : '';
        const environment = await inspectEnvironment(canonical);
        const declarations = '\nEnvironment declarations (root only; no execution/installation):\n' + [...environment.lines, ...environment.warnings, ...starterWarning(environment, profile)].join('\n');
        ctx.ui.notify(describeProfiles(config, jobs, sources) + '\nCanonical project: ' + canonical +
          '\nProject remote authorization: ' + (authorized ? 'authorized' : 'NOT authorized') +
          '\nConnection (this session): ' + current + '\nSuccessful actual tasks (local receipts, not fresh status): ' + successful.length + cloud + declarations +
          '\nSaved credentials do not establish authentication. No cloud calls made to view this overview.', 'info');
      } else if (action === 'Manage providers') {
        if (await manageProfiles(ctx, root, settings, projectOnly)) checked.clear();
      } else if (action === 'Compute & budget') {
        if (!Object.keys(settings.profiles).length) throw new Error('Configure global providers first, or choose Project overrides for this project.');
        const previous = activeProfile(settings);
        if (!['daytona','modal'].includes(previous.provider)) throw new Error('Managed specifications are available for Daytona/Modal; other providers keep their existing targets');
        const next = { ...previous, id: 'auto' };
        if (!await editCloudSettings(ctx, next)) continue;
        const candidate = { ...settings, profiles: { ...settings.profiles, [settings.active]: next } };
        const plan = cloudPlan(candidate, 'cargo test');
        if (previous.credential !== next.credential && (await cloudSummary(previous)).resources.some(r => r.state !== 'destroyed')) throw new Error('Destroy managed compute before changing credential accounts');
        if (await ctx.ui.confirm('Save ' + (projectOnly ? 'project' : 'global') + ' compute & billing policy?', 'Estimated worst-task reservation: $' + plan.estimatedUsd.toFixed(4) + '. Credit UNKNOWN; provider quota enforced by its API. Storage can remain billable. Project authorization is separate. No cloud call now.')) await saveSettings(root, candidate, projectOnly);
      } else if (action === 'Routing mode') {
        if (!Object.keys(settings.profiles).length) throw new Error('Configure global providers first, or choose Project overrides for this project.');
        const mode = await ctx.ui.select(projectOnly ? 'Project routing mode' : 'Global default routing mode', ['auto', 'local']);
        if (mode) await saveSettings(root, { ...settings, mode: mode as Config['mode'] }, projectOnly);
      } else if (action === 'Authorize project remote execution') {
        if (await confirmProject(ctx, canonical, config)) ctx.ui.notify('Project authorization saved. No source uploaded and no remote task started. Managed spending policy still applies.', 'info');
      } else if (action === 'Revoke project authorization') {
        if (await ctx.ui.confirm('Revoke this project remote authorization?', canonical + '\nFuture remote execution will require fresh approval. Running jobs are NOT cancelled.')) {
          await revokeProject(canonical);
          ctx.ui.notify('Project authorization revoked. Existing remote jobs/resources are unchanged.', 'info');
        }
      } else if (action === 'Optional low-cost smoke test') {
        await smoke(ctx, canonical, config);
      } else if (action === 'Check connection') {
        const result = await doctor(ctx.cwd, true);
        const status = String(result.checks.resource ?? 'unavailable');
        checked.set(key, (result.ok ? 'verified: ' : 'not ready: ') + status);
        ctx.ui.notify('Resource: ' + status + ' | Connection: ' + (result.ok ? 'verified' : 'not ready') +
          '\nThis connection check is not successful task execution or project authorization. Detailed diagnostics: reroute doctor --connect', result.ok ? 'info' : 'error');
      } else if (action === 'Recent jobs') {
        ctx.ui.notify(jobs.slice(0, 8).map(j => j.id + ' | ' + j.status + ' | ' + j.profile.provider +
          ' | ' + j.command + (j.metrics ? '\n  ' + measured(j) : '') +
          (j.cost ? '; reserved estimate: $' + j.cost.estimatedUsd.toFixed(4) : '')).join('\n') || 'No tasks recorded for this project', 'info');
      } else if (action === 'Advanced') {
        if (await advanced(ctx, root, config)) checked.clear();
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : 'Operation failed', 'error');
    }
  }
}
export function registerPi(pi: ExtensionAPI): void {
  // Pi deduplicates package paths, not distinct copies. The runtime bus survives module copies, not reload leases.
  const channel = '@onedotmint/reroute:registration:v1', claim = { registered: false };
  pi.events.emit(channel, claim);
  if (claim.registered) return;
  const release = pi.events.on(channel, value => { (value as typeof claim).registered = true; });
  pi.on('session_shutdown', () => release());
  const checked = new Map<string, string>();
  pi.on('before_agent_start', async (event, ctx) => {
    const prompt = event.systemPromptOptions, existing = prompt.toolGuidelines.reroute_run;
    if (!existing) return;
    const base = existing.filter(line => !line.startsWith(HISTORY_PREFIX) && !line.startsWith(ENVIRONMENT_PREFIX));
    prompt.toolGuidelines.reroute_run = base;
    if (!prompt.selectedTools.includes('reroute_run') || prompt.hiddenTools.includes('reroute_run')) return;
    try {
      const { root, config } = await loadConfig(ctx.cwd);
      if (!config || config.mode === 'local') return;
      const profile = activeProfile(config), canonical = await realpath(root);
      const environment = await inspectEnvironment(canonical);
      const declarations = environment.lines.length ? [ENVIRONMENT_PREFIX + 'Static root declarations, NOT verified remote compatibility: ' +
        [...environment.lines.slice(0, 3), ...environment.warnings.slice(0, 1)].join('; ').slice(0, 500)] : [];
      const environmentHints = [...declarations, ...starterWarning(environment, profile).map(line => ENVIRONMENT_PREFIX + line)];
      prompt.toolGuidelines.reroute_run = [...base, ...environmentHints];
      if (profile.managed && !profile.managed.authorized) return;
      const hints = projectExecutionHints(canonical, profile, await listJobs());
      prompt.toolGuidelines.reroute_run = [...base, ...environmentHints, ...hints];
    } catch { /* Optional local history must never block an agent run or disclose broken receipts. */ }
  });
  pi.registerTool(createRerouteTool());
  pi.registerTool(createRerouteStatusTool());
  pi.registerCommand('reroute',{description:'Reroute provider, routing and resource controls (no model calls)',handler:async(_args,ctx)=>panel(ctx, checked)});
}
