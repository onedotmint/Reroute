---
id: sync-performance-integrity
applies_to:
  - src/platform/file-stream.ts
  - src/sync/hash-cache.ts
  - src/sync/sync.ts
  - src/sync/artifacts.ts
  - src/providers/channel.ts
  - assets/worker.py
  - src/core/contracts.ts
  - src/core/coordinator.ts
  - src/config/config.ts
  - tests/integration/sync-streams.test.mjs
  - tests/integration/hash-cache.test.mjs
  - tests/integration/remote-hash-cache.test.mjs
---

# Transfer optimization must not authorize partial source

Bounded frames alone do not bound a return transfer: the consumer, conflict evidence
and local backup paths must also avoid accumulating whole files. A received file stays
in a private temporary file until its complete size/hash, planned metadata and confirmed
transport completion agree. Failure removes unverified temporaries and leaves source,
agreed baseline and pending-source recovery protections intact. Backpressure must follow
completed consumption, not mere frame receipt. Keep final expected-content checks after
backup and temporary-file preparation; cached scan hashes cannot replace those checks.

Reusing directory descriptors within a scan must still revalidate the named directory
before returning its manifest. An old opened inode surviving parent replacement is not
proof of the current path; never follow a substitute symlink to save path-check I/O.

# Hash reuse has a trust boundary

Full-content scans remain the default. Explicit metadata reuse is an optimization under
a documented filesystem/change-time assumption, not equivalent to reading every byte.
Unknown or coarse metadata and unsupported filesystems must fall back to full validation.
Do not persist unchecked cache hashes as source authority or reuse them across changed
runtime/root/generation identities or cold recovery. Lost cache means rehashing, not adopting the baseline;
failed reconciliation must discard reusable scan state. Watchers are not correctness
proof. Preserve a strict content-validation path for restores, suspicious metadata or
writers able to bypass normal filesystem change-time updates. The policy and limits
belong to [configuration](../../docs/CONFIGURATION.md#hash-validation-and-reuse).
