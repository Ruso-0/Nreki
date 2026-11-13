/**
 * Regressions for the bugs found by driving the built server over MCP
 * (2026-11-12): indentation of replace/insert (Python, and nested symbols in
 * batch_edit), the Python empty-block hole in Layer 1, the batch_edit blind
 * rule on small files, type_shape for values, and the mode threshold.
 * Each test failed before its fix.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { semanticEdit, batchSemanticEdit, type EditMode } from "../src/semantic-edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { detectMode } from "../src/detect-mode.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function tmp(prefix: string, files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

/** Apply one edit through `edit` and through `batch_edit`; both must write `expected`. */
async function expectBoth(file: string, source: string, symbol: string, code: string, expected: string, mode: EditMode = "replace") {
    for (const via of ["edit", "batch_edit"] as const) {
        const dir = tmp("nreki-indent-", { [file]: source });
        const abs = path.join(dir, file);
        const res = via === "edit"
            ? await semanticEdit(abs, symbol, code, parser, sandbox, dir, mode)
            : await batchSemanticEdit([{ path: file, symbol, new_code: code, mode }], parser, sandbox, dir);
        expect(res.error, `${via}: ${res.error}`).toBeUndefined();
        expect(res.success, via).toBe(true);
        expect(fs.readFileSync(abs, "utf8"), via).toBe(expected);
    }
}

// ─── Bug 1: indentation of replace / insert ─────────────────────────

const PY_TOP = "def helper(n: int) -> int:\n    return n + 1\n\n\ndef other() -> int:\n    return 2\n";
const PY_CLS = "class A:\n    def m(self):\n        return 1\n\n    def k(self):\n        return 3\n";
const PY_CLS_M2 = "class A:\n    def m(self):\n        return 2\n\n    def k(self):\n        return 3\n";

describe("Python replace/insert keeps the body inside its block", () => {
    it("top-level function, body sent relative to the def", async () => {
        await expectBoth("a.py", PY_TOP, "helper", "def helper(n: int) -> str:\n    return str(n)",
            "def helper(n: int) -> str:\n    return str(n)\n\n\ndef other() -> int:\n    return 2\n");
    });

    it("a body that ends with a closing bracket is still a body", async () => {
        await expectBoth("a.py", PY_TOP, "helper", "def helper(n: int) -> dict:\n    return {\n        \"n\": n,\n    }",
            "def helper(n: int) -> dict:\n    return {\n        \"n\": n,\n    }\n\n\ndef other() -> int:\n    return 2\n");
    });

    it("method: relative, absolute and first-line-trimmed payloads give the same file", async () => {
        await expectBoth("a.py", PY_CLS, "m", "def m(self):\n    return 2", PY_CLS_M2);
        await expectBoth("a.py", PY_CLS, "m", "    def m(self):\n        return 2", PY_CLS_M2);
        await expectBoth("a.py", PY_CLS, "m", "def m(self):\n        return 2", PY_CLS_M2);
    });

    it("method with nested blocks keeps every level", async () => {
        await expectBoth("a.py", PY_CLS, "m", "def m(self):\n    if True:\n        return 2\n    return 3",
            "class A:\n    def m(self):\n        if True:\n            return 2\n        return 3\n\n    def k(self):\n        return 3\n");
    });

    it("multi-line signature: the closing line marks the symbol level, relative or copied from the file", async () => {
        const expected = "class A:\n    def m(\n        self,\n        x: int,\n    ) -> int:\n        return x\n\n    def k(self):\n        return 3\n";
        await expectBoth("a.py", PY_CLS, "m", "def m(\n    self,\n    x: int,\n) -> int:\n    return x", expected);
        await expectBoth("a.py", PY_CLS, "m", "def m(\n        self,\n        x: int,\n    ) -> int:\n        return x", expected);
    });

    it("a decorator line puts the def on the symbol level", async () => {
        const expected = "class A:\n    @staticmethod\n    def m():\n        return 2\n\n    def k(self):\n        return 3\n";
        await expectBoth("a.py", PY_CLS, "m", "@staticmethod\ndef m():\n    return 2", expected);
        await expectBoth("a.py", PY_CLS, "m", "@staticmethod\n    def m():\n        return 2", expected);
    });

    it("a whole class is replaced with its methods nested", async () => {
        await expectBoth("a.py", PY_CLS, "A", "class A:\n    def only(self):\n        return 0",
            "class A:\n    def only(self):\n        return 0\n");
    });

    it("tab-indented file", async () => {
        await expectBoth("a.py", "class A:\n\tdef m(self):\n\t\treturn 1\n", "m", "def m(self):\n\tif True:\n\t\treturn 2\n\treturn 3",
            "class A:\n\tdef m(self):\n\t\tif True:\n\t\t\treturn 2\n\t\treturn 3\n");
    });

    it("insert_after / insert_before at top level", async () => {
        await expectBoth("a.py", PY_TOP, "helper", "def added() -> int:\n    return 7",
            "def helper(n: int) -> int:\n    return n + 1\n\ndef added() -> int:\n    return 7\n\n\ndef other() -> int:\n    return 2\n", "insert_after");
        await expectBoth("a.py", PY_TOP, "other", "def added() -> int:\n    return 7",
            "def helper(n: int) -> int:\n    return n + 1\n\n\ndef added() -> int:\n    return 7\n\ndef other() -> int:\n    return 2\n", "insert_before");
    });

    it("insert_after / insert_before next to a method", async () => {
        const expected = "class A:\n    def m(self):\n        return 1\n\n    def z(self):\n        return 9\n\n    def k(self):\n        return 3\n";
        await expectBoth("a.py", PY_CLS, "m", "def z(self):\n    return 9", expected, "insert_after");
        await expectBoth("a.py", PY_CLS, "k", "def z(self):\n    return 9", expected, "insert_before");
        await expectBoth("a.py", PY_CLS, "k", "    def z(self):\n        return 9", expected, "insert_before");
    });
});

