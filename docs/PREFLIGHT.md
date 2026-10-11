# Delivery preflight (2026-10-06)

Canonical repository: `/mnt/data/outboard`, branch `main`; no parallel worktrees.
Git 2.47.3 successfully created an initial checkpoint. Node 22.16.0 and global
TypeScript 5.8.3 are available. pnpm, OpenSSH, SkyPilot and Mutagen are absent;
rsync, zip, unzip, tar and Python 3 are present. No Daytona, Modal or E2B credential
variables were present (only variable names were checked, never printed values).

`npm view typescript version --fetch-retries=0 --fetch-timeout=15000` failed with
`EAI_AGAIN getaddrinfo registry.npmjs.org`. `curl -IL --max-time 10 https://github.com`
failed with `curl: (6) Could not resolve host: github.com`. This is an environment
DNS/network limitation, not a package test failure. Official documentation and
reference source were inspected using the separate browsing facility.

A zip was created and `unzip -t` passed before implementation. Delivery destination
is writable. The dependency-free runtime and Node test runner permit executable
local verification. Global TypeScript and existing Node declarations are used for
strict local typechecking; neither machine-specific symlinks nor dependencies are
included in the archive. Cloud live tests and real OpenSSH tests are opt-in and
must be reported unverified in this environment, not passed by test doubles.
