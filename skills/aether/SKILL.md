---
name: aether
description: Read and write the user's Aether notes through the `aether` CLI. Use when the user names Aether, for example to clip a snippet, SVG, or rule to Aether, add something to an Aether page, find, read, edit, move, or check Aether pages, or check, commit, or sync the notes' git state.
---

# Aether

Aether is a desktop markdown notes app. Each page is a `.md` file in a notes folder, its file name follows its first heading, and a page's sub-pages live in a folder beside it (`Page.md` plus `Page/`). Some pages are private: the CLI hides them completely.

Aether holds the user's notes, so it is outside your context until the user asks for it. Run `aether` only to carry out a request that names Aether ("save this to Aether", "add it to the Components page in Aether").

## Running the CLI

- Pass `--json` on every command, and parse the one JSON object it prints on stdout. Exit codes: 0 ok, 1 error, 2 not found or unavailable, 3 conflict, 4 handed to the app. Errors print `{"error":{"code","message"}}`.
- Notes folder: inside the notes folder the CLI finds it from the current directory. From another repo it uses the folder open in the app; pass `--folder <path>` when the user names a folder, or when a command fails because no folder is found.
- A page is named by its **id**: its path in the notes folder, `/` separators, no `.md` (`Components/Buttons`).
- `create`, `append`, and `edit` read markdown from stdin until it closes. Feed it through a quoted heredoc (`<<'EOF'`) so `$` and backticks in code reach the page unchanged. For `create` with no body, pass `< /dev/null`.

Run `aether <command> --help` for any flag not covered here.

## Finding pages

Find pages with `aether list --json` (all pages, or `--under PAGE` for one page's sub-pages) and `aether search QUERY --json` (title matches first, then content). Work only from ids these return. The notes folder holds private pages that the CLI hides, so the CLI is the only window into it: reading, globbing, or grepping its files directly would expose them.

## Reading and editing

1. `aether read PAGE --json` returns `id`, `title`, `hash`, `markdown`, and `subPages`.
2. Build the full new markdown from `markdown`. Keep the `# Title` first line: the first heading names the page, so changing it renames the page and dropping it renames the page after whatever line comes first.
3. `aether edit PAGE --if-match HASH --json <<'EOF'` with the full new markdown. It returns `{"id","hash"}`; the id changes when the title did.
4. On exit 3 (`conflict`), the page changed since your read: go back to step 1 and redo the edit on the new content.

Use the CLI for every change, never by writing or moving files: it keeps file names in step with headings and rewrites links that point at a moved or renamed page.

- **Rename**: `edit` with a new first heading. There is no rename command.
- **Append** to the end of a page: `aether append PAGE --json <<'EOF'`. It adds a blank line, then stdin. No read or hash needed.
- **Move** a page and its sub-pages: `aether move PAGE --to PARENT --json`, or `--to /` for the top level. Returns the new id.
- **Delete** is not available. Tell the user to delete the page in the app.
- After a change that touches links, run `aether check --json`. It lists `problems` with kinds `broken_link`, `conflict_markers`, `links_to_unavailable_page`, and `title_mismatch`; fix the ones your change caused.

## Creating pages

`aether create TITLE --json <<'EOF'` creates a top-level page, or a sub-page with `--under PAGE`. The CLI writes `# TITLE` itself, so stdin holds only the body, starting below the heading. It returns `{"id","hash"}`: use that id from then on, since it can differ from the title (unsafe characters become `-`, and a taken name gets a `-1` suffix).

## Clipping from another repo

A **clip** is something the user asks you to save to Aether while working in another repo: a snippet, an SVG, a lint rule, a config.

- With no page named, create a new top-level page titled after the thing clipped.
- With a parent page named, `read` it and follow its pattern:
  - Its items are sub-pages: `create` the clip `--under` it.
  - Its items are sections in the page: add the clip as a section of the same heading level, with `append` when it belongs at the end, or `edit` when it goes elsewhere.
  - The pattern is unclear, or the page is empty: ask the user which they want.
- Put code, lint rules, and config in a fenced block tagged with its language; SVG goes in a ```svg block.
- Give each clip a `Source: <repo>/<path>` line directly above its code block, with the repo's folder name and the file's path inside it.

## Private pages and git

- `unavailable` with "path unavailable" means a private page is in the way. Tell the user the request touches a private page and stop there; that is the CLI working as designed, and there is no way around it.
- The app owns git in the notes folder: it encrypts private pages into the vault on every commit, with a key the CLI never holds. Make every git write through `aether commit` and `aether sync`; `git commit`, `merge`, `pull`, `push`, `rebase`, and `--no-verify` stay off limits in a notes folder. Aether's hooks refuse terminal commits holding private pages, and bypassing them would commit those pages unencrypted.
- `aether status --json` answers questions about git state, app open or closed: `branch`, `ahead` and `behind` (null with no upstream), `changedPages` (public ids), `otherChanges` (count of changed non-page files), `privateChanges` (a count), `mergeInProgress`, and `syncBlocked` (true: `sync` refuses until the changes are committed).
- Run `commit` and `sync` only when the user asks for that commit or sync; writing pages never calls for one. Both hand the work to the Aether app and start it if it is closed, so they need a machine where the app can open, and its window appearing is expected.
- `aether commit -m MESSAGE --json` returns a `message` of "Changes committed" or "Nothing to commit". Without `-m` the message is "Quick commit from Aether".
- On exit 1 from `commit` or `sync`, relay the message to the user: it covers a public page linking to a private one, the app having a different notes folder open, and the app not answering within 10 minutes.

### Syncing

1. `aether sync --json` pulls, merges, and pushes. Exit 0: done. Exit 1 with "Commit your changes before syncing": run `aether commit` first when the user asked for a commit, otherwise tell the user.
2. Exit 3 (`merge_conflicts`): `error.conflicts` lists the public files holding git's conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`). Resolve every one, merging both sides and removing all markers. A page: `read` it, then `edit` it with `--if-match`. A file with `"page": null`: edit the file at `path` in the notes folder directly, the one file you write by hand. Private conflicts are the app's: they appear only as the `privateConflicts` count.
3. `aether sync --continue --json`. Exit 3 again means a listed file still holds markers, fenced code blocks included: back to step 2. Exit 0: merged and pushed.
4. Exit 4 (`handed_off`): the app has opened its merge editor on the private pages. Tell the user to finish the merge in Aether, which pushes after, and end there with no further sync commands.

`aether sync --abort --json` cancels a stopped sync and restores the state before it.
