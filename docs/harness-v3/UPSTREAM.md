# Harness v3 contract baseline

The imported contract and JSON fixtures are unchanged copies from
zeno0505/agent-skills commit a214e9d1df0e340863430509d69af48a24275781.

- Original contract: skills/harness-kit/references/link-contract.md
- Original fixtures: skills/harness-kit/references/link-contract.fixtures.json
- Fixture SHA-256: a8e5e3e5d0bd77c2731739794752fb03705d4f83f535395131d109f1421f5d18
- Fixture cases: 43. Expected objects are recursive subsets; arrays are exact.
- Test: npx vitest run --root . tests/unit/harness-link-contract.test.ts
- The suite has 43 unchanged upstream cases plus one byte-integrity assertion.
- The synthetic render-v3-dag.yaml example is from the same pinned commit.

resolveHarnessLink interprets a caller-authorized, case-sensitive NFC snapshot.
It does not discover or read files, perform network access, execute document
scripts, record reading activity, or grant permission. A resolved URL is parsed
metadata, not proof that a remote file exists.

The runtime and fixture suite use the same bounded data-only yaml parser. The
main-side snapshot adapter reads only an existing authorized project root through
no-follow evidence readers and pinned directory metadata. It does not scan an
entire vault to resolve IDs. Incomplete, changing, oversized or unsafe indexes
cannot establish a missing or unique target. The index is intentionally bounded
(256 Markdown/YAML files, 64 directories, 4 MiB content); unsupported results and
omissions remain visible. A fresh evidence capability revalidates an opened file.

The query transport accepts exactly the old query SHA-256
23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47 and the
a214e9d query SHA-256
f75690f800fe4354a5b9b37f1672d2ad824c941baa94186fd134b4898d7fe2b0.
The external query is not bundled. Set DAG_QUERY_PYTHON and DAG_QUERY_SCRIPT to
run opt-in query integration tests. Its wire version remains independent of the
ledger's numeric schema. Unknown schema/features are not silently promoted.

Existing task details display v3 declarations and recorded evidence separately.
`met` is a declaration; every AC retains `검사 결과 연결 미확인` pending the
upstream per-check result contract. Clicking or viewing never creates approval
or execution evidence.

Shared main is the last successfully observed **local refs/heads/main commit**,
not a claim about current remote state. Its exact committed ledger blob is read
only with existing permission for the repository and Git metadata; indirect Git
configuration, alternate/promisor object stores and unsafe metadata fail closed.
This observation is separate from the current session file, including dirty
working changes. It refreshes on manual refresh; failed refresh preserves the
previous observation with a warning. No fetch, pull, merge or push is performed.
Main details show up to 100 tasks and preserve the declared total. Missing scope,
runtime or main produces an explicit unobserved state, never an empty shared DAG.

Unit, synthetic Git/IPC integration and isolated headless component rendering do
not establish actual app interaction, real-data behavior, native Mac focus,
keyboard/screen-reader behavior or real-person usability. Those checks remain
separate and must not be inferred from this implementation or its passing tests.
