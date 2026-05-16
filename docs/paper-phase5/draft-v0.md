# Hybrid Topological-Lexical Retrieval via Late-Fusion RRF: Statistically Significant Improvements over BM25 and Standalone Topological Retrieval with 100% Production-Scale Reliability

## Abstract

Codebase retrieval for agentic software engineering fails when relevant evidence crosses files, modules, and type-level dependencies. Recent work by Arafat (2025) identifies cross-file evidence discovery as a primary bottleneck for citation-grounded code comprehension, while production use of cloud dense embeddings introduces cost, quota, and reliability constraints. We evaluate NREKI, a local-first Type Ledger topological retriever, against BM25 and a late-fusion hybrid that combines NREKI and BM25 with Reciprocal Rank Fusion over file-level rankings. On PolyBench-Verified TypeScript tasks (N=99), hybrid RRF achieves statistically significant improvements over both standalone systems: +15.2 percentage points First Hit Recall over NREKI, +19.2 points over BM25, and positive paired 95% bootstrap confidence intervals for all reported hybrid deltas in FHR, CLR, R@1, R@5, and MRR. NREKI remains the most token-efficient standalone retriever, with median token cost 4.8x lower than BM25. Hybrid RRF trades additional tokens for accuracy, remaining 2.42x cheaper than BM25 while using 1.98x more tokens than NREKI. Compared with voyage-code-3, which completed only 15.2% of N=99 production-scale tasks in our evaluation environment, local retrieval completed 100% with zero runner errors. The result supports a deployable hybrid retrieval pattern for code agents without claiming superiority over dense models when they complete.

## 1. Introduction

Modern coding agents need retrieval systems that can recover the source files that matter before generation begins. The hard cases are not usually files that share a rare literal string with the issue description. They are cross-file architectural dependencies: a behavior implemented in one module, typed in another, re-exported through a boundary, and triggered through a test or framework adapter elsewhere. A retriever that finds only lexical overlap may miss the architectural evidence. A retriever that follows only topology may miss the obvious textual cue. The practical problem is therefore not "BM25 versus structure" or "dense embeddings versus sparse retrieval"; it is how to combine complementary retrieval signals without creating a production system that is too fragile, too expensive, or too opaque to trust.

This paper studies that problem in the context of NREKI, a local-first retrieval engine for code agents. NREKI uses Type Ledger style topological signals to recover files through code structure rather than relying purely on textual similarity. In prior Phase 5 evaluations, standalone NREKI reached empirical parity with BM25 while using far fewer tokens. That result was useful but incomplete. If lexical and topological retrieval expose different slices of the relevant evidence space, then parity between standalone systems leaves accuracy on the table.

Recent citation-grounded code comprehension work gives external motivation for this direction. Arafat's December 2025 study argues that cross-file evidence discovery is a major contributor to citation completeness and that pure textual similarity underuses code structure. That work combines sparse, dense, and graph expansion techniques. NREKI approaches the same retrieval gap from a local-first engineering angle: avoid mandatory cloud indexing, keep retrieval inspectable, and exploit type-aware codebase structure where available.

Cloud dense embedding systems remain important baselines. We evaluated voyage-code-3 as a code-specialized dense retrieval baseline because the model is explicitly optimized for code retrieval. However, in our production-scale evaluation environment, voyage-code-3 completed only 15 of 99 evaluable PolyBench-Verified tasks before quota and operational limits dominated the run. On the paired successful subset, voyage-code-3 was more accurate than NREKI, which is important and should not be hidden. The larger finding is different: a retriever that is more accurate when it runs is not sufficient for a production-scale local coding agent if it cannot complete the workload reliably under the deployment constraints being tested.

The contribution of this phase is a late-fusion hybrid retriever. The system runs NREKI and BM25, extracts file-level rankings from each retriever, and applies Reciprocal Rank Fusion (RRF) at the file level. The winning files are then used to collect chunks for downstream context. This design was chosen after an early-fusion implementation at chunk granularity produced a mismatch between simulation and implementation. The failure mode was chunk starvation: multiple chunks from one file could crowd the fused ranking before file-level coverage had a chance to express itself. The final design treats the file path as the fusion unit, matching the evaluation objective: retrieve files that contain the ground-truth source change.

