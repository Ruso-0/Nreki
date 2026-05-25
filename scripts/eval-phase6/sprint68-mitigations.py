"""
Sprint 6.8 — Furia post-hoc mitigations (explicitly post-hoc, NOT redefining
the pre-registered hypothesis test):

  Q3: Apples-to-apples TPCH on voyage's actual N=16 subset, with NREKI
      restricted to the SAME 16 task IDs.
  Q2: Break-even R@5 where NREKI's TPCH would match voyage's TPCH at the
      pre-registered N_retry=1.
  Q4: Foveal ablation — same retrieved files, what would NREKI's tokens
      look like if foveal compression were disabled? Computed via the raw
      tokens of NREKI's surfaced files / topK (proxy for "no compression
      at all, just send the full files").
"""

import json
import sys
from pathlib import Path

import tiktoken

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "results-c4b-full.json"
HYBRID = ROOT / "results-c4b-v3-with-hybrid.json"
CACHE = ROOT / ".eval-phase5-cache" / "task-workspaces"
OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint68-mitigations.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint68-mitigations.md"

ENC = tiktoken.get_encoding("cl100k_base")
K = 5


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


def get_cell(task, runner):
    body = task["runners"].get(runner)
    if not body:
        return None
    res = body.get("result", {}) or {}
    if res.get("error"):
        return None
    gt = set(task["ground_truth"]["strict_src"])
    files = res.get("retrieved_files", [])
    if not gt:
        hit5 = 1
    else:
        rank = first_rank(files, gt)
        hit5 = 1 if (rank is not None and rank <= K) else 0
    return {
        "tokens": body["metrics"]["token_cost"],
        "hit_5": hit5,
        "files": files,
    }


def slug_to_task_dir(repo, pull_number):
    slug = repo.replace("/", "-")
    return CACHE / f"task-{slug}-pr{pull_number}"


def raw_tokens(path):
    if not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(2_000_000)
    except OSError:
        return None
    return len(ENC.encode(text))


def tpch(pairs, n_retry):
    """pairs: list of (tokens, hit_5)."""
    if not pairs:
        return float("nan")
    num = sum(tok * (1 + n_retry * (1 - h)) for tok, h in pairs)
    den = sum(h for _, h in pairs)
    return float("inf") if den == 0 else num / den


