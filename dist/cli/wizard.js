import * as p from '@clack/prompts';
import { PROVIDERS } from '../config/config.js';
import { TASK_CATEGORIES } from '../core/routing.js';
import { invariant } from '../core/errors.js';
import { projectSettings, projectConfiguration } from './manage.js';
import { authStatus, doctor } from './setup.js';
/** Collect a draft only. CLI applies it through the same coordinator path as Pi. */
export async function setupWizard(cwd, flags) {
    invariant(process.stdin.isTTY && process.stdout.isTTY, 'USAGE', 'Interactive setup requires a TTY; use --non-interactive --provider PROVIDER [--host ALIAS]');
    const { state, root, config } = await projectSettings(cwd);
    const draft = { ...flags };
    p.intro('Reroute setup');
    p.log.info(`Project: ${root}\nExisting settings are defaults. No cloud resources will be created.`);
    const cancelled = () => { p.cancel('Cancelled. No configuration or resource changes.'); return false; };
    const provider = await p.select({
        message: 'Target provider', initialValue: (flags.provider ?? config.provider),
        options: PROVIDERS.map(value => ({ value, label: value === 'ssh' ? 'SSH' : value === 'e2b' ? 'E2B' : value === 'skypilot' ? 'SkyPilot' : value[0].toUpperCase() + value.slice(1), hint: value === state?.provider ? 'current' : undefined }))
    });
    if (p.isCancel(provider))
        return cancelled();
    draft.provider = provider;
    if (provider === 'ssh') {
        const host = await p.text({ message: 'Existing OpenSSH host alias', initialValue: String(flags.host ?? config.providers.ssh?.host ?? ''), validate: value => !value?.trim() || /[\0\r\n]/.test(value) ? 'Enter an existing SSH host alias; credentials stay in ssh-agent/config.' : undefined });
        if (p.isCancel(host))
            return cancelled();
        draft.host = host.trim();
    }
    const auth = await authStatus();
    const checks = (await doctor(cwd, false, false)).checks;
    p.note([String(auth[provider]), ...checks.filter(check => check.check === provider + ' SDK' || ['python3', ...(provider === 'skypilot' ? ['sky', 'ssh'] : ['ssh', 'daytona'].includes(provider) ? ['ssh'] : [])].includes(check.check)).map(check => `${check.check}: ${check.state}${check.state === 'MISSING' && check.check.endsWith(' SDK') ? ' — ' + check.detail + ' --non-interactive' : ''}`), 'Presence is not verified authentication. Fix missing tools/auth before execution.'].join('\n'), 'Local prerequisites');
    const initialValues = typeof flags.tasks === 'string' ? flags.tasks === 'none' ? [] : flags.tasks.split(',') : config.routing.tasks ?? [...TASK_CATEGORIES];
    const tasks = await p.multiselect({ message: 'Automatically offload task categories', options: TASK_CATEGORIES.map(value => ({ value, label: value })), initialValues, required: false });
    if (p.isCancel(tasks))
        return cancelled();
    draft.tasks = tasks.length ? tasks.join(',') : 'none';
    // Validation precedes confirmation and every installation/configuration write.
    const planned = await projectConfiguration(cwd, draft);
    p.note([`Provider: ${planned.config.provider}${provider === 'ssh' ? ' → ' + draft.host : ''}`, `Routing: tasks (${tasks.join(', ') || 'manual only'})`, ...(config.routing.mode === 'legacy' ? ['Changes legacy executable routing to task-based routing.'] : []), 'Custom local/remote rules and other settings are retained.', `Adapters: ${flags['no-adapters'] ? 'none' : flags.harness ?? 'none (discovery is informational)'}`, `SDK installation: ${flags['install-sdk'] ?? 'none'}`, `Paid authorization: ${planned.config.authorization?.paidProviders.includes(provider) ? 'already granted / explicitly requested' : 'not granted; use reroute enable --allow-paid after reviewing costs'}`, 'Enables project routing. Writes machine-local override/identity and PATH shims; user TOML is unchanged.', 'Existing runtime identity and pending source are retained. No remote activation.'].join('\n'), 'Review changes');
    const confirmed = await p.confirm({ message: 'Save configuration?', initialValue: false });
    if (p.isCancel(confirmed) || !confirmed)
        return cancelled();
    Object.assign(flags, draft);
    p.outro('Confirmed. Applying validated settings…');
    return true;
}
