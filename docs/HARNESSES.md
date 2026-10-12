# Harness integrations

Noninteractive `reroute setup` without project flags configures only Reroute itself;
human TTY setup can guide explicit project/provider selection. Harness discovery
is informational, never permission to install an adapter.
Use explicit `--harness pi` (or a comma-separated list) to activate adapters, and restart
the selected host. `doctor --fix` must not install a merely detected harness.

These adapters preserve a native shell/Bash tool. They never define a model-facing
`remote_exec`, contain provider logic, or inject sandbox identifiers into prompts.
Every adapter has protocol fixtures. Pi's native management TUI is locally checked
against Pi 1.1.0; remote Bash/cloud integration and other native hosts still need
separate acceptance. See [interactive management](INTERACTIVE.md).

| Harness | Implemented entry point | Activation | Delivery qualification |
| --- | --- | --- | --- |
| Pi | native `createBashTool` spawn hook + user-shell operations | `reroute setup --harness pi`, then restart | native management TUI checked; remote Bash/cloud path unverified |
| Claude Code | `PreToolUse` / `hookSpecificOutput.updatedInput` | `reroute setup --harness claude`, review hook trust | native permissions retained; host unverified |
| Codex CLI | `PreToolUse`, `updatedInput` plus required allow | explicit `--allow-codex-hook` opt-in | approval semantics differ; see warning below |
| Cursor | native `preToolUse` / `updated_input`, `failClosed` | `reroute setup --harness cursor`, review native hooks | host/schema-version compatibility unverified |
| OpenCode | v2 `ctx.shell.hook('create.before', ...)` | native plugin activation required | v2 only, not a claimed v1 adapter |
| DeepSeek Harness | subclass native `LocalBashExecutor.execute` | native composition replacement required | evolving capability seam, experimental host support |
| Continue | none | none | not implemented; no clean stable seam verified |

Gemini CLI and GitHub Copilot CLI are deliberately absent.

## Pi

The installer creates `~/.pi/agent/extensions/reroute.ts`, importing the host's
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and this package's adapter
using an absolute file URL. It retains the native Bash tool definition, streaming callbacks, abort options,
output truncation and result shape. Only spawn environment is changed. The native
user-shell execution options delegate through the same local bridge.

A stale/older Pi package name is not silently monkey-patched. Verify your Pi release
and its extension API. If another extension also replaces Bash, resolve that host
conflict explicitly rather than stacking replacements without checking behavior.
Setup detects directories/binaries, not every possible compatibility conflict.

## Legacy OMP migration (no longer supported)

OMP is no longer detected, installed or repaired. `setup --harness omp` is rejected.
An existing `~/.omp/agent/extensions/reroute.ts` may still reference the removed
adapter module; restart OMP only after reviewing that stale extension.

Use `reroute uninstall --harness omp` explicitly to remove an unchanged, recorded
Reroute extension. Default uninstall does not select legacy OMP. Cleanup still checks
the expected current home, content hash and symlinks; modified, unrecorded or unsafe
files are preserved. `doctor` warns about legacy entries or an unrecorded extension,
and `doctor --fix` never reinstalls OMP, even when a recorded file is missing.

For preserved files, back up and review the exact extension manually; remove only
confirmed Reroute code. Do not delete `.omp`, reset user settings, or restore a whole
configuration backup. Reroute does not edit OMP's user configuration. This cleanup
does not stop runtimes or remove SDKs/credentials. Use `reroute shell -- '...'` as an
explicit CLI bridge, or explicitly install a supported harness such as Pi.

## Claude and Cursor

Owned entries are merged into `~/.claude/settings.json` or
`~/.cursor/hooks.json`. Unrelated settings and hooks survive repeated setup.
A backup is kept with private permissions; malformed/non-object JSON is not
rewritten. Native tool fields such as timeout/description are retained.

