import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { activeProfile, listJobs, stateDir, validate } from './config.js';
import { createProvider } from './providers/index.js';
import { atomicJson, hash, jsonFile, noSymlink } from './util.js';
import type { Compute, Config, Job, Profile, Provider } from './types.js';

export const presets: Record<string, Compute> = {
  small: { cpu: 1, memoryGiB: 2 }, medium: { cpu: 2, memoryGiB: 4 }, large: { cpu: 4, memoryGiB: 8 },
};
export function recommendCompute(command: string): { compute: Compute; reason: string } {
  return /\bcargo\b/.test(command)
    ? { compute: presets.large!, reason: 'Rust compilation benefits from parallel CPU and linker memory; suggestion only.' }
    : { compute: presets.medium!, reason: 'General build/test baseline; project defaults and explicit overrides take precedence.' };
}
export function cloudPlan(config: Config, command: string, override?: Partial<Compute>, timeoutMs?: number) {
  const profile = { ...activeProfile(config) };
  if (override) {
    if (!profile.managed) throw new Error('Per-task sizing requires managed Daytona/Modal compute; existing resources are never silently resized');
    profile.compute = { ...profile.compute!, ...override };
  }
  validate({ ...config, profiles: { ...config.profiles, [config.active]: profile } });
  const timeoutSeconds = timeoutMs === undefined ? config.timeoutSeconds : timeoutMs / 1000;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) throw new Error('Task timeout must be in (0, 86400] seconds');
  const policy = profile.managed;
  const hourlyUsd = policy && profile.compute ? profile.compute.cpu * policy.cpuHourUsd + profile.compute.memoryGiB * policy.memoryGiBHourUsd : 0;
  // Reserve preparation + maximum execution + idle fallback, without assuming any free credit.
  const guardMinutes = Math.ceil(timeoutSeconds / 60) + (policy?.idleMinutes ?? 0) + 5;
  const estimatedUsd = hourlyUsd * guardMinutes / 60 + (policy?.storageMonthUsd ?? 0);
  const suggestion = recommendCompute(command);
  const suggestedUsd = policy ? (suggestion.compute.cpu * policy.cpuHourUsd + suggestion.compute.memoryGiB * policy.memoryGiBHourUsd) * guardMinutes / 60 + policy.storageMonthUsd : undefined;
  const withinConfiguredLimits = !!policy && suggestion.compute.cpu <= policy.maxCpu && suggestion.compute.memoryGiB <= policy.maxMemoryGiB && suggestedUsd! <= policy.maxTaskUsd && suggestedUsd! <= policy.monthlyUsd;
  return { profile, timeoutSeconds, hourlyUsd, guardMinutes, estimatedUsd, balance: 'unavailable' as const,
    source: 'estimate' as const, recommendation: { ...suggestion, estimatedUsd: suggestedUsd, withinConfiguredLimits,
      note: 'Suggestion only; never overrides user/defaults. Provider quota and current monthly reservations are checked on execution, not confirmed by this offline plan.' } };
}
type ResourceRecord = { name: string; owner: string; profile: Profile; state: 'intent' | 'ready' | 'unknown' | 'destroyed'; observedAt: string };
interface Ledger { month: string; reservedUsd: number; resources: Record<string, ResourceRecord> }
const account = (profile: Profile) => hash(profile.provider + '\0' + (profile.credential ?? 'native-default')).slice(0, 32);
const directory = () => join(stateDir(), 'cloud');
const ledgerPath = (profile: Profile) => join(directory(), account(profile) + '.json');
const lockPath = (profile: Profile) => join(directory(), account(profile) + '.lock');
async function ownerFor(root: string, config: Config): Promise<string> {
  await noSymlink(directory()); await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = join(directory(), 'installation-id'); await noSymlink(path);
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(randomUUID()); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const installation = await readFile(path, 'utf8');
  if (!/^[0-9a-f-]{36}$/.test(installation)) throw new Error('Installation ownership is unconfirmed; inspect local cloud state');
  return hash(installation + '\0' + root + '\0' + config.active).slice(0, 32);
}
const active = (job: Job) => ['preparing', 'running', 'unknown'].includes(job.status);
const sameAccount = (a: Profile, b: Profile) => a.provider === b.provider && a.credential === b.credential;
const sameResource = (a: Profile, b: Profile) => a.provider === b.provider && a.id !== 'auto' && a.id === b.id;
async function ledger(profile: Profile): Promise<Ledger> {
  await noSymlink(ledgerPath(profile));
  const old = await jsonFile<Ledger>(ledgerPath(profile));
  const month = new Date().toISOString().slice(0, 7);
  return { month, reservedUsd: old?.month === month ? old.reservedUsd : 0, resources: old?.resources ?? {} };
}
async function exclusive<T>(profile: Profile, operation: () => Promise<T>): Promise<T> {
  await noSymlink(directory()); await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = lockPath(profile);
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Cloud account is busy or a previous process crashed. Use resource recover; never remove remote task locks blindly.');
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    return await operation();
  } finally { await file.close(); await unlink(path); }
}
/** Explicit recovery releases only a dead local client's lease; it does not clear unresolved jobs. */
async function releaseDeadLease(profile: Profile): Promise<void> {
  await noSymlink(directory()); await mkdir(directory(), { recursive: true, mode: 0o700 });
  const path = lockPath(profile); await noSymlink(path);
  // Serialize explicit recovery too, so two recoverers cannot unlink a replacement live lease.
  const recoveryPath = path + '.recovery';
  const recovery = await open(recoveryPath, 'wx', 0o600);
  try {
    const lease = await jsonFile<{ pid: number; host: string }>(path);
    if (!lease) return;
    if (lease.host !== hostname() || !Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error('Lease owner cannot be verified; inspect local state manually');
    try { process.kill(lease.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(path); return;
    }
    throw new Error('The lease owner process still exists; recovery cannot interrupt it');
  } finally { await recovery.close(); await unlink(recoveryPath); }
}
export async function recordedManagedProfile(root: string, config: Config): Promise<Profile | undefined> {
  const profile = activeProfile(config), owner = await ownerFor(root, config);
  const key = hash(owner + JSON.stringify(profile.compute) + profile.image).slice(0, 32);
  const record = (await ledger(profile)).resources[key];
  return record && record.state !== 'destroyed' && record.profile.id !== 'auto' ? record.profile : undefined;
}
export async function cloudSummary(profile: Profile) {
  const book = await ledger(profile);
  return { source: 'estimate', balance: 'unavailable', month: book.month, reservedUsd: book.reservedUsd,
    resources: Object.values(book.resources).map(r => ({ name: r.name, owner: r.owner, id: r.profile.id, state: r.state, compute: r.profile.compute, observedAt: r.observedAt })), notes: 'Local conservative reservations, not actual billing or credit. Retained storage may still cost money.' };
}
export async function withManagedResource<T extends { job: Job }>(root: string, config: Config, command: string,
  options: { compute?: Partial<Compute>; timeoutMs?: number; signal?: AbortSignal },
  run: (profile: Profile, provider: Provider) => Promise<T>, factory = createProvider): Promise<T> {
  const plan = cloudPlan(config, command, options.compute, options.timeoutMs), policy = plan.profile.managed;
  if (!policy?.authorized) throw new Error('Managed cloud creation/start is not authorized. Review rates, limits and unknown credit in /reroute or setup first.');
  if (plan.estimatedUsd > policy.maxTaskUsd) throw new Error(`Estimated reservation $${plan.estimatedUsd.toFixed(4)} exceeds the per-task limit; no resource created`);
  return exclusive(plan.profile, async () => {
    options.signal?.throwIfAborted();
    const book = await ledger(plan.profile), owner = await ownerFor(root, config);
    const key = hash(owner + JSON.stringify(plan.profile.compute) + plan.profile.image).slice(0, 32);
    let record = book.resources[key];
    const target = { ...plan.profile, id: record?.profile.id ?? plan.profile.id, owner };
    const blockers = (await listJobs()).filter(j => active(j) && (sameAccount(j.profile, plan.profile)
      || sameResource(j.profile, target) || (j.profile.provider === target.provider && j.profile.owner === owner)));
    if (blockers.length) throw new Error('Cloud account/resource has active/unresolved jobs: ' + blockers.map(j => j.id).join(', ') + '. Query status before new allocation or retry.');
    if (book.reservedUsd + plan.estimatedUsd > policy.monthlyUsd) throw new Error('Local monthly estimate budget would be exceeded; official remaining credit is unavailable');
    if (Object.entries(book.resources).some(([k, r]) => k !== key && ['intent', 'unknown'].includes(r.state))) throw new Error('An unresolved resource allocation blocks switching specs or projects; recover it before new spending');
    const fresh = !record || record.state === 'destroyed';
    if (fresh) record = { name: 'rr-' + key, owner, profile: plan.profile, state: 'intent', observedAt: new Date().toISOString() };
    const replaceStopped = record?.state === 'ready';
    book.resources[key] = record!;
    record!.state = 'intent';
    book.reservedUsd += plan.estimatedUsd;
    // A durable intent precedes *any* billable API, including Volume creation and starts.
    await atomicJson(ledgerPath(plan.profile), book);
    const provider = factory({ ...plan.profile, ...(fresh ? {} : { id: record!.profile.id }), owner });
    if (!provider.ensureManaged) throw new Error('Provider does not support managed compute');
    const start = performance.now();
    let cancelledAndStopped = false;
    try {
      const resolved = await provider.ensureManaged({ name: record!.name, owner, create: fresh, start: true, guardMinutes: plan.guardMinutes, replaceStopped });
      record!.profile = resolved; record!.state = 'ready'; record!.observedAt = new Date().toISOString();
      await atomicJson(ledgerPath(plan.profile), book);
      if ((await listJobs()).some(j => active(j) && sameResource(j.profile, resolved))) throw new Error('Resource has active/unresolved jobs; no task or cleanup started');
      // Only this pre-run window proves cancellation can stop compute without interrupting our task.
      if (options.signal?.aborted) {
        await provider.lifecycle('stop');
        record!.state = plan.profile.provider === 'modal' ? 'destroyed' : 'ready';
        cancelledAndStopped = true;
        options.signal.throwIfAborted();
      }
      const provisionMs = performance.now() - start;
      const result = await run(resolved, provider);
      if (result.job.metrics) result.job.metrics.provisionMs = provisionMs;
      result.job.cost = { estimatedUsd: plan.estimatedUsd, runtimeSeconds: (performance.now() - start) / 1000, source: 'estimate', balance: 'unavailable' };
      if (active(result.job)) record!.state = 'unknown';
      else {
        try { await provider.idle?.(policy.idleMinutes); if (plan.profile.provider === 'modal') record!.state = 'destroyed'; }
        catch { result.job.error = (result.job.error ? result.job.error + '. ' : '') + 'Idle policy update unconfirmed; original guarded provider timeout remains. Inspect resource.'; }
      }
      return result;
    } catch (error) {
      if (cancelledAndStopped) throw new Error('Managed allocation cancelled before task start; resource stopped. ' + String(error));
      record!.state = 'unknown';
      throw new Error('Managed allocation/execution unconfirmed. No creation retry performed. Use resource recover and task status. ' + String(error));
    } finally {
      await atomicJson(ledgerPath(plan.profile), book);
      await provider.close?.();
    }
  });
}
/** Only explicit lifecycle actions reach cloud APIs; opening the panel reads local receipts. */
export async function managedAction(root: string, config: Config, action: 'stop' | 'resume' | 'destroy' | 'recover', factory = createProvider): Promise<void> {
  const profile = activeProfile(config);
  if (action === 'recover') await releaseDeadLease(profile);
  await exclusive(profile, async () => {
    const book = await ledger(profile), owner = await ownerFor(root, config);
    const records = Object.values(book.resources).filter(r => r.owner === owner && r.state !== 'destroyed');
    if (!records.length) {
      if (action === 'stop' || action === 'destroy') return;
      throw new Error('No managed resources recorded for this profile; run an authorized task first');
    }
    if (action === 'resume') throw new Error('Managed resources start on the next authorized task after budget checks; no standalone unbounded paid resume');
    for (const record of records) {
      const provider = factory(record.profile);
      try {
        if (!provider.ensureManaged) throw new Error('Managed resource lookup unsupported');
        const resolved = await provider.ensureManaged({ name: record.name, owner, create: false, start: false, guardMinutes: 0 });
        record.profile = resolved;
        if (action !== 'recover') {
          if ((await listJobs()).some(j => sameResource(j.profile, resolved) && active(j))) throw new Error('Resource has active/unresolved jobs; status/cancel must confirm termination before lifecycle operations');
          await provider.lifecycle(action);
        }
        record.state = action === 'destroy' || (action === 'stop' && profile.provider === 'modal') ? 'destroyed' : 'ready'; record.observedAt = new Date().toISOString();
      } catch (error) { record.state = 'unknown'; throw error; }
      finally { await atomicJson(ledgerPath(profile), book); await provider.close?.(); }
    }
  });
}
