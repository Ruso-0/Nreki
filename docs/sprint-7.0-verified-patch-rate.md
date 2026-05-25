# Sprint 7.0 — Verified-Patch Rate (Edit-Safety prueba de fuego)

**Date:** 2026-05-21
**Status:** Internal measurement. NOT for publish.
**Pre-registration:** [scripts/eval-phase7/sprint70-prereg.md](../scripts/eval-phase7/sprint70-prereg.md) (frozen BEFORE any number generated).
**Verdict slot:** **NOT MEASURED.** H0 not tested. See §5.

---

## TL;DR — Where Sprint 7.0 stands

The Sprint 7.0 protocol asks the right question — *does NREKI Edit-Safety raise the agent's Pass@1 over Aider raw-edit?* — and pre-registered the binary, falsifiable test BEFORE any experiment ran. The protocol is frozen. The execution harness is committed. **Execution itself did not run** because three pre-registered HARD sanity gates fail (Docker missing, ANTHROPIC_API_KEY missing, OPENAI_API_KEY missing). Per the pre-registration rule, we did not invent numbers.

Furia's adversarial review of the FROZEN protocol then identified five mandatory revisions that must land BEFORE first execution (§4). None of these are post-hoc bias defenses — they are pre-execution methodological gaps. They will be incorporated into **Sprint 7.0.1 (amended pre-registration)** and the experiment will then proceed.

**Honest one-liner:** *"The edit-safety claim cannot be evaluated from Sprint 7.0 because the experiment did not run. The protocol is frozen and committed; revisions identified by Furia pre-review must land before Sprint 7.0.1 executes. NREKI's titanato remains UNTESTED."*

---

## Phase 1 — Pre-registration (frozen)

The pre-registration ([scripts/eval-phase7/sprint70-prereg.md](../scripts/eval-phase7/sprint70-prereg.md)) locks:

- **H0/H1:** binary, paired bootstrap CI95% on `(NREKI_pass - Aider_pass)` decides
- **Corpus:** 50 of 100 PolyBench Verified TS instances, deterministic even-index lexicographic subset (35 mui, 11 vscode, 4 small repos). All workspaces already cached at base_commit.
- **Pass@1 (v1):** diff applies clean AND F2P passes AND P2P preserved AND tsc delta-zero. [**Furia Q2 forces revision** — see §4]
- **Timeouts:** 600s per attempt, 2100s task cap.
- **LLM:** claude-sonnet-4-6, temp=0, identical system prompt across arms.
- **Arms:** A (Aider raw), B (Claude + NREKI MCP), C optional (Claude + bare Write/Edit).
- **3-rep validation:** median pass-indicator + variance band.
- **Sanity gates:** 6 pre-execution checks. Refuses to run on any HARD failure.

The pre-registration was committed before any experiment configuration, any LLM call, or any test execution. Modifications after this point require an amended Sprint 7.0.1 pre-registration with explicit justification.

---

## Phase 2 — Harness (committed, scaffold-validated)

Committed scaffold files:

| File | Role | Status |
|---|---|---|
| [sprint70-sanity-gate.ts](../scripts/eval-phase7/sprint70-sanity-gate.ts) | 6-gate pre-execution check | **Working** (refuses to proceed on HARD fail) |
| [sprint70-driver.ts](../scripts/eval-phase7/sprint70-driver.ts) | Phase 2 orchestrator, resume-safe JSONL output | **Working in --dry-run** (scaffold validated) |
| [sprint70-arm-a-body.ts](../scripts/eval-phase7/sprint70-arm-a-body.ts) | Arm A subprocess body (Aider invocation) | **SCAFFOLD ONLY** — agent loop + test execution NOT implemented |
| [sprint70-arm-b-body.ts](../scripts/eval-phase7/sprint70-arm-b-body.ts) | Arm B subprocess body (Claude+NREKI MCP) | **SCAFFOLD ONLY** — Anthropic SDK + MCP bridge NOT implemented |

The driver dry-run on `--n 5 --reps 1` was executed successfully — it loads tasks, forks subprocesses, captures structured cell results, and writes the JSONL. The arm-body implementations of `runArmA` / `runArmB` are commented sketches; turning them on requires:
- `pnpm add @anthropic-ai/sdk` (or equivalent) — not currently in package.json
- An MCP stdio bridge implementation for nreki_code/nreki_guard/nreki_navigate tool dispatch
- A Docker-based or Linux-native test execution path for PolyBench Dockerfiles

