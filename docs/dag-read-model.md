# Read-only DAG query boundary (T-014 partial)

## Acceptance criteria recorded before implementation

This slice addresses the approved T-014 requirements for declared status vocabulary,
external dependencies, E2E undeclared versus unmet coverage, commit references versus
verified facts, unchanged-source parse no-op, separate-process analysis, and bounded,
schema-validated worker output. It is a standalone main-side domain adapter. Actual
Electron integration, larger-DAG renderer/main responsiveness measurements, and the
project's task-completion evidence gate remain separate requirements. This slice does
not mark T-014 done or edit the authoritative DAG.

## External dependency and version contract

The application does not bundle or redistribute the supplied query implementation,
its skill text, its tests, or any set/render implementation. Configure an approved
private `query.py` location and an absolute trusted Python executable in main-process
configuration. Python must have PyYAML available in isolated mode (`-I`). The observed
runtime for these tests was PyYAML 6.0.3. No package installation is performed by the
adapter. Missing dependencies fail the observation; they do not become empty results.

The supported external script SHA256 is:

`23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47`

The adapter verifies the exact script bytes before compiling/executing those same
bytes in its child process. An upgrade requires explicit compatibility review and a
new reviewed pin. The fixed transport shim changes only the script's `emit` function
to collect structured results and serializes them as JSON. This is a **version-bound
compatibility shim**, not a claim that the Python module exposes a stable public API.
The original external `main()` executes its own parser and query logic. There is no
local YAML parser or reconstructed coverage/ready/dependency-closure implementation.

Observed official CLI shapes (the official CLI normally emits YAML):

```text
python3 <private-query.py> <explicit-dag-file> --index --fields id,title,status,depends_on,e2e,commits
python3 <private-query.py> <explicit-dag-file> --coverage --done-status <configured-done-status>
```

The adapter runs these modes against the same private, bounded, hash-checked snapshot
of the one registered DAG file. It never invokes `--brief` (which would consult a
sibling checklist), arbitrary fields/modes, set/render tools, or a shell. It neither
searches parent directories nor enumerates/recurses a vault. The private snapshot is
in a parent-owned temporary directory, removed by the parent in `finally`, including
after cancellation/timeout once pending filesystem operations settle. The bounded
response does not falsely claim that a stalled filesystem operation has been cancelled. Query stderr is counted against the output limit but is
never retained or exposed.

## Main-side interface and source authorization

`createDagReader(options).read(dagId, { signal? })` is main-only. The read call accepts
an opaque registered ID, not a path, command, environment, argv, or script body.

Trusted factory options are `pythonPath`, `queryScriptPath`, and `registrations`
(`dagId`, `canonicalDagPath`), with optional `doneStatus` and bounded limits. Register
only canonical files already resolved by the note mapper under an explicitly approved
narrow scope. A registration is not itself proof of scope authorization. The reader
does not replace the mapper or infer a vault scope. Re-resolve mappings when the
scope or linkage changes. The reader additionally rejects non-canonical paths and
final-component symlinks, checks regular files, and hashes before/after analysis.
Nonblocking opens avoid hanging on a replaced FIFO. Parent-directory namespace races
are not an OS sandbox; an adversarial concurrent filesystem writer requires stronger
OS-level source isolation. No arbitrary renderer registration API is provided.

Defaults and maxima:

- Response deadline: 5 seconds, configurable up to 60 seconds, subject to event-loop
  scheduling; independently races all main-side filesystem awaits and child cleanup
- Source bytes: 16 MiB, maximum 64 MiB; streamed hash on main, bounded snapshot in child
- Combined stdout/stderr: 2 MiB, maximum 8 MiB
- Tasks: at most 10,000; textual fields at most 4,096 characters
- Registered sources: at most 100; one read in flight per reader

Python is a trusted configured executable, not a sandbox for untrusted scripts.
Parsing is in a separate process, with cancellation and owned-process-group cleanup
shared with the Orca collector. Failed cleanup poisons the process runner. If a deadline/cancellation wins before the
observation settles, the reader returns immediately and is permanently poisoned for
reuse (`cleanup_unverified` on subsequent reads). The old operation retains cleanup
ownership: a late open is closed without reading, a pending read finishes before its
buffer is wiped/handle closed, and a late temporary-directory creation is removed
without spawning a child. No late operation can publish a success or refresh a cache.
Node cannot forcibly cancel kernel filesystem IO; indefinitely stalled operations may
retain resources until the kernel/OS releases them. Do not automatically recreate
readers to retry a poisoned source, which could accumulate unresolved IO. This is a
bounded response with fail-closed reuse, not a hard kernel-IO termination guarantee. POSIX
same-group termination does not contain deliberately escaped/new-session daemons;
Windows support is not established by these Linux tests. File size/output/time limits
are not a full process address-space quota. Main-side bounded JSON validation and
projection still consume event-loop time and need actual Electron measurement.

