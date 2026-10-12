# Reroute

**Keep editing locally in WSL2 and using Pi normally. Send eligible builds and tests to existing remote compute.**

Reroute is an on-demand task offloader, not a remote IDE or a synchronization daemon. A conservative router sends recognized build/test/check/benchmark tasks to the configured provider. Git, file inspection, deployments, ambiguous shell constructs and unknown commands stay local. Failed remote jobs never silently retry locally.

**Status:** 0.3.0-native.2 candidate. SSH is tested through real OpenSSH and rsync on an isolated Ubuntu localhost server in CI. Other cloud providers are implemented and contract-tested, but their real account integrations are **LIVE UNVERIFIED**.

## Install on Windows 11 + WSL2

Requirements: run inside **WSL2** with Node.js >=22.19, Git, Bash, Pi, and an already configured Linux compute resource.

1. Open [GitHub Actions: Verify native Reroute](https://github.com/onedotmint/Reroute/actions/workflows/verify.yml). Choose a **successful** run on branch `rebuild/0.3-native`.
2. Download its `reroute-npm-node-22-<sha>` (or Node 24) artifact; unzip and locate `reroute-0.3.0-native.2.tgz`. The artifact also includes a commit SHA and test evidence.
3. From a WSL shell run:

~~~bash
npm install -g ./reroute-0.3.0-native.2.tgz
cd /path/to/your/project
reroute setup
reroute doctor
reroute doctor --connect
~~~

`reroute setup` saves the project's `.reroute.json` and writes one owned Pi extension entry into `~/.pi/agent/extensions/reroute.ts` (or `$PI_CODING_AGENT_DIR/extensions/reroute.ts`). Existing unowned extensions are **not overwritten**. Run `/reload` if Pi is already open, then `/reroute`. This is a native TUI menu; viewing the panel does not use a model or create billable resources.

Alternatively, build from the GitHub branch with `npm ci && npm run build && npm pack`.

## Provider prerequisites

All targets must already exist and provide Linux, Python 3, Bash, a /proc filesystem and your project toolchain. No provider is provisioned during setup.

| Provider | Preexisting setup | Behavior |
|---|---|---|
| SSH | OpenSSH host/alias, key auth, trusted host key, rsync locally and remotely | Native ssh/rsync; host stop/resume/destroy unsupported |
| SkyPilot | Configured `sky` CLI, existing UP cluster, usable matching SSH alias and rsync | Sky status/start/stop/down plus native SSH execution, no automatic cluster launch |
| Daytona | SDK credentials and started Sandbox ID | Official TS SDK sessions/files/lifecycle; no stdin |
| Modal | SDK credentials, existing Sandbox ID, existing app name for snapshot stop/resume | JS SDK Sandbox API; resume may create a different billable Sandbox |
| E2B | SDK credentials and existing running Sandbox ID | Official SDK command/file APIs; resume/pause/kill only via explicit controls |

Cloud versions and account policies change; contract tests are **not** live account tests. The four non-SSH integrations are currently **LIVE UNVERIFIED**. Explicit resume can incur charges.

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

Pi's ordinary Bash runs through the same router after installation. The `/reroute` menu offers profile switching, connection checks, routing mode, recent jobs, and explicit resource operations. The CLI and Pi share the project config. A confirmed timeout returns 124, a confirmed cancellation returns 130, and infrastructure/unknown/incomplete output returns 125. A remote failure is **never** retried locally without your action.

Automatic classification fails closed: unrecognized scripts, redirects, pipes, expansions, working-directory changes, watch servers, deployment/publishing and other side-effect commands stay local. To override explicitly use `reroute exec`. Use `reroute --help` for setup flags, diagnostics and resource management.

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
