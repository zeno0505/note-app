# Recovery: fixture terminal contract and Korean review corpus

Status: **fixture-only groundwork; production transport remains blocked**.
No real Orca terminal, Claude/Codex run, provider API, network call, user note
write, or summary-cache write is performed by this work. No real model quality
measurement or safe remote cancellation is claimed.

## Evidence boundary

The historical interface identified as Orca **1.4.217** supports these known
command forms. They were supplied as recovery evidence, not re-observed here:

```text
terminal create --worktree <selector> --command <claude|codex> --json
terminal send --terminal <handle> --text <bounded-prompt> --enter --json
  optional: --wait-submit <seconds> --retry-request <returned-id>
terminal read --terminal <handle> --cursor <n> --limit <n> --json
terminal wait --terminal <handle> --for tui-idle --timeout-ms <ms> --json
```

Only the generic envelope `{id, ok, result, _meta: {runtimeId}}` is known.
Exact command-specific `result` fields, output framing, cursor/limit units,
retry outcomes, and a safe cancellation operation remain **unverified**.
`decodeRealOrcaTerminalResult` is intentionally **UNIMPLEMENTED** and always
throws, including for successful-looking envelopes. No terminal handle, retry
identity, submission status or response body is guessed from wire results.
There is no guessed terminal kill/close command. Read-only collector process
cleanup is not evidence that a long-lived terminal agent can be safely stopped.

## Isolated fixture seam

`src/summary/workflow/fixture-terminal.ts` has no execution or filesystem API.
Its command arrays are inert plans and never grant execution authority. It is
not imported by the production workflow, renderer IPC, collector or test
Electron transport. Existing synthetic workflow tests remain the integration
seam; this new module exercises only the missing terminal contract boundaries.

Every fixture session is explicitly marked `fixture-only`, declares a simulated
owner, and binds **owner, ticket, run, runtime, terminal handle and process
incarnation**. All subsequent operations and observations must match every
field. The binding is copied and frozen. This is a test of ownership checks,
not evidence that authentic ownership can yet be obtained from Orca.

Application-authored fixture observations such as `accepted`, `submitted`,
`turn-start`, and read metadata are **not Orca wire fields**. Their ordering and
numeric bounds are conservative local test policy, not claims about Orca's
unverified result schema.

The tests exercise:

- Send planning, acceptance, submission and turn start as distinct observations
- No blind resubmission after a send plan or ambiguous submission
- An explicit retry plan only for the same returned retry ID, exact payload,
  runtime/terminal/run/ticket/owner and incarnation; the original wait-submit
  option is retained, and a second retry plan is refused
- No automatic execution or retry; ambiguity remains visible after retry planning
- Read plans tied to the outstanding sequence and current cursor, bounded units
  and monotonic next cursor; no overlapping or stale reads
- Independent UTF-8 caps for prompt (16 KiB), each read (32 KiB), and accumulated
  output (128 KiB), with at most 256 retained events and 128 units per read
- Exact duplicate event suppression without double-counting output; conflicting
  payloads under the same event ID are errors
- `tui-idle` as an observation only; it never means successful semantic completion
- Local invalidation rejecting late events and clearing buffered output without
  claiming remote cancellation or sending any cancellation command

`semanticCompletion` and `remoteCancellationVerified` remain false. Buffered
fixture text is still untrusted data. Even a well-formed candidate must pass the
existing binding/provenance/schema checks, freshness handling and user review;
these checks do not establish semantic truth or authorize execution.

## Korean quality fixtures

`fixtures/summary-quality/korean-review-cases.json` contains fictional records,
a human-authored Korean reference answer, and **15 authored review cases**.
The six existing aspects are `goal`, `implemented`, `remaining`, `current`,
`next`, and `blockers`. They are deliberately kept aligned with the application
contract instead of introducing another summary taxonomy.

The corpus includes:

- One concise six-aspect reference, with dated declarations and explicit unknowns
- Six negative cases omitting each aspect in turn
- Unsupported wording that promotes `done` into tested/deployed/accepted, or a
  connected terminal into proof of active agent work
- A stale source hash and an old `running` declaration promoted to current fact
- A structural proposal violation and an inference that claims execution approval
  while deceptively retaining the `proposal` field
- Repetitive Korean prose that fits the byte budget but fails the concision rubric

`expectedParser` and `expectedInitialStore` are executable structural
expectations. The low-level parser permits partial claim sets for incremental
updates; the initial store enforces all six aspects. The omission cases verify
this difference rather than falsely claiming the parser enforces completeness.

`expectedReview` and the Korean reasons are **curated expected review labels**,
not outputs of an automated semantic evaluator. Six semantic negative cases
intentionally pass both structural checks. Tests preserve that limitation:
valid citations, schema, and byte bounds cannot prove entailment, current truth,
proposal wording or useful concision. The reference is also only a reviewed
fixture target; its acceptance is not evidence that a real model can produce it.
A separate context-change test verifies that affected evidence becomes stale
without rewriting or automatically approving the earlier candidate.

Actual model evaluation remains **not run**. It requires an approved, verified
transport and then independent review against the source records and rubric.
Do not report this corpus as a model success rate or six-aspect quality pass.

## Verification and remaining release gates

Run the isolated contract/corpus tests with:

```sh
npx vitest run --root . tests/unit/fixture-terminal.test.ts
npm run typecheck
```

Before any production terminal adapter can be enabled, independently verify:

1. Sanitized, authorized result samples and exact versioned result schemas for
   create, send, read and wait, including every ambiguous/retry/failure outcome
2. Authentic ownership and binding across runtime restart, terminal reuse,
   superseded tickets, concurrent runs and late/duplicate observations
3. Provider-enforced filesystem/tool confinement; instructions alone are not a
   sandbox, and a worktree selector does not establish an access boundary
4. Output framing and read/cursor semantics, bounded byte capture, actual turn
   start, semantic-response validation and response timeouts
5. Safe cancellation and cleanup ownership without signaling an unrelated agent
6. Budget behavior and explicit user-run authorization before any real invocation
7. Separate Korean model-quality review using the supplied evidence, freshness,
   omissions, unsupported wording, proposals and concision rubric

Nothing in these fixture tests relaxes `SUMMARY_TRANSPORT_GATE` or the existing
user review and persistence boundaries.

### Recovery verification, 2026-10-05

- Focused fixture suite: 35 tests passed
- `npm run check`: typecheck passed, 28 unit test files passed (708 tests passed,
  3 skipped), production build passed
- The aggregate run was on the shared recovery checkout while other workers
  were active, before further workflow edits were observed. It is an observed
  pass, not certification of an immutable final commit; rerun on the final tree
- `git diff --check`: passed
- Production imports: only the unit test imports the fixture-terminal module
- Real terminal/model execution, real model quality, and remote cancellation:
  **not run / not verified**
- Electron/macOS acceptance: not established by this fixture work
