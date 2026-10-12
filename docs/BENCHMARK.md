# Round 3: offline synchronization benchmark

This is a **real local two-directory run of the production synchronizer and Python
worker**, not an in-memory manifest benchmark and not a cloud/SSH performance test.
The benchmark task itself added only `scripts/benchmark.mjs` and this document.
The accompanying refactor subsequently optimized scan counting and reused bounded
worker batches; its archived comparison is in the final section. No dependency
was added by the benchmark or refactor.

## Reproduce

Requirements: Linux, Node >=22, Python 3, Git, tar and GNU `/usr/bin/time`. No npm
installation, cloud credentials, coordinator, provider account or new dependency is
needed. GNU time and the other tools must already be installed.

```sh
# Small assert-based integration/self-check (not the performance dataset):
node --check scripts/benchmark.mjs
node scripts/benchmark.mjs --self-test --temp-dir /var/tmp > /var/tmp/reroute-benchmark-self-test.json

# Full run: three independent trees per implementation/scenario,
# two unchanged reconciliations per tree, 15 samples per local command.
node scripts/benchmark.mjs --baseline e2c77e2 --repeats 3 \
  --command-samples 15 --temp-dir /var/tmp > /var/tmp/reroute-round3-benchmark.json
```

Run on an otherwise idle machine; preserve the JSON alongside any published result.
Progress goes to stderr; stdout is one JSON document **only after all assertions
pass**. A failed run exits nonzero and does not produce a partial success report.
The script removes its own uniquely created scratch directory in `finally`; it does
not run `git checkout`, `git reset`, `git worktree`, build, install or modify tracked
runtime files. External process termination/power loss can leave its scratch tree.
Budget about 17 minutes on the recorded host for the default full run (most of it
in many-small initial transfers), and a few hundred MiB of temporary storage. `--help` lists the small option surface.

Prefer a disk-backed `--temp-dir`. The default is the OS temporary directory;
`/tmp` on the measured host is **tmpfs**, which cannot measure backing-disk reads.
The JSON records `df -T`, CPU, memory, kernel, Node/Python versions, HEAD, Git dirt,
resolved baseline commit and runtime fingerprints. Paths and Git status in a
report can reveal local machine/worktree names; review before publishing.

### Which implementation is measured?

The baseline is extracted with `git archive` from the resolved `e2c77e2` commit
(`dist`, `bin`, `assets`, `package.json`) into a private temporary directory. The
current implementation is a frozen copy of those **working-tree runtime files**.
Neither imports modules from the other tree. SHA-256 fingerprints distinguish
whole runtime and `dist/sync/sync.js`; `identicalRuntimes` explicitly flags a
same-code comparison. The script is not an implicit rebuild of `src`: build first
if you intend to measure source changes, and coordinate with concurrent editors.
Do not mistake a HEAD label for an assertion that working-tree `dist` is committed
or that it matches source. A frozen copy does not make concurrent builds safe;
avoid changing runtime artifacts during snapshot creation.

### Datasets and phases

| Scenario | Included files | Bytes/file | Included total | Files changed/increment |
| --- | ---: | ---: | ---: | ---: |
| small | 32 | 4 KiB | 128 KiB | 1 |
| medium | 256 | 32 KiB | 8 MiB | 2 |
| many-small | 2,048 | 1 KiB | 2 MiB | 20 |
| few-large | 4 | 16 MiB | 64 MiB | 1 |

The deterministic synthetic payload is mostly `a` bytes with a four-byte file
index, split into groups of at most 64 files. It represents file sizes/counts, not
an application corpus or compression benchmark. Excluded `.env`, `ignored/**` and
`*.local` sentinel files test the minimum and configured exclusion boundaries.
Policy limits admit each dataset; they are fixture limits, not changes to defaults.

Each independent pair starts with an empty remote directory, then runs:

1. `initial`: push all included files.
2. `unchanged-1`, `unchanged-2`: reconcile twice without mutations.
3. `incremental-push`: change one byte at offset four in roughly 1% of local files
   (minimum one); size stays unchanged.
4. `incremental-pull`: change that byte again on the remote side, testing return sync.

