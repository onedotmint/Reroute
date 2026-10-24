# Reroute 0.4.0

## Daily-use release

Install once globally with `pi install npm:@onedotmint/reroute@0.4.0`, configure accounts through `/reroute` → masked terminal setup, and reuse defaults across projects. A project needs explicit one-time source-upload/execution consent before its first remote task; account spending policy remains a separate gate.

### Changes

- User-level provider accounts, compute defaults, budgets and execution settings; optional simple project overrides. Existing v3 project configuration remains supported and is not automatically migrated, overwritten or deleted. Existing projects need the new one-time consent.
- Global/project native Pi packages coexist without duplicate tool registration, including reload. Ordinary Pi/AFT Bash remains unchanged; the model chooses heavy work directly through `reroute_run`.
- SDK source transfers use a verified manifest-indexed gzip stream instead of per-file uploads. Unchanged and one-file Daytona transfers reuse its verified baseline; Modal retains its release/recreate policy and download-cache persistence.
- Native progress and measured phase timings, separate task/status uncertainty, recent project jobs, provider defaults and local cost estimates.
- Static npm/pnpm/Yarn/Bun/Rust/Python environment hints; `npm-shrinkwrap.json` bootstrap/cache identity support and version-declaration cache keys.
- Modal image PATH preservation, narrowly validated Volume mount aliases, private identity/config/state exclusions, and existing ownership/descendant/cache safety protections.

### Acceptance

The release runtime is derived from frozen candidate SHA-256 `de62f3837d6c941488f4f50304fbb06b3a8229a772e052f35707eb38b9460e31`. Release-only changes are version metadata, CLI help strings and documentation; no cloud execution logic is changed for release.

- 262 automated checks, strict types/build and CLI smoke passed with real Pi 1.4/AFT 0.62 coexistence.
- Frozen package global installation/consent acceptance: 13/13 groups passed.
- Daytona and Modal: four real scenarios per provider passed, including source integrity, warm downloads, intentional exit 7, project isolation and resource cleanup.
- Real model: six selection categories have successful evidence after an independently authorized light-fixture correction; 15 total requests, no automatic retry. This used an isolated local Provider, not autonomous model-to-paid-cloud execution.

Original harness failures and later authorized rechecks remain recorded. See [full acceptance](RELEASE-ACCEPTANCE.md) for exact scope, timings, artifact identities and residual resources.

### Known limits

Local budgets are estimates, not provider billing caps. Tiny remote tasks still incur substantial startup/transport overhead. No controlled historical speedup factor, production SLA, broad fault-recovery certification or universal model-selection accuracy is claimed. Unknown jobs may need manual provider verification; no local retry is automatic. Modal releases compute after confirmed jobs but keeps storage by design. Three empty test Apps remain from acceptance because the installed public JS SDK lacks App deletion; all new test Volumes were deleted and compute terminated. Keys saved by Reroute use private permissions, not encrypted keychain storage.
