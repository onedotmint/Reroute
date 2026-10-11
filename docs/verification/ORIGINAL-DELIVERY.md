# Outboard delivery report

Release: **0.1.0-preview.1**. License: Apache-2.0. Delivery date: 2026-10-06.

## What is actually delivered

A single integrated TypeScript/Node package with compiled runtime JavaScript,
`ob` / `outboardd` commands, a Python remote supervisor, five real provider adapters,
seven native-shell bridges, safe source synchronization, tests, examples, build
scripts, lockfiles and documentation. No cloud SDK, agent runtime, secret store,
node_modules tree or external toolchain is bundled. No production local-execution
fallback provider exists.

This is a locally verified implementation preview. **It is not claimed production
ready, live cloud verified, or fully zero-configuration on every target harness.**
The missing deployment/host validation and implementation gaps below remain real.

## Implemented architecture

Local control plane: CLI, source/Git, native agent, provider authentication,
per-user authenticated socket/pipe coordinator, project identity and atomic state.
Remote execution plane: isolated project workspace, toolchains supplied by the
selected runtime, dependency/build directories, supervised byte-stream processes.

Routing is centralized at executable/subcommand boundaries. Harnesses only
activate/translate the shell interface. Core receives provider implementations via
an injected factory and contains no vendor/harness SDK details. Project mutation
lanes prevent independent agents from creating conflicting runtimes/sync sessions.
Lifecycle policy is owned once, with serialized native calls and active leases.

Source synchronization is a shared three-way hash protocol with guarded native
transfer, exclusions, expected-version writes, preserved conflicts and backup
copies. Runtime generation changes reset the agreed baseline without deleting
local source. Mutagen/rsync are not implemented transport backends in this release.

## Providers and capabilities

| Provider | Implementation | Local verification | Real infrastructure |
| --- | --- | --- | --- |
| Daytona | SDK create/get/identity, resources/image/snapshot constraints, temporary SSH, native idle, destroy, previews | shared native-boundary contract with real worker/process/files | not configured; not live verified |
| SSH | OpenSSH config/agent, isolated directory/bootstrap, guarded destroy, port forward | shared contract using a clearly labelled local SSH command dispatcher | OpenSSH absent; no real host tested |
| SkyPilot | task resource mapping, native provisioning/reuse/status/autostop/stop/down, generated SSH alias | shared contract and resource-unit assertions | sky/OpenSSH/cloud auth absent |
| Modal | native sandbox/volume/image/secrets/resources, byte streams, finite lifetime, terminate/reconnect, tunnels | shared contract using SDK wire fixture and real child process | SDK/profile absent; persistence/preview not live verified |
| E2B | native template/create/connect, metadata reuse, stdin/process handles, lifecycle timeout/pause/kill, hosts | shared contract using SDK wire fixture and real child process | SDK/key absent; lifecycle/plan behavior not live verified |

The exact resource/persistence/idle capability matrix and caveats are in
PROVIDERS. Unsupported portable requests are rejected, not silently ignored.

## Harness implementations

Pi: native Bash tool spawn-hook environment plus user-shell operations. OMP:
current Bash tool-call input rewrite (not its incompatible user-shell API).
Claude: PreToolUse updatedInput without an automatic permission decision.
Cursor: native preToolUse updated_input and failClosed hook installation.
Codex: current updatedInput plus required allow, deliberately opt-in because this
changes approval semantics. OpenCode: v2 shell creation hook, native plugin
activation required. DeepSeek: LocalBashExecutor subclass preserving native handle
and trusted environment, native composition activation required.

All seven have local protocol fixtures. No actual harness runtime was present, so
none is labelled native-host verified. DeepSeek and native Windows remain
experimental. Continue is planned/unimplemented because no stable supported
execution seam was verified. Gemini and GitHub Copilot are intentionally excluded.

## Observed verification

Final local suite: **79 tests passed, 0 failed, 0 skipped**. The separate live
provider suite had **5 explicitly skipped tests, 0 live passes**. Typecheck/build
and offline installation of the npm tarball also passed.

The final exact command outcomes and raw TAP are stored under `docs/verification/`.
They must be interpreted as executed local tests, not cloud acceptance:

