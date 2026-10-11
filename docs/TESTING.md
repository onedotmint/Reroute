# Testing

## Local suites

After `npm run tools:install`, `npm run verify:release` checks committed `dist/`
against a temporary build **before rebuilding**, checks core and real pinned Daytona
SDK declarations, builds, runs every non-live suite, CLI smoke and offline tarball
installation in an isolated HOME/prefix. After source edits, build before this gate.
`npm test` alone does not rebuild and now requires isolated developer tools/SDKs;
missing tooling fails instead of silently skipping release tests. No cloud auth is needed.

- Unit: deterministic routing, inline env filtering, TOML/config validation,
  unsupported resources, safe paths, exclusion rules, three-way planning and lanes.
- Provider contracts: all five production classes; native SDK/CLI boundary fixtures,
  real remote-supervisor child processes, real sync/read/write, stream/exit/stdin,
  cancellation, identity reuse, native idle mapping and destruction.
- Worker/sync integration: byte streams, stdin, timeout, cancellation, transport
  corruption/loss, symlink/path refusal, secret/build exclusion, conflict/deletion,
  stale hashes, source limits and a 1 MiB payload transferred through stdin.
- Coordinator integration: two agents, one runtime, serialized mutations, fail
  closed, cancellation/release, nonzero-result reconciliation, recreation safety,
  dev leases and stale idle callback races.
- CLI/daemon integration: real CLI child process and private IPC with injected
  test transport; setup discovers a fixture Pi directory; enable, shell composition,
  remote-directory execution, local Git, persistent remote cache, streams/exit,
  explicit local override, auth rejection, client crash and open-stdin exit.
- Harness fixtures: Pi/OMP/Claude/Codex/Cursor/OpenCode/DeepSeek protocols and safe,
  idempotent installation/merging. Native host products are not launched.

The injectable test transport executes in a **separate local directory on the same
machine**, not a remote cloud host. Fake SDK/native-CLI records test our wire
mapping while actual subprocesses test supervisor behavior. This distinction is
part of the assertion/report contract, not a hidden substitution for live tests.

Behavior regression files added after the project review:

- `tests/integration/cancellation.test.mjs`: unread/full stdin cancellation, timeout,
  stalled cancellation sends, slow readers, ordered concurrent writes and EOF.
- `tests/integration/coordinator.test.mjs`: stop/shutdown cancel queued foreground/dev
  work and preparation, mixed already-running dev/foreground work, and startup with
  permanently blocked EOF; generated startup source returns locally. Stop still allows
  a subsequent deliberate restart.
- `tests/contract/modal-cancel.test.mjs`: the actual Modal provider with a stuck SDK
  WritableStream uses independent native EOF; another worker in the sandbox stays alive.
- `tests/integration/cli-daemon.test.mjs`: cancellation bypasses queued IPC stdin.
- `tests/integration/sync-regressions.test.mjs`: policy changes, both-direction type
  conversion, out-of-order worker apply, excluded/nonempty/symlink protection,
  structural conflicts, editing races, agreed-baseline preservation and failure retry.
- `tests/integration/cwd.test.mjs`: empty nested cwd for foreground/dev execution,
  cwd bounds/symlinks/file blockers, missing executables and permission errors.

Additional release-fix regression code (not executed in the original repair round;
**passed locally in the 2026-10-11 follow-up**, as part of 154 tests with no failures or skips):

- `coordinator.test.mjs`: startup destruction preserves generated source, failed return
  sync retains local/native idle protection, pending state survives shutdown/recovery,
  stopped/unknown resources cannot bypass reconciliation, and identity reset/index safety.
- `cli-daemon.test.mjs`: timeout/cancellation remain nonzero when the child handles TERM
  by exiting 0; the CLI maps those outcomes to 124/130 without changing the worker result.
- `auth-reload.test.mjs`: slow legacy daemon exit, startup-lock contention, replacement
  PID/environment, bounded failure, authentication rejection and shared close completion.
- `providers.test.mjs`: graceful shutdown terminates a Modal fixture sandbox rather than
  abandoning its local idle timer. `coordinator.test.mjs` also covers retaining the configured
  deadline for native-idle providers.
- `sync-regressions.test.mjs`: conflict evidence path collisions, merged file-count limit,
  legal 255-byte filenames in both directions, long-name conflict copies and reserved temps.