const TS_CLS = "export class A {\n    m(): number {\n        return 1;\n    }\n\n    k(): number {\n        return 3;\n    }\n}\n";

describe("batch_edit indents a nested symbol like edit does", () => {
    it("replace keeps the class indentation on the body and the closing brace", async () => {
        const expected = TS_CLS.replace("return 1;", "return 2;");
        await expectBoth("a.ts", TS_CLS, "m", "m(): number {\n    return 2;\n}", expected);
        await expectBoth("a.ts", TS_CLS, "m", "    m(): number {\n        return 2;\n    }", expected);
        await expectBoth("a.ts", TS_CLS, "m", "m(): number {\n        return 2;\n    }", expected);
    });

    it("insert_after / insert_before keep both symbols indented", async () => {
        const expected = "export class A {\n    m(): number {\n        return 1;\n    }\n\n    z(): number {\n        return 9;\n    }\n\n    k(): number {\n        return 3;\n    }\n}\n";
        await expectBoth("a.ts", TS_CLS, "m", "z(): number {\n    return 9;\n}", expected, "insert_after");
        await expectBoth("a.ts", TS_CLS, "k", "z(): number {\n    return 9;\n}", expected, "insert_before");
    });

    it("Go method body stays tab-indented", async () => {
        const go = "package p\n\ntype T struct{}\n\nfunc (t T) Name() string {\n\treturn \"a\"\n}\n";
        await expectBoth("a.go", go, "Name", "func (t T) Name() string {\n\tif true {\n\t\treturn \"b\"\n\t}\n\treturn \"c\"\n}",
            "package p\n\ntype T struct{}\n\nfunc (t T) Name() string {\n\tif true {\n\t\treturn \"b\"\n\t}\n\treturn \"c\"\n}\n");
    });

    it("several edits in one batch, top-down and nested, all land indented", async () => {
        const dir = tmp("nreki-indent-multi-", { "a.py": PY_CLS, "b.ts": TS_CLS });
        const res = await batchSemanticEdit([
            { path: "a.py", symbol: "m", new_code: "def m(self):\n    return 2" },
            { path: "a.py", symbol: "k", new_code: "def z(self):\n    return 9", mode: "insert_after" },
            { path: "b.ts", symbol: "k", new_code: "k(): number {\n    return 4;\n}" },
            { path: "b.ts", symbol: "m", mode: "patch", search_text: "return 1;", replace_text: "return 5;" },
        ], parser, sandbox, dir);
        expect(res.error).toBeUndefined();
        expect(fs.readFileSync(path.join(dir, "a.py"), "utf8")).toBe(
            "class A:\n    def m(self):\n        return 2\n\n    def k(self):\n        return 3\n\n    def z(self):\n        return 9\n");
        expect(fs.readFileSync(path.join(dir, "b.ts"), "utf8")).toBe(
            "export class A {\n    m(): number {\n        return 5;\n    }\n\n    k(): number {\n        return 4;\n    }\n}\n");
    });
});