The result is positive and statistically clean. On N=99, hybrid RRF improves First Hit Recall from 0.414 to 0.566 over NREKI and from 0.374 to 0.566 over BM25. Every requested paired bootstrap delta for hybrid versus NREKI and hybrid versus BM25 has a strictly positive lower 95% confidence bound. The result is not a token-efficiency win over NREKI. Hybrid costs more than standalone NREKI. It is an accuracy win that remains substantially cheaper than BM25 and preserves full local reliability.

## 2. Related Work

BM25 is the classical sparse lexical baseline for information retrieval. Its strengths are still relevant for code: identifier names, error messages, API calls, and exact literals often carry high signal. BM25 is also local, simple, and deterministic. Its weakness is that lexical overlap is not the same as architectural relevance. If a task description names behavior rather than the internal symbols that implement it, BM25 can miss the source file that needs editing.

Dense code embeddings attempt to close that semantic gap by mapping code and natural language into a shared vector space. Voyage AI's voyage-code-3 is a code-specialized embedding model; the public model card describes it as optimized for code retrieval and reports gains over other embedding baselines on a suite of code retrieval datasets. In our experiments, voyage-code-3 was treated as a strong cloud dense baseline. We separate two findings: on the successful paired subset, voyage-code-3 outperformed NREKI on FHR; on the full production-scale run, it completed only 15.2% of evaluable tasks in our environment.

Reciprocal Rank Fusion was introduced by Cormack, Clarke, and Buettcher in 2009 as a simple unsupervised rank aggregation method. RRF scores a document by summing reciprocal rank contributions across input rankings, commonly with k=60:

```text
RRF(d) = sum_r 1 / (k + rank_r(d))
```

The appeal for this work is that RRF does not require score calibration across heterogeneous retrievers. NREKI and BM25 scores are not naturally comparable, but their rank positions are. RRF lets a file receive cumulative evidence when both systems retrieve it, while still allowing one system to rescue files the other misses.

Graph-augmented and structure-aware code retrieval is an active area. Arafat (2025) combines BM25, dense embeddings, and Neo4j import expansion for citation-grounded code comprehension. NREKI differs in implementation target and deployment assumptions. It is designed as a local engine for coding agents and emphasizes type/topology derived from the repository itself rather than an external graph database service.

MCP-based context systems also matter for the surrounding ecosystem. Zilliz documents an MCP server that connects agents to Zilliz Cloud and Milvus-backed vector search. This paper makes no performance claim against Zilliz Claude Context or Zilliz Cloud systems. The only relevant contrast is deployment class: cloud vector search can be valuable, but this work focuses on local-first retrieval reliability and measured behavior on a fixed benchmark.

## 3. Methodology

### Dataset

We evaluate on PolyBench-Verified TypeScript tasks. The full orchestration run loaded 100 tasks. One task, `mui__material-ui-38247`, had no `strict_src` ground truth and was excluded before metric aggregation. The statistical tribunal is therefore N=99. This exclusion is not a post-hoc accuracy filter; a task without strict source ground truth cannot support file-retrieval metrics. The JSONL artifact still contains all 100 task records, preserving auditability.

The evaluated retrievers are:

- `nreki-mbf-on`: standalone NREKI topological retrieval.
- `bm25`: standalone lexical retrieval.
- `hybrid-rrf`: file-level late-fusion RRF over NREKI and BM25.

All three runners completed all 100 records. The integrity check found 0 malformed JSONL records, 0 missing runner cells, 0 schema errors, and 0 runner errors.

### Metrics

We report:

- FHR: First Hit Recall at the runner's retrieved file list depth.
- CLR: strict chunk containment as emitted by the evaluation harness.
- R@1, R@3, R@5, R@10: whether a strict ground-truth file appears by that file rank.
- MRR: reciprocal rank of the first strict ground-truth file hit.
- Median token cost and median latency.

