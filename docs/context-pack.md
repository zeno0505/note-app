# Bounded summary context (internal contract v1)

This is a **local preparer for already extracted records**. It neither defines the authoritative DAG query nor invokes Orca, CodeBurn, a model, an inbox, filesystem traversal or a network endpoint. The authoritative DAG query adapter remains an integration prerequisite. The caller must explicitly choose one scope and supply only necessary, authorized, extracted task declarations. A source hash identifies upstream exact-byte evidence; it is not asserted to hash the extracted `text` field.

## Script contract

Requires the repository's Node 24 runtime:

```
node scripts/context-pack.mjs < extracted-context.json > prepared-context.json
```

No positional arguments or path parameters are accepted. Standard input is one strict JSON `ContextInput`, at most 1 MiB UTF-8 (invalid encoding rejected). Standard output is exactly one compact JSON `ContextPack` with no newline; on failure stdout is empty, exit status is nonzero and stderr is a fixed generic diagnostic that never echoes input. Shell redirection is the caller's explicit choice, not a file-reading API inside the preparer. Never pipe whole DAG/inbox exports into it. The separate authoritative query must constrain retrieval before this stage.

Exports from `src/summary/context/index.ts` are Node-side, UI-independent:

- `parseContextInput(unknown)` validates and returns a detached canonical copy
- `buildContextPack(unknown)` builds the bounded deterministic pack
- `serializeContextPack(pack)` serializes compact JSON
- `computeContextPackHash(pack)` recomputes the pack binding
- `validateMissingContextRequest(unknown, pack)` validates a request only; does no retrieval
- `CONTEXT_SCHEMA_HASH` fingerprints the explicitly versioned internal contract descriptor, not a machine-readable JSON Schema

## Input

All fields are required; extra fields are rejected recursively:

- `schemaVersion: 1`, `scopeId`: opaque ID, not a path
- `records`: at most 256 unique records; each has `sourceId`, SHA-256 `sourceHash`, canonical UTC millisecond `observedAt`, `text` (at most 8,192 UTF-8 bytes), independent `declaredStatus` (`pending`, `running`, `done`, `blocked`, `unknown`) and at most 32 unique `dependencies` (`sourceId`, `declaredStatus`)
- `coverage`: `complete`, `totalCount` (number or null), `unknowns` (at most 32 bounded descriptions). Complete means count equals provided records and no unknowns. Partial coverage cannot establish zero. Unknown does not become empty
- `previousSources`: at most 256 unique source ID/hash pairs from the same selected scope, for hash deltas. Caller must keep its scope identity correct; this pure module cannot prove upstream identity
- `priorApprovedSummary`: null or `{text, approvedAt, approvalId, sources}` with at least one source reference matching a current or previous supplied manifest. Caller must establish that approval genuinely happened; a timestamp is not approval. No generated or unapproved summary should be inserted here
- `limits`: `maxBytes` and `maxApproxTokens` (512–131,072), `maxRecords` (0–256)

IDs allow letters, numbers, underscore, hyphen, period and colon, beginning with an alphanumeric character; no slashes or path traversal are accepted. Hashes must be lowercase `sha256:` plus 64 hexadecimal digits. Arrays, text and integer ranges are bounded. Duplicate records/references/dependencies fail closed. A dependency declaration that contradicts the declared status of another supplied record fails closed, even if that record would later be excluded by budget. Direct module input is structurally bounded; the script additionally enforces the tighter aggregate 1 MiB input ceiling.

## Output, ranking and budgets

The pack includes all observed source ID/hash/change pairs, absent previous sources, source coverage/unknowns, included full records, exclusion IDs/reasons, missing dependency IDs, prior approved summary and explicit truncation. Missing earlier sources are `removed` only under complete extraction; otherwise they are `not-observed`. Prior text is retained with `stale` when its cited hash changes/disappears or current extraction is incomplete. `current` only describes cited source identity within the extracted scope, not live freshness or renewed human approval.

