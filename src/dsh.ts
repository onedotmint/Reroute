import type { Context } from '@deepseek-ai/cordis';
import { defineTool, TOOL_ABORTED, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-plan-mode';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { activeProfile, loadConfig, projectAuthorized, projectRoot } from './config.js';
import { runRemote, inspectJob } from './engine.js';
import { runTool, statusTool } from './tools.js';
import { inside } from './util.js';

export const name = 'reroute';
export const inject = ['tools', 'fs', 'workingDirectory', 'sandboxPolicy', 'approval', 'systemPrompt'];
const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] } as const;
const runOutput = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', required: true }, exitCode: { ...nullableNumber, required: true },
    jobId: { ...nullableString, required: true }, reason: { ...nullableString, required: true },
    stdout: { type: 'string', required: true }, stderr: { type: 'string', required: true },
    outputTruncated: { type: 'boolean', required: true }, metrics: { type: 'json' },
  },
} as const;
const statusOutput = {
  type: 'object', additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true }, recordedStatus: { ...nullableString, required: true },
    recordedExitCode: { ...nullableNumber, required: true }, recordedError: { ...nullableString, required: true },
    remoteConfirmed: { type: 'boolean', required: true }, remoteStatus: { ...nullableString, required: true },
    exitCode: { ...nullableNumber, required: true }, error: { ...nullableString, required: true },
  },
} as const;

export function apply(ctx: Context): void { registerHarness(ctx); }

