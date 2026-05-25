# Sprint 7.0 — Pre-registration (Verified-Patch Rate)

**Frozen:** 2026-05-21, BEFORE any Pass@1 measurement.
**Purpose:** Lock the protocol so the verdict cannot be accused of post-hoc tuning of corpus, definitions, or thresholds.

---

## Hypotheses (binary)

- **H0 (null):** NREKI Edit-Safety (`mcp__nreki__nreki_code` batch_edit + ACID validation + ast-sandbox + TTRD shields) does NOT improve Pass@1 vs raw editing. The validation overhead has no net agentic benefit.
- **H1 (alt):** Claude + NREKI Edit-Safety resolves more PolyBench Verified TS bugs at Pass@1 than Claude + Aider (raw edit), with paired bootstrap CI95% that does not cross zero.

**Decision rule (frozen):**
- CI95% on paired delta `(NREKI_pass − Aider_pass)` strictly > 0 → **reject H0**
- CI95% strictly < 0 → **accept H0 with reversal** (NREKI hurts)
- CI95% crosses 0 → **NOT CONCLUSIVE** (report and document N requirement to resolve)

---

## Mechanism under test

NREKI Edit-Safety intercepts an attempted edit BEFORE disk write via:

1. `batchSemanticEdit` (src/semantic-edit.ts:426) — ACID-atomic batch: all-or-nothing apply, full rollback on any sub-edit failure
2. `AstSandbox.validate` (src/ast-sandbox.ts) — tree-sitter parse of the proposed code, rejects on `ERROR`/`MISSING` nodes with line/column + fix suggestion
3. TTRD (Type / Test / Reverse-Dependency) feedback (src/handlers/code/edit.ts:272, :559) — exposes downstream callers / type breaks BEFORE the agent's next decision
4. Kernel ts-compiler-wrapper (src/kernel/backends/ts-compiler-wrapper.ts) — in-process tsc against the edited file's project, returns diagnostics structured for the agent

The hypothesis is that surfacing compile/type errors as **structured feedback in the same turn** lets the agent self-correct, while raw edit (Aider) writes broken code to disk, runs tests, sees a runtime failure, and re-edits — burning more turns / hitting more timeouts.

---

## Corpus (frozen)

**Source:** [AmazonScience/SWE-PolyBench_Verified](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified) (arXiv:2504.08703, MIT). Same instance set used in Sprint 6.6 (`results-c4b-full.json`) — SHAs already cloned at base_commit in `.eval-phase5-cache/task-workspaces/`.

**Subset selection (frozen pre-execution):**

Of the 100 TS instances, the Sprint 7.0 evaluation requires running `test_command` post-patch. PolyBench Verified TS test_commands are mostly:
- `yarn compile ; xvfb-run --auto-servernum ... ./scripts/test.sh --run <test_file>` (vscode, 23 tasks)
- `yarn test:browser <pattern>` (mui, 70 tasks)
- repo-specific shell-on-Linux scripts (others)

**Execution requires Linux + Docker** because PolyBench ships per-instance Dockerfiles that resolve the build/test environment. Native Windows execution of the test step is NOT supported by the corpus.

**Pre-registered subset for Sprint 7.0 first execution:**

- **N=50** from the N=100 TS instances, drawn deterministically by lexicographic sort of `instance_id`, indices `[0, 2, 4, ..., 98]` (every other task) → balances per-repo coverage at the 100-corpus weighting (35 mui, 11.5 vscode, 1.5 each of small repos).
- Minimum acceptable N for verdict (Furia 6.7 lesson): N=40. If 10+ tasks fail to set up via Docker, report on what completed; if <40 complete, verdict is **NOT CONCLUSIVE** by stopping rule.

**Per-task data already on disk:** [results-c4b-full.json](../../results-c4b-full.json) carries `instance_id`, `repo`, `base_commit`, `task_category`, full `patch`, `test_patch`, `test_command`, `F2P`, `P2P`, `modified_nodes`. Each task workspace is checked out at `base_commit` in `.eval-phase5-cache/task-workspaces/task-<repo>-pr<num>/`.