### Sanity-gate output (verbatim, 2026-05-21)

```
Sprint 7.0 sanity gates:
  [PASS] aider --version present — aider 0.86.2
  [PASS] node ≥ v18 — v24.12.0
  [FAIL (HARD)] docker daemon reachable — spawnSync docker ENOENT
  [FAIL (HARD)] ANTHROPIC_API_KEY ≥ 30 chars — len=0
  [FAIL (HARD)] OPENAI_API_KEY ≥ 30 chars (Aider import requirement) — len=0
  [PASS] task workspaces cached — 100 task dirs present (need ≥50)

3/6 gates passed; 3 HARD blockers.
→ Phase 2 BLOCKED. Do not invent numbers. Verdict slot = NOT MEASURED.
```

This is the honest output of the pre-registered protocol. No Pass@1 number is offered.

---

## Phase 3 — Metrics (would have been)

Per pre-registration §"Primary metric" and §"Secondary metrics":

- **Primary:** Pass@1 per arm, paired bootstrap CI95% on the delta (B − A). 10 000 resamples, seed 42.
- **Secondary:** timeout_rate, doom_loop_rate, edit_rejection_to_correction_rate (NREKI only — Furia Q4 forces revision), tokens_per_resolved_bug (edit-side TPCH), wall_clock_per_task p50/p95.

No metric values can be reported because no cell ran. The aggregation script ([sprint70-driver.ts](../scripts/eval-phase7/sprint70-driver.ts) loads + summarizes JSONL) will produce the table when Sprint 7.0.1 executes.

---

## Phase 4 — Furia adversarial pre-review (no numbers required)

Because no results exist, Furia attacked the PROTOCOL itself. All five critiques are accepted as **mandatory revisions before Sprint 7.0.1 executes**.

### Q1 — Aider baseline is underspecified

> **Furia:** Your prereg locks `--architect false --no-stream --yes --auto-commits false` but is SILENT on the four flags that actually determine Aider's behavior on real repos:
>
> - `--map-tokens` (default 1024): on mui/vscode this truncates the repo-map aggressively. A user tuning Aider for vscode would set 4096-8192.
> - `--max-chat-history-tokens`: unbounded by default → Aider WILL hit Sonnet's 200K context and silently drop oldest messages mid-task.
> - `--read` / read-only context files: zero specified. Aider users routinely pin `package.json` + `tsconfig.json`.
> - `--edit-format`: default is `diff` for Sonnet, but `udiff` has measurably higher apply-success on TS.
>
> Either pin all four AND justify the values against Aider's published benchmark configs, or add Arm A' = "Aider + community-recommended TS config" so the comparison isn't a strawman.

