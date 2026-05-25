# Sprint 6.8 — Pre-registration

**Frozen:** 2026-05-21, BEFORE running Phase 2 analysis or looking at TPCH numbers.
**Purpose:** Lock the cost model, retry assumption, and TPCH formula so any later result cannot be accused of formula tuning after seeing numbers (Furia 6.8 Q2 pre-empt).

---

## Hypotheses (binary)

- **Q_a:** Does NREKI standalone (`nreki-mbf-on`) cost fewer tokens **per query** than every other measured retriever (excluding voyage if NOT MEASURED)? **YES / NO**
- **Q_b:** Does NREKI standalone cost fewer tokens **per correct hit (session-level)** than every other measured retriever, accounting for retries on misses? **YES / NO / NOT-MEASURABLE**
- **Q_c:** Is the "token economics" claim (NREKI saves tokens) **publishable** as currently framed, or must it be retired / restricted? **PUBLISHABLE / RESTRICTED / RETIRED**

---

## Cost model (operational)

### What counts as "tokens of a query"

For each task `t` and retriever `r`, `tokens(t, r)` = the value of `result.token_cost.total_tokens` from the runner's RetrievalResult. This is the **payload delivered to a downstream agent** per the Sprint 6.6 §3 definition:

- For `nreki-mbf-on` / `nreki-mbf-off`: foveal-compressed text (`tfcCompress.compressed`)
- For `hybrid-rrf`: foveal-compressed text from the NREKI half + raw-file slices from the BM25 half (RRF fusion preserves both)
- For `bm25`: raw file slices (or foveal-compressed for ≥100-line files via the standalone runner)
- For `ripgrep`: raw file slices (`readFileChunk`) of all top-K files
- For `voyage-3`: chunk text used as embedding payload
- For `aider`: aider's parsed repo-map output

We DO NOT count the cost of constructing the keyword query (negligible) or of running tsc / tree-sitter (these are amortized indexing, not per-query). This is **explicitly the read-and-deliver budget**, not the index build cost.

### What counts as a "hit"

Pre-registered K = 5 (the primary metric across Sprints 6.6 / 6.7). `hit(t, r) = 1` iff `r`'s `retrieved_files[0:5]` contains at least one file in `ground_truth.strict_src[t]`. Otherwise 0. Tasks with empty ground truth (1 such in N=100) count as vacuous hits = 1, vacuous tokens = `tokens(t, r)`.

---

## Retry model (operational, pre-registered)

A miss at K=5 represents the agent not finding the right file. We model the cost of a downstream retry as:

> `total_session_tokens(t, r, N_retry) = tokens(t, r) × (1 + N_retry × miss_indicator(t, r))`

where `miss_indicator(t, r) = 1 - hit(t, r)`.

This is conservative for NREKI in two ways:

1. **Same-cost retry assumption.** A reformulated retry is assumed to cost the same tokens as the original query. In practice retries often refine context (more cost) or restrict scope (less cost) — the assumption averages these.
2. **No partial-credit miss.** A miss costs the full retry, not a fraction. Penalizes low-recall retrievers maximally.

This assumption is a **MODEL, not an observation of an actual agent loop.** We report TPCH at three retry levels as a sensitivity band:

- **N_retry = 0:** TPCH = Σ tokens / Σ hits. Pure per-query cost amortized over successful tasks. Ignores retry penalty.
- **N_retry = 1:** baseline. One retry per miss. The conservative central estimate.
- **N_retry = 2:** worst-case agent loop where the second retry also misses.

All three are reported; the Q_b verdict considers all three.

---

## Pre-registered TPCH formula

For retriever `r` over corpus `T` (|T| = N tasks):

```
TPCH(r, N_retry) = ( Σ_t tokens(t, r) × (1 + N_retry × (1 - hit(t, r))) )
                   ─────────────────────────────────────────────────────
                                  Σ_t hit(t, r)
```

CI95% via 10 000-resample bootstrap (paired across tasks), seed 42 + retry_level offset.

**Sub-corpus restriction (Furia 6.7 carry-over):** For retrievers with coverage gaps (`voyage-3` N=16, `aider` N=13), TPCH is computed on **their successful subset** AND on the **all-runners intersection** (where every measured retriever ran successfully) so the comparison is paired-fair. Both reported.

---

## Pre-registered foveal isolation (Phase 3)

The foveal-compression claim is "78% savings" from `docs/token-economics-empirical-verify.md` (compressing 72 files of NREKI's own `src/` with tiktoken). Sprint 6.8 measures:

- **Foveal ideal:** the per-file compression ratio on the actual files NREKI surfaced in Sprint 6.6 retrievals. Computed as `tokens_compressed / tokens_raw` over the 100-task retrieved file set.
- **Foveal effective:** `ideal × P(hit)`. The expected savings PER HIT, accounting for the fact that compressing the wrong file isn't a saving.

Both reported. The effective number is the honest session-level number.

**Tokenizer:** real BPE via tiktoken `cl100k_base` (the same tokenizer used by `payloadTokens()` in the runner). NO chars/3.5 heuristic — Sprint 6.5 (May 2026) audit established the heuristic is +10% optimistic and the empirical-verify doc uses real BPE.

---

## Pre-registered binary verdict templates

For Q_a (per-query):
> "NREKI standalone has the LOWEST / SECOND-LOWEST / Nth-LOWEST token_cost p50 among measured retrievers. (Voyage NOT MEASURED if key absent.) [YES if lowest, NO otherwise.]"

For Q_b (per-correct-hit):
> "At N_retry = 1, NREKI's TPCH is X tokens/hit. The best-measured-competitor TPCH is Y tokens/hit (retriever R). Ratio = X/Y. (Voyage NOT MEASURED if key absent.) [YES if X < Y, NO if X > Y, NOT-MEASURABLE if voyage missing AND voyage is the obvious comparator that would change the answer.]"

For Q_c:
- PUBLISHABLE: NREKI is cheaper per-query AND per-session vs every measured retriever, including voyage if measured.
- RESTRICTED: NREKI is cheaper per-query but TPCH is dominated by ≥1 measured retriever. Claim must be re-scoped to "per-query" only, never "per-session".
- RETIRED: NREKI is more expensive per-query OR TPCH > BM25 (the cheapest lexical baseline). Token-economics claim must be removed from messaging.

---

## Stopping / scope rules

- If `voyage-3` cannot be measured (placeholder VOYAGE_API_KEY confirmed), proceed with the 5 other retrievers. The Q_b verdict is then "NOT-MEASURABLE vs voyage" but still reportable against the other 4.
- If 3-rep variance for token_cost > 5% relative on any retriever, flag and report variance band. (Tokens are deterministic given fixed seeds; this is unlikely to fire.)
- No removal of outliers. The top-1% token_cost tasks (e.g., ripgrep on massive vscode) are part of the cost story and stay in.

---

## Pre-registered output files

- `scripts/eval-phase6/sprint68-tpch.py` (analysis script)
- `scripts/eval-phase6/sprint68-tpch.json` (machine-readable)
- `scripts/eval-phase6/sprint68-tpch.md` (table fragment)
- `docs/sprint-6.8-token-economics.md` (verdict report)

**This file is frozen. Any post-hoc modification to the cost model, retry assumption, K, or TPCH formula invalidates the verdict.**
