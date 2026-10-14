# Source updater UI fixture

```sh
npm run build
node tests/electron/update-smoke.mjs
```

The test builds `update-fixture/main.ts`, launches the real Electron host with the
production Vue renderer and isolated preload, and uses an explicit main-only
synthetic `UpdateService`. It never invokes the real installer, fetches update
source, publishes an approved target, or invokes a model. Normal production
startup does not read the fixture's environment variables.

Coverage: no automatic check; absent publication; latest build; missing runtime;
error and retry; changelog escaping; full build identity; repeated preparation;
cancellation and late completion; leaving and returning during preparation;
Later; keyboard confirmation dismissal and focus restoration; light/dark narrow
layouts; explicit install confirmation with exactly one synthetic call.

`NOTE_APP_UPDATE_EVIDENCE` selects the screenshot/report directory. The test
uses a temporary profile and removes it after successful process cleanup.
`NOTE_APP_E2E_HEADLESS=1` opts into Chromium's headless Ozone platform on Linux;
it does not disable sandboxing. A runtime that blocks local UNIX sockets cannot
run Electron's single-instance lock even in headless mode. Such a startup
failure is a test blocker, not a UI pass or macOS installation verification.
