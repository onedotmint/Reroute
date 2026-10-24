import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { inside, processExec } from './util.js';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Category } from './types.js';
import { cloudSummary, presets } from './resources.js';
import { TOOLCHAIN_IMAGE } from './toolchain.js';
import { defaults, hasLegacy, loadConfig, loadUserConfig, projectRoot, saveConfig, saveUserConfig, userConfigPath, validate } from './config.js';
import { credentialStatus, saveProviderSecrets, secretFile, secretNames, type SecretMap } from './auth.js';
import { discoverExisting } from './discovery.js';
import { doctor } from './doctor.js';
export interface SetupOptions {
  advanced?: boolean;
  project?: boolean;
  nonInteractive?: boolean; provider?: string; id?: string; name?: string; root?: string;
  port?: string; identity?: string; app?: string; tasks?: string; noPi?: boolean; ignoreLegacy?: boolean;
  managed?: boolean; credential?: string; image?: string; cpu?: string; memory?: string; preset?: string;
  authorize?: boolean; monthlyUsd?: string; maxTaskUsd?: string; cpuHourUsd?: string; memoryHourUsd?: string;
  storageMonthUsd?: string; idleMinutes?: string; maxCpu?: string; maxMemory?: string;
}
function answer<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) throw new Error('Setup cancelled; no configuration saved');
  return v as Exclude<T, symbol>;
}
const guides: Record<ProviderId, string> = {
  ssh: 'Existing SSH host or alias; uses your ssh-agent, ~/.ssh/config and trusted host key.',
  skypilot: 'Install and authenticate the official sky CLI; select an existing cluster and SSH alias.',
  daytona: 'API key: https://app.daytona.io — credentials from DAYTONA_API_KEY or private Reroute store.',
  modal: 'Token pair: https://modal.com/settings — use native ~/.modal.toml or private Reroute store.',
  e2b: 'API key: https://e2b.dev/dashboard — credentials from E2B_API_KEY or private Reroute store.',
};

