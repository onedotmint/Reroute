# Reference and compatibility evidence

Inspection date: 2026-10-06. Public docs/source were read through a browsing tool
because container npm/GitHub DNS was unavailable. A viewed page is not proof that
a cloud API accepted our requests. Exact optional dependency status is in
`sdk-versions.json`. No substantial reference implementation was copied.

## Inspected implementation files

| Reference | Actual inspected file(s) | Applied lesson / boundary |
| --- | --- | --- |
| AFT | `https://raw.githubusercontent.com/cortexkit/aft/main/packages/pi-plugin/src/index.ts`; `STRUCTURE.md` | Thin Pi glue and shared backend/status ownership; no IDE/index engine copied |
| Magic Context | `https://raw.githubusercontent.com/cortexkit/magic-context/master/packages/pi-plugin/src/index.ts`; `CONFIGURATION.md` | Shared config, compatibility/discovery concepts; no plugin implementation copied |
| pi-rtk | `https://raw.githubusercontent.com/sherif-fanous/pi-rtk/main/index.ts` | Native Bash spawn hook and status boundary; Outboard does not adopt local fallback |
| Pi | `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/ssh.ts`; extension docs | Native Bash operations, cancellation, result shape and lifecycle |
| claude-remote-shell | `https://raw.githubusercontent.com/torarnv/claude-remote-shell/main/claude-remote-shell` | Local file authority + remote shell; source flush/reconcile boundary |
| DeepSeek Harness | `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/shell/bash-local/src/index.ts`; capability-seams and shell subsystem docs | Real `LocalBashExecutor.execute(spec)` delegation; inherited handles instead of a new tool |
| OMP (historical; support removed) | `https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/extensibility/extensions/types.ts`; `src/extensibility/shared-events.ts`; package manifest | Historical tool-call `input` replacement; no current OMP adapter |

AFT, Magic Context, pi-rtk and claude-remote-shell were MIT-design references, not
bundled source. The project itself is Apache-2.0. The user-specified
`https://github.com/remote-cli/remote` was inspected at repository/README/license
level (BSD-2-Clause); attempts to retrieve guessed config/sync implementation paths
failed. **Its implementation modules were not successfully inspected**, and no
claims of copying or fully studying them are made. Full setup/doctor implementations
from all reference projects were also not inspected exhaustively.

`https://github.com/Menghuan1918/rexec` was a design-only GPL boundary in the brief;
no GPL implementation is included or ported here. This delivery does not implement
that project's reconnect/log-offset recovery.

## Current official contracts used

Daytona:
- `https://www.daytona.io/docs/en/typescript-sdk/`
- `https://www.daytona.io/docs/en/typescript-sdk/daytona/`
- `https://www.daytona.io/docs/en/typescript-sdk/sandbox/`
- `https://www.daytona.io/docs/en/ssh-access/`
- `https://www.daytona.io/docs/en/sandboxes.md` — activity refresh and native lifecycle
- `https://www.daytona.io/docs/en/persistence.md` — CPU container vs GPU disk behavior
- Published `@daytona/sdk@0.223.1` declarations/implementation checked against injected boundaries (local; no authenticated client).

SkyPilot:
- `https://docs.skypilot.ai/en/latest/reference/cli.html`
- `https://docs.skypilot.ai/en/stable/reference/auto-stop.html`

Modal:
- `https://modal.com/docs/sdk/js/latest/Sandbox`
- `https://modal.com/docs/sdk/js/latest/ContainerProcess`
- `https://modal.com/docs/sdk/js/latest/Image`
- `https://raw.githubusercontent.com/modal-labs/modal-client/main/js/package.json`

E2B:
- `https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/sandbox/index.ts`
- `https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/sandbox/sandboxApi.ts`
- `https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/package.json`
- `https://docs.e2b.dev/sdk-reference/js-sdk/v2.52.1/sandbox-commands`

Harnesses:
- `https://opencode.ai/v2/docs/build/plugins`
- `https://cursor.com/docs/hooks`
- `https://cursor.com/docs/reference/third-party-hooks`
- `https://code.claude.com/docs/en/hooks`
- `https://learn.chatgpt.com/docs/hooks` (working official destination reached from Codex docs; the brief's generic URL was not used as a frozen schema)

Other design-only documentation:
- `https://devpod.sh/docs/developing-providers/quickstart`
- `https://mutagen.io/documentation/synchronization`

Notable source-driven decisions: Modal uses `regions`, not `region`; its registry
image construction is synchronous and sandbox lifetime is not VM stop/start.
E2B resource allocation is template-owned and its inspected lifecycle uses
`onTimeout` / `autoResume`. The historical OMP user shell could not reuse Pi's operations shape; OMP support is now removed.
Codex replacement requires an allow decision, so activation is explicit. OpenCode
v2 shell hooks are not represented as v1 plugin compatibility.

## Native management UI references

Pi 1.1.0's installed `docs/extensions.md`, `docs/tui.md`, `examples/extensions/tools.ts`
and `pi-tui` component declarations/implementations were checked directly. They own
`registerCommand`, `ui.custom`, SelectList/SettingsList, native selection keybindings
and terminal width/rendering. The packages declare MIT licensing and are supplied
by Pi rather than bundled here. The management entry uses static host imports so
Pi's loader mapping applies; helper `.mjs` imports alone cannot supply that mapping.

Clack's current npm `@clack/prompts@1.8.1` / `@clack/core@1.5.1` implementations and
MIT licenses were checked, including multiselect Space/Enter and Esc/Ctrl+C
cancellation, initial values and stream/TTY handling. The small dependency tree is
consumed intact, not copied or reimplemented; standalone PTY tests verify its actual
behavior. Upstream references: [Pi TUI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md),
[SelectList](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/select-list.ts),
[SettingsList](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/settings-list.ts),
[Clack](https://github.com/bombshell-dev/clack). Direct GitHub retrieval was unavailable
in this environment, so installed/npm interfaces, not assumptions about an old
GitHub checkout, were used. See [interactive management](INTERACTIVE.md).
