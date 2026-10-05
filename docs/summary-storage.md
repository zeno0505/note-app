# Local summary cache foundation (T-015)

This main-process-only module persists inert summary state into an explicitly
supplied, existing application-cache directory. It does not discover a userData
path, read/write a vault, invoke an agent, schedule work, or expose renderer IPC.
The Electron host owns selection of a private cache directory, source refresh,
approval event authentication, and UI failure reporting. Tests use synthetic
temporary directories exclusively.

## Interfaces

- `store.exportState()` emits `SummaryStoreState` v1
- `parseSummaryStoreState(unknown)` validates an inert local DTO
- `restoreSummaryStoreFromLocalCache(state, currentPack)` restores historical
  state, assigns a fresh runtime incarnation (also bound to approval events), invalidates old request tickets, then recomputes freshness against the
  host's freshly collected context. It never calls `approve()`
- `createLocalSummaryCache({ directory, codec: summaryCacheCodec })` provides
  `read(signal?)` and `write(payload, expectedRevision, signal?)`
- The local-only payload is `{ state, projectionContexts }`. Projection manifests
  retain upstream identifiers/hashes and immutable artifact bytes, validated by
  `validateProjectionContext`. Every included projection record must have a
  scope-matching local manifest. Unrelated-scope, duplicate and unused manifests
  are rejected. The host retains manifests for historical bases
- A read returns `{revision, payload}` or `null` only for a missing file.
  Corrupt, unsupported, oversized, unsafe and inaccessible caches throw. The host
  must surface that outcome and retain any last good in-memory state; never
  convert it into an empty successful summary
- A write requires `expectedRevision: null` for initial creation, or the exact
  revision read previously. Failures before commit retain the prior bytes

## Exact historical evidence

The state includes version, current pack hash, deduplicated context packs,
candidate, prior approved summary, claim-to-pack basis mappings for both, and
last failure. The current store preserves its latest prior approved summary;
this is not an unlimited approval audit log. An approved summary remains a
historical approval when its evidence changes or disappears. Claim freshness is
recomputed, never loaded as an authority-bearing flag.

Incremental refresh retains each unchanged claim's exact original context pack,
including original observation times. New claims bind their actual response
pack. Export never rewrites evidence timestamps to make retained citations
validate. No pending request or execution permission is persisted.

Parsing checks exact fields, inert dense data, canonical timestamps, candidate
hashes, scope/schema/pack bindings, source/record/exclusion linkage, chronology,
claim coverage, bounds, and per-claim evidence using the original strict response
parser. Rehashed malformed context structure is rejected. Context pack usage is
rechecked against serialized bytes. The unresolved-dependency set must match dependencies proven by retained records.
A pack with excluded records whose missing dependencies cannot be reconstructed
is rejected on persistence rather than restoring a broader retrieval allowlist.
This conservative unsupported case preserves the last good cache and requires
host recollection; no evidence is invented.

Local SHA-256 hashes establish consistency, not user identity or authenticity.
Anyone able to replace the private cache can recompute them. Neither this codec
nor restore is an import endpoint: do not expose it to model output, documents,
renderer data, downloaded caches, or arbitrary third-party JSON. New model output
still enters `parseSummaryResponse`, which cannot self-approve. Host UI approval
remains separate and must represent an actual user event. Summary approval never
approves executing a proposal.

The projection manifest stays local. Only intentionally constructed context
packs belong in prompts; never serialize the cache payload or local provenance
manifest into a prompt or renderer message.

## Filesystem and concurrency

The fixed destination is `summary-cache-v1.json`. A canonical absolute directory
is required; all ancestors must be real directories, never symlinks. Reads use
no-follow, bounded regular-file reads and reject hard-linked cache files. Writes
use an exclusive `.summary-cache.lock`, unique adjacent 0600 temporary files,
64 KiB chunks, file fsync, and atomic rename. Directory identities and temporary
inode identity are rechecked before rename. Only matching files created by the
current invocation are removed during cleanup. No wildcard cleanup, recursive
removal, automatic stale-lock takeover or arbitrary user-specified filename is
provided. Stale locks fail closed and require explicit host/operator recovery
with all writers stopped; the module does not delete them automatically.

All writers must use this adapter/lock. Revision comparison rejects stale writes
and malformed existing state blocks overwrite. This assumes a private main-owned
directory without a hostile concurrent filesystem actor; portable Node path
checks do not provide an OS directory-handle sandbox against adversarial ancestor
swaps. A read racing a successful rename may return the complete prior version;
its revision makes any subsequent stale write fail.

Bounds: 4 MiB file, 3 MiB summary-state DTO, 97 distinct packs (current plus up to
48 candidate and 48 approved claim bases), 48 claims per summary, and existing
128 KiB context/response bounds. Filesystem calls are asynchronous, byte-bounded
and sequential; this does not guarantee a deadline for a stalled kernel I/O.

Cancellation is checked before read/write chunks and immediately before rename.
Pre-commit cancellation cleans owned temporary files and preserves old bytes.
Once rename starts, it is the commit point: the operation waits for its actual
result and returns committed success even if cancellation arrives while it runs.
A post-commit cleanup failure uses the explicit `committed-cleanup-failed` error with `committedRevision`;
the host must read the committed revision before attempting another write.
There is no timeout `Promise.race`, false rollback claim, or late deletion of the
committed file. A filesystem error is surfaced, not retried through a new writer.

The guarantee is atomic replacement and process-restart persistence on a normal
local filesystem. The containing directory is not fsynced: this is **not** a
power-loss durability or hardware-failure recovery guarantee. Crash leftovers
fail closed; the module never promotes an orphan temporary file automatically.

## Verification

`npx vitest run --root . tests/unit/summary-storage.test.ts tests/unit/summary-claims.test.ts`

Synthetic tests cover restart readback, changed/deleted evidence, exact retained
incremental bases, invalid refresh preservation, malformed/version/size/integrity
failures, stale revision, concurrent writer exclusion, partial write failure,
pre-commit cancellation, cancellation after rename begins, symlink rejection,
private provenance separation and no arbitrary stale-lock/temporary-file cleanup.
Electron wiring and real application UI adoption are separate integration work.
