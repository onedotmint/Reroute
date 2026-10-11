import { bridgeCommand } from '../core/activation.js';
import { invariant } from '../core/errors.js';
/** Only wire translation lives here. No approval bypass, provider or routing logic. */
export function transformHook(host, packet) {
    invariant(packet && typeof packet === 'object' && !Array.isArray(packet), 'HOOK_PROTOCOL', 'Hook packet must be an object');
    const p = packet;
    const event = p.hook_event_name;
    if (event !== undefined && !['PreToolUse', 'preToolUse'].includes(String(event)))
        return {};
    const tool = String(p.tool_name ?? '');
    if (!['Bash', 'bash', 'Shell', 'shell', 'run_terminal_cmd'].includes(tool))
        return {};
    const input = p.tool_input;
    invariant(input && typeof input === 'object' && !Array.isArray(input), 'HOOK_PROTOCOL', 'Shell tool_input is missing');
    const fields = input;
    invariant(typeof fields.command === 'string', 'HOOK_PROTOCOL', 'Shell tool_input.command must be a string');
    const updated = { ...fields, command: bridgeCommand(fields.command) };
    if (updated.command === fields.command)
        return {};
    if (host === 'cursor')
        return { updated_input: updated };
    // Codex requires allow with updatedInput. This delegates to the host's hook trust
    // policy, not an Reroute shell allowlist. See SECURITY.md before enabling it.
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...(host === 'codex' ? { permissionDecision: 'allow' } : {}), updatedInput: updated } };
}
