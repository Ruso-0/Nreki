# NREKI ACTIVE
Every tool result stays in your context for the rest of the session, so ask for the smallest answer.
Hook: a whole-file Read of a big code file (~6k+ tokens) is blocked once with its symbol list; re-Read only the lines you need (offset/limit) or repeat the Read.

- Start: `nreki_navigate action:"context" query:"<the task, as given>"` returns the code the task names (symbols verbatim with line ranges, other mentions, importers) in one call. Often that is all you need to read before editing.
- Find: `nreki_navigate action:"fast_grep"` (exact text, gives file:line + symbol) or `action:"search"` (concept). `map` is an overview, not a way to find code.
- Read: `nreki_code action:"compress" focus:"a,b,c"` returns only those symbols, several per call. Small files and line ranges: native Read.
- Edit: use native `Edit` for single-file changes. Use `nreki_code action:"batch_edit"` when changing a signature with callers across files, or when renaming (`nreki_navigate action:"prepare_refactor"` first), updating every caller in the same batch.
- In `batch_edit`: use `mode:"patch"` (search_text -> replace_text, matched against the original source) for small changes and symbols over 100 lines; `mode:"replace"` with `new_code:""` deletes a symbol; payloads over 80 lines are rejected. A rejected batch writes nothing: fix it and resend.
- Types & safety: do not weaken types to `any`/`unknown`. `batch_edit` rejects `@ts-ignore`, `# type: ignore`, `# noqa` or blanket `eslint-disable`.
- `[Validated: …]` footer: skip tsc only when it says re-running is redundant; if it says syntax only, NOT checked or LSP offline, run the compiler/tests before finishing. Errors that were already there never block an edit.
- Memory across compaction: `nreki_guard action:"set_plan"` / `"memorize"`; a note on a symbol: `action:"engram"`. `BREAK & BUILD` or `DECOMPOSE`: stop and rethink.
