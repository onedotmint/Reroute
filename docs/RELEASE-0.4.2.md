# Reroute 0.4.2

## In-panel provider management and the DeepSeek Harness preview

This update lets an existing configuration be repaired and extended from the `/reroute` panel, and ships the DeepSeek Harness adapter as a **preview** entry point in the same package. Pi remains the supported host for everyday use. The engine, router, provider SDK lines and cost rules are unchanged, so no new paid-cloud or model-selection acceptance was performed for 0.4.2.

### Changes from 0.4.1

- **Manage providers without a terminal.** When a configuration already exists, **Manage providers** offers the same in-panel onboarding as first-run, plus **Use a saved credential account**, **Enter missing API key (hidden input)** and the previous wizard kept as **Advanced terminal setup**. Filling a missing key writes only that provider's credential file: profile settings and spending authorization are untouched.
- **Spending authorization asks, and defaults to No.** Authorization is now an explicit `No — save without spending authorization` / `Yes — authorize paid creation/start` select. Escape cancels without saving. `No` still saves a usable profile that cannot create or start paid compute.
- **Quick onboarding no longer replaces billable references.** A managed profile with recorded resources is refused by quick onboarding, because destroyed compute can leave billable storage behind. Keep the old profile/account and change it through **Compute & budget**.
- **Project overrides stay project-scoped.** Project-only onboarding, saved-account reuse and the E2B sandbox path write to the project override instead of the global user defaults.
- **Masked input uses Pi's own parser.** Paste, Kitty CSI-u keys and grapheme editing now match ordinary Pi text fields, and the value is still only ever rendered as a mask.
- **E2B is reachable from first-run onboarding**, alongside SSH, Daytona and Modal.
- **DeepSeek Harness preview entry point.** The package now also exports `./dsh` and ships `cordis.patch.yml` activating `@onedotmint/reroute/dsh` for Harness `0.2.1-rc.5`. Harness SDKs stay host-provided. This is a **WIP preview**: it is not qualified for real projects or paid tasks, and its evidence is Linux/Node 24 fixtures, not real-model or paid-cloud acceptance. See [Harness usage and boundaries](DEEPSEEK-HARNESS.md) and the [current status and blockers](DEEPSEEK-HARNESS-STATUS.md).

### Upgrade

```bash
# Native Pi package (global by default)
pi install npm:@onedotmint/reroute@0.4.2
pi list

# Optional standalone CLI
npm install -g @onedotmint/reroute@0.4.2
reroute --version
reroute doctor --json
```

The old `npm:...@0.4.1` specification stays pinned; select 0.4.2 explicitly, check `pi list` for obsolete copies, then restart or reload Pi. Updating the package does not grant project execution consent or spending authorization, and no credential/configuration migration or cloud resource operation is needed. Existing configuration files keep working unchanged.

The Harness adapter is installed only through the pinned preview tarball flow in [Harness usage](DEEPSEEK-HARNESS.md#install-the-current-build). Pi installation never pulls Harness SDKs.

### Verification and publication

`npm run verify` (strict typecheck, build, full offline/component suite, CLI smoke) and the packed clean install pass locally on Node 24 with npm 11. Production dependency audit remains **3 moderate / 0 high / 0 critical**; the development/host tree keeps the disclosed high findings from the pinned Pi and Harness SDK lines and is not a clean full-tree audit. See [dependency security](DEPENDENCY-SECURITY.md) for advisory detail and upgrade conditions.

CI covers Node 22/24 × npm 11/12 on Linux, real localhost SSH/rsync, real Pi/AFT coexistence, and a limited Windows job. CI success and an uploaded tarball are not publication: availability is determined by the [npm registry](https://www.npmjs.com/package/@onedotmint/reroute/v/0.4.2). Publication is manual from the verified tarball, and no automated release workflow or GitHub Release is introduced.

### Limits

Not verified for 0.4.2: real paid-cloud runs, billing, broad fault recovery, standard Harness Web/Desktop UI, real-model tool selection and Windows beyond the limited CI job. Historical 0.4.0 cloud measurements remain historical evidence and do not qualify the current dependency tree against the live services. This is **not a zero-vulnerability release**.
