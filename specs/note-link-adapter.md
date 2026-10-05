# Scoped note-link adapter proposal — implemented cloud workflow

Update 2026-10-03: the subsequently authorized Phase 1 user-flow work implements
the separate scoped TypeScript adapter in `src/collector/notes/link-workflow`.
Preview/confirmation and temporary Git tests now exist; the old whole-vault script
remains untouched. The proposal below is retained as design history. Real user
note changes still require the exact preview confirmation, and Mac acceptance is
separate. See the implementation README and current Phase 1 outcome checklist.

This document prepares the design decision only. It does not authorize or implement note-link writes, modify the existing script, or waive preview/confirmation.

## Known constraint

The previously inspected script takes no arguments and fixes its note target to the whole vault. It preserves an existing symlink and adds a local Git exclude entry. Therefore invoking it unchanged cannot faithfully express a selected project note scope. Do not call the no-argument script as a workaround or silently link the whole vault.

## Proposed option for approval

Implement a separate, narrowly scoped TypeScript adapter in the Electron main/worker boundary, preserving the original script unchanged. Reuse its intended behavior (non-destructive link creation and local Git exclusion), not its unsafe fixed-target invocation. Alternative: a separately reviewed parameterized revision of the existing script, but that would be a later explicitly authorized change on the machine holding it.

Decision needed: approve the separate scoped adapter, or prefer a future reviewed script extension. No option is considered approved by this document.

## Proposed read-only preview

1. Renderer submits selected worktree/scope identifiers, never an executable, raw shell string or arbitrary path
2. Main resolves identifiers from authorized configuration and revalidates worktree, note realpath and strict selected scope; whole-vault roots, outside paths and ambiguous registrations fail closed
3. Query Git with fixed argument arrays and a known executable, never shell concatenation. Resolve top-level worktree, common Git directory and `info/exclude` via Git rather than assuming `.git` is a directory. Reject conflicting/relocated metadata outside the authorized repository authority
4. Preview shows canonical source and destination, every proposed filesystem change, current conflict/no-op state, and all linked worktrees sharing the local exclude target
5. Generate an expiring preview identity bound to paths, filesystem identity/metadata, prior exclude bytes/hash and exact proposed bytes. It is a proposal, not a write capability

Git documents that `rev-parse` can resolve the common directory and Git paths with absolute-path output. The common repository's `info` area can be shared across linked worktrees; preview must disclose that scope. Sources: [git-rev-parse](https://git-scm.com/docs/git-rev-parse), [repository layout](https://git-scm.com/docs/gitrepository-layout/2.45.0).

## Proposed confirmed transaction

- Require explicit confirmation of that preview before any real link/exclude mutation
- Revalidate the authority chain, links, selected scope, preview identity and file bytes immediately before writes; reject stale previews
- Never overwrite a file, directory, existing different symlink or broken link at the destination
- Treat an already-correct link and already-present exact exclude rule as an idempotent no-op
- Preserve existing exclude bytes/newlines and unrelated rules; append only the required local rule, without modifying tracked `.gitignore`
- Detect concurrent edits before replacing bytes. If safety cannot be established, stop rather than guessing a merge
- On failure, undo only changes proven to have been created by this transaction and still unchanged; preserve pre-existing state and concurrent edits. If ownership cannot be proven, report partial failure and a reviewable recovery plan
- No elevated permissions, symlink-following write shortcuts, whole-vault scans or autonomous fallback script invocation

## Verification required before later completion

T-012/T-013 must test temporary Git repositories and real linked-worktree metadata, relative gitdir/commondir, shared excludes, no-op repetition, missing parent directories, existing file/directory/link/broken-link conflicts, option/path injection, preview cancellation, stale previews, permission failures, interrupted writes and rollback with concurrent edits. Final code must be exercised in actual Electron and UI screenshots opened. Real user note changes require the confirmed preview; macOS native selection/dialog verification remains separate.

Original proposal status: decision pending at the time this design was written.
See the update above for the implemented, temporary-fixture-tested workflow.
