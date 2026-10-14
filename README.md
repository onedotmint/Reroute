# Reroute

**Keep editing locally in WSL2 and using Pi normally. Send eligible builds and tests to existing remote compute.**

Reroute is an on-demand task offloader, not a remote IDE or a synchronization daemon. A conservative router sends recognized build/test/check/benchmark tasks to the configured provider. Git, file inspection, deployments, ambiguous shell constructs and unknown commands are not automatically offloaded (use ordinary Bash in Pi). Failed remote jobs never silently retry locally.

**Status:** 0.3.0-native.4 candidate. SSH is tested through real OpenSSH and rsync on an isolated Ubuntu localhost server in CI. Other cloud providers are implemented and contract-tested, but their real account integrations are **LIVE UNVERIFIED**.

## Install as a native Pi PROJECT package (recommended)

Reroute now relies on **Pi's own package manager**. From your WSL2 project (Pi and Node.js >= 22.19 required):

~~~bash
cd /path/to/your-project
pi install -l git:github.com/onedotmint/Reroute@rebuild/0.3-native
pi
~~~

Approve **Pi project trust** after reviewing this package. Inside Pi, run `/reroute`, choose **Configure this project**, then choose SSH / Daytona / SkyPilot / Modal / E2B and an existing target. Reroute saves `.reroute.json` in this project. Other projects do not load the extension.

Pi now owns the installation record at **`.pi/settings.json`**, source checkout, loading, updating and removal. There is no custom entry under `~/.pi/agent/extensions/` and no global Node or Pi installation required. A Pi project package is not loaded before the user trusts the folder.

~~~bash
pi list
pi update --extensions
pi remove -l git:github.com/onedotmint/Reroute@rebuild/0.3-native
~~~

For noninteractive inspections, `pi list --approve` explicitly permits reading trusted project settings; `pi list --no-approve` intentionally hides them. Global Pi installation is available by **omitting `-l`**, but project-only is the default recommendation.

The Git checkout does not need a built `dist/`: Pi's native TypeScript loader loads `adapters/pi.ts` and the source modules directly. A local checked-out source directory is also a native Pi package: `pi install -l /absolute/path/to/Reroute`.

**Important:** Reroute is **not published to npm** yet. Do not use `pi install -l npm:reroute`. The Git ref above is the supported native package source. [Successful GitHub Actions](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml) also uploads `reroute-0.3.0-native.4.tgz` for the **optional standalone CLI**.

### Optional CLI and masked API keys

The `/reroute` Pi screen can create, inspect and edit project profiles without the CLI. For Daytona / Modal / E2B credentials, prefer each provider's native environment or authentication. **Pi's text inputs are not masked**: never type API keys into an ordinary Pi input prompt.

For masked API-key entry, read-only resource discovery and advanced diagnostics, install the optional CLI tarball from a successful GitHub Actions run:

~~~bash
npm install -g ./reroute-0.3.0-native.4.tgz
cd /path/to/your-project
reroute setup
reroute doctor --connect
~~~

The standalone CLI manages only `.reroute.json` and the opt-in private credentials file. It **does not register a Pi extension or modify Pi settings**. Pi installs and removes its native package itself.

### Migrating from the earlier handwritten extension

Earlier Reroute candidates installed `~/.pi/agent/extensions/reroute.ts` globally. Before enabling the new native package, inspect that file. **Only remove it if its first line is `// Reroute v3 owned extension entry`**; leave unowned or modified files untouched. The new installer does not delete any global extensions automatically. Duplicate global/project registration could cause conflicts, and an old entry may still override Bash. Updating the native package does not retire a separate historical extension. Restart Pi (or reload extensions) after updating; no reinstall is normally needed for an existing branch-based native package. Before this PR is merged, try the feature branch with `pi install -l git:github.com/onedotmint/Reroute@feat/pi-independent-tool` in a trusted test project.

## Friendly setup and Pi control panel

The optional CLI command `reroute setup` guides you through five choices (SSH, Daytona, SkyPilot, Modal, E2B), detects native/environment credentials, and optionally prompts for masked cloud API keys. It then offers a **read-only** list of existing hosts, clusters or Sandboxes; choose an existing item or type its ID yourself. The final optional connection check is explicit and never provisions/resumes compute.

Cloud credentials are read from each provider's native environment/configuration first. For users who explicitly choose **Save locally**, Reroute stores keys outside the project in `~/.config/reroute/credentials.json` (or `$XDG_CONFIG_HOME/reroute/credentials.json`), with a private 0700 folder and 0600 file. This is **not an encrypted keychain**; use environment variables/native CLI authentication instead if preferable. API keys never appear in `.reroute.json`, the wizard's review, or Pi panel labels. Reroute passes saved credentials directly to official SDKs without adding them to global environment variables.

~~~bash
reroute credentials                                  # sources only; never prints keys
reroute credentials forget --provider daytona --yes   # forget saved Daytona key only
~~~

Use `/reroute` to add/edit profiles in Pi, or rerun the optional `reroute setup` CLI wizard. Both use the same project configuration. Credential/resource checks are not evidence that a paid cloud account was live-tested in CI.

In Pi, `/reroute` shows the **active profile, provider, resource ID, routing mode and credential availability**. **Overview** lists local profiles and recent task counts; **Manage providers** adds/edits/switches/forgets profiles and explicitly discovers existing resources. **Advanced** holds credential-key removal and all stop/resume/destroy resource operations, with explicit confirmation. **Check connection** is opt-in. Opening the panel does not contact cloud APIs, resume compute, or use a model.

