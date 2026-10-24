---
id: engineering.managed-cloud-safety
applies_to:
  - src/resources.ts
  - src/providers/daytona.ts
  - src/providers/e2b.ts
  - src/providers/modal.ts
  - src/config.ts
  - src/setup.ts
  - src/auth.ts
  - src/snapshot.ts
  - src/providers/ssh.ts
  - tests/security-boundaries.test.mjs
  - tests/providers.test.mjs
  - tests/auth.test.mjs
  - tests/snapshot.test.mjs
  - tests/wizard.test.mjs
  - tests/quick-setup.test.mjs
  - src/cli.ts
  - src/engine.ts
  - src/pi.ts
  - assets/task.py
  - tests/managed*.test.mjs
  - tests/persistent-cache.test.mjs
---
# Managed cloud safety

Managed Daytona/Modal compute is opt-in and must preserve the existing-resource path for other providers. For attached providers, preserve the [no implicit start contract](../../README.md#independent-pi-tool): a preceding running-state check cannot make an auto-resuming connection API safe against a concurrent pause. The user's 0.3 product contract requires explicit billing authorization, separate named credentials, resource ownership, deterministic capability/cost checks, and no local source writeback. A named credential must not fall back to another account's environment or native credentials. Masked setup must refuse to save credentials inside the project/repository; snapshots must exclude the actual private credential-store path (including relocated named accounts and tracked files) and native Modal token files. A generic filename exclusion alone is insufficient for arbitrarily named accounts. Excluding a configured identity path requires comparing canonical filesystem identity, not the configured string: `realpath` the private path (falling back to `resolve` only when the target is absent, so a not-yet-created key still cannot be uploaded) and expand `~` before that, then refuse the snapshot outright when the project overlaps the credential store. Comparing raw configured strings lets a symlinked project root or a `~`-relative configuration upload the key it claims to exclude. Also exclude native Git/Docker/Kubernetes/GnuPG credential stores and every configured SSH identity file, including nonstandard filenames. SSH transport must disable agent, X11 and port forwarding so project scripts cannot inherit access to local authentication agents or forwarded services; native local SSH authentication remains available.

Selecting multiple providers is configuration, not authorization to use each one. Preserve unselected/existing profiles and their credential/resource references; do not silently overwrite an account when adding another. Before the final save confirmation, cancellation must leave project settings and newly entered credentials unwritten. A simpler defaults path must still expose reviewed rates, separate account budgets and explicit default-off spending consent.

Before a billable API call, persist an allocation intent outside the project. A failed creation response does not establish that no resource exists: discover the original owned allocation, never silently create a replacement. Online resource state is not task completion. Active or unresolved jobs block new allocation and destructive lifecycle actions; credential aliases must not bypass protection of the same owned resource or confirmed provider/resource ID. Recovery must not clear remote task locks or invent termination. If allocation is confirmed and cancellation occurs before task entry, stop that unused compute and record the confirmed release; retain uncertainty when stopping is not acknowledged.

Ordinary idle reclamation must not interrupt an in-flight task. Set supplier-side guard windows longer than the task deadline before execution; only shorten them after confirmed termination. Client exit/detach is not a stop acknowledgement. Terminal receipts, cache publication and lock release require termination of task descendants, including processes that detach into new sessions; an empty original process group alone is insufficient. Symmetrically, a process group is not ownership evidence: a recycled PGID must never authorize signalling, so cleanup resolves the actual descendant tree, re-checks each PID's start time immediately before signalling, and sends no signal to a group with no supervised descendants. Cancellation observed during cache preparation must prevent subsequent command launch. Retained Volumes can continue to incur storage costs even after compute destruction.

Fee reservations are conservative local estimates, never official credit/balance or an absolute spending guarantee. Do not assume gifts/free tiers are available, rotate accounts, or use private billing RPCs as a stable official balance API. Capability or quota failures must remain failures, not silently downgraded CPU/memory.

Persistent download caches must be separated from scratch compilation, source, receipts and artifacts. Bound cache I/O inside the execution guard/transport margin; a slow or failed cache is a warned miss, not a reason to kill a running build or replace its exit code. Network Volume persistence is not proof of faster execution or durable final writes; report cold/warm timings and retain live acceptance gaps. Keep [Pi ownership](pi-tool-ownership.md), [source/cache trust boundaries](../../README.md#source-inputs-caching-and-artifacts) and [user-facing operational limits](../../README.md#managed-cloud-profiles) discoverable.

Treat mounted download-cache storage as non-transactional, not as POSIX scratch: [Daytona Volume limitations and shared-write semantics](https://www.daytona.io/docs/en/volumes/#limitations) do not guarantee atomic replacement. Cache publication must not depend on Volume directory/permission mutation or rename; keep prior usable data until a new ordinary-file archive is closed and verified, retain a verified previous generation for fallback, and reject interrupted generations during restore. A recorded save success means verified publication, not merely elapsed save time or task exit zero, and is not proof of durability across sandbox lifetimes. Diagnostics must identify the failing cache phase/errno without serializing private paths or raw provider errors.

The fixed `/var/reroute-cache` entry may be a Modal-managed symlink only when its immediate absolute target is `/__modal/volumes/vo-<alphanumeric ID>`. Validate the mount parent, target and target ancestors without following further links; keep archive files, archive members, scratch, source and artifact link checks unchanged. Other mount layouts fail closed as cache warnings/misses, not arbitrary path resolution.

Modal provider commands use a non-login shell to preserve the image environment, including toolchain PATH and RUSTUP_HOME. The task supervisor may redirect CARGO_HOME to download-cache scratch without changing RUSTUP_HOME; do not depend on login profiles or modify another provider to repair this Modal execution boundary.


## User defaults and per-project consent

The recommended native Pi package install is global. `reroute setup` saves user account references, compute defaults, budgets and admission policy at `$XDG_CONFIG_HOME/reroute/config.json` (fallback `~/.config/reroute/config.json`); `setup --project` preserves the explicit project configuration path. Resolve built-ins → user defaults → project top-level overrides. Merge only named profile maps; a named project profile replaces its entire user-default profile. Never deep-merge policy objects, silently migrate/delete existing project config, or interpret a parse failure as missing configuration.

Every remote run must verify a private local authorization receipt for the canonical current project and provider/account target **before snapshot preparation, upload or billable APIs**. Provider policy authorization alone is insufficient, including for preexisting v3 configurations. Pi may obtain an explicit user confirmation; noninteractive tools refuse until the user authorizes via the CLI. Neither a field in project source nor a model-supplied tool parameter can grant consent. Target/account changes need new consent; canonical aliases reuse consent. Revocation does not cancel running jobs or delete cloud resources. Global defaults never collapse the existing installation/project/profile ownership identity or account-wide reservation envelope.

Environment declarations are read-only bounded hints, not executable configuration or evidence that an image satisfies them. Exclude the actual relocated user config and local state directories from source snapshots, in addition to credentials. No implicit provider failover, retry, new task classifier, Bash interception or dependency/image installation is introduced by global defaults.
