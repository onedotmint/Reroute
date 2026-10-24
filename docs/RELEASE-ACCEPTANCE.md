# Release acceptance — 2026-10-24

## Decision

**Release preparation follow-up:** the user subsequently approved npm 0.4.0, source commit/push, merge into main, tag and GitHub Release. The package/lock metadata, CLI help and user documentation are being aligned to 0.4.0; execution logic remains unchanged. The statements below describe the completed acceptance checkpoint, not a claim that publication already occurred. See [0.4.0 release notes](RELEASE-0.4.0.md).

**The scoped functional acceptance passed. Recommend preparing version 0.4.0 and stopping feature expansion. Do not publish the current 0.3.0-labelled artifact.** The registry's latest version was read-only checked as 0.3.1. Version metadata, release notes, final release packaging/CI and explicit publication approval remain release operations, not reasons for another product redesign.

This is evidence for a bounded WSL2 daily-use release, not a production SLA, billing guarantee or statistical proof of model-selection reliability. No commit, push, merge, tag, npm publish or GitHub Release was performed.

## 1. Exact candidate and environment

- Baseline commit: `51194348385601743a45144ab0b4ae5eb636aadb`, **with the preexisting uncommitted changes**. That SHA alone is not the tested code identity.
- All acceptance used one frozen `onedotmint-reroute-0.3.0.tgz`, SHA-256 **`de62f3837d6c941488f4f50304fbb06b3a8229a772e052f35707eb38b9460e31`**.
- `frozen-build.json` records all **79** package-file hashes. Archive files were compared with the workspace at freeze and installed files before/after acceptance. Cloud execution imported only that installed package; the actual embedded Python helper hash matched its `assets/task.py`.
- Host: WSL2 x86_64, kernel `6.18.54.1-microsoft-standard-WSL2`, Node **24.22.1**, Pi **1.4.0**, AFT **0.62.0**. SDKs: Daytona **0.223.1**, Modal **0.11.0**.
- Cloud tasks: 1 CPU / 2 GiB, 60-second command timeout, existing `reroute:node-rust-v1` starter recipe. Daytona CPU is vCPU; Modal CPU is physical cores, not equivalent performance units.
- No production source, execution policy or model-facing wording changed in this round. Later report/documentation edits are **not** byte-identical to the original 79-file artifact; the final packaging check separately identifies that documentation-only successor and checks production-runtime equality. No cloud acceptance is falsely attributed to a new commit or version number.

Evidence root: `.artifacts/release-acceptance-1oje2Y/`. Existing dirty work and `verification/ROUND5-RAW-EVIDENCE.tar.gz` were retained.

## 2. Daytona / Modal real execution

Each provider's authorized recheck passed **4/4**: cold A, unchanged A, exactly one changed source file with intentional exit **7**, and independent B. Each task verified all 70 uploaded file hashes. Genuine npm tarball download/cache entries, Unicode stdout/stderr separation, terminal receipts, remote mutations without local writeback, and B's separate ownership/storage/cold-cache state passed.

| Provider / case | Exit | E2E s | Combined transfer s | Source files uploaded | Request + gzip bytes | Upload calls | Cache hit |
|---|---:|---:|---:|---:|---:|---:|---|
| Daytona cold | 0 | 49.022 | 12.326 | 70 | 642,805 | 2 | no |
| Daytona unchanged, after explicit stop | 0 | 31.372 | 8.999 | **0** | **8,872** | **1** | yes |
| Daytona one-file change | **7** | 32.498 | 9.170 | **1** | **18,110** | 2 | yes |
| Daytona B isolation | 0 | 37.596 | 8.949 | 70 | 642,833 | 2 | no |
| Modal cold | 0 | 43.958 | 16.324 | 70 | 838,504 | 2 | no |
| Modal unchanged | 0 | 38.930 | 12.649 | 70 | 838,504 | 2 | yes |
| Modal one-file change | **7** | 39.279 | 15.056 | 70 | 838,519 | 2 | yes |
| Modal B isolation | 0 | 37.053 | 12.714 | 70 | 838,498 | 2 | no |

