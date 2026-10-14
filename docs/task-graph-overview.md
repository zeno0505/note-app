# Graph overview candidate (T061)

## Production integration

`TaskWorkspace.vue` now offers the complete-source relation graph alongside the preserved task list and explicitly labelled legacy paged DAG. Entering the new graph opens prefix overview with no automatic task selection. `TaskGraphWorkspace.vue` owns the T058/T060 read/layout pipeline, shallow snapshots, authority withdrawal, background/unmount cancellation, T059 date reads, grouping and open/back integration. `TaskGraphOverview.vue` is a presentation component with `openGroup` events, complete-source group/status/edge counts, and shared tooltip targets. `task-graph-overview.ts` computes date/status display projections without I/O or product oracle constants.

The complete-source read/layout never consumes `workspaceTasks`, visible rows, the old task filter, or old pagination IDs. Source order determines the overview card order. Gap-based aggregate routing uses distinct endpoint ports, avoids card interiors, and reserves a footer band below detours. Routes can still overlap other routes; no crossing-free layout is claimed. Prefix, Phase and ungrouped modes retain missing/unparsed groups. A group aggregate's opposing arrows are explicitly aggregate-only evidence; they do not create task-cycle claims.

Dates come only from identity-bound `readTaskGraphDates` responses. Missing metadata remains unconfirmed. This does not enable any private provider or assert the private QA fixture's historical resolution coverage. Cards show only the compact KST calendar date, with visible year context when all confirmed dates share a year. Tooltip content includes exact KST timestamp, task, SHA, verified repository/commit URL, task and reference coverage, incomplete inspection and partial evidence. Source URLs are text only in this candidate: the renderer receives no arbitrary URL-opening capability.

Status bars use one whole-bar button as the hover/focus/tap target. Tooltip text retains exact counts and original vocabulary alongside the approved translations. Declared `done` is not presented as execution verification. The shared tooltip has a single-popup owner, remains pointer-accessible, supports keyboard focus and Escape, and is portalled with viewport positioning to avoid container clipping. Native/browser clipping, input and pixels remain unverified.

## T062/T063 integration boundary

Opening a group projects its complete membership through T060 and opens an unselected continuous DOM/SVG viewport with two-axis scroll, zoom and explicit back-to-overview. Search is over the full source index and explicit result activation moves/focuses the task without opening detail. Status filtering only changes candidates, never recomputes layout. Existing bounded task details, evidence viewer, verification popover and task summary are reused on explicit activation; an admitted graph task beyond the legacy detail reader is explicitly reported as unavailable rather than fabricated.

This is an initial functional integration, **not T062/T063 acceptance**. Per-group restore history, minimap, pointer drag, exact relation emphasis, offscreen chips, fully source-independent detail loading and broad accessibility acceptance remain subsequent work. The current view retains same-project/same-DAG geometry and pan/zoom across source refresh or background/resume; a new project/DAG resets it. Date-session rechecks bind project, DAG and session; explicit authorization/disconnection/source-revision failures withdraw the graph. Ephemeral session renewal does not by itself discard compatible geometry, but every new publication still passes the current authority pipeline.

## Explicit safety fallbacks and design differences

These are provisional bounded-rendering safeguards, **not measured renderer-performance limits or approved visual substitutions**:

- More than 600 viewport cards or 2,000 intersecting routes pauses the group diagram with actual candidate counts. Zoom, status filtering and full-source search remain available. No edges disappear silently from source semantics
- More than 120 overview groups or 2,000 directed group bundles uses 30-group paged cards with full counts and usable group activation. Aggregate arrows are explicitly omitted in this fallback
- Full-SHA/repository/URL and reference-coverage tooltip content is more detailed than the compact reference image. This is a source-level difference to review; no pixel-equivalence claim is made
- The surrounding existing application navigation and legacy feature access are preserved; the standalone reference's entire application shell is not replaced by this task

All these differences must be included in the final technical report. They do not satisfy approved-reference image comparison. No unavoidable constraint has been established that requires user acceptance of a permanent redesign.

## Verification scope

Public tests use synthetic sources only. Helper tests cover exact status counts, missing/anonymous group identity, full-source membership, date maxima and tie-breaking, task/reference coverage, stale identity, missing/duplicate dates and KST year boundaries. Production-template custom-host component tests are separate from native renderer evidence. Existing list/detail/evidence regressions are retained.

Actual application capture and reference overlays are blocked by the already-established Chromium socket `EPERM` environment failure. No sandbox/security change or bypass is attempted. Approval of mocked DOM/component tests is not approval of actual pixels, native keyboard/focus/pointer behavior, performance or Mac readiness. T065/T066 image comparison remains open.
