# Sprint 6.7 — Type-Aware Retrieval: cross-file subspace test

**Date:** 2026-05-21
**Status:** Internal measurement. NOT for publish.
**Pre-registration:** [scripts/eval-phase6/sprint67-preregistration.md](../scripts/eval-phase6/sprint67-preregistration.md) (frozen BEFORE Phase 1 ran).
**Scope:** Falsification test of the hypothesis that NREKI's Type Ledger captures retrieval signal that voyage-code-3 dense embedding does NOT, on the subspace of type-dependent cross-file low-lexical-overlap PolyBench TS tasks.

---

## TL;DR — Veredicto honesto con tamaño de nicho

**H0 is NOT rejected. H1 is NOT supported. The hypothesis is unfalsifiable on this corpus as configured.**

The pre-registered Bucket A (type-dependent cross-file, Jaccard < 0.15) contains **|A| = 1 task** out of 100. The stopping rule (|A| < 15) fires, so the verdict is *insufficient sample*, not "NREKI loses" or "NREKI wins".

Compounding setup failure: voyage-3 from Sprint 6.6 ran on a 21-task stratified subset that did NOT include the one Bucket A task (`coder/code-server-4923`). Paired NREKI-vs-voyage on Bucket A: **n_pair = 0**. H0 is **untestable** as the experiment was run.

Post-hoc sensitivity (Furia Q2 mitigation, explicitly exploratory): at relaxed thresholds 0.20/0.25/0.30, |A| only rises to **5** — still well below the pre-registered floor of 15. The niche is empirically small in PolyBench TS regardless of threshold.

**Honest one-liner:** *"On PolyBench Verified TS, type-dependent cross-file low-overlap tasks are 1-5% of the corpus depending on threshold, and voyage-code-3 did not run on the relevant subset. Sprint 6.7 neither supports nor refutes the type-aware niche claim. PolyBench TS is likely the wrong benchmark to test this hypothesis."*

---

## Phase 1 — Bucket classification

### 1.1 Operationalization

Per the [pre-registration](../scripts/eval-phase6/sprint67-preregistration.md):

- **Bucket A:** `|G| >= 2` AND some pair `(g_i, g_j)` in ground_truth has a type-edge AND Jaccard < 0.15
- **Bucket B:** `|G| >= 2` AND any cross-file edge (type or value) OR Jaccard >= 0.15 between any pair
- **Bucket C:** `|G| < 2` OR no inter-GT edges

Classifier: [scripts/eval-phase6/sprint67-classify.py](../scripts/eval-phase6/sprint67-classify.py). Regex over source bytes only. No tsc invocation, no NREKI import. Module imports: `re`, `os`, `json`, `pathlib` only. Type-edge rules (verbatim from §pre-reg):

1. Explicit `import type {...}` resolving to target
2. Inline `import { type Foo, ... }` resolving to target
3. Value-import of a name declared as `interface | type | enum | class` at top level of target
4. Re-export of a name declared as a type in target

### 1.2 Results

```
Bucket A (type-dependent-cross-file, Jaccard < 0.15):  1
Bucket B (cross-file, lexical or non-type import):    31
Bucket C (single-file / no cross-file):               68
```

Per-repo distribution:

| Repo | A | B | C | Total |
|---|---|---|---|---|
| mui/material-ui | 0 | 24 | 46 | 70 |
| microsoft/vscode | 0 | 6 | 17 | 23 |
| tailwindlabs/tailwindcss | 0 | 0 | 3 | 3 |
| coder/code-server | 1 | 1 | 1 | 3 |
| angular/angular | 0 | 0 | 1 | 1 |

### 1.3 Substantive finding behind the small |A|

Of the 41 tasks with `|G| >= 2`:

| Pair structure | N |
|---|---|
| type-edge present AND Jaccard < 0.15 (→ Bucket A) | **1** |
| type-edge present AND Jaccard >= 0.15 (→ Bucket B) | 4 |
| any (non-type) cross-file edge, no type-edge (→ Bucket B) | 4 |
| **NO edges of any kind between GT files (→ Bucket B by jaccard, or C)** | **32** |