const managedLimits = { monthlyUsd: '3', maxTaskUsd: '0.5', storageMonthUsd: '0.01', idleMinutes: '5', maxCpu: '8', maxMemory: '16' };
const billingWarning = 'Credit/balance: unknown; no free credit assumed. Retained storage may still cost money.\nBudgets are local estimates, not hard bill caps; estimates cannot guarantee or prevent provider charges.';
function numeric(value: string | undefined, label: string, zero = false): number {
  const n = value?.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || (zero ? n < 0 : n <= 0)) throw new Error(label + (zero ? ' must be a nonnegative number' : ' must be an explicit positive number'));
  return n;
}
function managedProfile(profile: Partial<Profile>, options: SetupOptions): Partial<Profile> {
  if (profile.provider !== 'daytona' && profile.provider !== 'modal') throw new Error('Managed compute supports Daytona or Modal only');
  if (options.id !== undefined && options.id !== 'auto') throw new Error('Managed compute uses --id auto; omit --id for automatic allocation (existing IDs require existing-resource setup)');
  if (options.preset !== undefined && options.preset !== 'custom' && !Object.hasOwn(presets, options.preset)) throw new Error('Unknown compute preset: ' + options.preset);
  if (options.preset && options.preset !== 'custom' && (options.cpu !== undefined || options.memory !== undefined)) throw new Error('Choose --preset or custom --cpu/--memory, not both');
  const preset = options.preset && options.preset !== 'custom' ? presets[options.preset] : undefined;
  const previous = options.preset === 'custom' ? undefined : profile.compute;
  const compute = preset ? {...preset} : {
    cpu: numeric(options.cpu ?? (previous ? String(previous.cpu) : undefined), '--cpu'),
    memoryGiB: numeric(options.memory ?? (previous ? String(previous.memoryGiB) : undefined), '--memory'),
  };
  const image = options.image ?? profile.image;
  if (!image?.trim() || /[\0\r\n]/.test(image)) throw new Error('Managed compute requires --image with your toolchain image');
  delete profile.pendingResume; delete profile.snapshot; delete profile.owner; delete profile.cacheVolume;
  return { ...profile, id: 'auto', image, compute, managed: {
    authorized: options.authorize === true,
    maxCpu: numeric(options.maxCpu ?? managedLimits.maxCpu, '--max-cpu'),
    maxMemoryGiB: numeric(options.maxMemory ?? managedLimits.maxMemory, '--max-memory'),
    monthlyUsd: numeric(options.monthlyUsd ?? managedLimits.monthlyUsd, '--monthly-usd'),
    maxTaskUsd: numeric(options.maxTaskUsd ?? managedLimits.maxTaskUsd, '--max-task-usd'),
    cpuHourUsd: numeric(options.cpuHourUsd, '--cpu-hour-usd (reviewed rate)'),
    memoryGiBHourUsd: numeric(options.memoryHourUsd, '--memory-hour-usd (reviewed GiB rate)'),
    storageMonthUsd: numeric(options.storageMonthUsd ?? managedLimits.storageMonthUsd, '--storage-month-usd', true),
    idleMinutes: numeric(options.idleMinutes ?? managedLimits.idleMinutes, '--idle-minutes'),
  } };
}
async function managedPrompts(profile: Partial<Profile>, options: SetupOptions): Promise<Partial<Profile>> {
  const modal = profile.provider === 'modal', unit = modal ? 'physical cores (not vCPU)' : 'vCPU';
  p.note(billingWarning + (modal
    ? '\nModal execution and starter toolchain verified against the real service; broad recovery and billing unverified. Non-preemptible Sandbox rates below, NOT cheaper function rates.\nhttps://modal.com/pricing — CPU $0.00003942/core/sec × 3600; memory $0.00000667/GiB/sec × 3600.'
    : '\nhttps://www.daytona.io/pricing/ — public rates fetched 2026-10-21: vCPU $0.0504/h, memory $0.0162/GiB/h.') +
    '\nReview rates against your provider/account; offered defaults are not a billing guarantee.', 'Managed compute and billing');
  const sizing = answer(await p.select({message:'Compute specification', initialValue:options.preset ?? (profile.compute ? 'custom' : 'small'),
    options:[...Object.entries(presets).map(([value,c])=>({value,label:value+': '+c.cpu+' '+unit+', '+c.memoryGiB+' GiB'})),{value:'custom',label:'Custom CPU and memory'}]}));
  const values: SetupOptions = {...options, preset:sizing, cpu:undefined, memory:undefined};
  const amount = async (message: string, initialValue: string, zero = false) => answer(await p.text({message, initialValue,
    validate:v=>{ try { numeric(v,message,zero); } catch (e) { return (e as Error).message; } }}));
  if (sizing === 'custom') {
    values.cpu = await amount('CPU ('+unit+')', options.cpu ?? String(profile.compute?.cpu ?? 1));
    values.memory = await amount('Memory (GiB)', options.memory ?? String(profile.compute?.memoryGiB ?? 2));
  }
  values.image = answer(await p.text({message:'Toolchain image (must contain your build/test tools)',initialValue:options.image ?? profile.image ?? TOOLCHAIN_IMAGE,
    validate:v=>!v?.trim() || /[\0\r\n]/.test(v) ? 'A toolchain image is required' : undefined}));
  values.monthlyUsd = await amount('Monthly local estimate budget (USD)', options.monthlyUsd ?? String(profile.managed?.monthlyUsd ?? managedLimits.monthlyUsd));
  values.maxTaskUsd = await amount('Maximum per-task estimate (USD)', options.maxTaskUsd ?? String(profile.managed?.maxTaskUsd ?? managedLimits.maxTaskUsd));
  values.cpuHourUsd = await amount('Review CPU rate (USD/'+(modal?'physical-core':'vCPU')+'/hour)', options.cpuHourUsd ?? String(profile.managed?.cpuHourUsd ?? (modal ? 0.141912 : 0.0504)));
  values.memoryHourUsd = await amount('Review memory rate (USD/GiB/hour)', options.memoryHourUsd ?? String(profile.managed?.memoryGiBHourUsd ?? (modal ? 0.024012 : 0.0162)));
  values.storageMonthUsd = await amount('Monthly retained storage allowance (USD; may still be charged)', options.storageMonthUsd ?? String(profile.managed?.storageMonthUsd ?? managedLimits.storageMonthUsd), true);
  values.idleMinutes = await amount('Idle reclaim delay (whole minutes, 1-1440)', options.idleMinutes ?? String(profile.managed?.idleMinutes ?? managedLimits.idleMinutes));
  values.maxCpu = await amount('Maximum allowed CPU ('+unit+')', options.maxCpu ?? String(profile.managed?.maxCpu ?? managedLimits.maxCpu));
  values.maxMemory = await amount('Maximum allowed memory (GiB)', options.maxMemory ?? String(profile.managed?.maxMemoryGiB ?? managedLimits.maxMemory));
  return managedProfile(profile, {...values, id:undefined, authorize:false});
}

