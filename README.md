# Reroute

**Keep editing locally in WSL2 and using Pi normally. Send eligible builds and tests to remote compute.**

Reroute is an on-demand task offloader, not a remote IDE or a synchronization daemon. A conservative router sends recognized build/test/check/benchmark tasks to the configured provider. Git, file inspection, deployments, ambiguous shell constructs and unknown commands are not automatically offloaded (use ordinary Bash in Pi). Failed remote jobs never silently retry locally.

**Status:** 0.3.0 development candidate, merged into `rebuild/0.3-native` as `2382dc5` and **not yet published to npm**. Managed **Daytona is live-verified**; managed **Modal is implemented and offline-tested but has never been run against the real service**. SSH has historical real localhost OpenSSH evidence. Billing remains unverified for every provider.

## Install as a native Pi PROJECT package (recommended)

Reroute now relies on **Pi's own package manager**. From your WSL2 project (Pi and Node.js >= 22.19 required):

~~~bash
cd /path/to/your-project
pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native
pi
~~~

Approve **Pi project trust** after reviewing this package. Inside Pi, run `/reroute` → **Configure Daytona / Modal / SSH (masked terminal)** for the exact terminal command. In that terminal wizard, use **Space to select one or both cloud providers**, then Enter; enter credentials privately, review defaults and choose the project default. No Sandbox ID is needed for managed compute. The manual Pi profile editor and `setup --advanced` still support existing targets. Reroute saves `.reroute.json` in this project. Other projects do not load the extension.

Pi now owns the installation record at **`.pi/settings.json`**, source checkout, loading, updating and removal. There is no custom entry under `~/.pi/agent/extensions/` and no global Node or Pi installation required. A Pi project package is not loaded before the user trusts the folder.

~~~bash
pi list
pi update --extensions
pi remove -l git:github.com/onedotmint/Reroute@rebuild/0.3-native
~~~

For noninteractive inspections, `pi list --approve` explicitly permits reading trusted project settings; `pi list --no-approve` intentionally hides them. Global Pi installation is available by **omitting `-l`**, but project-only is the default recommendation.

The Git checkout does not need a built `dist/`: Pi's native TypeScript loader loads `adapters/pi.ts` and the source modules directly. A local checked-out source directory is also a native Pi package: `pi install -l /absolute/path/to/Reroute`.

**Important:** Reroute is **not published to npm** yet. Do not use `pi install -l npm:reroute`. The Git ref above is the supported native package source. [Successful GitHub Actions](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml) also uploads `reroute-0.3.0.tgz` for the **optional standalone CLI**.

### Optional CLI and masked API keys

The `/reroute` Pi screen can create, inspect and edit project profiles without the CLI. For Daytona / Modal / E2B credentials, prefer each provider's native environment or authentication. **Pi's text inputs are not masked**: never type API keys into an ordinary Pi input prompt.

For masked API-key entry, read-only resource discovery and advanced diagnostics, install the optional CLI tarball from a successful GitHub Actions run:

~~~bash
npm install -g ./reroute-0.3.0.tgz
cd /path/to/your-project
reroute setup
reroute doctor --connect
~~~

The standalone CLI manages only `.reroute.json` and the opt-in private credentials file. It **does not register a Pi extension or modify Pi settings**. Pi installs and removes its native package itself.

### Migrating from the earlier handwritten extension

Earlier Reroute candidates installed `~/.pi/agent/extensions/reroute.ts` globally. Before enabling the new native package, inspect that file. **Only remove it if its first line is `// Reroute v3 owned extension entry`**; leave unowned or modified files untouched. The new installer does not delete any global extensions automatically. Duplicate global/project registration could cause conflicts, and an old entry may still override Bash. Updating the native package does not retire a separate historical extension. Restart Pi (or reload extensions) after updating; no reinstall is normally needed for an existing branch-based native package. Before this PR is merged, try the feature branch with `pi install -l git:github.com/onedotmint/Reroute@feat/pi-independent-tool` in a trusted test project.

## Friendly setup and Pi control panel

`reroute setup` now starts a **multi-select**: Daytona, Modal and/or SSH (Space toggles, arrows move, Enter confirms). Configure Daytona and Modal in one pass, then choose the default provider. New cloud profiles get separate named credentials and sensible reviewable defaults; only **Customize** expands specifications, image, budgets and rates. SSH only asks for your existing host/alias. API-key entry is **masked**; Modal takes a Token ID and Secret. Existing profiles stay untouched unless you use advanced editing; you can add another account without overwriting them.

