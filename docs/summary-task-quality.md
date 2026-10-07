# Task-scoped summary quality acceptance

## Request and scope

The reported large DAG repeats early tasks and can mix unrelated prefix context. Keep exact prefix independence (default T, no silent fallback if absent). Within that prefix, rules and manual AI must explain one shared set of at most 20 tasks. Do not infer recency from ID, source order, file mtime or phase: the observed task contract has no task timestamps. Phase 2 is separate work and is not part of this branch.

## Selection contract

- Explicit user selection wins: 1–20 existing IDs in the selected prefix; duplicates, unknown IDs and cross-prefix IDs are rejected by the main process
- Automatic selection includes representatives of running/in-progress, blocked, review, eligible pending, other unfinished and completed declarations. It takes up to five rounds across those categories, then fills spare capacity, with a global limit of 20
- Within each category, prioritize tasks referenced by more unfinished direct dependants. Ties retain source-array order; neither rule establishes recency or actual business priority
- Selection reasons show declaration category and direct unfinished dependant count. This is evidence-based triage, not a claim that arbitrary representatives capture all semantic context
- Rules and AI share exactly those task IDs. Counts disclose prefix total, selected and omitted. Sentence task-name caps stay at five; the UI DAG list remains capped at 200
- Selected tasks are always included in that 200-item list. The PrimeVue selection dialog supports names/IDs from that list and exact IDs beyond it; no “select all” bypass of the 20-item limit
- Dependency declarations outside the sample (including the same prefix) retain only ID, internal/external scope and status. Missing/unresolved/blocked dependencies never become completed merely because their task bodies were omitted
- Save explicit choices in app-owned registry state. Switching prefix resets to representative selection. Reopening/restarting keeps the current prefix and explicit choice. A disappeared selected ID is shown as missing; it is not silently replaced and AI is disabled
- Scope changes reset transfer consent, change model identity/input hash and invalidate running results. Prefix-v1 model history is preserved but not presented as a result of the new task scope
- Existing sensitive-input scan, DAG-byte limit, source/fact caps, all-facts and source/anchor validation are retained. No model calls are made by selecting or viewing

## Verification

`npm run check` is the aggregate type/unit/build gate. `tests/unit/summary-task-selection.test.ts` uses a fictional 463-task prefix with late active work, a blocker with dependant tasks, mixed-prefix dependency and explicit selections beyond item 200. It verifies matching rule/AI selection, omission counts, missing-ID behavior, sensitive-input handling and the unweakened all-facts contract.

Synthetic answers establish bounded selection and contract coherence only. Real model prose quality, actual user DAG interpretation, macOS behavior and live paid/model calls are not verified here.

## Independent UI review tasks

Run `npm run build`, then `npm run test:electron:prefix` with the isolated Python/query fixture prerequisites documented in existing Electron evidence. Review the detail screen in both themes: prefix switching, representative selection reasons, opening/filtering/clearing/applying/cancelling the task dialog, adding an exact ID beyond the visible 200, over-20 rejection, restored selection after process restart, missing task handling, consent reset and no horizontal overflow. No source edits or real model calls are required.

### Verified on 2026-10-07, Linux

- Aggregate gate passed: TypeScript/Vue typecheck, 53 unit test files, 1,035 tests passed, 5 skipped, production build
- Actual Electron smoke passed with Chromium sandbox enabled and zero model calls: representative prefix behavior, explicit task beyond display position 200, empty-selection disabled, exact rules task scope, transfer-consent reset, cancelled draft unchanged, reconnect and process restart persistence, return to representatives, missing-prefix fail-closed, unchanged source-link inode/target
- The shell executor could not access the display socket even after approved escalation. The same unchanged fixture succeeded through the available cloud desktop terminal; no sandbox-disable flag was used
- Independent UX review is a separate pending gate. The build retains the existing Vite large-chunk warning; this is not a build failure

### Same-review remediation

The independent UI/UX review found a polling-related dialog loss, stale list warning, explicit-mode copy mismatch and outdated prefix documentation. All were corrected, together with a deterministically reproduced publish-before-response acknowledgement race. Human-speed Electron regression and long-label screenshot QA were added. See [remediation and verification scope](../reviews/task-summary-ux-followup.md). Final aggregate gate: 53 test files, 1,037 passed, 5 skipped, typecheck/build passed.