For statistical claims, we use paired bootstrap confidence intervals over the same N=99 tasks. Each bootstrap uses 10,000 resamples. A positive improvement is considered significant only when the lower bound of the 95% confidence interval is strictly greater than zero. This rule is intentionally conservative and prevents narrative inflation from point estimates alone.

### Bias Controls

The evaluation excludes only the empty-ground-truth task. No failed runner cells were dropped because no runner cells failed. Previous Phase 5 methodology used a shuffled task order to reduce order effects and paired comparisons to prevent repository composition from favoring one retriever. The Sprint 6.4 tribunal compares runners on the same task set and therefore uses paired deltas for significance.

### Voyage Paired Analysis

Voyage-code-3 was evaluated separately because it could not complete the production-scale N=99 run in our environment. The local runner constant is `VOYAGE_MODEL = "voyage-code-3"`; this draft uses the model name consistently to avoid shorthand ambiguity. In `results-c4b-v2-full.jsonl`, voyage-code-3 produced successful paired results for N=15 tasks, equal to 15.2% of the N=99 evaluable benchmark. On those N=15 tasks, voyage-code-3 reached FHR 0.800 versus NREKI 0.400. The paired bootstrap delta reported by the local analysis script is `nreki-mbf-on - voyage-code-3 = -0.400`, CI95% `[-0.667, -0.133]`, significant. For CLR, the delta is -0.143 with CI95% `[-0.320, +0.004]`, not significant. These numbers support a narrow statement: voyage-code-3 was more accurate on FHR when it completed successfully. They do not support production-scale reliability claims in its favor for this evaluation.

### Late-Fusion RRF Implementation

The final hybrid is a runner-layer method, not a change to the NREKI engine. For each task, the runner requests `topK * 4` files from NREKI and BM25, deduplicates file paths inside each ranking, and computes:

```text
score(file) =
    1 / (60 + rank_nreki(file)) if present in NREKI
  + 1 / (60 + rank_bm25(file))  if present in BM25
```

Files are sorted by descending RRF score and truncated to `topK`. If scores tie, the implementation breaks ties deterministically by lexicographic file path comparison. This tie-breaker was added before the final N=99 run to remove insertion-order jitter from exact RRF ties.

The `topK * 4` pool is part of the method. Earlier reconciliation work found a truncation horizon asymmetry between simulations using K=10 and implementation runs using K=40 candidate pools. The final empirical claim is therefore based on the implemented architecture, not on the earlier file-level simulation alone.

### AI Dogfooding and Adversarial Review

The evaluation process used AI dogfooding as a methodology rather than as a branding claim. A coding agent implemented retrievers, ran evaluations, and produced diagnostic artifacts. A separate adversarial review process challenged silent failures, mismatched simulation granularity, OOM behavior, tie-breaking nondeterminism, and statistical overclaiming. The useful methodological point is that agentic systems can be evaluated by the same style of adversarial, reproducible workflows they are meant to improve. The paper does not disclose internal agent architecture; it reports the review discipline and the artifacts it forced into existence.

## 4. Results

### Table 1. Aggregate N=99

| Retriever | FHR | CLR | R@1 | R@3 | R@5 | R@10 | MRR | tok p50 | lat p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nreki-mbf-on | 0.414 | 0.488 | 0.152 | 0.313 | 0.364 | 0.414 | 0.244 | 2313 | 23866 |
| bm25 | 0.374 | 0.439 | 0.121 | 0.263 | 0.293 | 0.374 | 0.199 | 11110 | 7099 |
| hybrid-rrf | 0.566 | 0.568 | 0.263 | 0.404 | 0.465 | 0.566 | 0.355 | 4588 | 10756 |

Hybrid RRF has the highest value in every accuracy column. It improves FHR by +15.2 percentage points over NREKI and +19.2 points over BM25. It also improves MRR from 0.244 to 0.355 over NREKI and from 0.199 to 0.355 over BM25. The token cost is a trade-off: hybrid is more expensive than NREKI but much cheaper than BM25.

