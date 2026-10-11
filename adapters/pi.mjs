import { activationEnv, bridgeCommand } from '../dist/core/activation.js';
/** Native tool owns streaming, truncation, cancellation and the ordinary Bash schema. */
export function registerPi(pi, sdk) {
  if (typeof sdk.createBashTool !== 'function' || typeof sdk.createLocalBashOperations !== 'function') {
    throw new Error('Reroute requires the current Pi Bash extension API. No local fallback installed.');
  }
  pi.registerTool(sdk.createBashTool(process.cwd(), { spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: activationEnv(env) }) }));
  pi.on('user_bash', () => {
    const operations = sdk.createLocalBashOperations();
    return { operations: { ...operations, exec: (command, cwd, options) => operations.exec(bridgeCommand(command), cwd, options) } };
  });
}
export default async function reroute(pi) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  registerPi(pi, sdk);
}
