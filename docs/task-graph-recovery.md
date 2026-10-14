# Graph recovery and accessibility candidate (T064)

## Implemented scope

The complete-source graph distinguishes loading, empty source, no search match, no filter match, partial coverage, stale source, disconnection, denied authority, unsupported input, timeout, invalid response, calculation failure and generic read failure. Failure copy is selected from bounded error codes; raw exceptions or private paths are never rendered. Retry stays within the current project/source read and cannot publish a result from a superseded epoch.

Search counts, empty/partial/date-unavailable feedback, density fallback and meaningful relation counts expose live status semantics. True source SCCs have their own bounded disclosure, distinct from opposing group aggregate arrows. Each SCC's IDs are paged in batches of 20, and all SCCs remain reachable. This does not modify graph data or treat declared task status as verified execution.

Automatic source refresh, reconnect and background/resume preserve external keyboard focus. Filtering a previously focused card only moves focus when the disappearing card actually owns focus. Background/authority/source cancellation clears pointer drag state. New keyboard focus takes priority over a stationary hover on another node; actual subsequent hover remains usable.

Escape from a disappearing boundary chip, relation list or transient relation toolbar control returns focus to the anchor without reopening dismissed relation emphasis. Detail close preserves viewport and filter. If its node is hidden by the filter, one explicitly labelled temporary focus-return card is retained until blur; source/filter/viewport counts remain unchanged. Filtering, explicit navigation and source withdrawal remove this exception.

Relation text/markers use theme-aware semantic colors. Unrelated card text is no longer made translucent with whole-card opacity. Self-loop relationships count once in the total while exposing both predecessor and successor roles. Marker definitions follow each emphasized edge role.

## Evidence boundary

`tests/unit/task-graph-recovery.test.ts` adds 27 dedicated synthetic regression cases, running actual production Vue setup/templates in a custom host. Cases include repeated/late retries, empty/error states, live feedback, true cycles versus group aggregates, SCC pagination, background/resume, focus ownership, interrupted drag, repeated tooltip Escape/reopen, keyboard-versus-hover priority, disappearance focus restoration, self-loops and filter-hidden detail focus return.

The custom host uses mocked transport/layout lifecycle boundaries and does not establish browser pixels, native events, actual pointer capture, native Tab/Enter/Space, AX tree, screen-reader announcement timing, light/dark contrast, narrow/200% layout, native touch, performance or real-person usability. Approved reference images were inspected; exact implementation images remain blocked by the previously established environment Chromium socket restriction. No security settings were changed to bypass it.

Run the current candidate:

- `npx vitest run --root . tests/unit/task-graph-recovery.test.ts tests/unit/task-graph-overview-components.test.ts tests/unit/task-graph-navigation.test.ts tests/unit/task-graph-relations.test.ts --maxWorkers=2`
- `npm run typecheck`
- Final integration runs full unit/updater/build and authorized native gates separately

The isolated suite duplicated the existing custom-host harness to avoid changing an actively edited shared test file. It deliberately labels its evidence as non-native. Full production transport authorization continues to be checked by the separate IPC/layout/source/detail suites.

## T066 targeted validation-gap closure

The recovery suite now has 40 executable synthetic cases (13 added after T065). Added probes assert exact timeout/invalid-schema/invalid-result/worker-unavailable/layout-failed wording and successful retry, calculation failure during group projection, three SCCs in both directions with member-page and source reset, deferred followRelation resolve/reject after replacement with identical task IDs, no-match filter reset, and Escape from full-relations items with anchor/pane fallback. A controlled unconditional-origin-write mutant is rejected by both race probes; production source is restored unchanged. These are custom-host checks, not native event or visual acceptance. T066 artifacts record fresh aggregate verification on the updated candidate; T065 results remain historical evidence for the prior candidate.