### Table 2. Paired Bootstrap CI95% Deltas, 10,000 Resamples

| Comparison | Metric | Delta | CI95 low | CI95 high | Significant |
|---|---|---:|---:|---:|:---:|
| hybrid - nreki | FHR | +0.152 | +0.071 | +0.232 | Y |
| hybrid - nreki | CLR | +0.081 | +0.026 | +0.140 | Y |
| hybrid - nreki | R@1 | +0.111 | +0.030 | +0.192 | Y |
| hybrid - nreki | R@5 | +0.101 | +0.010 | +0.192 | Y |
| hybrid - nreki | MRR | +0.111 | +0.047 | +0.176 | Y |
| hybrid - bm25 | FHR | +0.192 | +0.091 | +0.293 | Y |
| hybrid - bm25 | CLR | +0.129 | +0.058 | +0.204 | Y |
| hybrid - bm25 | R@1 | +0.141 | +0.051 | +0.232 | Y |
| hybrid - bm25 | R@5 | +0.172 | +0.071 | +0.273 | Y |
| hybrid - bm25 | MRR | +0.156 | +0.081 | +0.233 | Y |

The hybrid has 10 significant positive deltas out of 10 requested hybrid comparisons. This is the central empirical result of Phase 5. It supports the statement that late-fusion RRF improves retrieval accuracy over both standalone NREKI and standalone BM25 on this benchmark.

NREKI and BM25, by contrast, were not significantly different from each other under the same bootstrap discipline:

| Comparison | Metric | Delta | CI95 low | CI95 high | Significant |
|---|---|---:|---:|---:|:---:|
| nreki - bm25 | FHR | +0.040 | -0.081 | +0.162 | N |
| nreki - bm25 | CLR | +0.049 | -0.038 | +0.135 | N |
| nreki - bm25 | R@1 | +0.030 | -0.061 | +0.121 | N |
| nreki - bm25 | R@5 | +0.071 | -0.051 | +0.192 | N |
| nreki - bm25 | MRR | +0.045 | -0.042 | +0.131 | N |

This matters because it prevents an inflated "NREKI beats BM25" claim. On this run, NREKI and BM25 are empirically at parity for the reported accuracy metrics. NREKI's standalone advantage is token efficiency, not statistically significant accuracy.

### Table 3. Voyage-Code-3 Paired Subset, N=15 Successful Tasks

| Retriever | FHR N=15 | CLR N=15 | tokens p50 | tokens p95 |
|---|---:|---:|---:|---:|
| voyage-code-3 | 0.800 | 0.707 | 4028.0 | 4569.8 |
| nreki-mbf-on | 0.400 | 0.564 | 2301.0 | 3988.9 |

| Paired Delta | Metric | Delta | CI95 low | CI95 high | Significant |
|---|---|---:|---:|---:|:---:|
| nreki - voyage-code-3 | FHR | -0.400 | -0.667 | -0.133 | Y |
| nreki - voyage-code-3 | CLR | -0.143 | -0.320 | +0.004 | N |

Voyage-code-3 was superior on FHR when it completed successfully. The limitation is operational coverage: the successful paired subset was N=15, or 15.2% of N=99. The main N=99 results therefore should not be read as saying local retrieval is more accurate than voyage-code-3 when both complete. They show that local NREKI/BM25/hybrid completed the production-scale benchmark reliably, while the dense cloud baseline did not in this environment.

### Token Efficiency

Median token cost:

- NREKI: 2313 tokens.
- BM25: 11110 tokens.
- Hybrid RRF: 4588 tokens.

NREKI is 4.8x cheaper than BM25 by p50 token cost. Hybrid RRF is 2.42x cheaper than BM25, but 1.98x more expensive than NREKI. This segmentation is important. Hybrid is not the cheapest retriever. It is the accuracy-leading retriever that remains substantially cheaper than BM25.

### Reliability

The Sprint 6.4 run completed with:

