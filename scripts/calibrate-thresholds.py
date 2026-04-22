#!/usr/bin/env python3
"""
calibrate-thresholds.py — v10.13.0 AHI threshold calibration
from Django STGT dataset (33k+ commits).

Uso:
    python scripts/calibrate-thresholds.py "C:/Users/jhers/Downloads/Nreki/django_stgt_dataset.jsonl"

Output:
    - ASCII histograms for normalized_gap and vonNeumannEntropy distributions.
    - Percentiles P20/P50/P80.
    - Recommended thresholds to replace TENTATIVE values in src/audit.ts.
"""

import json
import math
import sys
from pathlib import Path

# Windows cp1252 cannot encode some chars; force utf-8 stdout.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def von_neumann_entropy_normalized(eigenvalues):
    """
    Mirrors src/spectral/vonNeumann.ts:vonNeumannEntropyNormalized exactly.
    - Thermal firewall: filter e > 1e-12.
    - Math.log (natural log).
    - Normalize by log(posCount) if posCount > 1.
    """
    if not eigenvalues:
        return None
    pos_evals = [e for e in eigenvalues if e > 1e-12]
    if len(pos_evals) <= 1:
        return None
    total = sum(pos_evals)
    if total <= 1e-12:
        return None
    entropy = 0.0
    for v in pos_evals:
        p = v / total
        if p > 0:
            entropy -= p * math.log(p)
    max_entropy = math.log(len(pos_evals))
    if max_entropy <= 0:
        return None
    return entropy / max_entropy


def ascii_histogram(values, title, bins=None):
    """Prints ASCII histogram with custom bin edges."""
    if not values:
        print(f"  {title}: (no data)")
        return
    if bins is None:
        # Auto-bin based on data range
        lo, hi = min(values), max(values)
        if lo == hi:
            print(f"  {title}: all values = {lo:.4f} ({len(values)} samples)")
            return
        bins = [lo + (hi - lo) * i / 8 for i in range(9)]

    counts = [0] * (len(bins) - 1)
    total = len(values)
    for v in values:
        for i in range(len(bins) - 1):
            if bins[i] <= v < bins[i + 1]:
                counts[i] += 1
                break
        else:
            if v >= bins[-1]:
                counts[-1] += 1

    max_count = max(counts) if counts else 1
    print(f"  {title}:")
    for i in range(len(bins) - 1):
        pct = 100 * counts[i] / total
        bar_len = int(40 * counts[i] / max_count)
        bar = "#" * bar_len
        print(f"    [{bins[i]:7.3f} - {bins[i+1]:7.3f})  {bar:<40} {counts[i]:5d} ({pct:5.1f}%)")


def percentile(sorted_values, p):
    """Returns percentile p (0-100) from sorted list. No numpy dependency."""
    if not sorted_values:
        return None
    k = (len(sorted_values) - 1) * (p / 100)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_values[int(k)]
    return sorted_values[f] * (c - k) + sorted_values[c] * (k - f)


