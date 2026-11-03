---
id: engineering.harness-tool-ownership
applies_to:
  - src/dsh.ts
  - src/tools.ts
  - src/config.ts
  - src/pi.ts
  - src/engine.ts
  - src/router.ts
  - src/snapshot.ts
  - package.json
  - cordis.patch.yml
  - scripts/check-package.mjs
  - tests/dsh*.mjs
  - tests/tools*.test.mjs
  - tests/config-boundary.test.mjs
  - tests/global-config.test.mjs
  - tests/inspection.test.mjs
  - tests/router.test.mjs
  - tests/pi*.test.mjs
  - tests/native-package.test.mjs
---
# Harness tool ownership and shared execution boundaries

The user-facing contract is [DeepSeek Harness native integration](../../docs/DEEPSEEK-HARNESS.md). This specification complements [Pi ownership](pi-tool-ownership.md) and [managed-cloud safety](managed-cloud-safety.md); adding a host must not weaken either. Requirements below are acceptance criteria, not recorded test successes.

## Ownership and distribution

Reroute owns only foreground `reroute_run` and `reroute_status` in Harness. Do not register/override Bash, intercept another tool or process spawning, add a classifier/model request, create a settings panel, or connect to Harness background jobs. Pi retains its own schemas, native progress/envelope, management command/panel and source-only loading. Shared `src/tools.ts` owns host-independent validation, eligibility/refusal, bounded output and run/status semantics; host-specific approval/rendering stays in its adapter. Keep engine/router/provider and cost rules intact, rather than bypassing them with a direct `runRemote` wrapper.

Use the same npm package: preserve `.` and `./pi`, add `./dsh` → `dist/dsh.js`, and ship `dsh.bundle.patch` → `cordis.patch.yml` activating `@onedotmint/reroute/dsh`. Pin preview compatibility to DSH `0.2.1-rc.5`; SDKs are host-provided, not production dependencies or an install-time build. Preserve clean Pi/CLI installation without installing Harness. Current-build tgz installation must be distinguished from registry publication; unchanged `0.4.1` does not imply the published package contains Harness support.

## Admission and immutable scope

Require caller identity, the per-call Session cwd and a provable local Host same-file mapping. Do not assume equal path strings identify equal files, support SSH execution-world paths by inference, or fall back to process cwd. Policy/mapping/caller uncertainty fails closed.

Let `C`, `W`, `R` be canonical Host cwd, immutable Session `workspaceRoot` and discovered project root. Require `C ∈ R`, `C ∈ W`, `R ⊆ W` for run and status. A cwd change never changes `W`. Reject a Git root above `W` and tell the user to reopen at the complete project root; never silently clip snapshots, change project identity or expand scope after consent/approval.

Complete admission before selected project-config loading, receipt disclosure, snapshots/uploads or provider access. Use a trusted optional project-discovery/config search bound; the model cannot supply or override it. Do not inherit ancestor config outside the bound. Existing unbounded Pi/CLI callers retain their behavior. Git root discovery may inspect metadata to detect an out-of-scope root; do not describe this bound as a general OS read sandbox.

`W` is originally Harness's workspace-write permission root, not a universal read root or network/upload grant. The `R ⊆ W` upload rule is **Reroute's additional conservative policy**, not automatic Harness isolation. Direct Node filesystem and cloud SDK operations are not sandboxed by implication. Private user config, credentials, receipts/consent and temporary state outside `W` are installed-plugin capabilities, not arbitrary model-directed paths; installation trust does not waive per-run consent/approval.

## Independent execution gates

