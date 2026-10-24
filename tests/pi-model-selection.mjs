// Opt-in, real-model acceptance: REROUTE_MODEL_ACCEPTANCE=1 node tests/pi-model-selection.mjs
// Local isolated process/file fixture ONLY; this is neither SSH nor cloud acceptance.
// Project-consent adaptation has not been re-run with a paid model; no general tool-selection stability claim.
import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const sdkPath = '/home/dotmint/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const aftPath = '/home/dotmint/.pi/agent/npm/node_modules/@cortexkit/aft-pi/dist/index.js';
const aftBinary = '/home/dotmint/.pi/agent/npm/node_modules/@cortexkit/aft-linux-x64/bin/aft';
const userAgentDir = '/home/dotmint/.pi/agent';
const cases = [
  { id: 'light', prompt: '请查看当前工作区的 git status 和 node --version，然后简要报告结果。' },
  { id: 'success', prompt: '请运行这个项目的完整 npm test 测试套件，全部成功后再运行 npm run build，并报告结果。' },
  { id: 'failure', prompt: '请运行这个项目的完整 npm test 测试套件，全部成功后再运行 npm run build，并报告结果。', fail: true },
];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => access(path).then(() => true, () => false);
const knownCommand = value => typeof value === 'string' && /^(?:git status(?: --[a-z-]+)*|node --version|npm test|npm run build)$/.test(value.trim()) ? value.trim() : undefined;
const safeStatus = value => ['not_started', 'preparing', 'running', 'exited', 'cancelled', 'timed_out', 'failed', 'unknown'].includes(value) ? value : null;

function isolate(root) {
  // Model auth stays inside the SDK's read-only credential store, never in child environments.
  for (const key of Object.keys(process.env)) {
    if (/^(?:AWS|AZURE|GOOGLE|GCLOUD|GCP|MODAL|DAYTONA|E2B|SSH|SKY|KUBE|DOCKER|REROUTE|AFT|PI|MAGIC_CONTEXT)_/i.test(key)
      || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH_SOCK)/i.test(key)) delete process.env[key];
  }
  const dirs = {
    HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime',
    PI_CODING_AGENT_DIR: 'agent', AFT_STORAGE_DIR: 'aft-storage', AFT_CACHE_DIR: 'aft-cache',
    REROUTE_STATE_DIR: 'reroute-state', TMPDIR: 'tmp',
  };
  for (const [key, value] of Object.entries(dirs)) process.env[key] = join(root, value);
  Object.assign(process.env, {
    AFT_TEST_ISOLATION_ROOT: root, AFT_BINARY_PATH: aftBinary, MAGIC_CONTEXT_PI_SUBAGENT: '1',
    PI_SKIP_VERSION_CHECK: '1', npm_config_userconfig: join(root, 'empty-npmrc'),
    npm_config_globalconfig: join(root, 'empty-global-npmrc'), npm_config_update_notifier: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig'),
    AWS_EC2_METADATA_DISABLED: 'true',
  });
  return Object.values(dirs).map(value => mkdir(join(root, value), { recursive: true }));
}