def main():
    if len(sys.argv) < 2:
        print("Usage: python calibrate-thresholds.py <path_to_jsonl>")
        sys.exit(1)

    jsonl_path = Path(sys.argv[1])
    if not jsonl_path.exists():
        print(f"ERROR: File not found: {jsonl_path}")
        sys.exit(1)

    print(f"Reading: {jsonl_path}")
    print(f"Size: {jsonl_path.stat().st_size / (1024**3):.2f} GB")
    print()

    normalized_gaps = []
    entropies = []
    total_records = 0
    skipped_no_features = 0
    skipped_no_eigenvalues = 0
    skipped_no_gap = 0
    skipped_entropy_fail = 0

    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            total_records += 1

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            features = record.get("features")
            if not features:
                skipped_no_features += 1
                continue

            # normalized_gap (pre-computed by miner)
            n_gap = features.get("normalized_gap")
            if n_gap is not None and isinstance(n_gap, (int, float)) and math.isfinite(n_gap):
                normalized_gaps.append(n_gap)
            else:
                skipped_no_gap += 1

            # eigenvalues for vonNeumann entropy
            eigs = features.get("eigenvalues")
            if not eigs or not isinstance(eigs, list):
                skipped_no_eigenvalues += 1
                continue

            vn_norm = von_neumann_entropy_normalized(eigs)
            if vn_norm is None:
                skipped_entropy_fail += 1
                continue
            entropies.append(vn_norm)

            # Progress every 5k records
            if line_num % 5000 == 0:
                print(f"  Processed {line_num:,} records...", file=sys.stderr)

    print(f"\n=== DJANGO STGT DATASET — CALIBRATION RESULTS ===\n")
    print(f"Total records parsed:        {total_records:>6,}")
    print(f"Valid normalized_gap:        {len(normalized_gaps):>6,}")
    print(f"Valid entropy computations:  {len(entropies):>6,}")
    print(f"Skipped (no features):       {skipped_no_features:>6,}")
    print(f"Skipped (no eigenvalues):    {skipped_no_eigenvalues:>6,}")
    print(f"Skipped (no gap):            {skipped_no_gap:>6,}")
    print(f"Skipped (entropy failed):    {skipped_entropy_fail:>6,}")
    print()

    # --- EIGENGAP DISTRIBUTION ---
    print("=" * 70)
    print("EIGENGAP INTEGRITY — normalized_gap distribution")
    print("=" * 70)
    if normalized_gaps:
        sorted_gaps = sorted(normalized_gaps)
        print(f"\nStats: min={sorted_gaps[0]:.4f}, max={sorted_gaps[-1]:.4f}, mean={sum(sorted_gaps)/len(sorted_gaps):.4f}")
        print()

        # Custom bins matching current TENTATIVE thresholds
        bins = [0, 0.1, 0.3, 0.5, 1.0, 2.0, 5.0, 10.0, max(sorted_gaps[-1], 10.001)]
        ascii_histogram(normalized_gaps, "Distribution", bins=bins)

        p20 = percentile(sorted_gaps, 20)
        p50 = percentile(sorted_gaps, 50)
        p80 = percentile(sorted_gaps, 80)
        p90 = percentile(sorted_gaps, 90)
        p95 = percentile(sorted_gaps, 95)

        print(f"\nPercentiles:")
        print(f"  P20 (low-gap, risk):     {p20:7.4f}")
        print(f"  P50 (median):            {p50:7.4f}")
        print(f"  P80 (high-gap, healthy): {p80:7.4f}")
        print(f"  P90:                     {p90:7.4f}")
        print(f"  P95:                     {p95:7.4f}")

        print(f"\nCurrent TENTATIVE thresholds: [5.0, 2.0, 0.5]  (healthy -> warning -> critical)")
        print(f"\nRecommended calibrated thresholds (P80, P50, P20):")
        print(f"  [{p80:.2f}, {p50:.2f}, {p20:.2f}]")
        print(f"\nPaste into src/audit.ts:")
        print(f"  eigengapScore = bucketScore(normalizedGap, [{p80:.2f}, {p50:.2f}, {p20:.2f}]);")
    else:
        print("(No valid data)")

    # --- ENTROPY DISTRIBUTION ---
    print()
    print("=" * 70)
    print("SPECTRAL ENTROPY — vonNeumannEntropyNormalized distribution")
    print("=" * 70)
    if entropies:
        sorted_ent = sorted(entropies)
        print(f"\nStats: min={sorted_ent[0]:.4f}, max={sorted_ent[-1]:.4f}, mean={sum(sorted_ent)/len(sorted_ent):.4f}")
        print()

        bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
        ascii_histogram(entropies, "Distribution", bins=bins)

        p20 = percentile(sorted_ent, 20)
        p50 = percentile(sorted_ent, 50)
        p80 = percentile(sorted_ent, 80)

        print(f"\nPercentiles:")
        print(f"  P20 (low-entropy, healthy):   {p20:7.4f}")
        print(f"  P50 (median):                 {p50:7.4f}")
        print(f"  P80 (high-entropy, chaos):    {p80:7.4f}")

        print(f"\nCurrent TENTATIVE thresholds (bucketScoreInverse): [0.3, 0.6, 0.8]  (healthy -> warning -> critical)")
        print(f"\nRecommended calibrated thresholds (P20, P50, P80):")
        print(f"  [{p20:.2f}, {p50:.2f}, {p80:.2f}]")
        print(f"\nPaste into src/audit.ts:")
        print(f"  entropyScore = bucketScoreInverse(normalizedEntropy, [{p20:.2f}, {p50:.2f}, {p80:.2f}]);")
    else:
        print("(No valid data)")

    print()
    print("=" * 70)
    print("NEXT STEPS:")
    print("  1. Review distributions above. Confirm shapes look reasonable.")
    print("  2. Pass this script to Pipipi Furia for formula audit.")
    print("  3. If approved, update src/audit.ts with calibrated thresholds.")
    print("  4. Update comments: 'TENTATIVE' -> 'Calibrated from Django STGT (N records)'.")
    print("  5. Re-run npm test to confirm 827/827 still green.")
    print("  6. Commit + Phase 4 release.")
    print("=" * 70)


if __name__ == "__main__":
    main()
