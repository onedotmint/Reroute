# 0.3.1 preview patch

This patch carries the Modal fixes accepted at `e6b68ad176bd6cbec4fea4e30d5eec54e207e89a` into the maintained `rebuild/0.3-native` line. The initial Modal repair did not change dependency versions, the default Provider or other Provider implementations. The separate security dependency refresh below now updates the release candidate before publication.

- Accept only Modal's fixed cache mount alias pointing directly at `/__modal/volumes/vo-<ID>`, while keeping ancestor/archive/member link validation. Real download archives now survive Sandbox release/recreation.
- Run Modal commands with `bash -c`, not `bash -lc`: the login profile had removed the image's `/usr/local/cargo/bin` from PATH. Rust is installed correctly; `CARGO_HOME` cache redirection and the unchanged image recipe/version remain valid.
- Include offline mount/security and real-shell PATH regressions, and compare installed tarball executor files against the source/build in the package check.

Live acceptance before this packaging bump: default Node/Rust/Python plus a Rust compile/run, then two identical Reroute dependency-install/typecheck/build/test/smoke tasks at 2 physical CPU / 4 GiB. Each returned 0 with 200 passed, 0 failed and 2 original host-AFT opt-in skips; the warm task restored download archives in a different Sandbox and rebuilt node_modules/dist. GitHub Actions must separately verify the final patch SHA on Node 22/24, including actual AFT, localhost SSH and independent tarball install. CI success is not npm publication; registry metadata/integrity confirms publication.

No overall speedup is claimed: dependency install improved (8.814 → 6.783 s), but transfer (82.309 → 123.696 s) and observed allocation/execution time (145.387 → 193.245 s) worsened. Transfer instrumentation and `npm-shrinkwrap.json` automatic preparation/cache-key recognition are follow-up work, not silently included in this patch.

Billing is unverified; cost reservations are local estimates. Complex live fault recovery and post-release artifact retrieval remain outside this acceptance. No new Provider, provider performance equivalence, or default switch to Modal is proposed. Temporary acceptance resource cleanup is operational and does not delete users' normal resources.

## Security dependency refresh (before publication)

Node's 2026-10-21 security release fixes high-severity DNS/TLS/Brotli issues: require `^22.23.4 || ^24.22.1 || >=26.12.1`, pin `.nvmrc` to 24.22.1, and test exact patched Node 22/24 versions in CI. Doctor reports this baseline too. Do not infer that installing an npm package updates an already-running Pi host or cached cloud image.

Daytona SDK 0.223.1 → 0.226.0 removes the vulnerable fast-glob/micromatch/braces chain (GHSA-vfj7-8cjw-p6xm); no fake braces override is used because no patched braces release exists. Modal 0.11.0 → 0.11.1 and ignore 7.0.12 → 7.0.13 are maintenance patch refreshes, not claims of specific fixed CVEs. Compatible Undici lock updates move 7.30.0 → 7.30.1; the existing 8.x entry is already within its declared range. Other pinned direct dependencies, TypeScript and Pi SDK remain unchanged. The previous live Provider acceptance predates these SDK updates; fresh offline/CI compatibility checks do not substitute for live requalification.
