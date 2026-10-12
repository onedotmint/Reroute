# Architecture

## Ownership

```
Native agent shell / reroute shell
  -> Reroute PATH shims
  -> private versioned local IPC
  -> Coordinator: project lane, source sync, activity leases
  -> RuntimeProvider
  -> OpenSSH / native SDK command transport / SkyPilot-managed SSH
  -> Python supervisor in the isolated project runtime
```

One TypeScript package, not a monorepo of tiny packages. The Python supervisor has
only standard-library dependencies. `adapters/` contains host-loaded ESM entry
points; shared hook translation lives in `src/adapters/hooks.ts`.

Local source and Git are authoritative. A provider controls a remote sandbox,
cluster, container or SSH directory. It never becomes the source-of-truth Git
repository. The provider registry is injected at daemon composition time; Core
contains no vendor SDK or harness import. Test-only local transports are never
registered as production fallback providers.

## Contracts

`src/core/contracts.ts` defines project/runtime identities, explicit capabilities,
resource requests, binary execution events, cancellation, idle policy and guarded
file transfer. Providers own native create/reconnect, status, execution transport,
idle mapping, destroy and optional previews. Unsupported portable resources are
errors, including an explicit `spot = false` on a provider that cannot map it.
A structural SDK boundary is deliberately small, but has not replaced validation
against real SDK declarations; that missing verification is documented.

`src/core/routing.ts` is the only routing owner. Deterministic argv task rules separate heavy candidates from lightweight,
unknown and local identity/control work; explicit execution shares this safety core.
Adapters activate this boundary, not a new remote model tool or an LLM classifier.
`src/config/` exclusively owns config parsing, precedence and validation.

`src/core/projects.ts` owns UUID project identity and atomic local state. The
coordinator is the single writer. A copied identity at another real path fails
closed; `reroute enable --new-identity` is an explicit migration/reset operation.

## Concurrency and lifecycle

The daemon is lazy-started with a startup lock, authenticated by a private local
random token, on a Unix socket or native Windows named pipe. It refuses to start
another daemon if a recorded live process is unreachable. The socket is not an
HTTP network service.

Each project has a serialized mutation lane. Two agents reuse the same runtime
but foreground commands are serialized: they do not race file reconciliation.
Different projects can run independently. A dev process is long-lived; its periodic
sync and foreground sync share the project lane, not a second independent writer.
Native lifecycle calls are serialized, and generation checks prevent stale idle
callbacks from stopping a newly leased runtime. Stop invalidates previously accepted
foreground/dev/start/sync requests before they leave the lane; preparation checks the
same generation before starting a process. New work is rejected during stop/shutdown;
a completed project stop still permits a later deliberate restart. All active foreground
and dev handles receive cancellation before waiting for dev cleanup, which itself uses
the lane. Starting dev handles are tracked before awaiting EOF, and interrupted startup
reconciles generated source before releasing its lease.

Active work disables/extends provider idle controls. Successful source reconciliation
allows the last lease release to re-arm the configured idle deadline. Before execution
or reconciliation, persistent `syncPending` state and a retained activity lease protect
unreturned source. Failed reconciliation does not release that protective lease or
arm destructive idle; successful sync clears the marker and releases it. Pending-source
recovery uses the recorded running runtime, never `ensureReady` to replace it. A stopped original can be restored only through a supported identity-preserving
provider operation (Daytona), with paid authorization, or through native tools;
never through replacement provisioning. Setup/config changes do not resume it.

Graceful daemon shutdown cancels active processes and attempts pending reconciliation.
After success it restores native idle, or immediately stops a backend such as Modal
whose idle timer cannot outlive the daemon. On failed reconciliation it retains the
pending marker and does not request idle cleanup; native maximum lifetimes still apply.
Recovery validates index/project/provider/runtime identity before touching a resource.
Authentication reload holds the startup lock across old-process exit and replacement
readiness; a shutting-down server rejects ping and new work. Hard local host failure
and pending-source retention both carry billing risk; see SECURITY and LIMITATIONS.

## Remote execution protocol

