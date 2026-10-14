# Complete graph layout pipeline (T060)

## Integration boundary

This candidate adds pure graph geometry, indexing, a dedicated module worker and a cancellable reader/worker client. It does **not** replace `TaskWorkspace.vue` or the existing paged graph. The screen, interaction and native Electron/Mac acceptance gates remain later work. No private fixture is bundled in production or public tests.

Use `createTaskGraphLayoutPipeline(bridge).read(projectId, { grouping, groupKey, previous, signal })` with the complete graph bridge. `groupKey: null` lays out every admitted source node; a concrete key lays out the **whole** chosen group. Do not pass display pages, filtered arrays or visible IDs as layout input. Source coverage and unresolved endpoints are retained with the returned snapshot.

The owner must call `setBackground(true)` on background, `cancel()` on project/DAG/authority changes, and `dispose()` on unmount. The client checks all five graph identity fields before and after worker work; the pipeline re-reads metadata through the authorized bridge to verify content revision and session. Worker replacement/cancellation/timeout terminates physical computation. This is an injectable, testable boundary; real renderer lifecycle wiring belongs to the screen implementation.

Hold returned snapshots/layouts in shallow Vue refs, treat arrays and Maps as read-only and do not deep-proxy the graph. Records/arrays are frozen on publication; JavaScript Map mutation cannot be prevented by Object.freeze, so ReadonlyMap is the consumer contract and cached results are revalidated. Neither filters nor hover, detail, focus or zoom is a layout option. These operations use existing geometry and source indexes. The worker is an ordinary Vite module worker, with no filesystem, source-text, Git, URL-opening or bridge capability.

## Geometry and stability

`layoutGraphSnapshot` constructs canonical ID/edge order and iterative SCC condensation. Longest-path depth determines continuous left-to-right columns; task columns never wrap. SCC members occupy a shared depth with distinct rows. Local induced-group SCCs control layout; `sourceCycles` preserves global source SCC evidence, including cycles crossing group boundaries. Bidirectional group links are only aggregates and never establish a task cycle.

Cards are 184 × 58 world CSS pixels with 34-pixel column gaps and 16-pixel row gaps. These compact dimensions follow the latest approved continuous-canvas reference, rather than the older always-visible status rows. Adjacent same-row edges are direct. Other edges use column-gap vertical segments and row-gap horizontal segments so no segment crosses a card interior, including backward and self edges. Edge-edge overlap is possible and deliberately not represented as a card-collision guarantee; highlighted relation routing/readability still needs actual screen verification.

A compatible prior layout retains surviving rows at the same depth. New nodes fill unoccupied slots; removed nodes disappear. Dependency changes can require depth changes, so exact x preservation is not guaranteed when it would violate the DAG. Geometry compatibility requires project, DAG, grouping, group key and layout version. Only numeric row slots for surviving currently authorized IDs are reusable; old titles, edges, selection and authority are never reused. Source revisions and renewed session tokens do not discard compatible slots because main renews the session on every refresh. Worker publication and caches still require the full current identity, including session, source hash and revision, so A → B → A late results cannot publish. Geometry state keys intentionally omit the ephemeral authority token.

## Projections and render plan

- `visibleGraphNodes` binary-searches sorted columns and rows in a **world-coordinate** rectangle
- `visibleGraphRoutes` uses a balanced route-bounds hierarchy, then segment intersection, so a path crossing the viewport remains drawable even when both endpoint cards are outside
- `projectGraphViewport` separately partitions all source nodes and unique source edges; filtering, other-group nodes, viewport exclusion and unresolved endpoints remain distinct
- `graphDirectRelations` uses full-source incoming/outgoing edge-ID indexes; repeated declarations never multiply unique relation counts
- `graphRenderCandidates` reports visible card/intersecting path counts and caller-supplied budget exceedance without truncating any relationship; budgets require renderer evidence
- `graphRoutePath` provides orthogonal SVG geometry; task titles, statuses and full relationship evidence remain in the source index for accessible DOM/list consumers

During pointer pan, use the indexed geometric culling functions. Compute the O(V + E) diagnostic partition only when needed, not for every hover. Pin the focused accessible DOM node separately if virtualization would otherwise remove it, without changing truthful viewport counts. No node or edge is deleted from source semantics by rendering optimization.

Start with DOM task cards plus SVG paths, pending the benchmark report and actual UI measurements. Culling cannot guarantee a fixed edge count: high-degree or heavily overlapping paths can all intersect the viewport, and the bounds hierarchy has worst-case O(E) query cost. Fit-all views can expose every card. No frame-rate, Canvas superiority, WebGL requirement or million-node support is claimed.

## Limits and evidence

Input limits remain the complete-source transport contract: 10,000 nodes, 100,000 unique edges/declarations within the existing transport byte budget. An unsupported/partial source is never silently made complete by layout. Public regression fixtures are synthetic; optional private oracle execution is local-only.

Focused suites are `tests/unit/task-graph-layout.test.ts`, `task-graph-layout-client.test.ts` and `task-graph-layout-worker.test.ts`. The reproducible performance harness is `tests/performance/task-graph-layout-benchmark.mjs`; reports go to ignored `artifacts/t060/`. That harness is a micro-prototype, not the production Vue screen or Electron IPC/native acceptance. Exact evidence, hashes, independent review, performance results and any environment blockers are recorded in the candidate report there.

Worker validation/freezing must remain cancellation-aware and yield between bounded stages before atomic publication. Read worker roundtrip/event-loop evidence separately from pure algorithm timings; a fast worker calculation does not establish a responsive renderer. Source/authority is rechecked after finalization, including cache publication.
