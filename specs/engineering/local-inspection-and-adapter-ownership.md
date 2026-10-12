---
id: local-inspection-and-adapter-ownership
applies_to:
  - src/cli/main.ts
  - src/cli/setup.ts
  - src/core/routing.ts
  - src/config/config.ts
  - src/sync/sync.ts
  - assets/worker.py
  - tests/integration/readonly-cli.test.mjs
  - tests/integration/setup-uninstall.test.mjs
  - tests/integration/sync-preview.test.mjs
---

# Inspection never activates execution

Local sync preview and routing explanation must not contact/start the coordinator,
create provider resources, execute the described command, create/repair project
identity, or change source/baseline/state. Sync preview uses metadata only: no file
content reads or hashes, including secrets and the baseline. It reports local scan
readiness, never remote readiness or conflicts. Excluded directories are pruned;
descendant inventories/counts are not implied. Filename risks are not DLP or proof
that included content is safe to upload.

Explain shares the execution routing rules rather than implementing a second rule
set. Keep configured policy distinct from interception eligibility and project/local
recursion overrides. Control/identity operations stay local even if users list them
as runtime commands. PATH shims do not comprehensively intercept absolute paths,
wrappers, aliases, package-script bodies or unhooked tools. An explanation must not
promise otherwise or imply remote failure will fall back locally.

# Exclusion policy cannot diverge by transport

Local TypeScript scanning, preview and the Python worker must agree on matching and
ancestor pruning. Minimum credential/build/state exclusions cannot be undone by
user patterns. Unsupported pattern syntax fails explicitly rather than silently
matching differently in each language. The supported syntax and pruning limits are
owned by [configuration documentation](../../docs/CONFIGURATION.md) and executable
cross-language tests, not by generic Git-ignore or platform glob libraries.

# Detection and ownership are not consent

Default setup does not install a detected harness. Installation requires an explicit
selection; Codex's approval-changing hook requires its separate explicit trust opt-in.
Do not replace the native Bash tool definition/permissions with a remote model tool.

A marker comment, filename, command substring or historical command list does not
prove ownership of current contents. Reinstall/repair/uninstall may act only on
recorded content hashes or exact owned hook entries, within the current expected
homes, without following symlinks. Preserve user edits, malformed configuration,
unrelated hooks/settings, backups and runtime/source state. Doctor must not turn
mere discovery into installation or silently restore a deliberately uninstalled
adapter. Legacy installations without exact ownership are conservatively preserved.

Removed OMP support retains registry compatibility for explicit safe cleanup only;
never reinstall it or select it in default uninstall. See the
[legacy OMP migration boundary](../../docs/HARNESSES.md#legacy-omp-migration-no-longer-supported).

Uninstalling an adapter is not disabling a project, destroying a runtime, purging
credentials/SDKs, restoring an entire config backup or proving zero cloud charges.
See [harness boundaries](../../docs/HARNESSES.md) and
[security limitations](../../docs/SECURITY.md).
