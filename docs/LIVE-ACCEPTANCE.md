# Controlled Daytona + Pi acceptance

**Not executed by pre-test hardening. All native/cloud/billing outcomes below are UNVERIFIED.**
This is a bounded acceptance procedure, not permission to provision resources. Obtain
explicit account-owner authorization, a cost ceiling and a cleanup owner first.
Use a disposable repository with synthetic data, one CPU-container sandbox, and a
short idle interval. Never begin with a production repository or valuable secrets.

## 1. Local preflight — no cloud or agent activation

- Record `git rev-parse HEAD`, branch, Node/Python/OpenSSH/Pi versions and OS.
- Run `npm run tools:install` and `npm run verify:release`. SDK installation downloads
  packages, not cloud provisioning. Check dist parity before trusting an installed CLI.
- Inspect native Pi version/extension compatibility and competing Bash replacements.
  Do not disable native host approvals or filesystem/network restrictions.
- In the disposable project, run `reroute setup` and confirm no harness is installed
  automatically. Then `reroute sync --dry-run --json` and
  `reroute explain --json -- pnpm test`. Confirm no daemon, resource or project identity
  was created by these read-only commands (`setup` itself may start the local coordinator).
- Include synthetic `.env`, `.npmrc`, a fake private-key filename, ignored cache,
  symlink, oversized file and unsupported exclude syntax. Check exclusions/errors;
  remove blockers before activation. Dry-run is not a secret detector or remote
  conflict check. Review included paths manually.

## 2. Explicit activation and first remote command

- Configure `DAYTONA_API_KEY` in the native local environment only. Do not put it in
  TOML, tests, terminal screenshots, shell history, issue text or acceptance logs.
- Configure native budget/alerts and inspect the selected account/target. Use a CPU
  container image with Python 3 and the actual project toolchain; no GPU/Spot/VM,
  hard TTL or auto-delete. An optional snapshot must expose CPU-container metadata.
- Run `reroute setup --install-sdk daytona --harness pi` deliberately. Inspect exactly
  which owned extension was installed; restart Pi. Record only redacted configuration.
- Run `reroute enable --provider daytona`, `reroute doctor`, then the first harmless
  intercepted runtime command. `doctor --probe` only performs the supported native SSH
  probe; it does not provision or certify Daytona. Verify the native sandbox ID/project label.
- Confirm the native Bash tool name, permissions, output shape, streaming and abort
  remain intact; there is no new model-facing remote execution tool or sandbox ID in
  the prompt. Confirm remote cwd/toolchain and local Git/editor/source authority.
- Exercise stdin, stdout/stderr, a nonzero exit, timeout (124), cancellation (130),
  generated source/lockfiles returning locally and excluded caches staying remote.
  Force a provider failure and confirm it does not execute locally.

## 3. Activity, idle and browser preview

- Run a job/dev server longer than the active native timer. Native auto-stop must stay
  finite (at least five minutes), activity must renew, and the job must not stop early.
- Stop the dev session, observe idle policy and native stopped state after the configured
  interval. Verify stop is not archive/delete and disk/owner generation remain intact.
- Run `reroute dev --port 3000 -- ...` with a server listening on `0.0.0.0`.
  `reroute dev open` should produce a working signed HTTPS link. It expires in five
  minutes; call `dev open` again for a fresh link. Treat the URL as a bearer capability
  and redact query tokens. Do not mistake a mock URL/typecheck for browser acceptance.

## 4. Crash and original-source recovery

- Record original ID/root/generation and local baseline hashes without exposing auth.
- In a controlled failure, disconnect source return-sync so `syncPending` remains true
  and an unsynchronized synthetic source change remains on the remote disk.
- Kill the disposable coordinator abruptly using its confirmed native PID (not an
  unrelated agent process). Do not start a new daemon while observing native activity.
  Verify renewal ceases and finite native auto-stop eventually stops compute; allow
  provider scheduling/API grace and record actual elapsed time/state.
- Start the coordinator again and check status: background recovery must not implicitly
  resume stopped paid compute. Run `reroute sync` deliberately and verify the exact
  original sandbox resumes, source returns, generation/baseline remain valid and
  `syncPending` clears. Native archive/start must pass the same identity checks.
- Exercise synthetic divergent edits: exit 73, remote conflict evidence, no silent
  overwrite; compare both versions before deliberate `sync --accept-local`.
- Repeat failure/retry with unavailable network/auth; pending marker and baseline must
  survive. In a disposable sandbox only, alter/remove owner identity to confirm sync
  and warm execution fail closed without creating a replacement or repairing marker.
  Recover original state/native backups before cleanup; never force-delete pending data.
- A sandbox found by stable name without locally recorded runtime/generation is refused,
  including create-before-state-save crashes. Back up with native tools or recover the
  original state rather than adopting an unverifiable disk.

## 5. Cleanup and billing evidence — acceptance is incomplete without this

1. Stop dev, reconcile source and confirm `syncPending: false`; compare valuable local
   generated files, backups/conflict evidence and Git status before deletion.
2. Run `reroute stop --destroy` deliberately. Verify native deletion of the **recorded
   original ID**, not merely CLI success. Check other matching `reroute.project` labels
   for orphaned resources, including interrupted creates.
3. Inspect native compute, disk, snapshots, archives, volumes and other storage charges.
   Stopped compute is not a zero-cost guarantee. Remove only authorized disposable
   storage after preserving evidence; record the billing observation interval/latency.
4. Disable the disposable project and run `reroute uninstall --harness pi`. Confirm
   unrelated extensions/config survive; modified owned files are reported/preserved.
   Stop the coordinator. Uninstall is not cloud cleanup, SDK deletion or config rollback.
5. Record timestamped/redacted native resource list and cost evidence. Revoke a dedicated
   test credential if used. Never commit credentials, full signed URLs or SSH tokens.

Accept only when each required outcome has evidence; otherwise record **UNVERIFIED**
or **FAILED**, retain recoverable source and stop the trial. Other providers/platforms
remain separate acceptance tasks and are not certified by this Daytona/Pi procedure.
