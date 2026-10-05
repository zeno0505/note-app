# Phase 1 information contract

Status: implementation contract and synthetic fixture preparation; not a declaration that T-001, T-006 or a dependent feature is done. No DAG status is changed by this document. Final task completion remains subject to the recorded decision, integration and quality gates.

## 1. Acceptance basis recorded before implementation

The assigned acceptance criteria were read before domain implementation on 2026-10-02. They have not been relaxed to fit this scaffold:

- T-001: Phase 1 covers Orca discovery, note association and human-readable feature/workstream progress: how far, what remains, current work, proposed next work, and blockers/decisions. Preserve provenance, unknowns and time. Never infer tested/deployed from done, or priority/authorization from dependency readiness
- T-006: prepare synthetic minimal-response/DAG fixtures without secrets, prompts, previews or conversation bodies. Include the connected-terminal + agent-done + DAG-running combination
- Shared quality policy: document/fixture checks are scoped preparation, not live integration proof. Real Electron validation is a separate prerequisite. Browser-only tests, saved screenshots, synthetic Orca responses and Linux launch results do not prove real Orca, human image review, macOS native behavior or a packaged `.app`

Requirement versions supplied to this task (SHA-256 of exact input bytes):

| Input | SHA-256 |
| --- | --- |
| Assigned task-slice acceptance | `d0c19d153731a4dfe613a3d0571eaf61100bfca6854a372a0ce08c09dca1ff8c` |
| Planning `design.md` | `0ae742fd9690b11bc6aeb95a205ef99c2e3fae26d38b02fce3ad1d37cd2fd0e9` |
| Planning `quality-policy.md` | `39b4e8216fa1e8b9a85a2a2ef4c2ba4af2b17c788d155a1c98483a7d55c0f998` |
| Planning `context.md` | `6a8eb330cd8e8056e9746ee4bf8b1d6f4eb6de7560685ca32bd2342705f0da4e` |

No real project snapshot was opened, copied or used to generate fixtures. Fictional project labels, paths, observations and summaries were authored from scratch.

## 2. Product boundary

Phase 1 answers the same questions at a **workstream/project** level:

1. **Goal / where are we?** Explain the intended outcome and implemented scope in everyday language
2. **What remains / what is happening now?** Separate remaining work from observed activity
3. **What is blocking us?** Name missing evidence, blockers and decisions explicitly
4. **What is next?** Describe a proposed next step, without implying priority or execution approval

The display contract separates `goal`, `implemented`, `remaining`, `current`, `next` and `blockers`, so each answer is independently attributable. Task IDs, hashes and source locators are supporting detail. A reader should not need to interpret a DAG to understand the main answer. A missing answer is an explicit unknown claim; it is not an empty list pretending nothing remains.

Phase 1 includes future read-only Orca discovery, note mapping, safe note-connection proposals and the progress screen. This bounded scaffold implements synthetic display data and a local manual-summary boundary only. It does not implement the real collector, filesystem mappings, symlink changes, agent control or live summary generation.

Full acceptance/evidence management, approval operations and development delegation are Phase 2 product features. They are not mandatory Phase 1 UI or blocking dependencies. The development quality policy still applies from Phase 1; recording development verification is not the same as implementing an evidence-management product.

## 3. Domain contract and exports

`src/domain/index.ts` is the UI-independent boundary. It exports the following types and fixture helpers without Vue, Electron, filesystem, shell or network imports.

### Workspace snapshot

`WorkspaceSnapshot` contains:

- `schemaVersion: 1` and `mode: 'synthetic-fixture'`. This version identifies this internal fixture contract, not an Orca release or supported public CLI schema
- `observedAt`: UTC time of the last usable observation. Never replace this with render time or a failed attempt time
- `freshness: 'current' | 'stale'`: whether the observation still supports the claims being displayed. In this fixture, “current” means current within the scenario, never live data from the user's computer
- `lastAttempt`: attempt time, `success | error` and an error reason when present
- `coverage`: `complete`, `truncated`, `totalCount: number | null`, and `omittedHostIds`
- `workstreams`: resolved, distinct workstreams; not one card per repository or terminal

`coverage.totalCount` counts discovered **worktree records** in the scenario, not workstreams, DAG tasks or connected terminals. `null` means the total is unknown. A complete response must contain all counted worktrees. Truncation or an omitted host makes coverage incomplete. Filters can report “shown here” counts but cannot call them global totals.

