# Round 5 — offline source synchronization performance

Round 5 changes **only synchronization performance**: bounded returns, backup/conflict/
artifact data paths, incremental hashing and explicit conservative hash reuse. It does
not redesign routing, CLI, Providers or Agents, add a dependency/service/database, or
change local Git authority and original-runtime recovery. No commit, staging, push,
cloud operation or credential discovery occurs. The benchmark remains offline.

## Runtime identity and reproduction

The Round 4 baseline is the **actual uncommitted working-tree runtime**, immediately
copied to `/var/tmp/reroute-round4-frozen-lXjdm5` (dist/assets/bin/package.json) and
made read-only. It is not `git HEAD` and not Round 3's committed baseline. Source
builds precede the final-current copy to `/var/tmp/reroute-round5-final-runtime-5s2OKW`.
The current matrix uses that immutable copy, not a concurrently changing build. Each invocation
checks its runtime fingerprint before/after and retains its own benchmark runner.
The old runner is read as a reference, never edited or used to archive HEAD here.

```sh
node --check scripts/benchmark-round5.mjs
node scripts/benchmark-round5.mjs --runtime /var/tmp/reroute-round4-frozen-lXjdm5 \
  --self-test --report-dir /var/tmp/reroute-round5-self-check

# Separate invocations use the same deterministic dataset and policy.
node scripts/benchmark-round5.mjs --runtime /var/tmp/reroute-round4-frozen-lXjdm5 \
  --label baseline --repeats 3 --report-dir /var/tmp/reroute-round5-baseline-final \
  > /var/tmp/reroute-round5-baseline-final.stdout.json

# Only AFTER final build/ready: freeze current to a separate directory first.
node scripts/benchmark-round5.mjs --runtime CURRENT_FROZEN_ROOT --label current \
  --repeats 3 --report-dir /var/tmp/reroute-round5-current \
  > /var/tmp/reroute-round5-current.stdout.json

# Allocation diagnosis is a separate sample population, NOT timing evidence.
node scripts/benchmark-round5.mjs --runtime /var/tmp/reroute-round4-frozen-lXjdm5 \
  --profile --scenarios few-large --parallel none --repeats 1 \
  --report-dir /var/tmp/reroute-round5-baseline-profile

# New random directory only; no drive scan. Repeat for current when ready.
node scripts/benchmark-round5.mjs --runtime /var/tmp/reroute-round4-frozen-lXjdm5 \
  --temp-dir /mnt/c --scenarios few-large,many-small --parallel none --repeats 1 \
  --report-dir /var/tmp/reroute-round5-baseline-mnt-c
```

No new install is necessary: Linux, Node, Python standard library, GNU time, df and
getconf are used. stdout is JSON; progress and the raw report path go to stderr.
Every report directory retains `report.json`, the frozen `benchmark-runner.mjs`,
per-phase inputs, GNU time outputs, `/proc` timelines and optional `.heapprofile`.
Datasets and the private HOME are removed on ordinary completion. Interrupted
processes can leave their uniquely created scratch directory. Do not publish
machine paths blindly; reports contain paths but no credential contents.

## Dataset, checks and failures

The original benchmark's 4 × 16 MiB and 2,048 × 1 KiB deterministic `a`/index files
are retained. Additional scenarios use one 64 MiB and one 128 MiB file. Generation
writes in 1 MiB chunks, verification uses streaming SHA-256: the controller does
not hold the complete payload in RAM. Synthetic `.env`, `ignored/**`, `*.local`
sentinels test exclusions; they are not real credentials. Each fixture policy
admits its files, without changing production defaults or frame limits.

For each of three independent datasets, a fresh Node subprocess runs the real
`Synchronizer.reconcile`, real `fileTransport`, `spawnRaw`, and Python worker for
initial push, two strict unchanged scans, roughly 1% incremental push/pull (at least
one file), then return of all files. For the small-file case, the last full return
is omitted: incremental return tests 20 files and initial push retests batching.
For each large-file dataset, 2 and 4 independent projects run concurrently; equal
trees first establish an agreed baseline, then every remote file changes and is
returned. Trees, baselines and backup directories are never shared among lanes.

Every successful phase verifies both trees' streamed SHA-256, agreed baseline
count/hash/size, executable permission agreement, exclusions, confirmed transfer
counts and exactly one real worker scan. Small fixtures use the same exercised
paths as the self-check. These checks are not a substitute for the implementation
agent's race/conflict/symlink/deletion/corruption regressions.

