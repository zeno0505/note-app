# Application foundation — T-007 preparation

Single-window Electron main, isolated sandboxed preload, Vue/PrimeVue renderer and Vue Router overview/detail/settings routes. Main/preload/domain/renderer are separate. This is a local foundation with an explicit synthetic-data opt-in, not a finished Phase 1 product.

## IPC boundary

`window.noteApp` exposes fixed environment/demo/live methods plus narrow summary prepare/run/read/review/cancel and note-link options/preview/confirm/cancel methods. The two subscriptions have fixed event channels. Main validates top-frame/window identity, exact local app entry URL, argument counts and strict action schemas. Source selection uses only current opaque workstream/task/scope IDs; confirmation consumes exact main-owned tickets. No generic invoke, shell, filesystem, arbitrary URL, path, command or IPC surface is exposed. The preload does not trust renderer-supplied channel names. Configuration comes from one bounded host-side startup file, never renderer input.

All external navigation/new windows, webviews and permission grants are denied. CSP disallows remote scripts/fetch; content from fixtures is rendered through escaped Vue text interpolation, never HTML. Main session requests are limited to built renderer assets. Strict CSP allows inline style only for PrimeVue's local theme injection.

Startup remains disconnected. After explicit connection, configured read-only collectors run in bounded subprocesses with visibility-aware refresh, cancellation, coalescing and source freshness. Note access is restricted to explicitly registered project scopes and DAG files; no vault scan or summary model starts. Separately configured note-link changes require exact preview confirmation. Summary approval saves only to the private app-owned cache after fresh evidence validation. See [configuration](../docs/live-configuration.md).

`startHost()` is shared by the production entry and a separate test entry. Production always constructs the blocked summary service. A synthetic transport can be supplied only by explicit main-side test code; no environment flag, configuration property, renderer request or normal production control enables it. Synthetic results are visibly labeled and do not establish model quality or real agent enforcement.

## Honest data states

Default state is unconnected. A user can opt into fictional examples, switch connected/all-nonarchived workstreams, search, inspect sources, navigate details/settings and exit examples. Normal/empty/failure fixtures are deliberately separate. Failure preserves last-good content and clearly marks it stale. Next is labeled a proposal, not approval. Connected terminal, selected worktree, agent observation and DAG declaration remain separate.

Unit tests do not substitute for real Electron. `tests/electron/app-smoke.mjs` tests initial/normal/search/detail/back/invalid IPC/failure/retry/repeated refresh/empty/exit/missing-detail/reload and narrow-window paths, then closes the real app. Generated screenshots must be opened for visual review. See `reviews/foundation-verification.md` for final evidence and limits.
