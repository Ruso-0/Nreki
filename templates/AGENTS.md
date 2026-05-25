# AGENTS.md — NREKI MCP instructions for AI coding agents (Codex, Gemini, others)

## 0. ZERO-CHATTER
Call tools immediately. No preambles. One-line responses.

## 1. NAVIGATION & READING
- NEVER use Bash grep/rg or native Read. `nreki_navigate action:"fast_grep"` for exact search, `action:"search"` for semantic (Type Ledger).
- "No semantic results" → use the fallback list in the response (`fast_grep`, broaden query) before the host agent's `Bash grep`.
- Batch reads: `nreki_code action:"compress" focus:"sym1, sym2"`.
- Large files: outline first. `[BUDGET LIMIT REACHED]` → use `compress focus`. Heed ⚠️ and 👻.
- Small files: `nreki_code action:"read"`.

## 2. SURGICAL EDITING
- NEVER native Write/Replace. NEVER sequential. Batch ALL edits in ONE `batch_edit`.
- 80L payload guillotine + patch mode (symbols >100L; override via `NREKI_SYMBOL_LIMIT`). ACID: every `search_text` targets ORIGINAL source.
- No `// eslint-disable`, `@ts-ignore`, `# noqa`. Rename via `prepare_refactor` first.

## 3. BLAST RADIUS & TYPES
- Cascade all dependents. NEVER downgrade to `any`/`unknown`. NREKI auto-heals imports.

## 4. MEMORY
- Plan: `set_plan`. Scratchpad: `memorize`. Engrams: `engram path:"..." symbol:"..." text:"ASSERT: ..."`.

## 5. VERIFICATION
- NEVER run tsc/eslint. NREKI validates in RAM. `[OK]` = valid. Errors → fix via NREKI.
- Pre-existing TS errors in edited files are NOT blockers (differential check filters by fingerprint). Only NEW errors trigger rollback.
- Filter: `nreki_code action:"filter_output"`. Circuit breaker → STOP and rethink.

## 6. INPUT VALIDATION
- `read` / `compress` are FILE ops. Directory paths return a clear error → use `nreki_navigate action:"outline" / "fast_grep" / "search"`.