**A failed frame remains failed.** No limit is relaxed. After a refused large
initial push, equal trees are fixture-seeded outside measurement so strict scans
and return can still be tested. A refused incremental push is restored from the
unchanged remote fixture before testing return; this is benchmark-only recovery,
not production recovery behavior. Reports preserve the actual exception, counts
and bytes. Expected frame/pipe/transport failures are explicit `status: failed`,
not counted as verified. Other failures stop the invocation with its partial raw
report retained. Finishing the matrix does not mean every runtime row succeeded.

## Measurement definitions and observed platform limitations

- **Wall/CPU:** parent monotonic elapsed time; GNU time user+system CPU includes
  waited descendants (Python), rather than Node-only CPU. 0.01 s GNU time resolution
  and shared-host scheduler/cache noise remain. Parallel CPU is summed across lanes.
- **Memory:** `/proc/PID/status` RSS is sampled every 10 ms for each process family,
  traversing actual `/proc/PID/task/PID/children`. Reports preserve each observed
  process, sampled peak RSS, kernel VmHWM, and a timestamped family-sum timeline.
  `familyPeakBytes` is the largest simultaneous sum, not a sum of unrelated maxima.
  The benchmark controller's RSS and simultaneous family+controller sum are separate.
  GNU time max-process RSS is also retained and is **not** family RSS.
- **Node allocations:** `process.memoryUsage` records RSS/heapUsed/heapTotal/external/
  arrayBuffers at intervals and before/after actual RPCs. Synchronous JSON parse/
  stringify can block interval callbacks; external `/proc` sampling observes RSS
  independently. Optional Inspector sampling includes collected allocations and
  writes the real sampling profile. Sampling is not a census of all live objects.
- **Python allocations:** the separate `--profile` launcher executes unchanged worker
  source under tracemalloc, records traced peak/current, allocation sites at actual
  rpc/emit/digest (and current read_stable/read_stream) returns, Python ru_maxrss and
  logical source read bytes. Current fd-based reads are counted through os.fdopen;
  chunk-emission checkpoints are sampled every 64 chunks to avoid retaining a snapshot
  for every frame. The old runner remains alongside its original baseline report. This adds
  overhead, so never compare these timings with unprofiled rows. JSON framing and
  file IO are still production logic, not a replacement microbenchmark.
- **Logical source reads:** Node instrumentation observes successful promises.readFile,
  FileHandle.read/readFile/createReadStream and callback fs.read backing streams.
  It counts bytes by included-source vs `.reroute` state path and leaves the original
  result/event intact. It is deliberately **not readFile-only**. It is not a universal
  syscall tracer: native bindings, alternative future IO APIs and module imports are
  not source-path totals; instrumentation needs updating if those become source IO.
- **IO limitation discovered on this host:** `/proc/PID/io` does not exist, including
  `/proc/self/io`, on this WSL2 6.18.40.1 kernel. Reports retain `procIOAvailable: false`
  and `io: null`, not invented zero logical/disk bytes. strace/perf are not installed;
  no dependency was installed to compensate. On an accounting-enabled Linux host,
  per-process `/proc io` samples and Node start/end deltas are retained; parent IO can
  include reaped children, so sampled parent/child counters must not be summed as
  independent totals. GNU time input/output block counters remain available here.
- **Transport:** actual stdin/stdout bytes and maximum newline-delimited frame bytes
  are counted without retaining payloads or bypassing the channel. Profiling stderr
  is counted separately. This is local pipe traffic, not network/provider billing.
- **Budget:** default `--budget-mib 512` is an explicitly configurable observation
  threshold for the **whole measured family**, including concurrent lanes, excluding
  controller. `budgetPassed` is reported for every row; it does not authorize a
  relaxed production frame bound or establish an accepted deployment SLA. Consumers
  can select a stricter approved aggregate budget and inspect max-frame bytes too.

Generation, byte mutation and verification are outside measured sync children but
warm page cache. There is no privileged cache drop or cold-disk claim. ext4 and
`/mnt/c` (9p/DrvFS on this host) measure isolated local source+worker trees; neither
represents a network/cloud runtime. Filesystem results and peak samples are
observations under a shared development workload, not confidence bounds.

## Evidence and diagnosis

The Round 3 archived report at
`docs/verification/ROUND3-FINAL-BENCHMARK.json` records a roughly **422.7 MiB median
max-process RSS** for current 4 × 16 MiB incremental pull. That metric excluded the
benchmark controller and was not the sum of Node+Python. The return phase changed
one 16 MiB file, not all four; a one-byte edit transferred the entire file.

Round 4's frozen runtime still implements whole-file base64 read responses and
unbounded repeated string accumulation up to the existing 64 MiB per-frame bound.
The diagnosis runs below distinguish these mechanisms from guarded backups and
controller setup. Allocation sizes and process maxima must not be added together
as if they were a single simultaneous peak.