**32 of 41 multi-file PolyBench patches modify files that have no import-edge between them.** This is the corpus-shape finding that drives |A| down: PolyBench TS rewards co-located edits (siblings under a package directory, configs + handlers, CSS + component, etc.), not cross-module type propagation.

### 1.4 Stopping rule fires

`|A| = 1 < 15` → per pre-registration, this is **insufficient sample for the H0 test**. Phase 2 still computes per-bucket metrics for transparency, but Bucket A's row is reported as "untestable", not as a verdict.

---

## Phase 2 — Per-bucket metrics

Top-K=10, bootstrap 10 000 resamples, fixed seed 42. Single-shot retrieved_files data inherited from Sprint 6.6 / Sprint 4.9 runs. (3-rep variance does not apply: all retrievers are deterministic on ranking; only latency varies and is not under test for H0.)

### 2.1 Bucket A (N = 1)

| Retriever | N succ / attempted | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|
| nreki-mbf-on | 1/1 | 0.000 | 1.000 | 1.000 | 0.333 |
| hybrid-rrf   | 1/1 | 0.000 | 1.000 | 1.000 | 0.500 |
| **voyage-3** | **0/1 (skip=1)** | — | — | — | — |
| bm25         | 1/1 | 1.000 | 1.000 | 1.000 | 1.000 |
| ripgrep      | 1/1 | 1.000 | 1.000 | 1.000 | 1.000 |
| aider        | 1/1 | 0.000 | 1.000 | 1.000 | 0.500 |

The single Bucket A task is `coder/code-server-4923` (`src/node/app.ts` vs `src/node/cli.ts`, type-edge with Jaccard 0.132). It was NOT in Sprint 6.6's 21-task voyage subset, so voyage-3 returned `SKIPPED`. Paired test n_pair = 0.

Also note: BM25 and ripgrep BOTH get R@1 = 1.0 on this task — meaning the lexical signal alone is enough. The task does not isolate a "type-aware" advantage.

### 2.2 Bucket B (N = 31, cross-file with edges OR high Jaccard)

| Retriever | N succ / attempted | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|
| nreki-mbf-on | 31/31 | 0.290 [0.13, 0.45] | 0.516 [0.36, 0.68] | 0.581 [0.39, 0.74] | 0.397 [0.25, 0.55] |
| **hybrid-rrf** | 31/31 | **0.516 [0.36, 0.68]** | **0.710 [0.55, 0.87]** | **0.774 [0.61, 0.90]** | **0.589 [0.43, 0.74]** |
| voyage-3 | 4/31 (skip=25, err=2) | 0.500 [0.00, 1.00] | 1.000 [1.00, 1.00] | 1.000 [1.00, 1.00] | 0.750 [0.50, 1.00] |
| bm25 | 31/31 | 0.258 | 0.548 | 0.613 | 0.382 |
| ripgrep | 31/31 | 0.032 | 0.387 | 0.452 | 0.152 |
| aider | 5/31 (err=26) | 0.000 | 0.200 | 0.200 | 0.067 |

**Paired NREKI hybrid − voyage-3 on Bucket B (n_pair=4):**
- delta R@5 : −0.500 [−1.000, 0.000]
- delta R@10 : −0.500 [−1.000, 0.000]
- delta MRR : −0.250 [−0.750, 0.250]

voyage wins by 50pp R@5 on n_pair = 4, but that is too small for any confident claim. The CI lower bound at −1.0 / upper at 0.0 is wide enough to include "no effect" and "total domination" simultaneously.

**Cross-bucket observation:** NREKI hybrid R@5 = 0.71 on Bucket B is its **best per-bucket performance**, higher than the overall Sprint 6.6 N=100 R@5 = 0.47. So NREKI hybrid IS better on cross-file patches than on the average. But that effect is not isolated to type-coupled cases (Bucket A is too small) and on the small voyage-paired subset voyage still wins.

### 2.3 Bucket C (N = 68, single-file or no edges)

