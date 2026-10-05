# Scoped read-model and context verification — Linux integration slice

Final tested code: `5e0ac92f1cddb1c59098873a8d140bcabc6bc103`, clean working tree. Actual Electron observation: `2026-10-02T20:05:10.306Z`. Combined built-file SHA-256: `fb27d04bbc84a079b312613be970822b564c94b526c2511990dcee964b575eac`. Exact per-file hashes, results and lifecycle observations are retained in `runs/2026-10-02-read-model/T-read-model-result.json`.

## Executed checks

```
DAG_QUERY_PYTHON=<trusted-python> DAG_QUERY_SCRIPT=<private-external-query> npm run check
NOTE_APP_PYTHON=<trusted-python> NOTE_APP_DAG_QUERY_PATH=<private-external-query> npm run test:electron:read-model
```

The final aggregate check passed **395 tests across 17 files**, TypeScript and production build. The private-query integration cases were enabled and passed, not skipped. The external script is pinned to SHA-256 `23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47`. It stays outside the repository; no redistribution permission is assumed. Runtime and harness versions are recorded in the existing environment baseline and lockfile.

## Actual Electron results

- The production CodeBurn reader ran only exact fixed status/quota argv against a synthetic executable. Both providers' usage projections retain unknown calendar bases. Quota-data availability is distinct from agent availability. Private/error-body fields are discarded.
- Malformed output and command failure remain failures, never zero usage. Timeout and cancellation clean owned subprocesses; a later fixed CodeBurn query succeeds.
- The actual pinned external DAG query processed 1,000 temporary synthetic tasks. External dependency declarations, undeclared versus unmet E2E and unverified commit references remain distinct. No testing, deployment or approval is inferred from status or references.
- Unchanged source bytes skip the query entirely; changed bytes cause one new query. Source content and mtime remain unchanged by the reader.
- Main-process IPC responded while the real Python query was running. Overlapping reads were rejected. Cancellation settles the request and retires that DAG reader; reuse fails closed. This is a responsiveness demonstration, not an accepted resource/latency budget or production load certification.
- Explicit selection of one task produced one context record and a **2,006-byte pack** from the 1,000-task read model. Unselected task content was absent; goal remained unknown without its document excerpt. No agent was invoked.
- Unknown/extra IPC input and a real foreign renderer were rejected. Sandbox/context isolation remain enabled, Node integration disabled.
- Final cleanup observed all 17 tracked subprocess PIDs as gone, twice. Temporary source snapshots and this run's synthetic fixture root were removed. Tracked Electron processes exited.

The implementation agent opened all ten final PNG screenshots at approximately 20:05:50 UTC. Scope warnings, partial coverage, missing goal, failure states, cache behavior and responsive/cancelled states are legible. Long structured results scroll. These are actual Electron integration-test views, not a finished production read-model screen.

## Failures found and resolved

Independent review reproduced two source-reader defects: atomic pathname replacement could refresh old cached data as current, and filesystem awaits could exceed the advertised timeout. Post-read pathname/inode checks and a response deadline with retained late-cleanup ownership fixed them. The two original repros were independently rerun; a 250 ms delayed read with a 20 ms deadline returned timeout in approximately 21 ms. Such a reader remains retired and must not be silently recreated in polling.

The first Electron run completed the feature scenarios but failed test-fixture cleanup with one tracked PID still present and zero snapshots. Its exact state was not captured, so it is not proven to have been a zombie. The test wrapper was changed to reap its Python child; cleanup now distinguishes exited from nonexecuting zombie/dead states instead of treating all existing PIDs as active. The final run observed all PIDs gone. The older failed run's synthetic fixture root is not claimed to have been removed; no broad temporary-directory cleanup was performed. Its failure log is retained.

## Status recommendations, not canonical DAG changes

- T-014: scoped external-query adapter implemented and Linux Electron integration verified on synthetic data. Real user-note configuration, native Mac behavior and comprehensive resource acceptance remain unverified.
- T-015: source/candidate/approval-preservation contracts implemented; in-memory only, not durable application storage.
- T-016: bounded pack/prompt and validation boundaries prepared. Actual restricted Orca agent transport and cost enforcement remain gated.
- T-017: stale-safe claim updates and no-change behavior tested. Fine-grained per-task invalidation remains partial: the current extractor uses the upstream DAG hash, so unrelated DAG edits conservatively invalidate selected task records. A versioned per-record provenance contract is needed before claiming only semantically affected summaries refresh.
- T-018/T-020: no real generated-summary accuracy or user readability approval is claimed.
- T-022/T-023: production UI/live read-model/summary integration remains pending.

No real CodeBurn account, real Orca agent, user vault, document/inbox archive, native Mac dialog or packaged application was exercised. Existing source/summary evidence and the separate publication lane do not silently modify the canonical Mac DAG.
