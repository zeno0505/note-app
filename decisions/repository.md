# Repository and integration — T-004 partial

The user provided `https://github.com/zeno0505/note-app`. Clone on the explicitly requested cloud Linux machine succeeded. The repository was empty, with no commits, branches, files, AGENTS.md or repository-local skills. Nothing pre-existing was overwritten.

On 2026-10-02 the user approved continuing implementation, publishing an initial `main` and a work branch, opening a draft PR, and synchronizing verification evidence to the project note DAG. The chosen work branch is `feat/phase1-foundation`; merging is not approved. GitHub repository metadata reports public visibility and default branch `main`.

On permission recheck, the same connected GitHub integration successfully created minimal `main` at `ae1749db7398750b802013b4698355a308270e34`. Cloud Git itself still has no HTTPS credential. The earlier stalled upload is historical. On 2026-10-05 the user authorized direct work-branch publication without a PR, prioritizing durable checkpoints. No new credentials or permission changes were made by the implementation.

A privacy audit of local commit `1d64bb0` and its eight reachable commits found no credential, personal home path, company snapshot, private endpoint or internal assistant-note content. All 19 unique screenshot images were inspected. Cloud-only execution paths in historical logs are retained as reproducibility evidence; they are not personal machine paths. The 2026-10-05 recovery audit expanded this to all 25 recovered commits, 353 historical UTF-8 text blobs and all 45 unique PNGs; no exclusions were required.

Only synthetic fixtures may enter this public repository. Do not add company worktree snapshots, company DAGs/docs, terminal content, credentials, personal machine paths or copied planning archives. The canonical plan is maintained separately. No global task completion, macOS certification or execution round is inferred from a local commit.

A bounded read-only GitHub Actions workflow is prepared for Node 24, type checking, unit tests and building. It is published on the work branch and remote push checks have started; final results are recorded in the recovery evidence. Its success will not certify native Electron UI or a packaged application. Action references were checked against the official `actions/checkout` and `actions/setup-node` v7 tags on 2026-10-02 and pinned to their commit IDs.

## Verified recovery publication (2026-10-05)

- Original recovered tip: `34253e17108d361a430af6170bc716b601e760c7`, 25 commits and 316 tracked files
- Complete history bundle checkpoint: [`86bd0b0`](https://github.com/zeno0505/note-app/commit/86bd0b0e963b048cd02102c714c476162194ed54)
- Exact source snapshot checkpoint: [`6fb441b2`](https://github.com/zeno0505/note-app/commit/6fb441b2bb0a0151a1255e72bf0f35fb178a9d1f). Every original path, mode and blob SHA was compared against the remote recursive tree; two extra recovery files preserve the bundle and instructions
- Bundle: `recovery/history/note-app-34253e1.bundle`, 4,241,435 bytes; SHA-256 `ec47d88c955903c96bfb1ff9141b3f182135f1125f596897a46a94d6aefb4008`; Git blob `1fbf7d75c5cea2941e6cb238a28d10cda401b92b`

The authenticated connector writes Git objects and verified fast-forward branch updates. It cannot preserve original commit author/timestamp metadata when constructing new snapshot commits, so remote checkpoint SHAs intentionally differ from local implementation SHAs. The intact bundle retains all original commit objects without costly replay. No credential was created or extracted. The work branch is `feat/phase1-foundation`; `main` stays at `ae1749db7398750b802013b4698355a308270e34`, with no force push, merge, PR or deployment.

Missing later commits `6a4e04e` and `acb9454` were not recovered. Their approved increments are reconstructed with fresh tests, not described as recovered bytes. See [recovery verification](../reviews/recovery-2026-10-05.md).
