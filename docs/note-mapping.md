# Read-only scoped note mapping — T-009 preparation

Status: bounded local adapter implementation and Linux filesystem/unit verification. This is not a declaration that T-009, its decision dependencies, real Orca integration, or the note-link feature is complete. No DAG state, real note, symlink, exclude file or user repository has been changed by this work. The adapter itself has no write operations.

## Acceptance basis recorded before implementation

The assigned T-009 slice, `specs/information-contract.md` and `app/README.md` were read before implementation on 2026-10-02. The recorded acceptance is preserved: missing/broken/outside/whole-vault/multiple-DAG/shared-DAG cases, canonical identity, and no speculative matching. Real Electron integration and quality-policy gates remain separate prerequisites, owned by the parent integration work. No acceptance criterion was weakened to fit the implementation.

Input SHA-256 values read for this implementation:

| Input | SHA-256 |
| --- | --- |
| Assigned adapter task slices | `161834a9287e911d7464532a0eb6c545127837108f985733abbc129f16f5fb79` |
| `specs/information-contract.md` | `6c62a77f03527b9f41f643371a1ea6d938ff6ba54e230236eb7ade0f82251aa9` |
| `app/README.md` | `d091b0035ca6418645f7519ce01e369de0449ed86adc5337ccacb9cf468d5cc7` |

## Main-only interface

Import `mapWorktreesToNotes` and the exported types from `src/collector/notes/index.ts`.

```ts
await mapWorktreesToNotes({
  localHostId: 'explicit-observer-host',
  worktrees: [{
    worktreeId: 'verified-collector-worktree-id',
    hostId: 'explicit-observer-host',
    worktreePath: '/synthetic/worktree',
    // Optional exact registration; required when distinct registered DAGs coexist.
    selectedDagRelativePath: 'planning/dag.json',
  }],
  scopes: [{
    scopeId: 'explicit-project-scope',
    hostId: 'explicit-observer-host',
    vaultRootPath: '/synthetic/vault',
    scopePath: '/synthetic/vault/project',
    dagRelativePaths: ['planning/dag.json'],
  }],
  signal: abortController.signal,
  timeoutMs: 5_000,
});
```

The paths above illustrate the interface only. They are not built-in defaults or paths to be probed. The caller must supply verified collector worktree identity and explicitly configured, narrow allowlisted note scopes from a trusted main-process boundary. Renderer input must not choose arbitrary filesystem paths, host identity, roots or registrations. This adapter does not establish Git identity, ask Orca for records, discover configuration, or expose a product IPC endpoint.

`vaultRootPath` is an explicit declaration of the actual vault root. `scopePath` is a selected project directory strictly below that root, both lexically and after `realpath`. They are not interchangeable. The adapter never infers a vault from a parent directory, silently treats the selected project as a vault root, searches for vault markers, or expands authorization. A caller that supplies false root metadata has violated this input contract; the mapper cannot infer the user's intended vault without additional approved evidence.

### Output

- `status: complete | partial | invalid-request`. Complete means every supplied worktree resolved and no local scope validation failed; it does not mean complete vault discovery, fresh Orca coverage or task completion
- `mappings`: one resolved/unresolved result for each supplied worktree. Unresolved rows contain `reason`, `stage` and, when applicable, an allowlisted `errorCode`. They do not contain raw exception text/stack traces
- Resolved rows include `worktreeId`, `hostId`, `scopeId`, `canonicalWorktreePath`, `canonicalNotePath`, `canonicalDagPath` and `dagId`
- `dags`: deduplicated canonical DAGs with `dagId`, `hostId`, `canonicalDagPath` and sorted `worktreeIds`
- `scopeIssues`: exact configuration/root failure reason per rejected local scope
- `filesystemOperations`: bounded metadata-call count
- Invalid whole-request schema/limits/duplicate host+identity return `invalid-request`, an `inputError`, no rows and zero filesystem calls

An explicitly empty worktree input returns complete empty output without touching configured scopes. Missing evidence, partial mappings and failed scopes are not empty success. The caller remains responsible for retained observations, freshness and presenting unresolved rows. A remote-only batch performs zero filesystem calls. Remote-host records, including opaque Windows paths on Linux, are returned as `remote-host` and cannot borrow local paths with the same spelling.

