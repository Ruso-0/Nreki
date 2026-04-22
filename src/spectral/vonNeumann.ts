/**
 * vonNeumann.ts — Von Neumann entropy on normalized Laplacian spectrum
 *
 * Port of Python eval_django_crosseco.py lines 82-88.
 * Empirically validated: ROC-AUC 0.9070 cross-ecosystem (JS/TS → Django).
 *
 * Uses Math.log (natural, base e). NOT Math.log2.
 * Python np.log is natural log; using log2 would scale by 1.44x and
 * destroy cross-ecosystem calibration.
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
