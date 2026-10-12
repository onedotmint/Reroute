import { basename } from 'node:path';
import { localStatus, projectSettings, projectConfiguration, enableProject, runtimeStatus, manageRuntime } from '../dist/cli/manage.js';
import { authStatus, doctor } from '../dist/cli/setup.js';
import { PROVIDERS } from '../dist/config/config.js';
import { TASK_CATEGORIES } from '../dist/core/routing.js';
import { safeMessage, RerouteError } from '../dist/core/errors.js';

const operations = { localStatus, projectSettings, projectConfiguration, enableProject, runtimeStatus, manageRuntime, authStatus, doctor };
const providerLabel = id => ({ ssh: 'SSH', daytona: 'Daytona', skypilot: 'SkyPilot', modal: 'Modal', e2b: 'E2B' })[id] ?? 'not configured';

/** Host components own selection, keys, terminal widths and rendering. */
export function selectScreen(ctx, tuiApi, title, lines, items, initialValue) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const { Container, SelectList, truncateToWidth } = tuiApi;
    const container = new Container();
    container.addChild({ render: width => [theme.fg('accent', theme.bold(title)), ...lines.map(line => theme.fg(line.startsWith('Failed:') ? 'error' : line.startsWith('Warning:') ? 'warning' : 'muted', line)), ''].map(line => truncateToWidth(line, width)), invalidate() {} });
    const controls = new Container();
    let list, visible;
    const resize = () => {
      const count = Math.min(8, Math.max(1, (tui.terminal.rows ?? 24) - lines.length - 6));
      if (count === visible) return;
      const selected = list?.getSelectedItem()?.value ?? initialValue;
      visible = count;
      list = new SelectList(items, count, {
        selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('warning', text)
      });
      const index = items.findIndex(item => item.value === selected);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelect = item => done(item.value);
      list.onCancel = () => done(undefined);
      controls.clear(); controls.addChild(list);
    };
    resize();
    container.addChild(controls);
    container.addChild({ render: width => [truncateToWidth(theme.fg('dim', '↑/↓ move · Enter confirm · Esc back'), width)], invalidate() {} });
    return { render: width => { resize(); return container.render(width).map(line => truncateToWidth(line, width)); }, invalidate: () => container.invalidate(), handleInput: data => { list.handleInput(data); tui.requestRender(); } };
  });
}
export function routingScreen(ctx, sdk, tuiApi, selected) {
  return ctx.ui.custom((tui, theme, kb, done) => {
    const draft = new Set(selected);
    const list = new tuiApi.SettingsList(TASK_CATEGORIES.map(id => ({ id, label: id, currentValue: draft.has(id) ? '[x]' : '[ ]', values: ['[ ]', '[x]'] })), 6,
      { ...sdk.getSettingsListTheme(), hint: () => theme.fg('dim', 'Space toggle · Enter review · Esc cancel') }, (id, value) => { if (value === '[x]') draft.add(id); else draft.delete(id); }, () => done(undefined), { enableSearch: false });
    return {
      render: width => [theme.fg('accent', theme.bold('Configure routing')), ...list.render(width)].map(line => tuiApi.truncateToWidth(line, width)),
      invalidate: () => list.invalidate(),
      handleInput: data => {
        if (kb.matches(data, 'tui.select.confirm')) done(TASK_CATEGORIES.filter(task => draft.has(task)));
        else list.handleInput(data);
        tui.requestRender();
      }
    };
  });
}
export async function openPanel(ctx, sdk, tuiApi, ops = operations) {
  const choose = (title, lines, items, initial) => selectScreen(ctx, tuiApi, title, lines, items, initial);
  const confirm = async (title, detail) => await choose(title, detail, [{ value: 'cancel', label: 'Cancel' }, { value: 'confirm', label: 'Confirm' }]) === 'confirm';
  let feedback = '', live;
  for (;;) {
    try {
      const report = { ...await ops.localStatus(ctx.cwd), ...live };
      const auth = await ops.authStatus();
      const lines = [
        `Project: ${report.project?.name ?? basename(ctx.cwd)}`,
        `Provider: ${providerLabel(report.provider)}`,
        `Runtime: ${report.status === 'not-created' ? 'Missing (not created)' : report.status[0].toUpperCase() + report.status.slice(1)}`, 
        `Routing: ${report.enabled ? report.routing : 'disabled'} · Tasks: ${report.active ?? 'unknown'}`,
        `State: ${report.stateSource} · Coordinator: ${report.coordinator}`,
        ...(report.syncPending ? ['Warning: pending source — retain original runtime; reroute sync'] : []),
        ...(report.warning ? [`Warning: ${report.warning}`] : []),
        ...(report.provider ? [`${/missing/i.test(String(auth[report.provider])) ? 'Warning' : 'Auth'}: ${auth[report.provider]}`] : ['Warning: not configured — Switch provider or reroute setup']),
        ...(feedback ? [feedback] : [])
      ];
      const action = await choose('Reroute', lines, [
        { value: 'refresh', label: 'Refresh status', description: 'Local metadata only; never activates compute' },
        { value: 'provider', label: 'Switch provider' },
        { value: 'routing', label: 'Configure routing' },
        { value: 'doctor', label: 'Diagnostics' },
        { value: 'runtime', label: 'Manage runtime', description: 'Live query / start / stop / destroy' }
      ]);
      if (!action) return;
      feedback = ''; live = undefined;
      if (action === 'refresh') { feedback = 'Refreshed local metadata; remote state remains unverified.'; continue; }
      if (action === 'doctor') {
        const result = await ops.doctor(ctx.cwd, false, false);
        await choose('Diagnostics (read-only)', ['No repairs, resource creation or authentication requests.'], [
          ...result.checks.map((check, i) => ({ value: String(i), label: `${check.check}: ${check.state}`, description: typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail) })), { value: 'back', label: 'Back' }
        ]);
        continue;
      }
      if (action === 'provider' || action === 'routing') {
        const { state, config } = await ops.projectSettings(ctx.cwd);
        const choices = {};
        if (action === 'provider') {
          const provider = await choose('Switch provider', ['Existing resources are never destroyed by switching.'], PROVIDERS.map(id => ({ value: id, label: `${providerLabel(id)}${id === state?.provider ? ' (current)' : ''}` })), config.provider);
          if (!provider) continue;
          if (provider !== state?.provider && (state?.runtime || state?.syncPending)) throw new RerouteError('PROVIDER_CHANGE', 'Original runtime/pending source retained. Reconcile and explicitly stop --destroy before switching provider.');
          choices.provider = provider;
          if (provider === 'ssh') {
            const savedHost = String(config.providers.ssh?.host ?? '');
            const host = await ctx.ui.input(`Existing OpenSSH host alias${savedHost ? ' (Enter keeps current)' : ''}`, savedHost);
            if (host === undefined) continue;
            choices.host = host.trim() || savedHost;
          }
        } else {
          const tasks = await routingScreen(ctx, sdk, tuiApi, config.routing.tasks ?? TASK_CATEGORIES);
          if (!tasks) continue;
          choices.tasks = tasks.length ? tasks.join(',') : 'none';
        }
        const planned = await ops.projectConfiguration(ctx.cwd, choices);
        const current = await ops.localStatus(ctx.cwd);
        if (current.active || current.dev) throw new RerouteError('PROJECT_BUSY', 'Stop active commands/dev sessions before changing configuration.');
        if (!(await confirm('Save configuration?', [
          `Provider: ${providerLabel(planned.config.provider)}`,
          `Routing: ${planned.config.routing.mode} (${planned.config.routing.tasks?.join(', ') ?? 'existing policy'})`,
          'Enables project routing; saves machine-local override/identity. User TOML and runtime identity are retained.',
          'No cloud resources created; no new paid authorization granted.'
        ]))) continue;
        await ops.enableProject(ctx.cwd, choices);
        feedback = 'Configuration saved and validated.';
      }
      if (action === 'runtime') {
        const operation = await choose('Manage runtime', ['Stop/destroy reconcile pending source first.', 'Retained disks may still cost money; no zero-cost guarantee.'], [
          { value: 'query', label: 'Query live runtime state', description: 'Read-only vendor request; does not resume/create' },
          { value: 'start', label: 'Start / resume', description: 'May create billable resources; paid grant still required' },
          { value: 'stop', label: 'Stop work / runtime', description: 'Cancels tasks; SSH host is not stopped' },
          { value: 'destroy', label: 'Destroy runtime', description: 'Irreversible; native retained volumes may remain' }
        ]);
        if (!operation) continue;
        if (operation === 'query') { live = await ops.runtimeStatus(ctx.cwd); continue; }
        const current = await ops.localStatus(ctx.cwd);
        const remote = operation === 'start' ? undefined : await ops.runtimeStatus(ctx.cwd);
        if (remote?.status === 'unknown') throw new RerouteError('RUNTIME_UNKNOWN', remote.warning ?? 'Remote state unknown; no lifecycle action attempted.');
        if (!(await confirm(`${operation} runtime?`, [
          `Provider: ${providerLabel(current.provider)} · Runtime: ${current.runtime ?? 'not created'}`,
          `Tasks: ${current.active ?? 'unknown'} · Pending source: ${current.syncPending ? 'yes' : 'no'}`,
          ...(remote ? [`Live state: ${remote.status}`] : []),
          operation === 'start' ? 'May create/resume paid compute. Review native budget and cleanup first.' : 'Cancels active work. Reconciliation may resume paid compute; failures retain pending source.',
          operation === 'destroy' ? 'Deletes the original runtime/workspace after source reconciliation. Cannot be undone.' : 'Uses existing native lifecycle policy; storage costs may remain.'
        ]))) continue;
        await ops.manageRuntime(ctx.cwd, operation);
        feedback = `${operation} completed. Verify native resources/billing; retained storage may incur charges.`;
      }
      if (feedback) ctx.ui.notify(feedback, 'info');
    } catch (error) {
      feedback = `Failed: ${safeMessage(error)}`;
      ctx.ui.notify(feedback, 'error');
      // Broken local state cannot be rendered: leave an actionable, local-only error.
      try { await ops.localStatus(ctx.cwd); } catch { return; }
    }
  }
}