// ─── Layer 1: Python "expected an indented block" ───────────────────

describe("Layer 1 rejects a Python block without a body", () => {
    it.each([
        ["function", "def helper(n):\nreturn str(n)\n"],
        ["method on the def's column", "class A:\n    def m(self):\n    return 2\n"],
        ["if", "def f(x):\n    if x:\n    return 1\n    return 2\n"],
        ["class", "class A:\nx = 1\n"],
        ["comment-only body", "def f():\n    # todo\nx = 1\n"],
    ])("%s", async (_label, code) => {
        const res = await sandbox.validateCode(code, "python");
        expect(res.valid).toBe(false);
        expect(res.errors[0].nodeType).toBe("MISSING(indented block)");
        expect(res.suggestion).toContain("missing indented block");
    });

    it.each([
        ["one-liner", "def f(): return 1\n"],
        ["pass", "def f():\n    pass\n"],
        ["docstring only", "def f():\n    \"\"\"doc\"\"\"\n"],
        ["ellipsis", "class P:\n    def f(self) -> int: ...\n"],
        ["nested", "class A:\n    def m(self):\n        if True:\n            return 2\n        return 3\n"],
        ["CRLF", "def f():\r\n    return 1\r\n"],
    ])("valid Python still passes: %s", async (_label, code) => {
        expect((await sandbox.validateCode(code, "python")).valid).toBe(true);
    });

    it("an edit whose payload has no indented body is refused and the file is untouched", async () => {
        for (const via of ["edit", "batch_edit"] as const) {
            const dir = tmp("nreki-pyblock-", { "a.py": PY_TOP });
            const abs = path.join(dir, "a.py");
            const code = "def helper(n: int) -> int:\nreturn n + 2";
            const res = via === "edit"
                ? await semanticEdit(abs, "helper", code, parser, sandbox, dir)
                : await batchSemanticEdit([{ path: "a.py", symbol: "helper", new_code: code }], parser, sandbox, dir);
            expect(res.success, via).toBe(false);
            expect(res.error, via).toContain("indented block");
            expect(fs.readFileSync(abs, "utf8"), via).toBe(PY_TOP);
        }
    });
});

// ─── Bug 4: batch_edit blind rule on small files ────────────────────

describe("batch_edit has the small-file bypass that edit has", () => {
    const small = "export function add(a: number, b: number): number {\n    return a + b;\n}\n";
    const big = Array.from({ length: 150 }, (_, i) => `export function f${i}(): number {\n    return ${i};\n}`).join("\n") + "\n";

    it("does not demand a compress focus on a 3-line file", () => {
        const dir = tmp("nreki-enf-small-", { "math.ts": small });
        const enforcer = new CognitiveEnforcer(dir);
        const single = enforcer.evaluate("nreki_code", "edit", { path: "math.ts", symbol: "add" });
        const batch = enforcer.evaluate("nreki_code", "batch_edit", { edits: [{ path: "math.ts", symbol: "add" }] });
        expect(single.blocked).toBe(false);
        expect(batch.blocked).toBe(false);
    });

    it("still blocks a blind replace on a 450-line file, for both actions", () => {
        const dir = tmp("nreki-enf-big-", { "big.ts": big });
        const enforcer = new CognitiveEnforcer(dir);
        expect(enforcer.evaluate("nreki_code", "edit", { path: "big.ts", symbol: "f3" }).blocked).toBe(true);
        const batch = enforcer.evaluate("nreki_code", "batch_edit", { edits: [{ path: "big.ts", symbol: "f3" }] });
        expect(batch.blocked).toBe(true);
        expect(batch.errorText).toContain("Blind batch_edit");
    });

    it("few lines but 60 KB (minified, generated) is not a small file, for either action", () => {
        const dir = tmp("nreki-enf-wide-", { "bundle.ts": `export const data = "${"x".repeat(60_000)}";\nexport function f(): number { return 1; }\n` });
        const enforcer = new CognitiveEnforcer(dir);
        expect(enforcer.evaluate("nreki_code", "edit", { path: "bundle.ts", symbol: "f" }).blocked).toBe(true);
        expect(enforcer.evaluate("nreki_code", "batch_edit", { edits: [{ path: "bundle.ts", symbol: "f" }] }).blocked).toBe(true);
    });

    it("a batch mixing a small file and a blind edit on a large one is still blocked", () => {
        const dir = tmp("nreki-enf-mix-", { "math.ts": small, "big.ts": big });
        const enforcer = new CognitiveEnforcer(dir);
        const batch = enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [{ path: "math.ts", symbol: "add" }, { path: "big.ts", symbol: "f3" }],
        });
        expect(batch.blocked).toBe(true);
        expect(batch.errorText).toContain("big.ts");
    });
});

