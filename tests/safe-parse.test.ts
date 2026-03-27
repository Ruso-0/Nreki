/**
 * Tests for safe-parse.ts — WASM-safe Tree-sitter parsing.
 *
 * Verifies that tree.delete() is ALWAYS called:
 * - On successful callback
 * - On callback that throws
 * - On callback that returns a Promise (resolved)
 * - On callback that returns a Promise (rejected)
 */

import { describe, it, expect, vi } from "vitest";
import { safeParse } from "../src/utils/safe-parse.js";

// Mock a Tree-sitter Parser + Tree
function createMockParser(treeOverrides: Record<string, any> = {}) {
    const mockTree = {
        rootNode: {
            type: "program",
            text: "mock source",
            childCount: 0,
            children: [],
        },
        delete: vi.fn(),
        ...treeOverrides,
    };

    const mockParser = {
        parse: vi.fn().mockReturnValue(mockTree),
    };

    return { mockParser, mockTree };
}

describe("safeParse", () => {
    it("should return callback result on success", () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "const x = 1;", (tree) => {
            expect(tree).toBe(mockTree);
            return 42;
        });

        expect(result).toBe(42);
        expect(mockParser.parse).toHaveBeenCalledWith("const x = 1;");
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should call tree.delete() even when callback throws", () => {
        const { mockParser, mockTree } = createMockParser();

        expect(() => {
            safeParse(mockParser as any, "broken", () => {
                throw new Error("callback exploded");
            });
        }).toThrow("callback exploded");

        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should handle callback returning a resolved Promise", async () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "async code", async (tree) => {
            expect(tree).toBe(mockTree);
            return "async result";
        });

        // safeParse returns the Promise directly
        expect(result).toBeInstanceOf(Promise);
        const resolved = await result;
        expect(resolved).toBe("async result");
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should call tree.delete() when Promise rejects", async () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "failing async", async () => {
            throw new Error("async failure");
        });

        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toThrow("async failure");
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should pass source string to parser.parse()", () => {
        const { mockParser } = createMockParser();

        safeParse(mockParser as any, "function hello() {}", () => "ok");

        expect(mockParser.parse).toHaveBeenCalledWith("function hello() {}");
    });

    it("should handle callback returning null", () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "null return", () => null);

        expect(result).toBeNull();
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should handle callback returning undefined", () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "void return", () => undefined);

        expect(result).toBeUndefined();
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });

    it("should handle empty source string", () => {
        const { mockParser, mockTree } = createMockParser();

        const result = safeParse(mockParser as any, "", (tree) => tree.rootNode.type);

        expect(result).toBe("program");
        expect(mockParser.parse).toHaveBeenCalledWith("");
        expect(mockTree.delete).toHaveBeenCalledOnce();
    });
});
