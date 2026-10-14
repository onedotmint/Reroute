import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = fileURLToPath(import.meta.url);
const adapter = fileURLToPath(new URL('../adapters/pi.ts', import.meta.url));
const sdkPath = process.env.REROUTE_PI_SDK_PATH ?? fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const installedAft = process.env.REROUTE_AFT_EXTENSION;

async function coexistence(order, aftPath) {
  const root = await mkdtemp(join(tmpdir(), 'reroute-pi-coexistence-'));
  let session;
  try {
    // Fresh subprocess per order: neither extension may write to the real user config/cache.
    for (const [key, dir] of Object.entries({
      HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local',
      XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state',
      XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime', PI_CODING_AGENT_DIR: 'agent',
      AFT_STORAGE_DIR: 'aft-storage', AFT_CACHE_DIR: 'aft-cache', REROUTE_STATE_DIR: 'reroute-state',
    })) {
      process.env[key] = join(root, dir);
      await mkdir(process.env[key], { recursive: true });
    }
    process.env.AFT_TEST_ISOLATION_ROOT = root;
    process.env.MAGIC_CONTEXT_PI_SUBAGENT = '1';
    delete process.env.AFT_ALLOW_PRODUCTION_MIGRATION;
    const cwd = join(root, 'workspace');
    await mkdir(cwd);
    process.chdir(cwd);
    await mkdir(join(process.env.XDG_CONFIG_HOME, 'cortexkit'));
    await writeFile(join(process.env.XDG_CONFIG_HOME, 'cortexkit/aft.jsonc'), JSON.stringify({
      indexes: { trigram: false, semantic: false, callgraph: false }, lsp: { auto_install: false },
    }));
    // This command would route remotely if Reroute were still intercepting bash.
    await writeFile(join(cwd, '.reroute.json'), JSON.stringify({
      version: 3, active: 'offline', mode: 'auto', profiles: {
        offline: { provider: 'ssh', id: 'reroute-must-not-contact.invalid' },
      }, tasks: ['build', 'test', 'check', 'benchmark'], remote: [['printf']], local: [], timeoutSeconds: 1,
    }));
    globalThis.fetch = async () => { throw new Error('Network fetch prohibited in coexistence test'); };
    const sdk = await import(pathToFileURL(sdkPath).href);
    const fixture = join(root, 'bash-fixture.mjs');
    if (!aftPath) await writeFile(fixture, `
      import { createBashToolDefinition } from ${JSON.stringify(pathToFileURL(sdkPath).href)};
      export default pi => pi.registerTool(createBashToolDefinition(process.cwd()));
    `);
    const bashExtension = aftPath || fixture;
    const paths = order === 'bash-first' ? [bashExtension, adapter] : [adapter, bashExtension];
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' });
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: paths,
    });
    await loader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(root, 'agent/auth.json'), modelsPath: null, modelsStorePath: join(root, 'agent/models-store.json'),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    let modelCalls = 0;
    for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple', 'classify', 'generateImages']) {
      modelRuntime[method] = () => { modelCalls++; throw new Error('Model calls prohibited'); };
    }
    const result = await sdk.createAgentSession({
      cwd, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, settingsManager, modelRuntime,
      model: modelRuntime.getModels()[0], sessionManager: sdk.SessionManager.inMemory(cwd),
    });
    session = result.session;
    const errors = [];
    await session.bindExtensions({ onError: error => errors.push(error) });
    assert.deepEqual(result.extensionsResult.errors, []);
    assert.deepEqual(result.extensionsResult.extensions.map(ext => ext.path), paths);
    const reroute = result.extensionsResult.extensions.find(ext => ext.path === adapter);
    const shell = result.extensionsResult.extensions.find(ext => ext.path === bashExtension);
    assert.deepEqual([...reroute.tools.keys()], ['reroute_run']);
    assert.equal(reroute.handlers.has('user_bash'), false);
    assert.equal(reroute.handlers.has('tool_call'), false);
    if (!aftPath) assert.deepEqual([...shell.tools.keys()], ['bash']);
    assert.equal(session.getToolDefinition('bash'), shell.tools.get('bash').definition);
    assert.equal(session.getToolDefinition('reroute_run'), reroute.tools.get('reroute_run').definition);
    assert.equal(session.getToolDefinition('reroute_run').exposure, 'direct');
    assert.equal(session.getToolDefinition('reroute_run').defaultActive, true);
    // No explicit tool allowlist or activation: verify the actual default session loadout.
    assert.ok(session.getActiveToolNames().includes('bash'));
    assert.ok(session.getActiveToolNames().includes('reroute_run'));
    assert.ok(session.getCallableToolNames().includes('bash'));
    assert.ok(session.getCallableToolNames().includes('reroute_run'));
    // Nested calls require a caller in the canonical transcript; this synthetic message makes no model request.
    session.sessionManager.appendMessage({
      role: 'assistant', content: [], api: session.model.api, provider: session.model.provider, model: session.model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    session.refreshContext();
    const events = [];
    session.subscribe(event => { if (event.type === 'tool_execution_end') events.push(event); });
    const ctx = session.extensionRunner.createToolContext('coexistence-probe', new AbortController().signal);
    const outcome = await ctx.executeTool('bash', {
      command: "printf 'REROUTE_COEXISTENCE_OK'", ...(aftPath ? { workdir: cwd, wait: true, compressed: false, timeout: 5000 } : {}),
    });
    assert.equal(outcome.isError, false);
    assert.match(outcome.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), /REROUTE_COEXISTENCE_OK/);
    assert.ok(events.some(event => event.toolName === 'bash' && event.parentToolCallId === 'coexistence-probe'));
    const refused = await ctx.executeTool('reroute_run', { command: 'git status' });
    assert.equal(refused.isError, true);
    assert.equal(refused.result.structuredContent.status, 'not_started');
    assert.match(refused.result.structuredContent.reason, /Nothing executed/);
    if (aftPath) assert.equal(outcome.result.details.exit_code, 0);
    assert.deepEqual(errors, []);
    assert.equal(modelCalls, 0);
    const report = { order, actualAft: !!aftPath, active: session.getActiveToolNames(), modelCalls };
    await session.extensionRunner.emit({ type: 'session_shutdown' });
    session.dispose();
    session = undefined;
    if (aftPath) {
      const log = await readFile(join(process.env.AFT_STORAGE_DIR, 'logs/aft-plugin.log'), 'utf8');
      assert.match(log, /Spawning binary:/); // Read after shutdown flush: prove the real bridge ran, not its host fallback.
      assert.match(log, /Binary version:/);
      assert.match(log, /bash spawned task=/);
    }
    console.log(JSON.stringify(report));
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown' });
      session.dispose();
    }
    process.chdir(tmpdir());
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--coexistence-worker') {
  await coexistence(process.argv[3], process.argv[4] || undefined);
} else {
  for (const order of ['bash-first', 'reroute-first']) {
    for (const actual of [false, true]) {
      test(`real Pi session: ${actual ? 'installed AFT' : 'bash-only fixture'} + Reroute (${order})`, {
        skip: actual && !installedAft ? 'Set REROUTE_AFT_EXTENSION to the installed AFT entry file' : false,
      }, async () => {
        const { stdout } = await promisify(execFile)(process.execPath,
          [file, '--coexistence-worker', order, actual ? resolve(installedAft) : ''], { timeout: 120000 });
        assert.match(stdout, /"modelCalls":0/);
      });
    }
  }
}