def main():
    tasks = load_runs()
    task_by_id = {t["instance_id"]: t for t in tasks}

    # ----- Q3: voyage-equivalent subset -----
    voyage_ids = []
    for t in tasks:
        cell = get_cell(t, "voyage-3")
        if cell is not None:
            voyage_ids.append(t["instance_id"])
    print(f"Voyage success subset: N={len(voyage_ids)}", file=sys.stderr)

    apples = {}
    for runner in ["nreki-mbf-on", "hybrid-rrf", "bm25", "ripgrep",
                   "voyage-3", "aider"]:
        pairs = []
        for iid in voyage_ids:
            cell = get_cell(task_by_id[iid], runner)
            if cell is not None:
                pairs.append((cell["tokens"], cell["hit_5"]))
        if not pairs:
            apples[runner] = None
            continue
        hits = sum(h for _, h in pairs)
        n = len(pairs)
        apples[runner] = {
            "n": n,
            "hits_at_5": hits,
            "recall_at_5": hits / n,
            "tokens_sum": sum(t for t, _ in pairs),
            "tokens_mean": sum(t for t, _ in pairs) / n,
            "tpch_n_retry_0": tpch(pairs, 0),
            "tpch_n_retry_1": tpch(pairs, 1),
            "tpch_n_retry_2": tpch(pairs, 2),
        }
        print(
            f"  {runner}: n={n} hits={hits} R@5={hits/n:.2%} "
            f"TPCH@N=1={apples[runner]['tpch_n_retry_1']:.0f}",
            file=sys.stderr,
        )

    # ----- Q2: Break-even R@5 -----
    # NREKI_TPCH(R) = tokens_p50_NREKI × (1 + N_retry × (1 - R)) / R
    # Solve NREKI_TPCH(R) = voyage_TPCH (taken from apples voyage row)
    # At N=1: NREKI_p_mean = mean token across full 100; voyage TPCH = apples voyage TPCH@N=1
    nreki_native_tokens_mean = None
    for t in tasks:
        cell = get_cell(t, "nreki-mbf-on")
        if cell is not None:
            pass
    # Use the native full-100 NREKI mean
    nreki_pairs_all = []
    for t in tasks:
        cell = get_cell(t, "nreki-mbf-on")
        if cell:
            nreki_pairs_all.append((cell["tokens"], cell["hit_5"]))
    nreki_native_tokens_mean = sum(p[0] for p in nreki_pairs_all) / len(nreki_pairs_all)

    voyage_tpch_n1 = apples["voyage-3"]["tpch_n_retry_1"] if apples["voyage-3"] else float("nan")
    # Solve: nreki_token_mean × (1 + 1 × (1 - R)) / R = voyage_tpch_n1
    # => (2 - R) / R = voyage_tpch_n1 / nreki_token_mean
    # => 2/R - 1 = X  → R = 2 / (X + 1)
    if voyage_tpch_n1 and voyage_tpch_n1 == voyage_tpch_n1:
        X = voyage_tpch_n1 / nreki_native_tokens_mean
        breakeven_R_N1 = 2.0 / (X + 1)
    else:
        breakeven_R_N1 = float("nan")
    print(f"NREKI tokens mean (full 100): {nreki_native_tokens_mean:.0f}",
          file=sys.stderr)
    print(f"voyage TPCH @ N=1 (on its 16): {voyage_tpch_n1:.0f}", file=sys.stderr)
    print(f"NREKI R@5 break-even vs voyage (at N=1): {breakeven_R_N1:.3f}",
          file=sys.stderr)

    # Also compute break-even at N=0 and N=2:
    # N=0: NREKI_TPCH = tokens_mean / R = voyage_TPCH → R = tokens_mean / voyage_TPCH
    voyage_tpch_n0 = apples["voyage-3"]["tpch_n_retry_0"]
    voyage_tpch_n2 = apples["voyage-3"]["tpch_n_retry_2"]
    breakeven_R_N0 = nreki_native_tokens_mean / voyage_tpch_n0
    # N=2: NREKI_TPCH = tokens_mean × (1 + 2(1-R))/R = voyage_TPCH
    # (3 - 2R)/R = X → 3/R - 2 = X → R = 3/(X + 2)
    X2 = voyage_tpch_n2 / nreki_native_tokens_mean
    breakeven_R_N2 = 3.0 / (X2 + 2)

    breakeven = {
        "voyage_tpch_n0": voyage_tpch_n0,
        "voyage_tpch_n1": voyage_tpch_n1,
        "voyage_tpch_n2": voyage_tpch_n2,
        "nreki_tokens_mean_full100": nreki_native_tokens_mean,
        "nreki_breakeven_recall_at_5_N_retry_0": breakeven_R_N0,
        "nreki_breakeven_recall_at_5_N_retry_1": breakeven_R_N1,
        "nreki_breakeven_recall_at_5_N_retry_2": breakeven_R_N2,
        "current_nreki_recall_at_5": 0.37,
        "gap_to_breakeven_N1_pp": (breakeven_R_N1 - 0.37) * 100,
    }

    # ----- Q4: Foveal ablation -----
    # For each NREKI task: tokens_with_foveal (recorded) vs
    #   tokens_without_foveal (raw tokens of its top-K files, summed).
    # We approximate "AST chunks no foveal" as the raw file tokens of top-K
    # because the runner output is post-foveal. The ablation answers:
    # "if NREKI surfaced these same K files but sent them raw, how many tokens?"
    foveal_ablation = {"per_task": [], "summary": {}}
    sum_with_foveal = 0
    sum_without_foveal = 0
    n_complete = 0
    for t in tasks:
        cell = get_cell(t, "nreki-mbf-on")
        if cell is None:
            continue
        repo = t["repo"]
        pull = int(t["instance_id"].rsplit("-", 1)[-1])
        ws = slug_to_task_dir(repo, pull)
        if not ws.is_dir():
            continue
        raw_sum = 0
        ok = True
        for rel in cell["files"][:K]:
            p = ws / rel
            r = raw_tokens(p)
            if r is None:
                ok = False
                break
            raw_sum += r
        if not ok or raw_sum == 0:
            continue
        sum_with_foveal += cell["tokens"]
        sum_without_foveal += raw_sum
        n_complete += 1
    foveal_ablation["summary"] = {
        "n_tasks": n_complete,
        "tokens_with_foveal_total": sum_with_foveal,
        "tokens_without_foveal_total": sum_without_foveal,
        "compression_ratio_global": (sum_with_foveal / sum_without_foveal)
        if sum_without_foveal else float("nan"),
        "savings_pct_global": (1 - sum_with_foveal / sum_without_foveal) * 100
        if sum_without_foveal else float("nan"),
    }
    print(
        f"Foveal ablation: with={sum_with_foveal}, without(top-5 raw)="
        f"{sum_without_foveal}, savings="
        f"{foveal_ablation['summary']['savings_pct_global']:.1f}%",
        file=sys.stderr,
    )

    out = {
        "version": "sprint-6.8-mitigations",
        "K": K,
        "Q3_apples_to_apples": {
            "subset_n": len(voyage_ids),
            "subset_instance_ids": voyage_ids,
            "per_runner": apples,
        },
        "Q2_breakeven": breakeven,
        "Q4_foveal_ablation_top_K": foveal_ablation["summary"],
    }
    OUT_JSON.write_text(json.dumps(out, indent=2, default=str),
                        encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    # Markdown
    md = []
    md.append("# Sprint 6.8 — Furia post-hoc mitigations")
    md.append("")
    md.append("**EXPLICITLY POST-HOC.** These do not redefine the pre-registered Q_a/Q_b/Q_c verdict.")
    md.append("")
    md.append("## Q3 — Apples-to-apples TPCH on voyage's 16-task subset")
    md.append("")
    md.append(f"NREKI restricted to the SAME N={len(voyage_ids)} tasks where voyage ran successfully.")
    md.append("")
    md.append("| Retriever | n | hits@5 | R@5 | tokens mean | TPCH @N=0 | TPCH @N=1 | TPCH @N=2 |")
    md.append("|---|---|---|---|---|---|---|---|")
    for r in ["nreki-mbf-on", "hybrid-rrf", "bm25", "ripgrep",
              "voyage-3", "aider"]:
        b = apples.get(r)
        if b is None:
            md.append(f"| {r} | 0 | — | — | — | — | — | — |")
            continue
        md.append(
            f"| {r} | {b['n']} | {b['hits_at_5']} | {b['recall_at_5']:.2%} | "
            f"{b['tokens_mean']:.0f} | {b['tpch_n_retry_0']:.0f} | "
            f"{b['tpch_n_retry_1']:.0f} | {b['tpch_n_retry_2']:.0f} |"
        )
    md.append("")
    md.append("## Q2 — Break-even R@5 NREKI vs voyage")
    md.append("")
    md.append(
        f"NREKI tokens mean (full 100): {breakeven['nreki_tokens_mean_full100']:.0f}. "
        f"voyage TPCH on its 16: "
        f"N=0 {breakeven['voyage_tpch_n0']:.0f}, "
        f"N=1 {breakeven['voyage_tpch_n1']:.0f}, "
        f"N=2 {breakeven['voyage_tpch_n2']:.0f}."
    )
    md.append("")
    md.append("| N_retry | NREKI R@5 needed to match voyage TPCH | NREKI's actual R@5 | gap (pp) |")
    md.append("|---|---|---|---|")
    md.append(
        f"| 0 | {breakeven['nreki_breakeven_recall_at_5_N_retry_0']:.3f} | 0.370 | "
        f"{(breakeven['nreki_breakeven_recall_at_5_N_retry_0'] - 0.37) * 100:+.1f} |"
    )
    md.append(
        f"| 1 | {breakeven['nreki_breakeven_recall_at_5_N_retry_1']:.3f} | 0.370 | "
        f"{breakeven['gap_to_breakeven_N1_pp']:+.1f} |"
    )
    md.append(
        f"| 2 | {breakeven['nreki_breakeven_recall_at_5_N_retry_2']:.3f} | 0.370 | "
        f"{(breakeven['nreki_breakeven_recall_at_5_N_retry_2'] - 0.37) * 100:+.1f} |"
    )
    md.append("")
    md.append("## Q4 — Foveal ablation: NREKI-foveal vs NREKI-raw-files (same top-K, same retrieval)")
    md.append("")
    s = foveal_ablation["summary"]
    md.append(
        f"- n_tasks: {s['n_tasks']}\n"
        f"- with foveal (recorded): {s['tokens_with_foveal_total']:,} tokens\n"
        f"- without foveal (raw top-{K} file content): "
        f"{s['tokens_without_foveal_total']:,} tokens\n"
        f"- global compression ratio: {s['compression_ratio_global']:.4f}\n"
        f"- global savings: {s['savings_pct_global']:.1f}%"
    )
    md.append("")
    md.append("This is the foveal's contribution **with denominator pinned**: same retriever, same files, only thing changed is foveal-on vs foveal-off.")

    OUT_MD.write_text("\n".join(md) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    main()
