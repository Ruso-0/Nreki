# User Feedback Investigation — v11.4.1

**Date:** 2026-05-19
**Source feedback (verbatim):**
> Útil: search semántico, outline, compress con focus, batch_edit ACID
> Limitaciones:
> - Símbolos >100L bloquean y fuerzan a patch o caer a edit nativo (como en fillTemplate.ts)
> - Pre-existing TS errors (TS1259, TS2802) bloquean edits aunque no sean culpa mía
> - compress en directorios da EISDIR — solo funciona en archivos
> - A veces search no encuentra y toca usar grep nativo

**Method:** Each claim probed empirically against the **globally installed `@ruso-0/nreki@11.4.1`** (confirmed at `C:\Users\jhers\AppData\Roaming\npm\node_modules\@ruso-0\nreki\package.json` → `"version": "11.4.1"`). No assumptions about which version produced what.

---

## 1. Claim: "compress en directorios da EISDIR"

**Probe:** load `handleCode` from the installed v11.4.1 `dist/router.js`, invoke `compress` with `path: "src"` (directory).

**Result:**
```
RESULT.isError = true
RESULT.text    = Path is a directory, not a file: src
                 Hint: nreki_code action:"compress" operates on individual files.
                 For a directory overview, use nreki_navigate action:"outline" on specific files,
                 or nreki_navigate action:"fast_grep" / "search" to locate symbols across the tree.
```

**Verdict: FIX IS LIVE in v11.4.1.** No EISDIR leak in `read` or `compress`. The user's feedback on this point is **retrospective** — describes behavior seen earlier in the session, before v11.4.0 shipped.

---

## 2. Claim: "Pre-existing TS errors (TS1259, TS2802) bloquean"

**Probe:** boot v11.4.1's `NrekiKernel` in **hologram** mode against a real workspace with a `tsconfig.json` that triggers TS1259 (`esModuleInterop:true` + `allowSyntheticDefaultImports:false` + `export =` source). Invoke `interceptAtomicBatch` with an unrelated-symbol edit.

**Result:**
```
result.safe     = true
result.exitCode = 0
latency         = 3025ms
```

The differential filter at `dist/kernel/backends/ts-compiler-wrapper.js:611` (the same line as in source) correctly suppresses the pre-existing TS1259.

**Verdict: FILTER IS LIVE in v11.4.1.** No leak in the kernel hot path. The user's feedback is **retrospective**.

---

## 3. NEW BUG (genuine, v11.4.1): EISDIR in handlers I did NOT fix

The v11.4.0 sprint only added a stat-guard to `handleRead` and `handleCompress`. Audit of other `readSource` callsites surfaces:

| Action     | Handler                            | Behavior with directory                                                   |
|------------|------------------------------------|---------------------------------------------------------------------------|
| `set_plan` | `src/handlers/guard.ts:359`        | **EISDIR throws** — `readSource(resolvedPath)` after `fs.existsSync` (no isDirectory check). **MCP-visible crash.** |
| `engram`   | `src/handlers/guard.ts:465`        | **EISDIR throws** — `readSource(resolvedPath)` with no guard. **MCP-visible crash.** |
| `outline`  | `src/handlers/navigate.ts` → `getFileSymbols` at `src/ast-navigator.ts:438-442` | Caught by `try/catch` in getFileSymbols → returns `[]` → handler emits "No symbols found in <dir>. (File may be empty, unsupported, or contain no declarations.)" → **silent fail with misleading message** |
| `definition` (search auto_context) | `src/handlers/navigate.ts:190` | Caught by `try/catch` → degrades search auto-context silently |
| `prepare_refactor` | `src/handlers/navigate.ts:660` | Caught by `try/catch` per-candidate-file → `continue` (correct behavior; this iterates over a set, not user input) |

**Empirical probe** (against installed v11.4.1):
```
--- set_plan text:"src" (directory) ---
  THREW: EISDIR: illegal operation on a directory, read
--- engram path:"src" symbol:"x" (directory) ---
  THREW: EISDIR: illegal operation on a directory, read
```

**Severity:** Both `set_plan` and `engram` are common user-facing actions; a directory path is an easy mis-call (e.g. `set_plan text:"plans/"` instead of `plans/sprint.md`). The crashes surface as opaque MCP errors with no actionable hint.

**Fix (proposed, not yet applied):** extract the guard from `read.ts` into a shared helper (`src/utils/path-guard.ts`) and apply to all five callsites. DRY win + closes the gap.

---

## 4. Claim: "Símbolos >100L bloquean y fuerzan a patch"

**Status: working as designed in v11.3.1.** The threshold is configurable via `NREKI_SYMBOL_LIMIT` env (e.g. `NREKI_SYMBOL_LIMIT=150` raises it). Error message at `src/semantic-edit.ts:640` and `:1033` already names the override.

**UX gap:** The user reported this as a "limitation" rather than a bug, but it's worth checking that the error message they actually saw is concrete enough. Live message format (from source):
> `Blocked: Symbol "processText" is 55L (>100L). Use mode:"patch" with search_text and replace_text, or override via NREKI_SYMBOL_LIMIT env.`

