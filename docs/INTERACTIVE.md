# Interactive management

## Pi `/reroute`

Install explicitly with `reroute setup --non-interactive --harness pi`, then restart
Pi or `/reload`. During development, use `pi -e ./adapters/pi.ts` (or `pi -e .`).
The TypeScript entry imports the host SDK/TUI statically so Pi's module mapping is
used; the implementation `.mjs` files are not standalone extension entry points.
Old owned installer entries can be refreshed by the same explicit setup command.
User-edited entries are preserved, not overwritten.

The compact native panel shows project/provider, runtime, routing, current task
count, coordinator availability, authentication presence and pending/error warnings.
No reliable last-task/result record is currently maintained, so none is invented.

- **↑ / ↓** move; **Enter** select/review/confirm.
- **Space** toggles task categories in Configure routing.
- **Esc / Ctrl+C** return or cancel; Esc from the root closes the panel.
- Pi's configured selection bindings, theme and terminal-width utilities are reused.

Actions: Refresh status, Switch provider, Configure routing, Diagnostics, Manage
runtime. Opening/refreshing uses local/active-coordinator metadata only. Runtime
state is **Unknown / remote unverified** unless the user explicitly requests
Manage runtime → Query live runtime state. That vendor query is read-only; failures
remain Unknown, not Missing. A recorded runtime absence is shown as not created,
not a claim about all resources on the account. Live query data is displayed only
for that interaction; Refresh returns to metadata. No additional daemon is started
for status or read-only diagnostics.

Configuration is reviewed before saving, including enabling project routing. Start/resume, stop and destruction have
separate cost/data/task confirmations; cancellation never invokes a lifecycle action.
The existing coordinator rechecks activity and protects runtime identity and pending
source. Switching providers or changing the SSH endpoint while a runtime or pending source is recorded is refused,
not an implicit deletion: recover/sync the original, then explicitly destroy it if
appropriate. Stopping/destruction may require reconciliation and paid resume; the
existing authorization gate still applies. Retained storage/native volumes may cost
money after stopping or destroying compute. See [security](SECURITY.md).

## `reroute setup`

TTY input **and** output enable the Clack wizard:

1. Load current effective project configuration as defaults.
2. Choose SSH, Daytona, SkyPilot, Modal or E2B.
3. Ask only required parameters (an existing SSH host alias for SSH). Other providers
   have usable native defaults; advanced images/templates/sizing stay in user TOML.
4. Show local tool/SDK and native-auth presence, without verifying account access.
5. Space-select automatic build/test/check/benchmark categories; Enter reviews.
6. Show identity/override, shim, explicit adapter/SDK changes and existing cost grant.
7. Confirm before applying the existing validated coordinator save path.

Esc/Ctrl+C or declining the final confirmation returns exit **130**, with no draft
writes, SDK/adaptor installation or cloud operation. No credential input is requested
and no new paid authorization is inferred. Missing dependencies/auth are actionable
warnings, not a reason to provision resources. SDK installation remains an explicit
`--install-sdk PROVIDER` operation; harness detection never automatically installs.
After successful application the CLI reports the provider/project and next commands.

Pipes never wait for keyboard input. `--non-interactive` or `--json` also forces the
explicit-flag path on a TTY:

```sh
reroute setup --non-interactive --provider ssh --host build-host --tasks build,test
reroute setup --non-interactive --provider daytona
reroute setup --non-interactive --harness pi   # adapter-only, no project activation
reroute enable --allow-paid                  # separate deliberate cost decision
reroute status --json                        # additive metadata; no cloud query
reroute status --json --live                 # explicit read-only vendor query
reroute doctor                              # read-only diagnostics, no daemon startup
```

For compatibility, flag-free non-TTY setup still configures only Reroute itself.
Selecting SSH without a host errors before installation/config writes. Task-only
setup requires an existing project or explicit provider selection. No interactive
cancellation or validation failure leaves a half-written project config; saving uses
the existing atomic state writer. Shared user/project TOML is never rewritten.

## Dependency and verification boundaries

Clack **1.8.1** / core **1.5.1** are MIT licensed and support Node 22. They are loaded
only for the standalone TTY wizard. Six small MIT packages are bundled in npm
tarballs for empty-cache offline installation; neither Pi nor a provider SDK is
bundled. Pi uses host `SelectList`, `SettingsList`, `Container`, themes, keybindings
and width handling, not Clack or a second renderer. No generic ANSI/menu framework
is maintained here. Source checkouts run `npm ci --ignore-scripts` before tests/packing.

`tests/integration/wizard.test.mjs` drives real PTYs for cancellation and prefill;
`cli-daemon.test.mjs` confirms the complete keyboard/save/reread path with a local
fixture coordinator. `manage.test.mjs` verifies shared safety and all five providers;
`task-categories.test.mjs` verifies routing behavior. `pi-panel.test.mjs` uses actual
native components when Pi is installed (explicit skips otherwise), plus fixture
operations to verify no side effects before confirmation. These are not paid-cloud
or end-to-end remote-provider acceptance. See [live acceptance](LIVE-ACCEPTANCE.md).
