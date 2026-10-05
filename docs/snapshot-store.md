# Snapshot cache, polling and freshness preparation

Status: local Phase 1 T-010 preparation, not task/DAG completion. The parent owns real Electron lifecycle integration and its separate evidence. Existing decision and quality gates are not waived. This module does not turn on live Orca collection, access user notes, fetch remote data, or implement T-014 DAG parsing.

## Acceptance recorded before implementation

The assigned T-010 slice and information contract were read at 2026-10-02 17:39 UTC before writing this implementation. Acceptance criteria were preserved:

- Active polling uses a configured 15–30-second interval, default 20 seconds, with explicit manual refresh
- Hidden or inactive collection is paused and reactivation refreshes immediately, subject to settlement of an already-cancelled load
- Concurrent collection cannot overlap; cancellation/disposal invalidate late results
- Preserve the previous successful observation, coverage and source time after failures; initial failure is unknown, never successful emptiness
- Preserve partial/unknown host coverage, source freshness and explicit runtime-change failures
- New successful runtime identity replaces the entire old value; never merge identities across runtime restarts
- `lastOutputAt` remains output metadata and is never interpreted as an agent heartbeat
- Actual inactive-window polling reduction and reactivation freshness require a measured Electron integration result; deterministic unit tests alone do not fulfill that gate

Input byte hashes:

| Input | SHA-256 |
| --- | --- |
| Supplied `note-app-adapter-slices.md` | `161834a9287e911d7464532a0eb6c545127837108f985733abbc129f16f5fb79` |
| `specs/information-contract.md` | `6c62a77f03527b9f41f643371a1ea6d938ff6ba54e230236eb7ade0f82251aa9` |

## API and integration boundary

`src/collector/snapshot/index.ts` exports a UI-independent generic controller, an Orca adapter bridge and their types. Instantiate in trusted collector/main-process code. Inject an authorized, bounded, asynchronous loader; do not run this scheduler or parsing work in the renderer.

```ts
const store = createOrcaSnapshotStore({
  load: options => adapter.collect(options),
  intervalMs: 20_000,
  active: true,
  visible: window.isVisible(),
});
store.subscribe(state => publishSanitizedState(state));
await store.start();
// Trusted main-process lifecycle handlers:
store.setActivity({ visible: false });
store.setActivity({ visible: true });
await store.refresh();
store.dispose();
```

The caller owns actual window/app lifecycle wiring, authorization and narrow IPC publication. The module has no Electron, Vue, shell, filesystem, network, source-path discovery or DAG dependency. The bridge accepts an existing adapter's `collect()` function and never creates/reconnects an adapter. It forwards the AbortSignal unchanged.

Methods:

- `start()`: begin once; collect immediately if both active and visible. Construction alone performs no work and allocates no timer
- `refresh()`: manual attempt, including while hidden; also starts the controller. Simultaneous manual/poll requests share the same in-flight promise
- `setActivity({ active?, visible? })`: both flags must be true for background polling. Becoming hidden/inactive clears the timer and cancels/invalidate the current attempt. Becoming active/visible requests one immediate observation
- `cancel()`: cancel current work and queued requests. A later active poll may retry; use `dispose()` for permanent shutdown
- `getState()`: detached plain serializable snapshot; reading it does not collect or start a timer
- `subscribe(listener)`: state-change notifications, with an unsubscribe function. Subscribers receive separate detached objects; one subscriber's mutation/error cannot change another's data or stop collection
- `dispose()`: idempotent timer cleanup, abort, queued-request cancellation and subscriber cleanup. Late replies cannot change state. Calls to `start()`/`refresh()` after disposal resolve without loading

The injected `SnapshotClock` combines UTC `now()`, `setTimeout()` and `clearTimeout()`. The real default uses standard timers. Unit tests supply a deterministic clock; no test sleeps are used. Clock time must be finite and nondecreasing.

## Scheduling and cancellation

The configured interval is validated as an integer in `[15000, 30000]` milliseconds. After each attempt settles, the next background attempt is scheduled one interval later. Thus actual start-to-start spacing includes loader duration; slow/blocked reads cannot produce overlapping catch-up work. Manual refresh resets that deadline. The default stale threshold is twice the interval, 40 seconds, and can be configured independently with integer `staleAfterMs` in `[1, 2147483647]` milliseconds. The upper limit avoids native timer overflow/immediate-loop behavior.

