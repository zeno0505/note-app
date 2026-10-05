# Claude / Codex budget recommendation policy

`src/summary/budget/index.ts` exports `chooseAgent`, a pure advisory function. It reads no files, credentials, environment variables or usage databases, starts no process, and performs no network or paid action. It is deliberately separate from the narrow CodeBurn fact reader and any future Orca agent adapter. No provider quota, Orca command, or model price is assumed by the choice policy.

## Input contract

The caller supplies a request ID, its current epoch-millisecond time, an explicit maximum observation age, and separate Claude/Codex records:

- Availability is `available`, `unavailable`, or `unknown`, independently of usage retrieval. Missing or failed usage never implies provider unavailability.
- An observation is `observed`, `missing`, or `failed`. Observed amounts are normalized approximate monetary costs with an uppercase three-letter currency, exact half-open reporting window `[start, end)`, observation timestamp, and nonempty source provenance. No raw credential or raw usage log belongs here.
- An optional budget must explicitly be a `user-defined` approximate-cost cap with amount, currency and reporting window. The caller must obtain this cap from the user; tagging an inferred plan allowance as user-defined would violate the contract.
- An optional user override names one provider, the exact current request ID, and a future expiry. The caller must obtain that choice from the user. It is not a standing default or permission to execute.

All numbers must be finite. Costs and caps must be nonnegative, windows must be nonempty with nonnegative timestamps, observations cannot be future-dated and must fall inside their reporting windows. Invalid data fails closed. Source provenance records where the supplied observation came from; validation cannot establish its authenticity or completeness.

## Decisions

The result always has `executionAuthorized: false`, explanatory reason codes, and separate provider assessments. A recommendation is advice, never execution authorization or a guarantee that the next run fits a cap.

Without an override:

1. Fresh usage requires an age no greater than the supplied maximum and a reporting window that still contains `now`. Window boundaries and age limits are explicit; there is no invented reset schedule.
2. Assess usage against a cap only when unit, currency and exact window match. Missing, failed, invalid, stale, absent-cap and mismatched-cap evidence stays unknown, never zero.
3. Unknown availability or an available provider with unknown budget evidence requires an explicit choice. Providers actually known to be unavailable are excluded.
4. Observed cost at or above a user cap excludes that provider from a budget recommendation. Equality counts as reached, including a zero cap with zero usage.
5. Recommend the only available provider known below its cap, or, for two comparable providers, the lower observed-cost-to-user-cap fraction. Compare fractions only with matching units, currencies and windows. Equal fractions require a choice; provider names do not break ties.

An unexpired request-scoped override takes priority over the comparison. It requires known availability and cannot bypass a known reached cap or malformed selected-provider input. If budget evidence is missing, failed, stale or incomparable, the recommendation explicitly says `override-budget-unknown`. An invalid, expired, unavailable or cap-blocked override requires a new choice rather than silently selecting the other provider.

## Limits and integration

Observed approximate cost is not a subscription quota, provider balance, rate limit, remaining tokens, or next-run cost estimate. A fraction below one does not prove the next run is affordable. Fraction comparison balances observed utilization of user-defined caps; it does not claim one model is cheaper, better, or supported by a particular Orca version. No remaining-quota field is produced.

This module is not wired into the summary backend or settings UI. A future integration must separately verify Orca agent capabilities and the CodeBurn reporting-window timezone, normalize only documented fields, retain scope/completeness information, display these warnings, and require whatever execution and data-transmission authorization the summary workflow needs. Callers should not persist an override beyond its request or reinterpret the recommendation as permission to run an agent. Historical stale evidence cannot establish current cap status.

## Verification

Synthetic-only coverage is in `tests/unit/agent-budget.test.ts`. Run:

```
npx vitest run --root . tests/unit/agent-budget.test.ts
npm run typecheck
```

The tests cover missing and failed observations, staleness and window expiration, future timestamps, exact freshness and cap boundaries, zero caps, currency/window mismatch within and across providers, unavailable and unknown providers, reached/exceeded caps, equality, scoped overrides, malformed data, nonfinite values, provenance and input immutability. They do not claim to verify a real CodeBurn schema or an Orca agent transport.

## Narrow CodeBurn read-only projection

`codeburn.ts` exports `createCodeBurnReader` and `projectCodeBurn`. The documented CLI syntax was supplied by the parent task after inspecting official CodeBurn 0.9.25 on the user's Mac. This implementation was exercised only with synthetic executables in the cloud; it does not claim a real local integration test.

Trusted main-process configuration must supply an absolute executable path. The only allowed queries and argv are:

- `claude-status`: `status --format json --provider claude`
- `codex-status`: `status --format json --provider codex`
- `quota`: `quota --format json`

There is no PATH fallback, shell, arbitrary argument input, budget/plan query, settings mutation, or direct session/database/credential access in the adapter. The CLI may itself access its normal local data. Executable trust is the configuring caller's responsibility; an absolute path is not a signature check. Reads have a 5-second default timeout (60-second maximum) and a 512-KiB combined stdout/stderr limit (2-MiB maximum), reject overlap, and support AbortSignal cancellation. They reuse the existing isolated process-group cleanup helper; unverified cleanup disables further reads. That helper covers owned process groups on Unix and the direct child on Windows; escaped sessions are outside its guarantee.

Status projection retains currency and the reported today/month cost, savings and call count. These remain approximate observations, with `window: null` and `calendarBasis: unknown`: period labels do not identify an exact window without timezone and boundary facts. Status output cannot be passed directly into the policy as a known-window budget observation. No cap is synthesized; the inspected machine had no configured budgets, and the budget/plan output schema was not established.

Quota projection retains only known Claude/Codex records and their reported window label, used percentage and reset value. Reset values are deliberately tagged `resetTimeFormat: unverified`; they are not converted into epochs, reset schedules, or remaining quotas. Missing provider records become unknown. `available: false` means quota data is unavailable, and always leaves `agentAvailability: unknown`; it does not prove an agent executable is unavailable. The observed machine returned this unavailable state for both providers, with errors and no windows. Error strings are replaced by fixed `reported-error` or `unknown` markers, never exposed verbatim. Unknown fields are discarded and malformed known fields or contradictory records fail safely.

Successful results include the exact local read-completion timestamp and `codeburn-cli` provenance. This timestamp is not a source heartbeat or proof that underlying usage is complete or newly refreshed. Failures include a local failure-observation timestamp and fixed error kind, never stderr, stdout dumps, paths, raw errors or session details. Neither reader nor projection executes an agent or authorizes payment.

Run the synthetic reader checks with `npx vitest run --root . tests/unit/codeburn.test.ts`. Coverage includes exact allowlisted argv, shape failures, partial/failed quota data, sensitive-field dropping, process cancellation and overlap, timeout and termination, output bounds, invalid JSON/UTF-8, command failure, missing executable, and timestamp preservation. The policy tests remain separate.