## Read and selection rules

1. Validate bounded inputs and copy them before the first asynchronous operation, preventing in-flight caller mutation of allowed roots
2. Only resolve scopes belonging to the exact observer host and only when local worktrees exist. Validate explicit vault and project directories using asynchronous `lstat`, `realpath` and `access`
3. Resolve a local worktree directory, then its fixed `docs` directory. A `docs` symlink must remain strictly inside that worktree. Resolve only the fixed `docs/note` path
4. Require the note to be a directory inside exactly one allowed canonical project scope. Reject whole-vault targets, outside targets, files and overlapping scope ambiguity. No repository, branch, display name or terminal state supplies a fallback match
5. Consider only explicitly registered DAG paths lexically beneath that note directory. Never look in a note's parent to find a registered DAG. If an explicit selection exists, it must exactly match a registration and remain beneath the note
6. Inspect each component of an eligible registered path without enumeration. Check intermediate symlink canonical containment before attempting child metadata. Check both project and note containment, regular-file type, readability, and stable original-to-canonical resolution. No DAG bytes are opened or parsed
7. Deduplicate alias registrations by canonical file path. One canonical file resolves; multiple distinct canonical files remain `ambiguous-dag` unless explicitly selected. An unavailable registration does not silently disappear to make a different file look uniquely selected. Exact selection can exclude irrelevant registrations
8. Recheck the worktree, vault, project scope, docs and note chain after DAG resolution to detect observed path replacements

Missing note, broken note symlink, unavailable worktree/docs, missing/unreadable/broken DAG, directory-as-DAG, link loop and selection failures remain explicit. Safe OS codes are restricted to `ENOENT`, `ENOTDIR`, `EACCES`, `EPERM`, `ELOOP`, `ENAMETOOLONG`, `EIO`, `EMFILE`, `ENFILE` or `UNKNOWN`.

The DAG identity is `dag:` plus SHA-256 of the exact JSON tuple `['note-dag-v1', hostId, canonicalDagPath]`. It is deterministic for a canonical path on a host and independent of repository, worktree aliases, input ordering or scope label. Worktrees sharing one canonical DAG produce one DAG entry; different DAGs in the same repository stay distinct. Hard links at different canonical paths are distinct by design. Identity does not imply DAG content/version identity; future parsers need their own byte hash/mtime provenance.

## Bounds and limits

`NOTE_MAPPING_LIMITS` fixes maximums at 1,000 worktrees, 64 scopes, 32 registrations per scope, 4,096 characters per path or worktree identity, 256 characters per host/scope identity and 20,000 filesystem metadata operations. Registration-array length is checked before any copy or element iteration, including sparse-array elements. Worktree IDs retain the Orca parser's 4,096-character bound because they may contain `repo::absolute/path`; no hidden shortening or normalization is applied. Registered relative paths reject absolute paths, empty/dot/dot-dot components, backslashes and control characters. No recursive `readdir`, globbing, shell, child process, `readFile`, network request, writes or automatic parent walk exists in this adapter.

All metadata calls are asynchronous and sequential, with at most one native call in flight. The whole-request deadline is 5 seconds by default and configurable only between 1 ms and 30 seconds. Cancellation, deadline and operation-limit states stop scheduling further filesystem calls and remain unresolved, even if no scope resolved. Node's underlying `lstat`/`realpath`/`access` operation is not forcibly cancellable: one already-started read-only metadata call may settle after the returned cancellation/timeout. Its result is ignored, and its rejection is handled by the raced promise.

This is a bounded read-only observation, not an atomic security capability. `realpath` must follow symlink resolution to determine that a target escapes, but an escaped canonical target is rejected before target type/access checks or child traversal. Concurrent malicious filesystem replacement cannot be excluded by portable path APIs. The adapter rechecks observed paths, but any future DAG-content reader or link writer must independently revalidate scope and use an appropriate race-resistant opening strategy; it must never treat this result as durable authorization. No content reader or writer is implemented here.

## Verification and evidence

