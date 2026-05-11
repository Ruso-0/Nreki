/**
 * Phase 5 C.3.B query-construction tests.
 *
 * Pure unit tests for identifier + file path extraction and the
 * hybrid `constructQuery` helper. No I/O, no mocking required.
 */

import { describe, it, expect } from "vitest";
import {
    extractIdentifiers,
    extractFilePaths,
    constructQuery,
} from "../../../scripts/eval-phase5/runners/query-construction.js";

describe("extractIdentifiers", () => {
    it("captures PascalCase, camelCase, and short literals above the 3-char floor", () => {
        const ids = extractIdentifiers("SuggestModel.triggerWith(null)");
        expect(ids).toContain("SuggestModel");
        expect(ids).toContain("triggerWith");
        // "null" is 4 chars, not a stopword in our IR list → kept
        // per spec note.
        expect(ids).toContain("null");
    });

    it("filters stopwords and 1-2 char tokens", () => {
        // Every word is either a stopword (the/is/when/or) or under
        // the 3-char floor (a/x/y) — output must be empty.
        const ids = extractIdentifiers("the is when a is x or y");
        expect(ids).toEqual([]);
    });

    it("captures snake_case identifiers", () => {
        const ids = extractIdentifiers("see parse_modified_nodes() and other_helper");
        expect(ids).toContain("parse_modified_nodes");
        expect(ids).toContain("other_helper");
    });

    it("captures dotted paths like a.b.c", () => {
        const ids = extractIdentifiers("logger.info.format spans nested calls");
        expect(ids).toContain("logger.info.format");
    });

    it("dedups identifiers across multiple regex passes", () => {
        const ids = extractIdentifiers("Foo Foo Foo Bar Bar");
        expect(ids.filter(x => x === "Foo")).toHaveLength(1);
        expect(ids.filter(x => x === "Bar")).toHaveLength(1);
    });

    it("skips pure-digit tokens", () => {
        const ids = extractIdentifiers("error 12345 occurred near foo");
        expect(ids).not.toContain("12345");
        expect(ids).toContain("foo");
    });
});

describe("extractFilePaths", () => {
    it("captures forward-slash paths", () => {
        const paths = extractFilePaths("see src/foo.ts and packages/x/bar.ts");
        expect(paths).toEqual(["src/foo.ts", "packages/x/bar.ts"]);
    });

    it("normalizes backslashes to forward slashes", () => {
        const paths = extractFilePaths("look at src\\handlers\\navigate.ts please");
        expect(paths).toContain("src/handlers/navigate.ts");
    });

    it("dedups repeated paths", () => {
        const paths = extractFilePaths("src/foo.ts and src/foo.ts again");
        expect(paths).toEqual(["src/foo.ts"]);
    });

    it("covers ts/tsx/js/jsx/json/md", () => {
        const paths = extractFilePaths(
            "a/x.ts b/y.tsx c/z.js d/w.jsx e/m.json f/n.md",
        );
        expect(paths).toEqual([
            "a/x.ts",
            "b/y.tsx",
            "c/z.js",
            "d/w.jsx",
            "e/m.json",
            "f/n.md",
        ]);
    });
});

describe("constructQuery", () => {
    it("returns file paths before identifiers", () => {
        const q = constructQuery(
            "SuggestModel.triggerWith breaks when src/foo.ts is empty",
        );
        const fileIdx = q.indexOf("src/foo.ts");
        const idIdx = q.indexOf("SuggestModel");
        expect(fileIdx).toBeGreaterThanOrEqual(0);
        expect(idIdx).toBeGreaterThan(fileIdx);
    });

    it("dedups across categories and within a category", () => {
        const q = constructQuery("Foo Foo Foo Foo Foo");
        expect(q).toEqual(["Foo"]);
    });

    it("respects maxKeywords cap", () => {
        const text = Array.from({ length: 50 }, (_, i) => `Identifier${i}`).join(" ");
        const q = constructQuery(text, 10);
        expect(q.length).toBeLessThanOrEqual(10);
    });

    it("produces a non-empty query for a realistic PolyBench-style statement", () => {
        const q = constructQuery(
            "SuggestModel.triggerWith returns wrong completions when context is null. " +
                "See src/SuggestModel.ts and CompletionModel._createCachedState.",
        );
        expect(q.length).toBeGreaterThan(3);
        expect(q).toContain("src/SuggestModel.ts");
        expect(q).toContain("SuggestModel");
        expect(q).toContain("triggerWith");
        expect(q).toContain("CompletionModel");
    });
});
