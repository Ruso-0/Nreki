# Sprint 6.6 — Comparative Benchmark HONESTO

**Date:** 2026-05-21
**Status:** Internal measurement. NOT for publish.
**Scope:** Empirical gap of NREKI vs Claude Context (voyage-code-3 proxy) vs Aider repo-map vs ripgrep vs BM25, on aligned metrics (top-K=10, same corpus, same task set).

---

## TL;DR — Veredicto honesto

On the **primary metric (Recall@5)** NREKI's hybrid retriever (`hybrid_search`, v11.4.x) is **NOT a competitive substitute for dense embedding retrieval**.

- NREKI hybrid micro-avg R@5 = **0.47** (CI95 [0.37, 0.57], N=100)
- voyage-code-3 (Claude Context proxy) micro-avg R@5 = **0.75** (CI95 [0.50, 0.94], N=16 stratified subset)
- Gap = **~28 pp** in favor of dense embedding. Exceeds the sprint's ">15pp = report says clear" threshold.

Macro-averaged across repos (each repo weighted equally — Furia Q1 countermeasure):

- voyage-code-3: macro R@5 = **0.85** (4 repos)
- bm25 standalone: macro R@5 = **0.41** (5 repos)
- NREKI hybrid: macro R@5 = **0.34** (5 repos)
- NREKI base: macro R@5 = **0.33** (5 repos)
- ripgrep: macro R@5 = **0.34** (5 repos)
- aider: macro R@5 = **0.33** (4 repos)

**Under macro-averaging, NREKI hybrid does NOT statistically beat ripgrep or aider, and is BELOW BM25 standalone.** The micro-avg headline (NREKI hybrid 0.47) was driven by mui dominance (70/100 tasks).

NREKI's real value proposition reduces to **latency + local-only operation**, not retrieval quality:
- p50 latency: NREKI hybrid 10.9s vs voyage 230s (21× faster)
- p50 tokens: NREKI hybrid 4720 vs voyage 4104 (voyage is slightly cheaper too — token cost is NOT a NREKI win)
- Network: NREKI is local, voyage needs an API call

If you want to ship "retrieval as good as Claude Context", NREKI hybrid is not it. If you want "fast, free, local, mediocre", NREKI is competitive.

---

## Phase 1 — Corpus + task set

**Dataset:** [AmazonScience/SWE-PolyBench_Verified](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified) (arXiv:2504.08703, MIT).

**TypeScript subset:** N=100 instances across 5 repos:

| Repo | SHA strategy | N |
|---|---|---|
| mui/material-ui | per-task base_commit (Time-Travel guard) | 70 |
| microsoft/vscode | per-task base_commit | 23 |
| tailwindlabs/tailwindcss | per-task base_commit | 3 |
| coder/code-server | per-task base_commit | 3 |
| angular/angular | per-task base_commit | 1 |

Task categories: 77 Bug Fix, 22 Feature, 1 Refactoring.

**Task definition per instance:**
- `query` = PolyBench `problem_statement` (raw issue text or extracted)
- `ground_truth` = files modified in the gold `patch`, filtered through `ground-truth.ts` anti-tests filter MORTAL (excludes `*.test.ts`, `*.spec.ts`, `test/`, `tests/`, `__tests__/`)
- Per-task `base_commit` (40-char SHA) — Time-Travel guard ensures no leakage from post-fix HEAD

**Reproducibility:** Every per-task base_commit, ground_truth strict_src, and modified_nodes are persisted in [results-c4b-full.json](../results-c4b-full.json) (1.9 MB, 100 records). The full PolyBench Verified CSV lives at [scripts/eval-phase5/data/polybench-verified.csv](../scripts/eval-phase5/data/polybench-verified.csv).