Claude output omits `permissionDecision`, so the bridge does not intentionally
approve shell commands itself. Cursor uses its native `preToolUse` rewrite output,
not `beforeShellExecution`, which is not treated as a command-rewrite API.
Reroute cannot guarantee how each installed host version presents/approves a
rewritten command; test in an unimportant project first.

## Codex: explicit trust decision

The inspected Codex hook contract accepts command replacement only with an
explicit `permissionDecision: "allow"`. Consequently the adapter must emit an allow
for intercepted shell calls; it cannot promise unchanged per-command approvals.
It is implemented, but **setup deliberately does not install it merely because
Codex was detected**.

After reviewing that security tradeoff, explicit activation is:

```sh
reroute setup --harness codex --allow-codex-hook
```

The owned hook lives in `~/.codex/hooks.json`. Do not enable this in a trust model
that requires reviewing each untrusted Bash command. A safer manual boundary is
to run the CLI bridge deliberately rather than adding an automatic approving hook.
Native filesystem/network sandbox restrictions may still block local IPC; this
project does not disable those host safeguards.

## OpenCode v2

Setup writes an owned adapter entry under `~/.reroute/adapters/opencode.mjs` but
does not rewrite a possibly v1 or JSONC configuration. A v2-native project plugin
can use `.opencode/plugins/reroute/index.ts`:

```ts
import { Plugin } from "@opencode/plugin";
// Replace this single path with the installed Reroute adapter entry.
import reroute from "/absolute/path/to/reroute/adapters/opencode.mjs";
export default Plugin.define(reroute);
```

The inspected v2 docs auto-load project plugin directories. Alternatively configure
a native plugin directory through `plugins` in `opencode.json(c)`. Do not insert a
v2 plugin into a v1 configuration and claim compatibility. The adapter changes the
shell creation environment, not command text or host tool definitions. Confirm
that the host's native sandbox permits Reroute's private local socket.

## DeepSeek Harness

Setup writes a bridge factory under `~/.reroute/adapters/deepseek.mjs`. In the
native DSH composition, replace the `dsh-bash-local` executor binding with the
exported subclass. The replacement must be loaded where the native
`@deepseek-ai/dsh-bash-local` package can be resolved; setup cannot infer or rewrite
an arbitrary DSH composition graph.

```ts
import { LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
import { rerouteExecutor } from "/absolute/path/to/reroute/adapters/deepseek.mjs";
const RerouteExecutor = rerouteExecutor(LocalBashExecutor);
// Register RerouteExecutor at the same native composition binding as LocalBashExecutor.
```

The subclass changes `spec.command` and calls native `super.execute`; inherited
injection/config, foreground/background handles, trusted `dshEnv`, abort signal,
expiry and result semantics remain native. The exact application-level composition
binding is user-specific and has not been integration-tested here. This is a real
executor implementation, not automatic setup of every evolving DSH distribution.

## Shared limits and removal

PATH shims cover executable lookup, not arbitrary absolute paths, hardcoded PATH,
Python code execution tools, or hidden shell execution inside another unhooked
tool. A shell script routed remotely can itself call remote Git/publish commands;
Reroute does not parse script bodies or act as an agent security sandbox. Keep
identity-bearing composite workflows explicit and local.

`reroute disable` makes that project pass through; it does not uninstall global hooks.
Use `reroute uninstall --harness pi` (or a comma-separated selection) to remove only
unchanged Reroute-owned files and exact owned hook entries. User-edited files and
other hooks/settings are preserved and reported; a repeat uninstall is harmless.
`reroute uninstall` targets recorded supported adapters (legacy OMP requires explicit
`--harness omp`), not project runtimes, SDKs, secrets,
backups or arbitrary global configuration. Stop/sync resources separately, then remove
the npm package if desired. It does not imply cloud cleanup or zero billing.

Older installations that only have marker comments/command history are not evidence
of content ownership. Safe uninstall/reinstall deliberately refuses to claim them;
review and remove the exact old adapter manually (keeping unrelated content), then
perform explicit setup to record its content hash/exact hook entry.
