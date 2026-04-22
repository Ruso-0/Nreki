/**
 * @fileoverview Von Neumann Entropy utilities for spectral graph analysis.
 *
 * STATUS (as of v10.13.0): Functions are exported and tested, but NOT
 * integrated into the AHI score. Empirical calibration against Django
 * STGT dataset (18,225 commits) revealed discrimination band of ±0.05
 * (97.6% of values clustered in [0.80, 0.90]). Von Neumann entropy over
 * top-K=10 eigenvalues does not discriminate meaningfully in real codebases
 * — the truncated spectrum converges toward near-uniform distribution
 * (entropy ≈ log(K)) regardless of architectural health.
 *
 * RESERVED FOR v10.14.x INVESTIGATION:
 * Potential redesigns under consideration:
 *   1. Full-spectrum entropy (cost O(N³), likely impractical).
 *   2. Baseline-relative entropy vs Erdős-Rényi null model.
 *   3. Replacement metric: Inverse Participation Ratio (IPR) on Fiedler
 *      vector, Σ|v₂[i]|⁴. Spatial localization measure, O(N), deterministic.
 *      Expected to discriminate hub-localized tension vs distributed stress.
 *
 * Cross-ecosystem validation (JS/TS/Rust/Python miner dataset) required
 * before any metric reintegration to AHI.
 *
 * Original port: Python eval_django_crosseco.py lines 82-88.
 * Uses Math.log (natural, base e). NOT Math.log2 (would scale by 1.44x
 * and destroy cross-ecosystem calibration).
 */

export function vonNeumannEntropy(eigenvalues: readonly number[]): number {
    if (eigenvalues.length === 0) return 0;
    const posEvals = eigenvalues.filter(e => e > 1e-12);
    if (posEvals.length === 0) return 0;
    const sum = posEvals.reduce((a, b) => a + b, 0);
    if (sum <= 1e-12) return 0;
    let entropy = 0;
    for (const v of posEvals) {
        const p = v / sum;
        entropy -= p * Math.log(p);
    }
    return entropy;
}

export function vonNeumannEntropyNormalized(eigenvalues: readonly number[]): number {
    const entropy = vonNeumannEntropy(eigenvalues);
    const posCount = eigenvalues.filter(e => e > 1e-12).length;
    if (posCount <= 1) return 0;
    const maxEntropy = Math.log(posCount);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
}
