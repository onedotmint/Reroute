# Reroute

**Keep editing locally in WSL2 and using Pi normally. Send eligible builds and tests to remote compute.**

Reroute is an on-demand task offloader, not a remote IDE or a synchronization daemon. A conservative router sends recognized build/test/check/benchmark tasks to the configured provider. Git, file inspection, deployments, ambiguous shell constructs and unknown commands are not automatically offloaded (use ordinary Bash in Pi). Failed remote jobs never silently retry locally.

**Version: 0.4.1.** Dependency-security and npm-packaging patch: production high-risk dependency fixes, repository-only locking, host-provided Pi SDKs and reviewed automatic update PRs. See [0.4.1 release notes](docs/RELEASE-0.4.1.md) and the [remaining dependency findings](docs/DEPENDENCY-SECURITY.md). Publication status is determined by [npm](https://www.npmjs.com/package/@onedotmint/reroute), not by a passing build; no GitHub Release is required. Global-first installation, reusable defaults, per-project consent and packed source transfer from [0.4.0](docs/RELEASE-0.4.0.md) remain supported. Earlier [real-service acceptance](docs/RELEASE-ACCEPTANCE.md) is historical, not new cloud qualification for this patch. Billing and broad fault recovery remain uncertified.

## Install once as a global native Pi package (recommended)

From WSL2/Linux with Pi and Node.js >= 22.19:

~~~bash
pi install npm:@onedotmint/reroute@0.4.1
cd /path/to/your-project
pi
~~~

Inside Pi, open `/reroute` → **Configure Daytona / Modal / SSH (masked terminal)** and run the provided command in a terminal. Select your provider, enter masked credentials, accept or customize defaults, and review spending authorization. No Sandbox ID is needed for managed Daytona/Modal. This saves user defaults at `~/.config/reroute/config.json` (`$XDG_CONFIG_HOME/reroute/config.json`); ordinary projects need no `.reroute.json`.

Pi owns package installation, loading, updates and removal. There is no handwritten `~/.pi/agent/extensions/reroute.ts` entry. **Global installation and account spending consent do not authorize every project.** The first remote tool call in each project asks permission to upload its source and execute trusted scripts using the selected account. Rejecting it runs nothing. Consent is reusable private local state, not a flag inside project code.

~~~bash
pi list
pi update --extensions
pi remove npm:@onedotmint/reroute@0.4.1
~~~

**Optional project-only installation:** add `-l` to `pi install` / `pi remove`; Pi records it in `.pi/settings.json` and requires project trust. Use `setup --project` for special project configuration; existing files are not migrated or overwritten by global setup. A global and a project copy may coexist without registering duplicate Reroute tools; keep versions aligned and remove an obsolete copy through Pi. For noninteractive inspection, `pi list --approve` permits reading trusted project settings; `--no-approve` hides them.

For a historical 0.4.0 Git install, use `pi install git:github.com/onedotmint/Reroute@v0.4.0`; this is not the 0.4.1 patch. Use the versioned npm install above for 0.4.1. The Git checkout does not need a built `dist/`: Pi's native TypeScript loader loads `adapters/pi.ts` and source modules directly. For a local checkout, use `pi install /absolute/path/to/Reroute` (add `-l` only for project-only installation). Historical 0.3.x packages do not contain all 0.4.0 changes.

The npm package is **`@onedotmint/reroute`**, not the unrelated unscoped `reroute`; the CLI command remains **`reroute`**. The npm example pins this release; check registry availability before installing. [Successful GitHub Actions](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml) also uploads `onedotmint-reroute-0.4.1.tgz` for the **optional standalone CLI**; an uploaded CI artifact does not by itself publish to npm or create a GitHub Release.

### Optional CLI and masked API keys

The `/reroute` Pi screen can create, inspect and edit project profiles without the CLI. For Daytona / Modal / E2B credentials, prefer each provider's native environment or authentication. **Pi's text inputs are not masked**: never type API keys into an ordinary Pi input prompt.

For masked API-key entry, read-only resource discovery and advanced diagnostics, install the optional CLI from npm. Alternatively, install `./onedotmint-reroute-0.4.1.tgz` from a successful GitHub Actions run:

~~~bash
npm install -g @onedotmint/reroute@0.4.1
cd /path/to/your-project
reroute setup
reroute doctor --connect
~~~

The standalone CLI manages user defaults, explicit project overrides and opt-in private credentials. It **does not register a Pi extension or modify Pi settings**. Pi installs and removes its native package itself. The terminal command provided by `/reroute` uses the installed package directly; a separate global CLI install is optional.

### Migrating from the earlier handwritten extension

Earlier Reroute candidates installed `~/.pi/agent/extensions/reroute.ts` globally. Before enabling the new native package, inspect that file. **Only remove it if its first line is `// Reroute v3 owned extension entry`**; leave unowned or modified files untouched. The new installer does not delete any global extensions automatically. Earlier handwritten global/project entries may conflict or still override Bash; native-copy deduplication cannot make those legacy implementations safe. Updating the native package does not retire a separate historical extension. Restart Pi (or reload extensions) after updating; no reinstall is normally needed for an existing branch-based native package. Use the local-checkout installation above to try unreleased work.

## Friendly setup and Pi control panel

`reroute setup` now starts a **multi-select**: Daytona, Modal and/or SSH (Space toggles, arrows move, Enter confirms). Configure Daytona and Modal in one pass, then choose the default provider. New cloud profiles get separate named credentials and sensible reviewable defaults; only **Customize** expands specifications, image, budgets and rates. SSH only asks for your existing host/alias. API-key entry is **masked**; Modal takes a Token ID and Secret. Existing profiles stay untouched unless you use advanced editing; you can add another account without overwriting them.

`reroute setup --advanced` keeps the previous detailed flow for account edits, existing Sandbox IDs, E2B/SkyPilot and custom targets; explicit/non-interactive setup flags remain compatible. Quick setup makes **no cloud requests** and saves only after a final confirmation. Spending authorization is a separate **default-No** confirmation for newly configured, credential-ready cloud profiles; choosing providers does not authorize charges. Canceling before final save writes neither project settings nor newly entered credentials.

Unnamed profiles retain environment/native-first authentication. Quick setup uses named private accounts, which never fall back to another account. For users who explicitly choose masked entry, Reroute stores keys outside the project in `~/.config/reroute/accounts/NAME.json` (legacy unnamed store: `credentials.json`), with a private 0700 folder and 0600 file. This is **not an encrypted keychain**; use environment variables/native CLI authentication instead if preferable. API keys never appear in `.reroute.json`, the wizard's review, or Pi panel labels. Reroute passes saved credentials directly to official SDKs without adding them to global environment variables.

~~~bash
reroute credentials                                  # sources only; never prints keys
reroute credentials forget --provider daytona --yes   # forget saved Daytona key only
~~~

Use `/reroute` or rerun `reroute setup` for user defaults; `setup --project` retains special project settings. Credential availability, an opt-in successful connection check, spending policy, project execution consent, and a confirmed successful real task are displayed separately. A saved key is not a verified login or a successful execution. The panel offers an optional short first-task verification only after explicit project and cost consent.

In Pi, `/reroute` shows the **active profile, provider, resource ID, routing mode and credential availability**. **Overview** lists local profiles and recent task counts; **Manage providers** adds/edits/switches/forgets profiles and explicitly discovers existing resources. **Advanced** holds credential-key removal and all stop/resume/destroy resource operations, with explicit confirmation. **Check connection** is opt-in. Opening the panel does not contact cloud APIs, resume compute, or use a model.

## User defaults, project overrides and consent

Precedence is deliberately small: built-in defaults → user `config.json` → project `.reroute.json`. Top-level values and arrays replace their defaults; entries under `profiles` replace the **entire named profile**, never merge pieces of billing policy. A complete existing v3 project config remains valid. Invalid configuration fails closed, without falling back silently. No automatic migration/deletion occurs.

A project that only needs a different default can contain:

~~~json
{ "active": "modal", "timeoutSeconds": 900 }
~~~

`reroute setup` changes user defaults, not existing project files. `setup --project` explicitly configures a project. In Pi, the primary provider/settings controls edit **user defaults**; use **Project overrides** for project-only exceptions. In the CLI, provider/mode switches from a user-only configuration update user defaults; an existing project override keeps those switches local. The CLI also supports explicit `profile NAME --global` / `--project` and `mode auto|local --global` / `--project`.

Project consent is stored under `~/.local/state/reroute-v3/projects` (or the existing state override), bound to the canonical project root and provider/account target. Changing the target needs consent again; changing paths/using another project never inherits it. Pi confirms on the first eligible remote call; noninteractive tools refuse until a user explicitly runs `reroute authorize --yes`. This authorizes source upload and trusted remote scripts for that project/account, **not** managed spending when its separate policy is disabled. `reroute authorize --revoke` removes that project's saved consents. Existing configurations remain intact but need this new one-time consent too.

Managed Sandbox/Volume ownership remains installation + project + profile scoped; caches, workspaces and task receipts remain project-separated. A global account shares its conservative account budget across projects, not its compute identity. Existing attached SSH/Sandbox targets retain their documented same-UID namespace limitations: use managed per-project targets for stronger isolation.

## Provider prerequisites

All execution targets need Linux, Python 3, Bash, a /proc filesystem and your project toolchain. SSH/SkyPilot/E2B and attached cloud targets must already exist. Managed Daytona/Modal can create compute from a reviewed image; `reroute:node-rust-v1` is the starter SDK-built image (Rust stable, Node 22/npm, Python 3). Its historical cloud build/real-toolchain evidence is recorded below; the first build can still take time or fail. pnpm/Yarn/Bun and nonstandard runtimes require a suitable user-reviewed image.

| Provider | Preexisting setup | Behavior |
|---|---|---|
| SSH | OpenSSH host/alias, key auth, trusted host key, rsync locally and remotely | Native ssh/rsync; host stop/resume/destroy unsupported |
| SkyPilot | Configured `sky` CLI, existing UP cluster, usable matching SSH alias and rsync | Sky status/start/stop/down plus native SSH execution, no automatic cluster launch |
| Daytona | API key; opt-in managed policy **or** existing Sandbox ID | Official SDK discovery/create, custom vCPU/GiB, Volume and guarded auto-stop; no stdin |
| Modal | Token pair/native auth; opt-in managed policy **or** existing Sandbox ID | Official JS SDK App/Sandbox/Volume, physical CPU/GiB hard limits; managed compute released after confirmed tasks |
| E2B | SDK credentials and existing running Sandbox ID | Official SDK command/file APIs; resume/pause/kill only via explicit controls |

**Support policy:** Daytona/Modal managed operations are implemented and offline-tested, **not production-qualified or live-billing-verified**. SSH/SkyPilot/E2B existing-resource compatibility is retained; no additional providers were added. SDK/CLI contracts and service quotas may change. Creation/start can incur charges; no free credit is assumed. See [managed profiles](#managed-cloud-profiles) and the [live checklist](docs/MANAGED-CLOUD.md#authorized-live-acceptance).

## Environment compatibility

Read-only root-level hints recognize npm/pnpm/Yarn/Bun locks, `packageManager`, `engines`, `.nvmrc` / `.node-version` / `.tool-versions`, Cargo/toolchain and common Python declarations. `/reroute` Overview and `doctor` expose them; a bounded hint is available to the model. Declarations are not proof of remote runtime compatibility. The starter image does not include pnpm/Yarn/Bun or arbitrary project-specific versions; supply a reviewed compatible image when needed. No new host installs, source edits or custom image creation follow from detection.

`npm-shrinkwrap.json` participates in immutable npm bootstrap and cache identity. npm ≤11 gives it precedence over `package-lock.json`; npm ≥12 ignores it. Automatic bootstrap checks the **actual remote npm** and refuses shrinkwrap projects on npm ≥12, even with both locks, rather than silently choosing a different tree. Use a reviewed npm 11 environment or have the project maintainer migrate its lockfile. Dependency manifests and version declarations also namespace the download cache. Existing trusted Node lockfile bootstrap remains `npm ci` / native frozen-lockfile installation inside task work; static environment detection does not grant additional installation authority. The inspection intentionally does not resolve entire monorepos or parse all TOML syntax.

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

Results include status, exit code, Job ID (if allocated), separate stdout/stderr, measured metrics and errors, in text and structured data. Pi's native tool updates show actual snapshot, compute preparation, packing/upload, verification, cache restore, execution, descendant cleanup, cache save and resource-release boundaries. No percentage is invented. Errors retain known phase labels (for example `[upload]`, `[verify]`, `[budget]`, `[resource-cleanup]`); command nonzero exit remains distinct from transport/cleanup uncertainty. Progress is bounded and throttled. Only the final 8192 characters of each output stream are retained (long diagnostics are bounded too); truncation is explicitly reported, and the tool does not save full logs. Arrange explicit output artifacts when a complete record is needed. A confirmed timeout returns 124, a confirmed cancellation returns 130, and infrastructure/unknown/incomplete output returns 125. A failed or uncertain remote task is **never** retried locally: inspect its Job ID with `reroute_status({ jobId: "..." })` (no CLI required) and obtain user authorization before a local rerun.

**Tool choice stays with the current coding agent.** Prefer Reroute for full builds/test suites and slow CPU/memory-heavy checks; keep quick checks, Git, file operations and ordinary shell with Pi/AFT. Ambiguous work is judged from project context, not by an extra classifier/model request. Existing deterministic eligibility, authorization and budget gates still apply after the choice. No Bash interception or automatic local retry.

Pi can reference **up to three short project-history observations** from existing receipts: at least two confirmed exited runs in the past 30 days, matching the current provider/account/image/specification (and resource ID for attached targets). Each category uses at most five recent samples and reports remote execution-time range, nonzero exits and measured download-archive restores. No raw command/output/error is injected, no local speedup is inferred, and suggestions never authorize a retry. Missing, corrupt, stale or incompatible history stays silent. These tool-guideline observations replace the previous turn’s observations rather than accumulating chat messages; no extra model/API call or database is introduced.

**Model tool selection is not deterministic command interception.** Loading tests alone do not establish selection accuracy. The current frozen-candidate acceptance used real Pi 1.4/AFT 0.62 and the configured model: light work stayed local; complete tests/build chose Reroute first; failures/unknown states led to status queries without local retry. Six categories have successful evidence after a separately authorized light-harness correction; original failed evidence is retained. Execution used an isolated **local Provider fixture**, not paid cloud, and no general selection-stability guarantee is claimed. See [release acceptance](docs/RELEASE-ACCEPTANCE.md). `tests/pi-model-selection.mjs` and `.artifacts/pi-workflow-selection.json` are the older, version-pinned historical probe and partial result, not the current acceptance runner.

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

SSH/SkyPilot retain native rsync. SDK file providers keep the existing manifest/needed-file plan but upload changed file bytes as **one manifest-indexed gzip stream**, not one SDK request per source file. The remote helper checks compressed length/hash, full gzip stream, expanded bounds, safe manifest paths, file hashes and modes in private staging before updating its verified baseline. Unchanged baseline files are not re-uploaded; this is a single task snapshot, not a new synchronization protocol. Each job gets its own execution directory, separate from reusable dependency/toolchain caches. Jobs on a project remote workspace are serialized rather than racing a shared cache. Remote edits **never write back to local source**. Project cache directories on an attached shared host/Sandbox are namespaces, not access control between scripts running as the same remote UID; use separate managed Sandboxes/Volumes for mutually isolated projects. Scripts can read credentials already present on their remote target and can directly write their own mounted Volume. Trust project code and the selected image/target; do not treat these paths or cache checksums as a hostile-code sandbox.

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
- Real-service acceptance is version-specific. The frozen working-tree candidate passed new transfer/cache checks on both Daytona and Modal; global installation/authorization and real-model choice were separately checked. No integrated autonomous model-to-paid-cloud run or general reliability/billing guarantee is claimed. See [release acceptance](docs/RELEASE-ACCEPTANCE.md).

License: Apache-2.0; dependencies have their own licenses.

## Managed cloud profiles

This work is merged into `rebuild/0.3-native`. To run from source instead of the packaged tarball:

~~~bash
cd /path/to/your/Reroute/checkout
npm ci
npm run build
cd /path/to/your-project
pi install /path/to/your/Reroute/checkout
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

For the precise SDK evidence, retained billing risks, limitations and authorized live test steps, see [Managed cloud operations](docs/MANAGED-CLOUD.md). Managed **Daytona is live-verified**. Managed **Modal has passed default-toolchain and real-repository cold/warm verification** at 2 physical CPU / 4 GiB on acceptance SHA `e6b68ad`: install, typecheck, build, tests (200 passed, 2 unchanged host-AFT skips), smoke, download-cache restore and compute release. The Modal executor preserves image PATH using a non-login shell. Broad speedup and live failure/recovery acceptance remain unverified. Billing is unverified for both.

## Dependency and release maintenance

Development/CI uses the committed `package-lock.json` with `npm ci --ignore-scripts`; published npm packages contain neither lockfile nor install hooks. Pi SDKs are host-provided optional peers, not bundled runtime dependencies. Dependabot proposes reviewed updates; nothing auto-merges or publishes. See [dependency security and installation policy](docs/DEPENDENCY-SECURITY.md) for remaining upstream findings, script permissions, npm 11/12 behavior and verification evidence.
