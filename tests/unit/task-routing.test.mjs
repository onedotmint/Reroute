import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { routingDecision, route } from '../../dist/core/routing.js';
import { loadConfig, DEFAULT_CONFIG, merge, validateConfig } from '../../dist/config/config.js';
import { fixture } from '../helpers.mjs';

for (const argv of [
  ['node','--version'], ['python','--version'], ['node','-e','42'], ['python3','script.py'],
  ['cargo','fmt'], ['cargo','clean'], ['cargo','install','tool'], ['npm','install'],
  ['make','deploy'], ['make','install'], ['make','clean'], ['make','unknown-target'],
  ['npm','run','dev'], ['npm','run','build:deploy'], ['pnpm','exec','npm','publish'],
  ['uv','run','python','script.py'], ['npx','unknown'], ['unknown','build'],
  ['bash','-c','cargo test && git status'], ['env','CI=1','cargo','test'],
  ['cargo','test','&&','git','status'], ['rm','-rf','.'], ['npm','run','release']
]) test('conservative local task: '+argv.join(' '), () => assert.equal(route(argv), 'local'));
for (const argv of [
  ['cargo','build','--release'], ['cargo','test'], ['npm','run','build'], ['pnpm','test:unit'],
  ['pytest'], ['cmake','--build','.'], ['go','test','./...'], ['ninja'], ['mvn','verify']
]) test('heavy candidate: '+argv.join(' '), () => {
  assert.equal(route(argv), 'remote'); assert.equal(routingDecision(argv).rule, 'heavy-task-candidate');
});
test('exact project rules and explicit overrides share safety precedence', () => {
  const rules = { remote: [['node','scripts/build.mjs'], ['npm','run','prepare']], local: [['cargo','test','-q']] };
  assert.equal(route(['node','scripts/build.mjs'], undefined, rules), 'remote');
  assert.equal(route(['node','scripts/build.mjs-other'], undefined, rules), 'local');
  assert.equal(route(['cargo','test','-q'], undefined, rules), 'local');
  assert.equal(route(['cargo','test'], undefined, rules), 'remote');
  assert.equal(route(['python3','--version'], undefined, rules, true), 'remote');
  assert.equal(route(['unknown','build'], undefined, rules, true), 'remote');
  for (const argv of [['git','status'], ['bash','-c','cargo test'], ['npm','publish']]) assert.equal(route(argv, [argv[0]], {remote:[[argv[0]]]}, true), 'local');
});
test('existing explicit executable policies migrate visibly without changing identity', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.local,'reroute.toml'), '[routing]\ncommands = ["python3"]\n');
  const old = await loadConfig(f.local); assert.equal(old.routing.mode, 'legacy');
  assert.equal(route(['python3','script.py'], old.routing.commands, old.routing), 'remote');
  await fs.writeFile(join(f.local,'reroute.toml'), '[routing]\nmode = "tasks"\ncommands = ["python3"]\nremote = [["python3", "build.py"]]\n');
  const migrated = await loadConfig(f.local); assert.equal(migrated.routing.mode,'tasks');
  assert.equal(route(['python3','script.py'], migrated.routing.commands, migrated.routing),'local');
  assert.equal(route(['python3','build.py'], migrated.routing.commands, migrated.routing),'remote');
});
for (const routing of [{mode:'fast'}, {remote:[[]]}, {remote:['cargo test']}, {local:[['../tool']]}, {remote:[['node','bad\narg']]}]) test('invalid rules are rejected: '+JSON.stringify(routing), () => assert.throws(()=>validateConfig(merge(structuredClone(DEFAULT_CONFIG),{routing})), /routing/));
