# Configuration

Precedence: built-in defaults -> `~/.reroute/config.toml` -> project
`reroute.toml` -> local project override stored by `reroute enable` -> CLI flags.
`REROUTE_HOME` changes the user-state directory. `REROUTE_AGENT_HOME` is an
explicit installer/testing override for native harness configuration locations.

The normal existing-server path only needs `reroute setup --provider ssh --host ALIAS`.
`enable` remains a compatible project-only entry. Shared TOML is for advanced settings, not secrets. Re-run
`reroute enable` after editing config so a warm coordinator refreshes its cached policy;
stop active commands/dev work first. Changing provider requires destroying the
old runtime explicitly, rather than orphaning it silently. `--new-identity` cannot
bypass this protection for an owned runtime at the same path. A copied/moved identity
can acquire a new UUID without deleting the original resource. Destruction of a stopped
runtime requires resuming the original and synchronizing first (Daytona can do this
via `reroute sync` after identity verification; other providers need native resume);
an unknown status is not permission to delete. Newly excluded files leave
the synchronization baseline without deleting their local or remote copies. Removing
an exclusion later treats the files as newly entering sync; divergent copies conflict.

```toml
provider = "ssh"

[runtime]
idleTimeoutMinutes = 10

[runtime.env]
CI = "1"

[providers.ssh]
host = "build-host"

[sync]
maxFileBytes = 16777216
maxFiles = 20000
excludes = ["large-fixtures", "*.local-notes"]
# Default: complete content validation. See metadata trust boundary below.
hashMode = "strict"

[routing]
envAllow = ["MY_NONSECRET_BUILD_FLAG"]
mode = "tasks"
# Exact argv prefixes, not shell expressions or globs. Local rules take precedence.
local = [["cargo", "test", "-q"]]
remote = [["node", "scripts/build.mjs"]]
# commands is PATH-shim eligibility, replacing the default list (not appending).
# commands = ["node", "pytest", "cargo", "pnpm"]

[artifacts]
# Explicit regular files only. Output is a fresh .reroute/artifacts/UUID directory.
paths = ["target/release/my-program"]
maxFileBytes = 16777216
```

Portable runtime fields are `cpu`, `memoryMiB`, `diskGiB`, `gpu.type`, `gpu.count`,
`region`, `image`, `spot`, `idleTimeoutMinutes`, and non-secret `env`. A provider
must explicitly support a portable field. SSH/E2B sizing does not quietly discard
fields. Provider-specific settings are namespaced; examples and the provider guide
list all exposed options. Unknown keys and wrong types are errors.

TOML support is an intentional bounded subset: tables, dotted keys, quoted strings,
booleans, finite numbers, arrays and inline tables. Multiline strings, dates,
array-of-tables and full TOML conformance are not claimed. Use `reroute doctor` to catch
invalid input. Arrays replace, tables merge.

The environment passed to runtime commands is **not** the local process environment.
The activation layer hashes the initial environment and forwards safe inline
changes such as `VAR=value cargo test`, explicit allowed variables and selected
standard variables. Credentials and control variables such as local PATH/HOME,
Node preload settings and Reroute recursion flags are blocked from forwarding.
Explicit `[runtime.env]` is trusted remote configuration, not a way to store
passwords. Provider-native named secrets are the supported secret injection path
where implemented.

Default task policy recognizes build/test/check candidates (for example `cargo test`,
`npm run build`, `go test`, `cmake --build`). `node --version`, `python --version`,
interpreter scripts, installs, unknown wrappers and unrecognized tasks stay local.
Classification uses argv only: no repository scan, network, model, or shell parser.
Git, provider CLIs, shells, SSH, deployment/publish/auth and OS/control tools stay
local, even under a project remote rule or explicit remote execution. Exact
`routing.local` prefixes win over `routing.remote`; remote prefixes still require
the executable to appear in `commands` for PATH interception. Version/help probes
stay local in transparent routing. An explicit `reroute exec -- COMMAND` or
`reroute COMMAND` overrides task eligibility, but not control/identity exclusions
or ambiguous shell operators. Commands are argv, never implicit shell scripts.

**Migration:** an existing explicit `routing.commands` without `mode` retains the
legacy executable policy. Setup/enable and explain JSON label it `legacy`; set
`mode = "tasks"` explicitly to migrate, then add narrowly scoped remote prefixes.
No identity or sync baseline is rewritten by classification. Built-in defaults
(without a user commands list) use task policy. Nested package-script bodies are
not inspected: even a build script can hide deployment; review project scripts
and keep such scripts local. This is not a security sandbox.

Excludes cannot undo mandatory credential/build exclusions. `.reroute-tmp-*` names
are reserved for same-directory atomic writes and excluded on both sides. `maxFiles`
applies to the merged source tree as well as each scan; an over-limit merge is refused
before changing either tree. Local and Python worker exclusions use the same bounded
syntax: `*` and `?` do not cross `/`; a complete `**` segment spans zero or more
segments. A basename pattern (including a literal directory name) matches at any
depth; a pattern containing `/` is rooted at the source root. Matching an ancestor
excludes its subtree; trailing `/` is accepted and normalized. No negation, character
classes, braces, backslashes, absolute paths, control characters, `..` or embedded
`**` are supported. Unsupported syntax is rejected explicitly rather than behaving
differently across scanners. Check the effective list with `reroute sync --dry-run`. `.gitignore` is not treated
as a credential policy. Symlinks and reserved path components are rejected.

## Interactive task selection