Selection is deterministic: changed/new sources before unchanged sources, then declared blockers, running work, other statuses, then case-sensitive code-point ID order. Arrays that carry sets are sorted. Input record/dependency/manifest ordering cannot alter the output. A record that cannot fit is omitted intact and later smaller records may still be selected. Text is never sliced, corrupted or quietly summarized. `truncated` describes record omission by this preparer; upstream incompleteness remains separately visible in `coverage`.

Every byte of the final compact JSON, including provenance, exclusions, prior approved summary, limits, hashes and the usage counters, counts toward `maxBytes`. If mandatory metadata cannot fit, preparation fails rather than silently hiding provenance. `usage.approximateTokens` uses **one token per UTF-8 byte** as a deliberately conservative budgeting proxy, not a tokenizer, exact model token count or guarantee for every model. Both limits apply to this proxy and exact byte count. Prompts, response schemas, conversation wrappers and output token budgets are outside this pack and must be reserved by the caller. A real transport must use its supported model accounting and cannot claim these numbers prove an API token limit.

`schemaHash` is a SHA-256 fingerprint of `CONTEXT_SCHEMA_DESCRIPTOR`; semantic contract changes require updating its version/descriptor. `packHash` is SHA-256 of UTF-8 compact JSON with only `packHash` omitted, retaining the other property insertion order. Use the exported helper rather than independently reordering JSON properties. It binds records, provenance, exclusions and accounting. Source `change` flags compare upstream hashes only: the same source bytes can produce different extracted text or facts after an extractor change. Such changes produce a different `packHash`; caches must key on the pack binding and extractor version, never solely on source change flags. It is an integrity binding, not a signature or proof of approval. Claim citations should match **included `records`**, not merely the source manifest, because omitted text was not supplied to the agent.

Dependencies are source declarations, not graph execution permission. This module does not infer readiness, prioritize execution, infer testing/deployment from `done`, traverse dependencies, or grant permission based on a prior summary's approval.

## Bounded missing-context protocol

An agent can return a data-only request:

```
{"schemaVersion":1,"scopeId":"synthetic-workstream","sourceIds":["task-b"],"reason":"Need omitted task declaration","maxBytes":1000,"maxApproxTokens":1000}
```

Only 1–8 distinct IDs in the existing pack's exclusions or unresolved dependency IDs are allowed. Scope must match; IDs/extra fields/paths/commands fail closed. Request limits must be positive, no greater than the original pack limits, and at most 16,384 each. Requests do not authorize browsing or increase the original data-sharing scope. An authorized adapter must resolve IDs through its fixed query interface, enforce these bounds again on the response, and pass an explicitly rebuilt pack to the agent. If that interface is unavailable, report missing context instead of allowing the agent to explore the DAG or inbox. No automatic retry loop or arbitrary follow-up retrieval exists here.

## Verification scope

`tests/unit/context-pack.test.ts` uses invented text and IDs only, exercising deterministic output, detached inputs, source/hash changes, prior approval provenance, partial unknowns, dependency preservation, Unicode bytes, whole-record exclusion, strict rejection, missing-context limits and stdin-script success/failure. This is preparer/contract evidence, not Orca agent transport, real DAG schema, model quality, external authorization, Electron or packaged macOS evidence.

## Explicit extraction from the DAG read model

`src/summary/context/extract.ts` exports the pure `extractContextInput(request)` adapter. The request is script-friendly JSON data with `schemaVersion: 1`, `dagId`, the verified reader's `DagReadModel` as `dag`, `requestedTaskIds` (0–32 distinct exact IDs), `excerpts` (0–32), `previousSources`, `priorApprovedSummary`, and `limits`. It returns the existing validated `ContextInput`, ready for `buildContextPack` or the stdin pack script. It does not parse YAML, copy the official query script, run a subprocess, inspect directories, or query an inbox. The caller obtains the authoritative read model separately and explicitly chooses the task slice. No auto-priority or agent-chosen task selection occurs.

