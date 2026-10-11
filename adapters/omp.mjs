import { bridgeCommand } from '../dist/core/activation.js';
/** Current OMP has input replacement; it does not share Pi's spawnHook contract. */
export default function reroute(omp) {
  omp.on('tool_call', event => {
    if (event.toolName !== 'bash') return;
    if (typeof event.input?.command !== 'string') return { block: true, reason: 'Unsupported OMP Bash input. Reroute did not execute locally.' };
    return { input: { ...event.input, command: bridgeCommand(event.input.command) } };
  });
}