Daytona snapshots were 845,266 bytes each. Modal snapshots were 835,370 bytes, except the one-file case at 835,388 bytes. **These are application file payloads, not wire traffic.** Daytona counted original provider `put`, whose original implementation directly calls SDK `fs.uploadFile` once; module identity and one-to-one behavior were verified offline. Modal additionally hooked the actual original ESM SDK `copyFromLocal`: two calls per task. Neither count is an internal RPC/network request count.

Modal's normal policy terminates compute after each confirmed task. Therefore all four tasks use fresh Sandboxes and upload all source, even for unchanged or one-file inputs. Download caches persist across those lifetimes; source baselines do not. Daytona reused its A Sandbox, including explicit stop/start, retained its verified source baseline and uploaded only the changed file. Cache hit/save is true for both warm A cases; B is a cold miss on its own Volume.

### Phase measurements

Complete per-task input bytes, snapshot preparation, pack, manifest/source upload bytes/time, remote stage/unpack/verify/work preparation, cache restore/save bytes/time, execution, descendant cleanup, resource-policy release and E2E measurements are in:

- `CLOUD-METRICS.md`
- `cloud-metrics.json`
- `cloud-metrics.csv`

under the evidence root. Snapshot preparation combines scan and verified copying; it is not a separately instrumented scan-only timer. Enclosing client wall timers overlap subphases, and observer queries add overhead. Daytona `releaseMs` applies the idle guard, not immediate compute termination; explicit stop/destruction is separately recorded in lifecycle evidence. Modal release includes confirmed termination and observer checks. Unknown progress is never represented as a fabricated percentage.

### Comparison with historical data

Historical Modal measurements were 72 files / 742,267 bytes and **82.3–123.7 seconds combined transfer**. The new 70-file recheck observed **12.65–16.32 seconds**. That is a real observation of the new path, but **not a controlled before/after speedup factor**: source data, compressibility, image/cache state, provider/network conditions and observers differ. No old-code paid benchmark was repeated.

The proven improvement is reduced per-file API overhead: a cold task now needs a manifest plus one source archive, while unchanged Daytona uploads no source and one-file Daytona uploads one file's archive. Cloud tasks are correct, but for these small commands (roughly 0.7–2 seconds execution) infrastructure still dominates the 31–49 second E2E. Do not promise that offloading tiny checks is faster.

## 3. Global installation / multi-project acceptance

**13/13 groups passed** using the frozen package and real Pi CLI/native loader, PTY and RPC:

- Two clean Git projects inherit user defaults without `.reroute.json`.
- Headless/declined consent executes nothing and saves no grant. Real native Yes authorizes A; A reuses consent across sessions; B does not inherit it.
- One actual masked setup with a clearly fake key stores it once outside both sources with mode 0600; both projects resolve that saved account. Real cloud acceptance separately reused original private account credentials without copying/logging keys or changing user defaults/state.
- Production task engine with an explicitly labelled **NOTCLOUD** process/file fixture verifies A/B work/cache/job isolation and foreign-project status refusal.
- Minimal project override writes only `{"mode":"local"}`; global hash remains unchanged.
- Real global/project installation, local-path `update --extensions` reconciliation, session reload, single tool owner, Bash coexistence and independent scoped removal pass.
- Invalid configuration and missing named credentials fail closed. Missing-credential acceptance was at the production credential-resolution boundary, not a billable creation attempt.

This did not simulate a future registry 0.3.1→0.4.0 upgrade: that release does not yet exist. Evidence: `global-install/REPORT.md`, `results.json` and CLI/PTY/RPC records.

## 4. Actual model choice

Current real `openai / gpt-5.6-terra`, Pi/AFT and frozen production tools were used. Execution was a controlled isolated **local Provider fixture**, not a model-to-paid-cloud run.

| Category | Observed behavior |
|---|---|
| Lightweight files/Git/check | Local AFT read/Bash; successful Git status, Node version and small check; no remote job |
| Complete test suite | First execution tool is Reroute; no preliminary local heavy run |
| Heavy build | First execution tool is Reroute; successful isolated build |
| Complex side-effect command | Model refuses without execution |
| Command failure | Reroute exit 1 → status confirms exit 1; no local retry or dependent command |
| Unknown task | Reroute unknown → status remains unconfirmed; no local retry |

The original strict result was **5/6**, because the harness rejected safe `git status --short --branch` even though the model correctly chose local AFT. The original failed report and 22 evidence files remain unchanged. After a narrow argv allowlist correction and 24 allow / 43 deny offline checks, the separately authorized light-only recheck passed. Other five cases were not repeated.

