# Symbol Replace Threshold — Empirical Analysis

**Sprint:** v11.3.1 — empirical recalibration of `SYMBOL_REPLACE_LIMIT`
**Date:** 2026-05-19
**Methodology:** TypeScript Compiler API extraction of every function/method/arrow/getter/setter/constructor with `lines = endLine − startLine + 1`. No estimation, no heuristics.
**Script:** [scripts/analyze-symbol-sizes.mjs](../scripts/analyze-symbol-sizes.mjs)
**Raw data:** [scripts/symbol-size-report.json](../scripts/symbol-size-report.json)

## 1. Samples

| Sample        | Description                          | Files | Symbols extracted |
|---------------|--------------------------------------|------:|------------------:|
| `nreki-src`   | NREKI own source (this repo)         |    75 |               724 |
| `zod`         | zod v3 schema lib (npm prod)         |    99 |             1 439 |
| `ajv`         | ajv JSON validator (npm prod)        |   106 |               662 |
| `eventsource` | server-sent-events client (npm prod) |     4 |                29 |
| `ajv-formats` | ajv plugin (npm prod)                |     3 |                26 |
| **AGGREGATE** |                                      |   287 |         **2 880** |

External samples are real production TypeScript pulled from `node_modules` — code that ships to users, not toys.

## 2. Distribution percentiles

| Sample        | mean   | median |  p75 |  p90 |  p95 |  p99 |  max |
|---------------|-------:|-------:|-----:|-----:|-----:|-----:|-----:|
| nreki-src     | 28.9 L |   12 L | 31 L | 65 L |105 L |283 L |479 L |
| zod           | 15.2 L |    6 L | 14 L |  31 L*| 54 L |117 L |503 L |
| ajv           | 11.5 L |    6 L | 13 L |  26 L*| 39 L | 76 L |123 L |
| eventsource   | 11.5 L |    8 L | 12 L |  24 L*| 27 L | 78 L | 78 L |
| ajv-formats   |  9.8 L |    6 L | 14 L |  18 L*| 19 L | 49 L | 49 L |
| **AGGREGATE** |**17.7 L**|**7 L**|**17 L**|**38 L***|**66 L**|**146 L**|**503 L**|

\* p90 derived from raw report (not in summary table — interpolated for context).

**Reading:** Across 2 880 production functions, the p95 is **66 L**. Half of all functions are ≤ 7 L. NREKI's own source skews larger (p95 = 105 L) because it includes algorithmic kernels (Fiedler clustering, AST splice, symbol classifier).

## 3. False-positive rate by threshold

% of *legitimate, real* functions a `mode:"replace"` guard would block at each threshold.

| Threshold | nreki-src | zod    | ajv   | aggregate |
|----------:|----------:|-------:|------:|----------:|
| **>40 L (current)** | **19.06%** | 8.96% | 5.59% | **10.45%** |
|     >50 L           |    14.78% | 6.39% | 3.93% |     7.26% |
|     >60 L           |    11.46% | 4.59% | 2.27% |     5.59% |
|     >70 L           |     8.84% | 3.89% | 1.51% |     4.72% |
|     >80 L           |     8.01% | 3.27% | 0.91% |     4.20% |
|    >100 L           |     5.52% | 2.30% | 0.30% |     3.02% |
|    >120 L           |     4.01% | 1.46% | 0.15% |     1.42% |
|    >150 L           |     3.18% | 0.97% | 0.00% |     0.94% |

### Key findings

1. **NREKI self-inconsistency.** Current threshold (40 L) blocks **19.06%** of NREKI's own functions. ~1 of every 5 functions in this repo cannot be `replace`-edited by NREKI itself. The tool violates its own ergonomic contract.

2. **`processText` was not a corner case.** The user's bug report (`processText 55L`) sits well inside the p75-p90 band for both NREKI (p75=31, p90=65) and zod (p90≈31, p95=54). At 55 L it is a *typical mid-sized* function, not a god-function.

3. **Threshold elasticity.** Moving 40 → 80 cuts false-positive rate by **60%** (10.45% → 4.20%) on aggregate. Moving 40 → 100 cuts by **71%** (10.45% → 3.02%). Beyond 100 L the curve flattens — the marginal symbols unlocked are genuinely large (>120 L is < 1.5% of code).

4. **Aggregate p95 ≈ 66 L.** A defensible "block only true outliers" stance is *threshold = p95 of real code* ≈ 70 L. A more conservative "block only god-functions" stance is *threshold ≈ p99 of mid-sized libs* ≈ 80–100 L.

## 4. Bucket histogram (aggregate, 2 880 symbols)

```
   0– 20L  ████████████████████████████████████████  2 173  (75.5%)
  20– 40L  █████████                                    406  (14.1%)
  40– 60L  ███                                          140   (4.9%)
  60– 80L  █▏                                            40   (1.4%)
  80–100L  ▊                                             34   (1.2%)
 100–150L  █                                             46   (1.6%)
 150–200L  ▍                                             14   (0.5%)
   >=200L  ▋                                             27   (0.9%)
```

**Reading:** ~90% of real-world TypeScript functions fit in ≤ 40 L. The threshold has empirical support *as a heuristic for "this is small enough to rewrite safely"* — but that's a description of *most* functions, not *all legitimate* ones.

## 5. Interpretation for sprint decision

- The current `40` is **defensible as a description of typical code** but **excessive as a hard block**, because:
  - It blocks 10–19% of *real, well-written, non-pathological* functions.
  - NREKI has **10 other gates** (anti-sweep, TTRD, kernel TS validation, Chronos friction, blast radius, Fiedler bridge, auto-backup, ACID, file lock, topology cache) that catch the actual failure modes the guillotine was trying to prevent.
  - The 40 L block forces `mode:"patch"` even for legitimate full-symbol rewrites, which is friction without commensurate safety gain when other gates remain.

- **Candidates for new default:**
  - **80 L** — covers p95 aggregate, leaves ~4% false-positive rate, still blocks god-functions visibly. Round number, easy to remember.
  - **100 L** — covers p99 of typical libs, ~3% false-positive rate. NREKI's own outline auto-expand already uses `<=100L` as the "HIGH-risk but readable" cutoff (v10.1.1 commit 40d55fb), so 100 has internal precedent.

Final value is selected in Phase 3 after adversarial review.

## 6. Reproducibility

```bash
node scripts/analyze-symbol-sizes.mjs
# Re-emits scripts/symbol-size-report.json
```

Adding new samples: append to `SAMPLES` in the script. The walker skips `node_modules`, `__tests__`, `tests`, `.d.ts`, `.test.ts`, `.spec.ts`.