- 100 JSONL records written.
- 99 evaluable strict-ground-truth tasks.
- 3/3 runners present for every record.
- 0 malformed records.
- 0 schema errors.
- 0 runner errors.
- Wall clock: 8020.14 seconds.

This supports a production-scale reliability claim for the evaluated local runners. The claim is scoped to this benchmark, implementation, and run environment.

## 5. Discussion

The hybrid result is best interpreted as evidence of signal complementarity. NREKI and BM25 are not individually superior on accuracy with statistical confidence, yet their fusion is superior to both. This is exactly the kind of setting where RRF should work: two rankers retrieve overlapping but non-identical evidence, and a rank-level combiner can reward agreement while preserving rescue paths from either side.

Late fusion also resolved an implementation lesson. The early hybrid implementation fused chunks rather than files. That made the implementation diverge from the file-level simulation and created chunk starvation: a file with many high-ranking chunks could dominate the candidate list before the system had enough file-level diversity. The final runner fuses file paths, then retrieves chunks for the selected files. The granularity matches the evaluation target and the practical agent need: identify the files worth reading or editing.

The `topK * 4` candidate pool is not an incidental engineering detail. It gives each retriever room to contribute beyond the final K files. A K=10 simulation and a K=40 implementation are not isomorphic because files that appear below rank 10 in one retriever may become important after fusion. The final claim is therefore based on the actual implemented pool. Future simulations should explicitly model the truncation horizon used by the runner.

NREKI's standalone contribution remains substantial even though hybrid wins on accuracy. NREKI reaches accuracy parity with BM25 while using only 20.8% of BM25's median token cost. That is a practical result for local agents under token budgets. It means a deployment can choose among three operating points: BM25 for simple lexical local retrieval, NREKI for lower-token structural retrieval, and hybrid RRF when accuracy is worth the additional token spend.

The voyage-code-3 result complicates the story in a useful way. It indicates that cloud dense retrieval can be highly accurate on tasks it completes. The production problem is not only model quality. It is also availability, quotas, per-run cost, indexing limits, and failure behavior under a full benchmark workload. A local-first system can be less powerful per query and still be preferable when the unit of evaluation is a complete engineering workflow.

Finally, the adversarial review process affected the technical result. It caught OOM teardown risk, simulation/implementation granularity mismatch, truncation horizon asymmetry, and nondeterministic tie-breaking. Without those checks, the paper could have reported a more convenient but less true result. The final result is stronger because the failed paths are documented and the claims are narrower.

## 6. Limitations

This is a single-benchmark result. PolyBench-Verified TypeScript N=99 is large enough to support paired bootstrap analysis, but it is not a universal claim about all programming tasks, all languages, or all repository scales. The strongest claim is scoped: on this TypeScript benchmark and this implementation, late-fusion RRF significantly improves over standalone NREKI and BM25.

The voyage-code-3 comparison is limited by operational completion. The model completed only 15 paired evaluable tasks in the production-scale artifact used for this analysis. That is enough to show that voyage-code-3 was strong when operative, but not enough to characterize its full-benchmark accuracy. We therefore avoid claiming that hybrid RRF is more accurate than voyage-code-3. The honest claim is reliability and local completion at N=99, plus superiority over the two fully completed local baselines.

Hybrid has real token overhead. Its p50 token cost is 4588, compared with NREKI's 2313. That is 1.98x more than standalone NREKI. Users with tight token budgets may prefer NREKI even though hybrid is more accurate. The hybrid is still 2.42x cheaper than BM25, so the overhead is best understood as an accuracy trade-off inside the local retrieval family, not as a global efficiency win.

The Type Ledger component is TypeScript-specific in the current evaluated system. NREKI has broader parsing infrastructure and bundled language support, but the topological retrieval result in this paper should be read through the TypeScript lens. Current active multi-language support is narrower than the repository's bundled parser surface: seven active languages are supported in practice, while more than fifteen grammars or language assets may be present but inactive or not equivalently evaluated.

