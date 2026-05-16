#!/usr/bin/env python3
"""
measure-ahi-auc.py — empirical AUC of AHI normalized_gap feature
                     vs binary labels derived from Django commit messages.

Dataset: django_stgt_dataset.jsonl (18,225 commits, Lanczos-PRO features pre-computed).
Hypothesis: AHI's normalized_gap is predictive of API/architectural breaking
            changes (not just descriptive). H0: AUC ~ 0.50 (random).
            H1: AUC > 0.55 (predictive signal exists).

Output: rigorous_eval_ahi.json with roc_auc, pr_auc, bootstrap CI,
        confusion matrix at optimal threshold, per-label support counts.
"""

import json
import re
import sys
from pathlib import Path
import numpy as np
from sklearn.metrics import (
    roc_auc_score, average_precision_score,
    precision_recall_curve, roc_curve,
    confusion_matrix
)

DATASET = Path(r"C:\Users\jhers\Downloads\Nreki\django_stgt_dataset.jsonl")
OUTPUT = Path(r"D:\Nreki\scripts\rigorous_eval_ahi.json")
BOOTSTRAP_N = 1000
SEED = 42

BREAKING_PATTERNS = [
    r"\bBREAKING\s+CHANGE\b",
    r"\bBREAKING\b",
    r"\bbackward[s]?[\s-]incompat",
    r"\bremove[ds]?\s+(deprecated|legacy|obsolete)",
    r"\bdrop\s+support\b",
    r"\bdeprecat",
    r"^\s*(refactor|major|api)\!?:\s",
    r"^\s*\w+\!:\s",
    r"\bsemver\s*[:-]?\s*major\b",
    r"\bdrop\s+(python|django)\s+\d",
]
BREAKING_RE = re.compile("|".join(BREAKING_PATTERNS), re.IGNORECASE)

print(f"Loading dataset from {DATASET}...", flush=True)
features = []
labels = []
total = 0
parse_errors = 0
missing_features = 0

with open(DATASET, "r", encoding="utf-8") as f:
    for line in f:
        total += 1
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            parse_errors += 1
            continue
        gap = obj.get("features", {}).get("normalized_gap")
        if gap is None or not np.isfinite(gap):
            missing_features += 1
            continue
        msg = obj.get("commit_msg", "") or ""
        is_breaking = 1 if BREAKING_RE.search(msg) else 0
        features.append(float(gap))
        labels.append(is_breaking)
        if total % 5000 == 0:
            print(f"  {total} lines processed...", flush=True)

X = np.array(features)
y = np.array(labels)
print(f"\nLoaded: {len(X)} usable commits / {total} total")
print(f"  Parse errors: {parse_errors}")
print(f"  Missing features: {missing_features}")
print(f"  Positive (breaking): {y.sum()} ({100*y.mean():.2f}%)")
print(f"  Negative (safe):     {(1-y).sum()} ({100*(1-y.mean()):.2f}%)")

if y.sum() < 10:
    print("ERROR: too few positive labels (<10). Regex too strict or no breaking changes.")
    sys.exit(1)
if y.sum() == len(y) or y.sum() == 0:
    print("ERROR: degenerate labels.")
    sys.exit(1)

gap_mean_breaking = X[y == 1].mean()
gap_mean_safe = X[y == 0].mean()
print(f"\nMean normalized_gap (breaking): {gap_mean_breaking:.4f}")
print(f"Mean normalized_gap (safe):     {gap_mean_safe:.4f}")
print(f"Direction: {'HIGH->breaking' if gap_mean_breaking > gap_mean_safe else 'LOW->breaking'}")

score = X if gap_mean_breaking > gap_mean_safe else -X

roc_auc = roc_auc_score(y, score)
pr_auc = average_precision_score(y, score)
random_baseline = y.mean()
lift = pr_auc / random_baseline if random_baseline > 0 else float("inf")

print(f"\n=== CORE METRICS ===")
print(f"ROC-AUC:           {roc_auc:.4f}")
print(f"PR-AUC:            {pr_auc:.4f}")
print(f"Random PR-AUC:     {random_baseline:.4f}")
print(f"Lift over random:  {lift:.2f}x")

if roc_auc > 0.75:
    verdict_roc = "STRONG_PREDICTIVE"