An initial failure with no usable prior observation is an unavailable state in the consuming application, not a fabricated `WorkspaceSnapshot` with zero records. This type intentionally represents a usable current or retained observation. A genuinely observed empty snapshot may be retained after a later failure, with its original time and a stale marker. That historical zero is not evidence of the current situation.

### Workstream and source identity

`Workstream` contains `id`, `title`, `goal`, the five summary arrays, `canonicalDagPath`, `dagState`, `worktrees`, `noteMapping` and `sources`.

- Group confirmed work by its canonical DAG identity, with linked worktrees attached
- Two worktrees pointing to the same canonical DAG produce one workstream
- Two distinct canonical DAGs in one repository remain distinct workstreams
- A repository name, selected terminal or branch name alone is not a workstream identity
- A missing or ambiguous note mapping stays unresolved. Do not recursively infer all notes in a vault, select an arbitrary DAG or report a missing DAG as empty/done
- Fixture paths are bounded `/synthetic/...` values. No filesystem resolution is attempted. Realpath, supported roots, symlinks, permission checks and collision handling belong to later approved adapters

`SourceRecord` contains a local source ID, `dag-fixture | orca-fixture | manual-fixture`, a bounded `fixtures/sources/*.json` locator, exact-byte `sha256:` hash and observation time. Each claim references both the source ID and the source hash. References resolve within their workstream; a mismatched hash invalidates the claim rather than silently upgrading it to fresh evidence.

The same source may legitimately support multiple workstreams. Unique canonical DAGs and unique discovered worktree IDs are enforced across the normalized snapshot.

### Claims, evidence and review

`SummaryClaim` contains:

- `id`, human-readable `text`
- `kind: fact | inference | unknown`
- `sources: { sourceId, sourceHash }[]`
- `observedAt`, optional `reviewedAt`, and `freshness`
- `evidence: source-declaration | manual-description | none`
- `approval: not-requested | approved | rejected`

A **fact** means a specific source explicitly declares the information; it is not proof of runtime correctness. A **manual description** is attributable prose, not a passed test. An **inference** is a clearly labeled interpretation/proposal. **Unknown** preserves the reason evidence is absent and uses `evidence: none`. Unknown claims may point to the source that reveals the gap.

Review time does not imply approval. Claim approval does not authorize running commands, changing files, making a payment or transmitting data. `approval` is a display contract for provenance and review state, not an operational approval mechanism. All shipped fixture claims are `not-requested`; user readability approval has not happened. A future approved claim needs an attributable decision record in the appropriate later feature, not a fabricated timestamp here.

Facts and inferences require at least one resolvable source. Every source and claim has a timestamp no later than the retained observation. A review cannot predate its observation. A failed refresh makes the retained snapshot and its affected claims stale; it must not overwrite the previous text, provenance or observation time. When only some real sources later change, the future incremental engine should invalidate/rewrite only affected claims and retain any older approved text visibly stale. That engine is not implemented by these fixture helpers.

### Independent state dimensions

These distinctions are mandatory even when two states usually correlate:

| Field / observation | What it means | What it does not mean |
| --- | --- | --- |
| `isArchived: false` | Worktree is not archived | Selected, connected, active agent, or running DAG |
| `isSelected: true` | UI/Orca selection observed | Agent is working or work has priority |
| `terminalConnected` / `terminalCount` | Terminal connectivity observed | Agent is working, current output exists, or DAG is running |
| `agentState: working` | Agent activity state observed at `agentObservedAt` | A terminal must be connected, or DAG status has changed |
| `agentState: done` | Agent state says done | Feature done, tests passed, deployed, or DAG done |
| `lastOutputAt` | Last output time | An execution heartbeat or proof an agent is still working |
| `dagState: running` | DAG declares running work | A live agent/terminal is currently executing |
| Task `declaredStatus: done` | DAG declares task completion | Tested, verified, reviewed, approved, or deployed |
| Task `depsReady: true` | Internal dependencies are satisfied | Highest priority or permission to execute |
| `summary.next` | Attributable proposed next step | Authorized action or agreed scheduling priority |

`TaskStatusFact` defines independent declared status, tested/deployed observations, `depsReady`, priority and execution approval. The synthetic DAG source files use that shape to demonstrate the distinctions. These facts do not implement a task execution or evidence-management product.

The default view may favor terminal-connected workstreams; “all nonarchived” remains a separate view. Neither view changes the underlying source state, and terminal filtering must not discard the disconnected-but-working scenario from the full observation.

## 4. Failure and freshness rules

