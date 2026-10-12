# Reroute 0.2 workflow (development branch)

**Keep your workspace. Offload the workload.** This is a workflow/core refactor,
not a release announcement or cloud certification. The package version is still
`0.1.0-preview.1`; nothing was pushed, deployed or published.

## Install and first project

Local prerequisites: Node 22+, Python 3 for the local tests, and OpenSSH for SSH /
Daytona / SkyPilot transports. The remote environment needs Python 3 and your
project toolchain. Reroute does not silently install a toolchain or use an agent
framework/model to decide each command. From this source tree:

```sh
npm run tools:install          # existing isolated developer tools / pinned SDK
npm run verify:release
npm install -g .
cd /path/to/project
```

Use an existing SSH server first, if available. Verify its host key yourself:

```sh
ssh build-host 'python3 --version'
reroute setup --provider ssh --host build-host
reroute doctor --probe         # explicit SSH auth/connectivity/Python probe
reroute                       # concise current project status
reroute cargo test            # explicit remote argv execution
reroute stop                  # stops work/tunnels, never powers off SSH host
```

Bare `setup` offers a short provider/host guide on a human terminal. On a pipe,
CI or other noninteractive input it never waits: it sets up Reroute itself,
reports dependency/credential discovery, and suggests explicit project parameters.
Provider selection does not provision resources. No detected agent is installed
without `--harness`, and no SDK is downloaded without `--install-sdk`.
`enable` remains a project-only compatibility entry; it preserves the project ID.

### Paid providers

Only after account-owner approval and configuring native budgets/alerts:

```sh
# Supply DAYTONA_API_KEY natively; never put it in TOML or acceptance logs.
reroute setup --install-sdk daytona --provider daytona --allow-paid
reroute                       # remote readiness UNVERIFIED, billing UNKNOWN
reroute cargo test
reroute stop
```

The image/snapshot must already contain your project toolchain. Credential
presence is not verified authentication; it describes this CLI environment only.
If the coordinator started in an older environment, use `reroute auth reload`
deliberately. There is no silent retry as local execution on remote failure.

