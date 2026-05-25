# Sprint 8.0 — Pre-registration (Foveal Neto: AHORRO_NETO)

**Frozen:** 2026-05-21, BEFORE any AHORRO_NETO measurement.
**Principle (Jherson):** the benchmark must be an exam that EVALUATES NREKI, not one we design to pass. If the number favors NREKI by construction, the number does not count.

---

## Hypotheses

- **Q_a (Phase 1 binary, code-verifiable, NO benchmark):** does `tfcCompress` preserve the focus-symbol body at 100% resolution while eliding non-focus bodies?
- **Q_b (Phase 2-3 benchmark, requires agent):** does **AHORRO_NETO** (per-session token savings AFTER subtracting re-expansion turns) remain positive once Secondary Fetch Rate is paid? And how does it compare to the gross 77% Sprint 6.8 claim?

---

## AHORRO_NETO — pre-registered formula (FROZEN, v2 post-Furia Q1)

**Furia Q1 fix:** v1 of this formula counted FULL turn cost (input + output + tool_result) for each re-expansion turn. Furia correctly identified this as unit-inflated: 95% of a turn cost is fixed overhead the agent would pay on the next turn for unrelated reasons anyway. The correct unit is the **incremental delivered payload** — what foveal_on FORCED an additional tool call to deliver that foveal_off would have delivered in the first call.

For each task `t` and arm `a ∈ {foveal_on, foveal_off}`:

```
gross_savings(t)        = tokens_delivered(t, foveal_off)
                          − tokens_delivered(t, foveal_on)

reexpansion_cost(t)     = Σ over every re-expansion turn k where the
                          agent calls a tool to materialize content that
                          appeared in a PRIOR foveal-compressed response,
                          counted ONLY as:

                          tokens_tool_result_k_marginal =
                              tokens_tool_result_k  −
                              tokens_already_delivered_for_same_symbol

                          (The marginal payload: what the second call
                           delivers MINUS what the first call already
                           delivered. If the agent re-expands "foo" and
                           the first call delivered foo's signature only
                           while the second delivers foo's full body, the
                           marginal is `body − signature` in tokens.)

                          We do NOT count the input prompt re-read or
                          assistant output of turn k — those costs are
                          turn-structural, not attributable to foveal.

AHORRO_NETO(t) = gross_savings(t) − reexpansion_cost(t)
```

Then aggregate over the corpus:

```
AHORRO_NETO_mean  = mean(AHORRO_NETO(t)) over completed tasks
AHORRO_NETO_pct   = AHORRO_NETO_mean / mean(tokens_raw_topK(t, foveal_off))
```

CI95% via paired bootstrap on per-task deltas, 10 000 resamples, seed 42.

### foveal_off control — operational definition (Furia Q2 fix)

The pre-registration v1 said `NREKI_FOVEAL_ENABLED=false` without specifying what that path emits. Furia correctly identified this as the largest hole. Pre-registration v2 makes it concrete:

`foveal_off` is implemented by injecting an environment override that causes:

1. **`nreki_navigate action:"search"`** — returns top-K matched chunks each as `rawCode` (full body), NOT `shorthand` (signature). Topology metadata annotations (epicenter / blast radius) stay (they are the moat regardless of compression). No upstream/downstream collapse — every chunk in topology K=1 neighborhood is delivered as rawCode.
2. **`nreki_code action:"compress"`** — bypass `tfcCompress` entirely; return the file content as-is up to a 2 MB ceiling, with NO compression header and NO foveal/parafovea structure.
3. **`nreki_navigate action:"outline"`** — return symbols at full signature + body of every method (no `[BUDGET LIMIT REACHED]` auto-expand heuristic). The agent sees everything in one shot.

**This is the fair control: a vanilla semantic retriever with K-hop neighbor expansion to rawCode.** Implementation: a `FOVEAL_OFF=1` env var gates the compression paths in `compressor-foveal.ts` (bypass at line 109 ALWAYS fires), `handlers/code/edit.ts` (skip tfcCompress invocation), and `handlers/navigate.ts` (force `include_raw=true`).

