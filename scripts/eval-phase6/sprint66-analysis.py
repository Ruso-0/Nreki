"""
Sprint 6.6 Comparative Benchmark - aligned-metrics analysis.

Loads:
  - results-c4b-full.json     (voyage-3, ripgrep, bm25, aider,
                               nreki-mbf-off, nreki-mbf-on, fast_grep)
  - results-c4b-v3-with-hybrid.json  (hybrid-rrf)

For every runner, computes (per-task) and aggregates (mean + bootstrap CI95%):
  - Recall@1
  - Recall@5
  - Recall@10
  - MRR (mean reciprocal rank)
  - token_cost p50 / p95 (already on per-task)
  - latency p50 / p95   (already on per-task)

Honest coverage tracking:
  - Voyage ran on a 21-task subset (16 succeeded); flagged in report
  - Aider hit 120s timeout on 87 of 100 tasks; only 13 succeeded
  - All other runners completed N=100

Outputs:
  scripts/eval-phase6/sprint66-results.json   (machine-readable)
  scripts/eval-phase6/sprint66-table.md       (human report fragment)
"""

import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "results-c4b-full.json"
HYBRID = ROOT / "results-c4b-v3-with-hybrid.json"
OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint66-results.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint66-table.md"

RESAMPLES = 10000
SEED = 42
TOP_K = 10


def load_runs():
    with open(FULL, encoding="utf-8") as f:
        full = json.load(f)
    with open(HYBRID, encoding="utf-8") as f:
        hybrid = json.load(f)
    hybrid_by_id = {t["instance_id"]: t for t in hybrid["per_task"]}
    # merge: pull hybrid-rrf runner from hybrid file into full's tasks
    for task in full["per_task"]:
        ht = hybrid_by_id.get(task["instance_id"])
        if ht and "hybrid-rrf" in ht["runners"]:
            task["runners"]["hybrid-rrf"] = ht["runners"]["hybrid-rrf"]
    return full


def first_relevant_rank(retrieved, truth_set):
    for i, f in enumerate(retrieved):
        if f in truth_set:
            return i + 1
    return None


def task_metric(runner_body, gt_strict):
    """
    Returns dict r1/r5/r10/mrr; if the cell errored or has no files,
    treated as a miss (0). Caller filters by coverage flag separately
    when computing "successful subset" means.
    """
    if not runner_body:
        return None, "no_cell"
    res = runner_body.get("result", {})
    err = res.get("error")
    if err:
        return None, err
    if not gt_strict:
        # vacuous: nothing to retrieve, neutral score
        return {"r1": 1.0, "r5": 1.0, "r10": 1.0, "mrr": 1.0,
                "tokens": runner_body["metrics"]["token_cost"],
                "latency": runner_body["metrics"]["latency_ms"]}, None
    rank = first_relevant_rank(res.get("retrieved_files", []), set(gt_strict))
    return {
        "r1": 1.0 if rank == 1 else 0.0,
        "r5": 1.0 if (rank is not None and rank <= 5) else 0.0,
        "r10": 1.0 if (rank is not None and rank <= 10) else 0.0,
        "mrr": 0.0 if rank is None else 1.0 / rank,
        "tokens": runner_body["metrics"]["token_cost"],
        "latency": runner_body["metrics"]["latency_ms"],
    }, None


def bootstrap_ci(values, resamples=RESAMPLES, seed=SEED):
    if not values:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    n = len(values)
    samples = []
    for _ in range(resamples):
        s = sum(values[rng.randint(0, n - 1)] for _ in range(n)) / n
        samples.append(s)
    samples.sort()
    lo = samples[int(0.025 * (len(samples) - 1))]
    hi = samples[int(0.975 * (len(samples) - 1))]
    return (sum(values) / n, lo, hi)