Observed 2026-10-02 at approximately 17:47 UTC in the assigned dot cloud Linux workspace, Node v24.19.0, running as an unprivileged user. The executor's own displayed Vitest wall-clock is offset (it prints `02:46:52`); the UTC observation here follows the task time supplied by the runtime. The tests create and remove only unique temporary fixture roots. File/symlink creation, permission changes and cleanup are confined to those fixtures.

Exact focused commands, repository root:

```sh
./node_modules/.bin/vitest run --root . tests/unit/note-mapping.test.ts
./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --esModuleInterop --strict --skipLibCheck src/collector/notes/index.ts tests/unit/note-mapping.test.ts
```

Final focused output:

```text
Test Files  1 passed (1)
     Tests  62 passed (62)
  Duration  1.01s (transform 89ms, setup 0ms, import 115ms, tests 753ms, environment 0ms)
TypeScript: exit code 0, no diagnostics
```

The 62 tests cover actual normal/missing/broken/outside/whole-vault/multiple/shared-DAG directory and file fixtures; note, scope and DAG aliases; prefix siblings; intermediate symlink escapes; narrower notes; overlapping scopes; self-cycle, two-link cycle and long link chain; real Linux `EACCES`; directory/file type mismatch; stable host/path identity; remote-host zero-call behavior; exact multi-DAG selection; no scans/content reads/writes; invalid/sparse/bounded inputs; pre-start and mid-read abort; deadline; actual 20,000-call budget; safe error redaction; caller mutation; path/scope-link replacement detection; oversized sparse arrays without element access; and parser-to-mapper contracts preserving long worktree identity and mapping state.

Most checks use actual filesystem fixtures. Spies observe metadata calls or inject narrow timing/error conditions for deterministic cancellation, nonsettling timeout, arbitrary-error redaction and replacement timing. Those simulated failure tests are not proof of a hung native filesystem or production race immunity. Permission, loop, symlink and containment cases use actual Linux behavior.

Earlier development runs were not counted as final passes: the first spy implementation could not replace ESM namespace exports (42/53 passed), and a later run exposed a deadline rounding state issue (52/53 passed). The test observation seam now uses Node's mutable default promise API object; the mapper retains an explicit stopped-deadline state. Strict TypeScript also caught an overly narrow test-only extra repository-field cast, which was corrected without adding repository identity to the production interface. The final focused tests and strict typecheck above were rerun after those fixes, subsequent stability/budget additions and independent-review boundary corrections. That review found a registration-array copy before its length guard and a mismatch between the parser's 4,096-character worktree identity bound and the mapper's former 256-character limit. The guard now runs first, and a dedicated 4,096-character worktree-ID limit preserves the parser contract. Regression tests prove a million-slot sparse array never touches its throwing element getter, an actual 289-character path-based ID maps alongside a normal row unchanged, a 4,096-character remote ID stays unresolved as `remote-host` rather than invalidating the batch, and a 4,097-character ID is rejected before filesystem access.

Final verified source hashes:

| File | SHA-256 |
| --- | --- |
| `src/collector/notes/index.ts` | `e992cf38e624496510137501d63c21ee59fb97d297313a621f39f29cd8fee066` |
| `src/collector/notes/note-mapping.ts` | `427b9002a1900a040b7155051430793866d974a58bcad0082333faeb801d195b` |
| `src/collector/notes/types.ts` | `c8837f202a0b71d4f50c79722b4423f04451bb0b05daffcb11b358e01c98d873` |
| `tests/unit/note-mapping.test.ts` | `d45c55f25b0189903616df4fadc8d5c09fbf5b4dea614277e2c2f29bff392aa9` |

UI-independent focused checks do not create a screenshot obligation. Real Electron import/integration, renderer responsiveness, real Orca records, actual user vaults, macOS case/permission/native-dialog behavior, packaged `.app`, persistent scope configuration, note-link writing and DAG parsing remain outside this focused proof. Parent integration evidence must be recorded separately. T-009 and decision/quality gates remain open; no push, PR or commit was made by this work.

## Final actual Electron evidence

See `reviews/collector-verification.md` for the exact clean code commit, final real Linux Electron fixture-integration commands/results, screenshots actually inspected and remaining scope limits. This is not real Orca or native Mac verification.
