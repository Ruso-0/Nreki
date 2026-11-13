/**
 * Compressor fidelity regressions (v12.0.1).
 *
 * Measured on v12.0.0: comment stripping by regex cut string literals
 * (`"https:`), turned `startsWith("//")` into `startsWith("")`, deleted whole
 * lines between the `/*` of one glob string and the `*\/` of another, removed
 * every Python triple-quoted string, and Stage 2 token filtering turned
 * "the file is never written" into "file written". `read` also returned a
 * skeleton by default without saying what was omitted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { AdvancedCompressor } from "../src/compressor.js";
import { ASTParser } from "../src/parser.js";
import { NrekiEngine } from "../src/engine.js";
import { handleRead, handleCompress } from "../src/handlers/code/read.js";
import type { RouterDependencies } from "../src/router.js";

let compressor: AdvancedCompressor;
beforeAll(async () => {
    const parser = new ASTParser();
    await parser.initialize();
    compressor = new AdvancedCompressor(parser);
});

const light = async (file: string, code: string) => (await compressor.compress(file, code, "light")).compressed;

/** A function large enough that a skeleton is genuinely shorter than the code. */
function realisticFn(i: number): string {
    return [
        `export function process${i}(items: number[], limit: number): number[] {`,
        `    const result: number[] = [];`,
        `    for (const item of items) {`,
        `        const scaled = item * ${i} + limit;`,
        `        if (scaled > limit * 2) {`,
        `            result.push(Math.round(scaled / 3));`,
        `        } else if (scaled < 0) {`,
        `            result.push(0);`,
        `        } else {`,
        `            result.push(scaled);`,
        `        }`,
        `    }`,
        `    const total = result.reduce((a, b) => a + b, 0);`,
        `    if (total === 0) {`,
        `        return [];`,
        `    }`,
        `    return result.filter(v => v !== ${i});`,
        `}`,
        ``,
    ].join("\n");
}

describe("Stage 1 never touches strings, regexes or JSX text", () => {
    it("keeps URLs, globs, regex literals and template literals; removes real comments", async () => {
        const code = [
            'const files = ["**/*.js", "**/*.jsx", "**/*.ts"];',
            'const url = "https://registry.npmjs.org/pkg";',
            "const re = /\\/\\/[^\\n]*/g; // strip comments",
            'const stub = `/*[nreki:${n}L]*/`;',
            'if (line.startsWith("//") || line.startsWith("/*")) skip();',
            "/* real block comment */",
            "export const keep = 1; // trailing comment",
        ].join("\n");
        const out = await light("sample.ts", code);
        expect(out).toContain('const files = ["**/*.js", "**/*.jsx", "**/*.ts"];');
        expect(out).toContain('const url = "https://registry.npmjs.org/pkg";');
        expect(out).toContain("const re = /\\/\\/[^\\n]*/g;");
        expect(out).toContain('const stub = `/*[nreki:${n}L]*/`;');
        expect(out).toContain('if (line.startsWith("//") || line.startsWith("/*")) skip();');
        expect(out).toContain("export const keep = 1;");
        expect(out).not.toContain("strip comments");
        expect(out).not.toContain("real block comment");
        expect(out).not.toContain("trailing comment");
    });

    it("keeps `//` that is JSX text, removes the real comment", async () => {
        const code = 'export const A = () => <a href="https://x.dev">see https://x.dev // docs</a>; // real\n';
        const out = await light("a.tsx", code);
        expect(out).toContain('<a href="https://x.dev">see https://x.dev // docs</a>;');
        expect(out).not.toContain("// real");
    });

    it("keeps `debugger` inside strings, removes debugger statements and console calls", async () => {
        const code = 'const msg = "attach the debugger; then continue";\ndebugger;\nconsole.log("noise");\nexport const x = msg;\n';
        const out = await light("d.ts", code);
        expect(out).toContain('"attach the debugger; then continue"');
        expect(out).not.toMatch(/^debugger;/m);
        expect(out).not.toContain('console.log("noise")');
    });

    it("CSS: keeps url(http://…), removes /* comments */", async () => {
        const out = await light("a.css", "a { background: url(http://x.dev/y.png); } /* note */\n");
        expect(out).toContain("url(http://x.dev/y.png)");
        expect(out).not.toContain("note");
    });

    it("Python: only docstrings / bare strings go — value strings and # in strings stay", async () => {
        const code = [
            '"""Module docstring."""',
            'SQL = """SELECT * FROM t -- not a comment"""',
            'TAG = "#not-a-comment"',
            "def f():",
            '    """Function docstring."""',
            "    print(\"debug\")  # trailing comment",
            "    return SQL",
            "",
            "def only_doc():",
            '    """Only a docstring: keep it so the body is not empty."""',
            "",
        ].join("\n");
        const out = await light("m.py", code);
        expect(out).not.toContain("Module docstring");
        expect(out).not.toContain("Function docstring");
        expect(out).toContain('SQL = """SELECT * FROM t -- not a comment"""');
        expect(out).toContain('TAG = "#not-a-comment"');
        expect(out).not.toContain("trailing comment");
        expect(out).not.toContain('print("debug")');
        expect(out).toContain("Only a docstring");
    });
});

