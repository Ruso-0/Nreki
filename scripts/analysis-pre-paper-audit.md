# Pre-Paper Audit — NREKI v11.0.0 (HEAD 34e7962)
**Date:** 2026-05-13 | **Model:** deepseek-v4-pro via OpenCode TUI | **Auditor:** Pipipi Code

---

## 1. CLAIMS VERIFICATION — Evidence Summary

### Claim 1: "Recall 0.420 #1 ranking among non-dense retrievers"

| Aspect | Evidence | Verdict |
|--------|----------|---------|
| Formula | `scripts/eval-phase5/metrics.ts:28-40` — binary hit/miss: returns 1.0 if any GT file in topK, else 0.0 | ✅ Correct |
| Edge case | `metrics.ts:33` — empty GT → 1.0 (vacuously satisfied) | ✅ Handled |
| Error exclusion | `orchestrate.ts:453-456` — errored tasks excluded from mean (`okCells` filter) | ⚠️ See artifact |
| NaN check | 0 NaN recalls in 100 tasks | ✅ Clean |
| Data integrity | Recall computed programmatically, not hardcoded | ✅ Verified |
| Sample bias | 5 repos (angular, coder, vscode, mui, tailwindlabs), 100 curated tasks, not full PolyBench | ⚠️ MINOR |

**Artifact:** Error exclusion inflates recall for retrievers with systematic errors. If a retriever errors on HARD tasks (lower recall would result), those tasks are excluded from the mean — the retriever looks better than it actually is. In this dataset, NREKI has 0 errors and voyage has 89 skipped+errored out of 100, so the comparison remains valid for NREKI but voyage's recall (0.130 across 100 tasks) may be understated due to many "SKIPPED" tasks not being scored.

### Claim 2: "11× token efficiency vs BM25 standalone"

| Aspect | Evidence | Verdict |
|--------|----------|---------|
| Tokenizer | `utils/tokenizer.ts:27` — tiktoken `cl100k_base` for ALL retrievers | ✅ Uniform |
| NREKI input | `nreki-runner.ts:209` — `payloadTokens(compressedTexts)` ← TFC-compressed | ⚠️ CRITICAL |
| BM25 input | `bm25-runner.ts:267` — `payloadTokens(chunkPayloads.map(p => p.text))` ← RAW text | ⚠️ CRITICAL |
| ripgrep input | `ripgrep-runner.ts:184` — `payloadTokens(chunkPayloads.map(p => p.text))` ← RAW text | ⚠️ CRITICAL |

**CRITICAL: NOT APPLES-TO-APPLES.** NREKI's `token_cost` measures the TFC-COMPRESSED output (after foveal compression, dark matter omission, upstream collapse). BM25/ripgrep/fast_grep all measure RAW chunk/file text. NREKI naturally scores lower because its output is already compressed, not because it retrieves fewer tokens of relevant content.

**Fix recommendation:** Either:
1. Measure NREKI's raw search results before compression (extract `rawCode` from search hits, not TFC output), OR
2. Apply TFC compression to BM25/ripgrep/fast_grep output before measuring token_cost

### Claim 3: "100% reliability vs Voyage 24% HTTP failures"

| Aspect | Evidence | Verdict |
|--------|----------|---------|
| NREKI error handling | `nreki-runner.ts:232-241` — catch block captures error, returns empty result with error field | ✅ Robust |
| Graceful degradation | `nreki-runner.ts:189-193` — catches per-file read errors, falls back to rawCode silently | ⚠️ MINOR |
| N21 subset errors | `c4b-subset-stats.json` — NREKI: 0/21 errors (0%), Voyage: 5/21 errors (23.8%) | ✅ Confirmed |
| Silent empty results | `nreki-runner.ts:148-157` — "no source chunks indexed" returns empty WITH error | ✅ No silent suppression |

**Verdict:** Claim holds. NREKI has 0 real errors in the C.4.B dataset (100 tasks). Voyage has 84 skipped (out-of-subset) + 5 real errors in N21 subset. Within apples-to-apples N21 range: NREKI 100% reliability, Voyage 76.2%.

### Claim 4: "Sprint 4.9.8 child_process aguanta 14GB OOM-projection"

