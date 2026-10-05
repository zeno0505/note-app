# Electron test infrastructure — T-027 technical proof

## Scope and acceptance

The approved plan requires a real Electron development shell to launch, accept window interaction, produce a screenshot that an agent actually opens, and close cleanly. Browser-only testing is not equivalent. Invalid IPC and retry are included. A test shell has no destructive or native-dialog path, so those cases do not apply here.

This document records a technical proof; it does not override open T-003/T-004 decisions or mark canonical DAG tasks done.

## Executed proof

- Runtime: Linux x86_64, Debian 13, cloud desktop; Electron 44.5.1, bundled Node 24.21.0, Chromium 152.0.7977.130; Playwright 1.63.0 experimental `_electron`
- Command, from repository root on a desktop display: `npm run test:electron:harness` (equivalent initial run: `node tests/electron/launch-smoke.mjs`)
- Initial successful observation: 2026-10-02T16:52:56.233Z
- Checks: actual launch / firstWindow / click Check IPC / IPC round trip / malformed request rejected / repeat click / screenshot / close / main process no longer alive
- Actual settings: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; renderer `require` absent
- Playwright uses `chromiumSandbox: true`. Its default injects `--no-sandbox`; the explicit flag prevents that. The app also calls `app.enableSandbox()`
- Evidence generated in `reviews/evidence/T-027-launch.log`, `T-027-result.json`, `T-027-electron-smoke.png`; final commit/hash/run will be recorded in the foundation report
- The image was opened with an image-viewing tool at approximately 16:53 UTC: heading, subtitle, Check IPC button, successful IPC message, and test-shell disclaimer are legible and follow the expected reading order; no clipping or overlap

## Environment mechanics

The command executor has no active DISPLAY and a separate temporary/process view. The cloud desktop does exist. The supported cloud desktop terminal shares this repository and has DISPLAY=:0; the test was launched there using computer control. No Electron sandbox flags, OS security settings, credentials, or release fuses were weakened. A private launch helper outside the repository just changes directory, runs the command, and saves stdout/stderr.

## Remaining limits

- This is development Electron, not a signed/notarized/released package
- macOS native window input, file dialog, permission prompts, real Orca CLI, and final `.app` have not been tested on Linux
- No macOS validation or deployment claim is made
- Test harness debugging remains separate from release-fuse decisions; do not weaken release fuses merely to attach Playwright
- Screenshots support visual claims; assertions and logs support behavior. Neither alone proves all product requirements

Sources: [Playwright Electron API](https://playwright.dev/docs/api/class-electron), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox/).
