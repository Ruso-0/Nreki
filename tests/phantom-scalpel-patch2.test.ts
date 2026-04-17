/**
 * Patch 2 — Phantom Scalpel patch mode must treat replacement string literally.
 *
 * Pre-fix: `applySemanticSplice` used `String.prototype.replace(str, str)`,
 * which still interprets V8 substitution tokens in the replacement string:
 *   $&  → the matched substring
 *   $'  → substring following the match
 *   $`  → substring preceding the match
 *   $$  → literal "$"
 * An LLM patching a shell template with $'quoted' or a regex literal with $&
 * would see silent substitution.
 *
 * Post-fix: split/join treats the replacement purely as data. The
 * occurrences === 1 guard already in place keeps the behavior equivalent
 * to a single replace.
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

describe("Phantom Scalpel: literal $-sequence preservation (Patch 2)", () => {
    it("preserves $& literally in replace_text", () => {
        const content = `function f() { return "foo"; }`;
        const target = makeTarget(content, "f");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `"foo"`, `"$&bar"`,
        );
        expect(result.newContent).toBe(`function f() { return "$&bar"; }`);
        expect(result.newContent).not.toContain(`"foobar"`);
    });

    it("preserves $$ literally (does not collapse to single $)", () => {
        const content = `const price = "PRICE";`;
        const target = makeTarget(content, "price");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `"PRICE"`, `"$$100"`,
        );
        expect(result.newContent).toBe(`const price = "$$100";`);
    });

    it("preserves $' literally (does not splice trailing content)", () => {
        const content = `const cmd = "SHELL";`;
        const target = makeTarget(content, "cmd");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `"SHELL"`, `"$'shell'"`,
        );
        expect(result.newContent).toBe(`const cmd = "$'shell'";`);
    });

    it("preserves $` literally (does not splice leading content)", () => {
        const backtick = String.fromCharCode(96);
        const content = `const tpl = "TPL";`;
        const target = makeTarget(content, "tpl");
        const replacement = `"$` + backtick + `prefix"`;
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `"TPL"`, replacement,
        );
        expect(result.newContent).toBe(`const tpl = ${replacement};`);
    });

    it("preserves $1 literally (would have tried to back-reference a capture group)", () => {
        const content = `const v = "A";`;
        const target = makeTarget(content, "v");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `"A"`, `"$1"`,
        );
        expect(result.newContent).toBe(`const v = "$1";`);
    });

    it("normal (non-$) replacements still work as before (regression)", () => {
        const content = `function g() { return 42; }`;
        const target = makeTarget(content, "g");
        const result = applySemanticSplice(
            content, target, undefined, "patch",
            `42`, `100`,
        );
        expect(result.newContent).toBe(`function g() { return 100; }`);
    });
});
