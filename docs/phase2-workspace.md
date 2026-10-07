# Phase 2 observation workspace

This branch implements the observation/review workspace from T-036–T-048 and T-050/T-051. Execution remains in Orca. It does not implement dispatch, process termination, DAG writes, new account authorization, tray behavior, main merges, external publication, or real model evaluation.

## Read contract v2

The external query pin remains `23d00c96beb0661bb7da064d7dd83566ea754f75165bb9790831dabc25887d47`. The original index/coverage modes and authoritative coverage calculation remain unchanged. Two additional **fixed** invocations request `id,type,description,acceptance_criteria,target_files,discussion,design` and `--policy --all`. A small version-bound adapter takes only phase ID/title/index and task membership from the same pinned loader and same private hash-checked snapshot. There is no independent YAML parser, dependency-closure implementation, directory discovery, script redistribution, or renderer-controlled field list.

Only `readContractVersion:2` authorizes the new projection. Unversioned test/legacy responses retain v1 behavior, including excluding descriptions. Details retain unknown raw types; unsupported optional shapes count as omissions. Policies are detached and bounded (200 entries, 32 KiB each, 256 KiB total). Task text remains bounded to 4,096 characters, lists to 40 displayed entries; the process response/source bounds remain in force. V2 can reject a large rich DAG at the existing output limit rather than silently deliver an incomplete authoritative result.

The workspace has a separate full-prefix-independent projection of up to 1,000 tasks. The summary view retains its existing 200-item display and at-most-20 selection contract. This separation prevents a summary prefix from hiding unrelated tasks in the workspace or a workspace filter from widening model inputs.

## Policy interpretation

No status-name fallback classifies committed/blocked/deferred/superseded. A missing, ambiguous or incompatible mapping yields `unknown` while preserving the raw declaration in the full list. Planning completion is not development or deployment completion. E2E references remain declarations, never execution results.

A project can declare a versioned map in its existing project policy collection:

```json
{
  "key": "note_app_status_mapping",
  "legacy": false,
  "decision": {
    "schemaVersion": 1,
    "id": "project-status",
    "revision": "reviewed-1",
    "scope": {"projectId": "the exact observed note-app workstream ID"},
    "mappingVersion": "1",
    "statuses": {
      "pending": {"lifecycle": "before"},
      "review_needed": {"lifecycle": "review"},
      "done": {"lifecycle": "done"}
    }
  }
}
```

This application never writes that declaration. Unrelated policy keys are preserved but do not participate in lifecycle mapping. `legacy:true` entries are retained history. Current malformed mapping entries fail closed. Revisions are opaque; precedence requires explicit `supersedes` references within the same scope, not mtime or lexical revision order. Optional scope constraints are exact DAG/task type/phase/task ID constraints. Overlapping incompatible mappings stay unknown.

Seven filters are maintained: 전체 / 작업 전 / 진행 중 / 검토 대기 / 논의 필요 / 검증 필요 / 완료. Review encompasses explicitly mapped task review and separately observed PR review; a URL alone establishes neither. Discussion/verification can overlap lifecycle states and counts are not a partition. Source hash, observation time, interpretation version, policy identity/revision/scope and reasons remain inspectable.

## UI and evidence

The existing left project list remains. Right-side summary/usage/task tabs preserve per-project tab, search, type/phase/prefix/status, selected task and scroll in bounded app-local state. The task list is the default view inside the task tab. Read-only SVG graph selection follows the same selected task, with visible/external/hidden/cycle diagnostics and no edit commands. Layout is deterministic and dependency-free. VueFlow/ELK and Chart.js were not installed: the smaller SVG/meter/table implementation avoids worker/CSP/package adoption changes. Performance still requires actual measurement; dependency avoidance is not proof of speed.

The detail header opens a single-task summary confirmation, shows the unsupported Orca navigation reason, and closes with focus return. The summary button saves exactly one explicit task through the existing guarded scope endpoint, then opens the existing transfer-consent/controller flow. No model invocation occurs on selection or viewing. V2 model input includes task details and policy interpretation/version; the existing sensitive-input scan, byte cap, run ledger, cancellation and late-result guards remain. Oversized detail remains a blocked model input rather than silently broadening a cap. Real model prose evaluation is not performed.

