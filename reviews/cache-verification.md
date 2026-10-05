# Local summary cache — final slice verification

Code `b18742a9dcf472c5eedf00e1b8ecdd677dda1a87`, clean working tree. Final actual Electron cache run passed at `2026-10-02T20:47:15.098Z`; existing summary-contract Electron regression passed at `20:47:16.398Z`. Both recorded build hash `9967be62a964c18d2aae76d3c0df119ff15b25754baa710e5a5f2814f9a1834b`.

Final aggregate check passed **431 tests across 19 files**, TypeScript and production build. The three optional tests using the private external DAG query were enabled and passed. Commands:

```
DAG_QUERY_PYTHON=<trusted-python> DAG_QUERY_SCRIPT=<private-external-query> npm run check
npm run test:electron:cache
npm run test:electron:summary
```

## Verified behavior

- Explicit state export/restore preserves candidate, historical approval and each retained claim's exact original context basis, including observation times
- Fresh runtime incarnation binds requests and approval events. Two restores of the same cache cannot accept each other's response or approval events
- Strict parsing rejects rehashed malformed metadata, impossible historical references and retrieval allowlists, unrelated/local-manifest mismatches, oversized data and invalid merged chronology
- Atomic revision-guarded writes preserve prior bytes on pre-commit failure. Locks are exclusive and never automatically taken over. Symlink/cache-path guards reject unsafe paths
- A successful rename followed by failed cleanup is reported as `committed-cleanup-failed` with `committedRevision`; readback confirms the actual revision. Metadata errors are not silently treated as a missing lock
- Actual Electron saved a synthetic approved summary, closed all tracked processes, started a second Electron process, and restored the same historical approval/hash without invoking `approve()` in the reopened phase
- Changed source evidence made three approved claims stale while historical text remained intact. Malformed, unsupported, oversized, stale-revision, symlink and deterministic pre-aborted-write flows remained explicit failures; prior good data was preserved
- Narrow scenario IPC rejected unexpected arguments and a real foreign renderer. Sandbox/context isolation remained enabled and Node integration disabled
- All four tracked processes from each launch exited before the next phase/end. The owned temporary cache root was removed

The implementation agent opened all four final cache screenshots at approximately 20:47:50 UTC. Historical/synthetic approval warnings, restart restoration, stale evidence and failure boundaries were legible. These are integration-test screens, not a completed production persistence UI. The summary regression was automated and is logged separately; its screenshots were not newly claimed as reviewed in this final run.

## Review findings resolved

Independent review and additional reproductions found malformed rehashed metadata acceptance, merged-claim chronology/size gaps, oversized pre-parse work, cross-incarnation ticket/approval replay, lock-handle cleanup gaps and ambiguous post-commit failure reporting. These were fixed before the final commit and regression run. The last two added tests verify cleanup EIO/EACCES do not masquerade as a missing file. Focused cache/claim tests passed 49/49 after those changes.

## Limits

This guarantees atomic replacement and normal process-restart persistence on a trusted main-owned local filesystem. The containing directory is not fsynced; power-loss durability, hardware recovery and adversarial concurrent ancestor replacement are not certified. Filesystem calls are asynchronous and byte-bounded but do not have a guaranteed kernel-I/O deadline. Cancellation after rename begins cannot promise rollback. Actual Electron covered pre-aborted cancellation; mid-write/post-rename timing cases are unit-tested, not a GUI timing-race claim.

Hashes establish integrity, not the identity of the person who approved a summary. Cache restore is not a model/document/renderer import endpoint and does not approve executing proposals. Stale locks require explicit host/operator recovery. Some budget-excluded missing-dependency provenance cannot be reconstructed safely and is rejected for persistence rather than expanding retrieval scope.

T-015 now has a tested disk-backed host module and explicit restoration contract. Production settings/path ownership, UI integration and actual user approval flow remain unfinished. T-016 live restricted Orca transport, real CodeBurn data, real summary accuracy/readability, note-link operations, canonical Mac DAG synchronization and native/package Mac verification remain pending. No real userData, vault, provider, remote API or credentials were used.
