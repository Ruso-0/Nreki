# Furia Adversarial Review — `SYMBOL_REPLACE_LIMIT`

**Sprint:** v11.3.1
**Role:** Pipipi Furia (adversarial), feeding Pipipi Code (decision)
**Inputs:** [threshold-empirical-analysis.md](threshold-empirical-analysis.md), git history, [src/semantic-edit.ts](../src/semantic-edit.ts)
**Posture:** Hostile to silent magic numbers. Hostile to "looks safe" without data.

---

## Q1 — Was the 40 L threshold arbitrary or evidence-based?

**Finding: arbitrary.**

Origin commit: `3661c31` (NREKI v9.1, 2026-04-13). Comment in code reads `// ─── LEY 4: GUILLOTINA DE OUTPUT ───`. The commit message describes the *feature* ("CognitiveEnforcer + CLI Hook + Banner Purification") but contains **no measurement, no citation, no rationale** for the specific value 40. No follow-up commit in the history adjusts it based on telemetry.

The number was chosen by intuition. It has been load-bearing in user-facing error messages for 13 months without an empirical check until today's Phase 1.

**Verdict:** Magic number. Replacing it is not "changing a tuned parameter," it's "replacing a guess with a measurement."

---

## Q2 — At threshold 100 L, what concrete new risk appears?

**Furia attack vector:** "A larger allowed `replace` payload means an agent can wipe a larger blast radius in one operation. That is strictly more dangerous than the 40 L cap."

**Counter-evidence from NREKI's own defense-in-depth:**

| Failure mode for a 50–100 L `replace` | Existing gate that catches it |
|---|---|
| Syntactically broken replacement | AST splice + post-splice tree-sitter reparse → reject |
| Type regression in replaced code | Kernel TS validation (Layer 2) before disk write |
| `// eslint-disable`, `@ts-ignore`, `# noqa` smuggled in | Anti-Sweep Shield (`semantic-edit.ts:715-720`) |
| `any` / `unknown` regression | TTRD (Type Token Regression Detector) |
| Renamed symbol breaks callers | Cross-file blast radius / signature diff |
| Architectural bridge mutation | Fiedler bridge guard |
| Repeated failed attempts | Chronos friction CFI (penalty + escalation) |
| Bad write commits, user wants rollback | Auto-backup pre-commit |
| Mid-batch failure leaves partial state | ACID transactional batch (full rollback) |
| Race with concurrent process | File lock mutex |
| Stale graph state after edit | Topology cache invalidate ticket |

**That is 11 gates. The line-count threshold is one of them, and the *only* one that fires on size alone — not on a defect, not on a smell, just on size.**

The remaining 10 gates are *defect-detecting*. Removing the size-only gate, or raising it from 40 → 100, does not weaken any defect-detection gate. The empirical question is whether *defect-free* replacements of 41–100 L cause harm; the only mechanism by which they could is **agent overconfidence** (touching too much in one go), which is a *behavioral* concern, not a *correctness* concern, and is better addressed by Chronos friction (which already penalizes repeated failure) than by a static cap.

**Verdict:** Raising 40 → 100 expands one gate's tolerance band by 2.5× while leaving 10 orthogonal gates unchanged. No new failure mode is created.

---

## Q3 — Ratio (% of file) instead of absolute?

**Proposal:** Block when `symbolLines / fileLines > 0.30` (or similar).

**Furia attack vector for ratio:**
- A 40 L symbol in a 50 L file is 80% — flagged. Same symbol in a 1000 L file is 4% — passes. **Identical change, different verdict.** That's not "context-aware," that's "punishes small files."
- Adversarial agents can pad a file with trivia to lower the ratio and bypass the gate.
- LLMs reasoning about whether to use `replace` or `patch` must now also reason about file size. Currently: "if symbol ≤ N L, replace is OK." Future: "if symbol is ≤ N% of the file, and the file is at least M L, then…" — strictly more cognitive load with no measured benefit.
- Codebases vary in average file size (zod mean file ≈ 100 L; ajv mean ≈ 50 L; nreki mean ≈ 270 L). A ratio rule transfers the variance from one place (the threshold value) to another (the implicit "expected file size") without removing it.

**Verdict:** Reject ratio. Keep absolute line count. Simpler, predictable, parameter-stable across codebases.

---

## Q4 — Configurable via env var?

**Yes, mandatory.** Three reasons:

1. **Style variance is real.** Game engines, parsers, AST visitors, generated code legitimately have larger functions. A repo-wide override (`NREKI_SYMBOL_LIMIT=150`) costs the project owner one line in `.env` and unblocks their workflow without a fork.
2. **Backward compatibility for users on the current 40 L mental model.** They can set `NREKI_SYMBOL_LIMIT=40` and get exactly the old behavior. No surprise on upgrade.
3. **A/B-testable.** Future telemetry can compare repos at different thresholds. Hardcoded values prevent that.

**Constraints on the env knob:**
- Must be an integer ≥ 1. Reject zero or negative (would disable the gate silently — Furia hates silent disables).
- Must be bounded above by a sanity ceiling (e.g. 1000). Beyond that the user is asking for trouble; force them to fork if they really want it.
- Parse failure → fall back to default + warn on stderr (do not crash the MCP server).

---

## Q5 — Self-criticism: what about the legitimate 50–80 L rewrite?

**Concrete scenario:** Agent reads an outline, finds a 55 L function with a clean refactoring opportunity (e.g. invert a nested conditional + extract two helpers). The whole rewrite is 60 L, semantically equivalent, syntactically valid, type-clean, no suppressions.

**Current behavior (40 L cap):** Blocked. Forced to use `patch` mode with `search_text` / `replace_text`. For a structural refactor this is *worse* than a full rewrite — multiple overlapping patches each pointing into the original source, ACID rule says all patches must target the *original* (not prior patches), so the agent must mentally simulate the splice ordering. This is friction without a corresponding safety benefit, because every defect class is already caught by the other 10 gates.

**Proposed behavior (100 L cap):** Allowed. AST splice runs, kernel typechecks, anti-sweep verifies, blast radius checks callers, Chronos records cost. If the rewrite is bad, the kernel rejects pre-disk and the user sees a clear error. If the rewrite is good, one operation completes what would have been three fragile patches.

**Where the 100 L cap still bites:** A 150 L god-function rewrite. That *should* be friction. Forcing the agent to break it up via `patch` (or to decompose the god-function first via `prepare_refactor`) is the correct response — the size of the symbol is itself a smell, and the gate's role here is to make that smell expensive to ignore.

**Verdict:** 100 L preserves the gate's purpose ("god-functions are friction") while removing its overreach ("medium functions are friction too").

---

## Synthesis for Phase 3

1. **40 is unjustified empirically** (Q1). Replace it.
2. **100 introduces no new failure mode** the other 10 gates do not already cover (Q2).
3. **Absolute beats ratio** for simplicity and reasoning load (Q3).
4. **Env override is mandatory** (`NREKI_SYMBOL_LIMIT`, integer 1–1000, parse-failure-warns-and-defaults) (Q4).
5. **100 L preserves the gate's true purpose** (Q5) — block god-functions, allow legitimate medium refactors.

**Recommended default: 100 L.**

Alternative defensible choice: **80 L** (covers p95 aggregate, more conservative). Either is empirically justified; Furia prefers the value with internal precedent — and v10.1.1 (`40d55fb`) already used `<=100L` as the "HIGH-risk but readable" cutoff for outline auto-expand. Choosing 100 L unifies that constant across two subsystems instead of introducing a third magic number.
