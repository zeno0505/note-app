# Source-based updater

## Fixed source and manual flow

The discovery endpoint is:
https://github.com/zeno0505/note-app/releases/latest/download/note-app-source-update.json

The repository is fixed to https://github.com/zeno0505/note-app.git. Users do not enter a SHA, manifest or repository URL. Check is manual, with no startup network lookup. A missing feed reports unavailable.

1. Check for an update in Settings
2. Review its version, build number, source identity and changelog
3. Prepare the exact source in an app-owned isolated checkout
4. Cancel preparation, choose Later, or review Install and restart
5. Confirm installation explicitly

The feed is HTTPS-only, verified with TLS and public-DNS restrictions, and bounded to 64 KiB, three redirects and 30 seconds. Manifests more than 90 days old or dated in the future fail closed. Publisher control of the fixed HTTPS repository is the trust root; integrity hashes are not publisher signatures.

The newest version/build and manifest digest are stored privately. Older releases and changed same-build manifests are rejected. Fresh check authority expires after one hour or clock reversal. Prepared state needs a new matching remote check after restart. A failed/cancelled check revokes install authority while preserving staged data.

## Preparation and trust

Preparation needs already installed Node.js 24+, npm and Git. Missing prerequisites are explained, never installed automatically. A new isolated Git repository fetches the exact full approved SHA with no credential prompt/helper and checks it out detached. The user's development checkout is not used or changed.

Clean source, regular tracked files, version and lockfile digest are validated. The approved source's dependency install, Electron setup, aggregate checks, build and local macOS packager execute with fixed arguments and bounded child processes. Source and dependency approval remain trust prerequisites: this is not a sandbox for malicious maintainer code.

Cancel waits for the owned process and verified process-group cleanup. Network, dependency and build failures leave the installed app untouched. Unverified cleanup blocks further preparation until restart.

## macOS installation boundary

Production installation targets the canonical user identity dev.noteapp.local at ~/Applications/note-app.app. Verification applications use a separate identity and cannot replace it. Both installed and candidate applications must implement updater protocol 1 and the startup interlock. An older application without that interlock needs a separately approved manual bootstrap.

The app uses private owned storage under ~/Library/Application Support/note-app-updater. A main-owned transaction and external installer validate identity, exact metadata, private paths, signature, complete bundle integrity and a single-flight lock. Installation waits for a durable readiness journal, a nonce-bound quit receipt and proof that the old application exited. It does not force-kill the application.

Retained backups and startup health receipts support rollback. Ambiguous paths or transaction state are preserved for inspection rather than deleted. Ad-hoc local signing is supported; notarization, paid signing credentials and operating-system security changes are outside this flow.

## Verification limits

The public source contains unit, source-feed, transaction and synthetic Electron tests. Optional query integration requires the external pinned query described in the root README. Linux/synthetic results do not establish native macOS installation, real remote release availability, successful source fetching through the public feed or actual rollback on a Mac.

The [release procedure](source-release.md) is a separate maintainer action. No workflow or automatic publisher is included.