The above 154-test follow-up is historical. Current hardening results and checkpoints
live in [HARDENING.md](HARDENING.md); the controlled native trial checklist is
[LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md). The follow-up also passed typechecking and CLI
smoke; a temporary rebuild matched the existing `dist/`. These results come from the
session output, with no new archived TAP or commit association. Earlier passing TAP
records remain historical and do not verify the new changes. Live providers, native
harnesses and package installation were not tested in that historical follow-up.
The later hardening gates do verify isolated offline installation; native/cloud
compatibility remains unverified.

## Live providers: opt-in and potentially billable

Default `npm run test:live` emits five explicit skips when not configured.
Credentials are not required for core tests. To deliberately test one existing SSH
host (Python 3 required):

```sh
REROUTE_LIVE=1 REROUTE_LIVE_PROVIDERS=ssh \
  REROUTE_SSH_HOST=my-build-host npm run test:live
```

For a managed provider, first install/authenticate its native SDK/CLI, then select
it explicitly with `REROUTE_LIVE_PROVIDERS=daytona` (or modal/e2b/skypilot).
`REROUTE_LIVE_CONFIG_ROOT` can point at a directory containing a reviewed
`reroute.toml`. Each run creates a unique owned runtime, syncs/executes/reconciles
and tries cleanup. A failure between native creation and returning a handle can
require native manual cleanup by the Reroute UUID/name. Modal named volumes are
not deleted automatically. Do not run these tests against a production workspace.

These live tests cover basic provider execution, not a complete provider account
certification. Manually verify previews, persistence after native idle/reconnect,
resource quotas, hard-crash billing and native agent behavior before deployment.

## Delivery evidence and regressions

Original delivery outcomes are in [the historical report](verification/ORIGINAL-DELIVERY.md)
and `docs/verification/`. These predate the Reroute rename and are not a new run. Earlier runs found
and fixed a Python buffered-stdin daemon-thread shutdown failure, large-RPC argv
limits, runtime-recreation baseline risk and CLI stdin-pipe exit hang. A dev log
test now waits for its actual readiness output instead of assuming a fixed 150ms
startup. A CLI test fixture handles the expected EPIPE when a short native command
closes unused stdin; exit/output assertions remain in place.

Two foreground tool invocations were terminated by the outer execution timeout
before complete provider-suite reporting. A subsequently completed six-test
provider contract run is retained as evidence; timed-out runs are not called passed.
No failing production assertion was removed, no network test was reported green
through a mock, and no cloud credentials were fabricated.

## Build and package evidence

`npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
succeeded for the dependency-free core. Registry and GitHub DNS failures are recorded
in PREFLIGHT. `scripts/package.mjs` archives a clean canonical commit, adds generated
provenance only, validates/extracts the zip, rejects secret/cache paths, runs the
extracted CLI and executes extracted unit/harness tests. The deliverable's checksum
and exact commit are written to `reroute-packaging-report.json` outside the source
tree and `DELIVERY-STATE.json` inside the archive.

## Pre-test hardening regressions

- `unit/release-validation.test.mjs`: stale/missing/extra dist and isolated offline package gates.
- `sdk/daytona-types.ts` and `contract/daytona-sdk.test.mjs`: installed 0.223.1 declarations,
  real SDK error taxonomy, bounded operation shapes, create-before-snapshot resource checks.
- `contract/daytona-lifecycle.test.mjs` and `unit/lifecycle.test.mjs`: long active work,
  finite crash-stop model, renewal faults/non-overlap/disposal, pending-source recovery,
  ownership/generation damage and warm transport checks; this is not a billing simulation.
- `integration/runtime-recovery.test.mjs`: stopped/archive restore of the same ID/root/
  generation, unknown/missing refusal, network retry/conflicts, shutdown races, baseline
  protection, explicit destroy after reconciliation and no implicit cold compute resume.
- `integration/sync-preview.test.mjs`: metadata-only no-write/no-hash preflight, shared
  exclusions, TS/Python limited-glob parity, unreadable/type/symlink and limit diagnostics.
- `integration/setup-uninstall.test.mjs`: isolated agent HOME, explicit activation,
  content/exact-entry ownership, user edits and unrelated settings, legacy refusal,
  missing files, malformed JSON and symlink protection; no actual host is launched.
- `integration/readonly-cli.test.mjs`: stable/readable local-only sync and explain,
  no daemon/identity/baseline/resource side effects, routing/override/interception limits.

Node 22 MockTimers currently emits an experimental API warning; that is not a skipped
assertion. GitHub matrix results must be reported separately from local Node checks.