| Aspect | Evidence | Verdict |
|--------|----------|---------|
| Implementation | `orchestrate.ts:273-331` — `runTaskInChild` uses `child_process.fork()` | ✅ Confirmed |
| Production default | `orchestrate.ts:414` — `useWorker = true` except under vitest | ✅ Active default |
| History | `orchestrate.ts:261-264` — Sprint 4.9 used worker_threads (0.9x reduction); Sprint 4.9.8 restored OS isolation | ✅ Documented |
| Test coverage | `tests/eval-phase5/orchestrate.test.ts:155-169` — tests per-runner error isolation | ✅ Tested |
| Entry point | `task-worker.ts:4-32` — child process entry, rejects if no IPC channel | ✅ Guarded |

**Verdict:** Claim holds. child_process.isolation is the production default, empirically tested.

---

## 2. ARTIFACTS DETECTED

### 2.1 Cache Warming (MAJOR) — Round 32 Finding

**Evidence:** `task-worker-body.ts:160-163`
```typescript
case "nreki-mbf-off":
    return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: false });
case "nreki-mbf-on":
    return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: true });
```

MBF-off runs FIRST, MBF-on runs SECOND. Both create fresh `NrekiEngine` instances, but:
- `compressor-foveal.ts:41-42` — `tfcParseCache` (Map, max 10 entries) persists TFC parse results
- Filesystem-level caches (`.nreki.db`) persist across engine instances
- Filesystem reads are OS-cached after first access

**Effect:** MBF-on benefits from TFC parse cache hits + OS page cache warming. P50 latency: mbf-on 2,439ms vs mbf-off 14,179ms (5.8× fake speedup).

**Severity:** MAJOR — inflates MBF latency advantage.

**Fix:** Run mbf-on BEFORE mbf-off, or purge caches between runs.

### 2.2 Within-Task Sequential Contamination (MAJOR)

All 7 runners execute SEQUENTIALLY within a single task process (or child process). Each runner creates its own engine, but filesystem state and npm dependencies accumulate.

**Evidence:** `task-worker-body.ts:132-165` — sequential switch statement. No isolation between runner invocations.

**Effect:** Later runners (NREKI, BM25 — alphabetical: aider→bm25→fast_grep→nreki-mbf-off→nreki-mbf-on→ripgrep→voyage) may see different performance due to filesystem caching.

### 2.3 Token Cost Artifact (CRITICAL — already covered in Claim 2)

### 2.4 No Warmup Pass (MINOR)

All runners measure latency on COLD first run. No warmup pass is documented.

**Evidence:** `nreki-runner.ts:111-113` — `engine.initialize()` + `engine.indexDirectory()` included in latency measurement.

### 2.5 Selection Bias (MINOR)

100 tasks from 5 repos. 3 categories. Curated, not random.

**Evidence:** `c4b-subset-stats.json` contains `subset_success_instance_ids` (16) and `subset_failure_instance_ids` (5 with Voyage errors). The subset was explicitly curated for "success" (voyage works) and "intended failures" (voyage breaks).

**Bias direction:** Unknown without inspecting full PolyBench distribution. The 5 repos (angular, coder, vscode, mui, tailwindlabs) may overrepresent large/web frameworks.

### 2.6 Error-Driven Recall Inflation (MINOR — already covered in Claim 1)

---

## 3. DEAD CODE / NO-OP DETECTION

### 3.1 MBF Cross-File Injection — Partially Active (CONFIRMED in Round 33)

**Not dead code,** but limited impact: 31/100 tasks have Δ token_cost > 0 (avg +376 tokens). 69/100 have zero cross-file injection. Functionally active in 31% of cases.

### 3.2 Potential Silent Operation

| Feature | Location | Status |
|---------|----------|--------|
| `tfcParseCache` singleton | `compressor-foveal.ts:41` | Active (LRU, max 10 entries) |
| `_encoder` singleton | `utils/tokenizer.ts:22-30` | Active (lazy-init, reused) |
| `FastGrepRAMCache` | imported in `engine.ts` | Active |
| Circuit breaker | `engine.ts` → `middleware/circuit-breaker.ts` | Active (3 tools wrapped) |

No confirmed dead code found. All traced features are reachable from active code paths.

---

## 4. TYPE LEDGER 69% DIAGNOSIS

**Question:** Why do 69/100 tasks have Δ token_cost = 0 between MBF on/off?

**Diagnosis:** Mixed — both (a) inherent sparsity AND (b) parser limitation.