Only one asynchronous loader is outstanding at a time. Alongside the polling timer, at most one active/visible freshness-expiry timer delivers the transition from current to stale. It survives an outstanding loader so a slow/hung poll cannot leave subscribers showing current forever. It never starts a load, fires once at the source-age boundary, and is cleared/replaced on newer observation, failure, source-stale state, hiding, inactivity or disposal. Already-stale observations do not rearm it. Hidden/inactive state has no background timers. No renderer timer, heartbeat, render-tick churn, busy polling, `setInterval` backlog or concurrent retry loop is introduced.

Cancellation aborts the signal and invalidates that attempt immediately. A loader that ignores AbortSignal cannot publish a late success or error. If reactivation occurs before such a loader settles, one resume/manual request is queued; it starts only after settlement, preserving no-overlap even with an uncooperative loader. Becoming hidden again removes that queued resume. The loader remains responsible for bounded timeouts/termination; the store does not falsely claim that abort stopped an underlying subprocess. An indefinitely uncooperative loader necessarily prevents another load. The Orca runner separately supplies bounded command/process cleanup.

Hidden data can age into stale without any wake-up timer: `getState()` derives age from the injected current time. Active/visible subscribers receive the one-shot age-expiry notification, in addition to controller transition notifications; a consumer returning to view must use the current state. Reactivation requests a new observation immediately, or immediately after the cancelled in-flight attempt settles. Repeated activity updates with unchanged flags are no-ops, preventing reflective subscriber recursion. Changes that remain paused preserve explicitly requested hidden manual work. Repeated cancellation with no valid attempt/queued request is also a no-op.

## Retention, coverage and identity

State separates:

- `status: unknown | observed`, `value` and `coverage`; never-success has null value/coverage and unknown freshness
- `observedAt`: retained source observation time, canonical UTC ISO string with milliseconds; never render time or failed attempt time
- `lastSuccessAt`: time the controller accepted a usable success/unchanged result
- `lastAttempt`: independent ID, reason, attempted/completed times, outcome and safe error
- `freshness: unknown | current | stale`: source-stale, age, failed/cancelled refresh or disposed state can mark retained data stale
- `revision`: increments for accepted full values, not unchanged checks
- `runtimeChange`: most recent accepted whole-value runtime transition with its source time
- Lifecycle flags and `nextPollAt` for diagnostics/measurement

A failed attempt does not overwrite the previous value, coverage, runtime, hash or observation/success times. Its error is explicit in `lastAttempt`. A successfully observed complete empty response remains historical empty after failure, marked stale; it is not evidence of current emptiness. Partial/unknown success is usable evidence about observed records and does not imply completeness.

The Orca bridge preserves each query's exact coverage and exposes a convenience combined `state` and `complete`. Any partial scope yields combined partial; otherwise any unknown scope yields unknown. Detailed unknown scopes remain visible even when another scope is partial. Unknown project pagination, null totals, truncation and omitted host IDs are never replaced with zero or complete. An adapter failure at any query retains the complete prior observation, including all its partial/unknown metadata, rather than merging newly collected fragments.

A failure of kind `runtime_changed` remains that explicit adapter error. There is no immediate reconnect/retry and no invented successful runtime transition. Future scheduled/manual attempts can retry the same injected loader. A later fully successful new runtime replaces all old value records atomically, including reused record IDs, and records `runtimeChange`. Nothing merges by worktree ID, path, project, host or old runtime identity. Observations moving backwards in time within the same runtime are rejected; a whole new runtime can have a different source time, with age-derived stale status still applied.

The generic payload is treated as opaque normalized data. It does not derive heartbeat, agent activity, DAG progress, tested/deployed state, note identity or summary claims. In particular `lastOutputAt` is copied unchanged. Domain/display consumers must propagate envelope staleness to affected claim presentation; this controller does not rewrite unknown payload-specific claim fields or provenance.

## Cache scope and plain-data safety

The cache is in-memory last-usable-observation retention. No disk persistence or actual DAG parse cache is claimed. Orca collection currently supplies full successes with `sourceHash: null`; it does not pretend the CLI returns a content hash.

The generic loader may return `kind: 'unchanged'` only after positively checking that the current value remains the same. It must provide a nonempty source hash matching the retained hash and runtime, a new source observation time, and explicit current coverage. That assertion reuses the internal cached value without cloning/replacing it or increasing revision; metadata can still change. No prior cache, a changed hash or a changed runtime is an `invalid_result` failure, retaining the previous state as stale. The store does not itself hash, compare or parse files, nor infer no-change from missing data. Actual T-014 hash/mtime parse caching remains unimplemented.

Accepted values, coverage and loader errors must be finite, serializable plain trees without cycles, custom prototypes or functions. Metadata is checked for runtime identity, canonical timestamps, no future observation and valid freshness/hash. Failures with invalid results or thrown/rejected loaders use constant safe store diagnostics rather than exception bodies/stacks. The loader must already schema-validate/allowlist and size-bound source content and sanitize its explicit failure object; the generic store is not an untrusted wire-format validator. Orca supplies that bounded allowlist separately.

