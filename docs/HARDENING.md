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

## Phase C — local inspection and explicit/reversible adapters

- **R-05:** `reroute sync --dry-run [--json]` reports local included/excluded paths/reasons, count/bytes/limits, symlinks/unsupported types, sensitive-name risks and local readiness. It reads metadata only: no source contents/hashes, baseline/identity writes, daemon/provider/resource creation or remote conflict claim. Excluded directories are pruned. Scan blockers produce an actionable report/exit 65. Local and Python worker exclusions now agree on rooted/basename patterns, `*`, `?`, complete `**` segments and ancestor pruning; unsupported syntax fails explicitly. Mandatory security/build/state exclusions remain non-removable.
- **R-06:** Default setup is Reroute-only; detected hosts are informational. `--harness` is explicit. `reroute uninstall [--harness ...]` removes only content-hash-matching owned adapter files or exact owned hook entries, preserves user changes/unrelated configuration/backups/resources, and is idempotent. Marker comments/legacy command history alone cannot authorize overwrite/removal. `doctor --fix` repairs only explicitly recorded safe ownership, not detected hosts. Symlinks/malformed JSON/out-of-home paths fail closed. Codex's approving-hook opt-in is unchanged.
- **R-07:** `reroute explain [--json] -- pnpm test` reuses execution's routing decision and reports matched rule, enabled project/provider, configured route, actual transparent PATH eligibility, overrides and limitations. No command/daemon/remote state mutation occurs. Absolute paths, wrappers, aliases and hidden package-script operations are not falsely claimed as intercepted.
- Additional closure of a Phase B safety finding: warm Daytona file and execution operations now verify the remote owner/generation before each operation, not just cold restoration; a changed disk cannot be trusted because coordinator state is warm.

`npm run build && npm run verify:release` passed on Node **24.21.0**, followed by the complete `verify:release` gate under Node **22**. Each run passed **289 local tests (289 pass, 0 fail, 0 cancelled, 0 skip)** plus dist parity, core/vendor typechecking, build, smoke and isolated offline tarball installation. TypeScript 5.8.3 and Python 3.14.4 were used. Node 22 emits the expected experimental MockTimers warning. GitHub CI has not been executed remotely.

## Gate and remaining verification

Local hardening R-01–R-07 is complete: **READY FOR CONTROLLED DAYTONA TEST**, not production-ready or live-certified. Follow [LIVE-ACCEPTANCE.md](LIVE-ACCEPTANCE.md) only after explicit account-owner authorization, cost ceiling and cleanup ownership. Real Daytona API/auth, long-lived activity, retained disk across native stop/archive, browser preview, Pi compatibility and native resource/billing cleanup remain **UNVERIFIED**. Other providers and Windows/macOS are not certified by these checks.

No live calls, paid resources, real global agent settings, pushes, PR/issues or npm publication were performed. Historical TAP evidence is unchanged. Local checkpoints: Phase A `2403eec`, Phase B `1cced62`; Phase C is the commit containing this section (obtain its SHA from Git).

## Safety review and scope

Preserved local source/Git authority, native shell/Bash semantics, provider/core
separation, serialized shared-project mutations, three-way sync, agreed hashes,
backups/conflict evidence, pending-source guards, mandatory credential exclusions,
Codex opt-in and no implicit local fallback. No dependency or remote watchdog was
added. Narrow durable constraints live under `specs/engineering/`; Charterleaf
activation configuration is unchanged. Structural lint is not semantic proof.

Known intentional limits: metadata snapshots can race later edits; ignore/name
checks are not DLP; ownership cleanup is conservative, not whole-config rollback;
legacy marker-only installations need manual review; ownership checks add Python/
SSH calls to Daytona transfers; SDK/API delays and scheduling require live budget/
cleanup evidence; signed preview links expire and must not be shared unredacted.
No production/cloud/native-host certification follows from the local gate.
