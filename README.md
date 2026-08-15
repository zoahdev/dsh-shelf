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
```

Roots: `--root` overrides; default is `$DSH_SESSIONS` or `~/.dsh/sessions`. Archive/trash roots default to `sessions-archive` / `sessions-trash` next to the root.

## Safety model

- Listing, stats, export, and search are **strictly read-only**.
- Archive/trash **move** a session directory; nothing is ever deleted by the engine.
- Export never touches the source file.
- Zstandard-compressed sessions are detected and reported (plain-JSONL export in v0.1; raw `jsonl` path preserved).

## Development

```sh
node --test tests/shelf.test.mjs
node scripts/shelf.mjs list --root <fixtures>
```

## Why this is the gap

- Official discussions #1990 (no way to delete a conversation) and #1991 (archived sessions cannot be viewed or restored) are unanswered feature requests.
- The session category has 229 plugins - memory, recall, evolution - but almost nothing for **lifecycle**.
- dsh-shelf is the safe, scriptable first step: build export/archive/trash/search, then a web UI on top.

## Roadmap

- [x] list / stats / export (md/json/jsonl) / archive / restore / trash / search
- [ ] Web UI plugin (manage sessions from Settings)
- [ ] FTS5 search with Chinese tokenizer (aligns with #1999)
- [ ] Zstandard export (zstd decode)
- [ ] Schedule: auto-archive sessions older than N days

## License

MIT
