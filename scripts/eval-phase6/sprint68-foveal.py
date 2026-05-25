"""
Sprint 6.8 Phase 3 — Foveal compression: ideal vs effective.

For NREKI's retrievals on the N=100 corpus, compute:
  - ideal compression = compressed_tokens / raw_tokens
    averaged over the actual files NREKI surfaced
  - effective compression = ideal × R@5 (per pre-registration)

raw_tokens is measured with real BPE (tiktoken cl100k_base) over the
file content as it existed at base_commit (from .eval-phase5-cache).

We compute over EVERY file that NREKI's top-10 retrieved across 100
tasks. Compressed token count = the per-task token_cost recorded by
the runner divided by 10 (foveal payload is the concatenation of top-K
chunks; we approximate each file's contribution as 1/topK of the total).

For the per-FILE ideal ratio we sum compressed-payload across tasks
that surfaced file F and divide by the raw token count of F.

Outputs:
  scripts/eval-phase6/sprint68-foveal.json
  scripts/eval-phase6/sprint68-foveal.md
"""

import json
import sys
from pathlib import Path

import tiktoken

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "results-c4b-full.json"
CACHE = ROOT / ".eval-phase5-cache" / "task-workspaces"
OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint68-foveal.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint68-foveal.md"

ENC = tiktoken.get_encoding("cl100k_base")


def slug_to_task_dir(repo: str, pull_number: int) -> Path:
    slug = repo.replace("/", "-")
    return CACHE / f"task-{slug}-pr{pull_number}"


def read_raw_tokens(path: Path) -> int | None:
    if not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(2_000_000)
    except OSError:
        return None
    return len(ENC.encode(text))


def analyze():
    with open(FULL, encoding="utf-8") as f:
        full = json.load(f)
    tasks = full["per_task"]

    # Only nreki-mbf-on is the pure foveal isolation. hybrid-rrf mixes
    # foveal-on-NREKI-half with raw-file slices from the BM25 half and is
    # not a clean foveal measurement; reported separately if needed.
    runners_under_test = ["nreki-mbf-on"]
    per_runner_ideal = {}

    for runner in runners_under_test:
        compressed_total = 0  # tokens delivered by runner across all tasks
        raw_total = 0  # tokens of unique files NREKI surfaced, weighted by surfacings
        n_files_measured = 0
        n_files_missing = 0
        per_task_ratios = []
        per_task_hit5 = []

        for task in tasks:
            body = task["runners"].get(runner)
            if body is None:
                continue
            res = body.get("result", {}) or {}
            if res.get("error"):
                continue
            compressed = body["metrics"]["token_cost"]
            files = res.get("retrieved_files", [])
            if not files:
                continue
            instance_id = task["instance_id"]
            repo = task["repo"]
            pull = int(instance_id.rsplit("-", 1)[-1])
            workspace = slug_to_task_dir(repo, pull)
            if not workspace.is_dir():
                n_files_missing += len(files)
                continue
            raw_for_task = 0
            measured = 0
            for rel in files:
                p = workspace / rel
                raw = read_raw_tokens(p)
                if raw is None:
                    n_files_missing += 1
                    continue
                raw_for_task += raw
                measured += 1
                n_files_measured += 1
            if measured == 0:
                continue
            # per-task ideal = compressed / raw_for_top_K
            # (compressed is the total foveal payload; raw is sum of full-file
            #  tokens of the same top-K). Numbers like 0.05 mean 95% reduction.
            if raw_for_task > 0:
                per_task_ratios.append(compressed / raw_for_task)
                # need hit5
                gt = set(task["ground_truth"]["strict_src"])
                rank = next((i + 1 for i, f in enumerate(files) if f in gt), None)
                hit5 = 1 if (rank is not None and rank <= 5) else 0
                per_task_hit5.append(hit5)
            compressed_total += compressed
            raw_total += raw_for_task

        ideal_ratio = compressed_total / raw_total if raw_total else float("nan")
        ideal_savings_pct = 1.0 - ideal_ratio if ideal_ratio == ideal_ratio else float("nan")

        recall_5 = sum(per_task_hit5) / len(per_task_hit5) if per_task_hit5 else 0.0
        effective_savings_pct = ideal_savings_pct * recall_5

        # Also compute per-task ratio statistics (mean / median / p95)
        from statistics import mean, median
        ratio_mean = mean(per_task_ratios) if per_task_ratios else float("nan")
        ratio_median = median(per_task_ratios) if per_task_ratios else float("nan")

        per_runner_ideal[runner] = {
            "compressed_tokens_total": compressed_total,
            "raw_tokens_total": raw_total,
            "ideal_compression_ratio_global": ideal_ratio,
            "ideal_savings_pct_global": ideal_savings_pct,
            "ratio_per_task_mean": ratio_mean,
            "ratio_per_task_median": ratio_median,
            "recall_at_5": recall_5,
            "effective_savings_pct": effective_savings_pct,
            "n_tasks_in_ratio": len(per_task_ratios),
            "n_files_measured": n_files_measured,
            "n_files_missing_on_disk": n_files_missing,
        }
        print(
            f"{runner}: ideal savings={ideal_savings_pct:.1%}, "
            f"R@5={recall_5:.2%}, effective={effective_savings_pct:.1%}, "
            f"n_tasks={len(per_task_ratios)}",
            file=sys.stderr,
        )

    out = {
        "version": "sprint-6.8-phase3",
        "tokenizer": "tiktoken cl100k_base",
        "per_runner": per_runner_ideal,
    }
    OUT_JSON.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    # Markdown
    lines = [
        "# Sprint 6.8 — Foveal compression: ideal vs effective",
        "",
        "Tokenizer: tiktoken cl100k_base (real BPE).",
        "",
        "## Method",
        "",
        "For each NREKI task that returned retrieved_files:",
        "1. Read the raw content of every top-10 retrieved file from",
        "   `.eval-phase5-cache/task-workspaces/...` at base_commit.",
        "2. Sum raw BPE tokens of those files.",
        "3. The `token_cost.total_tokens` recorded by the runner is the",
        "   foveal-compressed payload across the same top-K.",
        "4. ideal_compression_ratio = compressed / raw, aggregated globally",
        "   AND per-task.",
        "5. effective_savings = (1 - ideal_ratio) × R@5 — only counts when",
        "   the right file was actually found in top-5.",
        "",
        "## Results",
        "",
        "| Retriever | ideal savings (global) | per-task ratio median | per-task ratio mean | R@5 | effective savings | n_tasks |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in runners_under_test:
        b = per_runner_ideal[r]
        lines.append(
            f"| {r} | {b['ideal_savings_pct_global']:.1%} | "
            f"{1 - b['ratio_per_task_median']:.1%} | "
            f"{1 - b['ratio_per_task_mean']:.1%} | "
            f"{b['recall_at_5']:.2%} | "
            f"{b['effective_savings_pct']:.1%} | {b['n_tasks_in_ratio']} |"
        )

    lines.append("")
    lines.append("## Reading")
    lines.append("")
    lines.append("- **ideal savings (global):** what foveal achieves on the files NREKI surfaces,")
    lines.append("  regardless of whether the right file was found. This is the headline 78% Sprint")
    lines.append("  6.5 number, measured here on PolyBench TS instead of NREKI's own src.")
    lines.append("- **effective savings:** ideal × R@5. The honest session-level savings —")
    lines.append("  compressing the wrong file is not a real saving.")

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    analyze()
