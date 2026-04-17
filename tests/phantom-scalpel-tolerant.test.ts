/**
 * Patch 3 extension (v10.5.8) — Tolerant Patch: indent-tolerant fuzzy matching.
 *
 * Motivation: LLMs often infer search_text indentation from memory rather than
 * reading the live file. If the exact indentation is wrong but the logical
 * content is unique inside the symbol, an exact-only patch fails with a
 * frustrating "whitespace must match exactly" error — even when the intent is
 * unambiguous.
 *
 * Tier 1: exact match (fast path, preserved behavior).
 * Tier 2: when Tier 1 yields 0 occurrences, retry with an indent-flexible
 *         regex. If exactly one match is found, rebase the replacement's
 *         indentation onto the original's indentation and proceed.
 */
import { describe, it, expect } from "vitest";
import { applySemanticSplice, type SpliceTarget } from "../src/semantic-edit.js";

function makeTarget(content: string, symbolName: string): SpliceTarget {
    return {
        startIndex: 0,
        endIndex: content.length,
        rawCode: content,
        symbolName,
        startLine: 1,
    };
}

describe("Phantom Scalpel: Tolerant Patch (Patch 3 / v10.5.8)", () => {
    it("fuzzy match succeeds when search_text has different indentation than source", () => {
        const content = [
            "function f() {",
            "    if (x) {",
            "        doWork();",
            "    }",
            "}",
        ].join("\n");
        const target = makeTarget(content, "f");

        // Agent sends search_text with 0-space indent, source has 8-space indent.
        const search = "doWork();";
        const replace = "doBetterWork();";

        const result = applySemanticSplice(content, target, undefined, "patch", search, replace);
        expect(result.newContent).toContain("doBetterWork();");
        expect(result.newContent).not.toContain("doWork();");
        // The 8-space indent must be preserved on the replaced line.
        expect(result.newContent).toContain("        doBetterWork();");
    });

    it("fuzzy match rebases multi-line replacement indent onto original indent", () => {
        const content = [
            "function g() {",
            "    if (flag) {",
            "        console.log(\"a\");",
            "        console.log(\"b\");",
            "    }",
            "}",
        ].join("\n");
        const target = makeTarget(content, "g");

        // Agent sends search + replace at 0-indent (inferred from memory).
        const search = [
            "console.log(\"a\");",
            "console.log(\"b\");",
        ].join("\n");
        const replace = [
            "console.log(\"x\");",
            "console.log(\"y\");",
        ].join("\n");

        const result = applySemanticSplice(content, target, undefined, "patch", search, replace);
        // Both replaced lines must inherit the original 8-space indent.
        expect(result.newContent).toContain("        console.log(\"x\");");
        expect(result.newContent).toContain("        console.log(\"y\");");
        expect(result.newContent).not.toContain("console.log(\"a\")");
    });

    it("fuzzy match is ambiguous when 2+ indent-tolerant matches exist — throws", () => {
        const content = [
            "function h() {",
            "    x = 1;",
            "    if (cond) {",
            "        x = 1;", // same logical content, different indent
            "    }",
            "}",
        ].join("\n");
        const target = makeTarget(content, "h");

        expect(() =>
            applySemanticSplice(content, target, undefined, "patch", "x = 1;", "x = 2;")
        ).toThrow(/ambiguous|found 2 times/i);
    });

    it("exact match is still the fast path (no fuzzy fallback needed)", () => {
        const content = "function i() { return 42; }";
        const target = makeTarget(content, "i");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            "return 42;", "return 100;",
        );
        expect(result.newContent).toBe("function i() { return 100; }");
    });

    it("not found in either tier throws with updated error message", () => {
        const content = "function j() { return 1; }";
        const target = makeTarget(content, "j");

        expect(() =>
            applySemanticSplice(content, target, undefined, "patch", "totallyNotInTheCode", "x")
        ).toThrow(/indentation-tolerant match not found/);
    });

    it("tolerant match preserves $ literally (Patch 2 behavior extends to fuzzy)", () => {
        const content = [
            "function k() {",
            "    const s = \"TOKEN\";",
            "}",
        ].join("\n");
        const target = makeTarget(content, "k");

        // 0-indent search; fuzzy tier fires and rebases to 4-space indent.
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            "const s = \"TOKEN\";", "const s = \"$&\";",
        );
        expect(result.newContent).toContain("const s = \"$&\";");
        expect(result.newContent).not.toContain("const s = \"TOKEN\";");
    });
});