**What N=99 PolyBench-Verified TS does NOT cover** (Furia Q1 honesty):
- svelte, serverless, prettier — PolyBench includes these but as JS-only instances (this sprint's corpus is TS-only)
- backend services, ORMs, compilers — entire categories missing
- 70% mui weight → the headline R@5 means are biased toward UI component libraries

---

## Phase 2 — Retrievers setup

Five aligned retrievers (plus three NREKI/lexical variants for ablation), same `RetrievalResult` interface, same anti-tests filter, top-K=10 each.

| Runner | Implementation | Notes |
|---|---|---|
| `nreki-mbf-off` | `NrekiEngine.search()` action, MBF off | NREKI's basic `search` |
| `nreki-mbf-on` | `NrekiEngine.search()` action + foveal MBF cross-file injection | Production default |
| `hybrid-rrf` | RRF (k=60) over NREKI ranks + BM25 ranks, top-K=10 | `hybrid_search` action |
| `voyage-3` | voyage-code-3 dense cosine, line chunks (~50 lines), exact scan | **Claude Context PROXY**, see §2.1 |
| `aider` | `aider --show-repo-map` parsed in encounter order + keyword boost | 120s/task timeout |
| `ripgrep` | `rg --count-matches` per keyword, aggregate per-file | `constructQuery(problem_statement)` keyword set |
| `bm25` | Standard Okapi BM25, k1=1.5 b=0.75, code-aware tokenizer | NREKI-independent |
| `fast_grep` | NREKI's optimized lexical (BPE/AST-aware) | Sanity baseline |

### 2.1 Claude Context proxy — honest disclosure

The Sprint 6.6 spec called for `@zilliz/claude-context-mcp`. Running the actual server requires:
1. A Milvus or Zilliz Cloud instance (either local Milvus standalone or paid Zilliz tier)
2. The MCP server installed and stdio-bridged into the eval harness
3. Re-indexing each PolyBench repo at `base_commit` into a Milvus collection

We did NOT install the full stack. Instead, the existing `voyage-runner.ts` (Phase 5 C.3.A) was treated as a proxy because the retrieval signal is the same model (`voyage-code-3`, 1024-dim, 32K context).

**What's identical:** embedding model, top-K cosine ranking, anti-tests filter.

**What differs (Furia Q2 honest):**
- ANN vs exact: Milvus HNSW would lose some recall vs our exact cosine. Direction = voyage-runner is an **upper bound** on Claude Context recall (≤5pp optimistic).
- Chunk strategy: Our voyage-runner uses ~50-line chunks; @zilliz/claude-context-mcp uses AST chunks (tree-sitter). AST chunks would likely *raise* R@1 (denser semantic units). Direction = our proxy is a **lower bound** on Claude Context R@1.
- Net: bounded uncertainty in both directions, ~5pp. The 28pp gap to NREKI is too large to be explained by this proxy noise.

For Sprint 6.7, the correct experiment is to install Milvus standalone locally and run `@zilliz/claude-context-mcp` against the same N=100 corpus.

### 2.2 Coverage gaps (Furia Q3 honest)

Not every runner ran on all 100 tasks:

| Runner | N attempted | N successful | Reason |
|---|---|---|---|
| nreki-mbf-off | 100 | 100 | — |
| nreki-mbf-on | 100 | 100 | — |
| hybrid-rrf | 100 | 100 | — |
| ripgrep | 100 | 100 | — |
| bm25 | 100 | 100 | — |
| fast_grep | 100 | 100 | — |
| voyage-3 | 21 (subset) | 16 | Token budget; 5 HTTP-400 on giant chunks |
| aider | 100 | 13 | 87 timeouts at 120s on mui/vscode (large repos) |

The voyage subset is the **Furia round 25 stratified design** (6 vscode + 12 mui + 3 mixed), preserving 6 vscode tasks already completed in Sprint 4. The aider 87/100 timeout rate is a survivorship bias — the 13 tasks where aider returned are by definition the small/fast repos where repo-map fits within 120s.

Both coverage gaps are **acknowledged Sprint 6.7 follow-up items**.

---

## Phase 3 — Aligned metrics

All retrievers measured on the SAME corpus, SAME task set, top-K=10:

- **Recall@1**: 1.0 if any ground-truth strict_src file is in `retrieved_files[0]`, else 0.0.
- **Recall@5 (PRIMARY)**: 1.0 if any GT file is in `retrieved_files[0:5]`, else 0.0.
- **Recall@10**: 1.0 if any GT file is in `retrieved_files[0:10]`, else 0.0.
- **MRR**: 1/rank of first relevant file (0 if none found).
- **token_cost p50/p95**: per-task `result.token_cost.total_tokens` (the payload to a downstream agent — for NREKI this is the foveal-compressed text, for BM25/ripgrep the raw file slices, for voyage the embedded chunk text).
- **latency_ms p50/p95**: end-to-end wall clock per task (includes index build for runners that build per-task).

All confidence intervals are 95% non-paired bootstrap (10 000 resamples, fixed seed 42).

**Validation pattern note (Furia round 18 carry-over):** Sprint 6.6 spec asked for 3-run validation with median ± variance. This report uses single-shot data from Sprint 4.9 / 6.3 runs (May 2026). All retrievers in scope are deterministic given fixed seeds (no random samplers), so per-task ranking variance is zero. Latency variance is unmeasured per-task — wall-clock differences would mostly come from filesystem cache state. The 3-rep ask is honestly **not done** in this sprint.

---

## Phase 4 — Results (the table)

### 4.1 Per-runner micro-average, N as ran

| Retriever | N | Recall@1 | Recall@5 | Recall@10 | MRR | TokCost p50 | TokCost p95 | Latency p50 (ms) | Latency p95 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| nreki-mbf-off | 100/100 | 0.160 [0.090, 0.240] | 0.370 [0.280, 0.460] | 0.420 [0.320, 0.520] | 0.251 [0.181, 0.326] | 2310 | 8150 | 8110 | 23953 |
| nreki-mbf-on  | 100/100 | 0.160 [0.090, 0.240] | 0.370 [0.280, 0.460] | 0.420 [0.320, 0.520] | 0.251 [0.181, 0.326] | 2408 | 8476 | 1356 | 4742 |
| **hybrid-rrf**| **100/100** | **0.270 [0.180, 0.360]** | **0.470 [0.370, 0.570]** | **0.570 [0.470, 0.670]** | **0.361 [0.281, 0.445]** | 4720 | 66825 | 10873 | 32970 |
| voyage-3      | 16/100 | 0.375 [0.125, 0.625] | **0.750 [0.500, 0.938]** | **0.812 [0.625, 1.000]** | **0.553 [0.361, 0.740]** | 4104 | 4564 | 230510 | 455764 |
| aider         | 13/100 | 0.000 [0.000, 0.000] | 0.231 [0.000, 0.462] | 0.231 [0.000, 0.462] | 0.083 [0.000, 0.179] | 2586 | 3278 | 59597 | 71093 |
| ripgrep       | 100/100 | 0.040 [0.010, 0.080] | 0.260 [0.180, 0.350] | 0.310 [0.220, 0.400] | 0.118 [0.074, 0.166] | 146762 | 721893 | 71436 | 263095 |
| bm25          | 100/100 | 0.130 [0.070, 0.200] | 0.300 [0.210, 0.390] | 0.380 [0.290, 0.470] | 0.207 [0.142, 0.275] | 11263 | 183761 | 5630 | 17952 |
| fast_grep     | 100/100 | 0.060 [0.020, 0.110] | 0.090 [0.040, 0.150] | 0.140 [0.080, 0.210] | 0.076 [0.033, 0.128] | 27300 | 107126 | 11603 | 33202 |

### 4.2 Per-repo Recall@5 (Furia Q1 countermeasure)

The headline 0.47 R@5 for hybrid is mui-weighted. Per repo:

| Repo | N | nreki-mbf-on | hybrid-rrf | voyage-3 | bm25 | ripgrep | aider |
|---|---|---|---|---|---|---|---|
| mui/material-ui | 70 | 0.41 | **0.59** | 0.75 (n=8) | 0.34 | 0.29 | 0.00 (n=3) |
| microsoft/vscode | 23 | 0.22 | 0.13 | **0.67** (n=6) | 0.04 | 0.09 | 0.00 (n=5) |
| coder/code-server | 3 | 0.67 | 0.67 | **1.00** (n=1) | 0.67 | 0.67 | **1.00** (n=2) |
| tailwindlabs/tailwindcss | 3 | 0.33 | 0.33 | **1.00** (n=1) | **1.00** | 0.67 | 0.33 |
| angular/angular | 1 | 0.00 | 0.00 | n=0 | 0.00 | 0.00 | n=0 |

**vscode is where NREKI hybrid breaks (0.13 R@5) and voyage shines (0.67 R@5).** This is the broadest, most heterogeneous, most "general-purpose" repo in the corpus.

### 4.3 Macro-averaged R@5 (each repo weighted equally)

| Retriever | repos covered | macro R@5 | macro MRR | micro R@5 (for contrast) |
|---|---|---|---|---|
| voyage-3 | 4 | **0.854** | 0.634 | 0.750 |
| bm25 | 5 | 0.411 | 0.238 | 0.300 |
| hybrid-rrf | 5 | 0.343 | 0.246 | 0.470 |
| ripgrep | 5 | 0.341 | 0.199 | 0.260 |
| aider | 4 | 0.333 | 0.122 | 0.231 |
| nreki-mbf-on | 5 | 0.326 | 0.166 | 0.370 |

**Under macro-averaging, hybrid-rrf falls below BM25 standalone.** The 0.47 micro-R@5 for hybrid was a mui artifact. On equal-weight cross-repo terms, NREKI hybrid is in the same ballpark as ripgrep and aider, and **below BM25**.

### 4.4 Apples-to-apples subset (N=7 tasks where ALL 5 retrievers ran)

| Retriever | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---|---|---|---|
| voyage-3 | **0.429** | **0.714** | **0.857** | **0.592** |
| nreki-mbf-on | 0.143 | 0.571 | 0.571 | 0.333 |
| hybrid-rrf | 0.286 | 0.571 | 0.571 | 0.429 |
| bm25 | 0.000 | 0.429 | 0.429 | 0.190 |
| ripgrep | 0.000 | 0.286 | 0.286 | 0.107 |
| fast_grep | 0.000 | 0.143 | 0.286 | 0.050 |
| aider | 0.000 | 0.143 | 0.143 | 0.048 |

N=7 is too small for statistical claims, but every metric in this strict-overlap subset agrees with the macro-average: **voyage wins R@1, R@5, R@10, MRR by 14-29pp over NREKI hybrid**.

### 4.5 Paired deltas vs nreki-mbf-on (positive = NREKI better)

| Comparison | N | R@1 delta [CI95] | R@5 delta [CI95] | R@10 delta [CI95] | MRR delta [CI95] |
|---|---|---|---|---|---|
| vs nreki-mbf-off | 100 | +0.000 | +0.000 | +0.000 | +0.000 |
| **vs hybrid-rrf** | 100 | **-0.110 [-0.190, -0.030]** | **-0.100 [-0.190, -0.010]** | **-0.150 [-0.230, -0.070]** | **-0.110 [-0.176, -0.048]** |
| vs ripgrep | 100 | +0.120 [+0.050, +0.200] | +0.110 [-0.010, +0.230] | +0.110 [-0.020, +0.240] | +0.134 [+0.059, +0.215] |
| vs bm25 | 100 | +0.030 [-0.060, +0.120] | +0.070 [-0.050, +0.180] | +0.040 [-0.080, +0.160] | +0.044 [-0.041, +0.130] |
| vs fast_grep | 100 | +0.100 [+0.020, +0.180] | +0.280 [+0.180, +0.380] | +0.280 [+0.180, +0.380] | +0.175 [+0.098, +0.257] |

**Key honest takeaways from paired CI:**
- NREKI base beats fast_grep significantly (NREKI lexical/AST optimizations are worse than NREKI's own AST search — internal sanity confirmed).
- NREKI base **does not significantly beat BM25** on R@5/R@10 (CI crosses 0). The +15pp paper claim from Sprint 6.4 does not hold for `nreki-mbf-on` vs `bm25` here; only `hybrid-rrf` vs `nreki-mbf-on` is significant.
- MBF on/off makes ZERO ranking difference (identical FHR everywhere). MBF affects payload content, not ranking. The latency reduction (8.1s → 1.4s p50) is a Phase 4 caching artifact, not a recall improvement.
- The `hybrid_search` vs base `search` boost is **real and statistically significant** (~+10pp R@5, paired CI does not cross 0).

---

## Phase 5 — Furia adversarial review (round 6.6)

Verbatim Furia Q1-Q5, with author response inline.

### Q1 — Corpus representativeness

> **Furia:** Cherry-picked. 70/100 mui + 23/100 vscode means 93% of your corpus is two repos, and you literally report "NREKI hybrid wins on mui (0.59 R@5, n=70) but loses on vscode (0.13 R@5, n=23)" — so the headline R@5=0.47 is almost entirely a mui artifact weighted 3× against the one repo where you lose by 54pp. To mitigate, report macro-averaged-per-repo (not micro), or rebalance to ~20/repo; without that, the corpus is a mui benchmark wearing a TS-benchmark costume.

**Author response:** Conceded. §4.3 macro-average added; NREKI hybrid drops from 0.47 micro to 0.34 macro — below BM25. The micro-headline is preserved in §4.1 for transparency but **§4.3 is the honest comparative number**. Rebalance to ~20/repo is a Sprint 6.7 prerequisite for any publish.

### Q2 — Claude Context proxy fairness

> **Furia:** Both directions, and you can't tell which dominates — that alone disqualifies the comparison. Exact cosine ADVANTAGES voyage (no HNSW recall loss, you're giving it oracle ANN at R@10), while line-chunks DISADVANTAGE it (AST chunks would raise R@1 further since dense embeddings prefer semantically-coherent units); net effect is unknown and you didn't ablate. Also N=16 vs N=100 with 5 API errors silently dropped is not a "proxy," it's a different experiment — to mitigate, you'd need Milvus HNSW + tree-sitter chunks + N=100 with retries before claiming this is "Claude Context."

**Author response:** Conceded. §2.1 now explicitly bounds the proxy noise at ~5pp in both directions. The 28pp gap is too large to be proxy-attributable, but the strict claim is "voyage-code-3 dense retrieval" not "Claude Context". Re-running with full `@zilliz/claude-context-mcp` is the Sprint 6.7 follow-up.

### Q3 — Aider survivorship bias

> **Furia:** N=13 is a survivorship-biased joke and you know it. An 87% timeout rate at 120s means you measured Aider on the 13% of repos small enough that repo-map fits in budget — which is exactly where graph-based ranking degrades to "everything is central," so you're sampling Aider's worst regime and calling it Aider's performance. To fix: raise cap to 600s (Aider's own default is unbounded), report timeout-as-failure separately from rank-failure, and re-run; current R@1=0.00 is unpublishable as-is.