---

## Operational definitions (frozen)

### "Verified Patch" (Pass@1 criterion, binary)

A patch passes IFF **all four** of the following are true:

1. **Applies clean:** the agent-generated diff applies to the base_commit workspace with no merge conflict / no `*.rej` files
2. **F2P pass:** all tests in PolyBench's `F2P` (Fail-to-Pass) list now pass with the agent's patch
3. **P2P preserve:** all tests in PolyBench's `P2P` (Pass-to-Pass) list still pass with the agent's patch (anti-regression)
4. **tsc clean:** `tsc --noEmit` over the patched project completes with no errors that were not present at base_commit (delta-zero check on type errors; pre-existing errors that the patch didn't touch are excluded)

Pass@1 = 1 single agentic attempt per task per arm. No re-tries between attempts. Within a single attempt the agent may issue multiple edit/test cycles up to the timeout.

### "Pass" timeout (frozen)

Per-task agent timeout: **600 s wall clock** (Sprint 6.6 Furia Q3 lesson: 120 s aider timeout was survivorship-biased; 600 s gives the agent meaningful loop room).
Per-task test_command timeout: **900 s** (vscode `yarn compile` alone can hit 5-8 min on cold cache).
Per-task total wall clock cap: **2 100 s** (35 min) including setup. Tasks that exceed cap → recorded as `timeout`, counted as `pass = 0`.

### LLM agent (frozen)

- **Model:** `claude-sonnet-4-6` (the most cost-effective production-quality model at sprint date; explicit pin so future API churn doesn't change the comparator).
- **Temperature:** 0.0 (deterministic per run; 3-rep variance under fixed seed should be near zero for the LLM itself, isolating tool-driven variance).
- **System prompt:** identical across arms (text below). The ONLY variable is the edit tool. Sample system prompt:

  ```
  You are a developer fixing a bug in a TypeScript repository. You will see
  the problem statement, a list of files you can inspect, and ONE editing tool
  available to you. Your goal: apply a minimal patch that makes the failing
  tests pass without breaking other tests. Stop when you have committed the
  fix. Do NOT explain — call the tool and exit.
  ```

- **Token budget per attempt:** 100 000 output tokens (defensive cap; typical attempts close at 5-15K).

---

## Arms (frozen)

### Arm A — Claude + Aider (raw edit baseline)

- Aider invoked with `--model claude-sonnet-4-6 --architect false --no-stream --yes --auto-commits false`
- Aider's standard SEARCH/REPLACE block edit mode
- Aider sees the problem statement as the initial user message
- Aider can read any file in the workspace at will
- No external tools (no MCP, no NREKI)
- Wall-clock measurement starts when aider receives the prompt, ends when aider exits or 600 s timeout fires

### Arm B — Claude + NREKI Edit-Safety

- Claude API directly (no aider wrapper) with the same system prompt
- Tools available: `mcp__nreki__nreki_code` (batch_edit + edit), `mcp__nreki__nreki_guard` (ast-sandbox + TTRD), `mcp__nreki__nreki_navigate` (search)
- The MCP server is `nreki` (already registered in this project's MCP config; if absent, Arm B is NOT RUN, not faked)
- Same prompt, same wall-clock measurement

### Arm C (OPTIONAL) — Claude + bare Write/Edit (control)

- Claude API with ONLY `Write` and `str_replace_based_edit_tool` (the most minimal edit primitives, no safety, no validation)
- Tests whether NREKI's gains come from the safety layer vs from any-edit-tool-at-all
- Run if Arms A and B complete within budget; otherwise marked NOT MEASURED

---

## Primary metric (frozen)

**Pass@1 per arm, paired bootstrap CI95% on the delta.**

Paired bootstrap (per-task delta `nreki_pass - aider_pass ∈ {-1, 0, +1}`), 10 000 resamples, seed 42.

---

## Secondary metrics (frozen)

- `timeout_rate_per_arm`
- `doom_loop_rate`: tasks where the agent issued ≥5 consecutive edits that compile-or-test-failed without an intervening successful change
- `edit_rejection_to_correction_rate` (NREKI arm only): when ast-sandbox or TTRD rejected an edit, did the agent's next turn correct it? Direct mechanism evidence
- `tokens_per_resolved_bug` (the edit-side TPCH, distinct from Sprint 6.8's retrieval TPCH):
  `TPCH_edit = Σ_t total_LLM_tokens(t, arm) / Σ_t pass_indicator(t, arm)`
- `wall_clock_per_task_p50, p95`

---

## 3-rep validation (frozen)

Each `(arm, task)` cell runs **3 independent attempts**. Report median pass-indicator (so a `2/3 pass` cell counts as pass; `1/3 pass` counts as fail). Variance reported alongside as `(min, max)` over 3 reps.

If the per-task Pass@1 is unstable (≥10% of tasks show `1/3` or `2/3` rather than `0/3`/`3/3`), the report flags determinism failure and recommends higher N.

OOM safety: each `(arm, task, rep)` runs in a `child_process.fork()` subprocess (regla hierro WASM, Sprint 4.9). The parent collects results via IPC.

---

## Pre-execution sanity gates (frozen)

Before Phase 2 runs:
1. `aider --version` returns non-error
2. `node --version` ≥ v18
3. Docker daemon reachable (or non-Docker test execution path explicitly chosen per task)
4. `ANTHROPIC_API_KEY` present and ≥ 30 chars
5. `OPENAI_API_KEY` present and ≥ 30 chars (Aider's model selection layer needs an LLM credential — even when targeting Claude via `--model claude-...`, Aider's libraries probe other providers at import)
6. `.eval-phase5-cache/task-workspaces/` contains the 50 selected task workspaces

If ANY gate fails: do not invent numbers. Report the gate failure as a blocker, freeze the protocol, write `NOT MEASURED` in the verdict slot. **This is enforced.**

---

## Pre-registered verdict templates (frozen)

If H0 rejected (paired CI on delta strictly > 0):
> "NREKI Edit-Safety raises Pass@1 by Δ pp [CI95: ...] over Aider on PolyBench Verified TS (N=...). The edit-safety claim is **CONFIRMED**. The mechanism is empirically supported by an `edit_rejection_to_correction_rate` of X% (Y/Z rejected edits the agent then corrected)."

If H0 not rejected and reversed (paired CI strictly < 0):
> "NREKI Edit-Safety LOWERS Pass@1 by Δ pp [CI95: ...] vs Aider. The edit-safety claim is **REFUTED**. Phase 7 must be re-scoped or retired."

If NOT CONCLUSIVE:
> "Paired delta CI crosses zero (delta = X [low, high]). With N=Y the experiment cannot distinguish a true effect from noise. Sprint 7.1 requires N≥Z to resolve, where Z is computed from the observed sample variance."

If NOT MEASURED:
> "Sprint 7.0 protocol frozen and harness committed. Execution blocked by [list of sanity gates that failed]. The H0 question is NOT YET TESTED. No claim about Edit-Safety can be made from this Sprint."

---

## Pre-registered file paths

- Harness: `scripts/eval-phase7/sprint70-driver.ts`
- Per-task subprocess body: `scripts/eval-phase7/sprint70-task-body.ts`
- Aider runner shim: `scripts/eval-phase7/sprint70-aider-arm.ts`
- NREKI runner shim: `scripts/eval-phase7/sprint70-nreki-arm.ts`
- Per-task JSONL results: `scripts/eval-phase7/sprint70-results.jsonl`
- Aggregate metrics: `scripts/eval-phase7/sprint70-metrics.json`
- Verdict: `docs/sprint-7.0-verified-patch-rate.md`

**This file is frozen. Any post-hoc modification to corpus selection, Pass@1 definition, timeouts, model, sanity gates, or verdict templates invalidates the result.**