## Result and interpretation

Success is `{ ok: true, value, unchanged }`; failure is `{ ok: false, error }` with a
constant safe message and classified kind. No raw subprocess errors/source contents
escape. `value` includes source hash/mtime, DAG ID, observation timestamp, configured
done status, task projections, declared status counts, authoritative coverage, and an
empty `verifiedFacts` list. Returned values are detached from the private cache.

- `status` is the declared string, including future vocabulary, or null. It is never
  converted to agent activity, runtime state, or independently verified completion
- Dependencies identify internal task IDs versus external unresolved references.
  External references are retained; the adapter does not assume they are satisfied
- E2E `undeclared`, `unmet`, `not-required`, `references-declared`, and `malformed` are
  distinct. Declared references do not prove that tests executed or passed
- `coverage` is the official query's `tasks_total`, `declared`, `required`, and lists
  of `uncovered_done`, `uncovered_open`, and `malformed`, projected to camelCase/IDs
- `commitReferences` are strings from the declaration. `commitVerification` is always
  `not-performed`; no Git existence, build success, visual review, or test execution
  is inferred from them
- Free prose/descriptions, deviations, evidence bodies, paths inside arbitrary
  fields, and additional wire fields are not exposed by the task projection
- Incompatible shapes, duplicate task IDs, impossible totals, and invalid coverage
  references reject the whole observation. These are application projection bounds,
  not an assertion that all historical DAG formats use this shape

## Cache and store boundary

Every read asynchronously rehashes the bounded source, even when its mtime is the
same, so equal-size rewrites with restored mtime are detected. If the source hash is
unchanged, the query process is not spawned and no YAML is parsed. An mtime-only
change is also a parse no-op. Successful re-observation updates the observation
metadata. Changes during analysis fail instead of caching a mixed snapshot. After hashing,
the pathname is statted and its device/inode/metadata must still match the open
handle before even an unchanged-cache result is accepted. This covers atomic pathname
replacement after open but before the first handle stat. Only a
successful projection enters the cache; failure never returns an old value as fresh.

Use the existing snapshot store for stale/last-good policy. Map failure to
`{ kind: 'failure', error }`; map success to a full success result with `value`,
`runtimeId` scoped to the registered DAG identity, `coverage`, `sourceHash`, and
`observedAt`. A fresh store must receive a full value even if the reader itself says
`unchanged`. Once both caches are synchronized, the store's unchanged result may be
used. The store boundary test demonstrates that a failed refresh retains the previous
value with stale freshness and an error attempt. Unchanged is not an empty success.

## Verification

Commands (external paths supplied through environment, never checked into the repo):

```sh
npm run typecheck
npx vitest run --root . tests/unit/dag-read-model.test.ts
DAG_QUERY_PYTHON=<absolute-python> DAG_QUERY_SCRIPT=<private-approved-query.py> \
  npx vitest run --root . tests/unit/dag-read-model.test.ts
```

On 2026-10-02 UTC the external-enabled command passed 29/29 tests and typecheck passed.
Tests cover the allowlisted projection, incompatible schemas, source/combined-output
bounds, opaque registrations, symlink rejection, cancellation/overlap, child cleanup,
source races (including atomic replace on the cached-read path), stalled/delayed IO
deadlines, late-handle cleanup, poisoned reuse, hash cache no-op, equal-size rewrites, fail-closed script pin, and stale
last-good at the store boundary. The actual external query was exercised only on
locally authored synthetic YAML/JSON-subset DAGs; source bytes and mtime stayed
unchanged. A 1,000-task synthetic input allowed the Node event-loop heartbeat to keep
running during parsing. This is a limited unit/integration responsiveness check,
**not** actual Electron E2E, a resource benchmark, real user DAG verification, or a
Mac validation result. Without the private dependency environment variables the
three actual-query tests are explicitly skipped; synthetic process tests still run.
