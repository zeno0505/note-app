# Direct graph relations and complete task details (T063)

## Production behavior

The continuous canvas keeps its existing complete-source geometry. Hover or keyboard focus highlights only direct predecessor/successor nodes and edges. Predecessor, successor and dual-role connections have separate role styling; arrowheads retain source direction and node descriptions include relation roles. Counts and an optional complete, paginated relation list supplement the diagram. Hover/focus never selects a task or opens detail. Explicit button activation pins selection and requests detail.

Boundary relation chips identify the task, predecessor/successor role and actual endpoint context. Viewport exclusion has geometric left/right/up/down direction and depth. Filter-hidden, other-group and unresolved endpoints remain distinct; unresolved references are explanations rather than invented navigation nodes or edges. All boundary relations are available through six-chip pages; the full direct-relation list has 20-item pages. Repeated source declarations do not inflate unique edge counts, and nodes with both roles preserve both.

Chip activation reveals and focuses the actual full-source node, resets an excluding filter when necessary, and does not reopen remembered target-group detail. A return control restores prior grouping, group, zoom, filter and scroll. Detail close returns focus with `preventScroll` without centering, changing zoom or removing the current filter. If that task is now filter-hidden, a temporary, explicitly labelled focus-return card is retained outside the filter; viewport/filter counts remain unchanged, and the exception is cleared when focus leaves or navigation/filter/source changes. Drag completion or pointer cancellation is not interpreted as a task click. Escape dismisses transient relationship presentation without deleting pinned selection.

## Full-source detail admission

Graph selection exclusively calls `readTaskGraphDetail`, not the legacy 1,000-task / 8-reference display projection. The existing task interpretation, verification popover and evidence viewer receive the verified selected task identity. A full-source task outside the old display range is actionable. Failure is explicit; no legacy detail substitution occurs.

The main service uses the existing authorized full-source read path. Requests, source revision and returned data are bounded and validated; current project/DAG/session/source hash/revision must match. Reads share graph cancellation, capacity and timeout protections. The renderer validates the response again, rechecks the current session, and checks selection generation before publication or focus. Source, authority, selected task, active view, visibility and unmount changes cancel or invalidate pending reads.

The response carries complete admitted dependencies, commit and E2E references with zero legacy display truncation. Existing upstream unsupported-field/normalization omissions remain explicit. Oversized or unsupported results fail closed. Detail dependencies use 20-item pages with the exact total. Declared status and policy interpretation remain separate from execution verification; `done` does not imply tests passed. Existing evidence document expansion and return are preserved.

## Evidence and remaining limits

The actual approved 07 hover, 02 detail and 06 overview images were inspected before implementation. Tests execute production Vue templates/setup using synthetic sources and a custom renderer; helper and IPC/runtime tests supplement this. They do not establish actual browser layout, native pointer/focus behavior, pixels or Mac acceptance.

The established Chromium socket restriction remains unresolved; no security bypass or new browser attempt was used. Native pixel comparison, narrow/200% and actual light/dark rendering still require the final integration gate. Related T064 recovery/accessibility changes may update the same workspace component and must be included in the final candidate fingerprint.

Source-level visual differences for review:

- Boundary chips occupy a bounded overlay stack with six-item pagination rather than a single reference chip; dense views also expose a complete textual relation list
- The continuous canvas remains in place when detail opens, as required by the implementation plan; the older isolated six-node focus composition is not substituted for normal navigation
- Existing app shell, detail/evidence controls and full-source diagnostics remain present; no pixel-equivalence claim is made
- Existing explicit rendering-density safeguards remain in effect. Undrawn paths are disclosed; complete relations remain reachable by the paginated list

Focused checks use the locally installed test and compiler executables, with no package install or network request:

- `node node_modules/vitest/vitest.mjs run --root . tests/unit/task-graph-relations.test.ts tests/unit/task-graph-overview-components.test.ts --maxWorkers=2`
- `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`

Backend full-source detail tests live in `task-graph-detail.test.ts`, `task-graph-source.test.ts`, `task-graph-ipc.test.ts` and `live-runtime.test.ts`. The source-on-disk fixture test needs the preverified local pinned-query executable; keep its path and source fixture out of public artifacts. Exact final results and fingerprints belong to the ignored candidate evidence folder.