### Frozen Round 4 baseline: completed three-repeat matrix

Raw report: `/var/tmp/reroute-round5-baseline-final/report.json` (99 rows,
69 passed/verified, 30 failed). SHA-256:
`1c8330c5deb318a53f0a2e1317b3d91871f2c8c1e8f026af93d618af9c1a3e21`.
Runtime fingerprint (this script's path/content hash convention):
`7b8f26362d6a41051a3c79200ce56de0467326ecc18bda3348e3efa8124c637b`.
The report retains its exact runner; this fingerprint convention differs from
Round 3's tree digest, so differing hashes alone are not a performance conclusion.

Medians across three independent datasets (each unchanged phase shown separately):

| Scenario / lanes | Phase | Wall ms | CPU ms | Family peak MiB | Max-process MiB | Node source read MiB/lane |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 4 × 16 MiB / 1 | initial | 1799.3 | 2110 | 316.6 | 279.5 | 192 |
| 4 × 16 MiB / 1 | unchanged-1 | 306.5 | 310 | 105.1 | 103.9 | 64 |
| 4 × 16 MiB / 1 | unchanged-2 | 295.9 | 280 | 105.0 | 103.9 | 64 |
| 4 × 16 MiB / 1 | incremental-push | 820.5 | 860 | 255.9 | 189.5 | 96 |
| 4 × 16 MiB / 1 | incremental-pull (one file) | 4378.2 | 4270 | 483.3 | 402.8 | 112 |
| 4 × 16 MiB / 1 | all-pull (four files) | 15235.9 | 15490 | 749.3 | 666.2 | 256 |
| 4 × 16 MiB / 2 | all-pull | 17562.1 | 34470 | 1291.0 | 648.6 | 256 |
| 4 × 16 MiB / 4 | all-pull | 25143.9 | 68510 | 1971.3 | 635.5 | 256 |
| 2048 × 1 KiB / 1 | initial | 8398.5 | 7920 | 98.4 | 77.4 | 6 |
| 2048 × 1 KiB / 1 | unchanged-1 | 2853.8 | 2660 | 93.0 | 76.7 | 2 |
| 2048 × 1 KiB / 1 | unchanged-2 | 2828.9 | 2650 | 91.8 | 76.0 | 2 |
| 2048 × 1 KiB / 1 | incremental-push (20 files) | 3004.6 | 2850 | 93.8 | 75.0 | 2.0391 |
| 2048 × 1 KiB / 1 | incremental-pull (20 files) | 3856.0 | 3730 | 94.1 | 75.1 | 2.0586 |

The small-file initial push still uses **16 apply RPCs**, incremental push one,
incremental pull 20 reads. The unchanged scans actually read all included bytes;
there is no metadata-only shortcut. The one-file 16 MiB return receives 22,370,249
stdout bytes (including scan metadata); its largest actual frame is 22,369,684
bytes. Four-file return receives 89,479,301 bytes per lane in four separate file
frames. Node sampled heapUsed medians are **311.3 MiB** for one-file return and
**505.4 MiB** for four-file return. The controller's corresponding separate median
peaks were 167.3/168.1 MiB, outside both family and GNU time max-process metrics;
later matrix retention/verification raised controller memory to about 255 MiB.
The old 423 MiB max-process observation therefore cannot be blamed on a controller
included in the measurement; controller cost is additional, separately visible.

With the diagnostic aggregate-family 512 MiB threshold, one-file 16 MiB return
fits in this run; full four-file return and 2/4-project returns do not. This is an
observation, not an approved memory SLA or a claim that 512 MiB is adequate.

**64/128 MiB transfers fail in every repeat.** The expanded base64 payload requires
about 85.3/170.7 MiB before JSON metadata, beyond the existing 64 MiB frame bound.
Initial/incremental push terminates with EPIPE after the worker refuses its request.
Return either reaches `PROTOCOL_LIMIT` or loses transport under the existing 30 s
started timer before the full frame arrives. The report shows actual partially
transferred bytes rather than claiming a complete 85/171 MiB frame was received.
Single-project 64/128 MiB failed-return family peak medians were 1087.9/1334.6 MiB;
four-project failed returns were 2953.9/3968.9 MiB. Failure is not a successful large
file or budget result. Equal-tree strict scans succeed and read exactly 64/128 MiB
per lane, with single-lane family medians about 142.9/206.9 MiB.

### Attribution: real profiled production return, separate from timings

Raw report: `/var/tmp/reroute-round5-baseline-profile/report.json`, SHA-256
`2cadaeeaaaa8179cfbb8b770a095da48062d92fccf3c5d905e3b9547ca8c69ec`.
All six profiled phases passed verification. The one-file return's Inspector
profile is `few-large-0-1-incremental-pull/node-0.heapprofile` beneath that directory;
its ordinary Chrome/Node sampling profile can be inspected without a new package.

The dominant finding is **Node channel string flattening/accumulation**, not the
controller or Python scan. Inspector attributes **5,150,305,832 cumulative sampled
allocation bytes** to `indexOf` during one 16 MiB return, versus about 22.5 MiB
allocated at the channel parser and 21.5 MiB at StringDecoder.write. Across four
sequential returns, indexOf accounts for 20,673,353,216 cumulative bytes. These
values include collected allocations: **they are allocation churn, NOT live RSS**.
The unchanged channel repeatedly appends decoded fragments to a growing JS string
and calls `indexOf('\n')` before a complete large JSON frame is available. That
forces repeated flatten/search work over increasing prefixes; sampled allocation
sites and the large live heap corroborate the mechanism. No synthetic readFile-only
microbenchmark is used to infer it. The measurement wrappers do not concatenate
stdout or retain payloads inside the measured worker.

During this separate one-file profile run, the Node process reached sampled RSS
437.7 MiB; memoryUsage heapUsed peaked at 319.7 MiB and arrayBuffers at 48.6 MiB
(external 67.0 MiB). The process.memoryUsage timer can miss short synchronous
maxima; VmRSS sampling and GNU time provide separate checks. Profiling changed GC/
RSS behavior, so its 529.2 MiB family maximum is not pooled with the 483.3 MiB
unprofiled median. Inspector sampled the benchmark's memory sampler itself at about
0.28 MiB and event-wrapper allocations at well below 1 MiB; this is not evidence
that the instrumented and uninstrumented runs are identical, but it rules out a
hundreds-of-MiB retained-payload wrapper as the measured root cause.

**Python contributes a bounded but nonzero large-frame overhead:** its real scan
reads all 64 MiB with traced peak about 3.8 MiB and RSS 28.9 MiB under profiling.
Its subsequent 16 MiB file-read worker reads 16 MiB and reaches traced peak **71.0
MiB**, RSS **89.5 MiB**. At rpc return, the 22,369,665-byte retained allocation is
at `worker.py:191` (base64 string); the read/base64 transient peak is 49.7 MiB, and
JSON emission raises peak to 71.0 MiB. This separates base64/JSON from a streaming
scan. For an incremental push, Python traces about 81.7 MiB peak: request bytes,
JSON-decoded base64 and the 16 MiB decoded buffer coexist. Profile checkpoints show
22.37 MiB each at request readline and JSON decoder plus 16 MiB at base64 decode.

**Backups and guards remain real work, but do not explain the JS heap peak.** Node
reads exactly **112 MiB** on one-file return: 64 MiB strict local scan plus three
16 MiB reads for target hash guards/backup. Python separately reads 80 MiB (64 MiB
scan + 16 MiB return). The real guarded destination backup and replacement write
remain enabled. Buffer storage is visible in Node external/arrayBuffers, rather
than the 311 MiB unprofiled heapUsed. This is attribution, not permission to remove
backups/guards or claim every allocation byte belongs exclusively to one mechanism.

### Isolated filesystem comparison: ext4 versus /mnt/c

Raw `/mnt/c` report: `/var/tmp/reroute-round5-baseline-mnt-c/report.json`, SHA-256
`5cb1f0a8e39c1c1904389c62a8c8966e55471470efa8d855f777c428b295906d`.
Only a newly created random tree was used; no drive inventory or credentials were
read. `df -T` identifies `/mnt/c` as 9p and `/var/tmp` as ext4. This filesystem
sample has **one repeat**, versus the three-repeat ext4 table; it is descriptive,
not a paired confidence estimate. Both source and worker trees reside on the named
mount, so this is not a mixed-local/network deployment simulation.

| Baseline phase | ext4 median wall ms | /mnt/c one-sample wall ms | /mnt/c family MiB |
| --- | ---: | ---: | ---: |
| 4 × 16 MiB initial | 1799.3 | 5115.7 | 317.7 |
| 4 × 16 MiB unchanged-1 | 306.5 | 1585.4 | 105.0 |
| 4 × 16 MiB unchanged-2 | 295.9 | 1649.0 | 105.3 |
| 4 × 16 MiB incremental-push | 820.5 | 3401.7 | 255.7 |
| 4 × 16 MiB incremental-pull | 4378.2 | 6422.9 | 599.4 |
| 4 × 16 MiB all-pull | 15235.9 | 19868.1 | 841.8 |
| 2048 × 1 KiB initial | 8398.5 | 347803.6 | 94.2 |
| 2048 × 1 KiB unchanged-1 | 2853.8 | **failed after 85016.7** | 92.6 |

Small initial batching remains 16 apply RPCs and successfully verifies all files.
The next unchanged phase completed its full 2 MiB local read but the real remote
scan could not finish under the existing 30 s channel started/result timer; it
failed `TRANSPORT_LOST`. Later unchanged/incremental phases were not fabricated or
measured on a failed state. A filesystem-sensitive timeout is a separate production
behavior concern, not permission for this benchmark to change the timer/logic.
The mixed outcome matters more than a blanket speed ratio. Higher return RSS on
9p can reflect scheduling/GC lifetime changes; one sample does not isolate a new
allocation mechanism.

All three baseline reports recorded zero GNU time input/output blocks. On this
host `/proc io` is absent and the kernel configuration has `CONFIG_TASKSTATS` unset;
these zero values cannot certify zero backing-storage activity (nor can they alone
establish warm-cache savings). Logical source bytes and transfer counters remain
measured separately. No device-throughput or cold-storage conclusion is claimed.

## Current implementation and measurement boundary

All shipped providers use acknowledged **64 KiB chunks, one in flight** for source
returns, conflict evidence and explicit artifacts. Local hashing, backup copies and
final expected-content checks also stream. Data stays in a private temporary until
size/hash, planned metadata and confirmed exit 0 agree; failures remove the incomplete
temporary. Baseline advancement, deletion-first batches, conflict preservation,
original runtime/generation and pending-source protection remain intact.

The small-file push batch remains **128 paths / approximately 4 MiB JSON**, not one
worker per file. Large pushes still use the prior whole-file path: 64/128 MiB push
rows fail the existing 64 MiB request-frame bound and are reported as failures. No
larger frame, new transport service, paid resource or remote-to-local fallback was used.

Stop-and-wait is a deliberate minimal bounded-memory implementation. High-RTT SSH/
cloud throughput is **UNVERIFIED** and can be RTT-limited (64 KiB per acknowledgement).
The local-pipe speedups below are not a WAN claim; a wider bounded window needs its
own latency/cancellation/budget measurements before adoption.

The final ext4 matrix is repeated against `/var/tmp/reroute-round5-release-runtime-eIuQwU`.
The earlier current profile and mounted-filesystem sample use the separately archived
`/var/tmp/reroute-round5-final-runtime-5s2OKW`. Their streaming/hash/worker paths are
unchanged; the release candidate additionally restores encoded-size checking **before
decoding** for the legacy injected-transport fallback, which neither sample exercises.
This scoped version difference is recorded rather than hiding a late compatibility fix.

## Dual scanner hash reuse

`sync.hashMode = "strict"` remains the default. Explicit `metadata` reuses only verified
in-process hashes under Linux/ext4, precise change-time and stable file identity assumptions.
Local records are immutable with in-process provenance; remote worker calls reuse
session-authenticated HMAC tokens held in client memory, scoped by original runtime/root/
generation and named root identity. Failed reconciliation, cold/recovery preparation,
identity changes or cache loss discard reuse. Corrupt tokens rehash. Final overwrite
checks and backups never substitute cached metadata for actual content hashes.

Same-size edits with restored mtime, rapid inode replacement, mode changes, mutation
during reading and parent-directory substitution have executable regressions. Metadata
reuse cannot prove unchanged bytes under privileged metadata manipulation, unannounced
snapshot restore, clock/filesystem faults or writers bypassing normal change time;
use strict mode there. Unknown/coarse filesystem metadata always rehashes. No watcher,
disk database or persisted cache is treated as source authority. See
[configuration](CONFIGURATION.md#hash-validation-and-reuse) for the user-facing boundary.

The scanner benchmark uses the same process/session for three scans in each mode,
three independent ext4 trees, and one mounted-Windows tree. Table entries are medians
of scans 1 and 2 (warm reuse); cold metadata scans read **all** included bytes on both
sides. Timing includes instrumentation: Node observes actual read APIs; the unmodified
Python scanner runs with transparent open/fdopen read counters and resource telemetry.
Interpreter startup is included remotely. This is not a readFile-only microbenchmark.

| Filesystem / dataset | Mode | Local ms / CPU ms | Remote ms / CPU ms | Logical reads local / remote | Protocol bytes sent + received |
| --- | --- | ---: | ---: | ---: | ---: |
| ext4, 4 × 16 MiB, frozen Round 4 | full content | 99.87 / 110.30 | 98.13 / 87.62 | 64 / 64 MiB | 584 |
| ext4, 4 × 16 MiB, current | strict | 185.67 / 183.82 | 95.79 / 85.92 | 64 / 64 MiB | 584 |
| ext4, 4 × 16 MiB, current | metadata warm | 6.31 / 7.10 | 44.61 / 36.90 | **0 / 0** | 2,981 |
| ext4, 2048 × 1 KiB, frozen Round 4 | full content | 1544.46 / 1498.21 | 98.73 / 88.57 | 2 / 2 MiB | 226,353 |
| ext4, 2048 × 1 KiB, current | strict | 2352.88 / 2291.13 | 136.91 / 126.74 | 2 / 2 MiB | 226,353 |
| ext4, 2048 × 1 KiB, current | metadata warm | 1869.67 / 1797.70 | 135.03 / 118.80 | **0 / 0** | 1,367,042 |
| /mnt/c, 4 × 16 MiB, current | strict | 993.23 / 317.34 | 732.85 / 169.97 | 64 / 64 MiB | 584 |
| /mnt/c, 4 × 16 MiB, current | metadata fallback | 1026.03 / 322.81 | 764.60 / 180.66 | **64 / 64 MiB** | 711 |
| /mnt/c, 2048 × 1 KiB, current | strict | 25783.59 / 5638.93 | 11831.93 / 1864.19 | 2 / 2 MiB | 226,353 |
| /mnt/c, 2048 × 1 KiB, current | metadata fallback | 32657.87 / 6596.94 | 11838.01 / 1864.49 | **2 / 2 MiB** | 226,480 |

Read elimination is real, but is **not a universal speedup**. Nanosecond/fd stability
checks cost strict scans; small-file metadata reuse retains traversal/stat overhead
and sends about six times as many protocol bytes for authenticated tokens. It does
not outperform the old small-file scanner in this sample. Mounted Windows reuse is
correctly disabled and opting into metadata there adds avoidable metadata overhead.
Prefer strict mode on unsupported filesystems. The benchmark's Python ru_maxrss may
include fork/pre-exec high-water inherited from its Node launcher; do not attribute
that watermark entirely to Python allocations or add it to Node maxima. The real
process-name RSS/tracemalloc return profiles provide the attribution below.

All reported block counters are zero here, while `/proc io` is unavailable. Backing
storage read bytes/throughput therefore remain **UNVERIFIED**; logical content reads
and wire bytes above are measured, not inferred from those zero counters.

## Final return comparison: exact release-candidate runtime

Final raw ext4 report: `/var/tmp/reroute-round5-release-final/report.json`, SHA-256
`33307ff6e95c2a505c44c8578cc61f50f03d61f4108d006ea759d91c95a85218`.
Runtime fingerprint: `589038bd2d7764b4e4f857ba350afe04208ddab9a43947c4ce73a2903ce8e83d`.
All **93 successful rows** verify content/mode/baseline/exclusions. The **12 failed
rows** are the unchanged oversized 64/128 MiB initial/incremental push limitation,
not successful transfers or tests silently omitted. Every measured return succeeds.

Medians from three independent ext4 datasets; family RSS is the simultaneous sampled
sum and max-process RSS is GNU time's separate high-water metric. All current return
rows pass the diagnostic 512 MiB family threshold; it excludes the controller and is
not a deployment SLA.

| Scenario / phase / lanes | Baseline wall → current ms | CPU ms baseline → current | Family MiB baseline → current | Max-process MiB baseline → current |
| --- | ---: | ---: | ---: | ---: |
| 4 × 16 MiB, return one file / 1 | 4378 → **983** | 4270 → **1000** | 483.3 → **93.2** | 402.8 → **76.6** |
| 4 × 16 MiB, return all / 1 | 15236 → **2698** | 15490 → **2740** | 749.3 → **117.6** | 666.2 → **96.0** |
| 4 × 16 MiB, return all / 2 | 17562 → **2774** | 34470 → **5240** | 1291.0 → **235.1** | 648.6 → **96.2** |
| 4 × 16 MiB, return all / 4 | 25144 → **2589** | 68510 → **8460** | 1971.3 → **469.6** | 635.5 → **96.3** |
| 1 × 64 MiB, return / 1 | failed → **2442** | failed → **2490** | failed → **99.8** | failed → **80.2** |
| 1 × 64 MiB, return / 4 | failed → **2418** | failed → **7390** | failed → **399.1** | failed → **80.5** |
| 1 × 128 MiB, return / 1 | failed → **4629** | failed → **4680** | failed → **115.0** | failed → **98.3** |
| 1 × 128 MiB, return / 4 | failed → **5243** | failed → **15540** | failed → **457.7** | failed → **99.9** |
| 2048 × 1 KiB, initial / 1 | 8398 → 10142 | 7920 → 9650 | 98.4 → 104.0 | 77.4 → 82.5 |
| 2048 × 1 KiB, unchanged-1 / 1 | 2854 → 3659 | 2660 → 3510 | 93.0 → 98.1 | 76.7 → 82.1 |
| 2048 × 1 KiB, unchanged-2 / 1 | 2829 → 3663 | 2650 → 3500 | 91.8 → 97.4 | 76.0 → 82.5 |
| 2048 × 1 KiB, push 20 files / 1 | 3005 → 3731 | 2850 → 3630 | 93.8 → 101.7 | 75.0 → 81.1 |
| 2048 × 1 KiB, pull 20 files / 1 | 3856 → 4850 | 3730 → 4750 | 94.1 → 104.2 | 75.1 → 83.0 |

One-file return max-process memory falls approximately **81%**, against both the
controlled Round 4 402.8 MiB median and Round 3's historical 422.7 MiB observation.
Strict content reads are **not removed**: Node still reads 112 MiB (64 MiB scan +
three 16 MiB guard/backup reads); Python reads 80 MiB. Payload throughput rises from
about 3.65 to 16.28 MiB/s for one-file return and 4.20 to 23.72 MiB/s for all four.
Four independent projects return 256 MiB in 2.589 s (about 98.88 MiB/s aggregate).
These are warm local-pipe observations, not network/device bandwidth promises.

Wire volume is nearly unchanged: the separate one-file profile records 22,370,249
baseline vs 22,391,825 current stdout bytes, and 270 vs 17,853 input bytes (acks included).
The largest **file-data** frame shrinks from 22,369,684 to **87,465 bytes**. Source
manifests remain their existing count-limited RPC representation (the small-file
manifest frame is 269,721 bytes); the 112 KiB stream-frame bound does not pretend that
all control/manifest frames have become chunks.

Small-file batching still uses **16 apply calls**, not 2,048; incremental push uses
one apply and incremental pull 20 bounded downloads. Stable-fd/stat/hash validation
makes strict small-file work about 21–30% slower than Round 4 here. That regression is
reported, not hidden by metadata-only scans. Compared with Round 3's original 96.76 s
pre-batching initial sample, the current 10.14 s still retains the major batching gain;
those historical samples are not a controlled significance test. No claim of universal
sync speedup or overall code/complexity shrinkage is made.

### Allocation attribution after streaming

The separate current profile's one-file Node peaks are **14.66 MiB heapUsed**, **2.47
MiB arrayBuffers**, **4.84 MiB external**; Python traced peak is **2.80 MiB**, process
RSS about **27.8 MiB**. Baseline Node heapUsed was 319.7 MiB and Python traced peak
71.0 MiB. In cumulative Inspector sampling, baseline one-file `indexOf` accounts for
5.15 GB of allocation churn; current has no sampled allocation attributed there and
**100.8 MB total** sampled allocation across all sites. Four-return totals change
from about 20.86 GB to **392.5 MB**. Zero at one sampled site is not proof of zero
allocation; cumulative allocation is not live RSS. Full profiles/checkpoints are
archived so the attribution is inspectable rather than inferred from readFile timing.

### Mounted Windows result, separately measured

The one-repeat mounted sample has **11/11 successful verified rows**. Baseline small
unchanged scan failed its existing remote timer; current reuses a verified directory
fd within a scan and revalidates the named parent, avoiding repeated full parent walks
without increasing that timer or accepting substituted links.

| /mnt/c phase | Baseline wall ms | Current wall ms | Current family MiB |
| --- | ---: | ---: | ---: |
| 4 × 16 MiB initial | 5116 | 5213 | 305.8 |
| 4 × 16 MiB unchanged-1 | 1585 | 1993 | 80.2 |
| 4 × 16 MiB unchanged-2 | 1649 | 1989 | 80.4 |
| 4 × 16 MiB incremental-push | 3402 | 3712 | 242.5 |
| 4 × 16 MiB incremental-pull | 6423 | 4075 | 93.3 |
| 4 × 16 MiB all-pull | 19868 | 10538 | 117.6 |
| 2048 × 1 KiB initial | 347804 | 353960 | 101.0 |
| 2048 × 1 KiB unchanged-1 | failed | 63309 | 103.2 |
| 2048 × 1 KiB unchanged-2 | not run after failure | 65242 | 103.8 |
| 2048 × 1 KiB incremental-push | not run after failure | 71187 | 104.1 |
| 2048 × 1 KiB incremental-pull | not run after failure | 73845 | 104.2 |

This mount is measured, not labelled unavailable, but it remains far slower for small
files. Native Windows Node/Python, actual SSH/cloud transports, paid persistence/billing,
WAN RTT throughput and backing-device I/O are **UNVERIFIED**. The single mount sample
is not pooled with three-repeat ext4 data. CPU/transport/process metrics and failures
remain in the indexed/raw evidence; no post-failure baseline rows are invented.

## Durable evidence and reproduction

- Readable indexed measurements: [ROUND5-SYNC-PERFORMANCE.json](verification/ROUND5-SYNC-PERFORMANCE.json).
  It preserves per-row metrics, processes, protocol/source counters, resource results,
  cache-scan rows and raw-report hashes. Large sampler/checkpoint arrays are omitted
  from this index only, with counts retained. **This file is committed and is the
  reproducible evidence a clone receives.**
- The raw archive `verification/ROUND5-RAW-EVIDENCE.tar.gz` (SHA-256
  `997377c00dd5e972b89f3148234a4f006b18246a6597c965606a0fe551a685d2`, 7,344,140 bytes)
  is **local-only evidence**. It is gitignored, is not in any clone, and is not part of
  the npm package. It holds the complete reports, process timelines, heap profiles,
  original runners and immutable before/after runtime copies from the recording host.
  No number in this document is derived from it, and no verification step requires it;
  treat any claim in it as unverified until reproduced by the commands below.
- Frozen Round 4/profile/mount report hashes are recorded in the index. The exact release
  matrix fingerprint above matches the recorded runtime, not a guessed Git revision.

Nothing above has to be extracted from the archive. The runner generates its own
fixture trees and deletes them again on exit, so **no dataset archive is needed**: it
`mkdtemp`s a scratch root under `--temp-dir`, seeds files from the deterministic
`datasets` table, and removes the whole root in `finally`. Only the immutable runtime
must be rebuilt, from the recorded commit, by copying exactly the four paths the
fingerprint covers (`dist/`, `assets/`, `bin/`, `package.json`) and freezing the copy:

```sh
# From the recorded commit; the toolchain is only needed to rebuild dist/.
npm run tools:install && npm run build
mkdir -p /var/tmp/reroute-reproduced-runtime
cp -r dist assets bin package.json /var/tmp/reroute-reproduced-runtime/
chmod -R a-w /var/tmp/reroute-reproduced-runtime

node scripts/benchmark-round5.mjs \
  --runtime /var/tmp/reroute-reproduced-runtime \
  --label current --repeats 3 --report-dir /var/tmp/reroute-round5-reproduced-current
node scripts/benchmark-hash-reuse.mjs \
  --runtime /var/tmp/reroute-reproduced-runtime \
  --files 4 --bytes 16777216 --repeats 3
```

A rebuild reproduces the method, not the recording host: unless the build is
byte-identical, the runtime fingerprint differs from the one recorded above, so the
absolute numbers are comparable only as a separate sample population. Repeat the same
copy step from the Round 4 baseline commit and pass that directory instead to rerun the
frozen baseline; the archived runners in the local-only raw archive remain a reference,
never the authority. Add
`--temp-dir /mnt/c` for the mounted source/worker trees. The benchmark invocations
themselves perform no daemon startup, provisioning, provider access, credential use or
cache drop; the `tools:install`/`build` step above is the only installation they need.
Benchmark timing remains descriptive on a shared host, not a formal statistical
isolation claim.

### Post-gate exact core rerun

After the last Python type-narrowing/build and final release gate, the exact frozen
runtime was `/var/tmp/reroute-round5-final-exact-eWb6tD`, fingerprint
`511f97ce72a211a50880be18f8888f60c108dded2fce86d56edfd0e15ca3c06c`.
`/var/tmp/reroute-round5-final-exact-report/report.json` completed **33/33** core
rows successfully. Its three-repeat medians confirm 951 ms / 93.2 MiB family RSS /
76.4 MiB max-process for one-file pull, 2,617 ms / 117.7 / 96.0 for four-file
pull, 9,838 ms for the 2,048-file initial push, and 4,798 ms for its 20-file pull.
The broader 64/128 MiB and 2/4-lane results above use the immediately preceding
release candidate; the last changes were Python type narrowing only and the final
release gate covered them. Raw long-matrix reports remain in the evidence archive;
this distinction avoids presenting a stale fingerprint as the final source tree.
