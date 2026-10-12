---
id: paid-activation
applies_to:
  - src/cli/main.ts
  - src/cli/setup.ts
  - src/config/config.ts
  - src/core/coordinator.ts
  - tests/integration/paid-consent.test.mjs
---

# Presence is not authorization or authentication

Credential discovery reports only the current CLI environment, never verified
account access or the coordinator's inherited environment. Setup/provider
selection and detected agent installation are separate from consent to paid
compute. Effective paid authorization must name the selected provider before
core preparation can create, resume or replace compute; legacy project state is
not an implicit grant. Denial retains runtime, pending source and baseline.
Use vendor budgets and lifecycle interfaces, not estimated zero-cost claims.

# Reducing cost does not discard source

Revocation is not stop/delete. A deliberate stop can reconcile an already-running
original runtime before stopping it, even after revocation; it cannot use this
exception to resume stopped paid compute or provision a replacement. Ordinary
stop of a clean stopped/archived runtime must not resume it just to stop it again.
Destruction still requires original-source reconciliation. Status and configuration
updates never activate a runtime, including when pending source is recorded.
See [configuration](../../docs/CONFIGURATION.md) and
[cost boundaries](../../docs/SECURITY.md#billing-and-lifecycle).
