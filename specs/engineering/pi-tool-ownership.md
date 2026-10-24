---
id: engineering.pi-tool-ownership
applies_to:
  - src/router.ts
  - tests/router.test.mjs
  - tests/engine.test.mjs
  - src/pi.ts
  - src/history.ts
  - tests/pi-model-selection.mjs
  - src/engine.ts
  - tests/inspection.test.mjs
  - adapters/pi.ts
  - tests/pi*.test.mjs
  - tests/native-package.test.mjs
  - tests/ssh.integration.mjs
  - scripts/verify-pi-git.mjs
---
# Pi execution ownership

The accepted integration boundary is documented in [README — Independent Pi tool](../../README.md#independent-pi-tool): Reroute owns only its compute/status tools and management command; ordinary Bash remains owned by Pi/AFT. Preserve that boundary when changing Pi adapters, including refusal without execution for local routing and no local retry after remote failure. The status tool must authorize the canonical current-project root before contacting a provider or exposing a saved record. Preserve the [status confirmation boundary](../../README.md#job-status-without-the-cli): saved history or an online resource is not a freshly confirmed task receipt; failed verification cannot authorize a local rerun. Registration/loading evidence does not establish real-model tool-selection accuracy.

The coding agent chooses tools from task/project context; Reroute must not add a classifier, per-command model request or Bash interception. Explicit project scripts (package-manager scripts, direct project file invocations and named build targets) are a remote compute trust boundary, not a security audit: accept their implementation and lifecycle hooks without recursive proof; retain top-level shell/path restrictions, obvious authentication/deployment commands and resource-policy checks. Scripts can contain side effects; do not claim remote execution or command-name filtering makes untrusted project code safe. Refusal must explain that nothing ran without recommending local retry or claiming to control AFT. Optional project-history hints are bounded observations, not routing authority: at most three, from recent confirmed comparable receipts, never raw command/output/error text or a claimed local/cloud speedup. Missing or invalid history must not block the agent. Replace prior hints rather than accumulating messages, preserve other extensions’ prompt sections, and do not let historical success authorize retries or resource spending. See [README tool-choice/history boundary](../../README.md#independent-pi-tool).
