# DeepSeek Harness native integration

**Status: WIP checkpoint, not for real projects or paid tasks; package version remains `0.4.1`.** Two approval-wait races are still open; see [current status and blockers](DEEPSEEK-HARNESS-STATUS.md). The registry's existing `0.4.1` is not evidence that this feature is published. [README](../README.md) retains Pi installation and release-publication guidance; Pi's tools, `/reroute` panel and source-only loading remain supported.

## Compatibility and packaging

The supported preview target is **`@deepseek-ai/dsh@0.2.1-rc.5`**. Pin this version: master, alpha, other 0.2.x releases, Desktop and Windows are not interchangeable compatibility promises. Initial isolated fixture evidence is limited to **Linux / Node 24**. The general Reroute CLI/Pi Node requirement does not establish Harness compatibility.

One npm package, `@onedotmint/reroute`, serves both hosts:

- Existing `.` engine and `./pi` exports and Pi package metadata remain intact.
- `./dsh` exports the prebuilt `dist/dsh.js` entry.
- `dsh.bundle.patch` points to the shipped `cordis.patch.yml`, which activates `@onedotmint/reroute/dsh`.
- Harness/Cordis SDKs are supplied by the host, with pinned development dependencies for compilation; they are **not production dependencies** that install a second Harness into Pi/CLI installations. No install-time build hook is required.

