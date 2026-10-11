# Scoped AI summary contract, 2026-10-09

This records the approved T054/T055/T056 implementation. The final low-density UI was approved on 2026-10-09. Development and Electron verification use synthetic fixtures and adapters, with no real model calls.

## Selection contract

- The default policy is the last **three** distinct tasks with explicitly linked code, discussion, or verification activity records. There is no seven-day filter.
- Full commit SHA declarations may be resolved to Git commit timestamps only when the repository is covered by an existing explicit local read grant. Metadata only is read. Source code bodies are not transmitted.
- The initial Git reader supports an ordinary canonical `.git` directory and local object storage. Linked worktrees, common directories, alternates, configuration includes, partial/promisor stores and unsafe paths fail closed. This can make activity unavailable; it does not authorize an expanded read root.
- Timestamped discussion/verification records must already be in bounded, authorized excerpt registrations, using `{"contract":"task-activity-v1","activities":[{"taskId":"T-1","kind":"discussion","at":"2026-10-09T10:00:00Z"}]}`. Their timestamps are labeled as declared record times, not independent proof that a discussion or verification occurred.
- A valid record must identify an existing task exactly. A filename, task status, task ID order, source mtime, or initial observation is not evidence of recent work. Invalid calendar dates and future dates are excluded. Tasks are deduplicated by their latest qualifying record; ties have a deterministic ID order.
- When no qualifying records exist, the backend returns unknown and offers direct selection. It does not silently fall back to representative tasks or fabricate past activity.
- Custom selection accepts 1–20 exact task IDs across prefixes. Deleted tasks cause rejection, not replacement. Recent and custom output identities remain separate.

## Model input and storage

The connected-project contract is version 3. Runtime/consent boilerplate is no longer forced into project facts or output paragraphs. Verification uncertainty, omissions and factual source coverage remain required. Version 1 and 2 saved results are retained and readable.

Input includes selected DAG details, selected dependencies as metadata, and only bounded, previously authorized registered Markdown excerpts that intersect explicit links on selected tasks. This is not a vault scan and does not automatically transmit every document made visible by the document browser. Current model limits remain 48,000 bytes, 12 sources and 24 facts; oversized input fails closed.

Hashes include selected content, excerpts, activity evidence, contract, project/root identity, provider/account identity, model policy and selection policy. Poll times alone are excluded. Exact selected-task content revisions avoid retiring a run solely because an unrelated task changed. Revalidation does not treat ordinary display ageing as source mutation.

## Remembered transmission and automatic runs

Local read grants and old one-time transmission acknowledgements do not grant recurring model transmission. A current main-owned proposal displays the project, exact transmitted roots, existing Claude subscription account, default-clean-settings model policy and dynamic last-three-task selection policy. Recurring consent and the automatic update switch are separate. Automatic updating starts off.

Main owns scheduling for the currently selected project only, including its task/document tabs. A visible, focused window is required to start a call or repair. Debounce is 10 seconds, the minimum project interval is 2 minutes and a durable global sliding-hour cap permits at most 6 automatic reservations. Each run permits at most 2 model calls, so the automatic upper bound is 12 calls per hour. A reserved input is not automatically replayed after failure, cancellation or restart.

Changes are coalesced to the newest hash. Source/recipient/root changes require revalidation and, when they change consent identity, renewed consent. Revocation and Off retire pending work immediately. Late responses cannot overwrite a newer selection, revoked grant or changed source. Closing a custom run must invoke its cancellation endpoint, including preflight cancellation.

One-time transfer proposals are main-owned, single-use, expire after two minutes, and bind the exact selection and displayed recipient/scope. The immutable approved binding remains enforced through controller resolution and launch, including asynchronous account changes. Account checks occur before the run and at the adapter's final authentication/launch boundary. No new credential or persistent account access is created. The model policy is the existing subscription CLI default under clean settings; it is not a promise of a fixed provider model version.

## Verification boundaries

Synthetic unit coverage includes exact task selection, invalid dates, stable hashes, separate custom/recent histories, restored manual history, unavailable automatic cache, blur during guard resolution, revoke during consent resolution, durable scheduling limits, account mismatch before launch and manual preflight cancellation. Independent security review findings were fixed and regression-tested; see `reviews/summary-ux-20261009.md`.

The production renderer now keeps recent results separate from the explicit multi-task selection dialog. Status shapes have accessible labels and keyboard tooltips. Source and diagnostic disclosures start collapsed, while errors remain visible; action errors persist through background polling. Historical v1/v2 and public results remain read-only in project settings.

An isolated production-host/preload/renderer Electron harness verifies exact recent activities, explicit consent, separate results, filter-only actions, close cancellation and focus restoration, bounded settings, and narrow/light/dark/zoom states. Final verification counts and screenshot review are recorded in the accompanying review. These tests do not authorize a release, merge, stable installation or real-user model transmission.