| Retriever | N succ | R@5 | MRR |
|---|---|---|---|
| nreki-mbf-on | 68 | 0.294 | 0.184 |
| hybrid-rrf | 68 | 0.353 | 0.255 |
| voyage-3 | 12 | 0.667 | 0.487 |
| bm25 | 68 | 0.176 | 0.116 |
| ripgrep | 68 | 0.191 | 0.089 |

**Paired NREKI hybrid − voyage-3 on Bucket C (n_pair=12):**
- delta R@5 : −0.083 [−0.333, +0.167]
- delta R@10 : −0.167 [−0.417, +0.000]

On Bucket C, voyage's lead over NREKI shrinks (CI on delta R@5 crosses 0). Sprint 6.6's headline "voyage wins by 28pp" was driven by Bucket B (cross-file) tasks, not Bucket C (single-file).

---

## Phase 3 — Furia adversarial

Verbatim, with author response.

### Q1 — Circularity defense

> **Furia:** Partial circularity, and the framing hides it. The regex classifier and NREKI's tectonic edges both ingest `import {...}` statements over the same source bytes. The only "independence" is implementation (regex vs AST/Type Ledger). But both operate on the same primitive: lexical import declarations resolved by relative path. So Bucket A is by construction "tasks whose ground truth contains the kind of edge NREKI's edge extractor would also see" — minus the value-vs-type distinction. That is not independence from NREKI; it is independence from `tsc`. Honest mitigation: relabel as "tsc-independent" (true) and stop claiming "independent from NREKI's logic" (false). To get true independence, build the classifier on a signal NREKI doesn't use — e.g., runtime call graphs, git co-change frequency, or LSP "find references" — and show Bucket A is non-empty under that signal too.

**Author response:** Conceded fully. Renaming throughout from "tsc-independent" alone (which is true) and dropping any "independent from NREKI's logic" framing. NREKI also operates on import statements; my classifier is `tsc-independent`, not `NREKI-orthogonal`. Sprint 6.8 should test the niche claim via a signal NREKI does NOT consume — `git log -p --follow` co-change frequency over the last 50 commits, or LSP `findReferences` calls — to confirm whether Bucket A is non-empty under a NREKI-orthogonal definition.

### Q2 — Pre-registration of 0.15

> **Furia:** Pre-registration shields you from p-hacking, not from picking a stupid threshold. 0.15 was chosen with zero pilot data on PolyBench TS; you froze it because freezing is virtuous, not because 0.15 was calibrated.

**Author response:** Conceded. Post-hoc sensitivity (explicitly exploratory, NOT a hypothesis test):

| Jaccard threshold | \|A\| | \|B\| | \|C\| |
|---|---|---|---|
| 0.15 (pre-reg) | 1 | 31 | 68 |
| 0.20 | 5 | 25 | 70 |
| 0.25 | 5 | 22 | 73 |
| 0.30 | 5 | 20 | 75 |

At every threshold ≤ 0.30, |A| stays below 15. **The pre-registered threshold is not the reason |A| is small** — the corpus simply does not contain many type-coupled multi-file patches. Threshold tuning would not have recovered statistical power. Sprint 6.8 must use a corpus where the niche is dense by construction (DefinitelyTyped PRs, TypeORM refactors, tRPC interface changes), not retrofit the threshold to PolyBench.

The 5 sensitivity-A tasks at threshold ≥ 0.20:

1. `coder/code-server-4923` (in pre-reg A too)
2. `microsoft/vscode-106767`
3. `mui/material-ui-26807`
4. `mui/material-ui-34158`
5. `mui/material-ui-34207`

Of these, only `microsoft/vscode-106767` is in Sprint 6.6's voyage subset. So even with a relaxed threshold, n_pair vs voyage = 1. H0 remains untestable.

### Q3 — |A|=1 power collapse

