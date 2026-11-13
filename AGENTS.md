# AGENTS.md — NREKI MCP instructions for AI coding agents (Codex, Gemini, others)
NREKI checks edits (syntax + types, in RAM) before writing them. Every tool result stays in your context for the rest of the session, so ask for the smallest answer.

- Start: `nreki_navigate action:"context" query:"<the task, as given>"` returns the code the task names (symbols verbatim with line ranges, other mentions, importers) in one call. Often that is all you need to read before editing.
- Find: `nreki_navigate action:"fast_grep"` (exact text, gives file:line + symbol) or `action:"search"` (concept). `map` is an overview, not a way to find code.
- Read: `nreki_code action:"compress" focus:"a,b,c"` returns only those symbols, several per call. Small files: `nreki_code action:"read"` or a native line-range read.
- Edit: one `nreki_code action:"batch_edit"` with every change. `mode:"patch"` (search_text -> replace_text, matched against the original source) for small changes; symbols over 100 lines require it; payloads over 80 lines are rejected. A rejected edit writes nothing: fix it and resend. In code mode, run your tests/checker in the same cell, right after it.
- Changing a signature: update its callers in the same batch. Do not weaken types to `any`/`unknown`. Edits that add `@ts-ignore`, `# type: ignore`, `# noqa` or a blanket `eslint-disable` are rejected. Rename: `nreki_navigate action:"prepare_refactor"` first.
- `[Validated: …]` footer: skip tsc only when it says re-running is redundant; if it says syntax only, NOT checked or LSP offline, run the compiler/tests before finishing. Errors that were already there never block an edit.
- Memory across compaction: `nreki_guard action:"set_plan"` / `"memorize"`; a note on a symbol: `action:"engram"`.
- `BREAK & BUILD` or `DECOMPOSE` in a response: stop and rethink the approach.
