import { invariant, errorCode, safeMessage } from '../core/errors.js';
import { findProject, projectRoot } from '../core/projects.js';
import { loadConfig, merge } from '../config/config.js';
import { installShims } from '../core/activation.js';
import { TASK_CATEGORIES } from '../core/routing.js';
import { request } from '../daemon/client.js';
export async function projectConfiguration(cwd, flags) {
    const old = flags['new-identity'] ? undefined : await findProject(cwd);
    const root = old?.project.root ?? await projectRoot(cwd);
    let override = old?.override ?? {};
    if (flags.host)
        override = merge(override, { providers: { ssh: { host: flags.host } } });
    if (typeof flags.tasks === 'string') {
        const tasks = flags.tasks === 'none' ? [] : flags.tasks.split(',');
        invariant(tasks.every(task => TASK_CATEGORIES.includes(task)), 'CONFIG', 'Use --tasks build,test,check,benchmark (or none)');
        override = merge(override, { routing: { mode: 'tasks', tasks } });
    }
    let config = await loadConfig(root, { ...override, ...(flags.provider ? { provider: flags.provider } : flags.host ? { provider: 'ssh' } : old ? { provider: old.provider } : {}) });
    invariant(!(flags['allow-paid'] && flags['revoke-paid']), 'USAGE', 'Choose --allow-paid or --revoke-paid, not both');
    if (flags['allow-paid'] || flags['revoke-paid']) {
        override = merge(override, { authorization: { paidProviders: flags['allow-paid'] ? [config.provider] : [] } });
        config = await loadConfig(root, { ...override, provider: config.provider });
    }
    if (config.provider === 'ssh')
        invariant(typeof config.providers.ssh?.host === 'string' && config.providers.ssh.host.length > 0 && !/[\0\r\n]/.test(config.providers.ssh.host), 'CONFIG', 'Set an existing host: reroute setup --provider ssh --host ALIAS');
    // Keep the core's identity guard visible before adapter/shim installation as well.
    invariant(!old?.runtime || old.provider === config.provider, 'PROVIDER_CHANGE', 'Existing runtime retained. Reconcile source and explicitly reroute stop --destroy before switching provider.');
    invariant(!old?.syncPending || old.provider === config.provider, 'SOURCE_PENDING', 'Recover pending source with the original provider before switching.');
    if (flags.host && old?.provider === 'ssh' && (old.runtime || old.syncPending)) {
        const original = await loadConfig(root, { ...old.override, provider: old.provider });
        invariant(original.providers.ssh?.host === flags.host, 'PROVIDER_CHANGE', 'Original SSH endpoint retained. Recover/sync and explicitly destroy the old workspace before changing host.');
    }
    return { config, override, root };
}
export async function enableProject(cwd, flags) {
    const { config, override, root } = await projectConfiguration(cwd, flags);
    await installShims(config.routing.commands);
    const state = await request({ op: 'enable', cwd: root, provider: config.provider, override, fresh: flags['new-identity'] === true });
    return { enabled: true, provider: config.provider, project: state.project.id, paidAuthorized: config.authorization?.paidProviders.includes(config.provider) ?? false, policyMode: config.routing.mode, migration: config.routing.mode === 'legacy' ? 'Legacy commands retained; set [routing] mode = "tasks" to migrate' : undefined, note: 'No runtime created. Restart explicitly configured harnesses after setup.' };
}
export async function projectSettings(cwd) {
    const state = await findProject(cwd), root = state?.project.root ?? await projectRoot(cwd);
    return { state, root, config: await loadConfig(root, state ? { ...state.override, provider: state.provider } : {}) };
}
export async function localStatus(cwd) {
    const { state, config } = await projectSettings(cwd);
    const paidAuthorized = state?.provider === 'ssh' || !!config.authorization?.paidProviders.includes(config.provider);
    const report = {
        paidAuthorized, warning: state?.enabled && !paidAuthorized ? 'Paid resources are not authorized. Review native budget/cleanup, then reroute enable --allow-paid before remote work.' : undefined,
        enabled: state?.enabled ?? false, project: state?.project, provider: state?.provider,
        runtime: state?.runtime?.id, status: state?.runtime ? 'unknown' : 'not-created',
        active: undefined, dev: undefined,
        syncPending: state?.syncPending === true, coordinator: 'not running', remoteReadiness: 'UNVERIFIED', billing: 'UNKNOWN',
        stateSource: 'recorded locally; remote unverified', routing: config.routing.mode ?? 'tasks', tasks: config.routing.tasks ?? [...TASK_CATEGORIES]
    };
    try {
        const live = await request({ op: 'status', cwd }, false);
        return { ...report, ...live, warning: live.warning ?? report.warning, coordinator: 'running', stateSource: 'live coordinator metadata; remote unverified' };
    }
    catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes(errorCode(error) ?? ''))
            return report;
        return { ...report, coordinator: 'unreachable', warning: safeMessage(error) };
    }
}
/** Explicit, read-only vendor query: never prepare/restore a runtime. */
export async function runtimeStatus(cwd) {
    const { state, config } = await projectSettings(cwd);
    if (!state?.runtime)
        return { status: 'not-created', stateSource: 'no recorded runtime', warning: undefined };
    try {
        const { createProvider } = await import('../providers/index.js');
        const status = await createProvider(config).status(structuredClone(state.runtime));
        return { status, stateSource: 'live provider query', warning: status === 'unknown' ? 'Provider could not verify remote state; no resource operation attempted.' : undefined };
    }
    catch (error) {
        return { status: 'unknown', stateSource: 'live query failed; remote unverified', warning: safeMessage(error) };
    }
}
export async function manageRuntime(cwd, action) {
    return request({ op: action === 'destroy' ? 'stop' : action, cwd, ...(action === 'destroy' ? { destroy: true } : {}) });
}