## Provider prerequisites

All targets must already exist and provide Linux, Python 3, Bash, a /proc filesystem and your project toolchain. No provider is provisioned during setup.

| Provider | Preexisting setup | Behavior |
|---|---|---|
| SSH | OpenSSH host/alias, key auth, trusted host key, rsync locally and remotely | Native ssh/rsync; host stop/resume/destroy unsupported |
| SkyPilot | Configured `sky` CLI, existing UP cluster, usable matching SSH alias and rsync | Sky status/start/stop/down plus native SSH execution, no automatic cluster launch |
| Daytona | SDK credentials and started Sandbox ID | Official TS SDK sessions/files/lifecycle; no stdin |
| Modal | SDK credentials, existing Sandbox ID, existing app name for snapshot stop/resume | JS SDK Sandbox API; resume may create a different billable Sandbox |
| E2B | SDK credentials and existing running Sandbox ID | Official SDK command/file APIs; resume/pause/kill only via explicit controls |

**Support policy:** SSH has real localhost OpenSSH integration evidence. Daytona, SkyPilot, Modal and E2B are **experimental / LIVE UNVERIFIED**, not production-qualified; they retain their current adapters without further feature expansion until existing-resource live tests pass. Cloud SDK/CLI contracts may change. Explicit resume can incur charges.

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

**AFT or Pi handles ordinary Bash execution. Reroute exposes a separate Pi tool for eligible compute tasks.** After trusted package loading, `reroute_run` is active by default and available directly to the model. It does not register/override `bash`, handle `user_bash`, rewrite other tools' calls, or hook process spawning. AFT requires no changes or special load order.

The tool accepts `{ command: "cargo test", timeout: 120 }` (timeout optional, in seconds, up to 86400; otherwise the project's timeout). It uses Pi's current project working directory and the same `.reroute.json`, conservative router, snapshots and execution engine as the CLI. Use `/reroute` to configure and manage providers; use `bash` for ordinary shell/file operations, authentication, deployment, interactive commands and unknown side effects.

A local routing decision (including `mode=local`), an unconfigured project or an ineligible command produces `not_started` with the reason: **nothing is run locally or remotely by the tool**. The model may use existing Bash when local execution is intended. This differs from standalone `reroute run`, which retains its explicit CLI local-routing behavior. There is no implicit local fallback and no automatic cloud creation/start/resume.

Results include status, exit code, Job ID (if allocated), separate stdout/stderr and errors, in text and structured data. Progress is bounded and throttled. Only the final 8192 characters of each output stream are retained (long diagnostics are bounded too); truncation is explicitly reported, and the tool does not save full logs. Arrange explicit output artifacts when a complete record is needed. A confirmed timeout returns 124, a confirmed cancellation returns 130, and infrastructure/unknown/incomplete output returns 125. A failed or uncertain remote task is **never** retried locally: inspect its Job ID with `reroute status` and obtain user authorization before a local rerun.

**Model tool selection is not deterministic command interception.** Registration makes the tool available; it does not guarantee that the model discovers or chooses it for every eligible task. Automated loading tests do not prove real-model selection accuracy.

Automatic classification fails closed: unrecognized scripts, redirects, pipes, expansions, working-directory changes, watch servers, deployment/publishing and other side-effect commands are not automatically offloaded. To override explicitly use `reroute exec`. Use `reroute --help` for setup flags, diagnostics and resource management.

## Source inputs, caching and artifacts

Reroute takes a two-read verified snapshot before the task: includes tracked/uncommitted/untracked non-ignored source, excludes deleted files and common secret files, .git, dependencies and build caches. It rejects source symlinks and inconsistent snapshots. Use `.rerouteignore` for extra private or bulky paths. Two reads reduce races; this is **not an atomic filesystem snapshot**. Avoid editing the same files while input is prepared.

SSH/SkyPilot transfer via native rsync; other providers use native SDK file APIs plus a manifest. Each job gets its own execution directory, separate from reusable dependency/toolchain caches. Jobs on a project remote workspace are serialized rather than racing a shared cache. Remote edits **never write back to local source**.

To retrieve an output, have the remote command put it under the `$REROUTE_ARTIFACTS` directory, or request a file retained in that job's remote work directory:

~~~bash
reroute artifacts JOB_ID @outputs/result.txt --to ./result.tgz
reroute artifacts JOB_ID path/in/workspace/result.bin --to ./result.tgz
~~~

Artifact downloads are checksum-verified tar.gz archives, limited to 256 MiB, and never overwrite an existing local file. Inspect/extract manually. `reroute cleanup JOB_ID --yes` removes only a confirmed terminal job.

## Safety and troubleshooting

- `reroute doctor --json` checks local requirements; `reroute doctor --connect` probes an existing target, without provisioning it.
- `reroute resource resume --yes --allow-cost` may incur costs; `reroute resource stop --yes` or `destroy --yes` are explicit. Running/unknown jobs prevent destructive lifecycle actions.
- On an `unknown` task, inspect `reroute status JOB_ID` and native provider logs before deciding to rerun. Network loss is not proof that remote execution stopped.
- Older 0.2 synchronization state is not deleted or migrated. Recover any pending files through the legacy version before using `reroute setup --ignore-legacy`.
- Files sent to remote should not contain credentials. Automatic exclusions are defensive, not a secrets scanner. Run on least-privilege isolated compute.
- Real user WSL2 Pi extension startup, cross-machine network performance and all four cloud backends remain to be tested. See [DELIVERY.md](./DELIVERY.md).

License: Apache-2.0; dependencies have their own licenses.
