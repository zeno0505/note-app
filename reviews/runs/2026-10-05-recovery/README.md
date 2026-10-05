# Fresh Linux recovery evidence

All files here are synthetic app/test evidence, never real notes or model output. The nine-suite desktop summary gives exact start/finish times, source/build identities and assertions. Raw successful result JSONs are retained unchanged; `visual-review.json` records the separate screenshot inspection. `files.json` binds the exact evidence bytes.

- Production source: `24664a99cac692aa20abb0d57ee2f6a7d4e0a96c`
- Corrected privacy harness: `c63708b6ca6ec64bb89e9bf31278bd590ce8e58b`; production source bytes unchanged
- Latest local check at `16d40d9`: 721 tests, zero skips; typecheck and production build passed. The earlier `c63708b` log is retained separately
- Nine actual Electron suites passed: app, collectors, polling, summary, read-model, cache, live, Phase1 and registered excerpts
- Separate actual Electron sandbox harness passed; no sandbox relaxation

## Screenshots

- [Overview](T-007-overview.png)
- [800-pixel layout](T-007-narrow.png)
- [Persisted approved summary](T-phase1-approved-local-cache.png)
- [Exact registered excerpt and provenance](T-excerpts-production-bounded-preview.png)
- [Changed slice against saved checkpoint](T-excerpts-saved-checkpoint-changed-slice.png)
- [Stale approval blocked, prior approval retained](T-excerpts-fresh-source-blocks-stale-approval.png)

The first excerpt test attempt incorrectly prohibited a registered target path in the separate note-link selector. The corrected test allows only that exact option text, checks all remaining DOM text/attributes, rejects unselected source bodies globally, checks every emitted summary DTO and guards actual synthetic prompts. Phase1 and excerpts then passed again. This was a test-boundary correction; no production change was required. Failed raw evidence stays outside this public evidence set.

The three private-query unit cases ran locally with the originally supplied pinned external query, stored outside this repository. GitHub CI deliberately skips them when the private tool is unavailable. Synthetic approval clicks are automation, not real user approvals. Real terminal result fields, real model quality and macOS/package acceptance remain unverified.

## Focused same-ID refresh integration probe

The [exact executed external probe](same-id-refresh/same-id-refresh-probe.mjs) and [result](same-id-refresh/same-id-refresh-result.json) establish actual production-UI prepared and waiting refresh behavior: the same workstream/DAG and active ticket remained visible, real public refresh IPC ran all four synthetic collection queries, no extra summary run or premature cache write occurred, and the original run completed to one saved candidate. The three [probe screenshots and identity files](same-id-refresh/) were visually inspected. Its original cloud evidence path is intentionally retained to preserve the executed script hash; reproduction needs an equivalent external evidence directory. Pending-RPC timing remains unit-only.

## CI deadline-test stabilization

One intermediate CI run exposed a pre-existing 40 ms setup deadline in the atomic-rename test. Under load, candidate persistence could time out before approval, leaving the test waiting for a rename that never began. A deliberate 100 ms setup delay reproduced that failure. Test-only commit `16d40d9` uses normal setup deadlines, asserts an approvable saved candidate and advances a controlled timer only after approval reaches rename. It also handles early rejection immediately and verifies unchanged precommit bytes, late commit, monotonic sequence and retired-ticket rejection. All 46 workflow tests, 20 focused repetitions and the final 721-test aggregate passed. Production deadlines and source bytes were unchanged. See [aggregate result](aggregate-result.json).
