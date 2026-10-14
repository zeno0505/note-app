# Graph and reader verification — 2026-10-14

Candidate content fingerprint: `6481a8bf75de64a1d30b69df9fbb8f2b26eb68d870e1e3eefb6b2ccd007b2f0c` (536 source files; a content fingerprint, not a Git commit). The reviewed change from df673 is DocumentViewer.vue and task-graph-evidence-return.test.ts. Historical source-handoff metadata and temporary artifacts are excluded from this source publication; other existing repository documents are preserved.

## Mac bounded regression

Actual sandboxed Electron production entry on macOS, Node 26.10.0. Separate HOME, userData, sessionData and config; installed build35 was not replaced. Project discovery was synthetic, the authorized note snapshot was read-only, and the reader document was authored for QA. These limits do not establish live Orca project/provider acceptance or real document quality.

Native run: 2026-10-14T15:22:58.533Z through 2026-10-14T15:32:01.394Z; Electron PID9166/window11584. Owned app and all tracked subprocesses exited; temporary DAG snapshots were removed.

- Expanded scroll2300, QA section21 and its viewport-relative offset0.4140625px are identical after collapse/reexpand. Repeated1200 and3100 positions also persist.
- Manual live refresh and a48.8second observation interval preserve scroll3100 and outer page742.5. Closing and reopening resets expanded offset to0.
- Graph wheel moves both axes,180px/140px, without outer page movement. Immediate Ctrl-wheel changes1 to1.49182 while cursor world point differs by less than0.12px.
- Orca CLI captured the exact PID/window. Its AXSetValue result reports unverified/value_mismatch; independent renderer readback observes T-001 and one result. Do not equate the tool's unverified metadata with verified native input delivery.
- One earlier zoom sample was taken after an unrelated search panel changed bounds. It is retained as a measurement diagnostic and superseded by the immediate before/after sample.

The previous df673 expanded-reader2300→0 failure was reproduced on Mac; this6481 bounded retest fixes that reproduction. This does not claim all reader states or full graph acceptance.

## Automated checks

Publication checkout: unit3120passed/14Linux-onlyskipped,145files; updater79passed; typecheck and build exit0. Unit ended at 2026-10-14T15:30:34.428848+00:00. Linux declares14 additional phase4-catalog linux-descriptor-path cases, so3148−14platform cases−14Mac skips=3120. The focused reader suite10passed overlaps these totals.

Supplied and separately reviewed Linux evidence: full3148, updater79, type/build, actual Electron16checks passed. Focused161 overlaps full tests. Video decoding passed; native playback for that recording was not run. Linux evidence is not Mac evidence.

## Remaining acceptance

Full same-viewport/DPR comparison with all six approved mockups, dense label collision review, full accessibility/theme/performance/reader-state coverage, live date-provider acceptance and physical trackpad inertia/pinch remain open. Mac protocol input does not establish physical trackpad feel. Human workflow fit is separate. T065/T066 remain in review; no full completion, installation, release or stable feed change is claimed.

Private screenshots, raw reports, note snapshot, query source, credentials, profiles and temporary QA data are retained locally and are not committed.

Formatting diagnostic: git diff --cached --check reports existing trailing whitespace in three candidate tests and an extra EOF blank line in two candidate files. These bytes were retained to preserve the reviewed candidate; type, full unit, updater and build checks pass. No functional acceptance is inferred from formatting.

## Main integration

Three-way scoped source integration onto existing main0b62112 preserved its current changes and required no conflicts. All534 selected candidate source files match the reviewed6481 bytes. Historical feature recovery/media files were not imported. The final main checkout passed unit3120/14Linux-onlyskips, updater79, typecheck and build again; unit ended 2026-10-14T15:38:02.251664+00:00. Native reader/graph code bytes are unchanged from the measured6481 candidate. No extra foreground run or installation was performed.
