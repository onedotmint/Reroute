import { constants } from 'node:fs';
import { mkdir, open, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicJson, noSymlink } from './util.js';
import type { ProviderId } from './types.js';

export const secretNames: Record<ProviderId, readonly string[]> = {
  ssh: [], skypilot: [],
  daytona: ['DAYTONA_API_KEY'],
  modal: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
  e2b: ['E2B_API_KEY'],
};
export type SecretMap = Record<string, string>;
export const secretFile = (credential?: string) => {
  const folder = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'reroute');
  if (credential === undefined) return join(folder, 'credentials.json');
  if (typeof credential !== 'string' || !credential || /[^a-zA-Z0-9._-]/.test(credential) || credential === '.' || credential === '..')
    throw new Error('Invalid credential name');
  return join(folder, 'accounts', credential + '.json');
};

async function privateDirectory(credential?: string, create = true): Promise<void> {
  const folder = dirname(secretFile(credential));
  await noSymlink(folder);
  if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
  let s;
  try { s = await lstat(folder); }
  catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
    throw new Error('Reroute credentials directory must belong to you and have mode 0700: ' + folder);
}
export async function savedSecrets(credential?: string): Promise<SecretMap> {
  const path = secretFile(credential);
  if (credential !== undefined) await privateDirectory(credential, false);
  await noSymlink(path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  try {
    const s = await file.stat();
    if (!s.isFile() || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
      throw new Error('Reroute credentials file must be owned by you and mode 0600 (or stricter)');
    const text = await file.readFile('utf8');
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw new Error('Invalid private credentials file'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid private credentials file');
    const allowed = new Set(Object.values(secretNames).flat());
    const out: SecretMap = {};
    for (const [key, value] of Object.entries(data)) {
      if (!allowed.has(key) || typeof value !== 'string' || !value.trim()) throw new Error('Invalid private credential fields');
      out[key] = value;
    }
    return out;
  } finally { await file.close(); }
}
export async function credentialsFor(provider: ProviderId, credential?: string): Promise<SecretMap> {
  const saved = await savedSecrets(credential), out: SecretMap = {};
  const names = secretNames[provider];
  if (credential !== undefined && (!names.length || names.some(name => !saved[name])))
    throw new Error('Missing named provider credentials');
  for (const name of names) {
    const value = credential === undefined ? process.env[name] || saved[name] : saved[name];
    if (value) out[name] = value;
  }
  return out;
}
export async function credentialStatus(provider: ProviderId, credential?: string): Promise<'native' | 'environment' | 'saved-local-file' | 'missing'> {
  if (credential !== undefined) {
    const saved = await savedSecrets(credential), names = secretNames[provider];
    return names.length && names.every(name => !!saved[name]) ? 'saved-local-file' : 'missing';
  }
  if (provider === 'ssh' || provider === 'skypilot') return 'native';
  const names = secretNames[provider];
  if (names.every(name => !!process.env[name])) return 'environment';
  const saved = await savedSecrets();
  if (names.every(name => !!(process.env[name] || saved[name]))) return 'saved-local-file';
  if (provider === 'modal') {
    try { await readFile(join(homedir(), '.modal.toml'), 'utf8'); return 'native'; } catch {}
  }
  return 'missing';
}
export async function saveProviderSecrets(provider: ProviderId, values: SecretMap, credential?: string): Promise<void> {
  const names = secretNames[provider];
  if (!names.length || names.some(name => !values[name]?.trim()) || Object.keys(values).some(k => !names.includes(k)))
    throw new Error('Missing or unexpected provider credentials');
  await privateDirectory(credential);
  const merged = { ...await savedSecrets(credential), ...values };
  await atomicJson(secretFile(credential), merged);
}

/** Forget only Reroute's local private file entries; does not revoke a provider key or alter process environment. */
export async function forgetProviderSecrets(provider: ProviderId, credential?: string): Promise<boolean> {
  const old = await savedSecrets(credential);
  const remaining: SecretMap = {...old};
  let changed = false;
  for (const name of secretNames[provider]) {
    if (name in remaining) { delete remaining[name]; changed = true; }
  }
  if (changed) { await privateDirectory(credential); await atomicJson(secretFile(credential), remaining); }
  return changed;
}