The [feasibility investigation](DEEPSEEK-HARNESS-FEASIBILITY.md) records earlier SDK/fixture probes, not completed integration acceptance. Current verification belongs in [DELIVERY](../DELIVERY.md#deepseek-harness--unreleased-current-build).

## Install the current build

Use an existing DSH `0.2.1-rc.5` installation and a source checkout with development dependencies installed. Build and pack **this checkout**, not a historical registry tarball:

~~~bash
cd /path/to/Reroute
npm run build
npm pack
# Use an explicit Harness profile:
dsh plugin --profile web add ./onedotmint-reroute-0.4.1.tgz
npm install -g ./onedotmint-reroute-0.4.1.tgz
~~~

Use the actual filename emitted by `npm pack`. The unchanged version number does not identify the source revision; retain the tarball's source identity/integrity when recording acceptance. DSH consumes the compiled entry, unlike Pi's existing source-only Git installation.

Once a release **containing this integration** is published, the registry installation form is:

~~~bash
dsh plugin --profile web add @onedotmint/reroute
~~~

That is not an installation path for this unpublished work. A successful local build, tarball or CI artifact does not publish to npm or create a GitHub Release.

### Configure and authorize as a human

From the complete project root, use the CLI from the same current build:

~~~bash
cd /path/to/your-project
reroute setup
# Review the canonical root, full source-upload scope, provider/account,
# trusted scripts/hooks, credentials and separate spending authorization.
reroute authorize --yes
~~~

`setup` saves configuration; it does not grant every project execution consent. `authorize --yes` is an explicit human action after review, **not a command for the model to run automatically**. No model-callable authorization tool or new Harness settings panel is provided. Existing masked CLI setup, user defaults and project overrides are reused.

## Tools and execution ownership

Only two foreground tools are registered:

~~~text
reroute_run({ command: "npm test", timeout: 120, cpu: 4, memoryGiB: 8 })
reroute_status({ jobId: "..." })
reroute_status({})  // Harness-only live-Session recovery; see below
~~~

`command` is required; timeout (seconds), CPU and memory overrides are optional and remain subject to existing validation and limits. Submit one independent eligible command, without pipes, redirects or compound shell operators. Dependent tasks require separate calls: wait for success and stop on failure/unknown. Project scripts and lifecycle hooks remain trusted code, not recursively audited code.

The shared run/status boundary preserves Pi/CLI engine behavior, eligibility and budget rules. Unconfigured, ineligible or local-mode calls refuse without local or remote execution. No Bash replacement/interception, process hook, classifier, automatic retry, provider expansion, Harness `ctx.jobs` integration or automatic background promotion is added. Ordinary shell/files/Git remain with the host's tools. No custom Web card or invented progress percentage is promised.

Harness receives canonical structured run/status fields, with a native text rendering, not Pi's `content/details/isError` envelope. A nonzero exit or `unknown` task is a domain result, not proof that the tool pipeline failed or the task stopped. Output retains the shared bounded tails and explicit truncation; full logs are not saved by these tools. A failed/unknown invocation must not automatically retry remotely or locally; inspect status first, and obtain user authorization before a local rerun.

## Three separate gates

1. **Harness admission:** every new run requires an approval answer of exactly `allowed-once`. `policy=never` rejects requests; it is not automatic approval. Rejected, unavailable or missing approval services fail closed. Read-only sandbox mode or active plan mode refuses new runs. Plan mode is soft guidance in Harness, so this refusal is explicit Reroute behavior.
2. **Project execution consent:** a private receipt binds the canonical project to the provider/account and authorizes source upload and trusted scripts. Installation, one Harness approval, a model parameter or a project-source flag cannot create this consent.
3. **Managed spending policy:** reviewed account authorization, deterministic resource limits and conservative budget reservations still apply independently. Approval/consent cannot bypass them; estimates are not actual billing or hard spending guarantees.

After waiting for approval, the adapter rechecks cancellation, cwd/scope, sandbox/plan mode and the stored project consent. **It does not yet reload changed execution/budget configuration or recheck a newly selected approval policy; the two open races in the status document must be closed before real use.** Approval is not persisted as project consent, and no approval service is not an unattended-mode exception.

## Local Host and source-upload boundary

Only projects with a **provable same-file mapping to the local Node Host** are supported. An SSH/execution-world path with identical spelling is not evidence of that mapping. Missing caller identity, mapping or required policy information fails closed; there is no fallback to `process.cwd()`.

Let `C` be the current Session cwd, `W` the Session's immutable `workspaceRoot`, and `R` Reroute's discovered project root. In canonical Host coordinates, require **`C ∈ R`, `C ∈ W`, `R ⊆ W`**. Changing cwd does not move `W`. Both run and status enforce this admission before loading the selected project configuration, exposing job records, preparing a snapshot or contacting a provider.

If Harness opened `/work/repo/packages/a` but Git's root is `/work/repo`, refuse and ask the user to **reopen the Session at the complete project root**. Do not silently truncate the project, inherit an out-of-bound ancestor config, change consent/cache identity or widen `W`. The configuration discovery bound is trusted host input, never a model-controlled tool parameter; unbounded Pi/CLI discovery retains its existing behavior.

**`W` originally defines Harness's workspace-write permission root, not a universal read boundary or source-upload authorization.** Restricting uploads to a project within `W` is an additional conservative Reroute policy. Harness does not automatically sandbox direct Node filesystem/cloud SDK access. Git metadata discovery is not an OS read sandbox. User defaults, credentials, private consent/receipts and temporary state may live outside `W` as installed-plugin capabilities, not arbitrary model-supplied paths or evidence of automatic Harness isolation.

## Status and confirmation

Status only queries remote state; it never starts/resumes resources, creates/retries/cancels/cleans tasks or changes configuration. It **may update the local receipt**, so it is not a globally write-free operation. Revoking execution consent still permits checking old jobs within the admitted current project; it grants no new run authority and does not cancel existing tasks.

Before record disclosure or provider access, validate the Job ID and canonical current-project ownership. Foreign jobs remain inaccessible, including through implicit Session recovery. No cross-project history fallback is allowed.

- `recordedStatus`, `recordedExitCode`, `recordedError` describe the pre-query local record.
- `remoteConfirmed` and `remoteStatus` describe a fresh valid task response, not resource availability or saved success.
- Read `exitCode` together with `remoteConfirmed`; `error` retains verification/persistence diagnostics, including a failure to save a confirmed response.

A timeout, disconnect, invalid receipt or remote `unknown` does not prove termination. **E2B remains fail closed**: do not invoke its potentially auto-resuming connection API merely to verify status. Historical evidence is not a fresh remote confirmation.

## Cancellation and recovery

The execution signal is passed through to Reroute; owned cleanup is awaited. Cancellation does not authorize ignoring the signal to preserve a successful return value.

When a Job ID has been allocated, cancellation's **native text retains that ID**. DSH `0.2.1-rc.5` nevertheless removes the canonical value on cancellation: PTC code sees a cancellation error, not the returned run object. Therefore Harness adds `reroute_status({})`, resolving the latest allocated Reroute Job ID associated with the **current live Session**, then applying the normal current-project ownership checks. It is not an all-session persistent history lookup; no allocated ID means no implicit recovery.

Reloading/unloading the plugin or restarting Harness loses that in-memory association. Recover with an explicit `reroute_status({ jobId: "..." })`; the user can find the ID via `reroute jobs` in the project. Existing private receipts persist independently of this convenience mapping. After cwd/project changes, `{}` must not expose another project's job.

On unload, the plugin explicitly aborts and awaits operations it owns before completing disposal; unregistering tools alone is insufficient. This is cooperative cleanup, **not a guarantee that hard process exit stops remote processes or cloud resources/billing**. Unknown state still needs status/provider verification; no automatic retry follows cancellation, failure or disconnection.

## Acceptance limits

The current Linux / Node 24 candidate passed strict typecheck/build, 36 Harness component checks, 59 focused Pi/config checks, and one real packed-bundle install/native/PTC/remove integration. The latter exercised refusal/status paths without a Provider; component tests used the real engine with mock Providers. Per user request, the full suite and comprehensive clean-consumer package gate were not run. These checks are not real Agent/model-selection, standard Web/Desktop UI, Windows or paid-cloud/billing acceptance. See [checkpoint status](DEEPSEEK-HARNESS-STATUS.md), [DELIVERY](../DELIVERY.md#deepseek-harness--unreleased-current-build), and the [engineering contract](../specs/engineering/harness-tool-ownership.md).
