# Known limitations and release gaps

Reroute is an implementation preview, not a claim that every acceptance item
was verified on real infrastructure. Environment details below describe the original
delivery environment, not every developer's current machine. The remaining gaps are concrete:

1. **No live providers or native agent products tested here.** Registry/GitHub DNS
   failed in the runtime; cloud credentials and OpenSSH/SkyPilot/harness binaries
   were absent. Daytona now has pinned real-vendor declaration checks; other SDK boundaries
   still use structural local declarations. Neither is live acceptance. Contract fixtures verify our mappings and real subprocess/file
   behavior, not vendor acceptance, native auth, previews or cloud persistence.
2. **Not universally zero-config.** Remote Python 3 and project toolchains must
   exist. Provider auth is external. OpenCode v2 and DeepSeek need native activation;
   OMP only covers Bash; Codex requires a deliberate approval-related opt-in.
   Continue is unimplemented. No native-host compatibility matrix is certified.
3. **Hard-crash billing gap.** An independent remote billing watchdog is absent.
   Daytona now keeps finite native auto-stop with active activity renewal (live
   UNVERIFIED); SkyPilot active native idle remains disabled and can outlive host
   loss. Worker disconnect cleanup is not cloud shutdown. Use native budgets.
4. **Execution boundary is PATH, not arbitrary code analysis.** Absolute executables,
   overridden PATH, package-manager scripts that conceal deploy operations, unhooked
   Python tools and nested remote shell workflows are not comprehensively routed.
   Local control actions hidden inside a remote script are not rewritten.
5. **No PTY, terminal resize or complete signal forwarding.** Standard byte streams,
   EOF, cancellation, timeout and process-group cleanup exist. Ctrl+C maps to a
   cancellation/TERM flow rather than preserving every original POSIX signal.
6. **Sync performance/semantics.** Incremental file transfer still hashes whole
   source trees and invokes a worker RPC for individual changed files. Very large
   trees/high-latency links are not benchmarked. No Mutagen/rsync transport is wired;
   native guarded transfer avoids requiring rsync on Windows. Symlinks are rejected.
   Glob syntax and TOML syntax are intentionally limited. Filesystem races are
   optimistic with backups, not transactional. Ignore rules are not DLP.
7. **Logs and dev recovery.** Foreground logs are not durably replayable; full output
   goes to the host. Dev logs are a bounded in-memory tail, lost on daemon restart.
   Dev processes require explicit restart after daemon loss; no distributed job
   resumption or log-offset recovery. `reroute dev` returns and `reroute dev logs --follow`
   is the attach step. Ports are explicit, not automatically discovered.
8. **Provider-specific gaps.** Not every native SDK feature is surfaced. No custom
   private-registry image secret bridge, general snapshot API, quota management,
   cross-provider artifact retrieval or nested-Docker guarantee. Modal volume
   commit persistence and multi-day dev lifetime require live validation. E2B
   `autoPause=false` and SkyPilot spot autodown discard mutable runtime state.
9. **Platform/package limits.** Linux/POSIX runtime tested; native Windows and macOS
   not tested. Native Windows needs Git Bash and unverified ACL/pipe paths. The
   package was not published to npm. Builds use explicit local TS tooling; runtime
   is dependency-free; release tests need isolated pinned developer SDK/tooling. pnpm/Vitest were not installed/tested.
10. **Setup/doctor scope.** Discovery checks binaries/directories and repairs owned
    files; it is not exhaustive host-version conflict detection or cloud service
    diagnosis. Native authentication is presence-detected, not validated by setup.
    Default setup does not auto-install detected hosts. Explicit safe uninstall
     removes only unchanged owned adapter files/exact hook entries and is not cloud cleanup.
     Re-run enable after config changes.

These are not hidden TODO provider classes: actual implementations live in
`src/providers/`, shared local contracts run, and the archive is executable. The
next gate after local hardening is controlled credentialed provider/harness validation,
including native crash-stop, retained-disk recovery and billing evidence.
