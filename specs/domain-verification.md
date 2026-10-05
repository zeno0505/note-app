# Domain and fixture verification

Status: focused contract/fixture preparation verified; no DAG task marked done. This record does not certify live Orca, note mapping, renderer integration, macOS behavior or a packaged release.

- Record time: 2026-10-02T17:14:39Z
- Final focused execution: 2026-10-02 17:13:50 UTC (Vitest renders host-local start time as 02:13:50)
- Environment: `Linux 6.18.44 x86_64 GNU/Linux`
- Host Node: `v24.19.0`; Vitest: `4.1.11`; TypeScript: `5.9.3`
- Scope: `src/domain/`, `fixtures/`, and `tests/unit/domain-contract.test.ts`
- Requirement criteria and requirement hashes: `specs/information-contract.md`
- Source-set SHA-256: `93412c70136747bf0df147dc491130d0d72fd84f2e0a89eeae3f0de0ec6f0f3b`
- Hash algorithm: SHA-256 of the UTF-8 exact-byte hash manifest below, in displayed sorted order, with one final newline
- No dependency was added by this bounded task. No commit, push, PR or DAG mutation was performed

## Executed checks

```sh
./node_modules/.bin/vitest run --root . tests/unit/domain-contract.test.ts
./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --resolveJsonModule --allowSyntheticDefaultImports --strict src/domain/index.ts
```

Both commands exited 0 after the final human-readable Korean activity/next-step refinement and source/scenario-hash regeneration. TypeScript emitted no diagnostics.

### Raw focused test result

```text
RUN  v4.1.11 /workspace/scratch/5a42b5329b35/note-app


 Test Files  1 passed (1)
      Tests  31 passed (31)
   Start at  02:13:50
   Duration  286ms (transform 80ms, setup 0ms, import 104ms, tests 48ms, environment 0ms)
```

## Expected and actual behavior

| Contract expectation | Actual result |
| --- | --- |
| Preserve source bytes/hashes, forbid sensitive payload keys, keep fixtures detached | Passed in focused unit suite |
| Connected agent done while DAG running; disconnected agent working | Passed without deriving one state from another |
| Deduplicate same canonical DAG; keep separate workstreams in same repository | Passed |
| Missing note/DAG mapping remains unknown | Passed |
| Done is not tested/deployed; deps-ready is not priority/approval | Passed in synthetic source/claim assertions |
| Later failed refresh retains observations, claims and provenance, marks them stale | Passed, including retaining a previously successful empty observation |
| Initial failed query cannot fabricate zero; partial coverage preserves unknown total and omitted host | Passed |
| Invalid schema, references/hashes, extra fields, bounds, contradictory counts/connectivity fail closed | Passed |
| Disabled backend remains inert; manual fixture backend keeps sources/freshness and copies results | Passed; a fetch spy observed no call in disabled mode |
| Human-readable Korean activity, next-step and failure text | Raw code states remain in source/domain fields; prose avoids code tokens and redundant next-step label; all exact-byte hashes revalidated |

A previous test invocation omitted `--root .`, inherited the renderer's Vite root and found no tests. It exited 1; the corrected root-specific command is the passing command recorded above. An initial TypeScript narrowing diagnostic was fixed with an explicit validation exception and then rechecked. Neither earlier attempt is represented as success.

## Requested readability refinement

The scaffold owner requested replacing raw state words in top-level prose with human-readable Korean descriptions, using “예시 데이터” instead of “fixture”, and removing the repeated “다음 제안:” prefix because the UI already labels proposed next steps. Only display prose changed; precise raw states, provenance, inference classification and nonapproval remain intact. The existing test now checks that the UI label is not redundantly embedded in prose, while still checking `kind: inference` and `approval: not-requested`. An additional regression test checks readable activity descriptions and unchanged raw states. This is a presentation refinement, not a relaxation of the authorization or information contract.

## Scope limits

- The sources are authored synthetic fixtures, including a provisional internal public-response shape. They provide no evidence of a real Orca command or wire schema
- This check does not open a native window; the scaffold owner must run the actual renderer/IPC and Electron integration path against these final hashes
- UI-independent contracts do not need duplicate screenshots. Relevant Electron screenshots and actual visual review belong to the scaffold's separate review record
- Real collection failures/cancellation, note links, filesystem safety, external summarization, actual user approval and macOS packaged/native paths remain unverified
- Required decisions and task completion gates remain unresolved unless separately documented by the task owner

## Exact source-set manifest

```text
7dfe08aace6ffa061ac769d5496bbc918312f4261713237b3f31c0f99d378327  fixtures/empty.json
2c2c5d89e931e447c20cfe64a64a3498f40a27e7ae866c0e15fad9f96141eb04  fixtures/manifest.json
de921604457dcb2f564516f2ac3aec19343ab9d35c6cf9f272af223f73d690ab  fixtures/normal.json
621d20657156962b2006169a6e2754752f0006f01ff55c47c50fff3f00cd8ee9  fixtures/partial.json
398f8511e044b19e5043c41297083052fba4fd3ede7b9b108f7beeeb1046c5f7  fixtures/refresh-failure.json
b16db7b60a435840865e1e737c9d4dc25f426120b9cf28bc423bee724091c52d  fixtures/sources/atlas-dag.json
daf4ebb4e7f2c2a138cd74f425e36f639acdac7503bf33db168fb7a6d00af745  fixtures/sources/beacon-dag.json
62774d4ac09a4a78eeeafe82bc762e08420b389bd7b52ed9703c2488db6d3b91  fixtures/sources/manual-summaries.json
1cc43f2d9613f045e0c38a88ab8c6559bb8b6a5f53a12787b66a566701f0f6ca  fixtures/sources/orca-public-response.json
6c62a77f03527b9f41f643371a1ea6d938ff6ba54e230236eb7ade0f82251aa9  specs/information-contract.md
d464e64f506e94682f67459d7a9eb3511f8b19f0c93d99095302ea1c188af0c3  src/domain/fixtures.ts
5044d3872ad2e2a2a8c487f8542b1810f2a57de4b70432b5e8be5ab72e884555  src/domain/index.ts
81e834b9d7330546264e597eb3474da2eefcf88bde4fc95220f3a9243101e262  src/domain/summary-backend.ts
cb207eef8ca7c7ee98ce12e3c8949906c717c4f2e2ba9e8e203639993e169764  src/domain/types.ts
a606f0dae48740edf06130e2ed28b8ab4993748a55f33c4b793b97d8883ff51a  src/domain/validation.ts
483e605497110f13f2a23516c570dc357ff30fadb32aac65709cb0f986be5d99  tests/unit/domain-contract.test.ts
```
