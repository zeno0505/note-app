# Production read-only integration checkpoint

Actual Linux Electron production-window run passed at
`2026-10-03T06:04:22.892Z`. Built-file manifest hash:
`ea60b9297d6d4bbac4bdd6337a83445f469728910c166bef78c702cfc2540ba2`.
This checkpoint follows base `54ea9f94ffcc5bc02ac4fb779ffc85ef900234c8`.
The exact pre-commit working tree and per-file hashes are in the result manifest.

## Executed verification

- Full `npm run check`, with approved private query integration configured: **514 passed across 23 test files**, no skipped tests; typecheck and production build passed
- Six Mac-affected suites under a deliberately symlinked Linux TMPDIR: 228 passed, three optional private-query cases skipped in that earlier focused run
- Actual production Electron demo regression passed; six screenshots visually opened
- Actual `test:electron:live`: 11 check groups, 12 screenshots, no renderer exceptions
- All 95 tracked synthetic CLI/Python subprocesses gone; all tracked Electron processes exited; temporary DAG snapshots and owned fixture root removed
- Independent review rechecked runtime/config/startup/renderer boundary fixes and found no outstanding material issue in this checkpoint

The live test uses actual synthetic Orca/CodeBurn child processes, temporary
synthetic notes, and the genuine externally supplied pinned DAG query. It is not
real Mac/source/provider coverage. It calls no model and performs no actual user
summary approval. Its trusted cache seed has six fictional candidate claims and
six fictional historical-approved claims.

## Product behavior observed

- Explicit configured-but-disconnected startup performs no collection
- Exact argument arrays work at executable and fixture paths containing spaces
- Empty branch/null project survives all four Orca reads and joins; identity is not invented
- Shared canonical DAG is deduplicated; 240 tasks are counted and 200 displayed
- Independent usage/quota reads retain unavailable quota and unknown agent availability
- Unchanged DAG skips query; note bytes, link metadata and historical cache bytes stay unchanged
- Failed Orca refresh retains prior content/time; successful empty data remains distinct
- Disconnect cancels a hanging child; repeated actions coalesce; reconnect recovers
- New zero-argument channels reject 25 malformed payloads and five real foreign-window invocations
- Sandbox/context isolation remain enabled; Node absent in renderer; child-frame bridge, network fetch, new windows and webviews stay blocked
- Reopened product restores historical candidate/approval views; source changes make claims stale; failed DAG refresh preserves history with unknown freshness
- Invalid startup configuration stays blocked without launching a subprocess

## Review corrections included

The parser exception is branch-only. Production cache path and process timeout
checks were not relaxed to make Mac fixture tests pass. Trusted test roots now
canonicalize system temporary aliases; timing tests separate readiness from the
operation timeout and retain ungated timeout-before-readiness regressions.

Production startup/cache response deadlines retain late cleanup ownership.
Interrupted cache and metadata readers retire rather than accumulating unsettled
filesystem calls. Selection-remap failure retains historical claims. Final DAG
history is bounded to eight, task display to 200, status categories to 12,
references to eight, overview cards to batches of 40. Omission counts are visible.
These are response/lifetime bounds, not OS-level kernel cancellation guarantees.

## Visual review and failure history

All 12 final live PNGs listed in `T-live-result.json` were opened and inspected,
including narrow, empty, invalid, historical, stale and DAG-failure states. No
overlap, clipped controls or horizontal overflow was found in captured viewports.
Large expanded task details can push summaries far down; improving that hierarchy
belongs in the next summary-journey increment.

The first live run stopped on a stale test selector for the updated unknown-branch
label. It is retained as a failed attempt, not counted as a product pass. The exact
label was corrected and the entire live harness reran successfully.

Evidence remains in `reviews/evidence/`: `live-final-check.log`,
`live-demo-regression.log`, `live-electron.log`, `T-live-result.json`, the listed
PNGs and preserved first-attempt failure. No public upload/GitHub call occurred.

## Outcome limit

**Phase 1 is still incomplete.** Live summary generation, new candidate review
and approval/save flow, missing-note proposal/setup, real-source summary accuracy,
and updated Mac/native acceptance remain separate. See
[the outcome checklist](phase1-outcome-status.md). This checkpoint is the tested
read-only integration baseline for continuing those authorized core flows.
