# T054/T055/T056 summary UX verification, 2026-10-09

## Candidate scope and remaining product gap

The approved minimal renderer, scoped AI contract, exact selection dialog, transmission consent, and bounded automatic scheduler are implemented. The default is three exact task-linked activities, not seven days. No real model or user-data transmission was used in verification.

This is **not closure of the primary-project recency goal**: the initial code-activity adapter rejects linked Git worktrees/common object stores. Orca worktree projects may therefore lack qualifying recent activity. Existing explicitly registered, dated discussion/verification records remain usable; otherwise the UI offers manual selection. Actual e2e/invest declared-SHA coverage has not been measured in this dot checkout. A bounded worktree metadata contract and the required existing or explicit read authority must be evaluated before that gap can be closed.

## Checks

- Configured full `npm run check`: 2,391 unit tests in 110 files, zero skips; 79 updater checks; typecheck and production build passed.
- Authoritative DAG tests used the existing pinned local query script and Python via `DAG_QUERY_SCRIPT` and `DAG_QUERY_PYTHON`. The earlier 62 opt-in skips were eliminated, not counted as passing coverage.
- Baseline Phase4 full check was 2,339 units; this candidate adds 52 unit cases.
- Production host/preload/renderer Electron synthetic run: eight scenario groups passed; zero renderer errors, zero external page requests, zero real model calls.
- Electron covers initial no-transmission state, exact recent three, remembered consent with auto off, cross-prefix filtering and selection, custom/main isolation, close cancellation and focus restoration, revoke/regrant on the same project with changed input, and visible failure preserving prior success.
- Layout evidence covers 1,200/768/320-pixel widths, 200% native zoom, light/dark, narrow and zoomed settings/picker modals, and keyboard-focused first/last status icons. Buttons measured 32px high with 10px horizontal padding and no fixed minimum width. Tooltip focus does not add horizontal scrolling.

Synthetic Electron entry points are test-only main-process injection; there is no renderer or environment switch that bypasses production consent. Each run has isolated synthetic data/profile and checks process exit. `npm run test:electron:summary-review` expects an already built renderer and an available desktop; build first.

## Independent findings fixed

1. An approved one-time recipient/scope could be replaced during the controller's subsequent source resolution. Immutable approved bindings now survive every resolution/guard, with account/root/scope regressions.
2. A concurrent account binding could alter retry disclosure after its internal ticket was prepared. Retry preparation now owns an immutable binding, cancellation and settlement; single use and expiry are tested.
3. Revoke deselected the main scheduler while the renderer remained on the same project. Revoke now cancels without dropping selection, with unit and Electron regrant coverage.
4. Background refresh erased action errors. Action errors now persist until an explicit action clears them.
5. The connected footer incorrectly said all transmission was manual. It now reflects per-project allowed scope.
6. Keyboard tooltips were clipped by the picker scroll container. Picker-specific row-contained placement was verified in rebuilt screenshots.

Source refresh races continue to fail closed when the underlying observation is changing. A synthetic run encountered that condition during long screenshot capture; a subsequent stable-source run passed. This is not permission to retry automatically or weaken source guards.

## Evidence and delivery boundary

Machine-readable UI evidence is produced by `tests/electron/summary-review-ui-smoke.mjs`; its build identity includes source status and hashes. Development evidence was generated against the exact pre-commit working tree; a local commit freezes that source for separate Mac verification. No main merge, release feed update, stable app installation, or real-model execution is part of this candidate.

The independent UI reviewer found no remaining material defect in the inspected final images. Capped-nextAt and some unavailable/retry states were reviewed in source and unit tests rather than final rendered scenarios. This evidence is synthetic agent-operated verification, not screen-reader certification, real-person usability research, or actual AI summary-quality validation.

## Approved compatibility follow-up, 2026-10-10

The compatibility follow-up adds local commit-identity/time reads for exact declared short SHA prefixes and linked worktrees. A new native-picker proposal names the current worktree and common Git directory, requires an explicit unchecked local-read confirmation, and persists descriptor identities and grant revision separately from note access and AI transmission consent. Cancelling grants nothing; revocation blocks cached reads and fallback authority. Changed provider/scope identities still require transmission reconsent.

The adapter accepts only full SHA-1 IDs or uniquely resolved hexadecimal prefixes of length 4–39. It verifies object type and records declared reference, full SHA, and commit time. Ambiguous prefixes, noncommits and unsupported declarations remain unresolved. No source code, blob bodies, diffs, network, hooks, replacement objects, alternates or lazy fetching are allowed. Git optimization commit-graph caches are ignored with an explicit `core.commitGraph=false`; cache contents are neither opened nor traversed, and safe cache updates do not invalidate grants.

A main-owned durable index advances at most 128 exact declarations per observation, binding every record to the current declared set, local authority and object-store revision. The UI shows checked, resolved, unresolved and pending counts. Partial coverage is explicitly “recent among checked records”; it is never represented as globally latest project work. One registered worktree's store does not prove coverage across distinct repositories in a merged project. Exceptional metadata bounds or unsafe layouts remain unavailable instead of expanding reads.

Independent review led to regression coverage for in-place loose-object changes, path swaps, short-prefix collisions, cancelled durable grant writes, failed recovery, symbolic HEAD confinement, and ordinary detached-HEAD movement. Unrecoverable storage uncertainty blocks reads and ordinary shutdown; a forced operating-system termination cannot guarantee rollback and is not presented as verified revocation.

Synthetic Electron validation found a valid UTC `Z` timestamp rejected by the numeric-offset-only parser. The repaired strict parser has a real 128-reference mixed full/short UTC regression. Final configured checks pass 2,541 unit tests in 115 files with zero skips, 79 updater tests, typecheck and production build. The compatibility Electron test passes 429/429 exact references, correct last-three selection, durable restart, revoke/restart isolation, and zero real model calls or external requests. Its native-picker cancellation response is stubbed in the main process; this does not claim OS-native picker operation. Proposal cancellation focus is asserted. Independent pixel review passes initial partial coverage, explicit grant, 320-pixel settings and 200% zoom. The existing eight-scenario summary and fourteen-scenario Phase4 document Electron regressions also pass on the updated source.