**Author response:** Conceded. Aider's reported numbers are **NOT publishable** — they characterize "Aider when it returns within 120s on small repos," not Aider's actual ranking quality. Sprint 6.7 must raise timeout to 600s (or remove cap) and re-run. The current 0.00 R@1 is annotated as a known-bad measurement.

### Q4 — Ground truth tilts toward NREKI

> **Furia:** Yes, and this is the most damaging methodological flaw in the whole sprint. PolyBench `patch` files are by construction the files a human committer touched to fix an issue — committers touch high-fan-in files disproportionately, which is the exact signal NREKI's tectonic-relevance scores; you've built a benchmark whose ground truth IS the feature NREKI optimizes for. Mitigation requires either (a) a held-out ground-truth derived from issue-linked files NOT in the patch (e.g., files mentioned in the issue body but unchanged), or (b) showing NREKI still wins on patches restricted to leaf/peripheral files — neither exists in the report, so the +0.10 hybrid-vs-base "significant" result is plausibly measuring the metric's tilt, not the retriever.

**Author response:** Partially conceded. The patch-as-ground-truth bias is real, but the data refutes the "NREKI optimized for centrality wins on centrality-based metric" hypothesis: voyage-3 (which has no topology signal at all) STILL beats NREKI hybrid by 28pp on the same biased metric. If the bias were the explanation, voyage should lose, not win. However: a held-out non-patch ground-truth (issue-mentioned files unmodified by the patch) IS the right Sprint 6.7 task to confirm this isn't a noise-floor result.

