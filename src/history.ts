import type { Job, Profile } from './types.js';
import { category, words } from './router.js';

export const HISTORY_PREFIX = 'Reroute history: ';
/** Observations only: remote elapsed time cannot establish local/cloud speedup. */
export function projectExecutionHints(root: string, profile: Profile, jobs: Job[], now = Date.now()): string[] {
  const groups = new Map<string, Job[]>(), seen = new Set<string>();
  for (const job of [...jobs].sort((a, b) => String(b?.createdAt).localeCompare(String(a?.createdAt)))) {
    if (!job || job.project !== root || typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/.test(job.id) || seen.has(job.id)) continue;
    const p = job.profile, elapsed = job.metrics?.executionMs, date = Date.parse(job.createdAt);
    if (!p || p.provider !== profile.provider || p.credential !== profile.credential || p.image !== profile.image
      || p.compute?.cpu !== profile.compute?.cpu || p.compute?.memoryGiB !== profile.compute?.memoryGiB
      || (profile.managed ? !p.managed : !!p.managed || p.id !== profile.id)) continue;
    if (job.status !== 'exited' || !Number.isInteger(job.code) || job.code! < 0 || job.code! > 255 || job.error !== undefined
      || typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 86410000
      || !Number.isFinite(date) || date > now || now - date > 30 * 86400000
      || typeof job.command !== 'string' || job.command.length > 4096) continue;
    const args = words(job.command), kind = args && category(args);
    if (!kind) continue;
    seen.add(job.id);
    const samples = groups.get(kind) ?? [];
    if (samples.length < 5) samples.push(job);
    groups.set(kind, samples);
  }
  const duration = (ms: number) => ms < 1000 ? '<1s' : Math.round(ms / 1000) + 's';
  // One confirmed run is already evidence: requiring two threw away the cold-start signal the agent needs most.
  return [...groups].filter(([, samples]) => samples.length >= 1).slice(0, 3).map(([kind, samples]) => {
    const times = samples.map(j => j.metrics!.executionMs!);
    const low = duration(Math.min(...times)), high = duration(Math.max(...times));
    const failures = samples.filter(j => j.code !== 0).length;
    const caches = samples.filter(j => j.cacheWarning === undefined && typeof j.metrics?.cacheHit === 'boolean');
    const cache = caches.length ? `; download archive restored ${caches.filter(j => j.metrics!.cacheHit).length}/${caches.length}` : '';
    const runs = samples.length === 1 ? '1 confirmed remote run' : samples.length + ' confirmed remote runs';
    // An all-failure group must not read like a usable path. Route state is stated first, not buried after 'confirmed'.
    const outcome = failures === samples.length
      ? `; ALL ${failures} FAILED (nonzero exit): treat the remote path as unproven, not as working`
      : failures ? `; ${failures} of ${samples.length} exited nonzero` : '; all exited 0';
    // Never put raw commands, paths, errors or output from receipts into model instructions.
    return `${HISTORY_PREFIX}${kind}/${profile.provider}: ${runs}, ${low === high ? low : low + '–' + high}${outcome}${cache}. Context only, not a local-speed comparison.`;
  });
}
