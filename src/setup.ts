import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PROVIDERS, type Config, type Profile, type ProviderId, type Category } from './types.js';
import { defaults, hasLegacy, loadConfig, saveConfig, validate } from './config.js';
import { noSymlink } from './util.js';
export interface SetupOptions {
  nonInteractive?: boolean; provider?: string; id?: string; name?: string; root?: string;
  port?: string; identity?: string; app?: string; tasks?: string; noPi?: boolean; ignoreLegacy?: boolean;
}
const marker = '// Reroute v3 owned extension entry';
export async function installPi(agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')): Promise<string> {
  const target = join(agentDir, 'extensions', 'reroute.ts');
  await noSymlink(target);
  let previous: string | undefined;
  try { previous = await readFile(target,'utf8'); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (previous !== undefined && !previous.startsWith(marker + '\n')) throw new Error(`Existing unowned Pi extension retained: ${target}. Remove/disable the old adapter yourself, then rerun setup. Configuration was not lost.`);
  const entry = fileURLToPath(new URL('../adapters/pi.ts', import.meta.url));
  const source = `${marker}\nexport { default } from ${JSON.stringify(entry)};\n`;
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temp = `${target}.${randomUUID()}.tmp`; await writeFile(temp,source,{flag:'wx',mode:0o600}); await rename(temp,target);
  return target;
}
function answer<T>(v: T): Exclude<T, symbol> { if (p.isCancel(v)) throw new Error('Setup cancelled; no configuration saved'); return v as Exclude<T, symbol>; }
export async function setup(cwd: string, options: SetupOptions = {}): Promise<Config> {
  const {root, config: existing} = await loadConfig(cwd);
  if (await hasLegacy(root) && !options.ignoreLegacy) throw new Error('Legacy Reroute state detected and retained. Recover pending files using the old version first. --ignore-legacy starts an isolated v3 config; it does not migrate, erase, or recover old state.');
  const config = existing ?? defaults();
  let name = options.name ?? (config.active || 'default');
  let profile: Partial<Profile> = {...config.profiles[name]};
  if (options.nonInteractive) {
    profile = {...profile, ...(options.provider ? {provider:options.provider as ProviderId} : {}), ...(options.id ? {id:options.id} : {}), ...(options.root ? {root:options.root} : {}), ...(options.port ? {port:Number(options.port)} : {}), ...(options.identity ? {identityFile:resolve(options.identity.replace(/^~(?=\/)/,homedir()))} : {}), ...(options.app ? {app:options.app} : {})};
    if (!profile.provider || !profile.id) throw new Error('Non-interactive setup needs --provider and --id (or an existing named profile)');
    if (options.tasks !== undefined) config.tasks = options.tasks === 'none' ? [] : options.tasks.split(',') as Category[];
  } else {
    if (!process.stdin.isTTY) throw new Error('No interactive terminal. Use setup --non-interactive --provider ssh --id user@host');
    p.intro('Reroute - local development, remote compute');
    name = answer(await p.text({message:'Profile name', initialValue:name, validate:v=>!v || !/^[a-zA-Z0-9._-]+$/.test(v) ? 'Use letters, digits, dot, dash or underscore' : undefined}));
    profile = {...config.profiles[name]};
    profile.provider = answer(await p.select<ProviderId>({message:'Existing compute environment (nothing is provisioned)',initialValue:(options.provider as ProviderId) ?? profile.provider ?? 'ssh',options:PROVIDERS.map(value=>({value,label:value}))}));
    profile.id = answer(await p.text({message:profile.provider === 'ssh' ? 'SSH alias or user@host (key authentication)' : profile.provider === 'skypilot' ? 'Existing SkyPilot cluster / SSH alias' : 'Existing sandbox ID',initialValue:options.id ?? profile.id,validate:v=>!v?.trim()?'A resource ID is required':undefined}));
    if (['ssh','skypilot'].includes(profile.provider)) {
      const identity = answer(await p.text({message:'SSH identity file (blank uses ssh-agent / SSH config)',initialValue:options.identity ?? profile.identityFile ?? ''}));
      profile.identityFile = identity ? resolve(identity.replace(/^~(?=\/)/,homedir())) : undefined;
      const port = answer(await p.text({message:'SSH port (blank uses SSH config)',initialValue:options.port ?? (profile.port ? String(profile.port) : ''),validate:v=>v && (!/^\d+$/.test(v) || +v<1 || +v>65535)?'Use port 1-65535':undefined}));
      profile.port = port ? Number(port) : undefined;
    }
    if (profile.provider === 'modal') profile.app = answer(await p.text({message:'Existing Modal app name (needed for snapshot resume)',initialValue:options.app ?? profile.app ?? '',validate:v=>!v?'Existing app name required':undefined}));
    profile.root = answer(await p.text({message:'Isolated remote storage root',initialValue:options.root ?? profile.root ?? '/tmp/reroute-v3'}));
    config.tasks = answer(await p.multiselect<Category>({message:'Automatic task categories (Space selects, Enter confirms)',initialValues:config.tasks,required:false,options:(['build','test','check','benchmark'] as const).map(value=>({value,label:value}))}));
    p.note(`${profile.provider}: ${profile.id}\nSource travels one way. Secrets/local environment are not forwarded.\nExisting remote resources must already contain your toolchain.\nAuthentication uses the provider's own configuration/environment.\nNo cloud resource will be created or resumed by setup.`, 'Review');
    if (!answer(await p.confirm({message:'Save this project configuration?',initialValue:true}))) throw new Error('Setup cancelled; no configuration saved');
  }
  config.profiles[name] = profile as Profile; config.active=name; validate(config);
  await saveConfig(root,config);
  const entry = options.noPi ? undefined : await installPi();
  if (!options.nonInteractive) p.outro(`Saved ${join(root,'.reroute.json')}${entry ? '\nPi extension registered. Start Pi or run /reload, then /reroute.' : ''}\nRun reroute doctor --connect to check the existing resource.`);
  return config;
}