Total **15 API requests**, below the authorized cumulative 16/original 18; all HTTP 200, no automatic retry/fallback. SDK/catalog estimate **$0.0783456**, conservative local-rate estimate **$0.123504**, neither an invoice. No classifier, predictor, scheduler, Bash interception or production wording change was added. No nested codemode call was selected; one observation per scenario does not prove long-term universal selection stability.

## 5. Harness defects, not concealed product failures

Original cloud rounds stopped after one task each, before any automatic paid retry:

1. Daytona fixture incorrectly matched npm `cache miss` log punctuation, yielding exit 90. Read-only diagnosis confirmed intact inputs and real successful download/cache save.
2. Modal observer hooked CJS SDK classes while production imported ESM; the task exited 0 but the SDK count assertion failed. Original SDK-level count is unavailable, not zero.
3. The model light-case allowlist omitted a valid read-only Git flag combination.
4. An immediate cleanup assertion did not allow asynchronous Daytona `pending_delete`; follow-up read-only reconciliation, not another deletion, confirmed absence.

Only acceptance drivers/assertions were corrected. Offline checks preceded separately authorized fresh cloud baselines and the light model recheck. Old evidence/guards were not cleared or relabelled. Total cloud tasks were **10** (2 original + 8 recheck), exactly within the amended authorization. No deterministic product defect was found requiring a core fix.

## 6. Final resources and costs

Only newly created, identified and confirmed-terminal resources were cleaned. Existing resources and old ledger records were not changed.

- **Daytona:** all 3 test Sandboxes and 3 test Volumes across both rounds confirmed absent. Pending Volume deletion was not misreported as complete.
- **Modal:** all 5 test Sandboxes confirmed terminated through production release and official polls. Sandbox exit 137 means terminated compute; it does **not** replace task exits 0/7. All 3 new test Volumes deleted and NotFound confirmed.
- **Three Modal Apps remain**, with no active Sandbox:
  - `ap-P8KoVLSb4h1iLw5wPoxZgl` — original cold attempt.
  - `ap-t9Nl6XubH6movpWXs3y4K8` — recheck A.
  - `ap-HnAsgKJYIk3rQDg7cxdSC2` — recheck B.

The installed public Modal JS SDK has no App stop/delete operation. No private RPC, guessed endpoint or additional CLI installation was used. These are recorded residual App metadata, not a claim of zero residual resources; manual cleanup through an independently reviewed official mechanism remains possible. Historical image caches/metadata were not erased. Resource checks are point-in-time observations, not eternal account-wide assertions.

Cloud conservative reservation increments: Daytona **$0.12590**, Modal **$0.2241080**, total **$0.3500080** across both rounds. Actual billed amount and account balance remain unavailable; no invoice or hard spending-cap claim is made. Model estimates above are separate.

## 7. Checks, limits and release steps

The full gate passed **262/262, 0 failures/skips**, including real AFT backend coexistence in both orders, typecheck/build and CLI smoke. Frozen installed CLI smoke and independent package installation passed. Final post-cloud verification, scoped diagnostics, artifact/runtime equality and packaging receipts are linked from the evidence root's final report.

Not newly verified: Node 22 host execution, live SSH, destroy/recreate Daytona cache restoration, broad quota/crash/disconnect fault recovery, actual billing, maximum/incompressible input stress or integrated autonomous model→paid-cloud workflows. The starter recipe is not an immutable registry digest. These are documented scope limits, not hidden broad-production claims.

Before publication:

1. Keep feature development stopped; preserve this evidence and the existing dirty work.
2. Intentionally set a new version (recommend **0.4.0**), update root lockfile metadata, CLI/help and README examples/release notes consistently. Do not publish 0.3.0 or overwrite 0.3.1.
3. Produce the final versioned tarball, check production-file differences against the accepted runtime and run clean install/smoke plus normal CI on supported Node 22/24. No new paid acceptance is required for metadata/docs-only changes; any execution-affecting change needs targeted validation and fresh authorization where billable.
4. Review the three retained empty Modal Apps and actual provider bills/budget controls. Do not delete preexisting account resources.
5. After explicit user approval, perform the desired commit/release/publication operations. None has been performed automatically.