`reroute setup --advanced` keeps the previous detailed flow for account edits, existing Sandbox IDs, E2B/SkyPilot and custom targets; explicit/non-interactive setup flags remain compatible. Quick setup makes **no cloud requests** and saves only after a final confirmation. Spending authorization is a separate **default-No** confirmation for newly configured, credential-ready cloud profiles; choosing providers does not authorize charges. Canceling before final save writes neither project settings nor newly entered credentials.

Cloud credentials are read from each provider's native environment/configuration first. For users who explicitly choose **Save locally**, Reroute stores keys outside the project in `~/.config/reroute/credentials.json` (or `$XDG_CONFIG_HOME/reroute/credentials.json`), with a private 0700 folder and 0600 file. This is **not an encrypted keychain**; use environment variables/native CLI authentication instead if preferable. API keys never appear in `.reroute.json`, the wizard's review, or Pi panel labels. Reroute passes saved credentials directly to official SDKs without adding them to global environment variables.

~~~bash
reroute credentials                                  # sources only; never prints keys
reroute credentials forget --provider daytona --yes   # forget saved Daytona key only
~~~

Use `/reroute` to add/edit profiles in Pi, or rerun the optional `reroute setup` CLI wizard. Both use the same project configuration. Credential/resource checks are not evidence that a paid cloud account was live-tested in CI.

In Pi, `/reroute` shows the **active profile, provider, resource ID, routing mode and credential availability**. **Overview** lists local profiles and recent task counts; **Manage providers** adds/edits/switches/forgets profiles and explicitly discovers existing resources. **Advanced** holds credential-key removal and all stop/resume/destroy resource operations, with explicit confirmation. **Check connection** is opt-in. Opening the panel does not contact cloud APIs, resume compute, or use a model.

## Provider prerequisites

All execution targets need Linux, Python 3, Bash, a /proc filesystem and your project toolchain. SSH/SkyPilot/E2B and attached cloud targets must already exist. Managed Daytona/Modal can create compute from a reviewed image; `reroute:node-rust-v1` is the starter SDK-built image (Rust stable, Node 22/npm, Python 3). Its actual cloud image build still needs live acceptance.

| Provider | Preexisting setup | Behavior |
|---|---|---|
| SSH | OpenSSH host/alias, key auth, trusted host key, rsync locally and remotely | Native ssh/rsync; host stop/resume/destroy unsupported |
| SkyPilot | Configured `sky` CLI, existing UP cluster, usable matching SSH alias and rsync | Sky status/start/stop/down plus native SSH execution, no automatic cluster launch |
| Daytona | API key; opt-in managed policy **or** existing Sandbox ID | Official SDK discovery/create, custom vCPU/GiB, Volume and guarded auto-stop; no stdin |
| Modal | Token pair/native auth; opt-in managed policy **or** existing Sandbox ID | Official JS SDK App/Sandbox/Volume, physical CPU/GiB hard limits; managed compute released after confirmed tasks |
| E2B | SDK credentials and existing running Sandbox ID | Official SDK command/file APIs; resume/pause/kill only via explicit controls |

