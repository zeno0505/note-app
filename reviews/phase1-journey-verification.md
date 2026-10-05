# Phase 1 functional journey verification

Tested source: `6f845c580f955fa2a383854e07a9197e558e520a`, clean working tree.
This follows read-only integration `b1f90f32eb8a51d17f4308388177397967ef740c`.

## Results

- Full typecheck, **630 tests across 26 files**, and production build passed; the three optional private-query cases were enabled, with no skips
- Actual Electron Phase 1 journey passed at `2026-10-03T06:42:28.068Z`
- Existing actual Electron demo regression passed at `06:42:30.934Z`
- Existing actual Electron live regression passed at `06:42:38.049Z`
- Phase 1 run: six check groups, twelve screenshots, zero renderer exceptions, seven synthetic summary requests, zero real provider calls
- One automated UI approval persisted; one stale automated approval rejected. These are test actions, not actual user approvals
- All 45 tracked Phase 1 CLI/Python subprocesses and tracked Electron processes exited; temporary snapshots and owned fixture roots were removed

Phase 1 built-file manifest SHA-256:
`094bd13054d2a1e7b33587d29d43ac4344634c00684764569539d4e2606b2670`.
Exact per-file hashes, source identity and process lifecycle are in
`reviews/evidence/T-phase1-result.json`. The two regression manifests preserve
their own build-file identities because their test bundles are built separately.

## Summary user journey actually exercised

1. Connect explicit read-only sources and select at most 32 current DAG tasks
2. Inspect exact bounded task/direct-dependency context, missing goal and exclusions
3. Review Claude/Codex choice, CodeBurn usage/quota and unknown comparable budgets
4. Verify the normal production entry cannot execute a provider, including when test control variables and direct public IPC calls are present
5. In a separately built test-only entry using the same production host/preload/renderer, observe synthetic submission, waiting and TUI idle as distinct from a validated response
6. Display and persist a six-aspect candidate without approval; explicitly approve it once despite repeated clicks
7. Close/reopen Electron and restore that real app-owned cache without seeding it or replaying an approval
8. Reject stale approval after a real disk change without an intervening poll; reject the restored stale candidate while preserving older approved text/time
9. Reject unsupported citations, cancelled/late/source-changed/navigation results and ambiguous submissions without blind resend or cache promotion

The final synthetic response uses concise Korean inferences with exact citations,
an unknown goal and an explicit next proposal. It demonstrates rendering and
review flow, not real model accuracy. Production has no environment/configuration/
renderer switch to enable this test transport.

## Note connection user journey actually exercised

The production entry uses real Git and filesystem operations only inside a unique
temporary fictional repository with a genuine linked worktree.

- Select a registered narrow scope; preview canonical paths, directory/link creation, exact local exclude append and both sharing worktrees
- Cancel with no changes
- Change exclude bytes externally and reject the stale preview
- Preserve a conflicting existing note object
- Confirm once despite rapid clicks; verify the symlink and effective local exclusion
- Repeat as an identity-preserving no-op
- Leave source note bytes untouched

Forty-two backend tests additionally exercise rollback, concurrent foreign edits,
native EACCES, delayed/unsettled filesystem actions, invalid authority, fsmonitor
suppression and tracked-path/ignore overrides. Those injected rollback/partial
cases are backend evidence, not native UI timing-race proof.

## Review findings fixed before final run

- Approval now freshly validates the selected canonical mapping and DAG bytes rather than trusting the recent polling cache
- POSIX app cache root, scope and existing file require current effective ownership/private modes; unsafe caches are rejected without takeover
- Rollback never adopts a concurrent foreign replacement as transaction-owned data
- Git commands disable repository-configured fsmonitor/hooks, use sanitized environment and fixed argv, and verify actual tracking/ignore behavior
- Preview concurrency, descriptor cleanup, historical-state retention and late-write ambiguity are bounded and explicit
- New actions reject malformed authority and real foreign renderers; sandbox/context isolation remain enabled and Node stays absent in renderer

Independent review found no remaining blocking issue in these core changes.
Portable path APIs still cannot prove resistance to an adversary replacing parents
between checks and mutation; ACL/xattr preservation and power-loss recovery are not
certified. Partial/unknown outcomes require inspection and no automatic retry.

## Visual verification

All twelve final Phase 1 screenshots were individually opened after the final run.
Candidate/approved/restored distinctions, readable Korean six-aspect text,
unknown/stale/proposal warnings, exact path previews and the 800px layout were
legible with no blocking overlap or horizontal overflow. Long content scrolls.
The previous run's raw-structured synthetic wording is retained separately as an
earlier passed attempt; it is not the final readability image.

## Remaining acceptance, not a completion claim

**Phase 1 remains incomplete as a real end-to-end summarization product.** Real
agent transport, tool/MCP/customization denial, filesystem read confinement,
safe cancellation, actual billing/availability policy, real-project summary quality
and user readability approval remain gates. Goal/document/inbox excerpts are not
automatically fetched. Native Mac configuration, permissions/ACLs, performance and
packaged-app behavior remain unverified. See [outcome status](phase1-outcome-status.md)
and [Mac acceptance checklist](../docs/mac-acceptance.md).

No real provider call, user note-link modification, private query redistribution,
public upload, GitHub call, push, PR, deployment or canonical Mac DAG edit occurred.
