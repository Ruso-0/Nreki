"""
Sprint 6.8 Phase 2 + 3 — Tokens Per Correct Hit (TPCH) analysis.

Computes the pre-registered TPCH metric per retriever at K=5 with
N_retry ∈ {0, 1, 2}, plus the foveal ideal vs effective ratio.

Data sources:
  - results-c4b-full.json (per-task token_cost, retrieved_files)
  - results-c4b-v3-with-hybrid.json (hybrid-rrf cell)

Formula (frozen in sprint68-preregistration.md):
  TPCH(r, N_retry) = Σ_t tokens(t,r) × (1 + N_retry × (1 - hit_5(t,r)))
                     ─────────────────────────────────────────────────
                                   Σ_t hit_5(t, r)

Outputs:
  scripts/eval-phase6/sprint68-tpch.json
  scripts/eval-phase6/sprint68-tpch.md
"""

import json
import random
import sys
from pathlib import Path
from statistics import mean, median

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "results-c4b-full.json"
HYBRID = ROOT / "results-c4b-v3-with-hybrid.json"
OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint68-tpch.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint68-tpch.md"

K = 5
RESAMPLES = 10_000
SEED = 42


def load_runs():
    with open(FULL, encoding="utf-8") as f:
        full = json.load(f)
    with open(HYBRID, encoding="utf-8") as f:
        hyb = json.load(f)
    by_id = {t["instance_id"]: t for t in hyb["per_task"]}
    for task in full["per_task"]:
        h = by_id.get(task["instance_id"])
        if h and "hybrid-rrf" in h["runners"]:
            task["runners"]["hybrid-rrf"] = h["runners"]["hybrid-rrf"]
    return full["per_task"]


def first_rank(retrieved, truth_set):
    for i, f in enumerate(retrieved):
        if f in truth_set:
            return i + 1
    return None


def task_cell(body, gt_strict):
    """Returns dict {tokens, hit_5, error} or None if cell missing."""
    if body is None:
        return None
    res = body.get("result", {}) or {}
    err = res.get("error")
    if err:
        return {"error": err, "tokens": None, "hit_5": 0}
    tokens = body["metrics"]["token_cost"]
    if not gt_strict:
        return {"error": None, "tokens": tokens, "hit_5": 1}
    rank = first_rank(res.get("retrieved_files", []), set(gt_strict))
    hit_5 = 1 if (rank is not None and rank <= K) else 0
    return {"error": None, "tokens": tokens, "hit_5": hit_5}


def percentile(xs, p):
    if not xs:
        return float("nan")
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    import math
    k = (p / 100) * (len(s) - 1)
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def bootstrap_tpch(pairs, n_retry, resamples=RESAMPLES, seed=SEED):
    """
    pairs: list of (tokens, hit_5).
    Returns (observed_tpch, ci_low, ci_high).
    """
    if not pairs:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    sims = []
    n = len(pairs)
    for _ in range(resamples):
        num = 0.0
        denom = 0
        for _ in range(n):
            tok, h = pairs[rng.randint(0, n - 1)]
            num += tok * (1 + n_retry * (1 - h))
            denom += h
        if denom == 0:
            sims.append(float("inf"))
        else:
            sims.append(num / denom)
    sims_finite = sorted(x for x in sims if x != float("inf"))
    if not sims_finite:
        return (float("inf"), float("inf"), float("inf"))
    # observed = formula on the actual data
    num = sum(tok * (1 + n_retry * (1 - h)) for tok, h in pairs)
    denom = sum(h for _, h in pairs)
    observed = float("inf") if denom == 0 else num / denom
    lo = sims_finite[int(0.025 * (len(sims_finite) - 1))]
    hi = sims_finite[int(0.975 * (len(sims_finite) - 1))]
    return (observed, lo, hi)