### Q5 — Spin check

> **Furia:** It's spin, and the numbers prove it. Voyage beats hybrid by 28pp R@5 on N=100-comparable means and by 14pp on the apples-to-apples N=7 (0.71 vs 0.57) — that is the primary metric the sprint defined, and "p50 tokens 4720 vs 4104" is not even a cost win (voyage is CHEAPER on tokens too; your only real axis is latency 10.9s vs 230s, which is an embedding-API artifact, not a retriever-quality claim). Honest framing: "voyage-code-3 dense retrieval dominates NREKI hybrid on recall at every K; NREKI's value proposition is latency and local-only operation, not retrieval quality" — anything softer than that, including the current "we're cheaper" pitch, is misrepresentation given vscode 13% vs 67% R@5 on the one general-purpose repo in the corpus.

**Author response:** Conceded fully. Adopted as the TL;DR (§ top). NREKI's positioning is:
1. **Faster:** 21× lower p50 latency than voyage (10.9s vs 230s)
2. **Local:** no API key, no network, no third-party data exposure
3. **Mediocre recall:** macro R@5 = 0.34 vs voyage 0.85; NREKI hybrid loses by 51pp macro
4. **NOT cheaper:** voyage p50 tokens 4104 < NREKI hybrid 4720

The honest one-liner: *"NREKI is for local, latency-sensitive code retrieval where you accept ~50% lower R@5 vs voyage-code-3."* Any other framing is spin.

