# Task summary UI review remediation

Date: 2026-10-07. This is remediation from one independent two-stage UI/UX review, not a second independent review. The reviewer first used the running synthetic app without implementation documents, then checked the source and contracts. No real model calls or user source edits were made.

## Findings and corrections

- Same-identity live snapshots closed the task-selection dialog. A getter returned a new identity array on each DAG object replacement. The watcher now observes project, DAG and prefix primitive values separately; only a real identity change cancels editing
- A filtered-out project warning survived after that project became visible again. The warning now remembers which excluded project it describes, clears when it reappears, and does not auto-select it
- Explicit selection still displayed representative-selection guidance. The text now describes the active mode
- The prefix guide described the previous independent rules/AI scopes and prefix-v1 identity. It now documents the common task selection and task-scope-v1 identity
- A publish event arriving before a successful mutation response caused a false save error. A deterministic test first reproduced `false` instead of successful acknowledgement. Successful mutation acknowledgement is now separate from whether the response snapshot may replace a newer event
- During remediation screenshot QA, a long task name expanded the MultiSelect overlay beyond the viewport. The overlay is bounded and option labels wrap. The smoke test now checks both the dialog and the open overlay boundaries

## Verification

The aggregate gate after product changes passed: Vue/TypeScript typecheck, 53 unit files, 1,037 tests passed and 5 skipped, and production build. The existing Vite large-chunk warning remains.

Actual Electron coverage uses an isolated synthetic fixture, Chromium sandbox enabled and an intercepted/blocked model spawn path. The expanded smoke keeps an open task editor for 22 seconds and then forces another same-identity refresh. It checks the dialog, draft ID text, search text and focus survive; two Escape presses close the dropdown then the dialog; real prefix identity change cancels the editor; empty and over-20 choices cannot apply; explicit mode guidance is correct; and apply/cancel/restart behavior remains intact. Screenshots cover light/dark open dropdowns, a long task label, and 0/20/21-item states.

This verifies interaction and contract behavior, not real AI prose quality, real project priority correctness, macOS behavior, screen-reader support, or full keyboard navigation. The broad information-density recommendation is recorded for later design work; this corrective patch does not reorganize unrelated project controls.

Final Electron rerun passed with zero model calls. Both light and dark long-label dropdown screenshots were opened and visually checked after waiting for the actual option text color to settle; an earlier mixed-theme capture was a transition-time screenshot and was not accepted as evidence. The final overlay wraps the complete long label and remains within the viewport. Empty/20/21-item screenshots were also inspected. The original review fixture was stopped and its exact disposable root removed; its PID was a non-executing zombie owned by PID 1, not a live app.