def percentile(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (p / 100) * (len(s) - 1)
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return s[lo]
    frac = k - lo
    return s[lo] + (s[hi] - s[lo]) * frac


def analyze():
    full = load_runs()
    per_task = full["per_task"]
    print(f"Loaded {len(per_task)} tasks.", file=sys.stderr)

    runners = [
        "nreki-mbf-off",
        "nreki-mbf-on",
        "hybrid-rrf",
        "voyage-3",
        "aider",
        "ripgrep",
        "bm25",
        "fast_grep",
    ]

    # per-runner: list of per-task metric dicts (only for tasks where ran successfully)
    per_runner_metrics = {r: [] for r in runners}
    per_runner_errors = {r: defaultdict(int) for r in runners}

    # paired-by-instance for downstream comparisons
    paired = {r: {} for r in runners}

    for task in per_task:
        gt = task["ground_truth"]["strict_src"]
        for r in runners:
            body = task["runners"].get(r)
            tm, err = task_metric(body, gt)
            if err:
                tag = err[:50]
                per_runner_errors[r][tag] += 1
                continue
            per_runner_metrics[r].append(tm)
            paired[r][task["instance_id"]] = tm

    results = {
        "version": "sprint-6.6",
        "corpus": "PolyBench Verified TS (100 instances, 5 repos)",
        "repos": ["microsoft/vscode", "sveltejs/svelte",
                  "serverless/serverless", "prettier/prettier",
                  "mui/material-ui"],
        "topK": TOP_K,
        "bootstrap_resamples": RESAMPLES,
        "bootstrap_seed": SEED,
        "per_runner": {},
    }

    for r in runners:
        vals = per_runner_metrics[r]
        n_success = len(vals)
        n_attempted = sum(1 for t in per_task if t["runners"].get(r))
        n_errors = sum(per_runner_errors[r].values())

        if not vals:
            results["per_runner"][r] = {
                "n_attempted": n_attempted,
                "n_successful": 0,
                "n_errors": n_errors,
                "error_breakdown": dict(per_runner_errors[r]),
                "metrics": None,
            }
            continue

        r1 = [v["r1"] for v in vals]
        r5 = [v["r5"] for v in vals]
        r10 = [v["r10"] for v in vals]
        mrr = [v["mrr"] for v in vals]
        tok = [v["tokens"] for v in vals]
        lat = [v["latency"] for v in vals]

        results["per_runner"][r] = {
            "n_attempted": n_attempted,
            "n_successful": n_success,
            "n_errors": n_errors,
            "error_breakdown": dict(per_runner_errors[r]),
            "metrics": {
                "recall_at_1": {
                    "mean": mean(r1),
                    "ci95": bootstrap_ci(r1)[1:],
                },
                "recall_at_5": {
                    "mean": mean(r5),
                    "ci95": bootstrap_ci(r5, seed=SEED + 1)[1:],
                },
                "recall_at_10": {
                    "mean": mean(r10),
                    "ci95": bootstrap_ci(r10, seed=SEED + 2)[1:],
                },
                "mrr": {
                    "mean": mean(mrr),
                    "ci95": bootstrap_ci(mrr, seed=SEED + 3)[1:],
                },
                "token_cost_p50": percentile(tok, 50),
                "token_cost_p95": percentile(tok, 95),
                "token_cost_mean": mean(tok),
                "latency_ms_p50": percentile(lat, 50),
                "latency_ms_p95": percentile(lat, 95),
            },
        }

    # Subset-fair analysis: restrict to instances where voyage AND aider
    # AND the 5 main retrievers all succeeded.
    voyage_succ = set(paired["voyage-3"].keys())
    aider_succ = set(paired["aider"].keys())
    core_succ = (set(paired["nreki-mbf-off"].keys())
                 & set(paired["nreki-mbf-on"].keys())
                 & set(paired["hybrid-rrf"].keys())
                 & set(paired["ripgrep"].keys())
                 & set(paired["bm25"].keys()))
    subset = voyage_succ & aider_succ & core_succ

    subset_block = {"intersection_size": len(subset),
                    "instances": sorted(subset),
                    "per_runner": {}}
    for r in runners:
        ids = [iid for iid in subset if iid in paired[r]]
        if not ids:
            subset_block["per_runner"][r] = None
            continue
        r1 = [paired[r][iid]["r1"] for iid in ids]
        r5 = [paired[r][iid]["r5"] for iid in ids]
        r10 = [paired[r][iid]["r10"] for iid in ids]
        mrr = [paired[r][iid]["mrr"] for iid in ids]
        subset_block["per_runner"][r] = {
            "n": len(ids),
            "recall_at_1": mean(r1),
            "recall_at_5": mean(r5),
            "recall_at_10": mean(r10),
            "mrr": mean(mrr),
        }
    results["subset_all_ran"] = subset_block

    # Paired deltas vs nreki-mbf-on for full-100 cells (only on N=100 runners)
    full100_runners = ["nreki-mbf-off", "nreki-mbf-on", "hybrid-rrf",
                       "ripgrep", "bm25", "fast_grep"]
    deltas_block = {}
    ref = "nreki-mbf-on"
    for r in full100_runners:
        if r == ref:
            continue
        pairs = []
        for iid in paired[r]:
            if iid in paired[ref]:
                pairs.append({
                    "r1_delta": paired[ref][iid]["r1"] - paired[r][iid]["r1"],
                    "r5_delta": paired[ref][iid]["r5"] - paired[r][iid]["r5"],
                    "r10_delta": paired[ref][iid]["r10"] - paired[r][iid]["r10"],
                    "mrr_delta": paired[ref][iid]["mrr"] - paired[r][iid]["mrr"],
                })
        if not pairs:
            continue
        deltas_block[f"{ref}_vs_{r}"] = {
            "n": len(pairs),
            "r1_delta": bootstrap_ci([p["r1_delta"] for p in pairs]),
            "r5_delta": bootstrap_ci([p["r5_delta"] for p in pairs], seed=SEED + 1),
            "r10_delta": bootstrap_ci([p["r10_delta"] for p in pairs], seed=SEED + 2),
            "mrr_delta": bootstrap_ci([p["mrr_delta"] for p in pairs], seed=SEED + 3),
        }
    results["paired_deltas"] = deltas_block

    # Per-repo Recall@5 + MRR for the headline runners (Furia round 6.6 Q1
    # countermeasure: expose mui dominance and per-repo skew).
    repo_block = {}
    repos_in_order = sorted({t["repo"] for t in per_task},
                            key=lambda r: -sum(1 for t in per_task if t["repo"] == r))
    headline_runners = ["nreki-mbf-on", "hybrid-rrf", "voyage-3", "bm25", "ripgrep", "aider"]
    for repo in repos_in_order:
        tasks_in_repo = [t for t in per_task if t["repo"] == repo]
        repo_block[repo] = {"n_total": len(tasks_in_repo), "runners": {}}
        for r in headline_runners:
            vals_r5 = []
            vals_mrr = []
            for t in tasks_in_repo:
                body = t["runners"].get(r)
                tm, err = task_metric(body, t["ground_truth"]["strict_src"])
                if err or tm is None:
                    continue
                vals_r5.append(tm["r5"])
                vals_mrr.append(tm["mrr"])
            repo_block[repo]["runners"][r] = {
                "n": len(vals_r5),
                "recall_at_5": (sum(vals_r5) / len(vals_r5)) if vals_r5 else None,
                "mrr": (sum(vals_mrr) / len(vals_mrr)) if vals_mrr else None,
            }
    results["per_repo"] = repo_block

    # Furia Q1 countermeasure: macro-averaged R@5 across repos (each repo
    # weighted equally regardless of N). Compare to micro-averaged headline.
    macro_block = {}
    for r in headline_runners:
        repo_scores_r5 = []
        repo_scores_mrr = []
        for repo, body in repo_block.items():
            cell = body["runners"][r]
            if cell["recall_at_5"] is not None and cell["n"] > 0:
                repo_scores_r5.append(cell["recall_at_5"])
                repo_scores_mrr.append(cell["mrr"])
        if repo_scores_r5:
            macro_block[r] = {
                "repos_covered": len(repo_scores_r5),
                "macro_recall_at_5": sum(repo_scores_r5) / len(repo_scores_r5),
                "macro_mrr": sum(repo_scores_mrr) / len(repo_scores_mrr),
            }
        else:
            macro_block[r] = None
    results["macro_per_repo"] = macro_block

    OUT_JSON.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    # Markdown table fragment
    lines = []
    lines.append("# Sprint 6.6 — Comparative metrics (PolyBench Verified TS, N=100)\n")
    lines.append("Top-K=10. Each runner's metrics are computed only on the tasks where it completed successfully (no skip / no error). N column reflects this.\n")
    lines.append("| Retriever | N | Recall@1 | Recall@5 | Recall@10 | MRR | TokCost p50 | TokCost p95 | Latency p50 (ms) | Latency p95 (ms) |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")

    def fmt_ci(mean_, ci):
        lo, hi = ci
        return f"{mean_:.3f} [{lo:.3f}, {hi:.3f}]"

    for r in runners:
        body = results["per_runner"][r]
        if body["metrics"] is None:
            lines.append(f"| {r} | {body['n_successful']}/{body['n_attempted']} | — | — | — | — | — | — | — | — |")
            continue
        m = body["metrics"]
        lines.append(
            f"| {r} | {body['n_successful']}/{body['n_attempted']} | "
            f"{fmt_ci(m['recall_at_1']['mean'], m['recall_at_1']['ci95'])} | "
            f"{fmt_ci(m['recall_at_5']['mean'], m['recall_at_5']['ci95'])} | "
            f"{fmt_ci(m['recall_at_10']['mean'], m['recall_at_10']['ci95'])} | "
            f"{fmt_ci(m['mrr']['mean'], m['mrr']['ci95'])} | "
            f"{m['token_cost_p50']:.0f} | {m['token_cost_p95']:.0f} | "
            f"{m['latency_ms_p50']:.0f} | {m['latency_ms_p95']:.0f} |"
        )

    lines.append("")
    lines.append(f"## Apples-to-apples subset (N={len(subset)} tasks where ALL 5 retrievers ran successfully)\n")
    lines.append("| Retriever | Recall@1 | Recall@5 | Recall@10 | MRR |")
    lines.append("|---|---|---|---|---|")
    for r in runners:
        sb = subset_block["per_runner"][r]
        if sb is None:
            continue
        lines.append(f"| {r} | {sb['recall_at_1']:.3f} | {sb['recall_at_5']:.3f} | {sb['recall_at_10']:.3f} | {sb['mrr']:.3f} |")

    lines.append("")
    lines.append("## Per-repo Recall@5 (Furia round 6.6 Q1 countermeasure — exposes mui dominance)\n")
    lines.append("| Repo | N | nreki-mbf-on | hybrid-rrf | voyage-3 | bm25 | ripgrep | aider |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for repo, body in repo_block.items():
        row = [f"| {repo} | {body['n_total']} "]
        for r in ["nreki-mbf-on", "hybrid-rrf", "voyage-3", "bm25", "ripgrep", "aider"]:
            cell = body["runners"][r]
            if cell["recall_at_5"] is None:
                row.append(f"| n=0/{body['n_total']} ")
            else:
                row.append(f"| {cell['recall_at_5']:.2f} (n={cell['n']}) ")
        row.append("|")
        lines.append("".join(row))

    lines.append("")
    lines.append("## Macro-averaged R@5 (each repo weighted equally — Furia Q1 countermeasure)\n")
    lines.append("| Retriever | repos covered | macro R@5 | macro MRR | micro R@5 (for contrast) |")
    lines.append("|---|---|---|---|---|")
    for r in headline_runners:
        m = macro_block[r]
        micro = results["per_runner"][r]["metrics"]["recall_at_5"]["mean"] if results["per_runner"][r]["metrics"] else None
        if m is None:
            lines.append(f"| {r} | 0 | — | — | — |")
        else:
            lines.append(f"| {r} | {m['repos_covered']} | {m['macro_recall_at_5']:.3f} | {m['macro_mrr']:.3f} | {micro:.3f} |" if micro is not None else f"| {r} | {m['repos_covered']} | {m['macro_recall_at_5']:.3f} | {m['macro_mrr']:.3f} | — |")

    lines.append("")
    lines.append("## Paired deltas vs nreki-mbf-on (Delta = nreki - other, positive = NREKI better)\n")
    lines.append("| Comparison | N | R@1 delta [CI95] | R@5 delta [CI95] | R@10 delta [CI95] | MRR delta [CI95] |")
    lines.append("|---|---|---|---|---|---|")
    for label, body in deltas_block.items():
        def fmt(t):
            obs, lo, hi = t
            return f"{obs:+.3f} [{lo:+.3f}, {hi:+.3f}]"
        lines.append(
            f"| {label} | {body['n']} | "
            f"{fmt(body['r1_delta'])} | {fmt(body['r5_delta'])} | "
            f"{fmt(body['r10_delta'])} | {fmt(body['mrr_delta'])} |"
        )

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    analyze()
