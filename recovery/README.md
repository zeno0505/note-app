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
