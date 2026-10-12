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
export const secretFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'reroute', 'credentials.json');

async function privateDirectory(): Promise<void> {
  const folder = dirname(secretFile());
  await noSymlink(folder);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const s = await lstat(folder);
  if (!s.isDirectory() || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
    throw new Error('Reroute credentials directory must belong to you and have mode 0700: ' + folder);
}
export async function savedSecrets(): Promise<SecretMap> {
  const path = secretFile();
  await noSymlink(path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  try {
    const s = await file.stat();
    if (!s.isFile() || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0)
      throw new Error('Reroute credentials file must be owned by you and mode 0600 (or stricter)');
    const data: unknown = JSON.parse(await file.readFile('utf8'));
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
export async function credentialsFor(provider: ProviderId): Promise<SecretMap> {
  const saved = await savedSecrets(), out: SecretMap = {};
  for (const name of secretNames[provider]) {
    const value = process.env[name] || saved[name];
    if (value) out[name] = value;
  }
  return out;
}
export async function credentialStatus(provider: ProviderId): Promise<'native' | 'environment' | 'saved-local-file' | 'missing'> {
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
export async function saveProviderSecrets(provider: ProviderId, values: SecretMap): Promise<void> {
  const names = secretNames[provider];
  if (!names.length || names.some(name => !values[name]?.trim()) || Object.keys(values).some(k => !names.includes(k)))
    throw new Error('Missing or unexpected provider credentials');
  await privateDirectory();
  const merged = { ...await savedSecrets(), ...values };
  await atomicJson(secretFile(), merged);
}

/** Forget only Reroute's local private file entries; does not revoke a provider key or alter process environment. */
export async function forgetProviderSecrets(provider: ProviderId): Promise<boolean> {
  const old = await savedSecrets();
  const remaining: SecretMap = {...old};
  let changed = false;
  for (const name of secretNames[provider]) {
    if (name in remaining) { delete remaining[name]; changed = true; }
  }
  if (changed) { await privateDirectory(); await atomicJson(secretFile(), remaining); }
  return changed;
}
