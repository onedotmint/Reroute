---
id: task-policy-and-artifacts
applies_to:
  - src/core/routing.ts
  - src/config/config.ts
  - src/core/coordinator.ts
  - src/sync/artifacts.ts
  - src/providers/channel.ts
  - assets/worker.py
  - tests/unit/task-routing.test.mjs
  - tests/integration/artifacts.test.mjs
---

# Classification is not activation

Task classification must remain deterministic and local: no model, repository-wide
analysis, remote API, or resource activation. Transparent routing is conservative
on unknown interpreter/scripts and shell wrappers; explicit argv execution can
opt out of task eligibility but never control/identity exclusions. Keep explain
and execution on the same classifier. Existing explicit executable policies have
an observable legacy migration path; do not silently reinterpret them. The exact
policy and migration are owned by [configuration](../../docs/CONFIGURATION.md).

# Artifacts do not enter source reconciliation

Explicit artifact retrieval is a separate read operation on the recorded runtime,
not a second source coordinator or permission to provision a new workspace.
Preserve credential/symlink/path/size protections even below excluded build roots.
Never merge downloads into source, caches, the agreed manifest, or an existing
local output. Downloads are private, non-executable and isolated per retrieval;
failure may retain clearly identified partial output, not advance source state.
See [artifact limits](../../docs/CONFIGURATION.md#source-cache-and-artifacts-are-separate).
