# Security and cost boundaries

Reroute is an execution router, **not a security sandbox** or a credential manager.
The coding agent remains trusted to edit local files and issue its normally
permitted local control-plane commands. Provider isolation must protect the actual
remote execution host. Do not route untrusted code onto a sensitive shared SSH user.

## Credentials and local IPC

Provider authentication uses native environment/profile/SSH-agent configuration.
Reroute writes no provider-secret database and never copies the complete local
environment into a remote process. Config validation rejects common secret key
names; the default source policy excludes credential filenames/directories and
private-key suffixes independently of Git ignore rules. This is a denylist, **not
content-based data-loss prevention**. A secret hidden in an ordinary source file
may still sync. Review your repository before enabling any remote service.

User state is private; the Unix socket has mode 0600 and its parent directory mode
0700. IPC has a random local token and version check. The token authorizes same-user
local access and is not a cloud credential. Native Windows ACL equivalence has not
been verified; WSL is the supported Windows route. Same-user processes can already
read user state; Reroute is not a boundary against a compromised local account.

Daytona temporary SSH tokens are retained only in memory. OpenSSH necessarily
receives the short-lived token as its username, which is visible to appropriate
local process inspectors while the transport exists. Native errors are not blindly
printed because they can contain auth URLs. Metadata logs never intentionally
store argv, full env, provider responses or credential values.

Foreground program output is faithfully forwarded to the agent. A program that
prints its own secret can expose it to that agent; Reroute does not silently alter
build/test output to claim perfect secrecy. Dev log tails are redacted heuristically,
which cannot guarantee removal of arbitrarily transformed secrets.

## Source integrity

The remote supervisor and local synchronizer validate paths, reject symlinks,
check content hashes before writes, preserve conflict copies and back up replaced
local versions. Large returns, backups and conflict evidence are streamed; unverified
content stays in private temporary files and is not installed as source. Strict scans
remain the default. Explicit metadata hash reuse assumes ordinary Linux/ext4 change-time
behavior; it is not a full-content integrity proof, and strict mode should be retained
for privileged writers, snapshot restores and untrusted metadata. See
[hash validation](CONFIGURATION.md#hash-validation-and-reuse).
They do not provide an atomic distributed filesystem transaction.
Another process editing a file in the tiny interval after its final comparison
can still race a replacement. Backups help recovery; adversarial races and hostile
remote manifests require a stronger sandbox/filesystem design.

Do not run two separate coordinators or manually mutate the same remote workspace
from another tool during Reroute sync. One daemon serializes ordinary project
commands; lifecycle and sync contracts are not a general multi-writer consensus
protocol. `reroute sync --accept-local` is explicit destructive conflict resolution,
not a routine way to ignore unreviewed changes.

## Agent permissions

Read HARNESSES before activation. In particular, Codex's inspected rewrite protocol
requires an allow decision. Its automatic bridge is opt-in, not installed merely
by detection. Reroute does not change native agent sandbox policies to force a
bridge to work. Absolute executables, replaced PATH and unhooked host tools can
bypass routing. Fail-closed applies to intercepted commands, not every imaginable
execution path available to an agent.

## Billing and lifecycle

Paid preparation requires explicit effective `authorization.paidProviders` for the
selected provider (`setup/enable --allow-paid`). Credentials, provider selection
and legacy enabled state are not consent. `--revoke-paid` does not stop resources;
an already-running original can still be safely reconciled/stopped, never replaced
or resumed under that exception. See [configuration](CONFIGURATION.md#paid-resource-authorization-and-authentication).
Status is local/coordinator metadata only: remote readiness is UNVERIFIED and
billing UNKNOWN. No status query automatically starts the daemon or calls providers.

Graceful idle/shutdown behavior is implemented; the latest release fixes passed
local regression tests on 2026-10-11, not live cloud validation (see PROJECT-REVIEW).
Daytona keeps finite native auto-stop (at least five minutes while active), with
serialized one-minute activity renewal. Daemon loss stops renewal; documented
CPU-container stop/archive preserves disk. GPU/Spot/VM/TTL source workspaces and
auto-delete are rejected. Native behavior and billing remain live **UNVERIFIED**.
SkyPilot still disables active native autostop; a hard host crash can leave it running.
Worker heartbeat cleanup is not cloud shutdown. There is no independent cloud watchdog.

Failed source reconciliation keeps a persisted `syncPending` marker and a protective
lease instead of arming destructive idle. `reroute status` exposes this state; resolve
conflicts/transport failures and synchronize to release it. A stopped original runtime
can be resumed by `reroute sync` for Daytona after original ID/ownership/generation
validation; other providers without restoration require native resume. Reroute will
not create an empty replacement or delete it without reconciliation. Shutdown attempts a final sync; failure leaves the marker and
native active policy, rather than knowingly cleaning up unsaved source. This can keep
resources billable. It is not an independent watchdog or an unlimited preservation
promise: E2B/Modal plan and lifetime limits, API failures, and host loss still apply.
Keep native backups and recover pending source promptly.

Use provider-side budgets and alerts. Do not put destructive maximum-lifetime controls
on source workspaces with pending changes; Daytona hard TTL is intentionally unsupported. Check native
provider state after a host crash. Modal has a finite sandbox lifetime, not a VM
idle setting. E2B has native timeout/plan limits. SSH idle does not power off a
machine. Named Modal volumes remain after runtime deletion and may retain data or
storage costs. This delivery makes no guarantee that idle costs reach zero.

## Destruction

SSH deletion checks the Reroute UUID/owner marker before removing its directory.
Cloud destroy operations use the persisted provider handle. Project identities and
native stores must not be copied between unrelated repositories. Keep backups of
local source and review `reroute stop --destroy` semantics for your provider.

## Read-only preflight and adapter ownership

`sync --dry-run` and `explain` are local-only inspection, not execution or remote
conflict detection. Neither may start IPC, create/repair identities or write a sync
baseline. Filename exclusions and sensitive-name warnings are not DLP: inspect the
included list yourself. The command argv and relative file names may themselves be
sensitive; do not share raw JSON reports indiscriminately.

Default setup never installs a detected harness implicitly. Explicit setup/uninstall
operate on owned adapter entries; uninstall preserves changed files and unrelated
hooks/settings. It is not a runtime destroy, credential purge or total config rollback.
Codex's explicit approving-hook opt-in remains a separate trust decision.
