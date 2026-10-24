# Reroute delivery ledger — 0.4.0 release

**Current acceptance:** the frozen working-tree candidate passed both providers' four-scenario real-cloud rechecks, native global installation/consent checks and the six model-selection categories. Earlier harness failures and explicitly authorized rechecks are retained, not relabelled. Exact artifact identity, measurements, remaining empty Modal Apps and release gates are in [Release acceptance](docs/RELEASE-ACCEPTANCE.md). Earlier sections below are historical checkpoints, not claims about every later working tree.

**Canonical source:** [rebuild/0.3-native](https://github.com/onedotmint/Reroute/tree/rebuild/0.3-native); main and the original 0.2 branch are unchanged. The precise final commit SHA is recorded in each successful CI archive's `COMMIT.txt` / `package-verification.json`, and in the GitHub run's head SHA. Always match those values to the requested source ref. This versioned ledger does not falsely describe an older checkpoint as the final SHA.

**Build:** npm package `@onedotmint/reroute@0.4.0`, `npm pack` to `onedotmint-reroute-0.4.0.tgz`. CI runs locked `npm ci`, strict types/build, tests, real localhost SSH, benchmark, real pack + clean-prefix install/smoke, then uploads the tarball and evidence as `reroute-npm-node-<node>-<sha>`, retention 30 days. CI does not run npm publish or create a GitHub Release; public availability is recorded by the [npm registry](https://www.npmjs.com/package/@onedotmint/reroute) and [GitHub Releases](https://github.com/onedotmint/Reroute/releases).

**Architecture removal (0.2 → 0.3):** removed resident daemon, generic multi-way synchronization and source writeback, merge conflict states, remote dev server/preview, unrelated adapters and legacy protocol. Retained native Pi integration (now an independent compute tool, not a Bash interface), Clack setup, conservative command classification, direct compute providers; rebuilt one-way snapshots and a small task supervisor. Uses OpenSSH, rsync, official Daytona/Modal/E2B SDKs, SkyPilot CLI, Pi SDK and TypeScript; no LLM client.

## Current status

| | |
|---|---|
| Version | `@onedotmint/reroute@0.3.0` preview; CLI command `reroute` |
| Merged | `rebuild/0.3-native` at merge commit `2382dc5` (PR #2, 2026-10-22T06:19:55Z) |
| Publication | Check the [npm registry](https://www.npmjs.com/package/@onedotmint/reroute) and [GitHub Releases](https://github.com/onedotmint/Reroute/releases); CI artifacts alone are not publication |
| Tests | **198 passed / 0 failed / 0 skipped**, plus real localhost SSH/rsync **7/7** and offline smoke with `cloudCalls: 0` |
| Daytona | **Live-verified**, including a full run on the exact merged commit `f713f52` |
| Modal | Lightweight live execution/release and synthetic download-cache persistence passed; full acceptance pending |
| SSH / SkyPilot | SSH has real localhost evidence; SkyPilot is offline-tested only |
| E2B | Offline-tested, with a known `UNRESOLVED` auto-resume race |
| Billing | **Unverified for every provider.** No artifact records an actual charge |

Everything below this table is history, newest last. It records what was true at each checkpoint and is deliberately not rewritten; where an older line contradicts the table above, the table is current. Test counts appear many times below because each round recorded its own; only the table's figure describes this commit.

## Configuration and control UX update

- Clack provider selection offers SSH / Daytona / SkyPilot / Modal / E2B, optional masked API-key entry, native authentication hints, opt-in read-only resource discovery, configurable saved profiles, and an optional connection check. User-selected storage is a private **unencrypted** local 0600 file; native environment/CLI authentication remains supported.
- Pi `/reroute` displays active resource, provider, routing, credential availability and all configured profiles without making remote calls. Overview, profile add/edit/switch/forget, opt-in resource discovery, credential status/forget, recent jobs, and explicit resource lifecycle operations are available.
- Non-interactive CLI `reroute credentials` and `reroute credentials forget --provider ... --yes` inspect and remove private-file entries; no keys are printed and provider-issued tokens are not revoked.
- Tests cover real Clack PTY interaction/masking, private file ownership and permissions, SDK authentication fallback, Pi menu contracts and existing SSH integration. **An interactive Pi terminal in a user's WSL2 is still NOT VERIFIED.**

## Native Pi package implementation

- Project install: `pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native` via Pi's actual package manager. Project settings are in `.pi/settings.json` and project trust gates extension loading.
- The Pi adapter now loads source `src/pi.ts` with Pi's own TypeScript loader; a Git package clone does not need generated `dist/`.
- `reroute setup` configures the project's `.reroute.json` only; global `installPi` entry-writing was removed. The old `reroute pi install` subcommand is intentionally retired.
- First `/reroute` invocation in an unconfigured trusted project can create the project's first provider profile. Provider keys must not be entered into unmasked Pi text inputs; masked credential entry remains available via the optional standalone CLI.
- Automated acceptance includes source-only Pi loading (without `dist/`), real Pi CLI project-local package install/trust/uninstall tests, and on GitHub branch pushes a full native Pi Git-install smoke test of the exact commit. No user home settings or global extensions are changed in these tests.
- An earlier owned global extension must be reviewed and manually retired to prevent duplicate registration; nothing deletes unknown Pi extensions automatically.
- **Manual WSL2 interactive acceptance and all live paid cloud integrations remain unverified.**

## 0.3 lightweight convergence (this branch)

- Slimmed the Pi profile-management flow rather than adding another configuration service. Shared `validate`/`saveConfig` remain the sole configuration validation/persistence path; both Clack onboarding and Pi use the same project configuration. The masked credential wizard is kept separate because Pi text inputs are not masked.
- Main `/reroute` menu now contains everyday overview, providers, routing mode, connection check and jobs; lifecycle stop/resume/destroy and key removal moved to **Advanced**. No resource is accessed merely by opening a menu; each potentially costly/destructive action still requires consent.
- Canceled Pi field editing leaves the existing saved profile untouched; new tests cover cancel, provider switching and Advanced confirmation.
- Cloud provider expansion frozen. **Daytona has since been verified live** (see the live-acceptance section below); SkyPilot/E2B remain **experimental and LIVE UNVERIFIED**; Modal has since passed the lightweight checks recorded below, not full acceptance. None is removed or silently disabled.
- The existing clean-prefix npm package check now records `installMs` and `nodeModulesKiB` in `package-verification.json`, providing a measured baseline instead of guessing WSL2 disk usage. Timing includes CI environment effects and is not a performance promise.

## Verified versus unverified

| Area | Current evidence |
|---|---|
| Type checking, build, offline tests and CLI smoke | Node 22 + Node 24 GitHub Actions steps passed in historical run 38225923288; required in final CI |
| Real SSH | GitHub Ubuntu localhost OpenSSH + rsync: dirty/new/deleted input, separated stdout/stderr/exit, no source writeback, incremental transfer, cache reuse, verified no-overwrite artifact, stdin/EOF, confirmed timeout/cancel, lock serialization, corrupt transfer/symlink refusal |
| Pi | Independent `reroute_run` / `reroute_status` source loading, schema/guidelines/default exposure, refusal, execution and project-scoped status results tested; no Bash or `user_bash` registration. Real SSH tool path is required by CI. **Interactive user Pi/TUI and broad model-selection stability NOT VERIFIED** |
| Rust and Node cache | Actual remote npm-ci bootstrap and Cargo cold/warm compilation tested through localhost SSH |
| Packaging | Actual npm tarball installed into clean prefix, offline `--help` / `doctor` / smoke execution checked; final run artifact must be separately verified |
| Performance | Synthetic 128 × 64 KiB preparation measurement and localhost SSH test timings saved as JSON in CI artifact; **no proof of real-device CPU/RAM savings or remote speedup** |
| Daytona | **LIVE VERIFIED** on a real account, including one run on the exact merged commit `f713f52`: image build, cache save then hit, failure and retest, canonical identity exclusion, detached-descendant cleanup. Evidence in `.artifacts/live-clean-commit-acceptance.json` |
| SkyPilot | Implemented, offline contract-tested; **LIVE UNVERIFIED** |
| Modal | Lightweight live execution/release and synthetic archive-cache persistence passed; starter image, real package builds and full failure acceptance pending |
| E2B | Implemented, offline contract-tested; **LIVE UNVERIFIED**, and carries a known `UNRESOLVED` auto-resume race |
| Cross-machine WSL2 / real network interruption / account billing behavior | **NOT VERIFIED** |

[Historical CI run 38225923288](https://github.com/onedotmint/Reroute/actions/runs/38225923288) passed the build, tests, localhost SSH, benchmark and clean install in both Node versions, but **overall failed** at upload: `actions/upload-artifact@v4` defaults to excluding hidden directories; test files were located in `.artifacts/`. Commit `bc7bd65865b65f7fda31482b1fb8b134afd0596a` adds `include-hidden-files: true`. **Do not use that failed run as an installable artifact.**

**Manual live probe, existing running target only:** with a configured source checkout and explicit billing authorization, `REROUTE_LIVE=1 REROUTE_ALLOW_EXISTING_COMPUTE=1 npm run test:live`. The probe expects native stdout, stderr and exit 7; it never silently provisions or resumes a target. CI intentionally runs no paid cloud resources.

**Known limits:** input snapshots are double-checked but not filesystem-atomic; Git index capture is capped at 1 MiB, total input at 512 MiB, each file at 256 MiB; artifact archive at 256 MiB. Symlink inputs rejected. Shared project execution is serialized. Cancellation or transport state can be unknown and is never reported as confirmed success. SSH host lifecycle is not supported. Per-provider live SDK/CLI behavior is still a validation gap.

**Recovery/install:** use `pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native`, trust the project in Pi, and run `/reroute` to configure the project. For the optional standalone CLI, checkout the branch or use the actual successful [Verify native Reroute Actions run](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml). Download a `reroute-npm-node-<node>-<sha>` artifact, unzip, compare `COMMIT.txt` with run head SHA, install `npm install -g ./onedotmint-reroute-0.3.0.tgz` inside WSL2, run `reroute setup` and `reroute doctor --connect` in the project. CLI setup does not install the Pi extension; Pi does so separately. Always report missing/failed CI or live checks as such; no substitute fake tarballs.

## Independent Pi tool integration

- Removed `createRerouteOperations`, the `createBashTool`/BashOperations adapter and `user_bash` interception. No replacement hook chain, registry, spawn interception or AFT modification. `registerPi` registers only native `reroute_run` and `reroute_status` tools plus the `/reroute` interactive management command. Both tools are default-active; the standalone CLI is optional.
- The tool is directly exposed and default-active, with official Pi TypeBox schema (`command`, optional timeout seconds), prompt snippet/guidelines, bounded per-stream tails and progress, explicit status/exit/Job ID and error results. Pi supplies the schema/SDK peer packages; no new AI client or service.
- Existing configuration/router/engine/provider/CLI and management UX are retained. Local-mode, unconfigured and ineligible decisions return `not_started`, not a hidden local process; Bash remains owned by Pi/AFT. Remote failure/unknown state never triggers local retry. See [README tool contract](README.md#independent-pi-tool).
- Automated tests cover real source-loader registration, source-only loading, native local package install/load/remove, mock Provider execution receipts (success/nonzero/cancel/timeout/unknown/transport/upload failure), split UTF-8, bounded output and no local retry. Existing localhost OpenSSH acceptance now exercises independent tool output, nonzero status, timeout and cancellation rather than the retired Bash override.
- Tool availability and prompt guidance are verified separately from model choice. No real-model selection accuracy claim; no live paid cloud qualification.

### Independent-tool verification evidence

- Local `npm run verify` and `npm run check:package` passed. [historical checkpoint] Default offline suite: 58 passed, two explicitly optional installed-AFT cases skipped; with installed AFT enabled: 60 passed. Native package tests install, load and remove without changing personal Pi settings; source-only loading does not need `dist/`.
- **Actual joint loading/execution:** installed `@cortexkit/aft-pi` + Linux Rust backend **0.59.0**, on repo-pinned Pi **1.1.0** and host Pi **1.2.0**. Both AFT-first and Reroute-first orders passed. Definition ownership/default activation and official nested tool calls were checked; backend spawn/version/task logs prove this was real AFT, not its fallback or the bash-only fixture. All model calls were blocked. This is automated real Pi/AFT execution evidence, not manual interactive TUI or model-selection evidence.
- [CI run 38590188172](https://github.com/onedotmint/Reroute/actions/runs/38590188172) passed on initial implementation commit `e89714d787c7db47a8d51f38e6d083d2dfb18738`: Node 22/24 types, tests, smoke, localhost OpenSSH/rsync/tool acceptance, benchmark and clean package installation; Node 22 additionally performed exact-commit native Pi Git-install/load/remove. Later commits are revalidated by CI; use [PR checks](https://github.com/onedotmint/Reroute/pull/1/checks) and archive SHA files for the final head, not this historical checkpoint. At that checkpoint, this machine lacked `sshd` and SSH evidence came from CI; the targeted local acceptance below uses a separately unpacked temporary OpenSSH server.
- Existing `npm audit` reports four high-severity entries in the Daytona dependency tree (`@daytona/sdk`, `braces`, `fast-glob`, `micromatch`). These are **one** advisory propagated along three edges, not four independent vulnerabilities: see the corrected analysis below. No dependency versions were upgraded in this integration-only change; the added Pi schema peer is host-provided. This is not a security-production-readiness claim.

Reproduce actual AFT acceptance from a built source checkout, using installed paths (no global config changes):

~~~bash
REROUTE_AFT_EXTENSION=/absolute/path/to/@cortexkit/aft-pi/dist/index.js \
AFT_BINARY_PATH=/absolute/path/to/@cortexkit/aft-linux-x64/bin/aft \
npm test
~~~

For a different installed Pi host, also set `REROUTE_PI_SDK_PATH` to its `dist/index.js` and run `node --test tests/pi-coexistence.test.mjs`. Without `REROUTE_AFT_EXTENSION`, CI runs both bash-only fixture orders and explicitly skips actual-AFT cases. The optional test never installs or modifies AFT. These automated loader tests do not make model requests. The separate one-shot WSL2 acceptance of `4653c311a165b7b41b9898b4521555bf56cbd85b` used real Pi/AFT model sessions: six required scenarios selected execution versus ordinary tools correctly, with real localhost SSH builds/tests and no unauthorized local fallback. This is not broad model-selection stability or live paid-cloud qualification.

## Final independent-tool diagnostic closure

- The Pi Package now supplies `reroute_status({ jobId })` without requiring the optional CLI. `/reroute` remains the interactive management entry; Pi/AFT still owns Bash.
- Status results separate the pre-query local record from a fresh remote task confirmation. Canonical current-project authorization occurs before provider access or record disclosure. A resource being online, a stored exit status or a remote `unknown` response cannot establish current task completion. Disconnects/timeouts return history and a failed-verification diagnostic; state recovery is not guaranteed while disconnected.
- Querying may update an existing local receipt but never starts/resumes resources or creates, retries, cancels or cleans tasks. Existing CLI status/cancel calls keep their return shape; the native status tool always uses the read-only status action. E2B task verification fails closed with history and a diagnostic because its existing connection API may resume a concurrently paused sandbox; no provider or dependency redesign is included.
- Execution guidance requires single eligible commands, separate sequential calls for dependent tasks, stopping on failure/unknown, and native status inspection before any decision about an authorized local rerun. The conservative router is unchanged; there is no command splitter, shell rewrite or Bash interception.
- Targeted tests cover status receipt validation and project authorization, stale history versus confirmation, unavailable/throwing/aborted providers, native package registration and both Pi/AFT loading orders. Final local and CI results are recorded on PR #1 for the exact pushed HEAD; historical run links above remain historical.

### Targeted final-fix acceptance

- [historical checkpoint] Local `npm run verify` with installed AFT enabled: 77 passed, including both real AFT loading orders on repo-pinned Pi 1.1.0. The same coexistence file against host Pi **1.2.0** passed **4/4**, including both installed-AFT orders; AFT 0.59.0 retains Bash ownership and both native Reroute tools are default-active.
- Local `npm run test:ssh`: **7/7 passed** over actual temporary localhost OpenSSH/rsync. New coverage confirms a native status receipt and exit 7, inaccessible-resource history explicitly unconfirmed, nested-directory ownership, unknown IDs and cross-project refusal. The first attempt exposed a temporary server PATH missing npm; after supplying the already installed Node toolchain in that server environment, the entire suite passed without skipped tests or production-code workarounds.
- Two clean real Pi 1.2.0 / AFT 0.59.0 model sessions, with no standalone `reroute` executable, extra tool-selection instructions or personal Skills/context: the successful case called `reroute_run` for tests, waited for exit 0, then called it separately for build; the failing case received test exit 101, called `reroute_status`, obtained `remoteConfirmed=true` / `remoteStatus=exited` / exit 101, and stopped without building or local retry. Selected model ID: `openai/gpt-6.1-sol` through the existing gateway; this is a two-case regression probe, not a stability benchmark.
- `npm run check:package` produced a real tarball, clean-prefix production install and successful smoke. Exact final-commit packaging/CI checks are attached to PR #1; do not identify a pre-commit local artifact as the final pushed SHA. No paid cloud provider or cross-machine performance qualification is implied.

## Managed daily-cloud increment (local development; not a release)

- Baseline: `3076ef786e46fea15548f7ba6ecd93a9f545a68d`, `origin/rebuild/0.3-native`; work happened on `feat/0.3-daily-cloud`, since merged. The original `refactor/workflow-0.2` worktree and its unrelated uncommitted work were not edited.
- Implemented opt-in Daytona resource discovery/create/start/reuse, custom and per-task specification, guarded auto-stop, retained Volume, durable allocation intent/account lease, local reservation limits and conservative recovery. Explicit user billing authorization is required; setup itself makes no managed-path cloud calls.
- Implemented Modal App/Sandbox/Volume creation via the locked SDK, physical CPU/memory hard limits, tagged recovery and bounded lifetime. Confirmed managed tasks release compute immediately; Volume is retained. No pretend in-place lifetime extension or mutable idle timer. Existing-resource Modal snapshot resume now refuses a running old Sandbox and journals a pending creation before attempting replacement.
- Named private credential files isolate explicitly selected accounts from environment/native/default credentials. Setup refuses credential storage inside the repository; snapshots exclude relocated named stores and native Modal tokens even if tracked. Masked Clack setup and non-secret Pi settings support managed configuration without copying a Sandbox ID. Existing SSH/SkyPilot/E2B paths remain; Pi/AFT retains ordinary Bash.
- Two hardening fixes landed with their own regression tests, both found by review of this branch rather than by a failing user report.
- A configured `identityFile` reached the snapshot exclusion list as the literal configured path. A project reached through a symlinked directory, or a `~/…` path, therefore kept the key in the upload even though the path was nominally private. Private paths are now canonicalised with `realpath` (missing targets fall back to `resolve`, so a nonexistent key still cannot slip in) and `~` is expanded before that, and `snapshot` refuses outright when the project overlaps the credential store. `tests/snapshot.test.mjs` covers the alias case with a synthetic key file.
- Remote cleanup signalled the task's whole process group, so a recycled PGID could kill an unrelated process that merely inherited the number. Cleanup now resolves the actual descendant tree from `/proc`, re-checks each PID's start time before signalling, and never signals a group with no supervised descendants. `tests/persistent-cache.test.mjs` asserts the no-descendant case never sends a signal.
- Source is verified once **before** allocating compute. Remote receipts cannot overwrite local Job ownership. Provider connections stay open through post-task lifecycle handling. Persistent download archives are separated from scratch target/node_modules/source, checked for corruption/path attacks, and produce explicit timing/hit/warning metrics. Each cache phase is time-bounded within the provider/transport safety margin so slow storage cannot silently consume the task deadline.
- Starter Node/Rust/Python toolchain recipe uses official image-builder layers without local project context. Its actual cloud build is **not verified**; see the live-acceptance section below for what has and has not run. All remaining operational details and the exact authorized test sequence are in [Managed cloud operations](docs/MANAGED-CLOUD.md).

### This round's verification

- Node **24.21.0**, locked `npm ci`: passed. [historical checkpoint] Strict TypeScript/build and the complete relevant offline suite: 130 passed, plus CLI smoke. This includes actual terminal PTY masking/cancellation, native Pi local installation/removal, source-only extension loading, real Python process-group execution/cancellation/timeout, cache scratch reconstruction, ownership/ledger safety and version-checked SDK-shaped contracts.
- Actual installed **Pi 1.3.0 + AFT 0.61.0**: both loading orders passed, AFT retains Bash, independent Reroute run/status tools remain active. These isolated sessions prohibited model calls. They do not establish natural-language model-selection accuracy or manual TUI acceptance. CI now pins `@cortexkit/aft-pi@0.62.0` in an isolated prefix so the two real-AFT loading orders run on every push instead of skipping.
- Clean-prefix tarball production installation and smoke: passed. First measured install **56,838 ms**, installed `node_modules` **127,012 KiB**; environment/cache-dependent, not a device-speed promise. `.artifacts/package-verification.json` records integrity and `sourceTreeDirty:true`. The reported Git SHA is the baseline commit, **not a commit containing these uncommitted changes**. Repacking after documentation changes refreshes the exact tarball evidence; no release or remote-ref installation of this branch is claimed.
- AFT TypeScript diagnostics: zero errors/warnings. Pi tool guidance is now short and context-driven: heavy builds/full tests prefer Reroute; quick checks, Git and files remain AFT/Bash. Up to three recent confirmed project observations are added only per turn; corrupt, old, foreign, failed or incomplete records are ignored.
- The repository Pi/AFT coexistence test passed in both extension orders with the real installed AFT backend. The opt-in model-selection probe ran in a local isolated fixture: the light case naturally selected AFT and completed; the heavy-case request ended with a model-provider error before any tool execution, so heavy-selection and failure-follow-up remain **not verified**, not fabricated. No cloud was contacted. Python diagnostics are unavailable without a Python analyzer project; actual Python execution tests passed. Existing unused-import hint in the router is unrelated and was left alone.
- `npm audit` reports **four high-severity entries** along `@daytona/sdk → fast-glob → micromatch → braces`. They are not four vulnerabilities. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) / CVE-2026-93687 (CVSS 7.5, CWE-674) is a single stack-exhaustion defect in `braces <= 3.0.3` with no patched version published; npm lists `braces` as the only advisory source and the other three nodes as `via`/`effects` propagation. No blind upgrade or advisory suppression was performed.
- Locally reproduced, bounded, offline (`.artifacts/security-daytona-dependency-probe.mjs`, result in `.artifacts/security-daytona-dependency-probe-result.json`): 800 nested braces is 3,201 bytes, i.e. inside braces' own `MAX_LENGTH: 10000` guard, and still exhausts the stack. Both `braces.expand(pattern)` and `fast-glob.sync([pattern])` throw `RangeError: Maximum call stack size exceeded` in isolated child processes. The advisory is real and reachable through the dependency Reroute ships.
- Reroute does not expose that reachable path. The only `fast-glob` consumer in the SDK is `Image.extractCopySources`, reached from `dockerfileCommands`/`fromDockerfile`; Reroute calls it only with the fixed `TOOLCHAIN_COMMANDS` recipe (`src/toolchain.ts`), whose `COPY` lines use `--from=node:22-bookworm` and never a local path or caller-supplied pattern. `tests/daytona-dependency-path.test.mjs` exercises the real SDK image builder with `fast-glob.sync` replaced by a thrower and asserts zero glob calls. Residual risk is a future recipe or SDK change that starts routing user patterns into that path; the guard test fails closed on that.
#### Live Daytona acceptance actually performed

These were real, authorized, billed Daytona runs against an existing owned sandbox and its retained Volume. Each is bounded by its own artifact, and **none of them ran on this branch's current commit**: every artifact records `sourceTreeDirty: true`, and `.artifacts/COMMIT.txt` names the baseline `3076ef7`, not a commit containing these changes.

- **Single real smoke** — `.artifacts/daytona-minimal-live-result.json`, 2026-10-21T14:28Z: real Pi invoked `reroute_run` once (`remoteRunAttempts: 1`) running `make test -f tests/daytona-live-smoke.mk` on 2 CPU / 4 GiB. `outcome: execution-passed`.
- **Cache cold/warm restart** — `.artifacts/daytona-cache-restart-live-result.json`, 2026-10-21T15:17Z: both phases `confirmed`, `exited`, code 0, with `noResourceCreationAllowed: true`. This exercised the retained-Volume restore/save path, not a fresh cache creation.
- **Real model + real AFT + real Daytona workflow** — `.artifacts/pi-daytona-workflow-live-result.json`, 2026-10-21T16:16Z: three cases (light, success, failure), `remoteCalls: 3`, jobs `exited` code 0, `unresolvedJobs: []`, `allComputeStopped: true`, `noAdditionalResources: true`, real AFT `0.61.0` binary spawned. Model was `deepseek/deepseek-flash` forced process-only. The artifact also records honestly that the first attempt without a trusted remote prefix was refused by the router and the model fell back to a local run.
- **Bounded security probe on the existing sandbox** — `.artifacts/security-daytona-live-result.json`, 2026-10-22T02:37Z: `outcome: passed`, `newResources: 0`, job exited 0, ~29 s compute window, ~0.04 USD estimate.
- **Final resource state** — `.artifacts/security-daytona-final-state.json`, 2026-10-22T02:38Z: sandbox `stopped`, one retained Volume `ready`, `newCloudResources: 0`. The Volume is deliberately kept and continues to incur storage cost.

#### Live acceptance on the exact PR commit (clean checkout)

Unlike the runs above, this one is on the real code. A clean `git worktree` was created at `f713f52` (the PR head), dependencies installed with `npm ci`, and `tsc` built. `sourceTreeDirty: false`, and the checkout SHA equals the PR head SHA exactly. Evidence: `.artifacts/live-clean-commit-acceptance.json`.

All runs used **2 CPU / 4 GiB** on Daytona and completed in a few minutes total:

- `npm test` first run: exit 0, `cacheHit: false`, `cacheSaved: true`, `provisionMs` 36,775. This is also the first-ever cloud build of the starter toolchain recipe — it succeeded.
- `npm test` second run: exit 0, `cacheHit: true`, `transferredBytes: 0`, `provisionMs` dropped to 4,486. **Cache save and hit both confirmed on real hardware.**
- Intentional failure: exit 1 with the genuine remote assertion (`actual: 0, expected: 99`), no local fallback.
- Fix and retest: exit 0. **Failure → fix → retest confirmed.**
- Sensitive-file exclusion: a fake key at `keys/deploy_key` was configured as `identityFile` **through a symlinked alias path** — the exact case the hardening fixed. It did not appear in the snapshot; `id_rsa` was excluded too.
- Remote process cleanup: `setsid` detached a `sleep 600` into a new session; a following task measured `survivors: 0`. **Detached descendants are reaped.**

Resource state was confirmed through the official Daytona API, not the local ledger. This run created a **new** sandbox and Volume because ownership derives from installation UUID plus project path, so the acceptance project got its own pair alongside the earlier one.

**Both were then deleted with explicit user authorization, and the official API now reports zero sandboxes and zero volumes.** Deletion is irreversible: the retained cache archives (`rr-cache-9cedd84f…` from the earlier work and `rr-cache-5e95c260…` from this run) are gone, so the next run starts cold and rebuilds the toolchain image. No source code was ever stored there; the caches held download archives only. Local month-to-date reservation reached 0.68268 USD before deletion — a conservative local estimate, **not** an official billed amount.

Not verified in this round: the real-model natural-selection path (`reroute_run` chosen by a model without forcing) was exercised through the engine API directly, not by letting a model choose the tool. That remains covered only by the earlier pre-commit `pi-daytona-workflow` artifact.

#### Still not verified

- **Modal lightweight live checks have since passed.** See the follow-up section below; this does not certify the starter image, real package builds, failure recovery or billing.
- **Starter toolchain image cloud build: not verified.** `src/toolchain.ts` is exercised offline only; no cloud build of that recipe exists.
- **Billing: not verified.** Every artifact records `actualBilledUsd: null`. The only spending observation is a rounded cumulative dashboard figure (`0.01 USD`) explicitly marked as not this run's incremental charge. No official balance/credit API was used.
- **Current-commit cloud state: unverified.** No live run has been made against `b8fdfe5` or any commit on this branch, and the live runs above predate the two hardening fixes. The identity-path and process-ownership fixes change snapshot exclusion and remote cleanup — exactly the code those runs exercised — so their live behavior is inferred from offline tests, not from a cloud run.
- Provider quota acceptance, Volume durability across sandbox lifetimes, native guards after a killed client, manual WSL2 Pi/TUI acceptance. Localhost OpenSSH is now covered by CI (7/7), not by this machine.
- **E2B remains `UNRESOLVED`** (`.artifacts/security-e2b-race-result.json`): an offline SDK-shape probe found its `getInfo`/`connect` interleaving permits the documented auto-resume. Not fixed here; out of this change's scope and left as a recorded open contract gap.

**Merged, not released.** PR #2 was merged into `rebuild/0.3-native` as merge commit `2382dc5` (2026-10-22T06:19:55Z); the version remains a development candidate, not a published daily-use certification. No npm publish, GitHub Release or git tag was created. Daytona live acceptance was performed repeatedly, including once on the exact merged commit; **Modal has since passed lightweight live execution/release and synthetic cache-persistence checks, not full live acceptance.**

Verified on commit `65a0253` (the PR head at merge) by CI runs [39732180527](https://github.com/onedotmint/Reroute/actions/runs/39732180527) and [39732187119](https://github.com/onedotmint/Reroute/actions/runs/39732187119): Node 22 and 24 both passed, **198 passed / 0 failed / 0 skipped**, real localhost SSH/rsync **7/7**, offline smoke with `cloudCalls:0`, and a clean-tree package install (`sourceTreeDirty:false`). CI pins `@cortexkit/aft-pi@0.62.0` in an isolated prefix, so the two real-AFT loading orders execute on every push instead of skipping; their internal assertions on `Spawning binary:` and `Binary version:` in the AFT log are what distinguish a real backend from the bash-only fixture. Earlier install-time figures in this document are CI-cache-dependent and none is a device-speed promise.

### Pi/AFT daily-workflow follow-up

- Narrow production changes: `src/pi.ts` tool wording/per-turn guideline integration and `src/history.ts` local receipt observations. Static run-tool guidance is **1,223 characters / four guideline bullets**; dynamic observations are at most three bounded lines. No classifier, extra model request, execution tool, Bash interception or AFT modification. Cache wording now says “download archive restored” rather than implying a warm build.
- History requires at least two confirmed exited comparable records within 30 days, uses up to five per category, filters account/image/compute and attached target identity, and never includes raw command/error/output. It reports nonzero task exits rather than hiding confirmed computation failures; unknown/transport failures are excluded. Missing/corrupt history stays silent and cannot block development.
- [historical checkpoint] Final `npm run verify` with actual Pi 1.3.0/AFT 0.61.0: 130/130 passed, including both loading orders and non-accumulating history integration; strict types/build and smoke passed. Charterleaf lint and `git diff --check` passed. The single `braces` advisory (GHSA-vfj7-8cjw-p6xm) remains unpatched upstream and is not reachable from Reroute's actual call path; no new dependency was added.
- Real-model probe (`openai/gpt-5.6-terra`, existing read-only Pi auth, no personal context/skills): light case completed using AFT Bash for Git status and Node version, two model requests, no Reroute execution. The second case ended in a model-provider request error before any tool call; the failure case was not attempted after that blocker. This is a partial result, **not** proof of heavy-task natural selection or a paid cloud run. Evidence: `.artifacts/pi-workflow-selection.json`; reproducible opt-in script: `tests/pi-model-selection.mjs` (excluded from default tests).
- Review-ready as a **draft PR** with explicit acceptance gaps. Heavy/failure real-model selection, manual TUI and all Daytona/Modal live resource/cache/billing checks remain pending; no automatic commit/push/PR or paid cloud operation was performed. Earlier tarball measurements are historical; rerun package verification for the final dirty tree and use its integrity rather than calling the baseline SHA a new source commit.

### Simplified configuration follow-up

- Bare `setup` now multi-selects Daytona/Modal/SSH in one pass, with explicit Space/arrow/Enter instructions. Daytona needs one masked API key; Modal needs masked Token ID + Secret. New accounts receive separate named private credentials and automatic profile names; existing profiles are kept unchanged or another account can be added without overwriting them. The project default is selected after configuration.
- Recommended 1 CPU/2 GiB toolchain, per-account $3 monthly estimate/$0.50 task cap and guarded idle defaults are reviewed together instead of asking every technical field. Customize expands the detailed existing settings. SSH quick setup asks only for an existing host; `setup --advanced` preserves detailed accounts/targets and E2B/SkyPilot. Existing explicit/noninteractive CLI flags remain compatible.
- Selecting providers does not authorize spending. A separate default-No consent applies only to new credential-ready cloud profiles; missing credentials cannot gain new authorization. All choices/keys are held in memory until final save confirmation. Cancel-before-save leaves existing project bytes and newly entered keys unwritten; setup does not create/contact cloud resources. Private credential paths inside the repository remain refused.
- `/reroute` offers the exact installed terminal command, shell-quoted with the current project path; it never spawns a terminal, collects unmasked keys or changes Pi/AFT Bash ownership.
- [historical checkpoint] Strict types/build/smoke and 147/147 tests passed, no failures/skips, including 16 actual PTY quick-setup scenarios, preserved advanced PTY coverage, configuration compatibility and actual installed Pi 1.3/AFT 0.61 in both loading orders. New coverage includes both-provider entry, separate authorization, cancel at multiple stages, existing profile preservation, added accounts, native/saved/missing credentials, custom specs, SSH, unsafe credential paths and advanced fallback. No live cloud credentials or billable resource operations were used.

## Modal mount-alias fix and lightweight live follow-up

- Real Modal mounts exposed `/var/reroute-cache` as a symlink to `/__modal/volumes/vo-<ID>`. The supervisor previously rejected this legitimate provider alias before any archive I/O. It now accepts only that fixed alias with an immediate absolute, ID-shaped target, while retaining link-free mount/target ancestors and archive/member/source/artifact checks. Other layouts fail closed.
- `tests/persistent-cache.test.mjs`: 19 focused component tests passed, including two new regressions for cross-scratch mount-alias persistence and rejected alternate targets/aliases, linked ancestors, linked archive files and malicious members.
- Two repaired live tasks at 1 physical CPU / 2 GiB, 30-second task deadline and `python:3.12-slim-bookworm` both exited 0 without cache warnings. Cold Job `4e53a436-bf0e-45e3-bd01-951aa40e9fd8`: `cacheHit=false`, `cacheSaved=true`. After confirmed termination, new-Sandbox Job `ff055065-ef31-48b0-b923-7412622668f3`: `cacheHit=true`, `cacheSaved=true`, with the prior synthetic download marker asserted inside the task. SDK checks confirmed both Sandboxes stopped and zero running compute for this test owner. Local source and the root project's active Daytona profile were unchanged.
- Evidence: `.artifacts/modal-cache-fixed-result.json`; initial failure/root-cause evidence remains in `.artifacts/modal-light-summary.md` and `.artifacts/modal-cache-repro-result.json`. This verifies archive mechanics across Sandbox lifetimes, not real Cargo/npm package validity or a build-speedup claim.
- The two repaired probes reserved a total local estimate of USD 0.0896432; `actualBilledUsd` remains null. The test Volume/App are retained. Modal starter-image builds, full repository builds/tests, cancellation/crash recovery and billing remain unverified. Historical pending statements above predate this narrowly scoped follow-up.

## Modal PATH repair and real-project acceptance

Acceptance SHA `e6b68ad176bd6cbec4fea4e30d5eec54e207e89a` supersedes the lightweight-only/blocked status above for the tested daily build/test scope. One authorized single-Sandbox comparison proved Rust exists and native PATH is correct; `bash -lc` reads `/etc/profile` and removes `/usr/local/cargo/bin`, while `bash -c` and scratch CARGO_HOME with preserved RUSTUP_HOME work. Only Modal shell argv changed; no image recipe/version, task environment or Daytona changes. Thirty-seven focused tests passed, including a real-shell regression that failed before repair.

Default Node/Rust/Python and Rust compilation passed. Identical real-repository cold/warm tasks ran npm ci, typecheck, build, complete tests and smoke in the same task directory each; both exited 0, 200 passed/0 failed/2 original host-AFT skips. Fresh-Sandbox warm archive restore succeeded; node_modules/dist were absent initially and rebuilt. Dependency install 8.814→6.783 s, execution 50.317→52.498 s, observed allocation/execution 145.387→193.245 s: no overall speedup claim. Full output/receipt hashes verified. All nine session Sandboxes freshly confirmed stopped; five App/Volume pairs retained, no deletion. Current request local reservations $0.4705216, actual billing unknown. Detailed report and exact resources: `.artifacts/modal-project-acceptance-UQxc8A/{SUMMARY.md,acceptance-result.json,all-session-resources.json}`. Complex live faults, actual billing, broad performance and shrinkwrap-change cache invalidation remain uncertified. These documentation updates postdate the frozen tested SHA; its code identity remains unchanged.


## Daily-use optimization — unreleased working tree

This section supersedes historical project-only installation and Modal-never-live wording; it does **not** turn prior live runs into acceptance of the new transfer code. Existing uncommitted Modal/Python/cache fixes and the `verification/` directory were retained. No commit, push, merge, npm publish, tag or GitHub Release was performed.

### Fewer user steps

- Recommend one **global native Pi package** installation and one masked `reroute setup`. User defaults are `$XDG_CONFIG_HOME/reroute/config.json` (fallback `~/.config/reroute/config.json`); no `.reroute.json` is needed in ordinary projects. `setup --project` and existing complete project files remain supported. Resolution is built-ins → user → top-level project overrides; named profiles replace whole profiles, not fragments of cost policy. No automatic migration or deletion.
- Account policy authorizes future managed spending only inside its reviewed estimate envelope. Each canonical project/account separately needs explicit one-time consent before snapshot/upload or compute start. Pi obtains native confirmation; headless calls refuse until the user explicitly authorizes. Consent is private state outside source, revocable, and changes in credential reference, attached target, SSH port or identity need new consent. Default authentication and a named `native-default` account are distinct. Overridden user SSH identity paths remain excluded from uploaded inputs.
- `/reroute` retains the existing panel/terminal wizard, separates saved credentials, connection check, policy/project authorization and successful actual task receipts, and exposes user default selection, project-only exceptions, recent jobs, local resource estimates and static environment hints. An optional 30-second smoke requires independent cost consent; opening the panel never runs it. No secret collection in Pi text fields.
- Native copies use a runtime-event registration lease released on shutdown/reload. Real physical-copy tests in both orders and actual session reload retain exactly one Reroute tool/command owner. No Bash/AFT interception, classifier, model prediction, scheduler, provider failover or local retry was added. The model can choose remote directly for clearly heavy tasks.

### Transfer evidence, not a cloud speedup claim

Historical Modal receipts contain 72 files / 742,267 source bytes, snapshot preparation 428–446 ms, and combined transfer 82,308.5 / 123,696.3 ms. The old combined metric includes stage/verification RPCs and sequential SDK puts; it cannot isolate network throughput. The old full input requires 73 puts.

SDK providers now upload one manifest-indexed gzip stream for changed file bytes plus the existing request, while rsync is unchanged. The existing manifest/needed-file baseline remains; this is not bidirectional or daemon synchronization. Private staging checks compressed size/hash, full gzip stream, bounded expansion, safe manifest paths and every file hash/mode before replacing baseline files. Existing two-read snapshots, secret exclusion, work verification, locks, unknown state, cache supervision and task receipt authority remain.

Local before/after single samples, **128 × 64 KiB deliberately repetitive files, 10 ms injected latency per put, no cloud SDK**:

| Input | put calls before → after | Combined transfer before → after |
|---|---:|---:|
| Cold | 129 → 2 | 1,612.5 → 419.0 ms |
| Unchanged | 1 → 1 | 179.9 → 239.2 ms |
| One changed file | 2 → 2 | 223.3 → 212.1 ms |

This demonstrates less per-file API overhead, not a measured Modal improvement; the unchanged path was slower in this sample. Repetitive data intentionally compresses unusually well. Detailed local evidence: `.artifacts/transfer-performance.md`, `transfer-baseline.json`, `transfer-after.json`; reproducible current-path measurement: `node tests/transfer-measurement.mjs OUTPUT.json`.

Metrics now distinguish snapshot, pack, manifest/file upload bytes and time, remote stage/unpack/verify/work preparation, cache restore/save bytes/time, execution, descendant/work cleanup and provider release. Some enclosing wall metrics overlap subphases; SDK wire overhead is not measured. Pi native updates expose actual stage boundaries without invented percentages; known-stage failures distinguish upload/verification/budget/cleanup from command exits. Random-token fixed-stage frames affect UI only, never task success or authorization.

### Environment compatibility

`src/environment.ts` inspects bounded allowlisted root declarations for npm/pnpm/Yarn/Bun, Rust and Python without execution, source edits or installs. The starter-image limitations are explicit. `npm-shrinkwrap.json` now takes npm bootstrap precedence and participates in dependency cache identity, alongside manifests/runtime declarations. Modern Yarn major versions retain immutable installation. Complex monorepos/full TOML resolution and arbitrary runtime installation are intentionally not implemented.

### Current local verification

- `npm run verify` with installed **Pi 1.4.0 / AFT 0.62.0** supplied to coexistence tests: types and build passed, **262 passed / 0 failed / 0 skipped**, CLI smoke passed with `cloudCalls:0`. The first post-review run caught a test fixture changing its SSH identity after authorization; the fixture now explicitly reauthorizes, preserving the tightened target boundary, and the full gate passed again.
- Real Pi CLI global and project installation/discovery/scoped removal; two physical package copies and reload; real offline `/reroute` PTY setup-help/overview/close on bundled Pi 1.1 and installed Pi 1.4; Clack masked/cancel/default-cost and global-save PTYs all passed. Actual AFT backend coexistence passes in both loading orders, not only a Bash substitute.
- Scoped authoritative TypeScript/Python diagnostics: **0 errors / 0 warnings**. Added fail-closed supervisor-identity validation before spawning and coverage for that branch.
- Clean-prefix package installation and installed CLI smoke passed (`npm run check:package`); final tarball integrity and dirty-tree identity are recorded in `.artifacts/package-verification.json`. A dirty source checkout is not a new released commit.

No new real cloud computation or paid model probe was run. New archive transport/global onboarding still require separately authorized Daytona/Modal acceptance; actual billing, general model-selection reliability, large/incompressible input cost and real network throughput remain unverified. Historical real-cloud toolchain/receipt/cache evidence remains valid only for the documented historical SHAs. Budgets are local estimates, retained storage can bill, and uncertain remote tasks can still require manual provider verification.