Each excerpt requires `scopeDagId`, `id`, `kind` (`goal-document`, `document`, or `inbox`), `sourceHash` (`sha256:` form), `observedAt`, and bounded `text`. Scope must equal the requested DAG. The caller must supply only already-authorized selected excerpts and exact provenance. No whole document/inbox input is requested or discovered. A missing goal-document excerpt remains an explicit unknown; a DAG task title is not promoted into an invented project goal.

The adapter builds a bounded identifier index from the supplied projection, then inspects full content only for requested task IDs. It adds the **status alone** of necessary direct internal dependencies, without reading those dependencies' own dependency lists, titles, commits or E2E declarations. It does not recursively walk the graph. External or absent dependencies have unknown status and unresolved opaque references, not fabricated source records. A declared external dependency whose ID exists locally is rejected as a contradictory projection. Missing requested IDs are reported as unknown counts. Original requested IDs remain with the host request; agents must not use the omission notice as permission to search.

Requested task declarations preserve raw status vocabulary, E2E declaration/coverage state, and declared commit references. Only exact supported status strings map to the pack enum; other values remain `unknown`, with the raw declaration preserved in text. A custom reader `doneStatus` does not expand this adapter's enum or prove completion. E2E `unmet`/`undeclared` and commit references remain declarations: they do not establish executed tests, deployment, acceptance, priority or execution approval. Every record text explicitly identifies its provenance category: requested DAG task declaration, minimal DAG dependency declaration, or selected document/inbox excerpt.

`contextScopeId`, `taskContextSourceId`, and `excerptContextSourceId` derive deterministic opaque SHA-256 IDs from framed identity tuples. DAG/task/excerpt identity is never copied into a filesystem locator. Task records use the upstream DAG source hash, normalized from the reader's bare hash into the pack's `sha256:` form; source hashes are not hashes of extracted text. Full pack hashes continue binding the actual extraction. Excerpt hashes are independently supplied provenance. A hash-based identifier is not anonymization against a party who already knows candidate IDs.

Coverage deliberately stays `complete: false, totalCount: null`, even when all DAG tasks were explicitly selected: document/inbox coverage was not established. The full DAG task count is labeled separately in coverage metadata and never substituted for selected context-record count (which may also contain dependency records and excerpts). Limits remain strict: at most 10,000 indexed projection IDs, 32 requested tasks, 32 dependencies per requested task, 32 commit/E2E references per selected task, and 32 excerpts; the final context parser additionally enforces its 256-record and text ceilings. Oversized required facts fail closed rather than being silently dropped. Pack budgeting can subsequently omit complete records with explicit exclusion metadata.

Synthetic-only tests in `tests/unit/context-extract.test.ts` cover direct-only selection, no unselected payload access, unknown external dependencies, exact scope checks, stable opaque IDs, raw unfamiliar statuses, declaration-only evidence, excerpts, selected-subset coverage, strict limits, and detached output. This establishes no live DAG, inbox, Orca, transport or Electron result.

### Conservative upstream invalidation limitation (T-017 remains incomplete)

Every extracted task and direct dependency currently cites the **entire upstream DAG file hash**. Therefore an unrelated edit to an unselected task changes the source hash of every selected DAG record, even when all extracted record text is byte-identical. All claims citing those changed hashes become affected; this adapter does **not** provide task-granular invalidation. The regression “conservatively invalidates every selected DAG record after an unrelated upstream edit” explicitly verifies this behavior. Independent excerpt provenance is unchanged unless its own source hash changes.

Fine-grained T-017 invalidation remains incomplete pending a separate, reviewed per-record provenance contract distinguishing extracted-record content identity from upstream exact-byte DAG provenance. This implementation intentionally preserves the current hash meaning instead of substituting extracted-text hashes or implying that only semantically changed task summaries refresh. Pack hashes bind the selected payload but do not solve the coarse source-hash dependency. No extra source browsing, traversal or retrieval is needed or performed to expose this limitation.

## Opt-in per-record projection provenance v1