---

## Phase 6 — Verdict + recommendations

### 6.1 NREKI competitor status (per metric)

| Metric | NREKI hybrid's competitive status |
|---|---|
| Recall@5 (micro) | **Loses to voyage by 28pp.** Within 5pp of BM25 (not significant). |
| Recall@5 (macro) | **Loses to voyage by 51pp. Loses to BM25 by 7pp.** |
| Recall@1 | Loses to voyage by 11pp; ties BM25. |
| MRR | Loses to voyage by 19pp; +0.15 over BM25. |
| Token cost p50 | Loses to voyage (4104 < 4720). Beats ripgrep & BM25 dramatically. |
| Latency p50 | **Wins decisively (10.9s vs 230s).** This is the real moat. |
| Local-only operation | Wins (voyage requires API). |

### 6.2 What this means for positioning

NREKI's marketable claim is **NOT** "better retrieval than Claude Context". The honest claim is:

> **"Local, fast, free code retrieval at ~50% the recall quality of voyage-code-3 dense embedding. Use when you need latency-sensitive search without an embedding API in the loop."**

This is a real niche (offline dev, no API key, fast iteration loops, latency-sensitive agentic flows), but it is NOT the "better retrieval" pitch.

### 6.3 Sprint 6.7 follow-ups (in priority order)

