import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Category } from './types.js';
import { defaults, hasLegacy, loadConfig, saveConfig, validate } from './config.js';
import { credentialStatus, saveProviderSecrets, secretNames, type SecretMap } from './auth.js';
import { discoverExisting } from './discovery.js';
import { doctor } from './doctor.js';
export interface SetupOptions {
  nonInteractive?: boolean; provider?: string; id?: string; name?: string; root?: string;
  port?: string; identity?: string; app?: string; tasks?: string; noPi?: boolean; ignoreLegacy?: boolean;
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

export async function setup(cwd: string, options: SetupOptions = {}): Promise<Config> {
  const {root, config: existing} = await loadConfig(cwd);
  if (await hasLegacy(root) && !options.ignoreLegacy)
    throw new Error('Legacy Reroute state detected and retained. Recover pending files using the old version first. --ignore-legacy starts an isolated v3 config; it does not migrate, erase, or recover old state.');
  const config = existing ?? defaults();
  let name = options.name ?? (config.active || 'default');
  let profile: Partial<Profile> = {...config.profiles[name]};
  const pending: SecretMap = {};
  let testConnection = false;
  if (options.nonInteractive) {
    profile = {...profile, ...(options.provider ? {provider:options.provider as ProviderId} : {}), ...(options.id ? {id:options.id} : {}), ...(options.root ? {root:options.root} : {}), ...(options.port ? {port:Number(options.port)} : {}), ...(options.identity ? {identityFile:resolve(options.identity.replace(/^~(?=\/)/,homedir()))} : {}), ...(options.app ? {app:options.app} : {})};
    if (!profile.provider || !profile.id) throw new Error('Non-interactive setup needs --provider and --id (or an existing named profile)');
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
    p.note(guides[picked] + (picked === 'ssh' ? '' : '\nEXPERIMENTAL: this provider has offline contract coverage, but no live account acceptance yet.') + '\nOnly existing compute is listed; nothing is created or resumed.', 'Provider setup');
    const authentication = await credentialStatus(picked);
    if (secretNames[picked].length) {
      p.note('Detected authentication: ' + authentication + '. Credentials never enter .reroute.json.\nAn available credential is not proof of a successful login.', 'Authentication');
      if (authentication === 'missing') {
        const action = answer(await p.select({message:'How would you like to authenticate?',
          initialValue:'external',
          options:[
            {value:'external',label:'Use environment variables / official provider login (no key stored by Reroute)'},
            {value:'save',label:'Enter masked key(s) and save locally (0600 file; NOT encrypted)'},
          ]}));
        if (action === 'save') {
          p.note('The key is stored ONLY in your user config directory with restricted Unix permissions. It is not encrypted or committed to the project. Skip this step if you prefer an OS keychain or provider CLI.', 'Private credential storage');
          for (const key of secretNames[picked]) pending[key] = answer(await p.password({message:key,mask:'*',validate:v=>!v?.trim()?'Credential required':undefined}));
        }
      }
    } else p.note('Authentication: use native SSH configuration or SkyPilot CLI; no API key is stored by Reroute.', 'Authentication');
    let discovered: Awaited<ReturnType<typeof discoverExisting>> = [];
    const wantDiscovery = answer(await p.confirm({message:'List existing resources now? (read-only network query for cloud providers)',initialValue:false}));
    if (wantDiscovery) {
      const spin = p.spinner(); spin.start('Looking for existing resources');
      try {
        discovered = await discoverExisting(picked, pending);
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
    if (picked === 'ssh' || picked === 'skypilot') {
      const identity = answer(await p.text({message:'SSH identity file (blank uses ssh-agent / SSH config)',initialValue:options.identity ?? profile.identityFile ?? ''}));
      profile.identityFile = identity ? resolve(identity.replace(/^~(?=\/)/,homedir())) : undefined;
      const port = answer(await p.text({message:'SSH port (blank uses SSH config)',initialValue:options.port ?? (profile.port ? String(profile.port) : ''),validate:v=>v && (!/^\d+$/.test(v) || +v<1 || +v>65535)?'Use port 1-65535':undefined}));
      profile.port = port ? Number(port) : undefined;
    }
    if (picked === 'modal') profile.app = answer(await p.text({message:'Existing Modal app name (needed for snapshot resume)',
      initialValue:options.app ?? profile.app ?? '',validate:v=>!v?'Existing app name required':undefined}));
    profile.root = answer(await p.text({message:'Isolated remote storage root',initialValue:options.root ?? profile.root ?? '/tmp/reroute-v3'}));
    config.tasks = answer(await p.multiselect<Category>({message:'Automatic task categories (Space selects, Enter confirms)',
      initialValues:config.tasks,required:false,options:(['build','test','check','benchmark'] as const).map(value=>({value,label:value}))}));
    p.note('Profile: '+name+' ('+picked+')\nResource: '+profile.id+'\nRouting: '+config.mode+
      '\nInput flows only from local to remote; no source writeback.\nNo paid compute will be created or resumed during setup.', 'Review');
    if (!answer(await p.confirm({message:'Save this project configuration?',initialValue:true})))
      throw new Error('Setup cancelled; no configuration saved');
    testConnection = answer(await p.confirm({message:'After saving, check connection to this existing resource? (no provisioning/resume)',initialValue:false}));
  }
  const candidate: Config = { ...config, profiles: {...config.profiles, [name]: profile as Profile}, active: name };
  validate(candidate);
  if (Object.keys(pending).length) await saveProviderSecrets(profile.provider!, pending);
  await saveConfig(root,candidate);
  // Pi package installation is always managed by Pi itself (pi install -l, pi remove -l).
  // Setup touches project configuration only; never writes Pi extension entries or settings.
  if (!options.nonInteractive) {
    if (testConnection) {
      const spin = p.spinner(); spin.start('Checking existing resource (no resume)');
      try {
        const result = await doctor(root, true);
        spin.stop(result.ok ? 'Connection ready' : 'Connection not ready');
        p.note('Resource: '+String(result.checks.resource ?? 'unavailable')+'\n'+(result.ok ? 'Remote prerequisites verified' : 'Check reroute doctor --connect for diagnostics.'),'Connection');
      } catch { spin.stop('Connection could not be confirmed; see reroute doctor --connect'); }
    }
    p.outro('Saved '+join(root,'.reroute.json')+
      '\nPi extension installation is managed separately by Pi (pi install -l ...).'+
      '\nOpen Pi or run /reload, then /reroute. Add another provider by rerunning reroute setup.');
  }
  return candidate;
}
