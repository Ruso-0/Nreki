---
name: nreki-optimizer
description: Edit code through NREKI MCP tools (edits checked for syntax and types before writing) and read only the symbols a task needs.
---

# NREKI ACTIVE
If nreki_* tools fail, native Read/Edit/Write still work. While a NREKI server runs, the Claude Code hook blocks only whole-file Reads of big code files (~6k+ tokens), once, answering with the symbol list: re-Read the lines you need (offset/limit) or repeat the Read.

Every tool result stays in your context for the rest of the session, so ask for the smallest answer.

## Find and read
- Start: `nreki_navigate action:"context" query:"<the task, as given>"` returns the code the task names (symbols verbatim with line ranges, other mentions, importers) in one call. Often that is all you need to read before editing.
- `nreki_navigate action:"fast_grep"`: exact text, gives file:line + symbol. `action:"search"`: concept search. `map` is an overview, not a way to find code.
- `nreki_code action:"compress" focus:"a,b,c"`: only those symbols, several per call. Small files and line ranges: native Read.
- `outline` lists a file's symbols. If it says `[BUDGET LIMIT REACHED]`, read the omitted symbols with `compress focus` before editing them.

## Edit
- One `nreki_code action:"batch_edit"` with every change (all-or-nothing). A rejected edit writes nothing: fix it and resend.
- `mode:"patch"`: search_text -> replace_text inside the symbol; indentation is matched loosely. Symbols over 100 lines require it (`NREKI_SYMBOL_LIMIT`). Payloads over 80 lines are rejected: split them. Several patches to one symbol go in one batch, each matching the ORIGINAL source.
- Changing a signature: update its callers in the same batch. Rename: `nreki_navigate action:"prepare_refactor"` first.
- Do not weaken types to `any`/`unknown`. Edits that add `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, `# type: ignore`, `# pyright: ignore`, `# noqa` or a blanket `eslint-disable` are rejected. NREKI may add a missing import itself; keep it.

## Verify
- The `[Validated: …]` footer says what was checked. Skip tsc only when it says re-running is redundant; if it says syntax only, NOT checked or LSP offline, run the compiler/tests before finishing.
- Errors that were already in the file never block an edit: only new ones do.
- Long terminal output: `nreki_code action:"filter_output"`. `BREAK & BUILD` or `DECOMPOSE`: stop and rethink.

## Memory
- `nreki_guard action:"set_plan" text:"PLAN.md"`, `action:"memorize" text:"<notes>"` (survive context compaction).
- `action:"engram" path:"…" symbol:"…" text:"ASSERT: <rule>"`: a note on a symbol; `ASSERT` notes survive code changes.
