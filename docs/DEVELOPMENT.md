# Development

Canonical repository: https://github.com/onedotmint/Reroute. Project/package name:
Reroute / `reroute`. The user CLI is `reroute`; the coordinator entry point is
`rerouted`. See [migration](MIGRATION.md) for the old Outboard names.

## Build and test

Use Node.js 22+ and Python 3 for worker integration tests:

```sh
git clone https://github.com/onedotmint/Reroute.git
cd Reroute
npm install --prefix .tools --no-save typescript@5.8.3 @types/node@22
npm run verify
npm run smoke
```

Build tools are kept in ignored `.tools/`; the core has no runtime npm dependencies.
Build output is checked in so a source snapshot can run before installing a compiler.
Edit `src/`, not `dist/`, and regenerate `dist/` before sharing a source change.
`npm test` alone tests the compiled files; it does not rebuild TypeScript.

Optional cloud SDKs are installed separately by `reroute setup --install-sdk ...`.
Do not commit credentials, `.tools/`, provider SDK installs or machine-local state.
The npm and pnpm lockfiles describe the dependency-free core; npm is the verified
build/test path. Provider credentials are not required for local tests.

## Module boundaries

- Core owns routing, identity, configuration use, coordination and lifecycle policy.
- Providers translate native resources/handles/lifecycle and expose byte channels.
- The shared channel supervises remote processes; source sync owns reconciliation.
- Agent bridges translate native protocols and activate the shell boundary only.
- CLI/doctor own human-facing setup and diagnostics, not duplicate runtime logic.

Add provider capabilities only when the platform can honor them. Add a wire fixture
and opt-in live test before claiming support. Keep cancellation, stdin and fail-closed
behavior intact. Update TypeScript and Python sync/exclusion policy together and test
the real worker. A same-machine subprocess is not a cloud sandbox; reports must keep
them distinct.

## Packaging

```sh
npm run verify
npm pack --ignore-scripts
# From a clean, committed Git working tree:
npm run package:source -- /path/to/output
```

`package:source` requires `.git` and a clean committed tree. An extracted snapshot
without Git metadata cannot run this command until it is placed in a repository and
committed. The script archives tracked files, rejects obvious secret/cache paths,
adds generated provenance, extracts the zip, and runs extracted CLI/unit/harness
checks. It produces `reroute-source.zip` and `reroute-packaging-report.json`.

`npm pack` creates the separately installable npm package and does not publish it.
Never bundle credentials, private SSH keys or tool caches. The original Outboard
archive provenance is historical, not proof of the current Reroute tree; see
[delivery evidence](DELIVERY.md).