**Furia Q2 audit deliverable:** before any Phase 3 run, a test verifies that `FOVEAL_OFF=1` produces the above three behaviors. Existing test `tests/sprint80-foveal-epicenter.test.ts` already pins the `FOVEAL_OFF=0` behavior. A symmetric test for `FOVEAL_OFF=1` lands in the same file.

### Silent-damage attribution (Furia Q3 fix)

Pre-registration v1 only counted pass/fail. Furia correctly noted this conflates foveal-caused failures with unrelated failures. Pre-reg v2 partitions task outcomes:

For each task, label the outcome with the joint state (foveal_on_pass, foveal_off_pass):

| Joint state | Label | AHORRO_NETO treatment |
|---|---|---|
| (1, 1) | both pass | normal — include in average |
| (0, 0) | both fail | **foveal-neutral failure** — exclude from AHORRO_NETO average, report separately as "foveal-irrelevant failure rate" |
| (0, 1) | foveal_on fails, foveal_off passes | **silent damage** — count as discrete regression. Report COUNT, do NOT average into delta. |
| (1, 0) | foveal_on passes, foveal_off fails | foveal helped — count as discrete "compression-aided pass". Average IS included. |

The headline metric `AHORRO_NETO_mean` is averaged ONLY over (1,1) tasks. Silent-damage count is reported alongside as `regression_count / N_total`. A protocol that hides regressions inside a token-average is dishonest by construction.

### Anti-construction rules (carried over from v1, still valid)

1. **The comparison is paired:** foveal_on vs foveal_off on the SAME task. We do not compare foveal_on against ripgrep's 146K tokens (which would inflate the savings).
2. **Same agent both arms, same temperature, same system prompt, same model.** The variable is `FOVEAL_OFF=0|1` only.
3. **Symmetric reexpansion measurement:** if `foveal_off` also re-expands (agent might re-read a file it already read), that cost is subtracted symmetrically.

### What success and failure look like

- **AHORRO_NETO_pct > 50%**: foveal is a real session-level win. The 77% gross savings holds NET, ≥65% effective.
- **AHORRO_NETO_pct ∈ [20%, 50%]**: foveal is a moderate win. The 77% claim must be re-scoped to "gross per-call savings, ~30% net per-session".
- **AHORRO_NETO_pct ∈ [0%, 20%]**: foveal barely pays for itself after Secondary Fetch Rate. Claim must be **restricted** to "context-window utilization improvement", NOT "session token savings".
- **AHORRO_NETO_pct < 0%**: foveal is net-negative — Claude pays more in re-expansion than it saves in initial compression. The 77% claim is **REFUTED** at session level. Either fix the compressor (anti-elision rule on epicenters / tier=core neighbors) or amputate.

---

## Secondary Fetch Rate (SFR) — secondary metric

```
SFR(arm) = (# turns where agent re-expanded previously elided content)
           ÷
           (# tasks completed in arm)
```

Pre-registered targets:
- SFR_foveal_on ≤ 0.20: foveal compression is net-positive in practice
- SFR_foveal_on ∈ (0.20, 0.50]: net-positivity depends on the magnitude of re-expansion cost
- SFR_foveal_on > 0.50: foveal forces re-expansion on majority of tasks → compression heuristic is too aggressive, redesign required

---

## Corpus (frozen)

Same as Sprint 6.6 / 6.7 / 6.8: **PolyBench Verified TS N=100**, instances already cached at base_commit in `.eval-phase5-cache/task-workspaces/`. No new corpus, no curation by the experimenter, no cherry-picking. Furia Q5 (corpus appropriateness) is acknowledged: PolyBench may not be the optimal benchmark for foveal stress because patches average 1.7 files and many edits don't need deep body inspection. We MEASURE on PolyBench because that's what we have; we DISCLOSE the corpus limitation in the verdict.

Sub-corpus pre-classification (Furia Q4 fix — split BEFORE the run):
- **Large-file subset:** tasks whose ground_truth files include at least one file with > 300 lines. ~30 of 100 expected.
- **Small-file subset:** the rest. ~70 of 100 expected.

