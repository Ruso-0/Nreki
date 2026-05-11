/**
 * Phase 5 C.3.E.1 tokenizer tests. Verifies the cl100k_base
 * singleton + payloadTokens aggregation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    computeTokenCost,
    payloadTokens,
    getTokenizerCallCount,
    _resetTokenizerCallCount,
} from "../../../scripts/eval-phase5/utils/tokenizer.js";

describe("computeTokenCost", () => {
    beforeEach(() => _resetTokenizerCallCount());

    it("returns 0 for empty string and does NOT touch the encoder", () => {
        expect(computeTokenCost("")).toBe(0);
        expect(getTokenizerCallCount()).toBe(0);
    });

    it("returns a positive integer for non-trivial text", () => {
        const n = computeTokenCost("export function foo(): number { return 1; }");
        expect(n).toBeGreaterThan(0);
        expect(Number.isInteger(n)).toBe(true);
    });

    it("reuses the singleton encoder across calls", () => {
        computeTokenCost("alpha");
        computeTokenCost("beta gamma");
        computeTokenCost("delta epsilon zeta");
        // 3 calls served, 1 encoder instance.
        expect(getTokenizerCallCount()).toBe(3);
    });

    it("counts more tokens for longer text", () => {
        const a = computeTokenCost("hello");
        const b = computeTokenCost("hello world hello world hello world");
        expect(b).toBeGreaterThan(a);
    });
});

describe("payloadTokens", () => {
    beforeEach(() => _resetTokenizerCallCount());

    it("returns zeroed TokenCost for an empty parts array", () => {
        const tc = payloadTokens([]);
        expect(tc).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    });

    it("sums computeTokenCost across parts", () => {
        const a = computeTokenCost("alpha beta");
        const b = computeTokenCost("gamma delta");
        const tc = payloadTokens(["alpha beta", "gamma delta"]);
        expect(tc.input_tokens).toBe(a + b);
        expect(tc.total_tokens).toBe(a + b);
        expect(tc.output_tokens).toBe(0);
    });

    it("ignores empty strings in the parts array", () => {
        const tc = payloadTokens(["", "", ""]);
        expect(tc.total_tokens).toBe(0);
    });
});
