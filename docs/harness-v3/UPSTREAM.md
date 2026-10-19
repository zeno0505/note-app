# Harness v3 contract baseline

The imported contract and JSON fixtures are unchanged copies from
zeno0505/agent-skills commit a214e9d1df0e340863430509d69af48a24275781.

- Original contract: skills/harness-kit/references/link-contract.md
- Original fixtures: skills/harness-kit/references/link-contract.fixtures.json
- Fixture SHA-256: a8e5e3e5d0bd77c2731739794752fb03705d4f83f535395131d109f1421f5d18
- Fixture cases: 43. Expected objects are recursive subsets; arrays are exact.
- Test: npx vitest run --root . tests/unit/harness-link-contract.test.ts
- The suite has 43 unchanged upstream cases plus one byte-integrity assertion.

resolveHarnessLink interprets a caller-authorized, case-sensitive NFC snapshot.
It does not discover or read files, perform network access, execute document
scripts, record reading activity, or grant permission. A resolved URL is parsed
metadata, not proof that a remote file exists. Filesystem authorization and
no-follow snapshot acquisition belong to the main-side caller.

The test-only Python/PyYAML decoder materializes synthetic trees in temporary
directories. It is not a bundled runtime parser or a substitute for app, real-data,
or UI validation. NOTE_APP_CONTRACT_PYTHON may specify the trusted test Python;
the current Mac default is /usr/local/bin/python3.

This milestone does not connect the resolver to document IPC or change UI.
Mixed schema projection and existing document/AC display are subsequent work.