export async function setup(cwd: string, options: SetupOptions = {}): Promise<Config> {
  const root = await projectRoot(cwd);
  const existing = options.project ? (await loadConfig(root)).config : await loadUserConfig();
  const persist = (candidate: Config) => options.project ? saveConfig(root, candidate) : saveUserConfig(candidate);
  const destination = options.project ? join(root, '.reroute.json') : userConfigPath();
  if (await hasLegacy(root) && !options.ignoreLegacy)
    throw new Error('Legacy Reroute state detected and retained. Recover pending files using the old version first. --ignore-legacy starts an isolated v3 config; it does not migrate, erase, or recover old state.');
  const config = existing ?? defaults();
  if (!options.nonInteractive && !options.advanced && !Object.entries(options).some(([key,value]) => !['noPi','ignoreLegacy','nonInteractive','advanced','project'].includes(key) && value !== undefined)) {
    if (!process.stdin.isTTY) throw new Error('No interactive terminal. Use setup --non-interactive --provider ssh --id user@host');
    return quickSetup(root, config, options.project === true);
  }
  let name = options.name ?? (config.active || 'default');
  let profile: Partial<Profile> = {...config.profiles[name]};
  const pending: SecretMap = {};
  let testConnection = false;
  if (options.nonInteractive) {
    if (profile.managed && options.provider && options.provider !== profile.provider) profile = {};
    if (options.managed === false) delete profile.managed;
    profile = {...profile, ...(options.provider ? {provider:options.provider as ProviderId} : {}), ...(options.id ? {id:options.id} : {}), ...(options.root ? {root:options.root} : {}), ...(options.port ? {port:Number(options.port)} : {}), ...(options.identity ? {identityFile:resolve(options.identity.replace(/^~(?=\/)/,homedir()))} : {}), ...(options.app ? {app:options.app} : {}), ...(options.credential !== undefined ? {credential:options.credential} : {}), ...(options.image !== undefined ? {image:options.image} : {})};
    if (options.managed || profile.managed) profile = managedProfile(profile, options);
    else if (['cpu','memory','preset','authorize','monthlyUsd','maxTaskUsd','cpuHourUsd','memoryHourUsd','storageMonthUsd','idleMinutes','maxCpu','maxMemory'].some(key=>options[key as keyof SetupOptions] !== undefined))
      throw new Error('Compute sizing and billing options require --managed');
    if (!profile.provider || !profile.id) throw new Error('Non-interactive setup needs --provider and --id (or --managed / an existing named profile)');
    if (options.tasks !== undefined) config.tasks = options.tasks === 'none' ? [] : options.tasks.split(',') as Category[];
  } else {
    if (!process.stdin.isTTY) throw new Error('No interactive terminal. Use setup --non-interactive --provider ssh --id user@host');
    p.intro('Reroute | Local development, remote builds');
    if (existing) p.note(Object.entries(existing.profiles).map(([key,item]) =>
      (key === existing.active ? '* ' : '  ') + key + ': ' + item.provider + ' (' + item.id + ')').join('\n'), 'Configured providers (local only)');
    name = answer(await p.text({message:'Profile name (add or edit)', initialValue:name,
      validate:v=>!v || !/^[a-zA-Z0-9._-]+$/.test(v) ? 'Use letters, digits, dot, dash or underscore' : undefined}));
    profile = {...config.profiles[name]};
    const picked = answer(await p.select<ProviderId>({message:'Choose compute provider (nothing is provisioned)',
      initialValue:(options.provider as ProviderId) ?? profile.provider ?? 'ssh',
      options:PROVIDERS.map(value=>({value,label:value.toUpperCase() === 'SSH' ? 'SSH' : value === 'e2b' ? 'E2B' : value === 'skypilot' ? 'SkyPilot' : value === 'daytona' ? 'Daytona' : 'Modal'}))}));
    if (picked !== profile.provider) profile = {};
    profile.provider = picked;
    const managed = (picked === 'daytona' || picked === 'modal') && answer(await p.select({message:'Compute ownership',
      initialValue:options.managed || profile.managed ? 'managed' : 'existing', options:[
        {value:'existing',label:'Use an existing resource'},
        {value:'managed',label:'Reroute-managed compute (create on authorized tasks)'},
      ]})) === 'managed';
    if (!managed) { delete profile.managed; delete profile.compute; delete profile.owner; delete profile.cacheVolume; }
    p.note(guides[picked] + (['daytona','modal'].includes(picked) ? '\nReal-service execution verified; billing and broad failure recovery remain unverified.' : '') +
      (managed ? '\nSetup only saves local configuration; no cloud query, creation or start.' : '\nOnly existing compute is listed; nothing is created or resumed.'), 'Provider setup');
    if (secretNames[picked].length) {
      const credential = answer(await p.text({message:'Credential account name (blank uses original default)', initialValue:options.credential ?? profile.credential ?? '',
        validate:v=>v && (!/^[a-zA-Z0-9._-]+$/.test(v) || v === '.' || v === '..') ? 'Use letters, digits, dot, dash or underscore; not . or ..' : undefined}));
      profile.credential = credential || undefined;
      const authentication = await credentialStatus(picked, profile.credential);
      p.note('Detected authentication: ' + authentication + '. Credentials never enter .reroute.json.\nAn available credential is not proof of a successful login.', 'Authentication');
      if (authentication === 'missing') {
        const action = answer(await p.select({message:'How would you like to authenticate?',
          initialValue:'external',
          options:[
            {value:'external',label:profile.credential ? 'Configure this named account later (no environment / native credential fallback)' : 'Use environment variables / official provider login (no key stored by Reroute)'},
            {value:'save',label:'Enter masked key(s) and save locally (0600 file; NOT encrypted)'},
          ]}));
        if (action === 'save') {
          p.note('The key is stored ONLY in your user config directory with restricted Unix permissions. It is not encrypted or committed to the project. Skip this step if you prefer an OS keychain or provider CLI.', 'Private credential storage');
          for (const key of secretNames[picked]) pending[key] = answer(await p.password({message:key,mask:'*',validate:v=>!v?.trim()?'Credential required':undefined}));
        }
      }
    } else p.note('Authentication: use native SSH configuration or SkyPilot CLI; no API key is stored by Reroute.', 'Authentication');
    if (managed) profile = await managedPrompts(profile, options);
    else {
    let discovered: Awaited<ReturnType<typeof discoverExisting>> = [];
    const wantDiscovery = answer(await p.confirm({message:'List existing resources now? (read-only network query for cloud providers)',initialValue:false}));
    if (wantDiscovery) {
      const spin = p.spinner(); spin.start('Looking for existing resources');
      try {
        discovered = await discoverExisting(picked, pending, profile.credential);
        spin.stop(discovered.length ? 'Found '+discovered.length+' existing resources' : 'No existing resources found');
      } catch {
        spin.stop('Resource listing unavailable; enter your existing resource ID manually');
      }
    }
    let selectedId: string | undefined;
    if (discovered.length) {
      selectedId = answer(await p.select({message:'Choose an existing resource',
        options:[...discovered.map(r=>({value:r.id,label:r.label === r.id ? r.id + ' (' + r.state + ')' : r.label + ' — ' + r.id + ' (' + r.state + ')'})),
          {value:'__manual__',label:'Enter an existing ID manually'}],
        initialValue:discovered.some(r=>r.id===profile.id) ? profile.id : discovered[0]?.id}));
    }
    profile.id = selectedId && selectedId !== '__manual__' ? selectedId : answer(await p.text({
      message:picked === 'ssh' ? 'SSH alias or user@host' : picked === 'skypilot' ? 'Existing SkyPilot cluster / SSH alias' : 'Existing sandbox ID',
      initialValue:options.id ?? profile.id,
      validate:v=>!v?.trim()?'A resource ID is required':undefined}));
    }
    if (picked === 'ssh' || picked === 'skypilot') {
      const identity = answer(await p.text({message:'SSH identity file (blank uses ssh-agent / SSH config)',initialValue:options.identity ?? profile.identityFile ?? ''}));
      profile.identityFile = identity ? resolve(identity.replace(/^~(?=\/)/,homedir())) : undefined;
      const port = answer(await p.text({message:'SSH port (blank uses SSH config)',initialValue:options.port ?? (profile.port ? String(profile.port) : ''),validate:v=>v && (!/^\d+$/.test(v) || +v<1 || +v>65535)?'Use port 1-65535':undefined}));
      profile.port = port ? Number(port) : undefined;
    }
    if (picked === 'modal' && !managed) profile.app = answer(await p.text({message:'Existing Modal app name (needed for snapshot resume)',
      initialValue:options.app ?? profile.app ?? '',validate:v=>!v?'Existing app name required':undefined}));
    profile.root = answer(await p.text({message:'Isolated remote storage root',initialValue:options.root ?? profile.root ?? '/tmp/reroute-v3'}));
    config.tasks = answer(await p.multiselect<Category>({message:'Automatic task categories (Space selects, Enter confirms)',
      initialValues:config.tasks,required:false,options:(['build','test','check','benchmark'] as const).map(value=>({value,label:value}))}));
    p.note('Profile: '+name+' ('+picked+')\nResource: '+profile.id+'\nRouting: '+config.mode+
      (profile.managed ? '\nCompute: '+profile.compute!.cpu+' CPU / '+profile.compute!.memoryGiB+' GiB; image: '+profile.image+
        '\nMonthly estimate budget: $'+profile.managed.monthlyUsd+'; per-task: $'+profile.managed.maxTaskUsd+
        '\nCPU/hour: $'+profile.managed.cpuHourUsd+'; GiB/hour: $'+profile.managed.memoryGiBHourUsd+
        '\nStorage/month: $'+profile.managed.storageMonthUsd+'; idle: '+profile.managed.idleMinutes+' min'+
        '\nMaximum CPU: '+profile.managed.maxCpu+'; maximum memory: '+profile.managed.maxMemoryGiB+' GiB\n'+billingWarning : '')+
      '\nInput flows only from local to remote; no source writeback.\nNo paid compute will be created or resumed during setup.', 'Review');
    if (profile.managed) profile.managed.authorized = answer(await p.confirm({
      message:'Authorize automatic paid creation/start on future tasks? (No saves unauthorized)',initialValue:false}));
    if (!answer(await p.confirm({message:options.project ? 'Save this project configuration?' : 'Save user defaults for all projects? (Each project still needs remote execution consent)',initialValue:true})))
      throw new Error('Setup cancelled; no configuration saved');
    if (!managed && options.project) testConnection = answer(await p.confirm({message:'After saving, check connection to this existing resource? (no provisioning/resume)',initialValue:false}));
  }
  const previous = config.profiles[name];
  if (previous?.id !== profile.id) { delete profile.pendingResume; delete profile.snapshot; }
  if (previous?.managed && (!profile.managed || previous.provider !== profile.provider || previous.credential !== profile.credential) &&
      (await cloudSummary(previous)).resources.some(resource=>resource.state !== 'destroyed'))
    throw new Error('Managed resources remain on the previous account. Recover/destroy them before switching provider/credential or disabling managed compute; no configuration saved.');
  const candidate: Config = { ...config, profiles: {...config.profiles, [name]: profile as Profile}, active: name };
  validate(candidate);
  if (Object.keys(pending).length) {
    const git = await processExec('git', ['-C', root, 'rev-parse', '--show-toplevel']).catch(() => undefined);
    const sourceRoot = await realpath(git?.code === 0 && !git.stdoutTruncated ? git.stdout.trim() : root);
    if (inside(sourceRoot, resolve(secretFile(profile.credential)))) throw new Error('Private credential storage must be outside this project/repository; configure XDG_CONFIG_HOME outside it. No keys saved.');
    await saveProviderSecrets(profile.provider!, pending, profile.credential);
  }
  await persist(candidate);
  // Pi owns extension installation. Defaults never grant project source-upload or execution consent.
  if (!options.nonInteractive) {
    if (testConnection) {
      const spin = p.spinner(); spin.start('Checking existing resource (no resume)');
      try {
        const result = await doctor(root, true);
        spin.stop(result.ok ? 'Connection ready' : 'Connection not ready');
        p.note('Resource: '+String(result.checks.resource ?? 'unavailable')+'\n'+(result.ok ? 'Remote prerequisites verified' : 'Check reroute doctor --connect for diagnostics.'),'Connection');
      } catch { spin.stop('Connection could not be confirmed; see reroute doctor --connect'); }
    }
    p.outro('Saved '+destination+
      '\nPi extension installation is managed separately by Pi (pi install ...). Each project needs one-time remote execution consent.'+
      '\nOpen Pi or run /reload, then /reroute. Add another provider by rerunning reroute setup.');
  }
  return candidate;
}

