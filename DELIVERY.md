# Reroute 0.3 delivery ledger

**Canonical source:** [rebuild/0.3-native](https://github.com/onedotmint/Reroute/tree/rebuild/0.3-native); main and the original 0.2 branch are unchanged. The precise final commit SHA is recorded in each successful CI archive's `COMMIT.txt` / `package-verification.json`, and in the GitHub run's head SHA. Always match those values to the requested source ref. This versioned ledger does not falsely describe an older checkpoint as the final SHA.

**Build:** npm version `0.3.0-native.4`, `npm pack` to `reroute-0.3.0-native.4.tgz`. CI runs locked `npm ci`, strict types/build, tests, real localhost SSH, benchmark, real pack + clean-prefix install/smoke, then uploads the tarball and evidence as `reroute-npm-node-<node>-<sha>`, retention 30 days. No npm publish or GitHub Release.

**Architecture removal (0.2 → 0.3):** removed resident daemon, generic multi-way synchronization and source writeback, merge conflict states, remote dev server/preview, unrelated adapters and legacy protocol. Retained native Pi integration (now an independent compute tool, not a Bash interface), Clack setup, conservative command classification, direct compute providers; rebuilt one-way snapshots and a small task supervisor. Uses OpenSSH, rsync, official Daytona/Modal/E2B SDKs, SkyPilot CLI, Pi SDK and TypeScript; no LLM client.

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
- Cloud provider expansion frozen until independent real-account tests. Daytona/SkyPilot/Modal/E2B remain **experimental and LIVE UNVERIFIED**, not removed or silently disabled.
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
| Daytona | Implemented, offline contract-tested; **LIVE UNVERIFIED** |
| SkyPilot | Implemented, offline contract-tested; **LIVE UNVERIFIED** |
| Modal | Implemented, offline contract-tested; **LIVE UNVERIFIED** |
| E2B | Implemented, offline contract-tested; **LIVE UNVERIFIED** |
| Cross-machine WSL2 / real network interruption / account billing behavior | **NOT VERIFIED** |

[Historical CI run 38225923288](https://github.com/onedotmint/Reroute/actions/runs/38225923288) passed the build, tests, localhost SSH, benchmark and clean install in both Node versions, but **overall failed** at upload: `actions/upload-artifact@v4` defaults to excluding hidden directories; test files were located in `.artifacts/`. Commit `bc7bd65865b65f7fda31482b1fb8b134afd0596a` adds `include-hidden-files: true`. **Do not use that failed run as an installable artifact.**

**Manual live probe, existing running target only:** with a configured source checkout and explicit billing authorization, `REROUTE_LIVE=1 REROUTE_ALLOW_EXISTING_COMPUTE=1 npm run test:live`. The probe expects native stdout, stderr and exit 7; it never silently provisions or resumes a target. CI intentionally runs no paid cloud resources.

**Known limits:** input snapshots are double-checked but not filesystem-atomic; Git index capture is capped at 1 MiB, total input at 512 MiB, each file at 256 MiB; artifact archive at 256 MiB. Symlink inputs rejected. Shared project execution is serialized. Cancellation or transport state can be unknown and is never reported as confirmed success. SSH host lifecycle is not supported. Per-provider live SDK/CLI behavior is still a validation gap.

**Recovery/install:** use `pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native`, trust the project in Pi, and run `/reroute` to configure the project. For the optional standalone CLI, checkout the branch or use the actual successful [Verify native Reroute Actions run](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml). Download a `reroute-npm-node-<node>-<sha>` artifact, unzip, compare `COMMIT.txt` with run head SHA, install `npm install -g ./reroute-0.3.0-native.4.tgz` inside WSL2, run `reroute setup` and `reroute doctor --connect` in the project. CLI setup does not install the Pi extension; Pi does so separately. Always report missing/failed CI or live checks as such; no substitute fake tarballs.

## Independent Pi tool integration

- Removed `createRerouteOperations`, the `createBashTool`/BashOperations adapter and `user_bash` interception. No replacement hook chain, registry, spawn interception or AFT modification. `registerPi` registers only native `reroute_run` and `reroute_status` tools plus the `/reroute` interactive management command. Both tools are default-active; the standalone CLI is optional.
- The tool is directly exposed and default-active, with official Pi TypeBox schema (`command`, optional timeout seconds), prompt snippet/guidelines, bounded per-stream tails and progress, explicit status/exit/Job ID and error results. Pi supplies the schema/SDK peer packages; no new AI client or service.
- Existing configuration/router/engine/provider/CLI and management UX are retained. Local-mode, unconfigured and ineligible decisions return `not_started`, not a hidden local process; Bash remains owned by Pi/AFT. Remote failure/unknown state never triggers local retry. See [README tool contract](README.md#independent-pi-tool).
- Automated tests cover real source-loader registration, source-only loading, native local package install/load/remove, mock Provider execution receipts (success/nonzero/cancel/timeout/unknown/transport/upload failure), split UTF-8, bounded output and no local retry. Existing localhost OpenSSH acceptance now exercises independent tool output, nonzero status, timeout and cancellation rather than the retired Bash override.
- Tool availability and prompt guidance are verified separately from model choice. No real-model selection accuracy claim; no live paid cloud qualification.

### Independent-tool verification evidence

- Local `npm run verify` and `npm run check:package` passed. Default offline suite: 58 passed, two explicitly optional installed-AFT cases skipped; with installed AFT enabled: **60 passed, zero failed/skipped**. Native package tests install, load and remove without changing personal Pi settings; source-only loading does not need `dist/`.
- **Actual joint loading/execution:** installed `@cortexkit/aft-pi` + Linux Rust backend **0.59.0**, on repo-pinned Pi **1.1.0** and host Pi **1.2.0**. Both AFT-first and Reroute-first orders passed. Definition ownership/default activation and official nested tool calls were checked; backend spawn/version/task logs prove this was real AFT, not its fallback or the bash-only fixture. All model calls were blocked. This is automated real Pi/AFT execution evidence, not manual interactive TUI or model-selection evidence.
- [CI run 38590188172](https://github.com/onedotmint/Reroute/actions/runs/38590188172) passed on initial implementation commit `e89714d787c7db47a8d51f38e6d083d2dfb18738`: Node 22/24 types, tests, smoke, localhost OpenSSH/rsync/tool acceptance, benchmark and clean package installation; Node 22 additionally performed exact-commit native Pi Git-install/load/remove. Later commits are revalidated by CI; use [PR checks](https://github.com/onedotmint/Reroute/pull/1/checks) and archive SHA files for the final head, not this historical checkpoint. At that checkpoint, this machine lacked `sshd` and SSH evidence came from CI; the targeted local acceptance below uses a separately unpacked temporary OpenSSH server.
- Existing `npm audit` reports four high-severity advisories in the Daytona dependency tree (`@daytona/sdk`, `braces`, `fast-glob`, `micromatch`). No dependency versions were upgraded in this integration-only change; the added Pi schema peer is host-provided. This is not a security-production-readiness claim.

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

- Local `npm run verify` with installed AFT enabled: **77 passed, zero failed/skipped**, including both real AFT loading orders on repo-pinned Pi 1.1.0. The same coexistence file against host Pi **1.2.0** passed **4/4**, including both installed-AFT orders; AFT 0.59.0 retains Bash ownership and both native Reroute tools are default-active.
- Local `npm run test:ssh`: **7/7 passed** over actual temporary localhost OpenSSH/rsync. New coverage confirms a native status receipt and exit 7, inaccessible-resource history explicitly unconfirmed, nested-directory ownership, unknown IDs and cross-project refusal. The first attempt exposed a temporary server PATH missing npm; after supplying the already installed Node toolchain in that server environment, the entire suite passed without skipped tests or production-code workarounds.
- Two clean real Pi 1.2.0 / AFT 0.59.0 model sessions, with no standalone `reroute` executable, extra tool-selection instructions or personal Skills/context: the successful case called `reroute_run` for tests, waited for exit 0, then called it separately for build; the failing case received test exit 101, called `reroute_status`, obtained `remoteConfirmed=true` / `remoteStatus=exited` / exit 101, and stopped without building or local retry. Selected model ID: `openai/gpt-6.1-sol` through the existing gateway; this is a two-case regression probe, not a stability benchmark.
- `npm run check:package` produced a real tarball, clean-prefix production install and successful smoke. Exact final-commit packaging/CI checks are attached to PR #1; do not identify a pre-commit local artifact as the final pushed SHA. No paid cloud provider or cross-machine performance qualification is implied.
