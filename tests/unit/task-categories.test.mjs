import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, merge, validateConfig } from '../../dist/config/config.js';
import { TASK_CATEGORIES, routingDecision, route } from '../../dist/core/routing.js';

const candidates = [
  ['build', ['cargo', 'build', '--release']],
  ['build', ['npm', 'run', 'build:production']],
  ['build', ['cmake', '--build', '.']],
  ['build', ['go', 'build', './...']],
  ['build', ['gcc', '-c', 'source.c']],
  ['build', ['make']],
  ['build', ['ninja']],
  ['test', ['cargo', 'test']],
  ['test', ['pnpm', 'test:unit']],
  ['test', ['pytest']],
  ['test', ['ctest']],
  ['test', ['go', 'test', './...']],
  ['test', ['deno', 'test']],
  ['check', ['cargo', 'check']],
  ['check', ['cargo', 'clippy']],
  ['check', ['npm', 'run', 'lint:ci']],
  ['check', ['ruff', 'check', '.']],
  ['check', ['mypy', 'source.py']],
  ['check', ['mvn', 'verify']],
  ['benchmark', ['cargo', 'bench']],
  ['benchmark', ['npm', 'run', 'bench:cpu']],
  ['benchmark', ['deno', 'bench']],
  ['benchmark', ['make', 'bench']]
];

for (const tasks of [undefined, [], ['build'], ['test'], ['check'], ['benchmark'], ['build', 'check'], [...TASK_CATEGORIES]]) {
  test(`task categories ${tasks === undefined ? 'omitted (all)' : JSON.stringify(tasks)} classify locally and deterministically`, () => {
    const routing = { mode: 'tasks', ...(tasks === undefined ? {} : { tasks }) };
    const config = validateConfig(merge(structuredClone(DEFAULT_CONFIG), { routing }));
    for (const [category, argv] of candidates) {
      const enabled = tasks === undefined || tasks.includes(category);
      const decision = routingDecision(argv, config.routing.commands, config.routing);
      assert.equal(decision.route, enabled ? 'remote' : 'local', argv.join(' '));
      assert.equal(decision.rule, enabled ? 'heavy-task-candidate' : 'task-category-disabled', argv.join(' '));
      assert.equal(route(argv, config.routing.commands, config.routing), decision.route);
    }
    assert.deepEqual(config.routing.tasks, tasks);
  });
}

test('category options reject malformed arrays and unknown names rather than silently routing them', () => {
  assert.deepEqual(TASK_CATEGORIES, ['build', 'test', 'check', 'benchmark']);
  for (const tasks of ['build', null, true, 1, {}, ['all'], ['none'], ['bench'], ['Build'], ['build', 'deploy'], ['test', 1], [[]]]) {
    assert.throws(() => validateConfig(merge(structuredClone(DEFAULT_CONFIG), { routing: { tasks } })), {
      code: 'CONFIG', message: /routing\.tasks/
    }, JSON.stringify(tasks));
  }
  assert.equal(DEFAULT_CONFIG.routing.tasks, undefined);
});

test('category selection never turns light or unknown commands into heavy tasks', () => {
  for (const argv of [
    ['node', '--version'], ['python3', '--version'], ['node', 'scripts/build.mjs'],
    ['python3', 'build.py'], ['cargo', 'fmt'], ['cargo', 'clean'], ['npm', 'install'],
    ['make', 'unknown-target'], ['unknown', 'build']
  ]) {
    for (const tasks of [[], [...TASK_CATEGORIES]]) assert.equal(route(argv, undefined, { mode: 'tasks', tasks }), 'local', argv.join(' '));
  }
});

test('exact remote prefixes can opt into disabled categories but local prefixes and shim eligibility still win', () => {
  const rules = {
    mode: 'tasks', tasks: [],
    remote: [['cargo', 'test'], ['node', 'scripts/build.mjs']],
    local: [['cargo', 'test', '-q']]
  };
  assert.equal(routingDecision(['cargo', 'test'], undefined, rules).rule, 'project-remote-rule');
  assert.equal(route(['cargo', 'test', '--release'], undefined, rules), 'remote');
  assert.equal(routingDecision(['cargo', 'test', '-q'], undefined, rules).rule, 'project-local-rule');
  assert.equal(route(['cargo', 'build'], undefined, rules), 'local');
  assert.equal(route(['node', 'scripts/build.mjs'], undefined, rules), 'remote');
  assert.equal(route(['node', 'scripts/build.mjs-other'], undefined, rules), 'local');
  assert.equal(routingDecision(['node', 'scripts/build.mjs'], ['cargo'], rules).rule, 'not-configured-runtime-command');
  assert.equal(route(['node', '--version'], undefined, { ...rules, remote: [['node']] }), 'local');
});

test('explicit argv execution overrides category and local-prefix policy but never control, identity or ambiguous commands', () => {
  const rules = { mode: 'tasks', tasks: [], local: [['cargo']], remote: [['cargo']] };
  assert.equal(routingDecision(['cargo', 'test'], [], rules, true).rule, 'explicit-remote');
  assert.equal(route(['python3', 'build.py'], [], rules, true), 'remote');
  assert.equal(route(['unknown', 'build'], [], rules, true), 'remote');
  for (const [argv, rule] of [
    [['git', 'status'], 'control-command'],
    [['ssh', 'host'], 'control-command'],
    [['daytona', 'create'], 'control-command'],
    [['bash', '-c', 'cargo test'], 'control-command'],
    [['env', 'cargo', 'test'], 'control-command'],
    [['npm', 'publish'], 'identity-subcommand'],
    [['pnpm', 'run', 'build:deploy'], 'identity-subcommand'],
    [['cargo', 'login'], 'identity-subcommand'],
    [['npm', 'config', 'set'], 'identity-subcommand'],
    [['cargo', 'test', '&&', 'git', 'status'], 'ambiguous-command']
  ]) {
    for (const explicit of [false, true]) {
      const decision = routingDecision(argv, [argv[0]], { mode: 'tasks', tasks: [], remote: [[argv[0]]] }, explicit);
      assert.equal(decision.route, 'local', argv.join(' '));
      assert.equal(decision.rule, rule, argv.join(' '));
    }
  }
});
