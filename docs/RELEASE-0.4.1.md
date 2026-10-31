# Reroute 0.4.1

## Dependency security and npm packaging patch

This patch distributes the governance changes from [PR #5](https://github.com/onedotmint/Reroute/pull/5), merged as `76c32f986d358301356d7826c8597611a2534d42`. It retains the single CLI + Pi extension package and existing configuration, private credential storage, project authorization, budgets and provider safety boundaries. No new paid-cloud or model-selection acceptance was performed for 0.4.1.

### Changes from published 0.4.0

- Fix the production high-risk HTTP dependency paths: follow-redirects **1.16.2** within the existing Axios range; E2B **2.60.0** with Undici **8.12.3**, removing the vulnerable `undici8` alias. Daytona and Modal SDK version lines are unchanged.
- Keep a committed **package-lock.json** for reproducible development/CI, but publish **neither npm lockfile nor shrinkwrap**. Critical SDKs use reviewed patch ranges; stable utilities stay within their current majors.
- Keep Pi SDKs as host-provided optional peers and explicit development dependencies, not additional production SDK installations. Clean consumers contain no Pi SDK, GenAI, esbuild or TypeScript.
- Add weekly Dependabot npm/Actions PRs and event-driven security PRs, without auto-merge or automatic npm publication. Production high/critical audit findings block CI; full host/development findings are reported separately.
- Preserve other projects' shrinkwrap support and cache identity on npm ≤11. Automatic preparation checks the actual remote npm and refuses shrinkwrap projects on npm ≥12, including dual-lock layouts, rather than silently choosing a different tree. It never migrates project locks, installs/downgrades npm, or retries locally.
- Validate real packed installations with CLI offline diagnostics and a separately installed Pi 1.4 host, under default and disabled install-script policies. No installation script approval is required for the tested path; Modal CBOR JS fallback and protobuf encode/decode are checked explicitly.

### Upgrade

Once npm reports 0.4.1 as available:

```bash
# Native Pi package (global by default)
pi install npm:@onedotmint/reroute@0.4.1
pi list

# Optional standalone CLI
npm install -g @onedotmint/reroute@0.4.1
reroute --version
reroute doctor --json
```

The old `npm:...@0.4.0` specification is pinned: an upstream release or an ordinary refresh does not necessarily move it. Select the new version explicitly, inspect `pi list` for obsolete copies, and restart/reload Pi. Updating the package does not grant project execution/spending consent or remove an unrelated handwritten legacy extension. No credential/configuration migration or cloud resource operation is needed.

For npm-12 remote targets, a project that still has shrinkwrap needs a reviewed npm 11 environment or a deliberate lock migration by its maintainer. Reroute will refuse automatic preparation rather than silently install from another lock.

### Verification and publication

The governance source passed Node 22/24 × npm 11/12 Linux CI, real localhost SSH/rsync, actual Pi/AFT coexistence and panel tests; Windows CI covers build, lock discovery, routing and the CLI entry only. The 0.4.1 metadata/docs-only preparation separately reruns the release checks and pack/install validation. CI artifacts record the exact source commit, dirty-state, integrity, CLI/extension results and production installation size; CI success is not proof of publication.

Publication is manual from the verified tarball, only after the release-preparation PR and CI pass. Check the [npm registry](https://www.npmjs.com/package/@onedotmint/reroute/v/0.4.1) for actual availability. No automated release workflow or GitHub Release is introduced.

### Remaining security findings and limits

This is **not a zero-vulnerability release**. At preparation, the repository production tree has **3 moderate / 0 high/critical** findings (E2B → glob/minimatch); a clean consumer reports **4 moderate / 0 high/critical**, including Reroute's own transitive-risk entry. The pinned Pi development/host tree still has **1 high** plus moderate findings; the latest examined upstream Pi also pins affected versions. No incompatible major override or blanket script approval hides these findings.

See [the full security report](DEPENDENCY-SECURITY.md) for advisory URLs, exploit preconditions, upstream blockers, installation scripts and upgrade conditions. Historical 0.4.0 cloud measurements do not qualify the updated E2B SDK against the real service. Billing, broad cloud recovery and real-model behavior remain outside this patch's verification scope.
