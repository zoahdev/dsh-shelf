# dsh-shelf

> Session lifecycle for DeepSeek Harness: **export, archive, restore, trash, search, and stats** for your dsh session library. Zero dependencies, read-only by default.

Every dsh user accumulates hundreds of sessions and has no way to manage them (#1990, #1991). dsh-shelf is the missing shelf.

## Quick start

```sh
npx dsh-shelf list                          # every session with id + path
npx dsh-shelf stats                         # counts, compressed/plain, bytes
npx dsh-shelf search "parser bug"           # header + body search (plain sessions)
npx dsh-shelf export <id> --format md       # Markdown transcript to stdout
npx dsh-shelf export --all --format jsonl --out all-sessions.jsonl
npx dsh-shelf archive <id>                  # move to sessions-archive (never deletes)
npx dsh-shelf restore <id>                  # move it back
npx dsh-shelf trash <id>                    # move to sessions-trash (recoverable)
npx dsh-shelf restore-trash <id>
npx dsh-shelf report                        # weekly session digest (Markdown)
npx dsh-shelf report 30 --format json       # 30-day digest as JSON
npx dsh-shelf report 14 --format html --out shelf-report.html   # offline dashboard
npx dsh-shelf verify                        # session health check (orphan tool calls, unfinished, empty)
npx dsh-shelf rescue <id>                   # export an un-resumable session's content
npx dsh-shelf archive-old 30                # dry run: sessions older than 30 days
npx dsh-shelf archive-old 30 --yes          # move them to sessions-archive
npx dsh-shelf tree                          # session fork lineage
npx dsh-shelf tree <id>                     # message tree (pi /tree)
npx dsh-shelf web                           # local web panel at http://127.0.0.1:4174
```

DSH plugin mode (panel bound to the active profile):

```sh
dsh plugin --profile web add github:zoahdev/dsh-shelf
# panel at http://127.0.0.1:4174 (committed lib/, no build at install)
```

Roots: `--root` overrides; default is `$DSH_SESSIONS` or `~/.dsh/sessions`. Archive/trash roots default to `sessions-archive` / `sessions-trash` next to the root.

## Message navigation (`/tree`)

Slim clone of [pi](https://github.com/earendil-works/pi) `/tree` (double-Esc). DSH stores branches *between* sessions (`parentSession` + `seedLength`), so the tree is reconstructed from fork lineage rather than an in-file entry graph. Labels, fold, and branch summarization are not copied.

Filter (default `no-tool`; cycle `o` in the panel, or `--filter` / `/nav user`): `no-tool` (user + assistant text), `user`, `all` (includes tool calls).

| Surface | How |
| --- | --- |
| CLI | `dsh-shelf tree` (session lineage) / `dsh-shelf tree <id>` (messages) |
| Web panel | **Double-Esc** or the Tree button. ↑/↓ move, Enter preview / open, Esc close |
| Host plugin | `/nav` on **`dsh --profile pi-tui` only**. `dsh web` / `--profile web` is **not supported** (its question form is not a tree UI). |

Selecting a user message forks *before* that turn (resubmit). Selecting an assistant message forks through its completed turn (continue from there). The handler prints a `/resume` hint; it does not switch the TUI.

## Safety model

- Listing, stats, export, and search are **strictly read-only**.
- Archive/trash **move** a session directory; nothing is ever deleted by the engine.
- Export never touches the source file.
- Zstandard-compressed sessions are detected and reported (plain-JSONL export in v0.1; raw `jsonl` path preserved).

## Development

```sh
node --test tests/*.test.mjs
node scripts/shelf.mjs list --root <fixtures>
```

## Why this is the gap

- Official discussions #1990 (no way to delete a conversation) and #1991 (archived sessions cannot be viewed or restored) are unanswered feature requests.
- The session category has 229 plugins - memory, recall, evolution - but almost nothing for **lifecycle**.
- dsh-shelf is the safe, scriptable first step: build export/archive/trash/search, then a web UI on top.

## Roadmap

- [x] list / stats / export (md/json/jsonl) / archive / restore / trash / search
- [x] weekly digest (`report`) + auto-archive (`archive-old`, dry-run by default)
- [x] local web panel (`dsh-shelf web`) - list/search/export/archive/trash + daily chart from the browser
- [x] offline HTML dashboard (`report --format html`) - shareable per-day bars + largest sessions
- [x] Chinese search via CJK bigram tokenizer (zero-dependency; aligns with #1999)
- [x] DSH plugin wrapper (`dsh plugin add github:zoahdev/dsh-shelf` opens the panel)
- [x] session health check (`verify`) + rescue export for un-resumable sessions (#1959/#2034 family)
- [ ] FTS5-backed search when the host provides SQLite FTS5
- [x] Zstandard export (node:zlib decode on Node >= 22.19)
- [x] Message navigation (`tree`, double-Esc in the web panel, `/nav` on the host) — slim clone of pi `/tree`

## License

MIT
