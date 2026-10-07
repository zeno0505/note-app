# Phase 2 repository usage collector

This adapter adds a bounded CodeBurn reporting reader and a detached usage projection for T-043/T-051. Verification in this change is synthetic. No installed CodeBurn command was executed against user data; no credentials, account profiles, private caches, or session files were opened by this implementation task. This document does not establish real Mac accuracy or complete source coverage.

## Reviewed upstream contract

The source was read at the explicit **v0.9.25** tag on 2026-10-07, not inferred from a screenshot or the current default branch:

- [branch-spend.ts](https://github.com/getagentseal/codeburn/blob/v0.9.25/src/branch-spend.ts): blob `7ef55e9cc1ced637e7df2ce9216245bf96cb4c5e`; report, project, branch, session, token and coverage definitions and construction
- [main.ts, spend command](https://github.com/getagentseal/codeburn/blob/v0.9.25/src/main.ts#L2955-L2992): blob `39d043fa93ff7bfad89ced145bf1603cbde84f16`; `spend --format branch-json`, provider and period options, direct report serialization
- [cli-date.ts](https://github.com/getagentseal/codeburn/blob/v0.9.25/src/cli-date.ts): blob `3b4b5fffbc90f0578d397fdef3b149a0749b91d2`; today/month calendar windows, inclusive end-of-day, ISO period timestamps
- [spend-flow.ts](https://github.com/getagentseal/codeburn/blob/v0.9.25/src/spend-flow.ts): blob `4c533e49d3658d3cda697ef6ae0c1d8398102ba1`; project-path identity and legacy display-label fallback; flow-json's top-eight/other aggregation is unsuitable for this collector
- [behavioral-weight.ts](https://github.com/getagentseal/codeburn/blob/v0.9.25/src/behavioral-weight.ts): blob `1370c2d8b9b49db4a0e0ee4628ffd3d7a84061ea`; behavioral request counts exclude supplementary accounting calls, while token/cost sums retain them

The accepted wire shape is:

```text
report
  period: { label, start, end }
  projects[]
    id, label, optional originKey, totalCost
    coverage: { branchKnownCost, branchUnknownCost, noBranchDataCost,
                noBranchDataSessions, noBranchDataProviders[], distinctSessions }
    branches[]
      projectId, projectLabel, branch (string or null), cost, calls, sessions
      tokens: { inputTokens, outputTokens, reasoningTokens,
                cacheReadTokens, cacheWriteTokens }
      firstActive, lastActive (ISO strings or null)
      worktrees[]: { path, sessions, cost }
      sessionRows[]
        sessionId, provider, optional workingDirectory, optional isSidechain
        cost, calls, tokens, models[], firstActive, lastActive
  totals: coverage shape
```

Unknown additional fields are discarded. Session titles and model labels are intentionally not included in the detached projection; model arrays are checked for schema compatibility. No account or DAG task identity is provided by this report. A newer installed version is accepted only if its emitted data satisfies this reviewed shape and consistency checks; the adapter does not pretend to detect the installed version.

Important upstream semantics:

1. Costs are accumulated from `costUSD` directly, so branch-json reports estimated USD independently of the status command's display currency. They are not bills, credits or quota consumption.
2. Sessions that never reported a branch contribute cost and count to `noBranchData*`, but have **no session rows, checkout detail or token splits** in this report. Their absence is not zero usage. A Codex-only project can therefore have reported cost and unknown tokens.
3. A session can contribute separate usage slices to several branches. Row session counts must not be added to obtain a distinct-session count. Project `distinctSessions` counts branch-bearing sessions; report totals include no-branch sessions as implemented upstream.
4. `branch: null` is a genuine unknown branch, not `main` or the current branch. Historical session `workingDirectory` is retained independently of canonical project `id`.
5. A project ID can be a legacy label when the upstream path was unavailable. Even an absolute project ID is source evidence, not proof of a Git repository. Optional `originKey` is never used as the identity key here.
6. The output has explicit time boundaries but does not identify the chosen calendar timezone. Today and month overlap and must not be added. The adapter preserves both timestamps and the unknown timezone. It does not fabricate daily time-series points from first/last session activity.

## Public API and runtime input

Implementation: `src/phase2/repository-usage.ts`. It is a **main-process module** because it imports the process runner. Renderer consumers must use type-only imports of `RepositoryUsageView` and receive already projected data.

```ts
const reader = createRepositoryUsageReader({
  executablePath: trustedConfiguration.codeburnExecutable,
  timeoutMs: 5000,
  maxOutputBytes: 512 * 1024,
});
const result = await reader.read('today', { signal });
const view = projectRepositoryUsage(result, observedContext, freshness, lastSuccessful);
```

The runtime owns configuration/observation callbacks. It supplies the existing trusted executable path and a snapshot of already observed checkout/repository metadata. No renderer input becomes executable, command flags or filesystem locations.

```ts
type RepositoryUsagePeriod = 'today' | 'month';
type ObservedRepositoryCheckout = {
  workstreamId: string;
  hostId: string;
  repositoryId: string | null;
  repositoryKey: string | null;
  checkoutPath: string;
  registeredProjectId: string | null;
};
type RepositoryUsageContext = {
  localHostId: string;
  checkouts: readonly ObservedRepositoryCheckout[];
};
```

`decodeRepositoryUsage(query, input, observedAt)` is the pure strict decoder. `projectRepositoryUsage(result, context, freshness = 'unknown', lastSuccessful?)` returns state, source, period, observation/attempt/success times, current/stale/unknown freshness, unknown corpus coverage, project/branch/session facts, correspondence evidence and sanitized errors. A failed refresh can retain only a same-query earlier success; chart values then become null. Cross-period replay is rejected.

`match.workstreamIds` connects an exact observed checkout to the existing workspace. Matching requires the collector's local host and an exact already observed absolute checkout path with repository IDs. It does not call realpath, read Git state, search parent directories or infer aliases. Supplied canonical aliases must have been verified by the caller before becoming observed input.

Every project row retains `codeburnProjectId`, `originKey` and its session checkouts separately. Shared origins do not merge clones. Project and session matches are independent: a linked worktree's session can match even if its canonical project path has no observed checkout. Missing, non-absolute or contradictory evidence stays unknown/conflict. Same paths on remote hosts cannot match. Current path correspondence does not prove that historical ownership never changed; the view says so.

The three display tiers remain separate:

- registered-project: the exact matched checkout has a supplied registered project reference
- repository-unregistered: the exact checkout has a verified repository identity but no registered project reference
- repository-unknown: repository evidence is absent or conflicting

Every session's `taskLinkage.state` stays `unknown`, with empty task IDs. A missing DAG task ID never establishes an untracked task. `accountRef` stays null. No quota-to-repository conversion or account aggregation is performed.

`branchTokens` sums only the branch-bearing recorded population. `tokens` is null when no-branch sessions/cost exist or when no branch rows exist. Coverage of all accounts/session sources remains unknown even when token details exist for every returned row. Missing project rows create no zero values.

## Execution and decoder bounds

Exactly two reviewed argv sequences are available:

```text
spend --format branch-json --period today --provider all
spend --format branch-json --period month --provider all
```

There is no shell, PATH lookup, custom argv, custom cwd, arbitrary environment, project path flag, custom date range, credential option, account setup, cache reader or fallback scan in this adapter. CodeBurn is a trusted configured executable, not a sandboxed executable: its own normal reporting implementation can consult its configured sources and manage its internal pricing/session caches. This adapter does not claim those internals are filesystem-write-free. No real execution was performed for this change.

- Default timeout: 5 seconds, configurable in trusted main code up to 60 seconds
- Combined stdout/stderr byte limit: 512 KiB by default, maximum 2 MiB
- One request per reader; overlapping calls return busy
- Abort and timeout terminate only the process group owned by this request
- Existing `finalizeQueryGroup` verifies cleanup; an unverifiable result permanently disables that reader instance
- POSIX process groups use TERM/KILL. Existing cleanup utility limitations still apply: escaped new-session daemons are not tracked; Windows covers the direct child only
- Strict UTF-8 and JSON parsing; stdout buffers are wiped after use; stderr is counted but not retained, with only a presence flag exposed
- Maximum 1,000 projects, 2,000 branches per project, 10,000 session rows per branch, 5,000 worktree rows per branch, and 20,000 combined nested rows
- Duplicate project IDs/branches/within-branch provider-session identities, missing required fields, invalid dates, nonfinite/negative metrics, unsafe counts, parent mismatch and inconsistent cost/token/worktree totals fail closed
- Output exceeding a bound is a failure, not a silently truncated complete report
- Diagnostic details, paths from spawn errors and arbitrary stderr never enter the returned error

The source exposes no reliable complete-source flag. `coverage: 'unknown'` is therefore intentional even for successful full JSON transport. `coverageEvidence` retains the upstream branch/no-branch splits separately.

## Verification and remaining gates

Focused synthetic tests are in `tests/unit/phase2-repository-usage.test.ts`. They exercise wire decoding, period semantics, branch switching, no-branch records, unknown fields, malformed/duplicate totals, optional fields, timezone offsets, exact local matching, separate clones and linked worktrees, remote-host mismatch, three tiers, task/account unknowns, stale retention, fixed argv, byte limits, cancellation, overlap, startup timeout, sanitized failures and fail-closed cleanup.

Run with:

```sh
npx vitest run --root . tests/unit/phase2-repository-usage.test.ts tests/unit/codeburn.test.ts
npm run typecheck
```

Live runtime wiring/UI adoption and real Mac acceptance remain distinct verification steps. A real authorized run must check installed contract compatibility, source permissions and stderr presence, local-host/checkout correspondence, no-branch coverage, refresh cost, cancellation/descendant cleanup, stale display, and account/source omissions before claiming collection accuracy. No actual account connection, credential access or new provider setup is part of this module.
