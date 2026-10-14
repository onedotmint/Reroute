---
id: engineering.pi-tool-ownership
applies_to:
  - src/pi.ts
  - adapters/pi.ts
  - tests/pi*.test.mjs
  - tests/native-package.test.mjs
  - tests/ssh.integration.mjs
  - scripts/verify-pi-git.mjs
---
# Pi execution ownership

The accepted integration boundary is documented in [README — Independent Pi tool](../../README.md#independent-pi-tool): Reroute owns only its compute tool and management command; ordinary Bash remains owned by Pi/AFT. Preserve that boundary when changing Pi adapters, including refusal without execution for local routing and no local retry after remote failure. Registration/loading evidence does not establish real-model tool-selection accuracy.