`reroute setup` on a TTY and Pi `/reroute` share the existing machine-local project
override and coordinator validation/save path, not a separate config file. Existing
user TOML and unrelated overrides are retained. `--non-interactive` (or `--json`)
keeps explicit-flag automation on a TTY; pipes never wait for prompts. Project-free
`setup --harness pi` still only installs the explicitly selected adapter.

Choose automatic categories with `--tasks build,test,check,benchmark`, `--tasks none`,
or `[routing] tasks = ["build", "test"]`. Omitted `tasks` retains all recognized heavy
categories; `tasks = []` disables category-based routing. Exact `remote` prefixes and
explicit argv execution can still opt in; local rules and control/identity exclusions
still win. Shims/command eligibility are unchanged. Existing legacy routing remains
legacy unless the user explicitly confirms task selection/migration in the wizard or
panel. Custom prefixes are retained; selecting no categories does not disable those
explicit remote rules. See [interactive management](INTERACTIVE.md).

## Hash validation and reuse

`sync.hashMode = "strict"` (the default, including omitted settings) hashes every
included file on every scan. Hashing and return transfers are incremental, so a large
file does not need a whole-file scan buffer. Set `hashMode = "metadata"` explicitly
only when ordinary filesystem writers and trustworthy change-time metadata are an
acceptable boundary: unchanged hashes may be reused within the current process/session
on Linux ext4 with non-coarse nanosecond metadata. Device, inode, size, mode, birth/change/
modification times and opened/named file identity must agree. Same-size edits with restored
mtime still invalidate change time; replacement and scan-time mutation are rejected or
rehash. Unsupported/unknown filesystems (including WSL Windows-mounted drives), coarse
timestamps, lost cache and cold restart fall back to full content validation.

Metadata reuse is **not a proof that every byte was reread**. Privileged writers, disk
snapshot restores, clock/metadata manipulation or filesystem bugs can violate its
assumptions. Use `strict` for such environments and recovery; no watcher is authoritative.
The cache is not a disk database and never replaces the agreed sync baseline. Runtime/
root/generation changes, cold/recovery preparation and failed reconciliation invalidate
reusable state. Remote worker invocations reuse only session-authenticated tokens held
in client memory; malformed/corrupted tokens rehash instead of becoming source authority. Transfers,
backups and final compare-before-overwrite checks still validate actual content in both
modes. Changing config on a warm project requires `reroute enable` as described above.

## Local-only preflight commands

`reroute sync --dry-run [--json]` scans only the local source tree and effective sync
policy. It reports included files, excluded entries/reasons, count/bytes/limits,
symlinks/unsupported types and sensitive-name risks. It does not start a daemon,
create a resource, update identity/baseline, upload source or inspect remote conflicts.
Readiness is only local scan readiness, never cloud readiness or proof of no secrets.
Excluded directories are pruned, so their descendants/counts are not enumerated.
An actionable local scan blocker returns exit 65 with the report; invalid config/usage
fails before scanning. A metadata preview cannot promise the tree will stay unchanged
or that the remote worker can read/write it later.

`reroute explain [--json] -- pnpm test` uses the same routing rules as execution,
plus enabled-project and recursion/local-override state. It explains PATH-shim
eligibility separately from configured policy; absolute executable paths bypass
shims. Shell wrappers, aliases and package script bodies are not parsed. Explicit
`reroute exec` has a different entry boundary but still rejects control commands.
The report does not execute the command or prove host activation/remote readiness.

## Source, cache and artifacts are separate

Source sync retains mandatory build-directory exclusions; remote caches remain in
that provider workspace. Reroute does not implement a compiler cache: use sccache,
Bazel, Nx or Turborepo inside the existing runtime as appropriate.

`reroute artifacts` reads only configured exact regular files below the root
`target`, `dist`, `build`, `coverage`, `.next` or `.nuxt` directory. No recursive
directory download, glob, credential path, symlink, source overwrite or baseline
update is allowed. Maximum 100 paths and 32 MiB per file (default 16 MiB), read one
file at a time through the same provider transport, with acknowledged 64 KiB chunks
and incremental size/hash checks before a complete output is installed. Downloads are non-executable
private files in a new `.reroute/artifacts/UUID/` directory; verified earlier files may
remain there on failure, while the interrupted file's private temporary is removed. Copy a verified output deliberately if you need it elsewhere.
There is no automatic fetch after every task, retention daemon or background index.
No recorded runtime means an error, not permission to provision an artifact source.

## Paid-resource authorization and authentication

`setup` never creates remote resources. Credential presence is **not verified
authentication** and describes the current CLI environment, not a daemon started
in another terminal. Use `reroute auth reload` deliberately to replace its auth
environment; no automatic account validation is implied.

For Daytona/SkyPilot/Modal/E2B, explicitly authorize the selected project/provider:
`reroute setup --provider daytona --allow-paid`, or later
`reroute enable --allow-paid`. This records `authorization.paidProviders = ["daytona"]`
in the machine-local project override. Alternatively set that table explicitly in
your user-owned configuration; a global setting grants that scope to projects
that inherit it. Provider names are checked and credential discovery never grants
consent. The default is an empty list, including migrated projects. Denial occurs
before provider preparation. SSH never provisions/stops a host and needs no paid
provisioning grant (an existing SSH host may itself cost money).

`reroute enable --revoke-paid` clears the project override grant; it is **not**
cloud cleanup. Stop already-running work deliberately; source is reconciled before
native stop even after revocation. A clean already-stopped runtime is not resumed
by ordinary stop. Resuming stopped paid compute for sync/destruction requires
renewed authorization. Native budgets/alerts and retained-storage costs remain
your responsibility. Never use consent as a reason to replace lost pending source.