For few-large, the minimum one file means **25% of files** change: one byte edited
still requires transferring a complete 16 MiB file with this implementation.
Generation/mutation and verification are outside the measured subprocess. After
**every** measured phase, assertions compare all source/remote SHA-256 hashes,
permissions, agreed baseline hashes/count, excluded-file absence, pushed/pulled
counts and worker RPC counts. The real `fileTransport`/`spawnRaw` pipeline launches
the real worker on the same machine, just as the local integration fixtures do.
No fabricated remote manifest substitutes for worker scanning or writes.

Implementation order alternates between repetitions. Each timed phase starts a
fresh Node process, including its import/startup cost; Python worker startup is
part of sync cost. Each repetition uses a new pair of trees. No host cache drop,
privileged operation, artificial network latency or cloud operation is performed.

### Metrics and interpretation

Each raw sync/command row records:

- `wallMs`: monotonic parent elapsed time around GNU time + child process; includes
  spawn, imports, worker calls and successful completion, not fixture setup/checks.
- `userSeconds`, `systemSeconds`, `cpuMs`: GNU time CPU accounting for the command
  and waited-for descendants, including Python. Values have 0.01-second reporting
  resolution; CPU is not wall time or a sampled CPU percentage.
- `maxProcessRssKiB`: GNU time `%M` maximum resident set. This is the largest
  process high-water mark in the accounted process family, **not the concurrent
  sum of Node and Python RSS** and not total benchmark-controller memory.
- `inputBlocks`, `outputBlocks`, `blockReadBytes`, `blockWriteBytes`: Linux/GNU time
  block I/O accounting (`%I`, `%O`, multiplied by 512). These are kernel-accounted
  backing-storage operations, **not logical file-read bytes or device throughput**.
  Warm page-cache reads need no block I/O. Zero blocks does not mean no file reads.
- `localSourceReadBytes`, `localStateReadBytes`: actual successful `fs.promises.readFile`
  result bytes during reconciliation, separated by source vs `.reroute` state.
  Instrumentation does not remove/replace a read or hash. It **does not count Python
  content reads**, module imports, directory/metadata reads or pipe traffic.
- `rpcCalls`, `pushed`, `pulled`: actual worker calls and confirmed sync counts.

Newly written data and the complete verification scans warm the page cache. This
is deliberately a reproducible **warm-filesystem** comparison. It cannot establish
cold-storage I/O performance. RSS can vary with GC/allocator scheduling, and three
repetitions characterize this run rather than establishing statistical significance.
No unmeasured acceleration is inferred from code changes or individual samples.

### Local command latency

The script separately measures 15 fresh-process samples each of:

- a bare Node process printing `ok`;
- `reroute local -- <same Node command>`;
- bare `git --version`;
- `reroute shim git --version` in an isolated **disabled/non-project** directory.

All use a temporary HOME/REROUTE_HOME/XDG configuration/cache, a restricted child
environment and verified output/exit status. This measures local wrapper overhead,
not remote execution. It does not measure an enabled project's config discovery,
a native harness hook, shell startup, a real Git workload or an already-running
coordinator. Bare controls are measured for each implementation/order even though
the underlying Node/Git binaries are shared. Warm runtime file pages do not remove
fresh-process startup costs. Compare p50 and p95, not the fastest sample alone.

## Recorded full run: 2026-10-11

Command: the full three-repetition command above. Exit 0; **120 sync rows and 120
local-command rows** passed assertions. Started `13:23:21Z`, finished about
`13:40:16Z`; total 1,015.4 seconds including fixture generation and verification.
Environment: Node 24.21.0, Python 3.14.4, WSL2 Linux
`6.18.40.1-microsoft-standard-WSL2`, AMD Ryzen AI 7 H 350, four exposed logical
CPUs, approximately 16 GiB RAM, `/var/tmp` on ext4 `/dev/sdd`.
This was a shared development session, not an idle/load-isolated lab run.

Baseline commit: `e2c77e2248315cbcdf4075d17d7952c6becc0435`. The frozen current
runtime included concurrent CLI/setup/coordinator edits, but the **sync JS hash
was identical in both snapshots**:
`64dd6a147fd6418a6f84603917b7f179c5d10326eeca415bfc507adc6025367a`.
Whole runtime hashes:

- Baseline: `2633da051589277d3ae6ef72f8b7123a75e2101882a8b8d295a3e67ed39c8d50`.
- Current: `e4312f2c6d4cc9256843ff7b2066c5d69ff6246e707a6d0dd8e3166f5af01783`.

The later working tree continued to change. These numbers are about those frozen
snapshots, **not a certification of later source/runtime edits**. Same-sync
sample differences below are not evidence of a sync optimization or a speedup.

The table reports medians; `B / C` means baseline / frozen current. `unchanged`
pools the two unchanged phases (six samples per implementation); other phases
have three samples each. For even-sized groups the lower middle order statistic
is used, consistently with nearest-rank p50. Source-read bytes happened to be
identical for B and C; they omit remote Python reads as described above.

| Scenario | Phase | Wall ms, B / C | CPU ms, B / C | Max-process RSS MiB, B / C | Local source read MiB, both |
| --- | --- | ---: | ---: | ---: | ---: |
| small | initial | 1808.3 / 1807.0 | 1850 / 1860 | 64.3 / 64.4 | 0.375 |
| small | unchanged | 162.7 / 163.0 | 160 / 160 | 62.0 / 62.1 | 0.125 |
| small | incremental-push | 212.0 / 223.2 | 220 / 230 | 62.2 / 62.1 | 0.133 |
| small | incremental-pull | 234.2 / 237.1 | 230 / 240 | 62.2 / 62.1 | 0.137 |
| medium | initial | 13673.7 / 13536.6 | 13750 / 13880 | 72.8 / 73.2 | 24.000 |
| medium | unchanged | 381.2 / 401.9 | 290 / 360 | 65.2 / 65.4 | 8.000 |
| medium | incremental-push | 588.5 / 565.2 | 500 / 560 | 65.4 / 65.3 | 8.125 |
| medium | incremental-pull | 613.6 / 551.8 | 610 / 560 | 65.6 / 65.2 | 8.188 |
| many-small | initial | 105968.1 / 106556.3 | 106660 / 107350 | 95.6 / 95.4 | 6.000 |
| many-small | unchanged | 2950.2 / 2804.3 | 2960 / 2810 | 75.8 / 75.6 | 2.000 |
| many-small | incremental-push | 4026.2 / 3861.6 | 4060 / 3900 | 75.1 / 74.4 | 2.039 |
| many-small | incremental-pull | 3999.2 / 3975.8 | 3990 / 4000 | 74.4 / 74.2 | 2.059 |
| few-large | initial | 2046.8 / 1718.5 | 2450 / 2000 | 279.5 / 278.6 | 192.000 |
| few-large | unchanged | 292.6 / 292.5 | 290 / 290 | 103.0 / 102.9 | 64.000 |
| few-large | incremental-push | 666.9 / 655.9 | 750 / 740 | 188.9 / 188.7 | 96.000 |
| few-large | incremental-pull | 4112.9 / 4267.1 | 4240 / 4430 | 417.3 / 417.8 | 112.000 |

**Kernel-accounted block reads were zero in all 240 measured rows**, including
local commands. This is consistent with warm cache; it does not establish zero
source I/O or cold-disk performance. All block counters remain in the raw report.
The largest observed max-process RSS across sync samples was **453.4 MiB**.
For many-small initial sync there were exactly one scan and **2,048 apply RPCs**;
unchanged phases had one scan and no transfers; each incremental push/pull used
20 apply/read RPCs respectively. For few-large pull, one byte edited still caused
one full-file read response plus local guard/backup reads.

Local command wall latency, nearest-rank p50 / p95 (15 samples each; p95 is the
largest sample with this sample count):

| Command | Baseline p50 / p95 ms | Current p50 / p95 ms |
| --- | ---: | ---: |
| bare-node | 39.9 / 73.7 | 40.7 / 48.8 |
| reroute-local-node | 114.3 / 147.1 | 110.2 / 237.2 |
| bare-git | 8.4 / 19.6 | 8.2 / 11.2 |
| reroute-shim-git | 84.4 / 128.2 | 79.7 / 134.5 |

