# Pre-test hardening

This report tracks the implementation and local evidence for R-01–R-07. It is not a live cloud compatibility certificate. Work started from clean commit `a67c306` on branch `hardening/pre-test`; no project-level AGENTS.md or CI existed. Charterleaf Auto was enabled with no living specs. Historical Outboard/Reroute TAP files are preserved unchanged.

## Phase A — CI and SDK baseline

- **R-01:** GitHub Actions runs Node 22/24 and Python 3 with read-only repository permissions, a 20-minute timeout and no cloud credentials. A temporary compile checks committed `dist/` before any build. An offline npm tarball install uses an isolated HOME, npm config/cache and prefix; both CLI entry points and the core export are checked. Regression tests prove stale/missing/extra dist files fail and ambient HOME/config remain untouched.
- **R-02:** `@daytona/sdk@0.223.1` is pinned exactly. Both `@daytona/sdk` and the older `@daytonaio/sdk` name published 0.223.1 when inspected on 2026-10-11; the selected name matches current official examples and the existing Reroute installer. Actual declarations check the injectable client/sandbox boundaries and create overloads. Real SDK error classes exercise 401/403/404/429/500 and transport failures without constructing a client. Only typed HTTP 404 is treated as missing. Create/start/stop/delete have bounded SDK operation timeouts. These are declaration and local-boundary checks, not live acceptance.

Commands run: `npm run build && npm run verify:release`. Core and vendor declaration checks, build, dist parity, **182 local tests (182 pass, 0 fail, 0 skip)**, CLI smoke and clean offline tarball installation passed on Node 24.21.0 / TypeScript 5.8.3 / Python 3.14.4. The CI workflow itself has not run on GitHub. Local test suites require `npm run tools:install`; SDK packages are isolated in ignored `.tools/`, not core runtime dependencies.

Official evidence inspected:

- https://www.daytona.io/docs/en/sandboxes.md
- https://www.daytona.io/docs/en/persistence.md
- Published SDK `Daytona.d.ts`, `Sandbox.d.ts`, error declarations and `Sandbox.js`.

## Phase B — crash protection and source recovery

- **R-03:** Daytona retains a finite native auto-stop during active work (at least five minutes), with serialized, completion-paced one-minute `refreshActivity()` renewals. Daemon loss stops renewals; no hard TTL or auto-delete is used. Release/dispose/idle/acquire races cannot enqueue overlapping renewal work. Renewal failure reports an error, cancels active execution and invalidates coordinator warmth before retry. Native auto-delete is explicitly disabled (`-1`); GPU, Spot, VM, unknown classes and existing hard-TTL/ephemeral sandboxes fail closed. Snapshot metadata is checked before creation. Archive remains distinct from stop/delete. Signed browser preview links expire after five minutes and are generated anew by `dev open`.
- **R-04:** Optional provider restoration resumes the original stopped/archived runtime, never creates a replacement. Core validates provider/project/ID/root/generation and shutdown guards. Daytona checks native labels and read-only remote ownership/generation/root (including symlinks). Failed resume, changed identity, unknown/missing runtime, transfer failure and conflict retain pending state and baseline; explicit destroy reconciles pending source first. Cold background recovery does not implicitly resume paid compute. A named sandbox without recorded runtime/generation now fails closed, including an interrupted create-before-state-save; recover native files/original project state deliberately rather than silently adopting it.

Commands run: `npm run build && npm run verify:release`. Dist parity, both typechecks, build, **249 local tests (249 pass, 0 fail, 0 skip)**, smoke and isolated offline npm install passed. Earlier original-runtime recovery tests also passed on Node 22. These exercise fixtures/real local workers, not cloud API, disk persistence, billing or native Pi compatibility; those remain **UNVERIFIED**.

## Remaining phase

Phase C (R-05/R-06/R-07) must implement local-only sync preview, explicit/reversible adapters and route explanation. Current gate: **NOT READY** until those local changes and their regression gates are complete. No live calls, paid resources, global agent settings, pushes or npm publication were performed.
