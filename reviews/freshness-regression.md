# Freshness and navigation regression

Supersedes the limited freshness/navigation coverage in the first foundation report. Code commit: `5b8ddbbfa0862eada9422d17d4e198619f4f84c4`. Built-file SHA-256: `540a15ce2e6eb49c138be39f499dc76370826f8d35104340b1d1613b41aacf1e`.

Independent review found that stale data lost its warning when navigating to detail. The defect was reproduced in actual sandboxed Linux Electron: the new detail-warning assertion timed out, and the agent opened the pre-fix screenshot showing the missing warning. Raw failing output/image are preserved in `runs/2026-10-02-freshness/`.

The fix shares freshness notices across overview/detail, shows last successful observation and failed-attempt time, adds per-claim stale labels, retains a header failure indicator, and keeps unknown terminal connectivity distinct from disconnected.

## Final verification

- `npm --cache /tmp/note-app-npm-cache run check`: TypeScript/build and 50 unit tests passed before the code-only commit, with the same application source
- `npm run test:electron`: passed on the exact committed build at `2026-10-02T17:28:42.821Z`
- Expanded actual Electron tests cover stale → detail → back, timestamp/claim labels, browser-history Back/Forward and search restoration, keyboard Enter activation and Space evidence expansion, unknown connectivity, hostile markup as literal text, and prior failure/retry/process cleanup paths
- Real child frame has no exposed IPC bridge; a separate actual Electron window using the same preload is rejected by the owning-window guard. Direct senderFrame mismatch is covered by unit tests. This does not claim an iframe with an artificially enabled IPC bridge was exercised
- Hostile text/unknown connectivity are injected only by the test's privileged main-process hook; no debug API or raw-file/command API was added to the product
- Agent opened final stale-detail and unknown/untrusted screenshots around 17:30 UTC; warning, successful/attempt times, per-claim labels and unknown badge were legible with no clipping. Hostile image markup remained visible text, not an image or executed code. The actual IPC-error screenshot was also inspected during the pre-commit run

One test-only navigation adjustment was required: the sample-options disclosure naturally closes when its view unmounts, so the test must reopen it after returning before selecting a scenario. This was not treated as a product failure or as evidence that an invisible control was usable.

Remaining scope limitations from the foundation report still apply. No canonical DAG state, acceptance criteria, real Orca/native macOS verification or publication status was changed by this fix.