Values are copied on full acceptance and every public state delivery/read. Returned types are deep readonly, while runtime objects are detached normal objects rather than frozen prototypes, suitable for IPC/Vue. Cloning and plain-tree validation are bounded by caller/adapter input limits and performed in the collector/main boundary. This is not a worker-based large-DAG parsing solution or a main-thread responsiveness performance claim.

## Verification and source version

Observed/report time: 2026-10-02 18:00 UTC on dot cloud Linux. The test runner printed its executor-local `02:59` clock; report time uses the conversation UTC clock. Commands from repository root, all exit 0:

```sh
npm run typecheck
./node_modules/.bin/vitest run --root . tests/unit/snapshot-store.test.ts
npm test
npm run build
```

Final output summaries:

```text
npm run typecheck: vue-tsc --noEmit, exit 0
Snapshot focused: Test Files 1 passed (1), Tests 63 passed (63), Duration 291ms
Full unit run: Test Files 10 passed (10), Tests 255 passed (255), Duration 5.53s
Build: 193 modules transformed; built in 1.20s; exit 0
```

An earlier focused strict TypeScript invocation exposed generic inference of optional coverage in the Orca bridge. Explicit bridge generic parameters corrected it; subsequent strict and full TypeScript runs passed. The initial 51-test pass was strengthened with a noncanonical timestamp case and a post-disposal start regression. Independent review then found that stalled polling did not notify subscribers when cached data aged stale, and redundant paused activity updates could recursively notify a reflective subscriber or erase explicitly queued hidden manual work. Those findings were corrected with the one-shot active expiry timer and idempotent/transition-aware activity handling. Ten additional timer-boundary, expiry-cleanup, reflective-subscriber and hidden-manual regressions bring the final focused count to 63. The earlier 53-test/244-test results are superseded. No acceptance criterion was removed or relaxed.

Deterministic test evidence covers exact 15/20/30-second boundaries, initially paused state, hidden/inactive no-timer periods, stalled-loader subscriber expiry at exactly 40 seconds, new-source expiry rescheduling, one-shot/paused/disposed expiry cleanup, resume, manual/poll collisions, ignored cancellation, deferred resume, cancel/dispose, detached/reflective subscribers, idempotent cancellation, queued hidden manual preservation across redundant paused updates, empty versus never-success, partial/unknown retention, source aging/staleness, separate attempt/success times, whole-runtime replacement, explicit `runtime_changed`, hash-based unchanged acceptance/rejection, backwards/future timestamps and safe errors.

Source SHA-256 manifest for that final verification (documentation excluded to avoid self-reference):

```text
fb9ad3c9d5e249ac372ba34ea108cfcac511bcb2d3df87c3211f44983297e368  src/collector/snapshot/index.ts
6055b974990d2edf6ea442c3c5ba0354046a2496f8741f56b3530d27d1c2679a  src/collector/snapshot/orca.ts
b124e56d593fd3a48cf3002394c7a95ff03753780aa31b5760a2d5a473936360  src/collector/snapshot/store.ts
dde7ec2a24d9cd9e3ecfa45100296fb3d493924a0729cd33e9198a0a06c25df5  src/collector/snapshot/types.ts
b05c1983fab7b7de0c1c4ae727afa56d4fd304ba5b9b7085b5f8e9c519965366  tests/unit/snapshot-store.test.ts
```

Independent read-only recheck at 2026-10-02 18:02 UTC confirmed both reported defects resolved against the source hashes above. Its combined reproduction verified stale subscriber delivery at 41 seconds while the poll remained pending, reflective activity setters, queued hidden manual refresh preservation across duplicate hidden and additional inactive updates, and zero paused timers. The focused 63-test rerun passed; no further actionable defect was reported within that fix scope.

The full unit/build result is a point-in-time regression check while other collector slices are under development, not a guarantee for later changed bytes. No source commit/push or DAG update was made by this slice. Real Electron active/hidden-window timing and source version capture are parent-owned in the test-only polling harness. This unit-only module creates no UI or duplicate screenshot. Real Orca, actual user data, packaged/macOS behavior, renderer claim-staleness wiring and T-014 worker/parse-cache performance remain unverified by these results. Task completion still requires the recorded integration/quality/decision gates.

## Final actual Electron evidence

See `reviews/collector-verification.md` for the exact clean code commit, final real Linux Electron fixture-integration commands/results, screenshots actually inspected and remaining scope limits. This is not real Orca or native Mac verification.
