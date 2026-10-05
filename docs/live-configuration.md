# Explicit local read-only configuration

The production window can now connect the existing bounded collectors. Nothing is
collected automatically: start with an explicit local configuration, review its
status under **연결 및 설정**, then choose **설정된 소스 연결**. This is local
development integration, not a packaged/Finder macOS acceptance result.

## Minimal Orca configuration

Create a private JSON file outside this repository. Use only trusted installed
executables; configuring a path authorizes this application to execute the fixed
read-only commands documented below. The renderer cannot set paths or arguments.

```json
{
  "schemaVersion": 1,
  "orcaExecutablePath": "/usr/local/bin/orca",
  "codeburnExecutablePath": "/opt/homebrew/bin/codeburn"
}
```

CodeBurn is optional. Start the development application from a terminal:

```sh
NOTE_APP_CONFIG="/absolute/private/path/note-app.json" npm start
```

Paths containing spaces remain one argument. No shell is used for collectors and
no PATH lookup is used for their executable selection. Configuration is read once
per app launch. Edit the file and restart to change it; a renderer reload does not
reload configuration. Missing, invalid, oversized, symlinked final-component or
unreadable configuration files are explicit unavailable states. The app never
guesses a vault, parent directory, host identity, project identity or executable.

The real Mac diagnostic verified the Orca and CodeBurn executable paths shown
above with fixed argument arrays in Node and Electron main, including minimal
PATH and `/tmp` working directory. That diagnostic preceded this UI integration.
It is not proof of this updated app on macOS, Finder launch or packaging.

## Opt-in project notes and DAG query

Register a narrow project directory strictly below an explicit vault root, its
actual local Orca host ID, and exact DAG-relative files. A worktree must already
have its `docs/note` link to that scope. This app neither creates nor changes links.
The mapper resolves and revalidates canonical paths without directory enumeration.
Remote hosts and missing or ambiguous mappings remain unresolved.

Example using fictional paths and IDs:

```json
{
  "schemaVersion": 1,
  "orcaExecutablePath": "/usr/local/bin/orca",
  "localHostId": "replace-with-local-orca-host-id",
  "noteScopes": [{
    "scopeId": "example-project",
    "hostId": "replace-with-local-orca-host-id",
    "vaultRootPath": "/Users/you/Notes",
    "scopePath": "/Users/you/Notes/Example Project",
    "dagRelativePaths": ["dag.yaml"]
  }],
  "dagQuery": {
    "pythonPath": "/absolute/trusted/python3",
    "queryScriptPath": "/absolute/private/query.py"
  },
  "summarySelections": [{
    "scopeId": "example-project",
    "dagRelativePath": "dag.yaml",
    "taskIds": ["T-001", "T-002"]
  }]
}
```

No private query script is bundled. It must match the reviewed hash in
[the DAG reader contract](dag-read-model.md), and Python must provide PyYAML in
isolated mode. At most eight explicit DAG registrations and 32 selected task IDs
per registration are accepted. The view displays at most 200 tasks per DAG and
keeps the actual total visible. Display limits do not silently select model input.
Status categories and task-reference lists have separate display caps and explicit
omission counts. The overview shows worktree cards in bounded batches.

## Summary and cache boundary

There is no enabled live agent transport or real model call. The detail view can
prepare a selected context, explain provider/budget uncertainty, and review an
existing candidate. The request control remains disabled in production while the
transport gate is unresolved. Claude/Codex help text alone does not prove
bounded filesystem access, and a read-only sandbox does not prove read confinement.

Configured selections prepare bounded local task projections, direct dependency
status, and optional explicitly registered goal/document/inbox line excerpts as
described below. No source is discovered by directory crawling. Missing goal
excerpts remain unknown. Unselected task content is
excluded from the summary context. The complete local provenance manifest and
runtime approval/request tokens never cross renderer IPC.

The read model and explicit candidate approval/rejection flow use a host-owned cache at:

```text
<Electron userData>/summary-cache/<contextScopeId(dagId)>/summary-cache-v1.json
```

These files use the existing strict [summary storage contract](summary-storage.md).
The application does not import a renderer/model-supplied cache or create fabricated
summaries when a cache is missing. An existing valid candidate can be explicitly
approved or rejected through a main-owned ticket; the source mapping and selected
DAG and configured excerpt files are freshly reread before approval. A test-only synthetic transport exercises
new candidate persistence without activating any production provider. Historical candidate and approval states are distinct,
and current evidence changes mark affected retained claims stale. Cache integrity
does not authenticate the historical human approval. A missing cache is empty;
corrupt or unsafe cache data is an error, not a fresh empty success.

On POSIX, cache roots, derived scope directories and existing cache files must be
owned by the current effective user and have no group/world permission bits. The
app rejects unsafe existing permissions; it does not silently chmod or take over.
ACL behavior and native Mac permissions still require Mac acceptance.

## Optional confirmed note connection

To enable scoped link proposals, add this to the same startup file, alongside
the required local host and registered note scopes:

