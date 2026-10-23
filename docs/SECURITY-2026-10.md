# Dependency security refresh — 2026-10-23

## Scope and sources

This is a bounded dependency/runtime maintenance update, not a comprehensive security audit or a provider expansion. It is based on the already-verified 0.3.1 Modal repair candidate. Publication remains paused; the old CI artifact must not be mistaken for this newer dependency tree.

Original sources checked:

- [Node 2026-10-21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
- [Node 24.22.1 release and checksums](https://nodejs.org/en/blog/release/v24.22.1) and [Node 22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4).
- [GitHub GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- [Axios maintainer incident report](https://github.com/axios/axios/issues/10636) and [CISA's Axios supply-chain alert](https://www.cisa.gov/news-events/alerts/2026/04/20/supply-chain-compromise-impacts-axios-node-package-manager).
- [Modal JS release notes](https://modal.com/docs/sdk/js/releases).
- Exact package manifests, dependency ranges, integrity/signature metadata and fresh advisories from the official npm registry, not third-party mirrored tarballs.

## Findings

### Runtime: actual security update needed

The running host was Node 24.21.0, and the preceding CI used 22.23.3 / 24.21.0. They precede the October security releases. Official fixes include high-severity DNS NUL handling, TLS hostname validation and Brotli decoder memory corruption, plus other bundled-library updates. These require a patched Node binary, not `npm audit fix` or a newer npm CLI.

The project now declares `^22.23.4 || ^24.22.1 || >=26.12.1`, checks the same floors in doctor, tests exact patched Node 22/24 versions in CI, and pins `.nvmrc` to 24.22.1. Older/EOL odd-number lines 23/25 are excluded. Existing upstream package engine ranges do not supersede this application's security baseline. Installed Pi hosts and already-running processes must be upgraded/restarted separately.

An official Node 24.22.1 binary was downloaded to `.tools/security-node/`, with SHA-256 checked against both HTTPS SHASUMS256.txt and the checksum in official release notes. No global runtime, user's shell startup or running Pi process was changed. PGP trust-store verification was not performed.

### Dependency: one high-severity chain, not four independent issues

Fresh baseline audit: four high entries along `@daytona/sdk → fast-glob → micromatch → braces`, rooted in GHSA-vfj7-8cjw-p6xm (stack-exhaustion DoS on deeply nested patterns). GitHub reports no fixed braces release. The existing Reroute image recipe does not feed user-controlled glob patterns into this path, but removing the vulnerable chain is preferable to permanently carrying an unreachable-path justification.

Daytona 0.226.0 replaces fast-glob with tinyglobby, removing braces/micromatch/fast-glob from this exact tree. The existing real-SDK no-local-COPY-glob regression is updated to intercept the new primitive rather than weaken the boundary. No Daytona provider behavior/code was changed; a pre-1.0 SDK minor upgrade still needs compatibility testing and does not inherit prior live acceptance automatically.

### Supply-chain incident: current lockfile not affected by the known versions

The Axios incident involved 1.14.1 / 0.30.4 and the injected plain-crypto-js package. This project's exact current tree has Axios 1.20.0, no affected Axios version, and no plain-crypto-js. This is a current-lockfile finding, not a forensic claim that the host never installed an affected package in the past. No automatic credential revocation or system-wide malware scan was attempted.

## Minimal changes

| Component | Before | After | Reason |
| --- | --- | --- | --- |
| @daytona/sdk | 0.223.1 | 0.226.0 | Remove known vulnerable glob chain via upstream replacement |
| modal | 0.11.0 | 0.11.1 | Maintenance patch; not advertised as a specific CVE fix |
| ignore | 7.0.12 | 7.0.13 | Maintenance patch; not advertised as a specific CVE fix |
| E2B's transitive undici | 7.30.0 | 7.30.1 | Compatible in-range patch, no forced v7→v8 override |
| Node baseline | >=22.19.0 | patched 22/24/26 floors | Official runtime security release |

The Daytona SDK update necessarily updates its pinned API/telemetry family and removes old glob utilities. The lock tree loses 20 dependency entries overall. E2B itself, Pi SDK, TypeScript, Clack and shell-quote remain pinned; no major toolchain migration, unsafe `audit fix --force`, broad `overrides`, or automatic npm CLI major upgrade was used. Download/install operations used `--ignore-scripts`; this is not a policy change to arbitrary user project scripts executed by Reroute.

## Verification boundaries

- Fresh npm audit after lock resolution: **0 known vulnerabilities** across the complete lock tree. This is a point-in-time registry result, not proof of absence of malicious code or undisclosed vulnerabilities.
- `npm audit signatures`: **279 installed packages with verified registry signatures**, **95 packages with verified attestations**. Signed publication does not prove benign code or protect against a compromised authorized maintainer.
- Strict typecheck under project-private patched Node passed before CI.
- New tests cover absence of the known vulnerable/malicious packages, synchronized engine policy and doctor version boundaries. Existing SDK glob test still forbids local COPY expansion.
- Final Node 22.23.4 / 24.22.1 CI, full tests, SSH/AFT and packaged install results must be read from this branch's exact run/commit, not the previous Modal-only candidate. Raw audit/registry/runtime evidence lives locally under `.artifacts/security-update/`.

Previous paid live Modal/Daytona receipts apply to the prior SDK tree. No paid cloud requalification, global Node replacement, OS/Python/Rust image scan, full host compromise investigation, new provider, default-provider switch or performance optimization was performed here. Existing cached cloud images need independent runtime review/rebuild where their binaries are older than the security baseline; npm package installation cannot update them.
