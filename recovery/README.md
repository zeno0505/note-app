# Durable recovery checkpoints

The original complete history is preserved at `history/note-app-34253e1.bundle`:

- Original tip: `34253e17108d361a430af6170bc716b601e760c7`
- Branch: `feat/phase1-foundation`; 25 commits, 631 Git objects
- Size: 4,241,435 bytes
- SHA-256: `ec47d88c955903c96bfb1ff9141b3f182135f1125f596897a46a94d6aefb4008`
- Git blob: `1fbf7d75c5cea2941e6cb238a28d10cda401b92b`

To restore the original history from a clone of this repository:

```sh
sha256sum recovery/history/note-app-34253e1.bundle
git bundle verify recovery/history/note-app-34253e1.bundle
git clone --branch feat/phase1-foundation recovery/history/note-app-34253e1.bundle recovered-note-app
```

The explicit branch is required because the recovered bundle does not advertise a default HEAD. The source snapshot at remote commit `6fb441b2bb0a0151a1255e72bf0f35fb178a9d1f` contains all 316 original files with exact path/mode/blob identity, plus this recovery documentation and the bundle.

GitHub connector checkpoint commits have new author/timestamp identities. They preserve source bytes and record local implementation SHAs in commit messages; they do not claim to reproduce original commit object IDs. All 25 original commit objects remain recoverable from the intact bundle. Later unavailable commits `6a4e04e` and `acb9454` are reconstructed work, not recovered objects.

The privacy audit covered every recovered commit, 353 historical text blobs and 45 unique screenshot images. No credentials, private company/personal notes, or private query implementation are included. Private integration tools remain external to this repository.

See [recovery verification](../reviews/recovery-2026-10-05.md) for current reconstruction and test status. Production real model execution remains blocked.

## Reconstructed implementation history

`history/note-app-reconstruction-24664a9.bundle` preserves the 11 new implementation/documentation commits after the recovered tip. It is an incremental bundle requiring original `34253e1`, not a second copy of the full repository.

- Reconstructed tested tip: `24664a99cac692aa20abb0d57ee2f6a7d4e0a96c`
- Size: 58,696 bytes
- SHA-256: `b5fc80655945c21979c59d7a0c5d412c88339259565b333ea733105ed5bf6b99`

After the original clone above, restore the reconstructed branch:

```sh
git -C recovered-note-app fetch ../recovery/history/note-app-reconstruction-24664a9.bundle refs/heads/feat/phase1-foundation:refs/heads/reconstructed
git -C recovered-note-app switch reconstructed
git -C recovered-note-app fsck --full
```

This exact two-bundle restore was independently exercised in a fresh directory: tip `24664a9`, all 36 original-plus-reconstructed commits, clean worktree and `git fsck` passed. Later evidence-only connector checkpoints can be obtained from the normal remote work branch.

## Final harness history

The newest incremental bundle is `history/note-app-reconstruction-c63708b.bundle`, including the complete reconstructed implementation and final corrected Electron harness. It requires the same original `34253e1` bundle and supersedes the earlier `24664a9` incremental bundle for restoration.

- Tip: `c63708b6ca6ec64bb89e9bf31278bd590ce8e58b`
- Size: 120,103 bytes
- SHA-256: `2e34b3bad068dadb7b9b25b88f3a17f9fcdfcdbb1a0c804060cebe1f613daf79`

Use the previous fetch/switch commands with the new filename. The two-bundle restore was reverified at this exact tip: all 39 commits, clean worktree and successful `git fsck`. Later evidence-only commits remain on the normal remote branch.
