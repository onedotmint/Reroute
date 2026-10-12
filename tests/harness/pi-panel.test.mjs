import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectScreen, routingScreen, openPanel } from '../../adapters/pi-panel.mjs';

const theme = { fg: (_color, value) => value, bold: value => value };
const keys = { matches: (data, action) => ({ 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' })[action] === data };
let tuiApi, sdk;
for (const folder of (process.env.PATH ?? '').split(delimiter)) {
  try {
    const path = await fs.realpath(join(folder, 'pi'));
    const require = createRequire(path);
    const nativeTui = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
    for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
      try {
        const manifest = JSON.parse(await fs.readFile(join(dir, 'package.json'), 'utf8'));
        if (manifest.name === '@earendil-works/pi-coding-agent') {
          sdk = await import(pathToFileURL(join(dir, manifest.main)).href);
          sdk.initTheme('dark', false);
          tuiApi = nativeTui;
          break;
        }
      } catch { /* Not the host package directory. */ }
    }
    if (tuiApi) break;
  } catch { /* Host is optional in CI, never install a second Pi runtime. */ }
}
function drive(input, inspect = () => {}) {
  return { ui: { custom: factory => new Promise(resolve => {
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keys, resolve);
    inspect(component);
    for (const key of input) component.handleInput(key);
  }) } };
}
test('native Pi SelectList navigates, preselects, cancels and renders narrow/resized widths', { skip: !tuiApi }, async () => {
  const items = [{ value: 'a', label: 'SSH selected', description: '远端运行时身份 retained' }, { value: 'b', label: 'Daytona' }];
  const ctx = drive(['\x1b[B', '\r'], component => {
    for (const width of [12, 20, 80, 16]) {
      component.invalidate();
      assert.ok(component.render(width).every(line => tuiApi.visibleWidth(line) <= width));
    }
  });
  assert.equal(await selectScreen(ctx, tuiApi, 'Reroute', ['Project: 一个很长的项目名称'], items, 'a'), 'b');
  assert.equal(await selectScreen(drive(['\x1b']), tuiApi, 'Reroute', [], items), undefined);
  assert.equal(await selectScreen(drive(['\r']), tuiApi, 'Reroute', [], items, 'b'), 'b');
});
test('native Pi SettingsList Space toggles draft; Enter reviews; Esc discards', { skip: !tuiApi }, async () => {
  const original = ['test'];
  assert.deepEqual(await routingScreen(drive([' ', '\r']), sdk, tuiApi, original), ['build', 'test']);
  assert.equal(await routingScreen(drive([' ', '\x1b']), sdk, tuiApi, original), undefined);
  assert.deepEqual(original, ['test']);
});
function scripted(selections, ops) {
  const ctx = { cwd: '/project', mode: 'tui', ui: {
    notify: value => ops.notifications.push(value), input: async () => 'existing-host',
    custom: factory => new Promise(resolve => {
      const result = selections.shift();
      const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, keys, resolve);
      // Reuse native selection via key presses rather than inspecting private list state.
      const [down, key] = result ?? [0, '\x1b'];
      for (let i = 0; i < down; i++) component.handleInput('\x1b[B');
      component.handleInput(key);
    })
  } };
  return ctx;
}
function operations(state = {}) {
  const calls = [], notifications = [];
  return {
    calls, notifications,
    localStatus: async () => ({ project: { name: 'project' }, provider: 'ssh', status: 'unknown', stateSource: 'recorded; unverified', routing: 'tasks', coordinator: 'not running', ...state }),
    authStatus: async () => ({ ssh: 'OpenSSH available (not verified)' }),
    projectSettings: async () => ({ state, config: { provider: 'ssh', providers: { ssh: { host: 'existing-host' } }, routing: { mode: 'tasks' } } }),
    projectConfiguration: async (_cwd, choices) => ({ config: { provider: choices.provider ?? 'ssh', routing: { mode: 'tasks' } } }),
    enableProject: async () => calls.push('enable'),
    runtimeStatus: async () => { calls.push('query'); return { status: 'running', stateSource: 'live provider query' }; },
    manageRuntime: async (_cwd, action) => calls.push(action),
    doctor: async () => { calls.push('doctor'); return { checks: [] }; }
  };
}
test('Pi opening/refresh/reopening never queries or creates resources', { skip: !tuiApi }, async () => {
  const ops = operations();
  await openPanel(scripted([[0, '\r'], [0, '\x1b']], ops), sdk, tuiApi, ops);
  await openPanel(scripted([[0, '\x1b']], ops), sdk, tuiApi, ops);
  assert.deepEqual(ops.calls, []);
});
test('Pi provider selection and runtime cancellation never mutate config/resource; original runtime blocks switching', { skip: !tuiApi }, async () => {
  const ops = operations({ provider: 'ssh', runtime: { id: 'original' }, syncPending: true });
  await openPanel(scripted([[1, '\r'], [4, '\r'], [0, '\x1b']], ops), sdk, tuiApi, ops);
  assert.deepEqual(ops.calls, []);
  assert.match(ops.notifications[0], /Original runtime\/pending source retained/);
  const cancelled = operations();
  await openPanel(scripted([[4, '\r'], [1, '\r'], [0, '\x1b'], [0, '\x1b']], cancelled), sdk, tuiApi, cancelled);
  assert.deepEqual(cancelled.calls, []);
});
test('Pi start executes only after explicit confirmation', { skip: !tuiApi }, async () => {
  const ops = operations();
  await openPanel(scripted([[4, '\r'], [1, '\r'], [1, '\r'], [0, '\x1b']], ops), sdk, tuiApi, ops);
  assert.deepEqual(ops.calls, ['start']);
});

test('Pi configured SSH host is kept when accepting the current default', { skip: !tuiApi }, async () => {
  const ops = operations({ provider: 'ssh' });
  let choices;
  ops.projectConfiguration = async (_cwd, selected) => { choices = selected; return { config: { provider: 'ssh', routing: { mode: 'tasks' } } }; };
  const ctx = scripted([[1, '\r'], [0, '\r'], [0, '\x1b'], [0, '\x1b']], ops);
  ctx.ui.input = async () => '';
  await openPanel(ctx, sdk, tuiApi, ops);
  assert.equal(choices.host, 'existing-host');
  assert.deepEqual(ops.calls, []);
});
