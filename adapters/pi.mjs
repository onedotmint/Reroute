import { activationEnv, bridgeCommand } from '../dist/core/activation.js';
import { openPanel } from './pi-panel.mjs';
/** Native tool owns streaming, truncation, cancellation and the ordinary Bash schema. */
export function registerPi(pi, sdk, tuiApi) {
  if (typeof sdk.createBashTool !== 'function' || typeof sdk.createLocalBashOperations !== 'function') {
    throw new Error('Reroute requires the current Pi Bash extension API. No local fallback installed.');
  }
  pi.registerCommand('reroute', {
    description: 'Manage Reroute project, routing and runtime locally',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('/reroute requires Pi TUI mode. Use reroute status --json in automation.', 'error'); return; }
      if (!tuiApi) { ctx.ui.notify('Refresh the owned Pi adapter with reroute setup --non-interactive --harness pi, then /reload. Or load adapters/pi.ts directly.', 'error'); return; }
      await openPanel(ctx, sdk, tuiApi);
    }
  });
  pi.registerTool(sdk.createBashTool(process.cwd(), { spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: activationEnv(env) }) }));
  pi.on('user_bash', () => {
    const operations = sdk.createLocalBashOperations();
    return { operations: { ...operations, exec: (command, cwd, options) => operations.exec(bridgeCommand(command), cwd, options) } };
  });
}

/** Legacy ESM factory for callers whose own module tree supplies the host packages.
 * Pi discovery uses pi.ts so the host loader resolves its static imports. */
export default async function reroute(pi) {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const tuiApi = await import('@earendil-works/pi-tui');
  registerPi(pi, sdk, tuiApi);
}