Subtracting the p50 values gives descriptive wrapper overhead of about **70 ms**
for explicit-local Node and **72 ms** for disabled-project Git shim in this current
snapshot. These are differences of medians, not paired-sample confidence bounds.

Raw report retained at `/var/tmp/reroute-round3-benchmark.json` for this session,
not added to the repository. SHA-256:
`08f8258815a0e8c6cf4f84574935f3c97501ed33b26859759e6e84b5d41f46df`.
Temporary reports are not permanent archival storage; retain a copy if needed.
The tiny `--self-test` also passed 40 sync and 16 command assertions; it is not
included in the performance table. Syntax/help and missing/invalid-option checks
passed. The full project/cloud/native-harness suites were not run by this task.

## Updated-runtime follow-up: separate sample population

Concurrent work changed the runtime after the first snapshot. A second run froze
that newer runtime and passed **40 sync measurements + 120 command measurements**:

```sh
node scripts/benchmark.mjs --repeats 1 --command-samples 15 --temp-dir /var/tmp \
  > /var/tmp/reroute-round3-benchmark-followup.json
```

Started `13:41:11Z`, finished `13:46:36Z`; 324.5 seconds on the same host. Baseline
commit/hash are unchanged. New frozen-current runtime SHA-256:
`f5c3ddd82ef8db2962b79b4aac019dd01babfa5c592556dc97d0ddfd299cefe6`;
sync JS SHA-256:
`44139dbec2b78eeff5b08b91aa9a214f081049fec03a36a5614fddc940978be0`.
The sync code now uses an integer file counter instead of repeated
`Object.keys(result).length`; other routing/worker/artifact changes are also in
this runtime. This run does **not isolate** any one change.

Below, B / C still means baseline / frozen current. There is **one independent
sample** per initial/incremental cell and two unchanged samples (lower p50 shown).
These observations are **not statistically validated speedups** and must not be
pooled with the first run's different current implementation.

| Scenario | Phase | Wall ms, B / C | CPU ms, B / C | Max-process RSS MiB, B / C |
| --- | --- | ---: | ---: | ---: |
| small | initial | 1724.6 / 2325.5 | 1740 / 1850 | 64.2 / 64.5 |
| small | unchanged | 179.0 / 165.5 | 140 / 150 | 61.9 / 62.0 |
| small | incremental-push | 236.5 / 214.5 | 230 / 210 | 62.0 / 62.0 |
| small | incremental-pull | 251.9 / 220.8 | 200 / 220 | 61.9 / 62.5 |
| medium | initial | 12636.8 / 14261.6 | 12960 / 14060 | 72.3 / 73.1 |
| medium | unchanged | 321.5 / 462.8 | 280 / 460 | 65.4 / 65.2 |
| medium | incremental-push | 519.2 / 580.6 | 460 / 580 | 65.0 / 65.6 |
| medium | incremental-pull | 507.0 / 566.0 | 470 / 530 | 65.5 / 65.7 |
| many-small | initial | 101876.4 / 100815.1 | 101270 / 101100 | 95.7 / 95.8 |
| many-small | unchanged | 2736.8 / 2563.7 | 2710 / 2560 | 75.2 / 75.2 |
| many-small | incremental-push | 3755.3 / 3551.9 | 3790 / 3530 | 75.1 / 74.9 |
| many-small | incremental-pull | 4089.2 / 3686.6 | 3980 / 3670 | 74.7 / 74.5 |
| few-large | initial | 1571.4 / 1461.4 | 1860 / 1750 | 279.0 / 278.6 |
| few-large | unchanged | 274.1 / 273.9 | 280 / 280 | 103.0 / 103.5 |
| few-large | incremental-push | 654.6 / 646.8 | 770 / 740 | 188.6 / 189.0 |
| few-large | incremental-pull | 3797.7 / 3844.5 | 3930 / 3930 | 425.4 / 425.3 |

Source-read bytes per phase match the first table exactly; all 160 rows again
reported zero kernel-accounted block reads. Many-small initial still used 2,048
apply RPCs. Local command p50 / p95 (15 samples each):

