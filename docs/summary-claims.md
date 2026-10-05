# Summary claim and approval preservation contracts

## Scope and acceptance baseline

This is the isolated, synchronous, in-memory contract foundation for transferred
T-015 (source/task/document ID, hash, observation time, fact/inference/unknown,
preservation of approved summaries) and T-017 (affected-claim refresh, no-change
no-op, deletion uncertainty, prior approval preservation). It is not completion
of the backend, persistent storage, renderer integration, or T-017 Electron flow.
No agent invocation, filesystem operation, network request, execution approval,
or DAG traversal occurs in this module. The source adapter remains responsible
for truthful source hashes and extracted records; these are not proof of code
correctness or test/deployment results.

## Response boundary

`parseSummaryResponse(unknown, pack)` accepts a bounded plain-data object or a
bounded JSON string and returns a detached, recursively frozen candidate. The
response must bind the exact scope ID, response-schema fingerprint exported as
`SUMMARY_RESPONSE_SCHEMA_HASH`, and the context pack's `packHash`. Context-pack
integrity is recomputed before use. The response schema fingerprint is separate
from the context schema fingerprint. Unknown fields (including model approval),
accessors, sparse arrays, noncanonical times, duplicate claim/citation IDs,
unsupported assertions and over-budget data are rejected. Maximum response is
128 KiB; 48 claims, 16 citations and 16 assertions per claim; text is 4 KiB and
quote 8 KiB. These independent bounds also limit direct-object parsing work.
Only inert trusted-builder packs and deserialized/plain response data belong at
this boundary; arbitrary JavaScript Proxies are not a sandboxed input format.

A claim has `claimId`, `aspect`, `kind`, `text`, `intent`, `citations`, and
`assertions`. Aspects are `goal`, `implemented`, `remaining`, `current`, `next`,
and `blockers`, covering purpose plus where work stands, current work, proposed
next work and blockers. The initial accepted response must cover all six.

Citations contain `sourceId`, `sourceHash`, `observedAt`, and an exact `quote`.
Only included `pack.records` may be cited: a source manifest entry without its
included text is insufficient. Response generation cannot predate cited
observations. A fact is a reported verbatim source excerpt; a paraphrase must be
an inference. Facts and inferences require citations. Unknown claims may omit
citations and must not contain declared-status assertions. The only supported
structured assertion is `{ type: 'declared-status', sourceId, status }`, checked
against a cited record. No structured tested/deployed/ready/priority/execution
approval assertion is accepted. A source's `done` is only its declared status.
Next claims must be inference/unknown and `intent: 'proposal'`.

**Semantic limit:** exact excerpts and consistent IDs do not establish truth,
completeness, relevance, or entailment. An excerpt can itself be false or
misleading, and a free-text inference can make unsupported claims. This parser
does not pretend regex matching or schema validation solves semantic review.
Every result remains a candidate. User review is required before summary
approval; approval of a summary never authorizes its proposed work.

## Store and refresh flow

1. Build an authorized context pack, then `createSummaryStore(pack)`
2. `beginUpdate()` returns a versioned, bound ticket, or null when no work is due
3. Pass the model result to `acceptResponse(ticket, response)`; invalid results
   preserve the prior candidate and approved snapshot, recording failure
4. Host UI separately calls `approve` with a `user-summary-approval` event,
   matching scope/candidate hash/version, approval ID and canonical time
5. `updateContext(nextPack)` invalidates only affected claims, or conservatively
   all scope aspects when source additions/coverage changes affect aggregates
6. A subsequent ticket lists affected claim IDs; delta responses must replace
   exactly those IDs and retain their aspects. Unaffected claims and their
   original source observation times are preserved

The host must authenticate the approval event as an actual user action. This
pure module is not an authorization service, and its approval method must never
be exposed as an agent-callable tool. Approval time cannot predate generation.
Model output cannot create approval. Late requests, superseded concurrent
requests and old-version approvals cannot replace newer state. Approval itself
invalidates outstanding requests. Explicit failures permit a retry without
removing approved content.

Identity includes source hashes, stable extracted text/status/dependencies and
coverage, not just upstream hashes. A change in extracted meaning with an
unchanged upstream hash still invalidates cited claims. Observation-time-only
updates are no-ops: the existing pack binding and observation times remain, and
no model refresh is scheduled. Source additions and coverage changes invalidate
aggregate claims conservatively because this contract has no stronger aggregate
dependency graph. This is a justified affected-scope refresh, not an unconditional
whole-summary recomputation. Coverage loss marks these claims unknown. Removed
or unobserved cited sources mark their claims unknown. If an extraction is
budget-excluded in either provenance basis or current context, the claim is
conservatively unknown until refreshed with included evidence; changed evidence marks
claims stale. The original approved summary and approval metadata remain intact
and are shown alongside separate freshness annotations. An approved snapshot is
historical approval, not a current-truth badge. Stale supported claims cannot be
reapproved before refresh; explicitly unknown claims can be reviewed as unknown.

Snapshots, candidate responses and tickets are detached and frozen. Persistence
is process-local only: restarting loses this store. There is no disk cache,
transactional disk guarantee or crash recovery claim. Future storage and IPC
adapters must preserve these checks and approval provenance, and be independently
tested; production integration is intentionally pending.

## Verification

Run `npx vitest run --root . tests/unit/summary-claims.test.ts` and
`npx vue-tsc --noEmit`. Unit coverage includes scope/schema/pack mismatch,
excluded/mismatched citations, unsupported assertions, model self-approval,
chronology, object/array/byte bounds, immutability, no-change updates, same-hash
semantic changes, additions, partial coverage, deletion, failed refresh,
prior-approval retention, exact incremental replacement, concurrent requests and
version guards. These tests do not invoke a real agent or establish an Electron
UI/backend integration result.
