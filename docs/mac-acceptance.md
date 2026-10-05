# Mac acceptance checklist

Use a fresh authorized checkout of the supplied final branch/bundle. Record its
exact commit, macOS/CPU, host Node, Electron/bundled Node, installed Orca/CodeBurn/
Git/Python versions and the reviewed external query hash. Linux fixtures do not
replace any real-source or native check below.

## Before connecting real sources

- Run the default unit suite without canonical TMPDIR overrides; separately enable the approved private-query cases with synthetic files
- Build and run the ordinary production entry, confirming sandbox/context isolation and no Node renderer bridge
- Confirm a missing/invalid configuration stays unavailable and opening the app alone launches no collector
- Provide exact installed executable paths and one narrow registered project scope; never register a whole vault as a note target
- Check app-cache owner/modes and relevant native ACLs; no automatic permission weakening or cache takeover
- Record the exact OS permission item if a prompt or denial appears; do not infer it from an earlier diagnostic

## Read-only actual-source acceptance

- Run the four fixed Orca queries through the updated adapter; verify all observed records including empty branch/null project without inventing IDs
- Confirm runtime/host/instance joins and project-list unknown completeness
- Test the production overview/detail/settings against the same observed scope
- Verify terminal connectivity, agent state, DAG declaration and E2E/commit evidence remain distinct
- Check CodeBurn provider usage and unavailable quota separately; unknown calendar basis/agent availability is not zero usage or a spending cap
- Check fresh, stale, error, empty, focus/hide/resume, cancellation/reconnect and read-only source-byte preservation

## Local review/setup acceptance

- First exercise summary/candidate/approval persistence using synthetic local evidence; keep real provider execution blocked
- Verify cache restart, changed source rejection and partial-write recovery messaging on Mac
- Test note proposals and local exclude behavior in a disposable native Git repository/worktree first, including paths with spaces and relative metadata
- Check cancelled, stale/conflicting, no-op, permission-denied and recovery states
- For any real project link change, review its exact paths and shared exclude impact and obtain that explicit confirmation before mutation

## Real agent activation is a separate gate

The current production build has no activation switch. Do not change the gate
merely because the UI or read-only CLI passes.

Before any authorized real model trial, verify the installed terminal request,
acknowledgement, turn-start, response framing and safe cancellation contracts.
Schema/help evidence for create/send/read/wait is insufficient. Submission does
not prove a turn started; TUI idle does not prove semantic completion. Never blindly
resend an uncertain request.

Independently verify that the exact Claude/Codex invocation cannot read outside
the supplied bounded context, invoke tools, discover MCP/customizations or fetch
vault/inbox content. Claude's help flags are untested enforcement claims; Codex
read-only plus cwd does not establish read confinement. Then confirm execution
cost/availability constraints and explicit authorization for the trial.

Only after those gates should real summary factuality, omission, readability and
usefulness be evaluated with the user. No synthetic test establishes those outcomes.

## Native release acceptance

- Finder/packaged launch configuration and executable discovery without a developer shell
- Startup, idle, hidden/resumed and large-project resource behavior
- Required native dialogs/permissions and supported minimum macOS version
- Packaging/signing/notarization/release distribution if in scope

Mark each item as passed, failed or not run with evidence. Keep the agent/security
gate distinct from Mac UI acceptance; neither automatically satisfies the other.