/** Executor injection is for component tests, never a configured production fallback. */
export function registerHarness(ctx: Context, execute = runRemote, inspect = inspectJob): void {
  const lifecycle = new AbortController(), active = new Set<Promise<unknown>>();
  const running = new WeakSet<object>();
  // shortcut: implicit recovery is live-session-only; use an explicit Job ID after reload/restart.
  const recent = new WeakMap<object, { root: string; jobId: string }>();
  const calls = new WeakMap<ToolExecutionToken, string>();
  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Reroute plugin unloaded; remote termination must be verified'));
    await Promise.allSettled(active);
  });
  async function owned<T>(exec: ToolRunContext, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([exec.signal, lifecycle.signal]);
    signal.throwIfAborted();
    const pending = run(signal);
    active.add(pending);
    try { return await pending; } finally { active.delete(pending); }
  }
  async function workspace(exec: ToolRunContext, signal: AbortSignal, forRun = false) {
    signal.throwIfAborted();
    const agent = exec.agent;
    if (!agent) throw new Error('Reroute requires a calling Agent Session; nothing executed');
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    // Node snapshots cannot read an SSH execution world, even if the same path exists locally.
    const current = ctx.workingDirectory.get(agent.session);
    if (ctx.fs.processPathFromHostPath(current) !== current || ctx.fs.processPathFromHostPath(policy.workspaceRoot) !== policy.workspaceRoot)
      throw new Error('Reroute supports host-local project files only; execution-world mapping unavailable. Nothing executed.');
    const ensured = await ctx.workingDirectory.ensure(agent, signal);
    const cwd = await realpath(ensured), boundary = await realpath(policy.workspaceRoot);
    if (!inside(boundary, cwd)) throw new Error('Current directory is outside the original workspace; nothing executed');
    if (forRun) {
      const plan = ctx.get('planMode')?.get(agent);
      if (policy.mode === 'read-only' || plan?.active || plan?.pending === true)
        throw new Error('Reroute execution is disabled in read-only or plan mode; nothing executed');
    }
    signal.throwIfAborted();
    return { agent, cwd, boundary };
  }
  ctx.systemPrompt.section({
    name: 'tool:reroute', order: 1650,
    text: 'Prefer reroute_run for full builds/test suites and heavy compute; keep quick checks, Git and file operations with the local tools. ' +
      'Reroute uploads the verified project, trusts project scripts and may incur compute/storage fees; project CLI authorization, per-call approval and managed budgets are separate requirements. ' +
      'Submit one independent command, without shell operators. A refusal executes nothing and does not authorize local retry. ' +
      'Check status and exitCode, not just tool-call success. After failure/unknown use reroute_status; never retry locally without user authorization. ' +
      'If cancellation hides the Job ID, call reroute_status({}) to recover this live Session\'s latest run. After plugin reload/restart supply an explicit Job ID from reroute jobs. ' +
      'Only remoteConfirmed=true confirms a fresh remote task receipt; status may update the local receipt but never starts or resumes compute.',
  });
  ctx.tools.register(defineTool({
    name: 'reroute_run',
    description: 'Run one heavy build/test/compute command remotely. Quick checks belong in local tools. Requires existing Reroute CLI project authorization and one-time Harness approval; read-only/plan mode refuses. No shell operators, Bash interception, local fallback or automatic retries. Return status/exitCode/Job ID, bounded output and measured metrics; nonzero/unknown are domain results, not successful computation.',
    parameters: {
      command: { type: 'string', required: true, description: 'One eligible compute command in the current project.' },
      timeout: { type: 'number', description: 'Positive timeout in seconds, at most 86400; omitted uses project configuration.' },
      cpu: { type: 'number', description: 'Positive per-task managed CPU override within budget; Modal uses physical cores.' },
      memoryGiB: { type: 'number', description: 'Positive per-task managed memory override within budget.' },
    },
    output: {
      schema: runOutput,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error('Reroute requires a calling Agent Session; nothing executed');
      if (running.has(session)) throw new Error('Another Reroute run is active in this Session; query its status instead. Nothing executed.');
      running.add(session);
      try {
        return await owned(exec, async signal => {
          const scope = await workspace(exec, signal, true);
          const report = await runTool(args, {
            cwd: scope.cwd, boundary: scope.boundary, signal,
            authorizationHelp: 'Project authorization or per-call approval is missing. Nothing executed or uploaded. Review the project/account/source/scripts/fees and authorize manually with reroute authorize --yes; Harness approval must also grant allowed-once. No local retry is authorized.',
            confirmProject: async (root, config) => {
              if (!await projectAuthorized(root, config)) return false;
              const profile = activeProfile(config);
              const outcome = await ctx.approval.request({
                agent: scope.agent, callId: exec.callId, toolName: 'reroute_run', signal,
                reason: `Upload canonical project ${root} and execute trusted project scripts on ${profile.provider}/${profile.credential ?? 'native default'} (${profile.id}). Compute and retained storage may incur fees; balance is unknown. Managed budgets still apply. Approve only this invocation?`,
              });
              signal.throwIfAborted();
              if (outcome !== 'allowed-once') return false;
              const current = await workspace(exec, signal, true);
              if (current.cwd !== scope.cwd || current.boundary !== scope.boundary)
                throw new Error('Workspace changed during approval; nothing executed');
              const latest = await loadConfig(current.cwd, scope.boundary);
              if (latest.root !== root || !isDeepStrictEqual(latest.config, config))
                throw new Error('Project root or configuration changed during approval; nothing executed. Submit again for fresh approval.');
              const authorized = await projectAuthorized(latest.root, config);
              // The SDK checks policy before waiting for the answerer, not after it.
              const policy = ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? 'ask';
              return authorized && policy === 'ask';
            },
            onJob: job => {
              recent.set(session, { root: job.project, jobId: job.id });
              calls.set(exec.token, job.id);
            },
          }, execute);
          return report.details;
        });
      } finally { running.delete(session); }
    },
    finalizeContent(exec, result) {
      const jobId = calls.get(exec.token);
      calls.delete(exec.token);
      if (!jobId || !result.isError || result.error.info?.code !== TOOL_ABORTED) return undefined;
      return [...result.content, { type: 'text', text: `Reroute Job ID: ${jobId}. Cancellation does not prove remote termination. Query reroute_status with this ID, or omit jobId in this live Session. Never rerun locally without user authorization.` }];
    },
  }));
  ctx.tools.register(defineTool({
    name: 'reroute_status',
    description: 'Query this project\'s Reroute Job without running/resuming resources. Explicit jobId survives restarts; omit it to recover only this live Session\'s latest run after cancellation. Separates recorded history from remoteConfirmed; may update a private local receipt. No cross-project queries or automatic retries.',
    parameters: { jobId: { type: 'string', description: 'Job ID; omit only to recover this live Session\'s latest Reroute run.' } },
    output: {
      schema: statusOutput,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return owned(exec, async signal => {
        const scope = await workspace(exec, signal);
        let jobId = args.jobId;
        if (jobId === undefined) {
          const saved = recent.get(scope.agent.session);
          if (!saved || await realpath(saved.root).catch(() => null) !== await projectRoot(scope.cwd, scope.boundary))
            throw new Error('No recoverable Reroute Job in this live Session and project. Supply an explicit Job ID from reroute jobs.');
          jobId = saved.jobId;
        }
        return (await statusTool(jobId, { cwd: scope.cwd, boundary: scope.boundary, signal }, inspect)).details;
      });
    },
  }));
}
