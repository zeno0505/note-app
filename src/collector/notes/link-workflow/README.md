# Main-owned note-link workflow

`createNoteLinkWorkflow(options)` is a scoped TypeScript adapter. It never runs the old no-argument whole-vault script. It is main-process-only; renderer requests use `src/shared/note-link-workflow.ts` opaque IDs and the exact server-issued proposal ID/token pair.

## Integration

- Trusted startup supplies an absolute Git executable, exact explicitly authorized common Git directories for linked worktrees, and `resolveSelection(worktreeId, scopeId)`
- Resolver returns verified local host/worktree identity plus one explicit scope/vault registration. It must not infer authorization from renderer paths, a `.git` pointer, a repository name, or an unavailable/remote collector row
- `preview(request, signal?)` returns a bounded, expiring proposal showing canonical paths, exact append delta/hash/size, temporary-file path, all current Git worktree registrations sharing the exclude, conflicts, and no-op state
- `confirm({proposalId, confirmationToken}, signal?)` consumes that exact proposal, resolves its selection again, and compares filesystem identities/mtime/bytes and Git metadata before writing. Main must invoke confirm only after explicit UI confirmation
- `cancel(proposalId)` invalidates an unused preview. It does not undo a confirmed transaction
- A repeated exact confirmation returns the cached actual result and never reruns a write. There is one in-flight preview or confirmation; bounded maps retain at most 32 proposals/results
- A partial transaction retires the service from new preview/confirm work. Show recovery paths and require local inspection before reopening the workflow. Do not automatically recreate the service to bypass this guard

## Filesystem and Git boundary

Whole-vault and recursive note targets are forbidden. Existing files, directories, different links, broken links, and `docs` symlinks are never replaced. `docs` may be created only when that exact missing directory was previewed. A correct existing note link plus an effective exact local exclude can be a no-op.

Ordinary `.git` must be a direct directory at the selected canonical worktree. A linked `.git` file must resolve beneath an explicitly registered common directory, and its `commondir` must equal that exact authority; its registration must point back to the worktree. `info` must already be a direct directory. Symlinked or hard-linked exclude files are rejected. The adapter fails closed when Git lacks required absolute-path/porcelain output; it does not guess a relocated metadata path.

Git uses a trusted executable, fixed argv, `shell:false`, a sanitized environment, no optional locks, and explicit `core.fsmonitor=false` and disabled hook directory to prevent repository-configured commands. The read-only commands are `rev-parse` for top/common/exclude, `worktree list --porcelain -z`, fixed-path `ls-files`, and fixed-input `check-ignore`. Git output is bounded to 256 KiB per invocation; the entire preview/confirmation has a main-owned deadline.

The adapter rejects tracked note paths even when their working files are absent. It preserves existing exclude bytes/newlines, appends `/docs/note` only as needed, and adds a new final rule if later negations could override an existing one. No `.gitignore` is modified. Final Git verification rejects ineffective exclusion, such as higher-priority `.gitignore` negation, and rolls back owned changes when safely possible.

Existing exclude replacement uses a same-directory exclusive temporary file with explicit original mode, bounded writes and fsync, followed by snapshot verification and rename. Absent exclude creation uses an atomic hard-link create-if-absent followed by temporary-link cleanup. Rollback restores only owned bytes/links/directories whose inode, mode and relevant contents are still verified. It leaves foreign replacements, concurrent edits and nonempty directories intact, returning explicit recovery instructions.

## Honest limits

These are portable Node path APIs, not descriptor-relative atomic compare-and-swap operations. Revalidation detects observed changes, but cannot prove freedom from an adversary replacing parents between check and mutation. Rename cannot preserve every ACL/xattr, inode identity, or guarantee recovery after process/power loss. No adversarial-race-proof or durable crash-recovery claim is made.

A native filesystem operation can remain in flight after cancellation or deadline. The service does not race it with rollback: it reports `partial` with uncertain actual state, retains its ownership context through settlement, refuses automatic retry, and starts bounded/eventual descriptor cleanup. Application shutdown should await the service response; a partial response is still an inspection requirement, not proof that OS operations finished. Read-only metadata calls can also settle after deadline with results discarded.

Focused tests use only unique temporary synthetic fixture directories and real temporary Git repositories/worktrees. Injected failures/cancellation cover observed ordering, not kernel-hang or adversarial-race proof. macOS native dialogs, actual user vaults, permissions/ACL behavior and real Orca observations require separate host/UI validation.
