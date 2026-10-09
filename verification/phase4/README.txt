Synthetic actual-module metadata probe

This bundle runs the exact current Phase4 metadata transport. It creates and removes synthetic directories, reads directory entry metadata only, and uses the explicitly supplied existing trusted Python interpreter. It performs no network requests, document-body reads, app installation or source changes.

Node:
PHASE4_PYTHON=/absolute/existing/trusted/python3 node probe.cjs > node-module-result.json

Actual Electron main (unset ELECTRON_RUN_AS_NODE):
PHASE4_PYTHON=/absolute/existing/trusted/python3 PHASE4_PROFILE=/absolute/new/disposable/profile /absolute/existing/Electron probe.cjs > electron-main-module-result.json

An explicit disposable Electron profile is mandatory. Use a verified executable path; do not replace or launch the installed note-app's ordinary main entry. The bundle launches no BrowserWindow. After process exit, remove only the test-owned disposable profile. Capture the exit code and result JSON. Failure is reported as failed; a primitive os.scandir probe does not replace this actual-module check.

Checks: 313-file metadata listing, nested no-follow stat, inherited directory survives parent replacement, expected child inode replacement rejected, symlink descendant rejected, pre-cancel denial and explicit partial listing.