// ─── Bug 3: type_shape of values ────────────────────────────────────

describe("type_shape resolves values, not only types", () => {
    function bootTs(files: Record<string, string>): { kernel: NrekiKernel; dir: string } {
        const dir = tmp("nreki-shape-", {
            "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
            ...files,
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        return { kernel, dir };
    }

    it("exported function, const, arrow function and class", () => {
        const { kernel, dir } = bootTs({
            "src/use.ts": [
                "export function total(items: number[]): number {",
                "    return items.length;",
                "}",
                "export const LIMIT = 5;",
                "export const label = (n: number): string => String(n);",
                "export let counter: number | undefined;",
                "export class Box {",
                "    constructor(public size: number) {}",
                "    grow(by: number): Box { return new Box(this.size + by); }",
                "}",
                "",
            ].join("\n"),
        });
        const shape = (s: string) => kernel.getTypeShape(path.join(dir, "src/use.ts"), s);
        expect(shape("total")).toBe("function total(items: number[]): number");
        expect(shape("LIMIT")).toBe("const LIMIT: 5");
        expect(shape("label")).toBe("const label: (n: number) => string");
        expect(shape("counter")).toBe("let counter: number | undefined");
        const box = shape("Box") ?? "";
        expect(box).toContain("class Box");
        expect(box).toContain("size: number");
        expect(box).toContain("grow(by: number): Box");
        expect(box).toContain("new (size: number)");
        for (const s of ["total", "LIMIT", "label", "counter", "Box"]) expect(shape(s)).not.toMatch(/=\s*any\b|:\s*any\b/);
    });

    it("types keep their expanded shape; a non-exported declaration is found too", () => {
        const { kernel, dir } = bootTs({
            "src/types.ts": [
                "export interface Config { name: string; retries?: number; }",
                "export type Mode = \"fast\" | \"safe\";",
                "export type Pair = { left: Config; right: Mode };",
                "export enum Level { Low, High }",
                "function hidden(flag: boolean): Mode { return flag ? \"fast\" : \"safe\"; }",
                "export const used = hidden(true);",
                "",
            ].join("\n"),
        });
        const shape = (s: string) => kernel.getTypeShape(path.join(dir, "src/types.ts"), s);
        expect(shape("Config")).toBe("interface Config { name: string; retries?: number | undefined; }");
        expect(shape("Mode")).toBe("type Mode = \"fast\" | \"safe\"");
        expect(shape("Pair")).toBe("type Pair = { left: Config; right: Mode; }");
        expect(shape("Level")).toBe("enum Level { Low = 0, High = 1 }");
        expect(shape("hidden")).toBe("function hidden(flag: boolean): Mode");
        expect(shape("used")).toBe("const used: Mode");
        expect(shape("nope")).toBeNull();
    });
});

// ─── Design 5: a tsconfig turns the kernel on at any size ───────────

describe("detectMode: project markers switch semantic checking on", () => {
    const tsFiles = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, `export const v${i} = ${i};\n`]));

    it("a small TypeScript project with a tsconfig.json is type-checked (file mode)", () => {
        expect(detectMode(tmp("nreki-mode-ts-", { "tsconfig.json": "{}", ...tsFiles(4) }))).toBe("file");
        expect(detectMode(tmp("nreki-mode-js-", { "jsconfig.json": "{}", "a.js": "export const a = 1;\n" }))).toBe("file");
    });

    it("without any marker a small folder stays syntax-only", () => {
        expect(detectMode(tmp("nreki-mode-none-", tsFiles(4)))).toBe("syntax");
    });

    it("size thresholds above are unchanged", () => {
        expect(detectMode(tmp("nreki-mode-200-", { "tsconfig.json": "{}", ...tsFiles(200) }))).toBe("file");
        expect(detectMode(tmp("nreki-mode-201-", { "tsconfig.json": "{}", ...tsFiles(201) }))).toBe("project");
    });
});
