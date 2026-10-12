---
id: source-runtime-safety
applies_to:
  - src/core/coordinator.ts
  - src/core/projects.ts
  - src/core/lifecycle.ts
  - src/core/contracts.ts
  - src/providers/common.ts
  - src/providers/daytona.ts
  - src/providers/ssh.ts
  - src/config/config.ts
  - src/sync/sync.ts
  - tests/integration/runtime-recovery.test.mjs
  - tests/contract/daytona-*.test.mjs
  - tests/contract/ssh-workspace.test.mjs
  - tests/integration/sync-batches.test.mjs
  - tests/unit/lifecycle.test.mjs
---

# Pending source binds to the original workspace

A persisted pending-source marker means remote user source may be newer than local
source. It is not permission to provision an empty replacement, reset the agreed
sync baseline, delete the original resource, or initialize/repair missing ownership
metadata. Failed restoration, identity verification, transfer or conflict must retain
pending state and the agreed baseline. Explicit destruction reconciles source first.
Conflict evidence and guarded hashes/backups remain part of reconciliation; a fresh
local scan is not a substitute for the snapshot actually agreed by both sides.

A supported restoration must preserve provider, project, native runtime ID, remote
root and workspace generation. Validate returned identity without letting a provider
mutate the persisted reference. Stopped/archive restoration is deliberate user work;
cold background recovery must not implicitly resume stopped billable compute.
Unknown/connectivity/auth failures are not evidence of absence or permission to
replace/delete. Only the pinned vendor's authoritative typed HTTP 404 is absence.

For Daytona, validate native ownership labels and original workspace owner/generation,
including root/marker symlinks. Restoration is read-only with respect to ownership:
never manufacture a marker to conceal lost/replaced disk. Warm coordinator state is
not proof of remote disk identity; file and execution operations must still verify it.
A stable-name sandbox without a recorded runtime/generation is deliberately refused,
even after create-before-state-save failure. Native backup/original state recovery is
safer than silently adopting an unverifiable workspace.

For SSH, directory existence is not proof of owner/generation. A recorded workspace
must be verified before file/execution/destruction operations, never initialized
to repair lost ownership. Destruction's absent-directory success requires the safe
original path; symlinks, ENOTDIR and connectivity failures are not absence.

Bounded transfer batches retain each path's expected hash, deletion-first order
and agreed-baseline-on-full-success semantics. A partial batch failure must remain
retryable without advancing the baseline or weakening conflict evidence.

# Crash-stop is not destructive expiry

Daytona source workspaces require persistent CPU containers. GPU/Spot/VM/unknown
classes, immediate-delete ephemeral semantics and hard TTL do not satisfy that
contract. Check explicit requests and snapshot metadata before provisioning, and
validate discovered resources before lifecycle/destruction side effects. Native
stop, archive and delete retain distinct meanings; source protection disables
native auto-delete rather than relying on a hard lifetime.

Active activity renewal must retain a finite native auto-stop, not disable it.
Renewal must be serialized, bounded and completion-paced so a slow API cannot
accumulate work; release/dispose/generation changes invalidate queued callbacks.
When renewal fails, report the failure and invalidate warm coordinator protection
before retry. Daemon death must cease renewal without needing a second local daemon
or cloud-auth watchdog. Pending source is protected by retained disk and identity-safe
resume, not by keeping compute billable indefinitely.

Vendor declarations and local fault fixtures do not establish live disk persistence,
billing or host compatibility. See [provider boundaries](../../docs/PROVIDERS.md) and
[controlled acceptance](../../docs/LIVE-ACCEPTANCE.md) for the operational boundary.