> **Furia:** ... the niche as operationalized is empty on PolyBench TS, AND PolyBench TS is the wrong corpus for the hypothesis. 32/41 multi-file GT patches touch sibling files with no import edge at all — PolyBench rewards co-located edits, not cross-module type propagation. ... Mitigation: replace PolyBench TS with a corpus where the niche is dense by construction — e.g., DefinitelyTyped PRs, or curated TS refactors from large monorepos (tRPC, Nx, TypeORM) where interface changes propagate.

**Author response:** Conceded fully. The Sprint 6.7 verdict is **"PolyBench TS is the wrong benchmark to test this hypothesis"** — added to the TL;DR. The 32-of-41 "no inter-GT edges" finding (§1.3) is the substantive reason and is now front-loaded. Sprint 6.8 corpus candidates:

- DefinitelyTyped PRs (heavily type-coupled by construction)
- Type-only PRs from TypeORM, tRPC, Nx, Zod (where a single interface change propagates across modules)
- Synthesized refactors: "rename TypeFoo across all consumers" extracted from monorepo type-only commits

### Q4 — Setup failure on Bucket A

> **Furia:** ... n_pair=0 on the niche of interest means the experiment did not execute its primary comparison. ... Minimum fix before any claim about Bucket A: run voyage-3 on coder/code-server-4923 (n=1, cost trivial) AND on the 27 Bucket B tasks voyage missed, so the paired n on type-edged tasks goes from 4 to at least 5–32. Without that, the row "Bucket A: H0 untestable" is the only legitimate output.

**Author response:** Conceded. Attempted the n=1 voyage run during Phase 3 mitigation; **blocked by missing real `VOYAGE_API_KEY`** in the local env (the present key is a 6-char placeholder, not a real Voyage credential). This is documented as the explicit Sprint 6.8 blocker. The "Bucket A: H0 untestable" row is now the verdict for Phase 4 §4 below.

### Q5 — Spin check

> **Furia:** It is face-saving. ... The honest one-liner is: "On PolyBench TS, type-dependent cross-file tasks under jaccard<0.15 are 1% of the corpus and we did not run the baseline on them; the niche claim is neither supported nor refuted, and PolyBench is likely the wrong benchmark to test it." Anything softer is marketing.

**Author response:** Conceded; verbatim adopted as the TL;DR honest one-liner.

---

## Phase 4 — Verdict

### 4.1 H0 result

**H0 is NOT rejected. H1 is NOT supported. The hypothesis is UNTESTABLE on this corpus as configured.**

Reasons:
1. **Insufficient sample on the niche:** |A| = 1 at pre-registered Jaccard 0.15 (stopping rule floor = 15). Even at the loosest exploratory threshold 0.30, |A| = 5.
2. **Baseline missing on the niche:** voyage-3 (the H0 comparator) was not run on the single Bucket A task. n_pair on A = 0. Mitigation blocked by missing Voyage API key in env.
3. **Substantive corpus mismatch:** 32 of 41 multi-file PolyBench patches modify files with no import-edge between them. PolyBench TS rewards co-located edits, not the type-coupled cross-module pattern under test.

### 4.2 Niche size and bounded claim

Even setting power aside, the niche size is **|A| / N = 1% (pre-reg) to 5% (exploratory ceiling)** of PolyBench TS. Per the pre-registration verdict template, any claim about NREKI's type-aware niche must read:

> *"NREKI's type-aware retrieval niche, as operationalized via tsc-independent import-graph + Jaccard < 0.15, contains 1% of PolyBench Verified TS tasks. We did not measure NREKI vs voyage on this 1% because voyage was not run there. The niche claim is neither supported nor refuted by Sprint 6.7."*

The retrieval-path open question from Sprint 6.6 (does NREKI win some niche where vector search loses?) **remains open**.

### 4.3 What CAN be said from Phase 2 data

These observations are NOT tests of H0, but are factual aggregations from the data:

- NREKI hybrid R@5 = 0.71 on Bucket B (cross-file with edges) is its **highest per-bucket result**, vs 0.35 on Bucket C (single-file). NREKI's hybrid retriever does perform better on cross-file patches than on the 100-task average — directionally consistent with the type-aware hypothesis but not isolated to type-coupled tasks.
- voyage's apparent dominance from Sprint 6.6 is concentrated in Bucket B (where voyage's n_pair=4 paired delta is −0.50 R@5 — large but very noisy) and shrinks on Bucket C (paired delta −0.08, CI crosses 0).
- BM25 and ripgrep alone solve the single Bucket A task. There is no measurable type-aware advantage on this single instance.