- `npm run typecheck`: strict TypeScript/noUncheckedIndexedAccess.
- `npm run build`: emitted executable JS and declarations.
- `npm test`: unit, provider contract, supervisor/sync, coordinator, CLI/IPC and
  harness-fixture tests, no required cloud credentials.
- `npm run test:live`: five explicit SKIPPED/not-configured cases, not five passes.
- `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`:
  genuine lockfile resolution for the zero-dependency core.
- `node bin/ob.mjs --help`: CLI smoke.
- `npm pack --ignore-scripts`: separate installable npm tarball; no registry publish.
- `npm run package:source`: clean Git archive, secret/cache path inspection,
  provenance, zip integrity/extraction, extracted CLI and extracted unit/harness tests.

The complete local end-to-end path exercises setup detecting a Pi fixture,
configuration of the SSH-shaped test runtime, enable, ordinary shell composition,
source reaching the separate runtime directory, byte stdout/stderr and exit23,
remote-only build state, local Git, fail-closed failure, explicit local override,
IPC auth rejection, client-crash cancellation and idle release. It is deliberately
labelled same-machine isolated-directory integration, not external remote execution.

Important regressions discovered and fixed during execution: Python buffered
stdin reader held at interpreter shutdown; streamed large RPC payload limits;
local-source protection on runtime recreation; lifecycle stale idle callback race;
client still-open stdin preventing CLI exit; stale warm config on re-enable.
A test-harness EPIPE case was handled without removing product assertions.

## Environment blockers and exact failed probes

`npm view typescript version --fetch-retries=0 --fetch-timeout=15000` failed with
`EAI_AGAIN getaddrinfo registry.npmjs.org`. `curl -IL --max-time 10 https://github.com`
failed with `curl: (6) Could not resolve host: github.com`. These were environmental
DNS/network failures, not successful dependency/SDK installation.

Node 22.16.0, npm 10.9.2, Git 2.47.3, Python 3, zip/tar and existing TypeScript 5.8.3
were available. pnpm, OpenSSH, SkyPilot and Mutagen were absent. No Daytona/Modal/E2B
credential variables were found; values were not printed. Provider live tests
therefore report skips. Public current docs/source could be inspected through a
separate web facility, but vendor SDK installation and vendor-declaration checking
remain unverified. Real SSH and cloud provider previews could not be tested.

## Known limitations

Read LIMITATIONS and SECURITY; the most important gaps are:

- Hard local host failure can leave Daytona/SkyPilot active autostop disabled;
  process heartbeat cleanup is not an independent cloud billing watchdog.
- A suitable remote toolchain image/template/SSH machine must be supplied. There
  is no universal language-toolchain bootstrap or nested-Docker promise.
- OpenCode/DeepSeek activation is manual; OMP coverage is Bash-only; Codex opt-in
  affects approval semantics. Absolute executables/unhooked tools bypass PATH.
- No PTY/full signal-forwarding or durable dev job/log resumption. Source scans are
  whole-tree; no production-scale sync benchmarks or transactional multi-writer FS.
- Secret exclusions are a filename/name policy, not content DLP. A user's command
  can print its own secrets to the native agent. Native Windows ACL/pipe behavior,
  all live SDK contracts and Modal volume commit persistence require validation.

The input brief's ideal all-platform production/zero-config acceptance bar is
therefore not fully achieved. The integrated code, meaningful local verification,
recoverable history and actual delivery artifacts are provided rather than stubs
or a promise to merge scattered work later.

## Repository and artifacts

Canonical branch: `main`. Intended release working tree: clean, all implementation
committed. Exact final commit and tree hashes are in the generated
`DELIVERY-STATE.json` inside the source zip and standalone packaging report. The
tracked report cannot embed the hash of the commit containing itself; the
standalone delivery report expands that final hash after packaging.

Required/source artifact: `outboard-source.zip`.
Convenience installer: `outboard-0.1.0-preview.1.tgz`.
Checkpoint history: `outboard-history.bundle`.
Standalone report: `DELIVERY.md`.
Package evidence: `outboard-packaging-report.json` and `SHA256SUMS`.
README/LICENSE/full documentation are also inside the source archive.

The source archive is produced from the committed tree, not an arbitrary workspace.
Only generated release provenance is added after Git archive. The Git bundle is
separate so consumers can restore all checkpoint commits without bundling private
repository configuration or workspace caches.