/** First-run path: collect locally, review once, then persist; advanced edits keep their existing path. */
async function quickSetup(root: string, config: Config, project: boolean): Promise<Config> {
  p.intro('Reroute | Configure once, use from Pi');
  const picked = answer(await p.multiselect({ message: 'Choose providers — Space toggles, ↑/↓ moves, Enter confirms (multiple allowed)',
    initialValues: ['daytona'], required: true, options: [
      { value: 'daytona', label: 'Daytona', hint: 'API key → automatic Sandbox' },
      { value: 'modal', label: 'Modal', hint: 'Token ID + Secret → automatic Sandbox' },
      { value: 'ssh', label: 'SSH — use your own server', hint: 'Existing SSH alias; no API key' },
      { value: 'advanced', label: 'Advanced / existing Sandbox / other providers', hint: 'Account edits, custom targets, E2B, SkyPilot' },
    ] }));
  if (picked.includes('advanced')) {
    p.note('Advanced setup configures one profile at a time. Quick selections have not been saved.', 'Advanced configuration');
    return setup(root, { advanced: true, project, ignoreLegacy: true });
  }
  const candidate: Config = { ...config, profiles: { ...config.profiles } };
  const pending: { provider: ProviderId; credential: string; values: SecretMap }[] = [];
  const added: string[] = [];
  for (const value of picked) {
    const provider = value as ProviderId;
    const existing = Object.entries(config.profiles).filter(([,profile]) => profile.provider === provider);
    let name = provider as string;
    if (existing.length) {
      const selection = answer(await p.select({ message: provider + ' — use a saved profile or add an account',
        options: [...existing.map(([value,profile]) => ({ value, label: 'Keep ' + value, hint: profile.managed ? 'Managed compute; settings unchanged' : 'Existing target; settings unchanged' })),
          { value: ':new-account:', label: 'Add another account / server' }] }));
      if (selection !== ':new-account:') continue;
    }
    if (existing.length || Object.hasOwn(candidate.profiles, name)) {
      name = answer(await p.text({ message: provider + ' — new profile/account name', placeholder: provider + '-work',
        validate: v => !v || !/^[a-zA-Z0-9._-]+$/.test(v) || ['.','..'].includes(v) || Object.hasOwn(candidate.profiles,v) || v === ':new-account:'
          ? 'Choose a new name (letters, digits, dot, dash, underscore); existing profiles are never overwritten' : undefined }));
    }
    if (provider === 'ssh') {
      const id = answer(await p.text({ message: 'SSH alias or user@host', placeholder: 'The host you already use with ssh', validate: v => !v?.trim() ? 'Existing SSH target required' : undefined }));
      candidate.profiles = { ...candidate.profiles, [name]: { provider, id: id.trim() } };
      added.push(name);
      continue;
    }
    let credential: string | undefined = name;
    const values: SecretMap = {};
    const named = await credentialStatus(provider, credential);
    if (named === 'missing') {
      const native = await credentialStatus(provider);
      p.note(guides[provider] + '\nKeys are masked and stored outside this project in a private, unencrypted 0600 file. Never paste keys into Pi text fields.', provider + ' credentials');
      const action = answer(await p.select({ message: provider + ' — credentials', initialValue: 'save', options: [
        { value: 'save', label: 'Enter masked credentials now' },
        ...(native !== 'missing' ? [{ value: 'native', label: 'Use detected environment / native credentials', hint: 'Detected source only, not a verified login' }] : []),
        { value: 'later', label: 'Configure credentials later', hint: 'Profile saved without spending authorization' },
      ] }));
      if (action === 'native') credential = undefined;
      else if (action === 'save') {
        for (const key of secretNames[provider]) values[key] = answer(await p.password({ message: provider + ' — ' + key, mask: '*', validate: v => !v?.trim() ? 'Credential required' : undefined }));
        pending.push({ provider, credential: name, values });
      }
    } else p.note('Using saved private credential account: ' + credential + '. This is not a connection check.', provider);
    const options: SetupOptions = { preset: 'small', image: TOOLCHAIN_IMAGE,
      cpuHourUsd: provider === 'modal' ? '0.141912' : '0.0504', memoryHourUsd: provider === 'modal' ? '0.024012' : '0.0162' };
    candidate.profiles = { ...candidate.profiles, [name]: managedProfile({ provider, credential }, options) as Profile };
    added.push(name);
  }
  const cloud = added.filter(name => candidate.profiles[name]!.managed);
  if (cloud.length) {
    p.note('Small: 1 CPU / 2 GiB; Node 22 + Rust + Python starter image. First build can take time.\n$3/month estimate limit PER credential account, $0.50/task, 5-minute idle allowance; multiple accounts have separate budgets.\nCPU/memory ceilings: 8 / 16 GiB; storage reservation $0.01/task.\n' + billingWarning, 'Recommended settings');
    const settings = answer(await p.select({ message: 'Compute & budget', options: [
      { value: 'defaults', label: 'Use recommended settings', hint: 'Review rates and authorization next' },
      { value: 'custom', label: 'Customize specifications, image, budget or rates' },
    ] }));
    if (settings === 'custom') for (const name of cloud) candidate.profiles[name] = await managedPrompts(candidate.profiles[name]!, {}) as Profile;
  }
  const names = Object.keys(candidate.profiles);
  candidate.active = names.length === 1 ? names[0]! : answer(await p.select({ message: 'Default provider for this project',
    initialValue: config.active || names[0], options: names.map(value => ({ value, label: value + ' — ' + candidate.profiles[value]!.provider })) }));
  if (cloud.length) {
    p.note(cloud.map(name => {
      const profile = candidate.profiles[name]!, policy = profile.managed!, modal = profile.provider === 'modal';
      return name + ': ' + profile.compute!.cpu + (modal ? ' physical CPU cores' : ' vCPU') + ' / ' + profile.compute!.memoryGiB + ' GiB; image: ' + profile.image +
        '\n  Estimate budget $' + policy.monthlyUsd + '/month per account, $' + policy.maxTaskUsd + '/task; CPU $' + policy.cpuHourUsd + '/hour, memory $' + policy.memoryGiBHourUsd + '/GiB-hour' +
        '\n  Rates: ' + (modal ? 'https://modal.com/pricing (non-preemptible Sandbox rates)' : 'https://www.daytona.io/pricing/') +
        '\n  ' + (modal ? 'Compute released after confirmed tasks; Volume retained.' : 'Owned compute reused; guarded idle stop; Volume retained.');
    }).join('\n') + '\n' + billingWarning + '\nProvider quota and rates are not verified; check the official account before authorizing.', 'Review rates & costs — actual billing unverified');
    const ready: string[] = [];
    for (const name of cloud) {
      const profile = candidate.profiles[name]!;
      if (pending.some(item => item.provider === profile.provider && item.credential === profile.credential) || await credentialStatus(profile.provider, profile.credential) !== 'missing') ready.push(name);
    }
    if (ready.length && answer(await p.confirm({ message: 'Authorize future paid creation/start for ' + ready.join(', ') + '? (No = save safely without authorization)', initialValue: false })))
      for (const name of ready) candidate.profiles[name]!.managed!.authorized = true;
  }
  validate(candidate);
  p.note('Default: ' + candidate.active + '\nProfiles: ' + Object.keys(candidate.profiles).join(', ') + '\nExisting profiles retained. No cloud requests, creation or start during this setup.', 'Save configuration');
  if (!answer(await p.confirm({ message: project ? 'Save these project profiles and private credentials?' : 'Save these user defaults and private credentials? (Project consent is separate)', initialValue: true }))) throw new Error('Setup cancelled; nothing saved');
  // Validate all destinations before writing any credential; cancellation above leaves no partial setup.
  if (pending.length) {
    const git = await processExec('git', ['-C', root, 'rev-parse', '--show-toplevel']).catch(() => undefined);
    const sourceRoot = await realpath(git?.code === 0 && !git.stdoutTruncated ? git.stdout.trim() : root);
    for (const item of pending) if (inside(sourceRoot, resolve(secretFile(item.credential)))) throw new Error('Private credential storage must be outside this project/repository. No keys saved.');
    for (const item of pending) await saveProviderSecrets(item.provider, item.values, item.credential);
  }
  if (project) await saveConfig(root, candidate); else await saveUserConfig(candidate);
  p.outro('Saved ' + (project ? join(root, '.reroute.json') : userConfigPath()) + '. Open Pi → /reroute.\nCredentials saved/detected, NOT verified online. Spending policy: ' +
    (candidate.profiles[candidate.active]!.managed?.authorized ? 'authorized within reviewed estimates' : 'not authorized for managed creation/start') +
    '. Each project still requires one-time consent before source upload or paid execution.\nAI chooses heavy tasks; AFT keeps ordinary Bash. First-task success is reported after a real task, not after setup.');
  return candidate;
}
