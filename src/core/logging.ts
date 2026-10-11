import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { home, privateDir } from '../platform/files.js';
import { redact } from './errors.js';
import { isSecretName } from './routing.js';
const LIMIT = 1024 * 1024;
export function scrub(text: string): string {
  let result = redact(text);
  for (const [key, value] of Object.entries(process.env)) if (isSecretName(key) && value && value.length >= 8) result = result.split(value).join('[REDACTED]');
  return result;
}
export async function log(event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const dir = join(home(), 'logs'); await privateDir(dir); const path = join(dir, 'daemon.jsonl');
  try { if ((await fs.stat(path)).size > LIMIT) await fs.rename(path, path + '.1'); } catch { /* first log */ }
  // Caller supplies only identifiers/status, never argv, env, provider responses or raw errors.
  await fs.appendFile(path, scrub(JSON.stringify({ time: new Date().toISOString(), event, ...fields })) + '\n', { mode: 0o600 });
}
export class LogTail {
  private text = '';
  push(stream: string, data: Buffer): void { this.text = (this.text + `[${stream}] ${scrub(data.toString('utf8'))}`).slice(-LIMIT); }
  read(): string { return this.text; }
}
