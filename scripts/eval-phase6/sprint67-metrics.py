"""
Sprint 6.7 Phase 2 — Per-bucket R@K + MRR + bootstrap CI95.

Reads:
  - scripts/eval-phase6/sprint67-buckets.jsonl  (Phase 1 output)
  - results-c4b-full.json + results-c4b-v3-with-hybrid.json  (retrieved_files)

For each bucket × each retriever:
  - mean R@1, R@5, R@10, MRR with 95% non-paired bootstrap CI
  - paired bootstrap delta for NREKI hybrid - voyage-3 over A_voyage

Outputs:
  scripts/eval-phase6/sprint67-metrics.json
  scripts/eval-phase6/sprint67-metrics.md
"""

import json
import random
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUCKETS = ROOT / "scripts" / "eval-phase6" / "sprint67-buckets.jsonl"
FULL = ROOT / "results-c4b-full.json"
HYBRID = ROOT / "results-c4b-v3-with-hybrid.json"
OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint67-metrics.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint67-metrics.md"

RESAMPLES = 10_000
SEED = 42
TOPK = 10


def load_data():
    with open(FULL, encoding="utf-8") as f:
        full = json.load(f)
    with open(HYBRID, encoding="utf-8") as f:
        hyb = json.load(f)
    hyb_by_id = {t["instance_id"]: t for t in hyb["per_task"]}
    for task in full["per_task"]:
        ht = hyb_by_id.get(task["instance_id"])
        if ht and "hybrid-rrf" in ht["runners"]:
            task["runners"]["hybrid-rrf"] = ht["runners"]["hybrid-rrf"]
    buckets = {}
    with open(BUCKETS, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            b = json.loads(line)
            buckets[b["instance_id"]] = b["bucket"]
    return full["per_task"], buckets


def first_rank(retrieved, truth_set):
    for i, f in enumerate(retrieved):
        if f in truth_set:
            return i + 1
    return None


def task_metric(body, gt_strict):
    if not body:
        return None
    res = body.get("result", {})
    err = res.get("error")
    if err:
        return None
    if not gt_strict:
        return {"r1": 1.0, "r5": 1.0, "r10": 1.0, "mrr": 1.0}
    rank = first_rank(res.get("retrieved_files", []), set(gt_strict))
    return {
        "r1": 1.0 if rank == 1 else 0.0,
        "r5": 1.0 if (rank is not None and rank <= 5) else 0.0,
        "r10": 1.0 if (rank is not None and rank <= 10) else 0.0,
        "mrr": 0.0 if rank is None else 1.0 / rank,
    }


def bootstrap_ci(values, resamples=RESAMPLES, seed=SEED):
    if not values:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    n = len(values)
    sims = []
    for _ in range(resamples):
        s = sum(values[rng.randint(0, n - 1)] for _ in range(n)) / n
        sims.append(s)
    sims.sort()
    return (sum(values) / n,
            sims[int(0.025 * (len(sims) - 1))],
            sims[int(0.975 * (len(sims) - 1))])


def paired_bootstrap(deltas, resamples=RESAMPLES, seed=SEED):
    if not deltas:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    n = len(deltas)
    sims = []
    for _ in range(resamples):
        s = sum(deltas[rng.randint(0, n - 1)] for _ in range(n)) / n
        sims.append(s)
    sims.sort()
    return (sum(deltas) / n,
            sims[int(0.025 * (len(sims) - 1))],
            sims[int(0.975 * (len(sims) - 1))])


def main():
    tasks, bucket_by_id = load_data()
    runners = ["nreki-mbf-on", "hybrid-rrf", "voyage-3", "bm25", "ripgrep", "aider"]

    # Group tasks by bucket
    by_bucket = defaultdict(list)
    for t in tasks:
        bucket = bucket_by_id.get(t["instance_id"], "C")
        by_bucket[bucket].append(t)

    print(f"Bucket sizes: A={len(by_bucket['A'])}, "
          f"B={len(by_bucket['B'])}, C={len(by_bucket['C'])}",
          file=sys.stderr)

    results = {
        "version": "sprint-6.7",
        "topK": TOPK,
        "bootstrap_resamples": RESAMPLES,
        "bootstrap_seed": SEED,
        "bucket_sizes": {b: len(by_bucket[b]) for b in ("A", "B", "C")},
        "buckets": {},
    }

    for bucket in ("A", "B", "C"):
        bucket_tasks = by_bucket[bucket]
        per_runner = {}
        # Per-runner: collect metric vectors only on tasks where the runner succeeded
        for r in runners:
            r1, r5, r10, mrr = [], [], [], []
            n_attempted = 0
            n_skipped = 0
            n_errored = 0
            for t in bucket_tasks:
                body = t["runners"].get(r)
                if body is None:
                    continue
                n_attempted += 1
                tm = task_metric(body, t["ground_truth"]["strict_src"])
                if tm is None:
                    err = body["result"].get("error", "") or ""
                    if "SKIPPED" in err or "subset" in err.lower():
                        n_skipped += 1
                    else:
                        n_errored += 1
                    continue
                r1.append(tm["r1"])
                r5.append(tm["r5"])
                r10.append(tm["r10"])
                mrr.append(tm["mrr"])
            if r1:
                per_runner[r] = {
                    "n": len(r1),
                    "n_attempted": n_attempted,
                    "n_skipped": n_skipped,
                    "n_errored": n_errored,
                    "recall_at_1": list(bootstrap_ci(r1)),
                    "recall_at_5": list(bootstrap_ci(r5, seed=SEED + 1)),
                    "recall_at_10": list(bootstrap_ci(r10, seed=SEED + 2)),
                    "mrr": list(bootstrap_ci(mrr, seed=SEED + 3)),
                }
            else:
                per_runner[r] = {
                    "n": 0,
                    "n_attempted": n_attempted,
                    "n_skipped": n_skipped,
                    "n_errored": n_errored,
                    "recall_at_1": None,
                    "recall_at_5": None,
                    "recall_at_10": None,
                    "mrr": None,
                }

        # Paired NREKI hybrid - voyage-3 (per the H0/H1 test)
        delta_block = None
        nh = "hybrid-rrf"
        v = "voyage-3"
        deltas_r5 = []
        deltas_r10 = []
        deltas_mrr = []
        n_pair = 0
        for t in bucket_tasks:
            nh_body = t["runners"].get(nh)
            v_body = t["runners"].get(v)
            if nh_body is None or v_body is None:
                continue
            nh_tm = task_metric(nh_body, t["ground_truth"]["strict_src"])
            v_tm = task_metric(v_body, t["ground_truth"]["strict_src"])
            if nh_tm is None or v_tm is None:
                continue
            n_pair += 1
            deltas_r5.append(nh_tm["r5"] - v_tm["r5"])
            deltas_r10.append(nh_tm["r10"] - v_tm["r10"])
            deltas_mrr.append(nh_tm["mrr"] - v_tm["mrr"])
        delta_block = {
            "n_pair": n_pair,
            "delta_recall_at_5": list(paired_bootstrap(deltas_r5)) if deltas_r5 else None,
            "delta_recall_at_10": list(paired_bootstrap(deltas_r10, seed=SEED + 1)) if deltas_r10 else None,
            "delta_mrr": list(paired_bootstrap(deltas_mrr, seed=SEED + 2)) if deltas_mrr else None,
        }

        results["buckets"][bucket] = {
            "n_tasks": len(bucket_tasks),
            "per_runner": per_runner,
            "paired_hybrid_vs_voyage": delta_block,
        }

    OUT_JSON.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    # Markdown
    lines = ["# Sprint 6.7 — Phase 2 per-bucket metrics", ""]
    lines.append(f"Top-K={TOPK}, bootstrap resamples={RESAMPLES}, seed={SEED}.")
    lines.append(f"Bucket sizes: A={len(by_bucket['A'])}, B={len(by_bucket['B'])}, C={len(by_bucket['C'])}.")
    lines.append("")

    def fmt(triple):
        if triple is None:
            return "—"
        obs, lo, hi = triple
        return f"{obs:.3f} [{lo:.3f}, {hi:.3f}]"

    for bucket in ("A", "B", "C"):
        b = results["buckets"][bucket]
        lines.append(f"## Bucket {bucket} (N={b['n_tasks']})")
        lines.append("")
        if b["n_tasks"] == 0:
            lines.append("(empty bucket)")
            lines.append("")
            continue
        lines.append("| Retriever | N succ / N attempted | R@1 | R@5 | R@10 | MRR |")
        lines.append("|---|---|---|---|---|---|")
        for r in runners:
            pr = b["per_runner"][r]
            n_succ = pr["n"]
            n_att = pr["n_attempted"]
            if n_succ == 0:
                lines.append(f"| {r} | {n_succ}/{n_att} (skip={pr['n_skipped']}, err={pr['n_errored']}) | — | — | — | — |")
            else:
                lines.append(
                    f"| {r} | {n_succ}/{n_att} "
                    f"(skip={pr['n_skipped']}, err={pr['n_errored']}) | "
                    f"{fmt(pr['recall_at_1'])} | {fmt(pr['recall_at_5'])} | "
                    f"{fmt(pr['recall_at_10'])} | {fmt(pr['mrr'])} |"
                )
        lines.append("")
        d = b["paired_hybrid_vs_voyage"]
        lines.append(f"### Paired delta NREKI hybrid - voyage-3 (Bucket {bucket}, n_pair={d['n_pair']})")
        lines.append("")
        if d["n_pair"] == 0:
            lines.append("No tasks where both ran successfully — paired test not applicable.")
        else:
            lines.append(f"- delta R@5  : {fmt(d['delta_recall_at_5'])}")
            lines.append(f"- delta R@10 : {fmt(d['delta_recall_at_10'])}")
            lines.append(f"- delta MRR  : {fmt(d['delta_mrr'])}")
        lines.append("")

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    main()
