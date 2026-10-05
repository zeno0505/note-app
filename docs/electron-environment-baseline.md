# Electron environment and baseline protocol — T-002 preparation

## Observed environment

2026-10-02 cloud Linux: Debian GNU/Linux 13 (trixie), x86_64, kernel 6.18.44, Node 24.19.0 and npm 11.9.0. `/proc/meminfo` reported 10,206,508 KiB total memory. `lscpu` cannot see the CPU topology in the command sandbox; record hardware identification as unavailable, not assumed. Native cloud desktop DISPLAY=:0 is usable through the supported desktop terminal. The isolated command runner has no display.

Electron 44.5.1 was installed from the official npm package and official binary installer; runtime reports bundled Node 24.21.0 and Chromium 152.0.7977.130. GUI libraries GTK3/NSS/ATK/GBM/X11/ALSA are installed. No Xvfb installation was needed. Package installation used a writable cache because the command runner cannot write its default home cache.

Electron 44 requires macOS 13 or later according to the [official Electron 44 release notes](https://www.electronjs.org/blog/electron-44-0). This is the runtime floor, not an agreed product-support guarantee. macOS arm64 is the eventual target from the plan. No macOS binary, native dialog, real Orca installation or final `.app` has been exercised here.

## Permissions and packaging constraints

- Renderer sandbox/context isolation enabled, Node integration disabled
- Renderer only receives environment metadata and bundled synthetic fixture reads
- No OS permission requests, actual note reads/writes, shell APIs, summary API calls, Orca agent calls or credential creation
- Official Electron binary download is an install-time network operation; running the app has no remote data requests
- Runtime file access and CLI collection need scoped, read-only adapters in later tasks
- Electron Forge is a packaging candidate from the [official packaging guide](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging); signing, notarization, bundle ID, display name, architecture choice and release-fuse policy remain pending T-025. No installer is produced

## Reproducible measurement plan

Measurements must be reported with exact commit/content hash, lockfile, OS/hardware, power mode, fixture size/hash, display/tool versions and whether sample is development or release. Do not invent acceptance thresholds before the baseline and user agreement.

1. Startup: measure process spawn to first rendered heading and enabled controls. Five cold-process starts and five warm-process starts, reporting every sample and median/range. “Cold process” means a new process; it does not claim flushed OS disk caches. State cache policy explicitly. The T-027 launch-and-interaction number includes automation overhead and is not a product startup baseline
2. Idle CPU: wait for startup to settle, sample `app.getAppMetrics()` once per second for 60 seconds foreground and 60 seconds hidden/minimized. Sum process CPU after distinguishing the API's percentage semantics; list main, renderer, GPU and utility processes. Record whether any collector worker exists
3. Memory: capture each Electron process working-set and peak-working-set KiB from `app.getAppMetrics()` with the same intervals. Report aggregate plus per-process values, and note shared-memory double-counting. Do not call only the main process RSS the total app footprint
4. Large DAG update: generate synthetic graphs of 100, 1,000 and 10,000 tasks with deterministic seed and acyclic dependencies. Record serialized bytes and source hash. For each size, measure 10 no-change refreshes and 10 single-task changes from collector receipt to rendered view; capture input latency/event-loop delay while updating. This remains unrun until a DAG adapter and worker path exist
5. Visibility: prove scheduled collection stops/reduces while hidden, resumes once foreground, coalesces overlapping refreshes and preserves last-good state on failure. No live polling exists in the current foundation, so real polling/resource behavior is unverified

## What has actually run

A real Linux Electron test shell was launched and interacted with; see `reviews/electron-test-infrastructure.md`. The product-shell smoke additionally captures a single process-metrics snapshot, useful only as inspection data. Full startup/CPU/large-DAG baseline and macOS resource acceptance remain unmeasured. This document defines the scenarios; it does not claim those benchmarks passed.

## Measured Linux update — 2026-10-02 18:16 UTC

The shell-only startup/idle CPU/aggregate working-set portion has now been executed on committed code, with five fresh-profile and five reused-profile starts plus60 one-second samples each visible and hidden. See `reviews/collector-verification.md` and its raw baseline JSON for numbers, equipment, scope and the immediate restore-capture caveat. This supersedes the earlier unmeasured shell statement; large-DAG, live-source and Mac/package performance remain unmeasured. No numerical acceptance target has been adopted.