`src/summary/context/projection.ts` adds a **separate source contract** without changing `extractContextInput` or its whole-DAG source hashes. `extractProjectionContext(request)` accepts the same bounded `ContextExtractionRequest` and returns `{input, provenance}`. Pass only `input` to the context pack builder. `provenance` is a **local-only manifest** and must never be appended to model text, prompts, logs or external transport. The same strict selected-task/direct-dependency/excerpt limits apply. This adapter performs no filesystem IO, raw-source reading, inbox scan, subprocess or network operation.

### Exact meaning of evidence and hashes

Each selected DAG task or minimal direct-dependency record now uses a new `projection-v1-…` source ID, derived from the versioned contract and legacy framed task identity. The record's `text` is the exact canonical JSON projection artifact. Its `sourceHash` is SHA-256 of those exact UTF-8 artifact bytes, **not** the original DAG file hash. The artifact explicitly identifies `sourceType: dag-task-projection-v1`, its schema version, declared status, original extracted declaration string, and sorted direct-dependency source IDs/status declarations. A citation resolves to this immutable supplied artifact, never to an alleged substring of the entire DAG file. The original declaration envelope retains its narrower task/dependency declaration category inside the projection artifact.

`provenance.entries` links each projection source ID/hash and exact artifact string to local `upstream: {dagId, taskId, sourceHash, observedAt}`. The upstream hash still means the exact original DAG file bytes and is never silently redefined. `validateProjectionContext` checks ID/scope/time linkage, exact artifact-to-record byte equality, content hashes, canonical representation, source category, dependency/status agreement, one-to-one manifest coverage and strict record bounds. The result is copied and recursively frozen. These integrity checks are not a digital signature or independent proof that the claimed DAG observation is authentic; the host must trust its verified reader and authorized selection.

`observedAt` remains observation metadata outside content-hashed projection artifacts. Re-reading identical evidence does not change its source hash. Updating local upstream provenance on each read does not automatically replace an older approved claim's recorded observation time. Excerpts deliberately retain their earlier independent upstream-hash contract for this slice and have no invented projection-provenance entry.

### Incremental behavior and migration

An unrelated unselected task edit can change the original DAG hash/time while leaving all selected projection artifacts and hashes unchanged. The summary store then treats the content as a no-op. A selected title, status, E2E/commit declaration or dependency fact change changes the corresponding artifact hash. A dependency status change may correctly affect both its own minimal record and any selected dependent whose artifact includes that fact. Source additions and scope coverage changes still invalidate aggregate claims conservatively; full-DAG task-count changes remain explicit scope metadata even when the added task was not selected.

Legacy IDs are never rewritten in old approvals or source manifests. Supply prior provenance explicitly in `previousSources`; a prior approved summary's references must be present there. When moving from whole-DAG records to projection-v1, old task IDs remain absent/stale and new IDs are new evidence, requiring fresh candidate generation and human approval rather than silent migration. The legacy T-017 limitation above remains accurate for the legacy adapter. This opt-in adapter supplies and tests a fine-grained projection-identity foundation; it does not by itself complete the full operational T-017 workflow.

### Remaining storage and semantic-review limits

Artifacts are retained exactly in the returned in-memory local manifest only. There is no durable content-addressed archive, disk persistence, retention/eviction policy, authenticated approval-event storage, artifact retrieval after restart, or real agent transport in this adapter. A production host must preserve exact cited artifacts and the appropriate upstream manifest under an explicit storage/privacy policy before claiming durable historical evidence. It must never overwrite historical artifacts merely because a later observation shares the same task ID. Hash validation and typed source declarations do not prove tests ran, commits exist, deployments occurred, or free-text summaries are semantically correct. Human review and runtime/Electron integration remain separate gates.

Synthetic tests in `tests/unit/context-projection.test.ts` demonstrate exact artifact hashing, local upstream lineage, unrelated-edit/no-op behavior, task/dependency-specific claim invalidation, aggregate invalidation, conservative excerpts, legacy migration, bounds and tampering rejection. They provide no real-source or model-quality evidence.