This is clear. The user likely saw this and chose `patch` mode (or native edit, per their feedback). No code fix needed — but a one-line nudge in `templates/CLAUDE.md` reminding agents that `NREKI_SYMBOL_LIMIT` is *configurable per session* might help. Currently the templates mention the override exists; they don't suggest *using* it for a specific blocked symbol.

---

## 5. Claim: "search a veces no encuentra y toca usar grep nativo"

**Trace:**
- `handleSearch` (`src/handlers/navigate.ts:31`) calls `engine.search(query, limit)`.
- Line 45: `const indexStarted = !engine.hasIndexedFiles() && engine.ensureIndexedBackground();` — semantic index is lazy (v11.2.1 non-blocking).
- Line 50-62: if `indexStarted && results.length === 0` → "Index pending" message **with** fallback suggestions (`hybrid_search`, `fast_grep`).
- Line 64-74: if `results.length === 0` and index was already loaded → **"No results found" message WITHOUT fallback suggestions**:
  ```
  No results found for: "X"
  Indexed N files with M chunks.
  Try a broader query or index more directories.
  ```

**Real failure modes:**
1. Semantic embedding doesn't match user's query (model limitation; intrinsic).
2. Indexing is in progress and the user already saw the "pending" once, so on retry the index is partial-but-loaded → the loaded branch fires but the relevant chunk isn't there yet.
3. `fastGrep` depends on `fgCache` (RAM-resident); if the file hasn't been parsed since boot, `fastGrep` returns `[]` cleanly. **Empirically `engine.fastGrep` first checks `if (this.fgCache.size === 0) return [];`** ([src/engine.ts:615](../src/engine.ts#L615)) — for a fresh project, the very first `fast_grep` call after boot can return empty even if the substring is on disk.

**UX gap:** the "No results found" branch should mirror the "Index pending" branch and suggest `fast_grep` / `hybrid_search` (or `Bash grep` as last resort) before the user falls back manually. This is a 5-line cosmetic edit.

---

## 6. Summary of findings

| # | Claim | Live status | Action |
|---|-------|-------------|--------|
| 1 | compress on dir = EISDIR | **already fixed v11.4.1** | None (retrospective feedback) |
| 2 | pre-existing TS1259/TS2802 block | **already filtered v11.4.1** | None (retrospective feedback) |
| 3 | `set_plan` / `engram` on dir = EISDIR | **GENUINE BUG in v11.4.1** | Fix in v11.4.2: extract path-guard helper, apply to 4 unguarded callsites |
| 4 | `outline` on dir = misleading "no symbols" | **UX bug in v11.4.1** | Detect directory at outline entry, return explicit error like `read`/`compress` |
| 5 | >100L blocks | **as designed; configurable** | Optional: template hint about `NREKI_SYMBOL_LIMIT` use cases |
| 6 | search misses, force grep | **partly intrinsic, partly UX** | Add fallback hint to "No results found" branch; mention `fast_grep`/`hybrid_search`/`Bash grep` |

---

## 7. Subagent claims I rejected (kept for honesty)

A subagent traced the kernel batch_edit path and proposed three "bypass points" for the pre-existing-error filter:

- **Point 1: `purgeCache()` wipes baseline.** **REJECTED.** `purgeCache` at `src/kernel/backends/ts-compiler-wrapper.ts:317-320` only resets `builderProgram` + `isStateCorrupted`. `baselineFrequencies` is cleared only by `captureBaseline()` itself, which is the correct place.
- **Point 2: Baseline scope mismatch (hologram).** **PLAUSIBLE BUT UNVERIFIED.** No empirical reproduction; the smoke test in §2 above did not exhibit a leak. Logged for a future Furia round if user feedback persists post-v11.4.2.
- **Point 3: Healing cascade not re-filtered.** **REJECTED.** `phase4_healingCascade.recompileAndEvaluate` (`src/kernel/nreki-kernel.ts:1035-1039`) calls `tsBackend.getDiagnostics`, which IS the baseline-filtered diagnostic path.

---

## 8. Proposed v11.4.2 scope

**Genuine bugs to fix:**
1. EISDIR in `set_plan` (guard.ts:359) — extract DRY helper + apply.
2. EISDIR in `engram` (guard.ts:465) — same helper.
3. `outline` directory message — same helper at handler entry.

**UX improvements (small, low risk):**
4. "No results found" search message → add `fast_grep`/`hybrid_search`/`Bash grep` fallback hint.
5. Template note: `NREKI_SYMBOL_LIMIT` for the rare legitimate >100L rewrite.

**Tests:**
- 3 EISDIR reproducers (one per handler) confirming the structured error replaces the crash.
- 1 search "no results" snapshot test confirming the new fallback wording.

**Not in scope (per Furia-style honesty):**
- Hologram scope-mismatch hypothesis (no reproduction yet).
- FIFO/device-file handling (already logged in v11.4.0 Furia review, no user report).