```json
"noteLink": {
  "gitExecutablePath": "/usr/bin/git",
  "allowedCommonGitDirs": ["/absolute/registered/repository/.git"]
}
```

The exact common Git directories authorize linked-worktree metadata, not arbitrary
repositories. An ordinary selected worktree may use its direct `.git` directory.
Choose a configured project scope in the detail view, inspect the exact `docs/note`
target, proposed local `/docs/note` exclude append and all worktrees sharing that
exclude, then confirm. Cancelling a preview writes nothing. Existing different
links/files, tracked note paths, stale previews and unsafe metadata are rejected.
The app never modifies tracked `.gitignore` files or invokes the old whole-vault script.

Partial results require inspection of the displayed recovery paths. Repeating the
same confirmation returns its recorded result without repeating the mutation.
Rollback preserves concurrent foreign changes; unresolved OS operations are not
reported as a successful rollback. See the
[transaction boundary](../src/collector/notes/link-workflow/README.md).

## Observations and failures

- Orca runs only `status --json`, `project list --json`, `worktree list --limit 1000 --json`, and `worktree ps --limit 1000 --json`
- CodeBurn runs only the two provider `status --format json --provider ...` commands and `quota --format json`; plan/budget data is not interpreted as a spending cap
- Project-list completeness can remain unknown even when worktree lists are complete
- Empty branch is unavailable information, not evidence of a particular branch or detached-head cause
- Terminal attachment, observed agent state and declared DAG status remain independent
- Quota data availability does not prove an agent can run; unavailable quota is not zero usage
- Refresh failure retains last-good observations with their original timestamps and a stale warning
- Visibility/focus-aware polling uses the existing 20-second cadence; explicit disconnect cancels outstanding collection
- Startup and cache responses are deadline-bounded; an interrupted/timed-out cache or metadata reader can remain retired until app restart rather than accumulate overlapping kernel IO

A bounded response is not a guarantee that an operating-system filesystem call
has been cancelled. The original operation retains cleanup ownership; its late
result cannot replace the displayed unavailable state.

All external navigation, remote renderer fetch, webviews and permission grants
remain blocked. Source strings are rendered as text. Connecting collectors does
not write notes or execute providers. The separately confirmed setup operation
changes only the previewed local link/exclude, and summary review writes only the
private app-owned cache. No public upload is part of these flows.

## Explicit registered excerpt selections (reconstructed increment B)

Each `summarySelections` entry may additionally supply `excerpts`. This is trusted
startup configuration only; the renderer cannot provide paths or expand it:

```json
"excerpts": [
  {"id":"goal","kind":"goal-document","relativePath":"goal.md","startLine":2,"endLine":4},
  {"id":"decision","kind":"document","relativePath":"decisions/review.md","startLine":7,"endLine":8},
  {"id":"inbox-item","kind":"inbox","relativePath":"inbox/selected-item.md","startLine":1,"endLine":2}
]
```

Paths are exact registrations relative to the selected project scope, and must
also remain inside its mapped note directory. The scope and all source path
components must be canonical real directories/files, not symlinks. A whole-vault
root, traversal, glob, recursive search, arbitrary code file discovery, hardlink,
special file, invalid UTF-8 or unstable read fails closed. Line ranges are
inclusive and 1-based; newline bytes are retained. Byte ranges shown in the
preview use a zero-based inclusive start and exclusive end. Missing or blank
selected lines fail rather than silently choosing another range.

Bounds: eight registered files across configuration, 32 excerpt selections per
summary scope, 128 KiB per file, 512 KiB aggregate file bytes per read, 2 KiB per
excerpt and 12 KiB total selected text. Multiple registered ranges may share one
file read. Only bounded selected text reaches the context/preview. Local canonical
paths, whole-file hashes and lineage remain in the private cache manifest. These
bounds constrain bytes, not the truth or completeness of source content.

Both the reader and live runtime bound pending responses to five seconds. A
cancelled/timed-out reader lifetime is retired; it retains ownership of late
kernel I/O and descriptor cleanup, and is never replaced during that runtime.
Restart is required after such a timeout. No app read writes to source notes.

Source selection IDs bind the exact registration; source hashes bind selected
UTF-8 bytes. An edit outside the selected lines leaves the selected-text hash
unchanged, while its local file hash/byte offsets can change. Changed selected
bytes and registration additions/removals require a new candidate review.
A saved candidate/approval cache supplies the comparison checkpoint after restart.
Preparation alone saves no checkpoint, so an unsaved restart establishes a new
baseline. The UI distinguishes new, changed, unchanged and no-longer-observed
sources. Approval rereads mappings, selected DAG and registered files; unavailable
or changed current evidence blocks approval while preserving historical approval.
Production agent execution remains hard-blocked throughout.

An exact registered DAG alias is matched through the existing scoped mapper,
never by guessing a path suffix. A sibling DAG with no applicable excerpt
registration keeps an empty excerpt selection. Source-file and scope-directory
aliases remain unsupported by the excerpt reader and surface as an error; they
are not silently treated as absent registrations.
