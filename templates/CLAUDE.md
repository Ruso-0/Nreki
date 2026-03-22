# NREKI Active

This workspace has the NREKI MCP plugin installed. It extends your capabilities with AST-aware tools that protect your context window and prevent syntax errors before they reach disk.

## Optimal Workflow

1. **Run tests & commands freely.** Use Bash for npm test, builds, git - NREKI doesn't interfere with your terminal.
2. **Navigate with AST precision.** Prefer `nreki_navigate` over grep/glob. It returns exact structural matches (functions, classes, references) without flooding your context with noise.
3. **Read files efficiently.** ALWAYS prefer `nreki_code action:"read"` over native Read. Native Read dumps the entire file into your context - a 2,000-line file burns ~5,000 tokens in one call. `nreki_code read` auto-compresses to ~1,200 tokens while keeping all structural context. This is the single biggest token saver available to you.
4. **Debugging? Read uncompressed.** If you need to understand a function's internal logic (not just its signature), use `nreki_code action:"read" compress:false`. Compression hides function bodies to save tokens - great for navigation, but not for debugging.
5. **Edit surgically.** Prefer `nreki_code action:"edit"` for modifying existing functions/classes. It validates the AST before writing to disk - if your code has a syntax error, the file stays untouched and you get the exact line/column to fix.
6. **Multi-file refactors? Use batch_edit.** `nreki_code action:"batch_edit" edits:[...]` edits multiple files atomically. If ANY file has a syntax error, NOTHING is written to disk. All-or-nothing safety.
7. **Renaming a symbol? Use prepare_refactor first.** `nreki_navigate action:"prepare_refactor" symbol:"OldName"` analyzes every occurrence and classifies it as "high confidence" (safe to rename) or "review" (might be a string, comment, or object key). Then use batch_edit to apply the renames.
8. **Watch for blast radius warnings.** When you change a function's signature, NREKI automatically warns you which files import it. Fix those files before running tests.
9. **The repo map shows architecture tiers.** `nreki_navigate action:"map"` now classifies files as CORE (high import count - modify with caution), BUSINESS LOGIC (medium), or LEAF (safe to experiment).
10. **Create new files normally.** Use native Write for brand new files that don't exist yet.
11. **Pin rules that matter.** Use `nreki_guard action:"pin"` to persist instructions across messages (e.g., "always use fetch, not axios").
12. **Anchor your plan.** If you're working on a complex task with strict schemas or architectural constraints, use `nreki_guard action:"set_plan" text:"PLAN.md"` at the start. NREKI will silently re-inject your plan every ~15 tool calls to survive context compaction. Use `nreki_guard action:"memorize" text:"your progress notes"` to leave notes for yourself.
13. **If the circuit breaker triggers, follow its instructions.** It detected a doom loop and is protecting your session from burning tokens on repeated failures.

NREKI handles the context heavy-lifting so you can focus on writing correct code on the first try.
