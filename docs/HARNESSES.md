# Harness integrations

These adapters preserve a native shell/Bash tool. They never define a model-facing
`remote_exec`, contain provider logic, or inject sandbox identifiers into prompts.
Every adapter has protocol fixtures. **No actual harness binary was installed or
launched during delivery**, so fixtures are not equivalent to host integration tests.

| Harness | Implemented entry point | Activation | Delivery qualification |
| --- | --- | --- | --- |
| Pi | native `createBashTool` spawn hook + user-shell operations | `reroute setup --harness pi`, then restart | locally verified protocol; native host unverified |
| OMP | current `tool_call` input replacement | `reroute setup --harness omp`, then restart | Bash tool only; user shell/Python tools not covered |
| Claude Code | `PreToolUse` / `hookSpecificOutput.updatedInput` | `reroute setup --harness claude`, review hook trust | native permissions retained; host unverified |
| Codex CLI | `PreToolUse`, `updatedInput` plus required allow | explicit `--allow-codex-hook` opt-in | approval semantics differ; see warning below |
| Cursor | native `preToolUse` / `updated_input`, `failClosed` | `reroute setup --harness cursor`, review native hooks | host/schema-version compatibility unverified |
| OpenCode | v2 `ctx.shell.hook('create.before', ...)` | native plugin activation required | v2 only, not a claimed v1 adapter |
| DeepSeek Harness | subclass native `LocalBashExecutor.execute` | native composition replacement required | evolving capability seam, experimental host support |
| Continue | none | none | not implemented; no clean stable seam verified |

Gemini CLI and GitHub Copilot CLI are deliberately absent.

## Pi

The installer creates `~/.pi/agent/extensions/reroute.ts`, importing the host's
`@earendil-works/pi-coding-agent` and this package's adapter using an absolute file
URL. It retains the native Bash tool definition, streaming callbacks, abort options,
output truncation and result shape. Only spawn environment is changed. The native
user-shell execution options delegate through the same local bridge.

A stale/older Pi package name is not silently monkey-patched. Verify your Pi release
and its extension API. If another extension also replaces Bash, resolve that host
conflict explicitly rather than stacking replacements without checking behavior.
Setup detects directories/binaries, not every possible compatibility conflict.

## OMP

The installed extension uses current OMP `tool_call` input replacement. It does
not pretend Pi's user-shell operations object exists in OMP. OMP's separate Python
tool and user `!` shell are outside this adapter; `reroute shell -- '...'` remains the
explicit bridge for user commands. Claims of full OMP execution interception would
be inaccurate for this preview.

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
To uninstall, remove only the Reroute-owned extension/plugin and the exact owned
hook command shown in `~/.reroute/installed-hooks.json`, preserving other hooks,
then uninstall the package. Automatic uninstall/config rollback is not implemented.
