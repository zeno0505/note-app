# Review changes by intent

Use a short review map when a change crosses files or boundaries. A one-file
correction may need only a sentence. This guide adapts ideas from
[pulls.review at `cf686ebc`](https://github.com/antfu/pulls.review/tree/cf686ebcf6642759c2a1291e2f12dc740c5c431b),
inspected on 2026-10-05. It is a review aid, not a task schedule or product roadmap.

## Inspiration, adoption and reviewer benefit

1. **Follow the reason for a change across directories.**
   - Source: the [grouping prompt][intent] groups by intent and keeps tests,
     stories and fixtures with the behavior they cover.
   - In note-app: describe a coherent behavior together with its relevant
     contracts, tests and explanatory docs. For example, a summary-approval
     change can span `src/shared/summary-workflow.ts`, `src/summary/workflow/`,
     renderer code and `tests/unit/summary-workflow.test.ts`.
   - Benefit: the reviewer can connect a claim to its implementation and proof
     without reconstructing that connection from the directory tree.

2. **Use predictable classification as an inventory, then review intent.**
   - Source: the [rules][rules] and [adapter][adapter] implement ordered,
     first-matching path rules for docs/code/tests/config/deps/generated/other.
     Text without a match falls back to code; binary files fall back to other.
     The [category schema][schema] separately describes system areas such as
     API, data and security. These are not the hardcoded rule groups.
   - In note-app: start with the changed-file list and optional path/glob hints,
     then inspect the diff to form meaningful groups. Record security, data and
     contract risks across those groups. An inventory label is not proof of intent.
   - Benefit: cheap, repeatable coverage without letting file extensions hide
     a cross-cutting change. Starting with rules and using a model only if useful
     is our workflow choice, not an upstream-required precedence.

3. **Make the review map small and navigable.**
   - Source: [group data][schema] carries a label, purpose summary, file paths
     and one child level; [DiffGroup][group], [tabs][nav] and [sidebar][sidebar]
     connect those groups to files and reviewed progress. The [navigation
     setting][nav-setting] changes presentation without changing the grouping.
   - In note-app: use a few short intent headings, linked files and evidence;
     add subheadings only when useful. State why each group exists and suggest
     where to start. The template below provides that map without a new UI.
   - Benefit: reviewers can resume at the right concern with less navigation.
     A reviewed-file count is progress, not proof that the behavior is correct.

4. **Keep missing coverage visible as the diff changes.**
   - Source: [group resolution][coverage] reconciles old paths, marks missing
     references and adds an Uncategorized group for files absent from the map.
   - In note-app: reconcile the map against the exact base/head diff. Give every
     changed path one primary group; list ungrouped files and overlapping glob
     matches explicitly until resolved. Cross-link shared contracts where useful
     without counting a file twice. Recheck renamed, removed and newly added files.
   - Benefit: stale summaries and convenient group labels cannot silently hide work.

5. **Let commit messages explain intent without dictating review boundaries.**
   - Source: the [prompt][intent] treats commit messages as clues and groups the
     final change rather than following fixup/WIP commit boundaries.
   - In note-app: prefer subjects explaining the outcome and a body explaining
     the reason or important limit. Keep behavior, tests and necessary contracts
     cohesive; separate independent changes when it improves understanding.
     Do not split feature/test/docs mechanically or rewrite history for this guide.
   - Benefit: useful checkpoints remain understandable both individually and in
     a final comparison.

## Review order and evidence in note-app

The upstream prompt suggests core changes, supporting changes, then mechanical
changes. For this repository, adapt that order to risk: inspect changed IPC/API
contracts, permissions and data-write/freshness boundaries early, then follow the
behavior through implementation and its evidence. Explain exceptions. This is a
note-app choice, not a fixed ordering imposed by pulls.review.

- Use [application boundaries](../app/README.md) for IPC and sandbox concerns.
  Review changed failure, cancellation and stale-result paths with the behavior.
- Put focused tests, fixtures and relevant screenshots/logs beside the claim in
  the map. Say **passed**, **failed** or **not run**, with the tested SHA and
  environment. Follow the [verification scope](../reviews/electron-test-infrastructure.md);
  Linux/unit evidence does not establish macOS or real-model acceptance.
- Keep mechanical/generated changes visible, usually later. Inspect their cause
  and relevant dependency/build impact; a generated label is not a safety waiver.
- Check changed links and source claims for documentation-only work. Run checks
  appropriate to affected behavior; do not add an unrelated expensive rerun just
  to populate the map. Report CI for the exact published SHA when it runs.

## Optional review note

Copy only useful fields into a commit body, branch/compare description, review
record or PR. Direct branch pushes are supported by the
[repository workflow](../decisions/repository.md); creating a PR is optional.

```text
Purpose: what changes for the user, and why?
Scope: base SHA -> head SHA; compare/commit link

Intent group: short heading
  Why / affected behavior:
  Primary paths / relevant contract or boundary:
  Evidence: command or review + result + tested SHA/environment + link
  Review first: starting point and risk; unresolved limits

Coverage: ungrouped paths; overlapping matches; renamed/missing paths (or none)
Publication: branch + verified remote head; exact-SHA CI result/link or not run
```

If head changes, update the scope and coverage. For an authorized direct push,
verify the remote head and committed files before reporting a durable checkpoint;
a local commit alone is not publication. This traceability is a note-app practice.

This adoption needs no pulls.review installation, model key, new Action or diff
upload. Keep the [public-repository data limits](../decisions/repository.md): use
synthetic fixtures, and do not include private notes, company code or credentials.

[intent]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/llm/prompt.ts#L29-L52
[rules]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/rule-based/rules.ts
[adapter]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/analyze/adapters/rule-based/index.ts
[schema]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/core/src/types/analyze.ts#L12-L89
[group]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroup.vue
[nav]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroupNav.vue
[sidebar]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/DiffGroupSidebar.vue
[nav-setting]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/state/group-nav.ts
[coverage]: https://github.com/antfu/pulls.review/blob/cf686ebcf6642759c2a1291e2f12dc740c5c431b/packages/app/src/components/diff/group-utils.ts#L34-L87
