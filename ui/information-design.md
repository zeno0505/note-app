# One-page information design — T-019 candidate

Status: implemented fixture candidate with Linux Electron interaction/visual evidence, not user readability approval or a completed live-data screen.

## Reading order

1. Workspace title and an unmistakable data-mode notice
2. Last observation, failure/attempt time, coverage/unknown indicators as applicable
3. Connected-workstream default filter and all-nonarchived option; counts refer to workstreams, not repositories or an old real snapshot
4. Workstream goal and plain-language progress: implemented/current, remaining, blockers/decisions, proposed next action
5. Collapsed source/connection detail: raw selected/terminal/agent/DAG observations kept separate, source locator/hash/time

A proposed next action is not execution approval or priority. Completed work in a source is not a passed test or deployment. Missing note mapping is visible uncertainty, not an empty completed plan.

## Routes and state

- `/`: overview/search/filter
- `/workstream/:id`: same workstream's explanation and source detail
- `/settings`: source/backend/privacy availability, with no false live integration controls
- Hash history keeps routing local in Electron. Back/Forward and explicit return preserve the current search/filter. Unknown IDs show a recoverable missing-workstream state
- Exiting sample mode explicitly clears sample state; reload starts disconnected. Persistence of real-source configuration is outside this slice
- Stale warnings, last success/failed-attempt time and per-claim old-observation labels survive detail navigation; the header also signals failure

## Local boundaries

Vue/PrimeVue renders escaped text; it never executes note HTML. Preload methods are narrow and main validates ownership and schemas. Collection, mapping and domain facts remain separate from view components. The fixture dashboard does not run a model or trigger agents.

## Interaction and accessibility

Semantic headings, native links/buttons, named search/filter controls, visible focus outlines, alert announcements and keyboard-operable evidence disclosure are used. Actual Electron tests include Enter activation, Space expansion, history navigation and narrow-window overflow checks. Hostile markup remains literal text; unknown connectivity is distinct from disconnected.

This is not a completed accessibility-conformance audit or macOS VoiceOver verification. User reading evaluation must use representative, source-grounded workstreams after summary accuracy review; three fictional examples do not satisfy that approval.

## Planned connection proposal

A missing mapping may later offer a scoped selection/preview route. It must show realpath scope and all filesystem/exclude effects before confirmation, preserve cancel/back state, and keep selection separate from write approval. That flow is not enabled in the foundation. See `specs/note-link-adapter.md`; D-04 remains open.

## Phase boundary

Source, uncertainty and time are accuracy aids in Phase 1. A full acceptance-criteria/evidence-review/delegation management interface belongs to Phase 2 and is not a prerequisite to reading project progress.

Evidence: `reviews/foundation-verification.md` and its superseding `reviews/freshness-regression.md`. Real CLI-to-read-model-to-dashboard integration (T-022), summary reading approval and native package checks remain separate.
