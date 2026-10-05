# Versioned projection provenance — incremental summary verification

Final code `bcf3bcb8a48b67cdb98fa4ad3bd569d8367b1423`, clean working tree. Final actual Electron run passed at `2026-10-02T20:23:26.246Z`; combined build hash `a723831cf4f0fac1d03a5f63e7a704bdde42720625b6cbb7c85797147d631367`. Final `npm run check`, with private-query cases enabled as described in the read-model report, passed **409 tests across 18 files**, typecheck and build. Logs and exact results are in `runs/2026-10-02-projection/`.

## New contract

`extractProjectionContext` is an opt-in, versioned source type. Exact canonical UTF-8 projection artifact bytes determine each selected task/dependency source hash. Original DAG identity/hash/time remain in a separate local-only provenance manifest. These are explicitly projection hashes, not misrepresented original-file hashes. `compileSummaryPrompt` accepts only strict `ContextInput`; passing the manifest wrapper is rejected. The original conservative whole-DAG-hash extraction is unchanged.

The independent review caught and the implementation corrected weak inner-declaration validation. Final validation checks exact canonical envelopes, status linkage, empty edges for minimal dependency records and projection-only dependency IDs. Review verified 62 focused tests, including exact hashing, bounds, legacy approval staleness, source/scope linkage and manifest exclusion. This verifies linkage and structure, not authenticity of an arbitrary upstream document or semantic truth of a generated summary.

## Actual Electron proof

- Queried the actual pinned external tool over 1,000 synthetic tasks, then explicitly selected one task
- Prepared one 2,378-byte context record; absent goal document remained unknown
- Edited an unselected task: original DAG hash changed, selected projection hash remained identical, and summary-store context update was a no-op
- Edited the selected task: selected projection hash changed
- Retained the read-model regression for unchanged-query no-op, source immutability, main-process responsiveness during actual Python execution, fixed CodeBurn queries/failures/cancellation, foreign-renderer rejection and sandbox settings
- All 19 tracked subprocess PIDs were gone; temporary snapshots and this run's fixture root were removed. Tracked Electron processes exited

The implementation agent opened the five retained final read-model screenshots at approximately 20:24 UTC: selected context, unrelated-edit no-refresh, relevant change, responsive query and cancellation. Labels and source-coverage warnings are legible. Other final run checks are automated assertions and logged results; this report does not claim every generated image was manually opened in this final run.

## Product wording correction

The production settings page now says the selected approach is Orca agents, with context/budget/execution integration still pending, rather than calling the backend decision undecided. Product Electron regression passed on `c2d496b9fa2384ea61236b0ac8ec07f0870b37a1` at `2026-10-02T20:16:22.876Z`. The settings screenshot was opened at approximately 20:16:40 UTC and is retained. Subsequent projection changes do not alter that renderer/domain wording.

## Status and limits

The new opt-in DAG projection path closes the previously documented whole-DAG invalidation limitation for explicitly selected task/dependency records. Excerpt records remain conservatively tied to their supplied upstream hashes. T-017 has tested fine-grained contract behavior; durable artifact/cache storage, production UI wiring and actual model invocation remain separate unfinished work. Old source IDs do not silently migrate approved summaries; prior approval becomes stale and needs explicit review against the new source contract.

This is still Linux development verification with synthetic sources, an external private query dependency and a synthetic CodeBurn executable. No real Orca/Claude/Codex agent, user note/inbox, provider account, Mac-native dialog or final packaged app was exercised. Instructions alone are not treated as runtime tool isolation. The canonical Mac DAG has not been updated by this implementation.
