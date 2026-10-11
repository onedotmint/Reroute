import { bridgeCommand } from '../dist/core/activation.js';
/** Factory avoids an eager optional peer import in offline tests. */
export function rerouteExecutor(LocalBashExecutor) {
  return class RerouteShellExecutor extends LocalBashExecutor {
    execute(spec) { return super.execute({ ...spec, command: bridgeCommand(spec.command) }); }
  };
}
export async function loadExecutor() {
  const { LocalBashExecutor } = await import('@deepseek-ai/dsh-bash-local');
  return rerouteExecutor(LocalBashExecutor);
}
