# Phase 3 native acceptance

Use an isolated source worktree. Never run these tests against an installed personal profile, personal DAG, real repository checkout, or a real model transport. The fixtures create their own temporary Git repositories, note directories, synthetic Orca executable and Electron profile; all model calls are forbidden.

Prerequisites are the repository's Node/Electron versions and the unchanged externally supplied pinned DAG query. Do not copy the private query into the public repository.

```sh
export NOTE_APP_PYTHON="/absolute/trusted/python3"
export NOTE_APP_DAG_QUERY_PATH="/absolute/pinned/query.py"
export DAG_QUERY_PYTHON="$NOTE_APP_PYTHON"
export DAG_QUERY_SCRIPT="$NOTE_APP_DAG_QUERY_PATH"
npm run check
npm run test:electron:onboarding
npm run test:electron:project-creation
```

The full query-enabled unit suite must not silently skip query tests. On macOS, explicitly list Linux-only procfs tests as platform skips. The Python writer must really execute on macOS before declaring that platform accepted.

`test:electron:onboarding` covers entered sources, multiple repositories, durable restart, unsaved-change recovery, Escape/focus return, strict draft IPC and light/dark/narrow layout. `test:electron:project-creation` covers main-revalidated current workspace selection, exact no-write preview, cancellation, explicit single-file creation, untouched original sources, existing-target refusal and the resulting file through the unchanged pinned production reader. Its native picker is stubbed to a single fixture directory; that is not a native-picker usability certification.

An interactive fixture is also available:

```sh
NOTE_APP_REVIEW_CONTROL="/absolute/owned/temporary/review-control.json" node tests/electron/project-onboarding-review.mjs
```

It seeds two fictional drafts and current synthetic observations. Native directory selection is intentionally stubbed to the temporary project directory. To stop it gracefully, preserve the written `runId` and change its control JSON `status` to `stop`. The fixture closes its owned Electron and removes its temporary source/profile directories. Do not point the control file at any existing user document.

For real native picker acceptance, use only a disposable fixture directory. Verify cancellation, exact path display, mismatch/existing-file refusal and keyboard focus. Do not grant new OS security permissions to make a test pass.

On macOS with existing host automation access, run `node tests/electron/mac-native-project-creation-smoke.mjs` with the same trusted Python/query environment. It drives the actual directory picker of its owned Electron PID with a one-time accessibility launch flag. It checks native cancellation and focus return, mismatched paths, exact preview bytes/hash, explicit creation and existing-file refusal. Run it in the foreground without concurrent desktop input. It changes no OS permission or default accessibility setting. If automation access is denied, stop and report that check as blocked.

For actual Orca 1.4.222 display acceptance, use an existing disposable Orca workspace with an internal DAG and no live model/agent, after separately verifying the full target ID and source scope. Check the exact file appears without starting a model or creating a terminal/worktree. Keep external-vault/symlink cases unavailable unless that specific behavior is verified. Never use `worktree create` or inherited startup commands as a display fallback.

Preserve all prior Phase 1/2, pagination and updater checks. No remote push, merge or installed-app replacement is part of these instructions.
