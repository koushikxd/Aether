# Private pages

Private pages let a notes folder sync through git while some pages stay unreadable to anyone without the key. On disk a private page stays plaintext markdown. Git never sees it: each commit from Aether encrypts private files into `.aether/vault/`, and only the encrypted copies are committed and pushed.

## Behavior

- Right-click a page and choose "Make private". Its sub-pages, and assets used only by private pages, become private too. A lock icon marks private rows.
- The first time, Aether asks the user to generate a key. Without it, private pages cannot be opened on another device or recovered.
- On another device the pages show as locked ("Private pages locked") until the key is entered. Then they are decrypted into place and stay in sync on every pull.
- Settings, Private Pages: generate, show, or enter the key.
- "Make public" asks for confirmation, because the page will be pushed unencrypted on the next commit. A sub-page of a private page cannot be made public on its own.
- A commit is refused while a public page links to a private page, since the link would expose its path.
- A sync is refused while private changes are uncommitted.
- Pins of private pages stay on the device, out of the committed settings file.
- Aether installs git hooks that refuse a terminal commit holding a private file in plaintext.
- Exports leave private pages out unless the user opts in (see [export-import.md](export-import.md)). The CLI cannot see them at all (see [cli.md](cli.md)).

## Implementation

Logic is in `src-tauri/src/vault.rs`, state and dialogs in `src/context/VaultContext.tsx` and `src/components/vault/`. Commit and pull run through the vault: see [git-sync.md](git-sync.md). Every vault file on disk is listed in [architecture.md](architecture.md#data-on-disk).

- **Key**: 32 random bytes, shown as `aether-key-<base64url>`, kept in the OS keychain (`keyring`, service `app.aether.vault`, account = vault id; an in-memory store under `cfg(test)`). `vault.json` holds a key check, so a wrong key is rejected.
- **Encryption**: XChaCha20-Poly1305. A blob is `nonce || ciphertext`, with its name (`files/<id>` or `roots/<id>`) as associated data, so blobs cannot be swapped. A file blob holds `path NUL content`. A root blob holds the marked note id. Unchanged files keep their blob bytes, so git sees no change.
- **Private set**: each marked page, everything under its sub-page folder, and assets used only by private pages. Once encrypted, an asset stays private until a public page uses it. `vault::current_private_set` reads it from `.git/aether-vault.json` and needs no key.
- **Exclusion**: `write_exclude` writes the private set as anchored patterns into the Aether block of `.git/info/exclude` and installs the hooks. Marking also runs `git rm --cached` on private files git still tracks.
- **Hooks**: `pre-commit` and `pre-merge-commit`, marked `# aether-private-pages`, run `git ls-files --cached --ignored` with only the Aether block's patterns and refuse the commit if anything matches. Aether never overwrites a hook that is not its own, and skips the install when `core.hooksPath` is set. `--no-verify` bypasses them.
- **Opening a folder** runs `vault::decrypt`, which calls `sync_plaintext` when this device has the key.
- **Saves and moves**: `vault::follow_moves` updates marks after a rename or move, `vault::page_saved` refreshes the exclude block when a private page starts using a new asset, and deletes call `vault::prune_marks`.
- **Status**: `git_get_status` adds `vault::pending_count` (private edits, removals, and mark changes git cannot see) to `changedCount`. `VaultContext` refetches `privateIds` and `privateRoots` when the notes list or git status changes.

## Rules for agents

- Never commit or merge from a terminal in a notes folder with private pages, and never pass `--no-verify`: it would commit plaintext. Commit through the app.
- Leave the exclude block and the `.git/aether-*` files to Aether.
- Any new path that reads, lists, exports, or reports notes must leave out the private set, and needs a test that proves it.

## Tests

`src-tauri/src/vault_tests.rs` runs real git repos and clones in temp dirs with the in-memory key store. `tests/e2e/private-pages.spec.ts` drives the UI against `tests/e2e/fake-vault.ts`.
