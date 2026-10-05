# Read-only collectors and refresh policy verification

## Version and scope

Tested code commit: `f82220b3694f71a96d79c94ec63ea452bcd1b15f` on local branch `feat/phase1-foundation`. Working tree was clean during the final committed runs. All build-file manifests report SHA-256 `62f574e9594331cdbe0526eb6494e18d6f215a2cfa40a821eaf38514c3d4152f`.

This slice implements read-only Orca projection/transport, scoped filesystem mapping and visibility-aware snapshot orchestration. Actual Electron integration uses a synthetic CLI executable and real temporary note directories/symlinks. The product dashboard still intentionally starts disconnected and only offers fictional samples. Real Orca, user notes, live dashboard integration, summaries, note writes, macOS and release packaging remain unverified or unimplemented. No canonical DAG task state, acceptance criterion, remote branch, PR or release was changed.

## Final executed checks

- `npm --cache /tmp/note-app-npm-cache run check`: TypeScript, 255 tests across 10 files, and Vite/esbuild build passed on the committed source
- `npm run test:electron:harness`: exit 0
- `npm run test:electron`: exit 0, completed 2026-10-02T18:13:27.977Z
- `npm run test:electron:collectors`: exit 0, completed 2026-10-02T18:13:29.923Z
- `npm run test:electron:polling`: exit 0, completed 2026-10-02T18:14:16.007Z
- `npm run benchmark:electron`: exit 0, completed 2026-10-02T18:16:23.957Z

The raw exit summary, logs, exact committed build hashes, result JSON and images are preserved in the accompanying evidence directory. The Electron renderer stayed sandboxed and isolated with Node integration disabled. No security flags or release fuses were weakened.

## Collector/mapping results

Fixed argument-array queries, strict output bounds, cancellation/timeouts and explicit failure outcomes are covered by actual subprocess tests. Projection discards synthetic prompt/preview/assistant/tool payloads and never emits raw stderr/error bodies. Runtime/host/instance joins fail closed on mismatch. Missing project pagination remains unknown; missing project identity is not guessed.

The real Electron fixture probe confirmed one collected worktree plus a second explicit temporary mapping fixture share one canonical DAG. Missing note mapping stays partial. Access denied is a failure without a fabricated zero count. A long read leaves the window/main IPC responsive, rejects overlap, cancels, retries and cleans up. Symlink target/inode/mtime/mode and DAG bytes remained unchanged.

Independent review corrections were rerun: normal/error subprocess exits now finalize their owned process group; Linux procfs evidence cannot bypass hard kill/reobservation after the reproduced fork race. Uncertain cleanup is bounded, fails closed and disables reuse. Escaped/new-session daemons are outside the documented guarantee, and non-Linux behavior is not verified. Registration limits now apply before copying input arrays; path-based worktree IDs match the collector's 4096-character bound.

## Snapshot/polling results

Deterministic tests cover exact supported intervals, coalescing, cancellation, late results, disposal, unknown/empty/partial states and replacement across runtime changes. Generic unchanged-source caching requires an explicit matching runtime/hash; no DAG parse-cache claim is made.

Actual Electron wall-clock test observed one initial load, a second after the 20-second active cadence, no further loads across 22 seconds with the native window hidden, and one immediate refresh on show/focus with a newer observation time. Unknown project coverage remained unknown.

A separate one-second test-only freshness deadline proved subscriber-visible staleness while a real synthetic subprocess was still pending. This is an expiry regression probe, not a changed product polling interval or performance target. Review also fixed duplicate visibility events dropping queued manual refreshes and recursive duplicate notifications.

## Linux shell resource sample

Shared cloud Linux x64, kernel 6.18.44, reported AMD EPYC 9V74, 9 logical CPUs and about 9.73 GiB host memory. Electron 44.5.1 / Chromium 152.0.7977.130 / bundled Node 24.21.0. Fixture-only overview; no live collectors or model.

- Five fresh application profiles: median 414.9 ms startup, range 383.4–427.8 ms
- Five reused-profile process starts: median 388.7 ms, range 375.6–408.7 ms
- 60 one-second visible/focused samples: mean summed Electron CPU percentage 0.0295; mean aggregate working set 603,025.9 KiB (~588.9 MiB)
- 60 hidden samples: mean summed CPU percentage 0.0203; mean aggregate working set 597,009.7 KiB (~583.0 MiB)

Startup includes automation overhead. No OS disk cache was flushed. Process working-set sums can double-count shared pages and are not unique physical RAM. These are measurements, not agreed acceptance targets. Large-DAG update/worker performance, real-source load and native Mac/package performance remain unmeasured.

## Visual review

Final normal dashboard, settings, stale detail, collector success/missing/cancel and polling resume/pending-stale screenshots were actually opened. Their expected status distinctions were legible with no observed overlap or clipping. Native short hide/restore inspection and a matching capture were also clean.

The resource screenshot after the longer hidden interval showed missing static labels despite automated checks passing. This is tracked separately from the successful behavior assertions; the bounded native/capture comparison result is appended below. Do not interpret automated exit 0 as unconditional visual acceptance.

### Bounded restore comparison result

A short 2.5-second hide/restore diagnostic showed identical DOM text/styles before/after and complete labels in both a saved capture and native desktop inspection. A second diagnostic repeated the resource setup and 60-second hidden interval. Native pixels were inspected at approximately 18:24 UTC before a delayed full-page capture; both showed the subtitle, sample notice, search hint and observation labels correctly. The saved delayed capture was opened and checked as well.

No persistent restore defect was reproduced, and no application code was changed. The immediate post-restore capture anomaly remains a narrowly scoped visual/timing caveat: this evidence does not establish whether the first-frame renderer or capture path caused it, nor how long it lasted. Do not present the immediate resource screenshot as a clean visual acceptance image. Revisit immediate restore painting during broader UI/native acceptance rather than silently dismissing it.

## Per-task reconciliation recommendation

- T-002: Linux shell startup/visible-hidden CPU/working-set sample is now measured; large-DAG and Mac/package performance remain pending, with the restore-capture caveat above
- T-003/T-004: versions/commands and local commits are evidenced; product minimum-Mac/packaging/base-branch/visibility/integration decisions remain unresolved
- T-007/T-027: real Linux development Electron foundation/harness rerun passed; Mac native/package scope is not certified
- T-008: adapter implemented and Linux synthetic-subprocess/Electron-integration verified; real Orca and non-Linux process-tree behavior not verified
- T-009: mapper implemented and actual temporary-filesystem/Electron-integration verified; real-user note and native Mac acceptance not verified
- T-010: state/polling controller implemented and deterministic plus real Linux visibility/pending-stale integration verified; production read-model wiring and DAG parse caching are separate
- T-011: safe adapter proposal documented only; decision unapproved and link writes not implemented
- T-019/T-021: fixture UI/information-design candidate evidenced; not user readability approval or completed real-source UI
- T-014/T-015/T-016/T-017/T-018/T-020/T-022 onward: not completed by this slice. Authoritative DAG-query semantics, summary policy/approval, live integration and native/release checks remain separate work

These are evidence-backed scope recommendations, not a global done declaration or a canonical DAG mutation.
