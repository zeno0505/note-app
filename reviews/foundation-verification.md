# Foundation verification — 2026-10-02

## Result and exact version

Local foundation verified on code commit `90b450d5ab0b4bcb90a2df8f5ea8e09e7c795860`, branch `feat/phase1-foundation`. This report and its evidence-only commit do not change application code. Full built-file manifest and combined SHA-256 are in `runs/2026-10-02-foundation/T-007-result.json`:

`6d53ab15398a261225161b976fd6513a48605321fa437c536b027c32765bef38`

This is a verified Linux development foundation with explicitly synthetic data, not completed Phase 1, real Orca integration, automatic summary generation, macOS acceptance or release.

## Requirement/task mapping

- T-001: written information contract and strict domain semantics prepared and tested; see `specs/information-contract.md`
- T-002: actual Linux dependency/runtime proof and reproducible resource-measurement protocol recorded; full benchmark and Mac measurements unrun
- T-003: installed versions and actually working commands documented; product minimum-macOS/packaging choices remain open
- T-004: user's empty repository cloned; local branch/commits prepared. Base branch, visibility and review/integration decisions remain open; no push/PR
- T-006: four entirely synthetic scenarios with source hashes and sensitivity exclusions verified; not an official real CLI schema
- T-027: technical Linux Electron gate proved with actual window interaction and visual inspection; no waiver of pending decision dependencies or Mac-native requirements
- T-007: secure single-window Vue/PrimeVue/Router foundation exercised. Foundation evidence supports preparation, not silent canonical DAG completion

Canonical plan/acceptance criteria were not changed. Initial authoritative plan archive SHA-256: `76a66721b8e6d136a5b45ed8be63efbf855fb2f0aad2b3ec66f7dc51ebfa7e37`. No planning archive, company snapshot or real project data was added to the repository.

## Commands and raw results

From repository root:

1. `npm --cache /tmp/note-app-npm-cache run check`: passed TypeScript, 49 tests across 3 files, and Vite/esbuild production compilation
2. `npm run test:electron:harness`: exit 0, actual Electron test shell; successful run around 17:16 UTC
3. `npm run test:electron`: exit 0, actual built Electron app; observed `2026-10-02T17:16:33.120Z`
4. `npm --cache /tmp/note-app-npm-cache audit --omit=dev --json`: 0 reported production vulnerabilities at that observation; not a guarantee against unknown vulnerabilities
5. `git diff --cached --check`: passed before code commits

Electron tests ran through the cloud desktop's supported terminal with DISPLAY=:0. Unit/build commands ran in the command executor. Host Node 24.19.0; Electron 44.5.1, bundled Node 24.21.0, Chromium 152.0.7977.130; Playwright 1.63.0; Debian 13 x86_64. Raw logs, result JSON, screenshots and exact exit codes are preserved under `reviews/runs/2026-10-02-foundation/`.

## Tested behavior and expected/actual results

- Initial state stays disconnected until explicit sample opt-in: passed
- Connected/nonarchived filtering shows 2 and 3 workstreams, never equates connectivity with agent activity: passed
- Search no-result/clear, details, source expansion, back, settings, exit/re-enter sample mode, missing detail and reload: passed
- Canned simulated failure keeps the actual previous successful cards and observation time, including empty → failure; retry restores current state: passed
- Actual main IPC handler removed during test: refresh rejection visibly preserves prior cards/time and marks them stale: passed
- Rapid in-flight refreshes coalesce; late reply after exit does not repopulate UI: unit tests passed; repeated real window refreshes passed
- Fixed-clock empty failure retains stale data rather than throwing: unit test passed
- Sandbox/context isolation enabled, Node absent, permissions/webviews disabled, narrow input/sender validation: unit and runtime checks passed
- Invalid/path-shaped/command-shaped IPC payloads fail; remote fetch and new external windows denied: runtime checks passed
- Narrow 800px window has no horizontal overflow; no uncaught renderer exceptions: passed
- Close ends all main/renderer/GPU/utility processes tracked by Electron metrics: passed

## Visual inspection of final screenshots

At approximately 17:16–17:17 UTC, the implementing agent opened all eight actual PNG images using an image-viewing tool. The final image pixels, not only filenames, were inspected:

- `T-027-electron-smoke.png`: real Electron heading, IPC result and test-only disclaimer clear
- `T-007-initial.png`: default disconnected state and explicit sample button clear
- `T-007-overview.png`: title → sample notice → filters/time → human summaries → next proposal/evidence reading order; two distinct cards; no clipping or overlap
- `T-007-detail.png`: expanded note/worktree/DAG/source hashes legible; long provenance lines wrap
- `T-007-stale.png`: Korean warning, retained observation time and all prior cards visible
- `T-007-settings.png`: source/backend unavailable states and local-only boundary clear
- `T-007-narrow.png`: cards stack vertically; controls and text remain within viewport
- `T-007-ipc-failure.png`: actual bridge-error and stale notices visible above preserved cards

No visual overlap or clipping was observed. This is agent visual QA, not user readability approval. No image was used as proof of real data or semantic correctness beyond its displayed fixture state.

## Review findings repaired

Independent read-only review found empty→failure incorrectly restoring a canned three-workstream snapshot, and actual IPC rejection leaving a current marker. Stateful demo storage and renderer failure handling fixed both. A fixed-clock equality edge was also fixed and covered. The final tests above were rerun after those changes; reviewer agreement alone was not treated as evidence.

## Unverified scope

Real Orca CLI, scoped filesystem/realpath mapping, note-link writes/preview/rollback, live polling/workers/large DAG updates, source-backed generated summaries, external model/cost policy, user reading approval, macOS native dialogs/input/permissions, packaging/signing/notarization/fuses and final `.app` remain unverified or unimplemented. The single process-metrics snapshot is not a resource-performance acceptance baseline. No release security was weakened to attach tests.