describe("No lossy token filtering in the output", () => {
    const prose = [
        "# Title",
        "",
        "**NREKI validates edits in RAM before they touch disk.** The file is never written when validation fails.",
        "Wrap it with `cmd /c`, otherwise Claude Code warns that the server failed to start.",
        '<img src="https://img.shields.io/badge/x" alt="badge">',
        "",
    ].join("\n");

    it.each(["medium", "aggressive"] as const)("%s never drops words from prose", async (level) => {
        const res = await compressor.compress("README.md", prose, level);
        expect(res.compressed).toContain("The file is never written when validation fails.");
        expect(res.compressed).toContain("otherwise Claude Code warns that the server failed to start");
        expect(res.compressed).toContain('<img src="https://img.shields.io/badge/x"');
        expect(res.breakdown.tokenFilterReduction).toBe(0);
    });

    it("medium on code is a structural skeleton built from real source lines", async () => {
        const fns = Array.from({ length: 12 }, (_, i) => realisticFn(i)).join("\n");
        const res = await compressor.compress("m.ts", fns, "medium");
        expect(res.breakdown.structuralReduction).toBeGreaterThan(0);
        expect(res.compressed).toContain("export function process11(items: number[], limit: number): number[]");
        for (const line of res.compressed.split("\n").map(l => l.trim()).filter(l => l.startsWith("return ") || l.startsWith("const "))) {
            expect(fns).toContain(line);
        }
    });
});

describe("read is verbatim by default; skeletons are labeled", () => {
    let dir: string;
    let deps: RouterDependencies;
    let engine: NrekiEngine;
    const body = Array.from({ length: 30 }, (_, i) => realisticFn(i)).join("\n");

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-read-default-"));
        fs.writeFileSync(path.join(dir, "big.ts"), body);
        engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki-test.db"), watchPaths: [dir] });
        await engine.initialize();
        deps = { engine } as unknown as RouterDependencies;
    });
    afterAll(() => {
        try { engine.shutdown(); } catch { /* best effort */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it("returns the file verbatim when compress is not requested", async () => {
        const res = await handleRead({ action: "read", path: "big.ts" }, deps);
        const text = res.content[0].text ?? "";
        expect(text).toContain("(raw)");
        expect(text).toContain("const scaled = item * 17 + limit;");
    });

    it("compress:true returns a skeleton that says so, in tokens", async () => {
        const res = await handleRead({ action: "read", path: "big.ts", compress: true }, deps);
        const text = res.content[0].text ?? "";
        expect(text).toMatch(/SKELETON/);
        expect(text).toMatch(/tokens \(\d+% fewer\)/);
        expect(text).toContain('compress focus:"<symbol>"');
    });

    it("when a skeleton would not be shorter, medium returns the code and says so", async () => {
        const small = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n");
        const res = await compressor.compress("small.ts", small, "medium");
        expect(res.breakdown.structuralReduction).toBe(0);
        expect(res.compressed).toContain("export const v39 = 39;");
    });

    it("compress level / legacy tier headers describe what was omitted", async () => {
        const lvl = (await handleCompress({ action: "compress", path: "big.ts", level: "aggressive" }, deps)).content[0].text ?? "";
        expect(lvl).toContain("SKELETON: signatures only");
        const tier = (await handleCompress({ action: "compress", path: "big.ts" }, deps)).content[0].text ?? "";
        expect(tier).toContain("SKELETON: signatures only, bodies omitted");
        expect(tier).toMatch(/tokens \(\d+% fewer\)/);
    });
});