- CLI unavailable, Orca stopped, permission denial, timeout, malformed/unsupported response, missing paths and incomplete hosts are collection problems; do not translate them into a successful empty result
- Preserve the last successful observation and its time if one exists, show the failed attempt time/reason, and visibly mark retained claims stale
- If nothing has ever been observed, show unavailable/unknown. No zero progress, zero remaining work or invented completion percentage
- A successful complete zero response may be shown as empty, with its observation time
- Partial data can still show observed work, but truncation, omitted hosts and unknown totals remain visible. A partial source cannot prove that no other work exists
- `retainLastGoodSnapshot` returns a detached, validated snapshot. It preserves the input and does not mutate imported fixtures
- A source hash mismatch is rejected by the display boundary; the caller can retain the last valid snapshot as stale and report the collection error. It must not swap in invalid new content

The planned real collector's public read-only candidates are status, project list, worktree list and worktree process/state queries. Their exact supported schema, limits and errors require real authorized investigation. Any implementation must preserve total/truncation/host omissions, execute fixed argv rather than concatenated shell, enforce response limits and cancellation, and prohibit agent/send/create/open/close/run calls in collection. None of this document or fixture data proves a real CLI integration.

## 5. Summary backend boundary

`SummaryBackend` accepts a normalized snapshot and workstream ID, and returns an explicit disabled, unavailable or manual-fixture result.

- Default mode is `disabled`
- `manual-fixture` returns existing attributable fixture claims without generating text or changing approval/freshness
- Unsupported modes fail closed
- There is no endpoint, API credential, model loader, Orca agent call, shell call or network transport in this module
- Backend choice, costs, model residency and external document transmission remain open decisions. They are not implied by a ready DAG task or the choice of Electron/Vue
- The fixtures demonstrate wording and data boundaries, not automatic summary correctness or user readability approval

## 6. Synthetic fixture inventory

`fixtures/manifest.json` records scenario and source content hashes and their explicit unverified scope. The public-response-shaped source is deliberately labeled **provisional internal fixture, not real CLI schema**.

| Scenario | Required behavior |
| --- | --- |
| `normal.json` | Three workstreams / four worktrees; connected agent done + DAG running; disconnected working agent; missing mapping; two worktrees deduplicated by DAG; same repository split into separate workstreams |
| `refresh-failure.json` | Same retained observation/workstreams/provenance as normal; later simulated error; all claims stale; no Orca command executed |
| `empty.json` | Explicit successful, complete zero observation |
| `partial.json` | Observed work retained; truncated response; omitted fictional host; total is null, not zero |

`fixtures/sources/` contains the fictional minimal public-response object, two fictional DAG source records and manual summary text. All source paths and host IDs are invented. No secrets, prompts, previews, conversation content, real worktrees or private company names are included.

Strict runtime normalization rejects unknown fields, unsupported versions/modes, unbounded text/arrays, invalid timestamps, arbitrary source locators, non-synthetic paths, duplicate identities, broken hashes/references, unsupported claims, inconsistent counts/connectivity and stale errors represented as current. It does not claim to semantically validate arbitrary prose, real filesystem safety or a real Orca wire schema. The fixture integrity tests additionally check exact source bytes against the manifest.

## 7. Verification and remaining gates

The contract/fixtures are verified through `tests/unit/domain-contract.test.ts` and strict TypeScript checking. The focused run covers provenance, forbidden payload keys, independent observations, canonical DAG identity, empty/failure/partial behavior, explicit unknowns, bounds and the local-only summary boundary.

Exact focused commands from the repository root:

```sh
./node_modules/.bin/vitest run --root . tests/unit/domain-contract.test.ts
./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --resolveJsonModule --allowSyntheticDefaultImports --strict src/domain/index.ts
```

Observed at 2026-10-02 17:13 UTC on the dot cloud Linux development machine: **31 tests passed; strict domain TypeScript check passed**. The first test command without `--root .` inherited the renderer Vite root and found no test files; it was corrected and rerun. That unsuccessful discovery is not counted as a pass. The source version, raw focused output and final revalidation result are recorded in `specs/domain-verification.md`.

These are UI-independent contract/unit checks. There is no duplicate screenshot obligation for this document. Actual renderer/IPC integration and real Electron screenshot review are owned by the scaffold verification; this focused result alone does not prove them. Real Orca, actual notes/links, macOS native controls, packaged release behavior, automatic summarization and user readability acceptance remain unverified. Task-state and decision gates remain unchanged.