Latency is not uniformly better. BM25 has the lowest median latency in Table 1. Hybrid RRF adds orchestration and runs both underlying retrievers. It improves accuracy, but it is not the fastest method. For interactive coding agents, the right deployment choice may depend on whether the bottleneck is first-token latency, total context cost, or success probability on harder cross-file tasks.

The benchmark evaluates retrieval, not end-to-end patch correctness. Higher FHR, R@K, and MRR should improve the odds that a downstream agent sees the right files, but this paper does not prove that hybrid RRF increases accepted patches, merged pull requests, or human developer productivity. Those are future end-to-end measurements.

The AI dogfooding methodology introduces its own risks. Agents can overfit to the metrics they are asked to optimize, and adversarial review can miss bugs. The mitigation is artifact discipline: JSONL outputs, deterministic tie-breakers, explicit bootstrap rules, and no claims without confidence intervals. Still, the review process should be treated as a promising methodology, not as a substitute for independent replication.

## 7. Future Work

Phase 6 will focus on adaptive foveal compression and Pareto sweeps across accuracy, latency, and token cost. The main question is whether the hybrid's added token cost can be compressed after retrieval without losing the accuracy gains created by file-level fusion.

Phase 7 will explore Type Ledger-guided periphery compression. If Type Ledger can identify structural centrality, then downstream context windows can preserve core architectural evidence while shrinking peripheral files more aggressively.

Phase 8 will expand Type Ledger beyond TypeScript. Priority targets are Kotlin, Java, and C++, where type systems and build graphs expose rich topology but require language-specific extraction strategies.

OMEGA 1 is compiler hijacking through headless `tsserver`: using the compiler and language server as live retrieval oracles rather than offline metadata generators.

OMEGA 2 is causal program slicing: moving from file retrieval toward minimal causal evidence chains for a requested behavioral change.

## 8. Conclusion

Phase 5 shows that late-fusion RRF over topological and lexical retrieval is not merely plausible; it is statistically significant on the N=99 PolyBench-Verified TypeScript tribunal. Hybrid RRF improves over standalone NREKI and BM25 across every requested paired bootstrap metric, while completing the full local production-scale run with zero runner errors.

The result is not that one retrieval philosophy wins. It is that file-level topology and lexical evidence are complementary. NREKI alone is the token-efficiency leader. BM25 remains a fast and useful lexical baseline. Hybrid RRF is the accuracy leader, with a transparent token trade-off and deterministic implementation.

The paper's core claim should therefore be narrow and strong: local late-fusion topological-lexical retrieval significantly improves file retrieval accuracy over both standalone local baselines on PolyBench-Verified N=99, while preserving 100% run completion in the evaluated environment.

## 9. References

[1] Jahidul Arafat. "Citation-Grounded Code Comprehension: Preventing LLM Hallucination Through Hybrid Retrieval and Graph-Augmented Context." arXiv:2512.12117, submitted December 13, 2025. https://arxiv.org/abs/2512.12117

[2] G. V. Cormack, C. L. A. Clarke, and S. Buettcher. "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods." SIGIR 2009. https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf

[3] Voyage AI. "voyage-code-3" model card/tokenizer repository. Hugging Face, accessed May 2026. https://huggingface.co/voyageai/voyage-code-3

[4] Zilliz. "MCP Server." Zilliz Cloud Developer Hub, accessed May 2026. https://docs.zilliz.com/docs/zilliz-mcp-server

[5] NREKI internal artifact. `results-c4b-v3-with-hybrid.jsonl`, Sprint 6.4, generated May 15, 2026.

[6] NREKI internal artifact. `results-c4b-v2-full.jsonl`, voyage-code-3 paired analysis input, generated before Sprint 6.4.

## Appendix A. Infrastructure Reliability Notes

Aider and other agent-infrastructure observations are intentionally separated from the main retrieval claims. They are useful for operational context but are not evidence for the central hybrid RRF result. The main paper should keep Aider in an infrastructure reliability appendix so that retrieval metrics do not become entangled with agent runtime behavior, quota management, or tool-specific failure modes.