**Accepted.** Sprint 7.0.1 pre-registration MUST:
- Pin `--map-tokens 4096`, `--max-chat-history-tokens 80000` (40% of Sonnet's 200K, leaves headroom), `--edit-format udiff`, `--read package.json,tsconfig.json` per task.
- Add Arm A' (community-tuned) if N permits, or fold the tuned config INTO Arm A and document Arm A is "community-config Aider", not "vanilla Aider".

### Q2 — Pass@1 is structurally tilted (THE DAMAGING ONE)

> **Furia:** You're scoring Aider 0 on tasks where its patch made the test green. That measures "did the arm have an edit-safety layer," not "did the arm fix the bug." Required change: **primary metric = F2P-pass-only; tsc-delta-zero and P2P-preservation become secondary REGRESSION-RATE metrics reported alongside.** Otherwise H1 is tautological — you defined Pass@1 to require the thing you're measuring.

**Accepted, this is the most important revision.** Sprint 7.0.1 pre-registration MUST redefine:
- **Primary Pass@1 = F2P passes within timeout.** No tsc check, no P2P check.
- **Secondary:** tsc_regression_rate (tsc new-errors / total tasks), p2p_regression_rate (P2P breakage / total tasks). Reported alongside the primary but NOT bundled into the headline.
- The H1 test runs against the redefined Pass@1. The mechanism question ("does the safety layer help") is then tested separately by the regression rates and the symmetric self-correction counters.

### Q3 — Compute budget unbounded; mandatory pilot

> **Furia:** vscode tasks at 600s × timeout-on-first-attempt × 3 reps × 2 arms = single task can burn 1hr and 200K tokens. One bad cluster of 5 vscode tasks = $300 extra. Add: pilot N=10, 1 rep, decision gate on (cost, timeout-rate, parse-fail-rate) before authorizing full N=50 × 3.

**Accepted.** Sprint 7.0.1 pre-registration MUST insert a **Pilot Phase 2a** between sanity-gate and full execution:
- N=10 (first 10 even-index tasks), 1 rep per arm
- Decision gate: total cost ≤ $X (X to be pinned), timeout_rate ≤ 30%, parse-fail-rate ≤ 20%
- If pilot fails the gate, abort and report what failed; do NOT proceed to N=50 × 3.

### Q4 — Self-correction measurement is asymmetric

> **Furia:** `edits_rejected_then_corrected` is a NREKI-only counter. Aider's equivalent signal — tool/test error in transcript followed by a successful retry of the same intent — is unlogged. You will be unable to claim "edit-safety drove the delta" because you didn't measure the baseline self-correction rate.

**Accepted.** Sprint 7.0.1 pre-registration MUST define:
- `self_correction_event(arm, task, rep)` = an assistant turn N+1 that retries the failed sub-goal of turn N where turn N's tool result contained an error / non-pass marker.
- Logged symmetrically for both arms. Arm A counts these from Aider's transcript (parsed for "I'll try..."-style retries after a parse/test failure). Arm B counts these from the ChatCompletion turn stream.
- Reported as a secondary metric. Without this, the mechanism claim ("the shield caused +N corrections") is unfalsifiable.

### Q5 — Power analysis missing; N=50 likely under-powered for headline

> **Furia:** PolyBench TS is 77% Bug Fix, but the tsc-detectable subset is likely 25-40% of bugs. At 30% prevalence the mechanism fires on ~15 of 50 tasks. A real 15pp effect on the relevant subset dilutes to 4.5pp headline — below paired-bootstrap CI95 detectability at N=50 (need ~7-8pp for separation from zero).

**Accepted.** Sprint 7.0.1 pre-registration MUST:
- Pre-classify each task by a STATIC HEURISTIC on the golden patch (e.g., "patch introduces a type annotation change" / "patch fixes a null-undefined check" / "patch fixes runtime logic"). This sub-classification happens BEFORE the experiment runs (frozen at pre-reg time).
- Pre-register a **sub-analysis on the tsc-detectable subset**. The headline at N=50 is then exploratory; the confirmatory test is on the tsc-relevant subset.
- Acknowledge: if the prevalence is < 30%, the effective N for mechanism testing is < 15 and the experiment must scale up (N=100 or a different corpus where tsc-detectable bugs are over-represented).

---

## Phase 5 — Verdict

### 5.1 H0 status

**H0 is NOT tested.** Sprint 7.0 produced zero per-task data because all three HARD sanity gates failed at the pre-execution check (Docker missing, ANTHROPIC_API_KEY missing, OPENAI_API_KEY missing). The pre-registration rule explicitly forbade fabricating numbers in this scenario, and we honored that.

### 5.2 Does the Edit-Safety shield work?

**UNKNOWN.** The question remains open. NREKI's tectonic Edit-Safety machinery (`batchSemanticEdit` ACID atomicity, `AstSandbox` tree-sitter validation, TTRD type-dependency feedback) exists and is unit-tested at the code level (`src/handlers/code/edit.ts`, `src/ast-sandbox.ts`, `src/semantic-edit.ts`). What is not known is whether it raises the agent's Pass@1 in a controlled comparison against raw editing. That measurement is the Sprint 7.0.1 deliverable.

### 5.3 Phase 7 path forward

The trajectory across Sprints 6.6 / 6.7 / 6.8 is:

- **6.6:** NREKI loses retrieval recall by ~28pp vs voyage-code-3 dense embedding.
- **6.7:** The type-aware retrieval niche, as operationalized, contains 1% of PolyBench TS tasks. Hypothesis untestable on this corpus.
- **6.8:** NREKI's token-economics claim is RESTRICTED — wins 10-125× over lexical baselines, loses 1.5-2.1× vs voyage. Foveal compression is real (77.3% vs raw top-K).
- **7.0:** Edit-safety claim is the LAST remaining differentiator after recall + niche + token-economics are closed or restricted. **It must execute** — either it confirms NREKI's value-add and Phase 7 (production deployment, Nova thaw) proceeds, or it refutes the value-add and Phase 7 is fundamentally re-scoped.

The harness is ready. The pre-registration is frozen. Furia has stress-tested the protocol design ahead of any data. The next concrete action is operator-only:

1. **Resolve sanity gates:** install Docker (or commission a Linux VM with Docker), populate `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from a real billing source.
2. **Amend pre-registration to Sprint 7.0.1** with the 5 Furia revisions incorporated. Re-freeze.
3. **Run pilot N=10, 1 rep**. Gate decision on cost / timeout / parse-fail.
4. If pilot passes, **run full N=50 × 3 reps** per the amended protocol.
5. Aggregate, paired bootstrap, write the verdict against Sprint 7.0.1 pre-reg verdict templates.

Estimated cost for full execution (pilot + 50×3): ~$300-700 in Anthropic API + 50-150 hours wall clock (heavily front-loaded on Docker setup for vscode tasks). Estimated calendar time with proper engineering: 1-2 weeks.

### 5.4 Recommendation

**Phase 7 does NOT proceed on a published "NREKI Edit-Safety raises Pass@1" claim from Sprint 7.0 data, because no Sprint 7.0 data exists.** Phase 7 product decisions (deployment, Nova thaw) should wait on Sprint 7.0.1's actual numbers.

In the meantime, the public messaging adjustments from Sprints 6.6 / 6.8 stand:
- **Retired:** "better retrieval than Claude Context" (6.6)
- **Retired:** "type-aware retrieval niche" until corpus exists (6.7)
- **Restricted:** "token economics" to "vs lexical baselines" only (6.8)
- **PENDING:** "Edit-safety raises agent Pass@1" — explicitly untested. Do NOT publish this claim.

### 5.5 Unexpected finding (honest)

The most striking finding of Sprint 7.0 is that **Furia's adversarial review of the protocol — done BEFORE any experiment ran — caught five methodological flaws that would have invalidated the verdict had the experiment proceeded as pre-registered v1**. In particular Q2 ("Pass@1 is tautological") was a self-inflicted flaw I (the author) committed in the pre-reg without spotting. Without the adversarial pre-review, a tautological Pass@1 would have produced a publishable-looking but methodologically dead result.

This generalizes: the value of adversarial pre-review on a frozen protocol is HIGH and CHEAP. Sprints 7.x should incorporate Furia-on-protocol as a standard gate before any executor runs. The cost is one agent invocation; the saved cost is potentially the entire experiment's budget.

---

## Artifacts

- Pre-registration v1 (frozen): [scripts/eval-phase7/sprint70-prereg.md](../scripts/eval-phase7/sprint70-prereg.md)
- Sanity-gate: [scripts/eval-phase7/sprint70-sanity-gate.ts](../scripts/eval-phase7/sprint70-sanity-gate.ts)
- Sanity-gate output (2026-05-21): [scripts/eval-phase7/sprint70-sanity-gate.json](../scripts/eval-phase7/sprint70-sanity-gate.json)
- Driver: [scripts/eval-phase7/sprint70-driver.ts](../scripts/eval-phase7/sprint70-driver.ts)
- Arm A body (scaffold): [scripts/eval-phase7/sprint70-arm-a-body.ts](../scripts/eval-phase7/sprint70-arm-a-body.ts)
- Arm B body (scaffold): [scripts/eval-phase7/sprint70-arm-b-body.ts](../scripts/eval-phase7/sprint70-arm-b-body.ts)
- Dry-run validation output: [scripts/eval-phase7/sprint70-results.jsonl](../scripts/eval-phase7/sprint70-results.jsonl)
- Reproducibility:
  ```
  npx tsx scripts/eval-phase7/sprint70-sanity-gate.ts
  npx tsx scripts/eval-phase7/sprint70-driver.ts --dry-run --n 5 --reps 1
  # Once API keys + Docker land + Sprint 7.0.1 pre-reg is committed:
  npx tsx scripts/eval-phase7/sprint70-driver.ts --n 50 --reps 3
  ```

---

**Verdict status: NOT MEASURED. Sprint 7.0.1 mandatory next step. Phase 7 deployment decisions deferred until Sprint 7.0.1 produces real Pass@1 numbers under the Furia-revised protocol.**
