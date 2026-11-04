import { StringDecoder } from 'node:string_decoder';
import { realpath } from 'node:fs/promises';
import { getJob, loadConfig, projectAuthorized, projectRoot } from './config.js';
import { inspectJob, runRemote } from './engine.js';
import { ruleRouter } from './router.js';
import type { Config, Job } from './types.js';

export interface RunParameters { command: string; timeout?: number; cpu?: number; memoryGiB?: number }
export type RunDetails = {
  status: string; exitCode: number | null; jobId: string | null; reason: string | null;
  stdout: string; stderr: string; outputTruncated: boolean; metrics?: Job['metrics'];
}
export type StatusDetails = {
  jobId: string; recordedStatus: string | null; recordedExitCode: number | null; recordedError: string | null;
  remoteConfirmed: boolean; remoteStatus: string | null; exitCode: number | null; error: string | null;
}
export interface ToolReport<T> { details: T; text: string; isError: boolean }
export interface ToolOptions { cwd: string; signal?: AbortSignal; boundary?: string }
export interface RunToolOptions extends ToolOptions {
  confirmProject?: (root: string, config: Config, signal?: AbortSignal) => Promise<boolean>;
  authorizationHelp?: string;
  onUpdate?: (report: ToolReport<RunDetails>) => void;
  onJob?: (job: Job) => void;
}
export const authorizationHelp = 'Project remote execution is not authorized. Nothing executed or uploaded. Open /reroute or run reroute authorize --yes after reviewing the canonical project, provider/account, source upload, trusted script execution and fees. No local retry is authorized.';

/** Shared tool boundary: a local routing decision refuses; it never executes locally. */
export async function runTool(params: RunParameters, options: RunToolOptions, execute = runRemote): Promise<ToolReport<RunDetails>> {
  const { signal, onUpdate } = options;
  let job: Job | undefined;
  let stdout = '', stderr = '', outputTruncated = false, lastUpdate = 0;
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  const append = (channel: 'stdout' | 'stderr', text: string) => {
    const value = (channel === 'stdout' ? stdout : stderr) + text;
    outputTruncated ||= value.length > 8192;
    if (channel === 'stdout') stdout = value.slice(-8192); else stderr = value.slice(-8192);
  };
  const result = (status: string, exitCode: number | null, reason?: string, isError = false): ToolReport<RunDetails> => {
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
    return { details, text, isError };
  };
  const progress = () => {
    if (onUpdate && Date.now() - lastUpdate >= 250) {
      lastUpdate = Date.now(); onUpdate(result(job?.status ?? 'preparing', null));
    }
  };
  try {
    signal?.throwIfAborted();
    if (typeof params.command !== 'string' || !params.command.trim()) throw new Error('Command must not be blank');
    if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > 86400))
      throw new Error('Task timeout must be in (0, 86400] seconds');
    if ([params.cpu, params.memoryGiB].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0))) throw new Error('CPU and memoryGiB overrides must be finite positive numbers');
    const { root, config } = await loadConfig(options.cwd, options.boundary);
    const decision = config ? await ruleRouter(params.command, options.cwd, config) : { route: 'local', reason: 'not-configured' };
    if (decision.route === 'local') return result('not_started', null,
      decision.reason + '. Nothing executed. This tool does not fall back locally. ' +
      (decision.reason === 'complex-or-ambiguous-shell'
        ? 'Submit one command without shell operators/expansion, or invoke a reviewed project script containing the sequence.'
        : 'Inspect project mode, command restrictions and configuration before retrying.'), true);
    if (!config || !await (options.confirmProject ?? projectAuthorized)(root, config, signal))
      return result('not_started', null, options.authorizationHelp ?? authorizationHelp, true);
    signal?.throwIfAborted();
    const remote = await execute(params.command, {
      root, config, cwd: options.cwd, signal,
      timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000,
      compute: params.cpu === undefined && params.memoryGiB === undefined ? undefined : {
        ...(params.cpu === undefined ? {} : { cpu: params.cpu }), ...(params.memoryGiB === undefined ? {} : { memoryGiB: params.memoryGiB }),
      },
      onJob: value => { job = value; options.onJob?.(value); progress(); },
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
    return result(job.status, remote.code, job.error, remote.code !== 0 || job.status !== 'exited' || !!job.error);
  } catch (error) {
    append('stdout', outDecoder.end()); append('stderr', errDecoder.end());
    return result(job?.status ?? (signal?.aborted ? 'cancelled' : 'failed'), job ? 125 : null,
      String(error) + '. Never retried locally.', true);
  }
}