def analyze():
    tasks = load_runs()
    runners = ["nreki-mbf-off", "nreki-mbf-on", "hybrid-rrf",
               "bm25", "ripgrep", "fast_grep",
               "voyage-3", "aider"]

    out = {
        "version": "sprint-6.8",
        "K": K,
        "bootstrap_resamples": RESAMPLES,
        "seed": SEED,
        "per_runner": {},
    }

    # Sweep N=100 ("native") and the all-runners intersection
    # subset where every measured retriever succeeded.
    successful_ids = {r: set() for r in runners}
    cells = {r: {} for r in runners}  # cells[r][instance_id] = {tokens, hit_5}
    for t in tasks:
        gt = t["ground_truth"]["strict_src"]
        for r in runners:
            cell = task_cell(t["runners"].get(r), gt)
            if cell is None or cell.get("error"):
                continue
            cells[r][t["instance_id"]] = cell
            successful_ids[r].add(t["instance_id"])

    # Native (per-runner own successful subset)
    for r in runners:
        pairs = [(c["tokens"], c["hit_5"]) for c in cells[r].values()]
        if not pairs:
            out["per_runner"][r] = {"n": 0, "status": "NOT_MEASURED"}
            continue
        tokens_all = [p[0] for p in pairs]
        hits = sum(p[1] for p in pairs)
        body = {
            "n": len(pairs),
            "hits_at_5": hits,
            "recall_at_5": hits / len(pairs),
            "tokens_p50": percentile(tokens_all, 50),
            "tokens_p95": percentile(tokens_all, 95),
            "tokens_mean": mean(tokens_all),
            "tokens_sum": sum(tokens_all),
            "tpch": {},
        }
        for n_retry in (0, 1, 2):
            obs, lo, hi = bootstrap_tpch(pairs, n_retry,
                                         seed=SEED + n_retry)
            body["tpch"][f"n_retry_{n_retry}"] = {
                "observed": obs,
                "ci95_low": lo,
                "ci95_high": hi,
            }
        out["per_runner"][r] = body

    # Apples-to-apples: tasks where EVERY runner with N>=80 succeeded.
    # Voyage (N=16) and aider (N=13) are kept out of the intersection;
    # reported separately on their own subsets.
    full100_runners = [r for r in runners
                       if r not in ("voyage-3", "aider")
                       and len(successful_ids[r]) >= 80]
    intersection_ids = None
    for r in full100_runners:
        if intersection_ids is None:
            intersection_ids = set(successful_ids[r])
        else:
            intersection_ids &= successful_ids[r]

    out["intersection_full100_runners"] = sorted(full100_runners)
    out["intersection_size"] = len(intersection_ids) if intersection_ids else 0

    if intersection_ids:
        intersection_block = {}
        for r in full100_runners + ["voyage-3", "aider"]:
            pairs = [(cells[r][iid]["tokens"], cells[r][iid]["hit_5"])
                     for iid in intersection_ids
                     if iid in cells[r]]
            if not pairs:
                intersection_block[r] = {"n": 0, "status": "NOT_IN_SUBSET"}
                continue
            hits = sum(p[1] for p in pairs)
            tokens_all = [p[0] for p in pairs]
            body = {
                "n": len(pairs),
                "hits_at_5": hits,
                "recall_at_5": hits / len(pairs),
                "tokens_p50": percentile(tokens_all, 50),
                "tokens_sum": sum(tokens_all),
                "tpch": {},
            }
            for n_retry in (0, 1, 2):
                obs, lo, hi = bootstrap_tpch(pairs, n_retry,
                                             seed=SEED + 100 + n_retry)
                body["tpch"][f"n_retry_{n_retry}"] = {
                    "observed": obs,
                    "ci95_low": lo,
                    "ci95_high": hi,
                }
            intersection_block[r] = body
        out["intersection_block"] = intersection_block

    OUT_JSON.write_text(json.dumps(out, indent=2, default=str),
                        encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    # ---- Markdown ----
    lines = ["# Sprint 6.8 — TPCH analysis", ""]
    lines.append(f"K={K}, bootstrap resamples={RESAMPLES}, seed={SEED}.")
    lines.append("Hit = ground_truth.strict_src ∩ retrieved_files[0:K] non-empty.")
    lines.append("")
    lines.append("## Per-retriever native (each retriever's own success subset)")
    lines.append("")
    lines.append("| Retriever | N | hits@5 | R@5 | tokens p50 | tokens p95 | TPCH @N=0 | TPCH @N=1 | TPCH @N=2 |")
    lines.append("|---|---|---|---|---|---|---|---|---|")

    def fmt_tpch(d):
        if d["observed"] == float("inf"):
            return "∞ (no hits)"
        return f"{d['observed']:.0f} [{d['ci95_low']:.0f}, {d['ci95_high']:.0f}]"

    for r in runners:
        body = out["per_runner"][r]
        if body.get("status") == "NOT_MEASURED":
            lines.append(f"| {r} | 0 | — | — | — | — | — | — | — |")
            continue
        t = body["tpch"]
        lines.append(
            f"| {r} | {body['n']} | {body['hits_at_5']} | "
            f"{body['recall_at_5']:.3f} | {body['tokens_p50']:.0f} | "
            f"{body['tokens_p95']:.0f} | "
            f"{fmt_tpch(t['n_retry_0'])} | {fmt_tpch(t['n_retry_1'])} | "
            f"{fmt_tpch(t['n_retry_2'])} |"
        )

    if out.get("intersection_block"):
        lines.append("")
        lines.append(f"## Apples-to-apples intersection (N={out['intersection_size']} tasks where all full-100 runners succeeded)")
        lines.append("")
        lines.append("Intersection includes: " + ", ".join(out["intersection_full100_runners"]))
        lines.append("")
        lines.append("| Retriever | n in subset | R@5 | tokens p50 | TPCH @N=0 | TPCH @N=1 | TPCH @N=2 |")
        lines.append("|---|---|---|---|---|---|---|")
        for r in runners:
            body = out["intersection_block"].get(r, {})
            if body.get("status") == "NOT_IN_SUBSET" or body.get("n", 0) == 0:
                lines.append(f"| {r} | 0 | — | — | — | — | — |")
                continue
            t = body["tpch"]
            lines.append(
                f"| {r} | {body['n']} | {body['recall_at_5']:.3f} | "
                f"{body['tokens_p50']:.0f} | "
                f"{fmt_tpch(t['n_retry_0'])} | {fmt_tpch(t['n_retry_1'])} | "
                f"{fmt_tpch(t['n_retry_2'])} |"
            )
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    analyze()
