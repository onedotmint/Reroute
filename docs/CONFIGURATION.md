# Configuration

Precedence: built-in defaults -> `~/.reroute/config.toml` -> project
`reroute.toml` -> local project override stored by `reroute enable` -> CLI flags.
`REROUTE_HOME` changes the user-state directory. `REROUTE_AGENT_HOME` is an
explicit installer/testing override for native harness configuration locations.

The normal existing-server path only needs `reroute setup` and `reroute enable --provider
ssh --host ALIAS`. Shared TOML is for advanced settings, not secrets. Re-run
`reroute enable` after editing config so a warm coordinator refreshes its cached policy;
stop active commands/dev work first. Changing provider requires destroying the
old runtime explicitly, rather than orphaning it silently. `--new-identity` cannot
bypass this protection for an owned runtime at the same path. A copied/moved identity
can acquire a new UUID without deleting the original resource. Destruction of a stopped
runtime requires resuming the original with native provider tools and synchronizing first;
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

[routing]
envAllow = ["MY_NONSECRET_BUILD_FLAG"]
# commands replaces the whole default executable list, it does not append.
# commands = ["python3", "pytest", "cargo", "pnpm"]
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

Default runtime groups cover Rust; Node/npm/pnpm/yarn/bun/deno; Python/pip/uv/pytest;
C/C++ build/compiler tools; Go; Java/Maven/Gradle. Read
`src/core/routing.ts` for the exact list and local subcommand exceptions. Git,
GitHub/provider CLIs, SSH, Docker and OS/control tools remain local. A package
script that hides a deploy or credential operation is not semantically inspected:
run that deliberately through `reroute local -- ...`.

Excludes cannot undo mandatory credential/build exclusions. `.reroute-tmp-*` names
are reserved for same-directory atomic writes and excluded on both sides. `maxFiles`
applies to the merged source tree as well as each scan; an over-limit merge is refused
before changing either tree. Globs support `*` and
`?`; complex Git ignore semantics are not implemented. `.gitignore` is not treated
as a credential policy. Symlinks and reserved path components are rejected.
