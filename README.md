[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dnshtm9/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dnshtm9/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend applies an edit that an AI model wrote to a tree of text files. It reads four edit formats and either changes
every file the patch names or changes none of them.

## The four formats

- **unified**: a diff with `---`/`+++` headers and `@@` hunks. Hunks find their place near the line number given,
  so a wrong line number is tolerated. Creations, deletions and moves are supported.
- **search-replace**: `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks under a path line.
- **v4a**: the `*** Begin Patch` format with Add, Delete and Update sections, anchors and end-of-file chunks.
- **json**: text-editor tool calls, as one JSON array or as JSON Lines (`create`, `str_replace`, `insert`).

## Matching lines

Old lines are looked up at three strictness levels, tried in order:

1. exact;
2. trailing spaces and tabs ignored;
3. leading and trailing spaces and tabs ignored, with the added lines re-indented to the file's indent.

`--strict` allows only the exact level. An edit that matches nowhere fails, and one that matches more than once fails
where the format gives no way to choose.

## Run it

    node main.ts [options] [PATCH]

Options:

- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly.

PATCH is a file path; with no PATCH, or `-`, the patch comes from standard input.

Example, run in a directory holding `notes.txt` (containing `hello`) and `fix.patch`:

    --- a/notes.txt
    +++ b/notes.txt
    @@ -1 +1 @@
    -hello
    +bye

    node main.ts fix.patch
    # M notes.txt
    # ok: 1 file

    node main.ts --check --strict fix.patch
    # error: no-match notes.txt
    # failed: 1 of 1 edits

The second run checks against the file the first run already changed, where `hello` is gone.

## Output

Each changed path is listed on its own line, in UTF-8 byte order: `A` for a created file, `D` for a deleted file,
`M` for a modified one, and `R old -> new` for a move. The last line gives the count. On failure the exit code is 1,
one `error:` line is printed per failed edit, and no file is written.

## Licence

MIT. See `LICENSE`.
