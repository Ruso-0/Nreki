---
name: nreki-optimizer
description: Read only the symbols a task needs and validate multi-file signature changes or renames in RAM before writing.
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
- Single-file changes: use native `Edit`.
- Signature changes touching callers across multiple files, or renames (`nreki_navigate action:"prepare_refactor"` first): use `nreki_code action:"batch_edit"` with every affected caller in the same batch (all-or-nothing; a rejected batch writes nothing: fix it and resend).
- In `batch_edit`, use `mode:"patch"` (search_text -> replace_text inside the symbol; indentation is matched loosely). Symbols over 100 lines require it (`NREKI_SYMBOL_LIMIT`). `mode:"replace"` with `new_code:""` deletes a symbol. Payloads over 80 lines are rejected: split them. Several patches to one symbol go in one batch, each matching the ORIGINAL source.
- Do not weaken types to `any`/`unknown`. `batch_edit` rejects `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, `# type: ignore`, `# pyright: ignore`, `# noqa` or a blanket `eslint-disable`. NREKI may add a missing import itself; keep it.

## Verify
- The `[Validated: …]` footer says what was checked. Skip tsc only when it says re-running is redundant; if it says syntax only, NOT checked or LSP offline, run the compiler/tests before finishing.
- Errors that were already in the file never block an edit: only new ones do.
- Long terminal output: `nreki_code action:"filter_output"`. `BREAK & BUILD` or `DECOMPOSE`: stop and rethink.

## Memory
- `nreki_guard action:"set_plan" text:"PLAN.md"`, `action:"memorize" text:"<notes>"` (survive context compaction).
- `action:"engram" path:"…" symbol:"…" text:"ASSERT: <rule>"`: a note on a symbol; `ASSERT` notes survive code changes.