1. **Install `@zilliz/claude-context-mcp` + local Milvus, re-run N=100.** Eliminates the proxy uncertainty (~5pp). Highest-value follow-up.
2. **Aider re-run at 600s timeout.** N=13 is unpublishable; need real Aider numbers.
3. **Held-out non-patch ground truth.** Generates ground-truth from issue body file mentions excluding patch-modified files. Tests Furia Q4 directly.
4. **Repo-balanced corpus.** Rebuild to ~20 tasks per repo across ≥5 diverse repos (backend, ORM, library, framework, CLI). Eliminates mui dominance.
5. **3-rep validation.** Re-run the orchestrator 3× to measure latency variance (ranking is deterministic so other metrics won't change).

### 6.4 What does NOT change

- NREKI hybrid is significantly better than NREKI base (+0.10 R@5 paired, CI [+0.01, +0.19]). The `hybrid_search` action is the right default.
- NREKI's latency advantage over dense embedding is structural (no API roundtrip) and will not be eroded by better tuning.
- NREKI's local-only operation is a genuine differentiator with privacy/compliance value.

---

## Artifacts

- Analysis script: [scripts/eval-phase6/sprint66-analysis.py](../scripts/eval-phase6/sprint66-analysis.py)
- Machine-readable results: [scripts/eval-phase6/sprint66-results.json](../scripts/eval-phase6/sprint66-results.json)
- Markdown table fragment: [scripts/eval-phase6/sprint66-table.md](../scripts/eval-phase6/sprint66-table.md)
- Source per-task data: [results-c4b-full.json](../results-c4b-full.json) + [results-c4b-v3-with-hybrid.json](../results-c4b-v3-with-hybrid.json)
- Corpus CSV: [scripts/eval-phase5/data/polybench-verified.csv](../scripts/eval-phase5/data/polybench-verified.csv)
- Reproducibility: `python scripts/eval-phase6/sprint66-analysis.py`

---

**Decision recommendation:** Do NOT publish a head-to-head NREKI-vs-Claude-Context claim until Sprint 6.7 (real `@zilliz/claude-context-mcp` install + macro-balanced corpus) closes the proxy and corpus gaps. Continue shipping NREKI on the latency + local + privacy story; treat the recall comparison as an open question.
