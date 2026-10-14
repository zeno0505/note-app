# Continuous graph navigation candidate (T062)

## Scope

The production `TaskGraphWorkspace.vue` now provides full-width unselected continuous graph navigation. Task depth remains left-to-right without wrapping; vertical movement reaches other tasks at the same depth. Geometry continues to come exclusively from the authorized complete-source T058/T060 pipeline, never the legacy 1,000-task / 8-reference display projection. Existing list, legacy paged DAG, detail, verification and evidence access remain present.

- Native two-axis scroll, pointer drag, keyboard arrows/Page Up/Page Down/Home, center-preserving zoom, 100%, full fit and selection reveal
- Miniature whole-graph path with viewport indicator, pointer positioning using the SVG bounds, and keyboard panning
- Complete-source ID/title search, explicit activation and 100-result pages with all matches reachable; no automatic detail opening
- Status filtering without relayout, explicit no-match recovery, separate visible/offscreen/filtered counts and full-source edge partitions
- Distinct other-group, filter-hidden and unresolved-reference context counts, with overlap disclosed
- Visible depth headings and compact group date/status tooltips; permanent task status text removed in favor of accessible declared-status names and existing status accents
- Focused node pinning during geometric culling; a drag is not dispatched as task activation

Full-edge diagnostic counts settle 120 ms after movement; the interface identifies pending position recounts. Geometric card/route culling remains immediate. No production frame-rate claim is made.

## State and identity

`task-graph-navigation.ts` stores at most 100 recently saved views for the renderer session. Keys include project, DAG, grouping mode, group key and layout version. Records retain numeric positions/viewport/zoom, filter and a selected ID plus detail-open intent. They exclude source titles, adjacency and source content; session key, revision and source hash are stripped from remembered geometry. Nothing is written to disk. Older entries may be evicted; application restart persistence is not implemented.

Group backtracking, grouping changes, list/legacy transitions, background/resume, source refresh and project A → B → A remounts restore compatible geometry. Every return reads the current authorized source. Selection is re-admitted only in the same project/DAG/group against existing unambiguous IDs; removed/duplicate selections are explicitly cleared. Source identity and current legacy-detail admission must also match before the parent opens an existing detail. Missing bounded detail and mismatched current source are reported separately.

The graph remains mounted across list/legacy transitions, but is inactive and cancels its pipeline while hidden. Expanding an evidence document suspends graph work without clearing parent detail and collapsing the document. Parent/child generation checks suppress late layouts, date results and focus movement from superseded navigation.

## Explicit density recovery and differences

The provisional 600-card / 2,000-intersecting-route thresholds remain safeguards, not measured performance promises. When exceeded, the interface explicitly reports the number of paths not drawn. Admitted task cards remain available within their own budget. When the card budget is exceeded, a searched/focused card remains available, and its complete direct relations are paged in groups of 20 with resolved navigation or an unresolved-reference explanation. High-fan-in search therefore does not strand the user in a blank canvas.

This fallback is an explicit deviation from the ordinary approved-reference canvas at unusually dense views. It is not an approved visual replacement or evidence of full diagram coverage. Group status/date content uses existing verified metadata semantics; no private fixture is bundled. Whole-graph source partitions are labelled as such, rather than mislabelled group-internal counts.

## Verification boundary

The actual approved 05, 06 and 07 pixels were inspected before implementation. The candidate's native application pixels remain blocked by the previously established Chromium socket `EPERM` restriction; no bypass, install, Mac operation, push or external publication was attempted.

Custom-host tests execute actual Vue production setup functions and templates. They cover full-source search beyond 1,000 tasks, search pagination, group/identity restore, source withdrawal, A → B → A component unmount, revoked return, deleted selection, zoom/scroll, drag suppression, keyboard pan, focus pinning, filter counts, SVG-coordinate minimap navigation and high-fan-in recovery. Parent integration executes actual `TaskWorkspace` and `TaskGraphWorkspace`, with PrimeVue leaves and the evidence viewer stubbed, to test document expansion, list/legacy return and stale detail-source rejection. Those tests do not establish real browser layout, pixels, native events or the evidence viewer's own runtime behavior.

Run the exact current candidate:

- `npx vitest run --root . tests/unit/task-graph-navigation.test.ts tests/unit/task-graph-overview-components.test.ts --maxWorkers=2`
- `npm run typecheck`
- `npm run build`

The T062-focused final run has 76 passing tests. Independent review evidence is in the ignored local T062 artifact directory. Complete-suite/updater/native/pixel/performance acceptance belongs to the final integration gate; do not substitute an earlier candidate's result. T063 still owns ordinary one-hop hover/focus emphasis, boundary chips, cross-group relation return paths and fuller detail behavior.
