// Copied into the clean install; no imports or module resolution from the checkout.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageDir, hostDir, project, agent] = process.argv.slice(2);
globalThis.fetch = async () => { throw Error('Network prohibited during installed-package probe'); };
// Set before Modal can load and cache cbor-x, including its CommonJS entry.
process.env.CBOR_NATIVE_ACCELERATION_DISABLED = 'true';
const require = createRequire(join(packageDir, 'package.json'));
const e2b = await import(pathToFileURL(require.resolve('e2b')));
for (const method of ['getInfo', 'connect', 'pause', 'kill']) assert.equal(typeof e2b.Sandbox[method], 'function', `E2B ${method}`);
assert.equal(typeof e2b.CommandExitError, 'function');
const daytona = await import(pathToFileURL(require.resolve('@daytona/sdk')));
assert.equal(typeof daytona.Daytona, 'function');
const modalPath = require.resolve('modal');
const modal = await import(pathToFileURL(modalPath));
assert.equal(typeof modal.ModalClient, 'function');
const modalRequire = createRequire(modalPath);
// Verify the fallback, not an accidentally working native addon.
const cbor = await import(pathToFileURL(modalRequire.resolve('cbor-x')));
assert.equal(cbor.isNativeAccelerationEnabled, false);
const value = { task: 'offline', count: 42, text: '无安装脚本' };
assert.deepEqual(cbor.decode(cbor.encode(value)), value);
const protobuf = modalRequire('protobufjs');
const message = protobuf.parse('syntax="proto3"; message Probe { string value = 1; }').root.lookupType('Probe');
assert.equal(message.decode(message.encode({ value: 'offline' }).finish()).value, 'offline');
const sdk = await import(pathToFileURL(join(hostDir, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
const adapter = join(packageDir, 'adapters/pi.ts');
const loaded = await sdk.discoverAndLoadExtensions([adapter], project, agent);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.deepEqual([...extension.tools.keys()], ['reroute_run', 'reroute_status']);
assert.ok(extension.commands.has('reroute'));
assert.equal(extension.tools.has('bash'), false);
assert.equal(extension.handlers.has('user_bash'), false);
console.log(JSON.stringify({ extensionLoaded: true, command: '/reroute', tools: [...extension.tools.keys()], sdkImports: true, cborJs: true, protobuf: true, cloudCalls: 0 }));