**Support policy:** Daytona/Modal managed operations are implemented and offline-tested, **not production-qualified or live-billing-verified**. SSH/SkyPilot/E2B existing-resource compatibility is retained; no additional providers were added. SDK/CLI contracts and service quotas may change. Creation/start can incur charges; no free credit is assumed. See [managed profiles](#managed-cloud-profiles) and the [live checklist](docs/MANAGED-CLOUD.md#authorized-live-acceptance).

## Everyday commands

~~~bash
reroute explain -- npm run build
reroute run -- cargo test                 # conservative auto routing
reroute exec -- cargo test                # force remote
reroute local -- cargo test               # force local
reroute exec --shell 'npm test && npm run build'  # explicitly trust a compound shell command
reroute mode local
reroute mode auto
reroute jobs
reroute status JOB_ID
reroute cancel JOB_ID
~~~

### Independent Pi tool

**AFT or Pi handles ordinary Bash execution. The Pi Package includes independent `reroute_run` and `reroute_status` tools; the standalone CLI is optional.** Both tools are active by default after trusted package loading. Reroute does not register/override `bash`, handle `user_bash`, rewrite other tools' calls, or hook process spawning. AFT requires no changes or special load order.

The execution tool accepts `{ command: "cargo test", timeout: 120, cpu: 4, memoryGiB: 8 }` (timeout/specification optional). CPU/memory override only this task on managed compute, respect project limits, and do not silently resize attached targets. Modal CPU is **physical cores**, Daytona CPU is vCPU. Submit **one independent, eligible compute command per call**, without `&&`, pipes, redirects or complex shell combinations. For dependent tasks, call the tool separately, wait for the preceding task to succeed, and stop dependent tasks if it fails or remains unknown. It uses Pi's current project working directory and the same `.reroute.json`, snapshots and execution engine as the CLI. Explicit package-manager scripts such as `npm test`, `npm run build` and custom `npm run <task>` are treated as the project's remote compute boundary; Reroute does not recursively inspect or prove every lifecycle script. Direct project file invocations (`node scripts/verify.mjs`, `python3 scripts/validate.py`, `./scripts/compute`) and custom Make/Ninja targets are also accepted. Unrecognized named scripts/targets use the existing `build` category, so disabling that category still refuses them. Shell syntax, working-directory changes, watch/serve modes, authentication, deployment and interactive commands remain restricted.

A local routing decision (including `mode=local`), an unconfigured project or an ineligible command produces `not_started` with the reason: **nothing is run locally or remotely by the tool**. The tool does not fall back to local Bash after a refusal or remote failure; the coding agent may choose AFT Bash separately when the task itself is a quick/local operation. Standalone `reroute run` retains its existing CLI local-routing behavior; this is not a change to or interception of AFT. Attached resources never auto-start; only an explicitly authorized managed profile can discover/create/start compute after deterministic specification and budget checks.

Results include status, exit code, Job ID (if allocated), separate stdout/stderr and errors, in text and structured data. Progress is bounded and throttled. Only the final 8192 characters of each output stream are retained (long diagnostics are bounded too); truncation is explicitly reported, and the tool does not save full logs. Arrange explicit output artifacts when a complete record is needed. A confirmed timeout returns 124, a confirmed cancellation returns 130, and infrastructure/unknown/incomplete output returns 125. A failed or uncertain remote task is **never** retried locally: inspect its Job ID with `reroute_status({ jobId: "..." })` (no CLI required) and obtain user authorization before a local rerun.

**Tool choice stays with the current coding agent.** Prefer Reroute for full builds/test suites and slow CPU/memory-heavy checks; keep quick checks, Git, file operations and ordinary shell with Pi/AFT. Ambiguous work is judged from project context, not by an extra classifier/model request. Existing deterministic eligibility, authorization and budget gates still apply after the choice. No Bash interception or automatic local retry.

Pi can reference **up to three short project-history observations** from existing receipts: at least two confirmed exited runs in the past 30 days, matching the current provider/account/image/specification (and resource ID for attached targets). Each category uses at most five recent samples and reports remote execution-time range, nonzero exits and measured download-archive restores. No raw command/output/error is injected, no local speedup is inferred, and suggestions never authorize a retry. Missing, corrupt, stale or incompatible history stays silent. These tool-guideline observations replace the previous turn’s observations rather than accumulating chat messages; no extra model/API call or database is introduced.

**Model tool selection is not deterministic command interception.** Loading tests establish compatibility, not selection accuracy. The opt-in real-model probe is `REROUTE_MODEL_ACCEPTANCE=1 node tests/pi-model-selection.mjs` from this checkout; it uses actual installed Pi/AFT and an isolated local process fixture, **not cloud compute**. The latest probe passed light-command selection, but the next model request failed, leaving heavy-task selection/failure-follow-up unverified. Redacted evidence: `.artifacts/pi-workflow-selection.json`. No claim of general selection stability.

Automatic routing fails closed for unrecognized top-level commands, redirects, pipes, expansions, working-directory changes, watch servers, authentication, deployment/publishing and other obvious side-effect commands. A package script is different: once the agent explicitly chooses `reroute_run`, its named script is trusted as the remote compute boundary and is not recursively audited. **Project scripts and pre/post hooks can run arbitrary code, including network, filesystem, deployment or other side effects under the remote account.** Command-name restrictions are not a sandbox or an audit: review/trust project code and do not place unnecessary secrets in the remote environment. The tool neither recommends local retry after refusal nor prevents the agent from separately calling AFT. To override a top-level routing refusal explicitly use `reroute exec`. Use `reroute --help` for setup flags, diagnostics and resource management.

### Job status without the CLI

Call `reroute_status({ jobId: "..." })` after an execution failure or unknown result. This tool accepts only `jobId` and only queries jobs belonging to the canonical current project root, including calls from nested directories or filesystem aliases. Invalid, missing and cross-project jobs fail without contacting a provider or revealing a foreign job's details.

The result explicitly separates:

- `recordedStatus`, `recordedExitCode`, `recordedError`: the local record captured **before** this query; not a claim about the current remote state.
- `remoteConfirmed`: true only after obtaining a valid, non-unknown task status response. Resource availability alone is insufficient. `remoteStatus` is null when unconfirmed.
- `exitCode`: the fresh response's exit code when confirmed (null for a nonterminal response), or the last recorded exit code when unconfirmed; null means unavailable. Read it together with `remoteConfirmed`.
- `error`: a verification/persistence diagnostic; an unsuccessful verification is an error result even when the saved job previously exited successfully. A successful query of an exited job with a nonzero code does not mean its computation succeeded.

Queries have a 30-second client deadline and may refresh the local receipt, but never start/resume resources, create/retry/cancel/clean tasks, or change project configuration/credentials. They use only the existing provider availability and task-status mechanisms. **A disconnection, timeout, invalid receipt or remote `unknown` response cannot establish completion or termination.** The tool returns the authorized last-known record with an explicit failed-verification indication; it cannot guarantee recovery of live state while disconnected. For E2B, native task verification currently fails closed even when the resource is online: the existing adapter uses a connection API that may resume a concurrently paused sandbox. No such connection is attempted by this tool. Do not rerun locally without user authorization.

## Source inputs, caching and artifacts

Reroute takes a two-read verified snapshot before the task: includes tracked/uncommitted/untracked non-ignored source, excludes deleted files and common secret files, .git, dependencies and build caches. It rejects source symlinks and inconsistent snapshots. Use `.rerouteignore` for extra private or bulky paths. Two reads reduce races; this is **not an atomic filesystem snapshot**. Avoid editing the same files while input is prepared. Known native credential stores and configured SSH identity files are excluded even when tracked, and SSH disables agent/X11/port forwarding. This is **not a general secret-content scanner**: keys embedded in ordinary source, copied/hard-linked to an unrecognized name, or held in other private directories still require removal or `.rerouteignore` exclusions.

SSH/SkyPilot transfer via native rsync; other providers use native SDK file APIs plus a manifest. Each job gets its own execution directory, separate from reusable dependency/toolchain caches. Jobs on a project remote workspace are serialized rather than racing a shared cache. Remote edits **never write back to local source**. Project cache directories on an attached shared host/Sandbox are namespaces, not access control between scripts running as the same remote UID; use separate managed Sandboxes/Volumes for mutually isolated projects. Scripts can read credentials already present on their remote target and can directly write their own mounted Volume. Trust project code and the selected image/target; do not treat these paths or cache checksums as a hostile-code sandbox.

To retrieve an output, have the remote command put it under the `$REROUTE_ARTIFACTS` directory, or request a file retained in that job's remote work directory:

~~~bash
reroute artifacts JOB_ID @outputs/result.txt --to ./result.tgz
reroute artifacts JOB_ID path/in/workspace/result.bin --to ./result.tgz
~~~

Artifact downloads are checksum-verified tar.gz archives, limited to 256 MiB, and never overwrite an existing local file. Inspect/extract manually. `reroute cleanup JOB_ID --yes` removes only a confirmed terminal job.

## Safety and troubleshooting

- `reroute doctor --json` checks local requirements; `reroute doctor --connect` probes an existing target, without provisioning it.
- `reroute resource resume --yes --allow-cost` applies to attached resources and may incur costs; managed resources start on the next authorized task. `reroute resource stop --yes` / `destroy --yes` are explicit and protect active/unknown jobs. `resource recover --yes` discovers an uncertain managed allocation without starting compute; it never clears remote task locks.
- On an `unknown` task, use `reroute_status({ jobId: "..." })` in Pi (or optional CLI `reroute status JOB_ID`) and native provider logs before deciding to rerun. Network loss is not proof that remote execution stopped.
- Older 0.2 synchronization state is not deleted or migrated. Recover any pending files through the legacy version before using `reroute setup --ignore-legacy`.
- Files sent to remote should not contain credentials. Automatic exclusions are defensive, not a secrets scanner. Run on least-privilege isolated compute.
- Real user WSL2 Pi extension startup, cross-machine network performance and all four cloud backends remain to be tested. See [DELIVERY.md](./DELIVERY.md).

License: Apache-2.0; dependencies have their own licenses.

## Managed cloud profiles

This work is merged into `rebuild/0.3-native`. To run from source instead of the packaged tarball:

~~~bash
cd /path/to/your/Reroute/checkout
npm ci
npm run build
cd /path/to/your-project
pi install -l /path/to/your/Reroute/checkout
node /path/to/your/Reroute/checkout/bin/reroute.mjs setup
pi
~~~

In setup, press **Space** to select Daytona and/or Modal (Daytona starts selected), then **Enter**. Choose masked credential entry: one API key for Daytona, Token ID + Secret for Modal. Select **Use recommended settings** or **Customize**, choose the default provider, review the rates, and save. Defaults are 1 CPU / 2 GiB, the Node/Rust/Python starter image, $3/month estimated budget **per credential account**, $0.50/task and a 5-minute idle allowance. These are separate account limits, not a combined $3 cap.

Authorization defaults to **No**. Leave it off to save keys/configuration without permitting future creation/start. A credential deferred with “Configure later” cannot be newly authorized by this wizard. Existing profiles and their prior authorizations are preserved. For custom accounts/targets use `setup --advanced`; in Pi, **Manage providers → Configure providers / API keys (masked terminal)** gives the exact installed setup command, including the current project path. Never paste a key into a Pi field.

- Named credentials are in `~/.config/reroute/accounts/NAME.json` (0700 directory, 0600 unencrypted file). A named account **never falls back** to environment/default/native credentials. Unnamed profiles retain legacy environment-first authentication. `reroute credentials --credential NAME` shows sources only; `forget --provider daytona --credential NAME --yes` affects only that saved account/provider.
- Profiles choose the account explicitly. Marking one as your gift-credit account is a user choice, **not verified credit**. There is no account rotation or automatic registration.
- Presets: `small` 1 CPU/2 GiB, `medium` 2/4, `large` 4/8. Custom values and project defaults are supported. Single-task `--cpu 4 --memory 8` or Pi `cpu`/`memoryGiB` overrides preserve the saved default. Rust recommendations suggest 4/8; other tasks suggest 2/4. Suggestions show whether they fit configured limits and never override a user specification.
- Local quota envelopes (`maxCpu`, `maxMemoryGiB`) and cost reservations are checked before allocation. SDK-compatible units/minimums are validated. **Actual account quota/capacity is enforced by the provider's API, not pre-certified by Reroute.** Rejected or uncertain creation is never reported as successful or blindly retried.
- `reroute plan --cpu 4 --memory 8 -- cargo test` is offline: estimated reservation, specification, recommendation and explicitly unavailable balance. Defaults are a **$3 local monthly estimate budget**, $0.50/task and no assumed free credit. These are USD, not a currency-conversion promise or hard self-pay cap.
- Reservations include the maximum task window, preparation/idle allowance and a conservative storage allowance **on every task**. They are intentionally not refunded automatically, including after ambiguous failures. `reroute status` shows the local reservation ledger, not an invoice. `job.cost.runtimeSeconds` is observed client allocation/execution elapsed time, **not provider-confirmed billable uptime**. Image builds, retained storage, egress, billing delays, external use and service failures can produce additional charges. Configure available native account spending protections yourself before authorizing paid compute.
- Daytona uses label-based discovery, stable installation/project ownership and a project Volume. Guarded auto-stop protects a task's deadline, then returns to the configured idle delay after confirmed completion. Modal uses tagged App/Sandbox discovery and a named Volume, CPU **reservation and hard limit**, and a provider lifetime guard. It releases compute immediately after a confirmed task: this SDK cannot extend lifetime or adjust idle delay on an existing Sandbox. Modal's `idleMinutes` contributes to the fallback lifetime estimate, not a promise of a mutable idle timer. Stopping/recreating compute never deletes the Volume.
- Only dependency-download stores cross Sandbox lifetimes. Cargo `target` remains local scratch; npm dependencies are freshly installed from the lockfile per job. Download archives are isolated by project, provider, image and lock/toolchain inputs; archives are size-limited and checked against traversal, links and corruption. Cache warnings preserve the task exit code. Metrics include provision, execution, restore/save timings and cache hit; **no cloud speedup is claimed without live measurements**.
- Cloud intents/leases/reservations live under `~/.local/state/reroute-v3/cloud` (or the existing state override), outside Git/project configuration. Preserve this directory. A crash/unknown task blocks replacement and destructive cleanup. `reroute resource recover --yes` releases only a dead local client lease and discovers the same owned allocation; it does not start, retry, delete or clear task locks. Missing/ambiguous resources need provider-console verification and manual support, not repeated creation.

For the precise SDK evidence, retained billing risks, limitations and authorized live test steps, see [Managed cloud operations](docs/MANAGED-CLOUD.md). Managed **Daytona is live-verified**; managed **Modal has never been run against the real service**. Billing is unverified for both.
