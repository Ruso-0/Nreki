# Sprint 8.0 Phase 2 — OFFLINE pilot (Furia Q5 mandated)

**Scope:** offline tokenization-only measurement of `gross_savings(t)` over a stride-3 sample of PolyBench Verified TS (N=33). NO API calls, NO Docker, NO agent loop.

**Method:** for each task, locate the largest GT file at base_commit. Pick the first `export function|class|const|interface|type|enum` symbol as focus. Call `tfcCompress(file, content, focus, engine, {maxCrossFile:0})`. Count tokens with tiktoken `cl100k_base` (real BPE).

**What this is NOT:** AHORRO_NETO. Re-expansion cost is not measurable offline. This pilot bounds the CEILING of AHORRO_NETO.

## Headline (Furia Q4: two-bucket split, never averaged)

### Large-file subset (>300 LOC) (N = 20)

- successful compressions: 17
- density-shield tripped: 0  (TFC fell back to legacy, no usable foveal output)
- focus not found in file: 0
- pilot skipped (no engine / no export): 3

- gross_savings_pct global (Σtokens-weighted): 91.8%
- gross_savings_pct per-task median: 82.1%
- gross_savings_pct per-task mean: 83.6%
- gross_savings_pct p10 / p90: 67.1% / 99.1%

### Small-file subset (≤300 LOC) (N = 14)

- successful compressions: 13
- density-shield tripped: 0  (TFC fell back to legacy, no usable foveal output)
- focus not found in file: 0
- pilot skipped (no engine / no export): 1

- gross_savings_pct global (Σtokens-weighted): 67.6%
- gross_savings_pct per-task median: 64.0%
- gross_savings_pct per-task mean: 59.8%
- gross_savings_pct p10 / p90: 0.0% / 85.4%

## Honest interpretation

- These numbers are the GROSS upper bound on AHORRO_NETO. Re-expansion costs only subtract from here, they cannot add.
- The Sprint 6.8 headline (77% global, 78.5% per-task median) was measured against NREKI's own top-K AST chunks. This pilot measures against the FULL FILE the agent would otherwise read raw — a different (typically stricter) baseline.
- If the small-file subset shows negative gross_savings, that means tfcCompress's 100-line bypass is correct: those files are NOT compressed and savings are zero by design. A negative number indicates header overhead vs raw, which would mean the bypass is firing AT THE WRONG threshold.
- The `density_shield_tripped` count is non-zero indicator that on those tasks, foveal compression FAILED to beat 15% improvement and the compressor returned `shield_tripped` (no compression delivered). Production handlers fall back to legacy aggressive in that case, which IS lossy compression but NOT measured here.

## What remains for Sprint 8.0.1 (NOT measurable here)

1. `reexpansion_cost(t)` — needs real agent. Requires ANTHROPIC_API_KEY ≥ 30 chars.
2. Silent-damage attribution — needs both arms run on same task with PolyBench test_command. Requires Docker.
3. F2P pass-rate comparison (foveal_on vs foveal_off) — same blockers.
4. Bootstrap CI95 on AHORRO_NETO — needs the above to be measured first.

## Raw data

- per-task rows: `scripts/eval-phase8/sprint80-offline-pilot.jsonl` (N=34)
- methodology: this file's preamble + sprint80-prereg.md
- tokenizer: tiktoken cl100k_base (offline BPE, no network)
