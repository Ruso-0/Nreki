# NREKI ACTIVE (IMMUNE SYSTEM)
Native Read/Write blocked for >100L files. Fallback only for new files or <100L.

## 0. ZERO-CHATTER
Call tools immediately. No preambles. One-line responses.

## 1. NAVIGATION & READING
- NEVER use Bash grep/rg or native Read. Use `nreki_navigate action:"fast_grep"` for exact search, `action:"search"` for semantic (Type Ledger).
- Diverse codebase + accuracy critical: `action:"hybrid_search"` (NREKI + BM25 fusion). Costs +207% tokens; skip on single-project corpora.
- Batch reads: `nreki_code action:"compress" focus:"sym1, sym2"`.
- Large files: `nreki_navigate action:"outline"` first. If `[BUDGET LIMIT REACHED]`, use `compress focus`. Heed ⚠️ and 👻 markers.
- Small files: `nreki_code action:"read"`.

## 2. SURGICAL EDITING
- NEVER native Write/Replace. NEVER edit sequentially. Batch ALL edits in ONE `batch_edit`.
- **80L payload limit:** Decompose `new_code`/`replace_text` >80 lines. **Patch mode:** Use `search_text`/`replace_text` for symbols >100L (default, empirically calibrated; override via `NREKI_SYMBOL_LIMIT`).
- ACID rule: every `search_text` targets ORIGINAL source, not prior patches.
- Anti-sweep: no `// eslint-disable`, `@ts-ignore`, `# noqa`. Rename via `prepare_refactor` first.

## 3. BLAST RADIUS & TYPES
- Cascade all dependents in same `batch_edit`. NEVER downgrade to `any`/`unknown`.
- Heal `[UNPAID TYPE DEBT]` by restoring strict types. NREKI auto-injects missing imports.

## 4. MEMORY
- Plan: `nreki_guard action:"set_plan" text:"PLAN.md"`.
- Scratchpad: `nreki_guard action:"memorize" text:"<notes>"`.
- Engrams: `nreki_guard action:"engram" path:"..." symbol:"..." text:"ASSERT: <rule>"`.

## 5. VERIFICATION
- NEVER run tsc/eslint. NREKI validates edits in RAM. `[OK]` = guaranteed valid.
- Errors: fix with NREKI tools, not bash. Filter output: `nreki_code action:"filter_output"`.
- **Pre-existing TS errors** in the file you edit are NOT blockers — NREKI's differential check (`count > baseline` per error fingerprint) only rejects edits that *introduce* a new error. You are not obligated to fix pre-existing problems that are unrelated to your change.
- `BREAK & BUILD` or `DECOMPOSE`: STOP and rethink.

## 6. INPUT VALIDATION
- `read` / `compress` are FILE operations. Passing a directory returns a clear error pointing to `nreki_navigate action:"outline" / "fast_grep" / "search"`. Use the right tool for the input shape.
