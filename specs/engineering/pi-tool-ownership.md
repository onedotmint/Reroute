---
id: engineering.pi-tool-ownership
applies_to:
  - src/pi.ts
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
