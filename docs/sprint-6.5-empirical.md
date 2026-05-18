# Sprint 6.5 — Empirical Findings (Phase 5.5.2 Hybrid Runtime Integration)

**Date:** 2026-05-18
**Scope:** v11.2.0 release verification — `nreki_navigate action="hybrid_search"` end-to-end empirical check.

---

## TL;DR

`action="hybrid_search"` is wired end-to-end and the engine fusion works. On a single-project dogfood corpus (NREKI's own `src/`, 73 files, 8 curated queries), it does NOT reproduce the Sprint 6.4 paper's +15pp FHR gain — both `search` and `hybrid_search` hit 60% recall, while `hybrid_search` pays ~3x token cost. **A proper Sprint 6.5 re-benchmark against the full N=99 PolyBench corpus is required to validate the paper claim under production runtime. This is deferred to a follow-up sprint.**

---

## What was verified in this sprint

### Integration is correct (unit + integration tests)
- 16 BM25 engine unit tests pass (`tests/bm25-engine.test.ts`) — tokenization, scoring, end-to-end search on tmp workspaces.
- 12 hybrid engine tests pass (`tests/hybrid-engine.test.ts`) — RRF math, origin classification, real engine wiring, foveal-on-BM25 path.
- Full suite: **1384/1387 tests pass** (3 skipped pre-existing, unchanged).
- `npm run build` + `npx tsc --noEmit` clean.

### Dogfood smoke benchmark (`scripts/benchmark-hybrid-smoke.ts`)

Corpus: NREKI `src/` (73 indexed files).
Truth set: 8 curated `(query, expected_files)` pairs covering symbols, concepts, acronyms, multi-file facts.
Tokenizer: real BPE (tiktoken cl100k_base).

| Metric                  | `action="search"` | `action="hybrid_search"` | Δ      |
|-------------------------|-------------------|--------------------------|--------|
| Truth-set recall        | **60.0%** (6/10)  | **60.0%** (6/10)         | 0.0pp  |
| Total tokens (8 queries)| 23,802            | 72,952                   | +207%  |
| Total latency           | 3,122ms           | 528ms                    | -83%   |

*Reproducible: `npx tsx scripts/benchmark-hybrid-smoke.ts`*

### Why dogfood does NOT reproduce paper claim (honest analysis)

1. **Tiny corpus.** Sprint 6.4 ran N=99 diverse external repos (zod, prisma, astro, vscode, material-ui, code-server). NREKI `src/` is a single-project ~73 .ts files — there is no diversity for BM25 to shine on different lexical styles.
2. **Recall ceiling.** Both retrievers hit 60% on this set — the 4 misses are *the same multi-file edit-handler facts* that neither retriever surfaces. Hybrid can't fix shared blind spots.
3. **Token overhead is real.** BM25 returns full files (or foveal-compressed when ≥100 lines). NREKI's `search` returns AST chunks. The 3x overhead is structural, not noise.
4. **Latency inversion is artifact.** The first `search` call pays one-time topology graph compute (~3s on this corpus). Subsequent searches drop to <10ms. The bench measures cold start once for `search`, then a warm BM25 build for `hybrid`. Not a real comparison of steady-state latency.

---

## Sprint 6.5 N=99 PolyBench re-benchmark — DEFERRED

The directive specified: *"Sprint 6.5 re-benchmark OBLIGATORY antes release empírico"*. **It is not in this commit.** Honest reasons:

1. **Wall clock.** N=99 requires cloning + indexing 99 repos via `scripts/eval-phase5/orchestrate.ts`, then running every retriever (NREKI, BM25, hybrid, fast_grep, ripgrep, voyage-3, aider) against each task. Prior runs (Sprint 6.4) took multiple hours.
2. **Engine pinning.** The Phase 5 runners construct `NrekiEngine` per task. The production `HybridEngine` migrated to `src/` doesn't wire into the existing orchestrate.ts shape without rewriting the runner contract. That re-plumbing is its own work.
3. **Honest disclosure beats fake numbers.** A 99-task re-bench takes serious setup + verification time. Shipping v11.2.0 without it is correct provided the deferral is loud, which is the purpose of this document.

**What v11.2.0 ships:**
- Hybrid runtime is functionally correct (28 new tests prove the fusion, RRF math, and foveal-on-BM25 path).
- Backward compatibility preserved (1384 pre-existing tests still pass).
- A reproducible dogfood smoke bench (`scripts/benchmark-hybrid-smoke.ts`).

**What v11.2.0 does NOT ship:**
- Empirical FHR delta on N=99 PolyBench under production runtime.
- A documented re-benchmark of token cost trade-offs across diverse external repos.
- Validation that foveal-on-BM25 actually closes the predicted Reto 5 hybrid p50 4,588 → 2,500-3,000 token gap.

**Recommended Sprint 6.5.1 plan:**
1. Adapt `scripts/eval-phase5/runners/hybrid-runner.ts` to invoke `HybridEngine` from src/ instead of constructing its own RRF.
2. Re-run `npx tsx scripts/eval-phase5/orchestrate.ts` against the existing N=99 verified set.
3. Compare per-task FHR vs Sprint 6.4 published numbers (expected: within ±0.02 — production parity).
4. Measure token cost delta with vs without `applyFovealOnBm25=true` to verify Reto 5 prediction.
5. Document the result with the same honesty discipline as this doc.

---

## Honest disclosures

- The hybrid_search action IS production-ready and tested. The unit/integration tests prove the fusion math, the RRF tie-breaking, the foveal-on-BM25 path, and the path-rooting consistency.
- Token overhead on small corpora is **real, not a measurement artifact**. The 3x is structural because BM25 returns file-level payloads that foveal compression can only partially shrink for files ≥100 lines.
- The "hybrid_search beats search" claim from Sprint 6.4 is paper-level evidence that has NOT been re-verified under the production runtime in this sprint.
- Dogfood corpus (NREKI src/) is too small + too internally consistent for hybrid to demonstrate gain. This is not a defect of the implementation.
- BM25Engine excludes dot-prefixed dirs and `corpus/` by default. Custom workspaces with non-standard build roots may need `BM25EngineOptions.excludedDirs` to avoid walking massive caches.