The supervisor is passed as Python code, not installed system-wide. It starts a
new process group and frames stdout/stderr as base64 NDJSON. This keeps arbitrary
binary program data separate from transport control messages. It carries cwd,
argv, filtered environment, stdin, timeout and confirmed exit status. EOF on input
is distinct from cancelling the execution. Missing executables return 127;
permission denial returns 126. Missing cwd directories are safely created inside the
workspace without following symlink parents; invalid/outside cwd is a workspace error,
not a missing-executable error. A command without an exit acknowledgement is a
transport failure, never presumed success.

Stdin uses a bounded eight-frame (32 KiB each) acknowledged window and a separate
writer, so pipe backpressure cannot block cancellation/heartbeat reads. IPC cancellation
bypasses queued stdin. Its five-second transport-kill deadline starts before sending
cancel, including when the transport write itself stalls. Modal uses the pinned SDK's
independent `ContainerProcess.closeStdin()` RPC, not another write into the same stuck
stream: worker disconnect cleanup stops only its own process group. EOF waits can
finish when the command ends, even if the transport writer never settles.

Client disconnect cancels the process through the daemon. Supervisor heartbeat
loss is detected after approximately 45 seconds. TERM is followed by KILL; inherited
descendants are cleaned up. This is not a security boundary against processes
that deliberately escape their group/session. No PTY or arbitrary signal-forwarding
protocol is claimed.

## File synchronization

`src/sync/sync.ts` computes a three-way plan from the last agreed manifest, current
local source and current remote source. Transfers are incremental by content hash;
scans still traverse the source tree. Strict scans hash content incrementally; optional
in-process metadata reuse has a filesystem trust boundary, not a watcher-based guarantee
(see [hash validation](CONFIGURATION.md#hash-validation-and-reuse)). `assets/worker.py` mirrors the exclusion
policy, validates every path and enforces expected-content hashes on writes.
The initial RPC payload is streamed over stdin to avoid OS argv size limits.
Push operations use the existing worker's guarded batch support: up to 128 paths
or roughly 4 MiB of JSON per batch; one larger supported file travels alone.
Deletion batches precede writes. Baseline advancement remains all-success only.
Return transfers and conflict evidence use 64 KiB chunks with one acknowledged
chunk in flight; acknowledgement follows completed disk consumption. Incremental
hash/size checks and transport confirmation precede installation from a private
same-directory temporary. Local backups and expected-content checks also stream;
unverified temporaries are removed on failure. Legacy injected transports retain
their optional whole-file compatibility path, but all shipped providers use streaming.
Push batching remains unchanged. Explicit artifact retrieval uses this same transport/
project lane but cannot enter source reconciliation: exact build files go to a fresh
private download directory.

Local source writes are backed up; conflicts preserve remote copies and refuse
silent replacement. Symlink traversal, suspicious path components, secret names,
excessive file sizes and file counts fail closed. Runtime generation markers
ensure that a recreated empty workspace is not interpreted as deletion of the
local source tree. Reconciliation is optimistic and recoverable, not a filesystem
transaction across concurrent arbitrary writers. Excluded historical baseline entries
are forgotten without deleting either copy; current remote manifests remain strictly
validated. Planned deletions precede writes on both sides. A directory can become a
file only after all remaining directories are verified empty and unexcluded; unrelated
files, excluded content and symlinks are never recursively deleted. Impossible merged
file/child trees are conflicts before user-file changes. Local replacements recheck
expected hashes after backup/temp preparation. See LIMITATIONS.

## State and output

`~/.reroute/` holds only non-secret state, IPC token, owned shims/adapters, optional
SDK installations, redacted metadata logs and project references. `.reroute/`
inside a project holds its local identity, agreed sync manifest, conflict evidence
backup versions and isolated explicit artifact downloads; `enable` adds it to `.gitignore`.
Status reports local/coordinator observations without auto-start/provider calls;
unknown remote readiness and billing remain explicitly unverified. Effective paid
authorization is separate from auth presence and checked before core preparation.

The IPC token is a short local authorization secret, not a provider credential.
Provider credentials remain in provider-native stores/environment. Temporary
Daytona SSH access stays in process memory. It necessarily appears to same-user
process inspection as an OpenSSH username while that process is running.
Foreground output is streamed to the host and not durably duplicated. Dev output
has a bounded 1 MiB in-memory redacted tail; metadata logs rotate around 1 MiB.
