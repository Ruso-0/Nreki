import { describe, it, expect } from "vitest";
import { SpectralMath, type SparseEdge } from "../../src/kernel/spectral-topology.js";
import { vonNeumannEntropy } from "../../src/spectral/vonNeumann.js";
import { normalizedEigengap } from "../../src/spectral/eigengap.js";

describe("Lanczos-PRO canonical topologies", () => {
    it("Clique K_5 combinatorial: λ₂ = 5.0", () => {
        const edges: SparseEdge[] = [];
        for (let i = 0; i < 5; i++) {
            for (let j = i + 1; j < 5; j++) edges.push({ u: i, v: j, weight: 1 });
        }
        const res = SpectralMath.analyzeTopology(5, edges, false);
        expect(res.fiedler).toBeDefined();
        expect(res.fiedler!).toBeCloseTo(5.0, 6);
    });

    it("Ring N=10 combinatorial: λ₂ = 2 - 2cos(2π/10)", () => {
        const edges: SparseEdge[] = [];
        for (let i = 0; i < 10; i++) edges.push({ u: i, v: (i + 1) % 10, weight: 1 });
        const res = SpectralMath.analyzeTopology(10, edges, false);
        const expected = 2 - 2 * Math.cos(2 * Math.PI / 10);
        expect(res.fiedler!).toBeCloseTo(expected, 6);
    });

    it("Star K_{1,4} normalized: λ₂ = 1.0", () => {
        const edges: SparseEdge[] = [];
        for (let i = 1; i < 5; i++) edges.push({ u: 0, v: i, weight: 1.0 });
        const res = SpectralMath.analyzeTopology(5, edges, true);
        expect(res.fiedler!).toBeCloseTo(1.0, 6);
    });

    it("Clique K_5 normalized: λ₂ = 5/4 = 1.25", () => {
        const edges: SparseEdge[] = [];
        for (let i = 0; i < 5; i++) {
            for (let j = i + 1; j < 5; j++) edges.push({ u: i, v: j, weight: 1.0 });
        }
        const res = SpectralMath.analyzeTopology(5, edges, true);
        expect(res.fiedler!).toBeCloseTo(1.25, 6);
    });

    it("Disconnected components: λ₂ = 0", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1.0 },
            { u: 2, v: 3, weight: 1.0 }
        ];
        const res = SpectralMath.analyzeTopology(4, edges, false);
        expect(res.fiedler!).toBeCloseTo(0.0, 5);
    });

    it("N > 25000 opt-out: fiedler undefined", () => {
        const res = SpectralMath.analyzeTopology(26000, [{ u: 0, v: 1, weight: 1 }], false);
        expect(res.fiedler).toBeUndefined();
        expect(res.volume).toBeDefined();
    });

    it("Eigenvalues array: no zero-padding, variable length", () => {
        const edges: SparseEdge[] = [
            { u: 0, v: 1, weight: 1.0 }, { u: 1, v: 2, weight: 1.0 }
        ];
        const res = SpectralMath.analyzeTopology(3, edges, true);
        if (res.eigenvalues) {
            expect(res.eigenvalues.length).toBeGreaterThan(0);
            expect(res.eigenvalues.includes(0)).toBe(false);
        }
    });
});

describe("Cross-ecosystem numerical validation (Python ground truth)", () => {
    it("vonNeumannEntropy matches Python Numpy within 1e-7", () => {
        // Ground truth from Pipipi Furia Numpy execution:
        //   eigenvalues = [0, 0.059581, 0.161211, 0.228693, 0.360901]
        //   p = pos / pos.sum()
        //   vn = -sum(p * log(p + 1e-9))  # Python hack with +1e-9
        //   Result: 1.2304031755489457
        //
        // TS implementation uses thermal firewall > 1e-12 instead of +1e-9.
        // Expected delta: ~4e-9 (Taylor expansion: p * ln(1 + 1e-9/p) ≈ 1e-9 per eigenvalue).
        const eigenvalues = [0, 0.059581, 0.161211, 0.228693, 0.360901];
        const pythonGroundTruth = 1.2304031755489457;
        const tsVn = vonNeumannEntropy(eigenvalues);
        const delta = Math.abs(tsVn - pythonGroundTruth);
        expect(delta).toBeLessThan(1e-7);
    });
});

describe("normalizedEigengap", () => {
    it("density=0 returns 0", () => {
        expect(normalizedEigengap(0.1, 0.3, 0)).toBe(0);
    });

    it("positive gap produces positive log1p value", () => {
        const result = normalizedEigengap(0.1, 0.5, 0.1);
        expect(result).toBeGreaterThan(0);
    });

    it("zero gap returns 0", () => {
        expect(normalizedEigengap(0.3, 0.3, 0.1)).toBe(0);
    });
});