async function worker(spec, root) {
  const report = {
    id: spec.id, fixture: true, cloudVerified: false, outcome: 'blocked', phase: 'sdk-runtime',
    requests: 0, modelRequestSucceeded: false, turns: 0, calls: [], jobs: [],
    aft: { spawn: false, version: null, bashSpawned: false },
  };
  let session, timer;
  try {
    const sdk = await import(pathToFileURL(sdkPath).href);
    assert.equal(sdk.VERSION, '1.3.0');
    const { ReadOnlyAuthStorage } = await import(new URL('./core/auth-storage.js', pathToFileURL(sdkPath)));
    const { defaultProvider, defaultModel } = await json(join(userAgentDir, 'settings.json'));
    assert.equal(defaultProvider, 'openai');
    assert.equal(defaultModel, 'gpt-5.6-terra');
    report.model = { provider: defaultProvider, id: defaultModel };
    // Initialize before HOME/XDG isolation, using original read-only paths and a scratch catalog store.
    const authPath = join(userAgentDir, 'auth.json');
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath, credentials: new ReadOnlyAuthStorage(authPath), modelsPath: join(userAgentDir, 'models.json'),
      modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
    });
    const model = modelRuntime.getModel(defaultProvider, defaultModel);
    assert.ok(model, 'configured model unavailable; no fallback');
    await Promise.all(isolate(root));
    const cwd = join(root, 'src'), remote = join(root, 'tempremote');
    await mkdir(cwd);
    process.chdir(cwd);
    await mkdir(join(process.env.XDG_CONFIG_HOME, 'cortexkit'));
    await writeFile(join(process.env.XDG_CONFIG_HOME, 'cortexkit/aft.jsonc'), JSON.stringify({
      indexes: { trigram: false, semantic: false, callgraph: false }, lsp: { auto_install: false },
    }));
    const files = {
      'package.json': JSON.stringify({ name: 'local-isolated-selection-fixture', private: true, type: 'module', scripts: { test: 'node --test suite.mjs', build: 'node build.mjs' } }),
      'input.txt': 'indexed source\n',
      'fixture.json': JSON.stringify({ fail: !!spec.fail }),
      'suite.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
test('isolated snapshot test',()=>{
 writeFileSync('execution-test.json',JSON.stringify({cwd:process.cwd(),jobId:process.env.REROUTE_JOB_ID??null}));
 assert.equal(readFileSync('input.txt','utf8'),'dirty source\\n');
 assert.equal(JSON.parse(readFileSync('fixture.json','utf8')).fail,false,'intentional acceptance failure');
});\n`,
      'build.mjs': `import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(readFileSync('input.txt','utf8'),'dirty source\\n');
writeFileSync('execution-build.json',JSON.stringify({cwd:process.cwd(),jobId:process.env.REROUTE_JOB_ID??null}));
console.log('isolated build completed');\n`,
      '.gitignore': 'execution-*.json\n',
      '.reroute.json': JSON.stringify({
        version: 3, active: 'local-isolated-fixture', mode: 'auto', profiles: {
          'local-isolated-fixture': { provider: 'ssh', id: 'fixture-contract.invalid', root: remote },
        }, tasks: ['build', 'test', 'check', 'benchmark'], remote: [['npm', 'run', 'build']], local: [], timeoutSeconds: 15,
      }),
    };
    for (const [name, contents] of Object.entries(files)) await writeFile(join(cwd, name), contents);
    await promisify(execFile)('git', ['init', '-q', cwd]);
    await promisify(execFile)('git', ['-C', cwd, 'add', '.']);
    await writeFile(join(cwd, 'input.txt'), 'dirty source\n');
    const probe = { jobs: [], requests: 0, limit: false, extensionErrors: 0 };
    globalThis[Symbol.for('reroute.model-selection.probe')] = probe;
    const extension = join(root, 'fixture-extension.ts');
    // The SDK's official TS extension loader imports current production source (not potentially stale dist).
    await writeFile(extension, `
import {copyFile} from 'node:fs/promises';
import {registerPi,createRerouteTool,createRerouteStatusTool} from ${JSON.stringify(join(repo, 'src/pi.ts'))};
import {runRemote,inspectJob} from ${JSON.stringify(join(repo, 'src/engine.ts'))};
import {processExec} from ${JSON.stringify(join(repo, 'src/util.ts'))};
import {authorizeProject,loadConfig} from ${JSON.stringify(join(repo, 'src/config.ts'))};
export default async function(pi) {
 // Explicit test-only consent after both model-acceptance opt-in checks, in isolated local state.
 const configured=await loadConfig(${JSON.stringify(cwd)});
 await authorizeProject(configured.root,configured.config);
 const probe=globalThis[Symbol.for('reroute.model-selection.probe')];
 // Native local process/file Provider fixture: no SSH transport or cloud account capabilities.
 const provider={profile:{provider:'ssh',id:'fixture-contract.invalid',root:${JSON.stringify(remote)}},stdin:true,
  status:async()=> 'running',exec:(command,options)=>processExec('bash',['-c',command],options),
  put:copyFile,get:copyFile,lifecycle:async()=>{throw Error('local fixture forbids resource lifecycle')}};
 registerPi(pi);
 pi.registerTool(createRerouteTool(async(command,options)=>{
  const result=await runRemote(command,{...options,provider});probe.jobs.push(result.job);return result;
 }));
 pi.registerTool(createRerouteStatusTool((id,action,options)=>inspectJob(id,action,{...options,provider})));
 pi.on('before_provider_request',()=>{probe.requests++});
 pi.on('turn_end',event=>{if(event.turnIndex>=7){probe.limit=event.continue;return {continue:false}}});
}
`);
    report.phase = 'extension-load';
    const settingsManager = sdk.SettingsManager.inMemory({
      defaultProvider, defaultModel, compaction: { enabled: false }, cacheWarming: 'off',
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 60000 } },
      enableInstallTelemetry: false, enableAnalytics: false, defaultTools: ['+codemode'],
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [aftPath, extension], extensionFactories: [sdk.createCodemodeExtension({ mode: 'on' })],
    });
    await loader.reload();
    const result = await sdk.createAgentSession({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, modelRuntime,
      model, sessionManager: sdk.SessionManager.inMemory(cwd),
    });
    session = result.session;
    assert.deepEqual(result.extensionsResult.errors, []);
    await session.bindExtensions({ onError: () => { probe.extensionErrors++; } });
    const aft = result.extensionsResult.extensions.find(ext => ext.path === aftPath);
    assert.equal(session.getToolDefinition('bash'), aft.tools.get('bash').definition);
    for (const name of ['bash', 'reroute_run', 'reroute_status', 'codemode']) assert.ok(session.getActiveToolNames().includes(name));
    report.activeTools = session.getActiveToolNames();
    session.subscribe(event => {
      if (event.type === 'turn_start') report.turns++;
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message;
        report.actualModel = { provider: message.provider, id: message.model };
        if (!['error', 'aborted'].includes(message.stopReason)) report.modelRequestSucceeded = true;
        else {
          report.modelError = message.stopReason;
          const status = /\b(?:HTTP\s*)?([45]\d\d)\b/.exec(message.errorMessage ?? '');
          if (status) report.httpStatus = Number(status[1]);
        }
      }
      if (event.type === 'tool_execution_start') {
        const command = event.args?.command;
        report.calls.push({ event: 'start', name: event.toolName, id: event.toolCallId,
          parent: event.parentToolCallId ?? null,
          ...(typeof command === 'string' ? { command: knownCommand(command) ?? '[withheld]', commandSha256: sha(command) } : {}),
          ...(typeof event.args?.code === 'string' ? { codeSha256: sha(event.args.code) } : {}),
          ...(event.toolName === 'reroute_status' && /^[0-9a-f-]{36}$/.test(event.args?.jobId) ? { jobId: event.args.jobId } : {}),
        });
      }
      if (event.type === 'tool_execution_end') {
        const details = event.result?.structuredContent ?? event.result?.details ?? {};
        report.calls.push({ event: 'end', name: event.toolName, id: event.toolCallId,
          parent: event.parentToolCallId ?? null, isError: event.isError,
          status: safeStatus(details.status ?? details.remoteStatus),
          exitCode: Number.isInteger(details.exitCode ?? details.exit_code) ? details.exitCode ?? details.exit_code : null,
          ...(typeof details.remoteConfirmed === 'boolean' ? { remoteConfirmed: details.remoteConfirmed } : {}),
          ...(typeof details.jobId === 'string' && /^[0-9a-f-]{36}$/.test(details.jobId) ? { jobId: details.jobId } : {}),
        });
      }
    });
    report.phase = 'model';
    timer = setTimeout(() => { report.timeLimit = true; void session.abort(); }, 120000);
    await session.prompt(spec.prompt);
    clearTimeout(timer);
    report.requests = probe.requests;
    report.turnLimit = probe.limit;
    report.extensionErrors = probe.extensionErrors;
    report.phase = 'verification';
    for (const job of probe.jobs) {
      const jobDir = join(job.root, 'jobs', job.id);
      const receipt = await json(join(jobDir, 'receipt.json'));
      const command = knownCommand(job.command);
      const marker = command === 'npm test' ? 'execution-test.json' : 'execution-build.json';
      const execution = await json(join(jobDir, 'work', marker));
      const inputMatches = await readFile(join(jobDir, 'work/input.txt'), 'utf8') === 'dirty source\n';
      const request = await json(join(jobDir, 'request.json'));
      const sealedSnapshot = request.files.some(file => file.path === 'input.txt' && file.sha256 === sha('dirty source\n'));
      report.jobs.push({ id: job.id, command: command ?? '[withheld]', status: safeStatus(receipt.status),
        code: receipt.code, inputMatches, sealedSnapshot, receiptMatches: receipt.status === job.status && receipt.code === job.code,
        isolatedExecution: execution.jobId === job.id && execution.cwd.startsWith(remote + '/') && execution.cwd !== cwd,
      });
    }
    report.localExecution = await exists(join(cwd, 'execution-test.json')) || await exists(join(cwd, 'execution-build.json'));
    assert.equal(await readFile(join(cwd, 'input.txt'), 'utf8'), 'dirty source\n');
    if (report.modelError || report.timeLimit) {
      report.outcome = 'blocked';
      report.reason = report.timeLimit ? 'case-time-limit' : 'model-request-error';
    } else {
      verify(spec, report);
      report.outcome = 'passed';
      report.reason = 'natural-selection-and-receipts-verified';
    }
  } catch (error) {
    report.outcome = report.modelRequestSucceeded ? 'failed' : 'blocked';
    report.reason = error?.code === 'ERR_ASSERTION' ? 'acceptance-assertion' : 'sdk-or-fixture-unavailable';
    // Never serialize private provider errors, assistant prose, prompts, keys or original auth.
  } finally {
    clearTimeout(timer);
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown' }).catch(() => {});
      session.dispose();
    }
    const log = await readFile(join(root, 'aft-storage/logs/aft-plugin.log'), 'utf8').catch(() => '');
    report.aft = { spawn: log.includes(`Spawning binary: ${aftBinary}`),
      version: /Binary version:\s*v?(0\.61\.0)\b/.exec(log)?.[1] ?? null,
      bashSpawned: /bash spawned task=/.test(log), logSha256: sha(log) };
    if (report.outcome === 'passed' && (!report.aft.spawn || report.aft.version !== '0.61.0' || (spec.id === 'light' && !report.aft.bashSpawned))) {
      report.outcome = 'failed'; report.reason = 'real-aft-backend-evidence-missing';
    }
  }
  return report;
}

function verify(spec, report) {
  assert.ok(report.modelRequestSucceeded);
  assert.deepEqual(report.actualModel, report.model);
  assert.ok(report.turns <= 8 && report.requests <= 8 && !report.turnLimit);
  assert.equal(report.extensionErrors, 0);
  assert.equal(report.localExecution, false);
  const starts = report.calls.filter(call => call.event === 'start');
  const runs = starts.filter(call => call.name === 'reroute_run');
  const ends = report.calls.filter(call => call.event === 'end');
  if (spec.id === 'light') {
    assert.equal(runs.length, 0);
    for (const command of ['git status', 'node --version']) {
      const call = starts.find(call => call.name === 'bash' && call.command?.startsWith(command));
      assert.ok(call);
      assert.ok(ends.some(end => end.id === call.id && end.exitCode === 0 && !end.isError));
    }
    assert.equal(report.jobs.length, 0);
  } else {
    assert.deepEqual(runs.map(call => call.command), spec.fail ? ['npm test'] : ['npm test', 'npm run build']);
    assert.deepEqual(report.jobs.map(job => job.code), spec.fail ? [1] : [0, 0]);
    assert.ok(report.jobs.every(job => job.status === 'exited' && job.inputMatches && job.sealedSnapshot && job.receiptMatches && job.isolatedExecution));
    // Any heavy command on bash is a selection failure, including after a failed remote job.
    assert.ok(!starts.some(call => call.name === 'bash' && !/^(git status|node --version)/.test(call.command ?? '')));
    const firstEnd = report.calls.findIndex(call => call.event === 'end' && call.id === runs[0].id);
    assert.ok(firstEnd >= 0);
    if (spec.fail) {
      const status = starts.find(call => call.name === 'reroute_status' && call.jobId === report.jobs[0].id);
      assert.ok(status);
      assert.ok(report.calls.indexOf(status) > firstEnd);
      assert.ok(ends.some(call => call.id === status.id && call.remoteConfirmed && call.status === 'exited' && call.exitCode === 1 && !call.isError));
      assert.ok(!starts.some(call => call.command === 'npm run build'));
    } else {
      assert.ok(report.calls.indexOf(runs[1]) > firstEnd);
      assert.ok(ends.filter(call => runs.some(run => run.id === call.id)).every(call => !call.isError && call.exitCode === 0));
    }
  }
}

async function main() {
  if (process.env.REROUTE_MODEL_ACCEPTANCE !== '1') {
    console.log('Skipped: set REROUTE_MODEL_ACCEPTANCE=1 to permit real model requests.');
    return;
  }
  const report = { fixture: true, cloudVerified: false, sdkVersion: '1.3.0', aftVersion: '0.61.0',
    maxTurns: 8, caseTimeoutMs: 120000, cases: [] };
  for (const spec of cases) {
    if (report.cases.some(item => item.outcome === 'blocked')) {
      report.cases.push({ id: spec.id, outcome: 'blocked', reason: 'not-attempted-after-runtime-or-model-blocker', fixture: true, cloudVerified: false });
      continue;
    }
    const root = await mkdtemp(join(tmpdir(), 'reroute-model-selection-'));
    try {
      const result = await new Promise(resolve => {
        const child = fork(fileURLToPath(import.meta.url), ['--worker', spec.id, root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let received;
        const timeout = setTimeout(() => child.kill('SIGKILL'), 135000);
        child.on('message', message => { received = message; });
        child.on('error', () => {});
        child.on('exit', () => { clearTimeout(timeout); resolve(received ?? {
          id: spec.id, outcome: 'blocked', reason: 'worker-exit-or-hard-timeout', fixture: true, cloudVerified: false,
        }); });
      });
      report.cases.push(result);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  report.outcome = report.cases.some(item => item.outcome === 'failed') ? 'failed' : report.cases.some(item => item.outcome === 'blocked') ? 'blocked' : 'passed';
  const output = join(repo, '.artifacts/pi-workflow-selection.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.map(({ id, outcome, reason, requests, modelRequestSucceeded }) => ({ id, outcome, reason, requests, modelRequestSucceeded })), result: '.artifacts/pi-workflow-selection.json' }));
  if (report.outcome !== 'passed') process.exitCode = 1;
}

if (process.argv[2] === '--worker' && process.env.REROUTE_MODEL_ACCEPTANCE === '1') {
  const report = await worker(cases.find(spec => spec.id === process.argv[3]), process.argv[4]);
  process.send(report, () => process.exit(0));
} else await main();
