# Phase3 usability review, 2026-10-09

## Scope

Project draft creation, minimum-input saving, resumption, reference links, work-environment preparation, empty-DAG review/cancellation/creation, and return to existing observed work. Changes preserve the existing source, write approval, no-overwrite, and model boundaries.

This is a Linux development-build review using disposable synthetic data. Static image review, scripted runtime assertions, and an independent agent-operated first-time-developer scenario are separate evidence types. No real-person study, macOS verification, real model execution, deployment, or installed-app replacement is claimed.

Base: `f525a31a604bf71b4159d34dfc3fa9628be9bd94`. The prior release checkout is untouched; changes are in an independent checkout. The final commit and scenario result are recorded in the handoff report.

## Accepted issues

| ID | Severity | Observed problem | Bounded correction | Regression obligation |
|---|---|---|---|---|
| UX01 | S2 major | Empty creation submit returned only a generic input/storage error | Required-field explanation, precise local field validation and focus, associated ARIA state | Missing/invalid path, missing verification, corrected input proceeds; native picker not opened for invalid values |
| UX02 | S3 moderate | Two draft rows occupied about 411 vertical pixels and pushed observed-work controls down | Adjacent row actions and compact refresh placement; no draft information hidden | Same two-draft comparison and narrow-layout checks |
| UX03 | S3 moderate | The dialog did not explain that a name-only draft can be saved; optional description consumed space | Visible minimum-save explanation and shorter resizable description field | Name-only save, edit, persistence |
| UX04 | S3 moderate | A zero-repository draft was described as an unsupported multiple-repository draft | Separate empty-state reason and same-draft environment-edit action | Zero vs multiple repository states, dialog transition and retained draft |
| UX05 | S3 moderate | Creation review did not show the current draft/repository | Compact explicit target context, with exact file preview unchanged | Target identity assertion and screenshot |
| UX06 | S3 moderate | Draft-only environment inputs looked mandatory; step identity disappeared on scroll | Optional-at-draft explanation/labels and small persistent footer step | Correct conditional wording, step transition/scroll, narrow layout |
| UX07 | S3 moderate | Relative note path and draft state were ambiguous | Concrete existing-folder/path example and explicit draft label | No auto-directory creation; source validation and no-overwrite preserved |

Each change was adopted only after the coordinating reviewer checked the cited original image/source, and directly reproduced the two behavioral errors in the original app. Optional input was not made mandatory. Existing instruction inheritance defaults and backend workflows remain unchanged.

## Testing

Baseline `npm run check`, with trusted pinned DAG query environment: 92 unit files / 2,068 tests passed; updater tests and build passed.

After the static-review changes, the same command passed: 93 unit files / 2,078 tests and 79 updater tests; typecheck and build passed. The renderer bundle-size warning already existed; this task does not introduce code-splitting or build-system changes.

Relevant Electron suites are:

- `npm run test:electron:onboarding`: minimum save, multiple references/repositories, interruption/discard, restart persistence, exact validation feedback, same-draft recovery, theme/narrow layout
- `npm run test:electron:project-creation`: local workspace selection, invalid-field recovery, exact preview, cancellation, explicit creation, generated-file reading, duplicate target refusal, zero model calls
- `npm run test:electron:phase2`: 500 synthetic tasks, filters/tabs/restart, declared vs observed state, evidence documents/images, graph, usage and model-consent boundaries
- `npm run test:electron:theme`: light/dark rendering and keyboard-focus/contrast probes within its measured scope

Scripted creation tests substitute the folder-picker response with a temporary fixture directory. The independent scenario uses the unmodified Linux folder picker. Neither should be described as macOS native-picker verification.

## Interactive review fixture

`tests/electron/phase3-persona-review.mjs` starts a fresh synthetic HOME and Electron profile, asserts zero initial drafts, records runtime sandbox settings and build hashes, and rejects model subprocess attempts. A supplied synthetic startup configuration is naturally connected by the production host; the fixture does not navigate or seed a draft on the user's behalf. Its control file can request a clean stop using the matching run ID. All fixture data is removed only after owned processes stop.

An operator should receive goals, allowed synthetic source paths, and success criteria without previous findings or prescribed controls. Record actual actions/outcomes and distinguish tool input limitations from application defects.

## Evidence and remaining validation

Original and revised screenshots, structured issue records, test logs and independent scenario observations accompany the external review packet. A screenshot proves the rendered state only. Final runtime/scenario outcome, exact code identity, and any unresolved limits must be added to that packet before claiming completion.

## Independent first-use scenario findings

The first independent agent-operated scenario discovered a core failure missed by the immediate mocked picker. With the real native folder picker open longer than 40 seconds, the app moved to background polling (five minutes) and its last observation became stale. Closing the picker scheduled a five-second foreground resume, but file-preview source validation ran before that refresh. The user repeatedly received a source-unavailable error. The coordinating reviewer reproduced it in the real native picker.

The correction keeps the 40-second freshness rule and every identity, source-equality, exact-preview and no-replace write check. After a successful native selection, a current ready observation follows the prior path directly. Only stale/in-flight observations request or join a read-only refresh. A five-second bound is a UI response deadline, not a claim that all configured collectors complete in five seconds. If exceeded, the runtime retains ownership of its in-flight work and the UI states that no file was created and observation may still be running. A later explicit user attempt can use the ready observation without forcing another full collection.

Further accepted scenario/review corrections:

- UX08: return focus to the originating draft after generation-review → edit → close, including repeated transitions
- UX09: refresh expired workspace choices once after rejection; preserve inputs and require an explicit new selection
- UX10: clarify that additional instructions are draft-only until deliberately consolidated, and verification commands belong to the later generation-review field
- UX11: the native-picker freshness/resume failure above

The scripted resume regression uses real window hide/show/focus events and an actual 41-second wait; it asserts stale background state followed by a fresh-source preview. This is not presented as actual folder-picker automation. The independent native-picker reevaluation remains the separate acceptance evidence.

The desktop process and command-tool `/tmp` views are separate in this environment. An initial external `ENOENT` did not mean the fixture disappeared: a read-only check in the desktop process namespace confirmed the running process and exact empty target directory. No missing fixture was silently recreated.

## Latest candidate validation

- Canonical `npm run check` with pinned DAG-query environment: 94 unit files, 2,102 tests, and 79 updater tests passed; typecheck and build passed; no skipped updater tests
- Latest targeted Electron onboarding and creation suites both exited 0 after the ready-observation guard and named-dialog test synchronization were added
- The 41-second background observation probe recorded stale/background state and a five-second resume countdown before successful preview; final creation passed the pinned reader with zero tasks, no overwrite, and zero model calls
- Phase2 and theme suites passed immediately before the narrow ready-observation guard; they were not rerun redundantly after that guard, which is exercised by dedicated unit and creation-flow tests
- Independent first-use native-picker reevaluation is a separate pending result at this code snapshot