elif roc_auc > 0.65:
    verdict_roc = "MODERATE_PREDICTIVE"
elif roc_auc > 0.55:
    verdict_roc = "WEAK_PREDICTIVE"
else:
    verdict_roc = "NOT_PREDICTIVE"

if pr_auc > 0.50:
    verdict_pr = "EXCEPTIONAL"
elif pr_auc > 0.40:
    verdict_pr = "STRONG"
elif pr_auc > 0.25:
    verdict_pr = "MODERATE"
elif pr_auc > 2 * random_baseline:
    verdict_pr = "WEAK_BUT_NONRANDOM"
else:
    verdict_pr = "INDISTINGUISHABLE_FROM_RANDOM"

print(f"\nVerdict ROC: {verdict_roc}")
print(f"Verdict PR:  {verdict_pr}")

print(f"\nBootstrapping {BOOTSTRAP_N} iterations for 95% CI...", flush=True)
rng = np.random.default_rng(SEED)
n = len(y)
boot_roc = np.empty(BOOTSTRAP_N)
boot_pr = np.empty(BOOTSTRAP_N)
for i in range(BOOTSTRAP_N):
    idx = rng.integers(0, n, n)
    yb, sb = y[idx], score[idx]
    if yb.sum() == 0 or yb.sum() == n:
        boot_roc[i] = np.nan
        boot_pr[i] = np.nan
        continue
    boot_roc[i] = roc_auc_score(yb, sb)
    boot_pr[i] = average_precision_score(yb, sb)

roc_ci = (np.nanpercentile(boot_roc, 2.5), np.nanpercentile(boot_roc, 97.5))
pr_ci = (np.nanpercentile(boot_pr, 2.5), np.nanpercentile(boot_pr, 97.5))
print(f"ROC-AUC 95% CI: [{roc_ci[0]:.4f}, {roc_ci[1]:.4f}]")
print(f"PR-AUC  95% CI: [{pr_ci[0]:.4f}, {pr_ci[1]:.4f}]")

fpr, tpr, thresholds_roc = roc_curve(y, score)
youden = tpr - fpr
best_idx = int(np.argmax(youden))
best_threshold = float(thresholds_roc[best_idx])
y_pred = (score >= best_threshold).astype(int)
tn, fp, fn, tp = confusion_matrix(y, y_pred).ravel()
precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

print(f"\n=== OPTIMAL THRESHOLD (Youden's J) ===")
print(f"Threshold (on score):  {best_threshold:.4f}")
print(f"  TP: {tp}  FP: {fp}  FN: {fn}  TN: {tn}")
print(f"  Precision: {precision:.4f}")
print(f"  Recall:    {recall:.4f}")
print(f"  F1:        {f1:.4f}")

results = {
    "experiment": "AHI normalized_gap vs commit_msg breaking labels",
    "dataset": str(DATASET),
    "dataset_size_total_lines": total,
    "usable_commits": int(len(X)),
    "parse_errors": parse_errors,
    "missing_features": missing_features,
    "positive_count": int(y.sum()),
    "negative_count": int((1 - y).sum()),
    "positive_rate": float(y.mean()),
    "label_regex_patterns": BREAKING_PATTERNS,
    "feature_direction": "HIGH->breaking" if gap_mean_breaking > gap_mean_safe else "LOW->breaking",
    "gap_mean_breaking": float(gap_mean_breaking),
    "gap_mean_safe": float(gap_mean_safe),
    "roc_auc": float(roc_auc),
    "pr_auc": float(pr_auc),
    "random_pr_baseline": float(random_baseline),
    "lift_over_random": float(lift),
    "verdict_roc": verdict_roc,
    "verdict_pr": verdict_pr,
    "roc_ci_95": [float(roc_ci[0]), float(roc_ci[1])],
    "pr_ci_95": [float(pr_ci[0]), float(pr_ci[1])],
    "bootstrap_iterations": BOOTSTRAP_N,
    "best_threshold": best_threshold,
    "confusion_matrix": {"tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn)},
    "precision": float(precision),
    "recall": float(recall),
    "f1": float(f1),
    "seed": SEED,
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)
print(f"\nResults saved to {OUTPUT}")