### 4.4 Unexpected finding (honest)

The most surprising data point is **|A| = 1 even before considering threshold strictness.** Going in, I expected ≥ 10 such tasks based on the intuition that "TypeScript refactors propagate types across files." The empirical reality on PolyBench Verified TS is that **bug-fix PRs (77% of the corpus) almost never modify multiple type-coupled files**. They mostly touch:
- A single file with the bug (58/100 single-file GT)
- A handler + its sibling config (high Jaccard)
- A component + its CSS / snapshot test (no type-edge)
- Distantly related siblings under the same package (no import-edge)

This is a substantive comment about PolyBench's bug taxonomy, not just an artifact of my classifier. If NREKI's value is in cross-module type-aware retrieval, **the PolyBench benchmark cannot measure it**.

---

## Phase 5 — Sprint 6.8 path forward

Sprint 6.7 closes the type-aware niche question with **"not testable here"**, not with "NREKI wins" or "NREKI loses". Two paths:

### Path A — Build the right corpus

1. **DefinitelyTyped PRs.** Extract 50+ TS-only PRs where a `.d.ts` interface change propagates to ≥2 consumer `.d.ts` files. By construction, these are type-coupled with low lexical overlap.
2. **TypeORM / Zod / tRPC interface refactors.** Mine commits where a single `interface` is renamed or restructured and check downstream files. The patch IS the type signal.
3. **Synthesize from existing TS monorepos.** Build a small N=30-50 benchmark of "rename TypeFoo across consumers" tasks. Curate ground truth manually.

Then re-run Sprint 6.7 protocol with the niche dense by construction.

### Path B — Drop the type-aware retrieval claim entirely

If the corpus shape of real-world TS PRs is "single-file fixes + sibling edits + no cross-module type propagation", then NREKI's tectonic relevance signal may not have a defensible retrieval-quality niche. In that case Sprint 6.6's verdict stands: **NREKI is for latency + local operation, not retrieval quality**, and the type-aware claim should be removed from the messaging.

The Sprint 6.7 data does not force a choice between Path A and B; it forces an acknowledgment that the choice has not been answered.

---

## Artifacts

- Pre-registration (frozen): [scripts/eval-phase6/sprint67-preregistration.md](../scripts/eval-phase6/sprint67-preregistration.md)
- Classifier: [scripts/eval-phase6/sprint67-classify.py](../scripts/eval-phase6/sprint67-classify.py)
- Phase 1 bucket assignments: [scripts/eval-phase6/sprint67-buckets.jsonl](../scripts/eval-phase6/sprint67-buckets.jsonl)
- Phase 1 summary: [scripts/eval-phase6/sprint67-buckets-summary.md](../scripts/eval-phase6/sprint67-buckets-summary.md)
- Phase 2 per-bucket metrics: [scripts/eval-phase6/sprint67-metrics.json](../scripts/eval-phase6/sprint67-metrics.json) + [.md](../scripts/eval-phase6/sprint67-metrics.md)
- Sensitivity (post-hoc, exploratory): [scripts/eval-phase6/sprint67-sensitivity.py](../scripts/eval-phase6/sprint67-sensitivity.py), [scripts/eval-phase6/sprint67-sensitivity.md](../scripts/eval-phase6/sprint67-sensitivity.md)
- Reproducibility:
  ```
  python scripts/eval-phase6/sprint67-classify.py
  python scripts/eval-phase6/sprint67-metrics.py
  python scripts/eval-phase6/sprint67-sensitivity.py
  ```

---

**Sprint 6.7 closes with the niche hypothesis OPEN. Do not publish a "NREKI wins type-aware retrieval" claim from this data. Sprint 6.8 must either build the right corpus (Path A) or retire the claim (Path B).**