`--allow-paid` records consent for this project and selected provider. The default
is no grant, including existing enabled cloud projects. `enable --revoke-paid`
revokes it but is not stop/cleanup. Explicit configuration can also grant named
providers; see [authorization scope](CONFIGURATION.md#paid-resource-authorization-and-authentication).
SSH can cost money externally, but Reroute never provisions/stops its host.

## Pi daily use

Opt in, then restart Pi:

```sh
reroute setup --harness pi
```

Pi still uses its native Bash tool/schema, streaming, truncation and cancellation.
No new model tool, MCP server or AI router was added. The existing adapter activates
PATH shims. Local editing, Git, filesystem/search and normal shell work remain local.
`cargo test`, `pnpm test` and known build tasks are remote candidates in an enabled
project. `python --version`, `node --version`, unknown interpreter scripts, installs
and control/auth/deploy/publish operations stay local by default.

```sh
reroute explain --json -- cargo test   # read-only transparent policy
reroute explain --json -- node --version
reroute shell -- 'cargo test && git status'   # compatibility bridge, not a new shell
reroute exec -- cargo test             # explicit remote argv, same core as shorthand
reroute local -- cargo test            # explicit local override
reroute status --json                  # stable machine-readable status entry
```

The shell remains local and each eligible simple executable is intercepted.
Wrappers, aliases, absolute executable paths, scripts hiding deployment and
unhooked tools are not comprehensively parsed. Explicit exec is not a shell-script
entry: `reroute 'cargo test && git status'` is rejected. Reserved CLI names take
priority; `reroute status cargo test` is rejected, not interpreted as a remote
program. A missing executable returns 127; remote errors never trigger fallback.

### Project task rules and migration

```toml
[routing]
mode = "tasks"
local = [["cargo", "test", "-q"]]
remote = [["node", "scripts/build.mjs"], ["python3", "build.py"]]
```

Rules are exact argv prefixes, not globs or arbitrary shell expressions. Local
rules win, and safety exclusions cannot be overridden. Classification makes no
network/model calls or repository scan. After config changes, stop active work and
run `reroute enable` to refresh a warm coordinator.

An existing explicit `routing.commands` with no mode retains the legacy executable
policy, visibly labelled by setup/enable/explain. Set `mode = "tasks"` explicitly
to migrate. Built-in defaults already use tasks. `commands` replaces shim eligibility;
include custom executable names there before expecting PATH interception.

## Source, cache and artifact results

```sh
reroute sync --dry-run --json          # metadata only, no hash/network/identity write
reroute sync                          # real guarded three-way reconciliation
```

Source/Git stay authoritative locally. Credentials, Git, machine state and build
caches are forcibly excluded. Synchronization keeps content hashes, backups,
remote conflict evidence, deletion ordering and an agreed baseline. Small push
files now share bounded existing worker apply RPCs rather than one worker each;
this is one synchronizer, not a second rsync/Mutagen coordinator. Both sides still
scan/hash the source tree on unchanged executions.

Caches stay remote; use existing sccache/Bazel/Nx/Turborepo as appropriate. To fetch
specific outputs, configure files explicitly:

```toml
[artifacts]
paths = ["target/release/my-program", "build/report.txt"]
maxFileBytes = 16777216
```

```sh
reroute artifacts
# JSON reports .reroute/artifacts/UUID/; inspect, then copy a verified file yourself.
```

Only exact regular files below supported build roots are accepted. No directories,
globs, credentials, symlinks or source overwrites. Each retrieval has a new private,
non-executable output directory; partial failures remain isolated. Maximum 100
paths, 32 MiB per file. No background artifact index, automatic downloads, or new
compiler-cache system. Retrieval never creates a replacement workspace.

## Failure, recovery and cleanup

```sh
reroute status --json
reroute doctor
reroute sync                          # retry return sync on original runtime
# For exit 73: compare local source with .reroute/conflicts/ID/remote/ first.
reroute sync --accept-local            # deliberate conflict resolution, not routine
reroute stop                          # reconcile before native stop
reroute stop --destroy                 # explicit destructive request, original ID only
reroute disable
reroute uninstall --harness pi         # unchanged owned extension only
reroute daemon stop
```

- Timeout is 124; cancellation is 130 even if the program handles TERM with exit 0.
- Preparation control calls have a 60-second bound; explicitly configured SSH
  bootstrap has ten minutes. Process execution timeout is not a total provisioning /
  multi-file synchronization deadline; cancellation during preparation remains
  bounded by native/control calls, not universally immediate.
- Failed return sync retains `syncPending`, original runtime/root/generation and
  baseline. Missing/changed/symlink owner markers fail closed without repair.
- Daytona stopped/archive recovery requires the same recorded resource and explicit
  paid authorization; unsupported providers need native recovery. Never create a
  replacement to make pending source disappear.
- Ordinary stop of a clean stopped runtime does not resume it. After revocation,
  already-running work can still reconcile and stop; resuming paid compute cannot.
- Stop is not zero billing. SSH host remains running; cloud disks, archives and
  Modal volumes may remain billable after native stop/delete. Inspect native resources
  and billing. Uninstall is not cloud cleanup or full user-config rollback.
- User-edited adapters/hooks/settings are preserved; unrelated agent config is not
  installed, replaced or deleted. Pi native integration and actual cloud behavior
  still need [controlled acceptance](LIVE-ACCEPTANCE.md).

## Evidence and limits

See [benchmark methodology and raw evidence](BENCHMARK.md) and
[refactor delivery](REFACTOR-0.2.md). Benchmarks run real local worker processes,
not cloud SDK mocks, but do not measure real network/SSH or native Pi overhead.
All five provider compatibility contracts run locally with synthetic native
boundaries. Actual SSH + Daytona + Pi, retained disk behavior and charges remain
**UNVERIFIED** until account-owner-authorized acceptance is completed.