| Command | Baseline p50 / p95 ms | Current p50 / p95 ms |
| --- | ---: | ---: |
| bare-node | 36.5 / 38.5 | 36.8 / 40.2 |
| reroute-local-node | 101.5 / 106.8 | 100.9 / 103.5 |
| bare-git | 7.1 / 8.3 | 7.0 / 10.4 |
| reroute-shim-git | 72.5 / 83.2 | 74.2 / 79.5 |

Current differences of p50 imply approximately 64 ms explicit-local Node and
67 ms disabled-project Git-shim overhead in this run, not an enabled-project or
remote latency claim. This sample does not establish improvement over baseline.
Raw report: `/var/tmp/reroute-round3-benchmark-followup.json`, SHA-256
`f13840683dffa24ffd61a53409442fa26fc066623fa6ff28e06bef2f898fe722`.
After the small script cleanup fix, syntax and an injected initialization-failure
check also passed: a missing `df` fails without stdout and removes its scratch
directory. A final self-test after that fix again passed 40 sync and 16 command
measurements. AFT inspection was partial (cache writer-lease timeout and no scoped
JS analysis); the executable syntax/self-checks and completed benchmark assertions,
not an AFT clean claim, are the verification evidence. No production source/runtime
file was edited by this benchmark task.

## Mature alternatives: review, not a replacement

| Option | Where it may help | Why it is not a drop-in sync replacement |
| --- | --- | --- |
| rsync | Native file lists, one session instead of per-file worker startup; remote delta transfer for large edited files | A one-way copy has no Reroute three-way agreed baseline/conflict protocol. Default size/mtime quick checks do not match content-hash validation. `-a` includes symlinks; `--delete` can destroy destination-only source. Must preserve mandatory exclusions, guarded expected hashes, backup evidence, deletion ordering and failure/pending semantics. Remote availability and native Windows need checking. |
| Mutagen | Persistent development sync and change detection; potential fit for repeatedly unchanged trees | An additional agent/session lifecycle and independent ignore, conflict and symlink policies must be reconciled with ownership, pending-source restoration and provider lifecycle. No current Reroute transport integration or compatibility/performance trial is claimed. |
| Unison | A mature bidirectional, archive-based sync model worth evaluating for three-way changes | External executable/remote availability, version compatibility, archive ownership and conflict/deletion behavior need a dedicated adapter acceptance test. Existing Reroute state is not automatically a Unison archive. No measured performance claim here. |