Evidence uses opaque bounded main-owned sessions. Sources are explicit registered project links or selected-task design/discussion links under the current canonical permitted note root. No renderer path/URL is accepted. Files undergo canonical/root, regular-file, hardlink/symlink, byte, hash, identity and permission checks. Markdown is intentionally shown as escaped plain text; HTML, scripts, inline events and network images are never executed or fetched. Raster PNG/JPEG/GIF/WebP receives bounded format/dimension checks; unsupported formats and native decoder failures are visible errors. An image declaration in a document is registered separately and remains bound to the unchanged declaring document hash and parent session. Anchors are preserved and honestly marked as unmatched; rich Markdown/anchor scrolling are not claimed.

Session release, disconnect, disposal and authorization changes invalidate reads. Late results cannot publish after release. At most 16 retained sessions, 4 concurrent preparations and 4 unresolved permission operations are allowed. Authorization checks and file reads have bounded response deadlines; kernel IO remains cleanup-owned and cannot be forcibly cancelled. Image dialogs provide fit/original/zoom/scroll and keyboard dismissal; stored bytes are not proof of successful visual verification.

## Resources and capability gaps

Provider history, account quota and project/repository usage are separate axes. Existing CodeBurn readings retain unknown account identity, per-window percentages/reset format, observations, last success/attempt, errors and coverage. Unknown/no records/stale values never become zero chart points. Account percentages are never summed or averaged. Provider estimated cost is not a project cost or bill; today/month windows are not treated as disjoint.

Pure contracts support explicit multi-account observations and supplied PID+startTime memory ownership/deduplication fixtures. **The live collectors do not currently supply account/profile identity, per-repository historical usage, OS PID/RSS linkage, system pressure or swap.** Those capabilities and UI fields remain unsupported/unknown. No UsageScope credentials, Keychain or private cache were read. Official account integrations require a separately verified interface and authorization. Unregistered work is separated by verified observed repository identity; task linkage unknown is not interpreted as confirmed DAG absence. Local checkout identity is retained; remote names do not merge repositories.

Dispatch advice references observed quota/review/verification and memory pressure when supplied. It has no execution authorization, enforcement, automatic action or invented RSS threshold. Acknowledgement only records that the user read the advice.

## Acceptance matrix and remaining gates

| Task | Implemented evidence | Remaining gap / honest boundary |
| --- | --- | --- |
| T-036 | Versioned read projection, raw values, source/phase/details/omissions | Real private 459-node structure not imported; rich DAG output limits remain |
| T-037 | Explicit policy/envelope, revision/scope, overlap and unknown tests | Existing free-text policies require an explicitly authored mapping; no automatic semantic migration |
| T-038 | Left list, right 3 tabs, per-project state and responsive layout | macOS native interaction and user reading acceptance |
| T-039 | Seven status Select, search/type/phase/prefix filters, selected detail | Functional feature labels beyond observed fields not invented |
| T-040 | Readonly deterministic SVG, cycle/hidden/external diagnosis, synthetic500 unit benchmark | Real459 structure and agreed performance thresholds; no VueFlow/ELK claim |
| T-041 | Declaration-rich detail, summary/optional-capability/close ordering, focus and stale notice | Actual PR review source absent unless explicitly supplied |
| T-042 | Bounded source-safe text/raster reader, IPC sessions, dialogs, adversarial tests | Rich Markdown and automatic anchor matching omitted; Mac permissions unverified |
| T-043 | Account windows, provider history, accessible meter/table, freshness/error/coverage | Project tokens/repository history unavailable from current collector |
| T-044 | Honest live capability boundary, pure memory attribution/dedup model | Actual Mac process/PID/RSS/pressure collection not implemented or measured |
| T-045 | Provenance-bound advisory and acknowledgement, no execution control | Reliable recommendations limited by missing memory/account/review observations |
| T-046 | Explicit single-task consent flow; policy-bound input/cache; no-replay inherited | Real external model semantic quality not evaluated; oversized source fails closed |
| T-047 | Unsupported navigation explanation, no shell/string command insertion | Installed Orca public navigation capability not established; optional feature excluded |
| T-048 | Aggregate unit/type/build, actual Linux Electron fixture and visual plan | Mac install/signing/permissions, state-preserving upgrade/rollback and user acceptance remain |
| T-050 | Multi-account model and independent windows/error tests; legacy decoder projection | Actual multi-account collection/connection not supported; fixture success is not live integration |
| T-051 | Independent repository tier/task linkage, checkout preservation, ownership tests | CodeBurn branch collector and live repository usage/memory attribution not implemented |

This matrix deliberately distinguishes working read-model/UI contracts from live collector and Mac acceptance completion. It does not mark all 15 planning tasks done in the authoritative DAG.
