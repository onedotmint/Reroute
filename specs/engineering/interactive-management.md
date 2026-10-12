---
id: interactive-management
applies_to:
  - src/cli/manage.ts
  - src/cli/wizard.ts
  - src/cli/main.ts
  - adapters/pi.ts
  - adapters/pi.mjs
  - adapters/pi-panel.mjs
  - tests/harness/pi-panel.test.mjs
  - tests/integration/wizard.test.mjs
  - tests/integration/manage.test.mjs
---
# Management is not activation

Pi commands and standalone setup must use the same project configuration and
coordinator save/management path, not a second state store or model-facing tool.
Opening/refreshing the panel and default status/diagnostics are read-only: no daemon
startup, provisioning, resume or inferred paid grant. Distinguish coordinator
metadata from explicitly requested live vendor state; unknown is not absence.
Cancellation before confirmation must leave configuration/resources unchanged.
Preserve original runtime identity and pending source when a switch cannot proceed.
Changing the SSH endpoint is a workspace switch, not a harmless same-provider edit.
The existing [paid activation](paid-activation.md), [runtime/source ownership](source-runtime-safety.md)
and [adapter ownership](local-inspection-and-adapter-ownership.md) boundaries remain authoritative.

Use Pi's host components inside Pi and Clack only for standalone TTY setup. Keep
host SDK imports in the loader-managed entry point: native ESM imports from helper
files do not receive Pi's module mapping. Do not install/bundle a second Pi runtime
to repair that resolution. See [interactive management](../../docs/INTERACTIVE.md)
for loading, automation, cancellation and verification boundaries; task policy
semantics are owned by [configuration](../../docs/CONFIGURATION.md#interactive-task-selection).