**Headline reporting rule (Furia Q4):** the report MUST publish AHORRO_NETO_pct as TWO numbers (large-file and small-file), never a single weighted average. The TL;DR sentence must contain both — e.g., *"AHORRO_NETO_pct = X% on files >300 LOC (n=N1) and Y% on files ≤300 LOC (n=N2)."* If the small-file subset is negative (foveal overhead), the headline reports the negative number visibly, NOT a positive average that hides it. Publication-quality manipulation by averaging across regimes is forbidden by this rule.

---

## Phase 3 protocol (frozen) — execution requires API key

Per task per arm per rep:
1. Clone task workspace at base_commit (already cached)
2. Spawn a fresh Claude API session
3. Inject system prompt (identical across arms — only `NREKI_FOVEAL_ENABLED` env differs)
4. Agent receives problem_statement
5. Agent uses NREKI MCP tools, including search/outline/compress/batch_edit
6. Capture transcript: every input token, every output token, every tool result token, every turn boundary
7. After agent's final turn:
   - Apply captured diff
   - Run PolyBench test_command in Docker → measure F2P pass + P2P preserved
8. Record: pass/fail, gross_savings(t), reexpansion_cost(t), AHORRO_NETO(t), SFR contribution, total tokens, wall clock

3 reps per (arm, task) cell. Median of pass-indicator (2/3 = pass). All AHORRO_NETO values reported as median ± (max − min) across reps.

---

## Pre-execution sanity gates (frozen, same as Sprint 7.0)

1. ANTHROPIC_API_KEY length ≥ 30
2. node ≥ v18
3. Docker daemon reachable (PolyBench test_command requires Linux + Docker)
4. Task workspaces cached
5. NREKI MCP server reachable via stdio
6. `tests/sprint80-foveal-epicenter.test.ts` passes (Phase 1.2 binary invariants preserved)

If ANY gate fails: Phase 3 = NOT MEASURED. Phase 1-2 still publishable as code-level verification + protocol freeze.

---

## Pre-registered verdict templates

After Phase 3 runs:

**If AHORRO_NETO_pct > 50% AND F2P pass-rate(foveal_on) ≥ F2P pass-rate(foveal_off):**
> "Foveal compression delivers net-positive session-level savings of X% (CI95: ...) without harming Pass@1 (foveal_on F2P = A%, foveal_off F2P = B%, ΔCI: ...). The 77% gross claim from Sprint 6.8 holds NET ≥65% at session level."

**If AHORRO_NETO_pct ∈ [0%, 50%]:**
> "Foveal compression is moderately net-positive: AHORRO_NETO = X% (CI: ...), SFR = Y. The 77% gross headline does not hold net; the defensible session-level claim is X%."

**If AHORRO_NETO_pct < 0%:**
> "Foveal compression is net-negative once re-expansion is counted. The 77% gross headline is misleading at session level. Required action: (a) fix the compressor with the anti-elision rule for tier=core neighbors before claiming any session-level savings, or (b) restrict the claim to context-window utilization, not token savings."

**If Phase 3 = NOT MEASURED:**
> "Phase 1 binary verification: pass (focus body preserved, non-focus elided, code-tested). Phase 2-3 AHORRO_NETO untested due to sanity-gate failure (specific gates listed). The 77% gross claim from Sprint 6.8 stands; the NET claim is pending Sprint 8.0.1 execution."

---

## Pre-registered file paths

- Sanity gate (reused): `scripts/eval-phase7/sprint70-sanity-gate.ts`
- Harness driver: `scripts/eval-phase8/sprint80-driver.ts`
- Per-task results: `scripts/eval-phase8/sprint80-results.jsonl`
- Verdict: `docs/sprint-8.0-foveal-neto.md`
- Phase 1.2 tests: `tests/sprint80-foveal-epicenter.test.ts` (already committed)

**This file is frozen. Any post-hoc modification to the AHORRO_NETO formula, SFR thresholds, corpus selection, or verdict templates invalidates the result.**
