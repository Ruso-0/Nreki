/**
 * eigengap.ts — Normalized spectral gap for cluster separation quality
 *
 * Formula from chronos-miner.ts line 790:
 *   gap = λ₃ - λ₂
 *   normalized = sign(gap) * log1p(|gap / density|)
 *
 * NOT normalized by λ_avg: for L_sym trace=N so λ_avg=1.0 on full
 * spectrum (useless). Density normalization is physically correct.
 */

export function normalizedEigengap(
    fiedler: number,
    lambda3: number,
    density: number,
): number {
    if (density <= 1e-12) return 0;
    const gap = lambda3 - fiedler;
    const safeNorm = Math.min(Math.abs(gap / density), 30.0);
    const result = Math.log1p(safeNorm);
    return gap < 0 ? -result : result;
}