Installed rsync 3.4.1 `--version`/`--help` were inspected: the delta algorithm,
checksum-vs-size/time selection, symlink/archive and deletion options are explicit.
The other entries are architecture candidates, **not verified integrations**.
Public documentation links for a follow-up review:
[rsync manual](https://download.samba.org/pub/rsync/rsync.1),
[Mutagen synchronization](https://mutagen.io/documentation/synchronization/),
[Unison](https://www.cis.upenn.edu/~bcpierce/unison/).
The URL reader could not retrieve live pages in this run (host resolution was
blocked); no current vendor behavior or comparative speed is certified. No
alternative was installed, invoked for a transfer, or added as a dependency.

Any optimization/replacement must preserve
[source/runtime safety](../specs/engineering/source-runtime-safety.md),
[shared exclusions and read-only preview](../specs/engineering/local-inspection-and-adapter-ownership.md)
and [configured pattern semantics](CONFIGURATION.md).
The benchmark's straightforward successful byte edits do not replace the existing
race, conflict, corruption, symlink, deletion and recovery regression suites.

## Initial bottleneck review (before bounded batches)

These are recommendations, **not speedups implemented or validated by this task**:

1. **Many-small startup costs:** the baseline `Synchronizer.reconcile` calls
   `transport.apply([change])` per pushed file, and `fileTransport` launches one
   Python worker per RPC. The benchmark records the real call count. A bounded
   batch within the existing worker protocol is the first larger experiment;
   retain per-path expected hashes, deletion-first ordering, payload/frame bounds
   and agreed-baseline-on-success behavior. Do not batch an unlimited number of
   base64 payloads or replace conflict handling with `rsync --delete`.
2. **Low-risk scan overhead:** the baseline/first snapshot checked
   `Object.keys(result).length` after every inserted file, repeatedly enumerating
   a growing manifest (quadratic total enumeration work). The parallel agent has
   already replaced this with an integer counter in the follow-up snapshot while
   preserving `maxFiles` refusal; this single follow-up does not prove the gain.
   Pattern validation/compilation still repeats per visited path: compile the
   existing supported syntax once per validated scan, not with a different glob
   library. Measure each change separately before claiming a gain.
3. **Few-large memory and read cost:** local scan hashes a complete `readFile`
   buffer; transfers materialize a full file and base64/JSON frames. Streaming the
   scan hash is a smaller memory experiment than a new transport. The Python scan
   already hashes in chunks. A one-byte edit still transfers the whole file; only
   a separately validated delta/streaming protocol can change that. Do not remove
   race hashes, backups or final guarded checks to make the benchmark faster.
4. **Unchanged repeats:** both sides still scan/hash all included files, even when
   transfer counts are zero. Metadata caching/watchers would require invalidation
   and missed-event correctness work; size/mtime alone is not an equivalent
   content/race guarantee. Start with the low-risk scan work, not a daemon.
5. **Local commands:** compare bare-vs-wrapper latency separately from sync. Most
   fixed wrapper cost is fresh Node/module loading and project/config discovery,
   not remote transfer. A local-control fast path must preserve routing semantics;
   never infer that an unavailable cloud runtime permits local fallback.

The current measurements run a Python worker on the same host; real network/SDK
latency could amplify per-file RPC costs, but no numeric cloud extrapolation is
validated. The smaller option is to retain the synchronizer and finish the low-risk scan
experiments first; a transport replacement needs a separate decision.

## Bounded-batch implementation: archived final synchronization comparison

The measured bottleneck justified one small reuse change: push the existing worker's
guarded apply arrays in bounded batches (128 paths / roughly 4 MiB JSON; a larger
supported file alone). No second coordinator, native sync dependency or background
index was introduced. Counter optimization remains. Per-path expected hashes,
deletion ordering, partial-failure recovery and full-success baseline remain tested.

Run: `node scripts/benchmark.mjs --baseline e2c77e2 --repeats 3 --command-samples 15 --temp-dir /var/tmp`.
Completed 2026-10-11T13:55:43.615Z to 2026-10-11T14:05:57.341Z: 120 real sync phases and 120 command samples.
Raw evidence is archived as [ROUND3-FINAL-BENCHMARK.json](verification/ROUND3-FINAL-BENCHMARK.json),
not just a temporary report. The JSON records the exact frozen runtime fingerprints.
Later CLI usage guards, shared provider verification consolidation and comments are
not in this snapshot; the benchmark bypasses provider APIs by design. It measures
the same batch algorithm, not live provider/SSH/Pi verification overhead. Some local
tests ran concurrently, so timings are descriptive observations, not isolated
statistical confidence bounds or a cloud extrapolation.

Below: median across three independent trees; unchanged combines six repetitions
(even-sample medians average the middle pair). RSS is max-process, not family-sum.
CPU includes waited-for Python descendants. All block-read counters were zero
because this is a warm-cache experiment; logical source reads did not decrease.

| Scenario | Phase | Wall ms B / C | CPU ms B / C | RSS MiB B / C | Apply RPC B / C |
| --- | --- | ---: | ---: | ---: | ---: |
| small | initial | 1627.2 / 287.2 | 1680 / 290 | 64.1 / 63.4 | 32 / 1 |
| small | unchanged | 155.4 / 155.5 | 150 / 160 | 62.1 / 62.0 | 0 / 0 |
| small | incremental-push | 219.4 / 210.8 | 220 / 210 | 62.1 / 62.1 | 1 / 1 |
| small | incremental-pull | 206.7 / 211.3 | 210 / 210 | 62.1 / 62.2 | 0 / 0 |
| medium | initial | 12207.5 / 1299.9 | 12570 / 1370 | 73.0 / 101.2 | 256 / 3 |
| medium | unchanged | 443.8 / 461.9 | 445 / 460 | 65.0 / 65.4 | 0 / 0 |
| medium | incremental-push | 571.7 / 515.3 | 570 / 520 | 65.3 / 65.6 | 2 / 1 |
| medium | incremental-pull | 558.3 / 572.1 | 570 / 580 | 65.4 / 65.3 | 0 / 0 |
| many-small | initial | 96760.5 / 7918.1 | 98070 / 7760 | 95.7 / 77.9 | 2048 / 16 |
| many-small | unchanged | 2810.4 / 2404.0 | 2805 / 2190 | 75.7 / 75.2 | 0 / 0 |
| many-small | incremental-push | 3687.2 / 2472.7 | 3720 / 2330 | 74.6 / 74.2 | 20 / 1 |
| many-small | incremental-pull | 3824.4 / 3582.8 | 3800 / 3620 | 74.6 / 75.1 | 0 / 0 |
| few-large | initial | 1480.2 / 1847.8 | 1790 / 2010 | 278.9 / 278.8 | 4 / 4 |
| few-large | unchanged | 295.3 / 298.0 | 290 / 295 | 103.2 / 103.2 | 0 / 0 |
| few-large | incremental-push | 755.1 / 718.8 | 750 / 800 | 188.8 / 172.8 | 1 / 1 |
| few-large | incremental-pull | 4137.2 / 3940.4 | 4270 / 4060 | 417.6 / 422.7 | 0 / 0 |

Small-file initial synchronization improved in this offline dataset: 2,048 files
went from 96.8 s / 98.1 s CPU / 2,048 apply calls to 7.92 s / 7.76 s CPU / 16 calls.
This is a measured reduction in local worker startup/CPU, not remote build speed.
Medium initial RSS rose from 73.0 to 101.2 MiB: bounded batching trades some memory
for fewer processes. Large-file initial time regressed (1.48 to 1.85 s); large-file
return peak remained about 423 MiB. Unchanged trees still require full hashes;
do not claim universal acceleration, lower read volume or uniformly lower memory.

| Local command | Baseline p50 / p95 ms | Current p50 / p95 ms | Current CPU ms / RSS MiB |
| --- | ---: | ---: | ---: |
| bare-node | 37.0 / 46.5 | 38.5 / 43.4 | 20 / 44.7 |
| reroute-local-node | 101.4 / 121.6 | 106.5 / 127.3 | 100 / 61.1 |
| bare-git | 7.7 / 9.2 | 7.8 / 9.4 | 0 / 3.7 |
| reroute-shim-git | 74.1 / 85.2 | 76.5 / 85.3 | 70 / 61.2 |

Current descriptive extra p50: explicit local Node **68.0 ms**, disabled-project
Git shim **68.7 ms**. Compared with baseline wrapper p50, current was ~5.1 ms slower
for local Node and ~2.4 ms slower for Git shim; no local-wrapper speedup is claimed.
A normal unshimmed Git command pays none of this executable wrapper cost, but a
native agent's shell activation cost was not measured. No added background process
or runtime npm dependency. Existing daemon and explicit dev-sync timers remain.

## Round 5 follow-up

Round 3's archived measurements above remain the historical baseline, not a claim
about the current implementation. Round 5 uses a frozen copy of the uncommitted
Round 1–4 runtime (not `git HEAD`) and real-process return-transfer profiling in
`scripts/benchmark-round5.mjs`. Results and measurement limits live in
[Sync performance Round 5](SYNC-PERFORMANCE-ROUND5.md).

`scripts/benchmark-hash-reuse.mjs --runtime FROZEN_ROOT --temp-dir /var/tmp`
measures three sequential strict and explicit metadata scans within each session;
repeat with `--temp-dir /mnt/c` for Windows-mounted storage. Local and real Python
worker logical reads, CPU, process RSS, block counters and protocol bytes are reported
separately. It asserts streamed content hashes, counts and metadata agreement; lost
cache means full reads. The baseline ignores the new optional mode and still fully
hashes, making a conservative comparison. See `--help` for dataset/repeat controls.
No benchmark builds, activates a provider, drops OS caches or installs a dependency.
