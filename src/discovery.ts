import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from './types.js';
import { credentialsFor, type SecretMap } from './auth.js';
import { processExec } from './util.js';

export interface ExistingResource { id: string; state: string; label: string }
const limit = 20;
function row(id: unknown, state: unknown, label?: unknown): ExistingResource | undefined {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(id)) return;
  const status = typeof state === 'string' ? state : 'unknown';
  const display = typeof label === 'string' && !/[\r\n\x00-\x1f]/.test(label) ? label : id;
  return { id, state: status, label: display };
}
export async function discoverExisting(provider: ProviderId, pending: SecretMap = {}): Promise<ExistingResource[]> {
  const secrets = { ...await credentialsFor(provider), ...pending };
  const result: ExistingResource[] = [];
  const add = (id: unknown, state: unknown, label?: unknown) => {
    const item = row(id, state, label);
    if (item && !result.some(r => r.id === item.id)) result.push(item);
  };
  if (provider === 'ssh') {
    // Only parse host names: reading ssh config never establishes a network connection.
    let conf = '';
    try { conf = await readFile(join(homedir(), '.ssh', 'config'), 'utf8'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const line of conf.split(/\r?\n/)) {
      const match = /^\s*Host\s+(.+?)(?:\s*#.*)?$/i.exec(line);
      if (!match) continue;
      for (const host of match[1]!.trim().split(/\s+/))
        if (!/[\*?!]/.test(host)) add(host, 'unverified SSH alias');
      if (result.length >= limit) break;
    }
  } else if (provider === 'skypilot') {
    // Read-only, no refresh, start, or provider provisioning.
    const r = await processExec('sky', ['status', '-o', 'json'], { timeoutMs: 45000 });
    if (r.code !== 0 || r.stdoutTruncated) throw new Error('SkyPilot status query failed or was truncated; enter an existing cluster name manually');
    const clean = r.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
    // Some SkyPilot versions add human prose before their JSON; do not parse a plain text table.
    const index = clean.indexOf('['), json = index >= 0 ? clean.slice(index) : clean;
    let items: unknown;
    try { items = JSON.parse(json); } catch { throw new Error('SkyPilot did not return machine-readable JSON; enter an existing cluster name manually'); }
    if (!Array.isArray(items)) throw new Error('Unexpected SkyPilot listing; enter a cluster name manually');
    for (const item of items.slice(0, limit)) if (item && typeof item === 'object') {
      const data = item as {name?: string; status?: string};
      add(data.name, data.status);
    }
  } else if (provider === 'daytona') {
    const { Daytona } = await import('@daytona/sdk');
    const client = new Daytona({ ...(secrets.DAYTONA_API_KEY ? { apiKey: secrets.DAYTONA_API_KEY } : {}) });
    for await (const sandbox of client.list({ limit })) {
      add(sandbox.id, sandbox.state, sandbox.name);
      if (result.length >= limit) break;
    }
  } else if (provider === 'modal') {
    const { ModalClient } = await import('modal');
    const client = new ModalClient({ timeoutMs: 15000, maxRetries: 0, ...(secrets.MODAL_TOKEN_ID && secrets.MODAL_TOKEN_SECRET ? { tokenId: secrets.MODAL_TOKEN_ID, tokenSecret: secrets.MODAL_TOKEN_SECRET } : {}) });
    try {
      for await (const sandbox of client.sandboxes.list()) {
        add(sandbox.sandboxId, 'running');
        if (result.length >= limit) break;
      }
    } finally { client.close(); }
  } else if (provider === 'e2b') {
    const { Sandbox } = await import('e2b');
    const paginator = Sandbox.list({ limit, ...(secrets.E2B_API_KEY ? { apiKey: secrets.E2B_API_KEY } : {}) });
    const sandboxes = await paginator.nextItems();
    for (const sandbox of sandboxes.slice(0, limit)) add(sandbox.sandboxId, sandbox.state);
  }
  return result;
}
