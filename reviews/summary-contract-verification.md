# Bounded summary contract verification — partial Phase 1

Code: `cf13ac7913da459117a945bbeec787b3921fa375` (summary implementation `ca87ed8`, followed by test-only foreign-renderer preload correction). Linux cloud Electron development harness; synthetic sources and synthetic approval events only. Private DAG adapter work was untracked during this run and was not imported by this harness.

## Verified

- `npm run check`: 375 passed, 3 explicitly skipped external-private-query tests; typecheck and build passed. This aggregate ran before the test-only foreign-window correction. Exact log retained below. Separately, the external-query worker executed all 23 adapter tests with the pinned private query on synthetic DAGs; subsequent independent review found two adapter issues, so T-014 is not complete.
- `npm run test:electron:summary`: passed at `2026-10-02T19:51:17.175Z` on the exact code commit above. Build hashes and working-tree state are in `runs/2026-10-02-summary/T-summary-result.json`.
- Real Electron buttons exercised context selection, hostile text as inert data, complete prompt budget rejection, candidate/approval/stale preservation, late request and context-version rejection, excluded-source/quote rejection, and advisory provider choice with unknown or reached user budgets.
- Unknown/missing/extra IPC arguments and a real foreign renderer are rejected. Sandboxing and context isolation are enabled; Node integration is disabled. Tracked Electron processes exited.
- The implementation agent opened all six final PNGs at approximately 19:51:50 UTC. Status labels, synthetic-data/approval warnings, stale/current distinctions and unknown-budget wording are legible; hostile HTML appears as text. Long structured results use visible scrolling areas. These are contract-test views, not completed production summary screens.

The first Electron attempt exercised the six scenarios but failed the foreign-window probe because its preload path was not explicit. This is not counted as a pass. The corrected test uses the actual built preload and local fixture entry; the final rerun passed.

## Scope and remaining work

T-015 and T-017 have tested in-memory source/claim and stale-safe incremental contracts. They are not durable on-disk storage or end-to-end project summarization. T-016 has bounded context/prompt preparation and candidate validation; actual restricted Orca transport, real agent invocation, actual provider cost/capture enforcement and cancellation are not verified. CodeBurn projection uses synthetic subprocesses in unit tests; the budget choice view tests the advisory policy, not a live local CodeBurn installation.

Schema/citation checks cannot establish complete semantic truth. Explicit approval must come from a trusted separate user event; model text cannot approve itself. User readability approval, canonical Mac DAG synchronization, native macOS behavior and final application packaging remain pending.

Evidence: `runs/2026-10-02-summary/` contains six opened screenshots, raw check/Electron logs and exact result JSON. No private project data or external query script is included.