- Users configure with `reroute setup`, review canonical project/upload scope, provider/account, trusted scripts/hooks and spending policy, then explicitly use `reroute authorize --yes`. No model auto-authorization, authorization tool, source flag or tool parameter may grant consent.
- Every new run requires exactly Harness `allowed-once`. Rejected, unavailable/missing approval services and `policy=never` refuse; `never` must not be interpreted as default allow. Approval does not persist project consent or broaden scope.
- Refuse new runs in read-only mode or active plan mode. Harness plan guidance alone is not enforcement. Recheck cancellation and relevant policy, cwd/scope and consent after approval waits, before handing execution to the core; do not execute using a stale approved context.
- Preserve private canonical project/provider-account consent before snapshot/upload/billable API calls, managed spending authorization, eligibility, resource limits and budget reservations. Global install/config and native approval are not substitutes. Refusal/local-mode/unconfigured/ineligible calls execute nothing locally or remotely.
- Submit one eligible compute command per call; no shell splitting/rewriting or expanded command authority. Trusted scripts/hooks remain arbitrary project code, not a security audit. Failure/unknown must not trigger automatic retry or dependent work; local retry requires user authorization.

## Status, records and cancellation

Authorize the admitted canonical current project and validate Job ownership before exposing records or contacting a provider. Status is remotely read-only: no start/resume, task creation/retry/cancel/cleanup or configuration changes. It may update an existing **local receipt**. Revoked execution consent must not prevent querying old jobs in the admitted project, nor grant new execution rights. Cross-project IDs, aliases and implicit recovery must not leak another project's records.

Preserve the distinction between pre-query `recorded*` fields and a fresh `remoteConfirmed`/`remoteStatus`. Online resources, historical success and remote `unknown` are not task confirmation. Retain confirmation facts and a separate persistence diagnostic if saving a fresh receipt fails. E2B verification stays fail closed without its potentially auto-resuming connection API. No live refresh capability means no fabricated fresh confirmation.

Harness returns canonical domain data with its own renderer, not Pi envelopes. Nonzero exits/unknown states retain allocated Job IDs and are not mechanically turned into thrown adapter errors. Bound output/diagnostics and explicitly flag truncation. Propagate the execution signal and await owned cleanup, including when cancellation is pending.

For cancellation, preserve an allocated Job ID in native text, while acknowledging that Harness removes the canonical value and PTC receives only a cancellation error. Harness-only `reroute_status({})` resolves the latest allocated ID for the **current live Session**, then applies normal current-project checks; it is not a disk-wide or cross-session search. Reload/unload/restart loses that implicit mapping. Persistent receipts remain accessible with an explicit `jobId` (the user can discover IDs with `reroute jobs`). Never promise durable all-session recovery, expose foreign-job details after cwd changes, or ignore cancellation to retain a canonical result.

Unload must explicitly abort and await owned operations, not merely unregister tools. Hard process exit, abort, network loss or client disposal does not guarantee remote termination, resource release or cessation of billing. Preserve unknown states and require status/provider verification rather than automatically retrying.

## Required regression coverage and evidence

Record actual results in [DELIVERY](../../DELIVERY.md#deepseek-harness--unreleased-current-build), not here in advance. Cover:

- Native and PTC schema/canonical/rendering behavior, nonzero/timeout/unknown/error, bounded UTF-8 output and receipt persistence failures.
- Missing caller/mapping/policy, local versus SSH file worlds, immutable root across cwd changes, canonical aliases, nested cwd, out-of-bound ancestor config and Git root, with no upload/provider access on refusal.
- No consent, approval denied/unavailable/never, cancellation while awaiting approval, read-only and active plan; no new execution, consent persistence or scope expansion. Revalidation after waits must prevent stale-context execution.
- Project-scoped status, execution-consent revocation, saved history versus fresh confirmation, E2B fail-closed behavior, foreign-ID non-disclosure and local receipt updates.
- Cancellation native text versus missing canonical value/PTC error; `{}` recovery within the live Session, missing mappings, changed project, reload/restart loss and explicit-ID recovery.
- Explicit unload abort/await; no fake remote-stop guarantee or automatic remote/local retry.
- Real local tgz/profile install/load/remove, bundle/export contents and host-provided SDK resolution, no unwanted production SDK installation; preserve Pi source-only loading, both Pi/AFT orders and existing tools/UI.

Initial fixture evidence is Linux / Node 24 only. Actual model selection, standard user UI/other platforms and paid-cloud/billing acceptance need separate recorded evidence and authorization; fixture/loading success must not be presented as those claims.
