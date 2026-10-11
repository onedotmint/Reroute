# Delivery and historical evidence

Reroute was originally delivered under the name **Outboard**. The preserved original
report is [verification/ORIGINAL-DELIVERY.md](verification/ORIGINAL-DELIVERY.md), and
its recorded Git provenance is [verification/original-delivery-state.json](verification/original-delivery-state.json).

The original `final-verify.tap`, `live-provider.tap` and `summary.json` under
`verification/` also belong to that original delivery. Old names, paths, dates and hashes are intentionally unchanged. They do not
identify the current Reroute working tree or prove that renamed code was verified.
`PREFLIGHT.md` and `REFERENCES.md` describe the original inspection environment.

The new [reroute-behavior-fixes.tap](verification/reroute-behavior-fixes.tap) records
local regression verification after the five behavior fixes; it is separate from the
original delivery evidence.

For current verification, run `npm run verify` and `npm run smoke`. Live cloud tests
are opt-in: skips are not passes. See [testing](TESTING.md) and
[the project review](PROJECT-REVIEW.md) for the checks and remaining gaps.

From a clean committed repository, `npm run package:source` creates new
`DELIVERY-STATE.json` provenance **inside the generated source archive** and writes
`reroute-packaging-report.json` beside it. No current commit hash is inferred from
the original extracted snapshot. Packaging alone does not certify cloud APIs,
provider persistence or native harness compatibility.
