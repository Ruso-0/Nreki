/**
 * Phase 5 C.4.A metrics tests.
 */

import { describe, it, expect } from "vitest";
import {
    computeFirstHitRecall,
    computeStrictChunkContainment,
    percentile,
    mean,
} from "../../scripts/eval-phase5/metrics.js";
import type { ChunkResult } from "../../scripts/eval-phase5/types-runners.js";
import type { ModifiedNode } from "../../scripts/eval-phase5/types.js";

function chunk(file: string, start = 1, end = 100): ChunkResult {
    return { file_path: file, start_line: start, end_line: end };
}

function node(file: string): ModifiedNode {
    return {
        raw_path: `${file}->program->class:Foo`,
        file_path: file,
        ast_path: ["program"],
        terminal_kind: "class",
        terminal_name: "Foo",
    };
}

describe("computeFirstHitRecall", () => {
    it("returns 1.0 when ground-truth file is at top-1", () => {
        expect(computeFirstHitRecall(["a.ts", "b.ts"], ["a.ts"], 10)).toBe(1.0);
    });

    it("returns 1.0 when ground-truth file is at top-3", () => {
        expect(computeFirstHitRecall(["x.ts", "y.ts", "a.ts", "b.ts"], ["a.ts"], 3)).toBe(1.0);
    });

    it("returns 0.0 when no ground-truth file in top-K", () => {
        expect(computeFirstHitRecall(["x.ts", "y.ts", "z.ts"], ["a.ts"], 3)).toBe(0.0);
    });

    it("returns 0.0 with empty retrieved when truth non-empty", () => {
        expect(computeFirstHitRecall([], ["a.ts"], 10)).toBe(0.0);
    });

    it("returns 1.0 vacuously when ground-truth is empty", () => {
        expect(computeFirstHitRecall(["a.ts", "b.ts"], [], 10)).toBe(1.0);
    });

    it("respects topK cap: a hit beyond K does NOT count", () => {
        expect(computeFirstHitRecall(["x.ts", "y.ts", "a.ts"], ["a.ts"], 2)).toBe(0.0);
    });
});

describe("computeStrictChunkContainment", () => {
    it("returns 1.0 when every modified_node has a matching chunk file", () => {
        const chunks = [chunk("src/a.ts"), chunk("src/b.ts")];
        const nodes = [node("src/a.ts"), node("src/b.ts")];
        expect(computeStrictChunkContainment(chunks, nodes)).toBe(1.0);
    });

    it("returns 0.5 when half the modified_nodes are covered", () => {
        const chunks = [chunk("src/a.ts")];
        const nodes = [node("src/a.ts"), node("src/b.ts")];
        expect(computeStrictChunkContainment(chunks, nodes)).toBe(0.5);
    });

    it("returns 0.0 when no overlap", () => {
        const chunks = [chunk("src/x.ts")];
        const nodes = [node("src/a.ts")];
        expect(computeStrictChunkContainment(chunks, nodes)).toBe(0.0);
    });

    it("returns 1.0 vacuously when modified_nodes is empty", () => {
        const chunks = [chunk("src/a.ts")];
        expect(computeStrictChunkContainment(chunks, [])).toBe(1.0);
    });

    it("treats duplicate chunks on the same file as one match (per-node basis)", () => {
        const chunks = [chunk("src/a.ts", 1, 50), chunk("src/a.ts", 60, 90)];
        const nodes = [node("src/a.ts")];
        expect(computeStrictChunkContainment(chunks, nodes)).toBe(1.0);
    });
});

describe("percentile", () => {
    it("median (p50) of an even-length sample interpolates", () => {
        expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    });

    it("median (p50) of an odd-length sample is the middle element", () => {
        expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it("p95 of a 20-element sample", () => {
        const xs = Array.from({ length: 20 }, (_, i) => i + 1);
        // 19 * 0.95 = 18.05 -> interpolate between sorted[18]=19 and sorted[19]=20 with frac 0.05
        expect(percentile(xs, 95)).toBeCloseTo(19.05, 4);
    });

    it("p99 of a 100-element sample", () => {
        const xs = Array.from({ length: 100 }, (_, i) => i + 1);
        // 99 * 0.99 = 98.01
        expect(percentile(xs, 99)).toBeCloseTo(99.01, 4);
    });

    it("returns NaN on empty input", () => {
        expect(Number.isNaN(percentile([], 50))).toBe(true);
    });

    it("single element returns that element for any p", () => {
        expect(percentile([42], 0)).toBe(42);
        expect(percentile([42], 50)).toBe(42);
        expect(percentile([42], 100)).toBe(42);
    });

    it("clamps p to [0, 100]", () => {
        expect(percentile([1, 2, 3], -10)).toBe(1);
        expect(percentile([1, 2, 3], 150)).toBe(3);
    });
});

describe("mean", () => {
    it("returns the arithmetic mean", () => {
        expect(mean([1, 2, 3, 4])).toBe(2.5);
    });
    it("returns 0 for empty input (convention for aggregate reports)", () => {
        expect(mean([])).toBe(0);
    });
});
