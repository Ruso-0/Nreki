# Sprint 6.7 — Pre-registration

**Frozen:** 2026-05-21, BEFORE running Phase 1 classification or Phase 2 measurement.
**Purpose:** Lock the bucket definitions and thresholds so any later result cannot be accused of p-hacking via threshold tuning (Furia round 6.7 Q2).

---

## Hypotheses

- **H0 (null):** NREKI hybrid Recall@5 in the type-dependent-cross-file subspace (Bucket A) is NOT statistically better than voyage-code-3 Recall@5 in the same subspace.
- **H1 (alt):** NREKI hybrid Recall@5 > voyage-code-3 Recall@5 in Bucket A, with paired-bootstrap CI95% that does not cross zero.

---

## Bucket definitions (operational)

For each PolyBench Verified TS task in the N=100 Sprint 6.6 corpus:

1. Let `G` = `ground_truth.strict_src` (non-test src files modified by the gold patch).
2. If `|G| < 2` → **Bucket C** (single-file / vacuous patch; no cross-file structure to measure).
3. Else, for every unordered pair `(g_i, g_j)` in `G`, compute:
   - `has_type_edge(g_i, g_j)` — see definition below
   - `has_any_import_edge(g_i, g_j)` — file imports anything from the other (type or value)
   - `jaccard(g_i, g_j)` — Jaccard similarity of code-identifier sets

4. Task classified:
   - **Bucket A (type-dependent-cross-file, low lexical overlap):**
     `∃ pair (g_i, g_j) such that has_type_edge(g_i, g_j) AND jaccard(g_i, g_j) < JACCARD_THRESHOLD`
   - **Bucket B (cross-file lexical):**
     not A, but `∃ pair (g_i, g_j) such that has_any_import_edge(g_i, g_j)`
     OR `∃ pair (g_i, g_j) such that jaccard(g_i, g_j) ≥ JACCARD_THRESHOLD`
   - **Bucket C (other):** the remainder.

### Pre-registered constants

- `JACCARD_THRESHOLD = 0.15` (fixed BEFORE any measurement)
- Identifier extraction:
  - Tokenize file content by non-alphanumeric chars (Unicode letters + digits + `_`)
  - Lowercase
  - Split PascalCase and snake_case into subtokens; keep original tokens too
  - Drop tokens of length < 2
  - Drop language keywords (a small fixed list: `const, let, var, function, class, interface, type, enum, import, export, from, as, return, if, else, for, while, do, switch, case, break, continue, default, true, false, null, undefined, new, this, super, extends, implements, typeof, instanceof, in, of, void, async, await, yield, public, private, protected, static, readonly, abstract, declare, namespace, module, any, unknown, never, object, string, number, boolean, bigint, symbol`)
- Identifier-set sizes capped to first 50 000 tokens per file (defensive memory bound on massive bundles)

### Type-edge definition (tsc-INDEPENDENT, no NREKI involvement — Furia Q1 anti-circularity)

A type-edge from file `X` to file `Y` exists if file `X` matches AT LEAST ONE of:

1. **Explicit type-only import:**
   `X` contains `import\s+type\s+\{[^}]+\}\s+from\s+['"]<rel>['"]` resolving to `Y` (relative path resolution via Node.js algorithm: `./`, `../`, suffix `.ts`, `.tsx`, `/index.ts`, `/index.tsx`)
2. **Mixed import with type member:**
   `X` contains `import\s+\{[^}]*\b(type\s+\w+)\b[^}]*\}\s+from\s+['"]<rel>['"]` resolving to `Y` (the inline `type Foo` member syntax)
3. **Value-import of a name declared as a type in Y:**
   `X` contains `import\s+\{[^}]*\b(\w+)\b[^}]*\}\s+from\s+['"]<rel>['"]` AND `Y` contains a top-level declaration `(export\s+(default\s+)?(interface|type|enum)\s+\w+)` matching that name.
4. **Re-export type:**
   `X` contains `export\s+\{[^}]*\}\s+from\s+['"]<rel>['"]` resolving to `Y`, where the re-exported name is a type per rule (3) applied to `Y`.

`has_type_edge(g_i, g_j)` returns `true` if a type-edge exists in either direction.

`has_any_import_edge(g_i, g_j)` returns `true` if any `import ... from '<rel>'` resolves to the other file, type-related or not.

