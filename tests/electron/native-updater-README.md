# Native updater fixture acceptance (Mac only)

Run `npm run build` then `npm run test:electron:native-updater` on Mac with Electron installed. Optional `NOTE_APP_NATIVE_UPDATE_EVIDENCE` selects an evidence output directory; the default is ignored `test-results/native-updater`. It never selects an installation path or approved production target.

The harness creates canonicalized private `note-app-native-fixture-*` temporary homes. Two owned copies of Electron are ad hoc signed with the required user-role identity and private fixture marker. Synthetic SHA/build identities and prebuilt staged artifacts are intentional; there is no source download, production manifest approval, model, note access or source-preparation acceptance. The current host receives a main-only synthetic updater factory. Its actual cleanup/quit callbacks and private pending intent are used. A separate entry sets all app home/profile/cache paths inside the fixture before starting the production host. Normal production entry and default service are unchanged.

The native test seam refuses the OS user's real home, noncanonical/nonprivate paths, foreign owner/marker/bundles (including recovery backups), caller lifecycle/platform injection and unsupported deadlines. It invokes the real native lifecycle: codesign/Plist checks, PID identity/exit checks, copy/rename/hash verification and precise executable launch. The production CLI has no fixture switch.

Scenarios:

- Healthy: real current host cleanup and quit acknowledgement, actual old PID exit, signed replacement/backup, candidate production Vue/preload renderer mount and trusted main IPC boot acknowledgement, matching receipt.
- Crash: candidate deliberately exits without acknowledgement; installer restores exact old bytes and launches the restored app.
- Hang: candidate stays alive without acknowledgement; installer returns recovery-needed and retains both installed candidate and backup. The harness waits for its owned quit controller, sends a private token/PID-bound file request to `app.quit()`, verifies actual exit, then invokes recovery and verifies exact restoration/relaunch.

Cleanup uses the same authenticated fixture app.quit controller, never signals or forced process termination. All observed owned processes must exit before the temporary home is removed. A failed cleanup retains the fixture and reports the error. The current canonical user app, configuration and note/DAG sources are outside the fixture scope.

This is native component acceptance, including genuine production renderer/IPC acknowledgement within an isolated Electron home. It does not certify the unmodified production entry in the actual OS account, detached external installer CLI handoff, published-source preparation, canonical user replacement, all interrupted-install phases, or an event-loop-blocked process that cannot quit normally.