| Factor | Evidence |
|--------|----------|
| JS repos (mui/material-ui = .js files) | 47/100 tasks are JS repos. Type Ledger is TS-only. 5/7 major gap tasks are mui JS files. |
| Single-file bugs | 1 task (microsoft__vscode-108964) has 1-file GT — cross-file injection irrelevant |
| Type Ledger lookup failures | `extractTypeLedgerParafovea` at `compressor-foveal-cross-file.ts:55-56`: `getChunkIdByPathAndSymbol` returns null → fovea skipped. This is the "Furia #7 fail-open" guard. |

**Conclusion:** ~70% of Δ=0 cases are JS repos (no Type Ledger). ~30% are TS repos with single-file ground truth or complex symbol names that Type Ledger can't resolve. NOT a parser bug — it's a scope limitation (JS unsupported, Type Ledger depth limited to K=1).

---

## 5. TEST COVERAGE GAPS

### 5.1 What exists (unit-level)
- `tests/eval-phase5/metrics.test.ts` — 130 lines. Tests `computeFirstHitRecall` with simple cases. Does NOT test against real retrieval results.
- `tests/eval-phase5/orchestrate.test.ts` — 414 lines. Tests orchestration flow with mocked runners.
- `tests/eval-phase5/ground-truth.test.ts` — tests ground truth computation.
- `tests/eval-phase5/runners/*.test.ts` — per-runner integration tests.

### 5.2 What's MISSING (integration-level)
- **No test that validates recall metrics against known ground truth with real retrievers**
- **No test that catches cache-warming contamination** (like the Round 32 artifact)
- **No test that verifies token_cost apples-to-apples across retrievers**
- **No test that asserts latency P50/P95 bounds** (would have caught the 5.8× fake speedup)

### 5.3 Gap Severity
**MAJOR** — The absence of metric-level integration tests means artifacts like cache-warming, order-of-execution contamination, and apples-to-oranges token comparisons can survive into production data.

---

## 6. CHANGELOG DRIFT

**Finding:** NO DRIFT DETECTED.

The CHANGELOG documents v10.x (MCP server layer). Sprint 4.x features are documented inline in `orchestrate.ts` comments, not in CHANGELOG. This is a documentation split, not code drift:

| Sprint | Documented in | Code active? |
|--------|--------------|--------------|
| 4.7 Hygenic cleanup tree-sitter | Not found in codebase | UNVERIFIED |
| 4.8 Cached prepared statements | Not found in eval codebase | UNVERIFIED |
| 4.9.8 child_process.isolation | `orchestrate.ts:255-271` | ✅ Active (default) |

Sprint 4.7 and 4.8 references not found in current `scripts/eval-phase5/` — may refer to older eval infrastructure or be documented only in issue tracker.

---

## 7. RECOMMENDATIONS

### Claims that SOSTIENEN (ready for paper):
1. **Recall 0.420 #1 ranking** — formula correct, data clean. Add caveat: "over 100 curated tasks from 5 repos."
2. **100% reliability** — confirmed within N21 subset (NREKI 0 errors vs Voyage 24%). Add caveat: NREKI has fewer failure modes than cloud API retrieval.
3. **Sprint 4.9.8 child_process** — confirmed active as production default.

### Claims that need REFRAMING:
1. **"11× token efficiency vs BM25"** — MUST reframe. The metric measures compressed NREKI output vs raw BM25 output. Fair comparison requires either: (a) decompress NREKI or (b) compress BM25. Current claim is misleading.
2. **MBF speedup** — The 5.8× latency advantage is a benchmark artifact (cache warming). Remove latency comparison for MBF on/off; report only recall/token_cost delta (which is small but real: +3.4% tokens, ~31% of tasks affected).

### Claims that require RETRACT:
- None — no claims found to be empirically false. All artifacts are measurement/precision issues, not fabrication.

### Top-line artifact ranking:

| # | Severity | Artifact | Impact |
|---|----------|----------|--------|
| 1 | CRITICAL | Token cost not apples-to-apples (NREKI compressed vs others raw) | Inflates NREKI token efficiency claim by unknown factor |
| 2 | MAJOR | Cache warming between mbf-off→mbf-on within-task | Inflates MBF latency advantage 5.8× |
| 3 | MAJOR | No metric-level integration tests | Artifacts survive into production data undetected |
| 4 | MINOR | Sequential runner execution shares filesystem state | Later runners may benefit from OS page cache |
| 5 | MINOR | 5-repo curated subset, not full PolyBench | Limited generalizability |