### Path resolution

Relative imports resolved via:
1. If endswith `.ts`/`.tsx`/`.d.ts`/`.js`/`.jsx`: use as-is
2. Else try suffixes `.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx` in that order
3. Else try `<base>/index.ts`, `<base>/index.tsx`, `<base>/index.js`

Absolute / non-relative imports (e.g. `import { Foo } from 'some-pkg'`) are ignored — Bucket A is intra-repo type structure only.

### Why this definition is tsc-independent

The classifier uses ONLY regex over source bytes. No TypeScript compiler API call, no NREKI Type Ledger consultation, no AST parser shared with NREKI. The classifier code lives at `scripts/eval-phase6/sprint67-classify.py`, in a separate module that imports nothing from `src/`. Furia round 6.7 Q1 (circularity) is structurally prevented at the import level.

### Acknowledged false positives / negatives of the heuristic

This is NOT a fully-resolving TS compiler. Known limitations:
- **False negatives:** types used in expression position (e.g., `as Foo`) won't promote a value-import to a type-edge unless `Foo` is declared as a type at top level of the target file. We're conservative — better to under-count Bucket A than over-count.
- **False positives:** a value-only enum that happens to be imported won't be misclassified, but a class with no methods imported only for typeof would be classified as value-import (rule 3 catches classes with `class` keyword, so this is correct).
- **Path resolution:** TypeScript path mappings from `tsconfig.json` are ignored. Repos that use aliased imports for cross-file types (e.g. `@/types/foo`) will have lower Bucket A counts. mui and vscode mostly use relative imports for type-edges, so this should be tolerable; reported as a limitation in the verdict.

---

## Stopping rule and sample-size discipline

- If `|A| < 15` after classification → report "insufficient sample for Bucket A" verdict. Do NOT force H0/H1.
- If `|A| ∈ [15, 30]` → run the comparison but explicitly flag CI width as a limit on certainty.
- If `|A| > 30` → standard report.

Tasks in `voyage-3`'s actual 16-success subset (Sprint 6.6 §2.2) intersected with `A` define `A_voyage`. The Bucket A NREKI-vs-voyage claim must use `A_voyage` only — voyage cannot be claimed against tasks it never ran.

---

## Pre-committed analysis plan

Phase 2 computes, per bucket × retriever:
- Recall@1, @5, @10 — mean and 95% non-paired bootstrap CI (10 000 resamples, seed 42)
- MRR — same
- Paired bootstrap CI95 on the delta `NREKI_hybrid - voyage_3` over `A_voyage` tasks (10 000 resamples, seed 43)
- Token cost p50, latency p50 (for context, NOT in the H0 test)

### 3-rep validation (Sprint 6.6 carry-over)

All ranking is deterministic given the runners' fixed seeds and identical inputs; 3 reps would give identical retrieved_files. The only metric that varies across reps is latency (wall-clock). Since H0 concerns Recall@5, NOT latency, the single-shot retrieved_files from Sprint 4.9 / 6.3 runs are the **definitive ranking data** for H0 testing. The "3 runs, median ± variance" requirement is honored only for latency (Sprint 6.6 §3 noted not done — Sprint 6.7 inherits that disclosure).

### Verdict template (pre-committed)

If H0 is rejected (CI on paired delta lies strictly above 0):
> "NREKI hybrid beats voyage-code-3 Recall@5 by Δ pp [CI95: ...] on type-dependent-cross-file low-lexical-overlap tasks. This subspace is `|A| / 100` = X% of the corpus."

If H0 is NOT rejected:
> "On the type-dependent-cross-file low-lexical-overlap subspace (|A|/100 = X% of corpus), NREKI hybrid does NOT significantly beat voyage-code-3 (paired delta CI95: ...). The Type Ledger does not appear to capture distinguishing retrieval signal under this operationalization."

Both templates include `|A|` adjacent to the claim — never the claim without the niche size.

---

## Pre-registered file paths

- Bucket output: `scripts/eval-phase6/sprint67-buckets.jsonl`
- Per-bucket metrics: `scripts/eval-phase6/sprint67-metrics.json`
- Final report: `docs/sprint-6.7-type-aware.md`

---

**This file is frozen. Any change to thresholds, definitions, or stopping rules after Phase 1 runs invalidates the verdict.**