/** Project identity is checked before revealing a record or contacting its Provider. */
export async function statusTool(jobId: string, options: ToolOptions, inspect = inspectJob): Promise<ToolReport<StatusDetails>> {
  const { signal } = options;
  let recorded: Job | undefined, confirmed: Job | undefined, error: string | null = null;
  const diagnostic = (value: unknown) => String(value).slice(-8192);
  try {
    signal?.throwIfAborted();
    const root = await realpath(await projectRoot(await realpath(options.cwd), options.boundary));
    let job: Job;
    try { job = await getJob(jobId); }
    catch (cause) {
      if (cause instanceof Error && ['Invalid job ID', 'Unknown job ID'].includes(cause.message)) throw cause;
      throw new Error('Could not read the local Job record');
    }
    if (!job || job.id !== jobId || await realpath(job.project).catch(() => null) !== root)
      throw new Error('Job does not belong to the current project');
    recorded = job;
    const querySignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const current = await inspect(jobId, 'status', { project: root, signal: querySignal, onConfirmed: value => { confirmed = value; } });
    if (current.error) error = diagnostic(current.error);
    else if (!confirmed) error = 'Remote task status could not be confirmed. Last recorded state shown.';
  } catch (cause) { error = diagnostic(cause); }
  const details = {
    jobId, recordedStatus: recorded?.status ?? null,
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
  return { details, text, isError: !!error || !confirmed };
}

/** Only measured values are printed: the model reads text, so a '?' costs context and teaches nothing. */
export function measured(job: Job): string {
  const m = job.metrics;
  if (!m) return 'Timing not measured';
  const first: string[] = [], rest: string[] = [];
  const time = (label: string, ms: number | undefined, bytes?: number) => {
    if (ms === undefined && bytes === undefined) return;
    first.push(label + ' ' + (ms === undefined ? '?' : ms) + ' ms' + (bytes === undefined ? '' : ' / ' + bytes + ' B'));
  };
  const detail = (label: string, ms: number | undefined, bytes?: number) => {
    if (ms === undefined && bytes === undefined) return;
    rest.push(label + ' ' + (ms === undefined ? '?' : ms) + ' ms' + (bytes === undefined ? '' : ' / ' + bytes + ' B'));
  };
  time('source', m.inputMs);
  time('transfer', m.transferMs, m.transferredBytes);
  time('execution', m.executionMs);
  time('provision', m.provisionMs);
  detail('pack', m.packMs, m.archiveBytes);
  detail('upload', m.uploadMs, m.uploadedBytes);
  if (m.remoteUnpackMs !== undefined || m.remoteVerifyMs !== undefined)
    rest.push('remote unpack/verify ' + (m.remoteUnpackMs ?? '?') + '/' + (m.remoteVerifyMs ?? '?') + ' ms');
  detail('cache restore', m.cacheRestoreMs, m.cacheRestoreBytes);
  detail('cache save', m.cacheSaveMs, m.cacheSaveBytes);
  if (m.cleanupMs !== undefined || m.releaseMs !== undefined)
    rest.push('cleanup/release ' + (m.cleanupMs ?? '?') + '/' + (m.releaseMs ?? '?') + ' ms');
  if (m.cacheHit !== undefined) rest.push('download cache: ' + (m.cacheHit ? 'archive restored' : 'archive not restored'));
  if (!first.length && !rest.length) return 'Timing not measured';
  return ['Measured: ' + first.join('; '), ...(rest.length ? ['  ' + rest.join('; ')] : [])].join('\n');
}
