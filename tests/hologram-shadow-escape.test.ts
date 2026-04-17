/**
 * Patch 6 (v10.6) — shadow-generator escape-loop fix in three functions:
 * `stripParameterDefaults`, `splitAndCleanParams`, `cleanSingleParam`.
 *
 * Pre-fix: the heuristic `params[i-1] !== "\\"` misread strings ending in
 * an escaped backslash pair (e.g. `"C:\\"`) — the final `\` was seen as
 * escaping the closing quote, so the parser kept running INSIDE the
 * string past its actual terminator. That corrupted signatures with
 * Windows paths, escape sequences, or any string ending in `\\`.
 *
 * Post-fix: the skip-next-char pattern (already in peer `splitParams`).
 * On `\`, advance past the next char; quote termination becomes a simple
 * equality check with no lookback.
 *
 * The three fixed functions are file-private, so we exercise them
 * end-to-end through `classifyAndGenerateShadow`. The critical assertion
 * is "does not throw / does not produce a corrupted shadow": pre-fix the
 * parser bled past the closing `)` of the parameter list into the return
 * type or subsequent declarations.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Parser from "web-tree-sitter";
import path from "path";
import { fileURLToPath } from "url";
import { classifyAndGenerateShadow } from "../src/hologram/shadow-generator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(__dirname, "..", "wasm");

let parser: Parser;
let tsLanguage: Parser.Language;

beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    tsLanguage = await Parser.Language.load(
        path.join(wasmDir, "tree-sitter-typescript.wasm"),
    );
});

function classify(content: string) {
    return classifyAndGenerateShadow("test.ts", content, parser, tsLanguage);
}

describe("shadow generator: escape-loop in parameter parsing (Patch 6 / v10.6)", () => {
    it("parses a default value ending with an escaped backslash without throwing", () => {
        // Raw TS: "C:\\" — one-char string containing a single backslash.
        const src = `export function init(p: string = "C:\\\\"): string { return p; }`;
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        // Shadow may be null if classifier marks as inferred, but must not
        // be a corrupted string that bled past the params.
        if (result.shadow !== null) {
            expect(result.shadow).toContain("function init");
            // `: string` return type must survive as a separate token
            // (pre-fix, parser bled into it).
            expect(result.shadow).toMatch(/\)\s*:\s*string/);
        }
    });

    it("splits two params correctly when the first ends with a backslash-string", () => {
        // Raw TS: "one\\", 42 — pre-fix, the comma would have been seen as
        // still-inside-string and the two params would have merged.
        const src = `export function f(a: string = "one\\\\", b: number = 42): number { return b; }`;
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        if (result.shadow !== null) {
            expect(result.shadow).toContain("a: string");
            expect(result.shadow).toContain("b: number");
            expect(result.shadow).toMatch(/\)\s*:\s*number/);
        }
    });

    it("cleanSingleParam does not bleed past a backslash-terminated default", () => {
        // Raw TS: "esc\\" — tests cleanSingleParam's = seek logic.
        const src = `export function g(msg: string = "esc\\\\"): string { return msg; }`;
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        if (result.shadow !== null) {
            expect(result.shadow).toContain("msg: string");
            // Return type survived.
            expect(result.shadow).toMatch(/\)\s*:\s*string/);
        }
    });

    it("handles template-literal default ending with backslash (backtick branch)", () => {
        const src = "export function h(t: string = `line\\\\`): string { return t; }";
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        if (result.shadow !== null) {
            expect(result.shadow).toContain("t: string");
        }
    });

    it("preserves return type when params end with an escaped-backslash string", () => {
        // Regression: the canonical failure mode was the return type getting
        // swallowed as part of the parameter list.
        const src = `export function j(a: string = "x\\\\"): number { return 42; }`;
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        if (result.shadow !== null) {
            expect(result.shadow).toContain("function j");
            expect(result.shadow).toMatch(/\)\s*:\s*number/);
        }
    });

    it("no-default case (regression: the fix must not break normal params)", () => {
        const src = `export function k(a: string, b: number): string { return a + b; }`;
        expect(() => classify(src)).not.toThrow();
        const result = classify(src);
        if (result.shadow !== null) {
            expect(result.shadow).toContain("a: string");
            expect(result.shadow).toContain("b: number");
        }
    });
});
