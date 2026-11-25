import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nativeEditContent, validateNativeEdit } from "../src/hooks/native-edit-validator.js";
import { NrekiEngine } from "../src/engine.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { NativeEditRequest } from "../src/hooks/native-edit-ipc.js";
import type { RouterDependencies } from "../src/router.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
const edit = (old_string: string, new_string: string, replace_all?: boolean): NativeEditRequest => ({
    tool_name: "Edit", tool_input: { file_path: "a.ts", old_string, new_string, replace_all },
});

function fixture(): { root: string; file: string; deps: RouterDependencies } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-native-validator-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, target: "ES2022" }, include: ["*.ts"],
    }));
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const count: number = 1;\n");
    const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
    const sandbox = new AstSandbox();
    const kernel = new NrekiKernel();
    cleanup.push(() => { engine.shutdown(); sandbox.shutdown(); });
    return { root, file, deps: { engine, sandbox, kernel, nrekiMode: "project", monitor: new TokenMonitor(), circuitBreaker: new CircuitBreaker(root) } };
}

describe("native edit reconstruction", () => {
    it("keeps replacement dollars, BOM and CRLF literally", () => {
        expect(nativeEditContent(edit("old", "$& $1 $$"), "\uFEFFold\r\n")).toBe("\uFEFF$& $1 $$\r\n");
    });
    it("requires an exact unambiguous match unless replace_all is true", () => {
        expect(() => nativeEditContent(edit("x", "y"), "x x")).toThrow(/uniquely/);
        expect(() => nativeEditContent(edit("z", "y"), "x x")).toThrow(/exactly/);
        expect(nativeEditContent(edit("x", "y", true), "x x")).toBe("y y");
    });
    it("applies MultiEdit entries sequentially and rejects partial/invalid entries", () => {
        const request = { tool_name: "MultiEdit", tool_input: { edits: [{ old_string: "x", new_string: "y" }, { old_string: "y", new_string: "z" }] } };
        expect(nativeEditContent(request, "x")).toBe("z");
        expect(() => nativeEditContent({ tool_name: "MultiEdit", tool_input: { edits: [null] } }, "x")).toThrow(/invalid/);
    });
    it("supports new files and skips unsupported tool shapes", () => {
        expect(nativeEditContent(edit("", "new"), null)).toBe("new");
        expect(nativeEditContent({ tool_name: "Write", tool_input: { content: "new" } }, null)).toBe("new");
        expect(nativeEditContent({ tool_name: "Replace", tool_input: {} }, "old")).toBeNull();
    });
    it("matches LF old_string against CRLF source while still rejecting ambiguous duplicates", () => {
        const crlfSource = "export function calc(): number {\r\n    const base = 1;\r\n    return base;\r\n}\r\n";
        const updated = nativeEditContent(
            edit("    const base = 1;\n    return base;", "    const base = 2;\n    return base * 2;"),
            crlfSource,
        );
        expect(updated).toBe("export function calc(): number {\r\n    const base = 2;\r\n    return base * 2;\r\n}\r\n");

        const multi = nativeEditContent({
            tool_name: "MultiEdit",
            tool_input: {
                edits: [
                    { old_string: "    const base = 1;\n    return base;", new_string: "    const step = 3;\n    return step;" },
                    { old_string: "    const step = 3;\n    return step;", new_string: "    const step = 4;\n    return step + 1;" },
                ],
            },
        }, crlfSource);
        expect(multi).toBe("export function calc(): number {\r\n    const step = 4;\r\n    return step + 1;\r\n}\r\n");

        const dupCrlf = "const a = 1;\r\nreturn a;\r\nconst a = 1;\r\nreturn a;\r\n";
        expect(() => nativeEditContent(edit("const a = 1;\nreturn a;", "const a = 2;\nreturn a;"), dupCrlf)).toThrow(/uniquely/);
    });
});

describe("native preflight validation", () => {
    it("allows a valid edit without changing disk or leaving VFS writes", async () => {
        const { file, deps } = fixture();
        expect(await validateNativeEdit(edit("= 1", "= 2"), deps)).toEqual({ status: "allow" });
        await deps.kernel!.commitToDisk();
        expect(fs.readFileSync(file, "utf8")).toBe("export const count: number = 1;\n");
    });
    it("returns the compiler error and preserves disk on type rejection", async () => {
        const { file, deps } = fixture();
        const result = await validateNativeEdit(edit("= 1", '= "bad"'), deps);
        expect(result.status).toBe("deny");
        expect(result.error).toMatch(/2322|not assignable/);
        expect(fs.readFileSync(file, "utf8")).toContain("= 1");
    });
    it("catches a broken dependent and accepts a later correct edit", async () => {
        const { root, deps } = fixture();
        fs.writeFileSync(path.join(root, "b.ts"), 'import { count } from "./a"; export const bill: number = count;');
        const result = await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "a.ts", content: 'export const count: string = "bad";' } }, deps);
        expect(result.status).toBe("deny");
        expect(result.error).toMatch(/b\.ts|2322/);
        expect((await validateNativeEdit(edit("= 1", "= 2"), deps)).status).toBe("allow");
    });
    it("rejects malformed syntax and traversal before any native write", async () => {
        const { deps } = fixture();
        expect((await validateNativeEdit(edit("= 1", "= ;"), deps)).status).toBe("deny");
        expect((await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "../escape.ts", content: "export {};" } }, deps)).status).toBe("deny");
    });
    it("validates creation in syntax mode without creating the file", async () => {
        const { root, deps } = fixture();
        deps.nrekiMode = "syntax";
        expect((await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "new.ts", content: "export const fresh: number = 3;" } }, deps)).status).toBe("allow");
        expect(fs.existsSync(path.join(root, "new.ts"))).toBe(false);
    });
    it("directs new TypeScript files outside the current program to batch_edit", async () => {
        const { root, deps } = fixture();
        const result = await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "new.ts", content: "export const fresh: number = 3;" } }, deps);
        expect(result.status).toBe("deny");
        expect(result.error).toContain("batch_edit");
        expect(fs.existsSync(path.join(root, "new.ts"))).toBe(false);
    });
    it("rejects isolated checking under a solution-style tsconfig", async () => {
        const { root, deps } = fixture();
        fs.mkdirSync(path.join(root, "pkg"));
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./pkg" }] }));
        fs.writeFileSync(path.join(root, "pkg/tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, composite: true }, include: ["*.ts"] }));
        fs.writeFileSync(path.join(root, "pkg/api.ts"), "export function value(): number { return 1; }");
        fs.writeFileSync(path.join(root, "pkg/caller.ts"), 'import { value } from "./api"; export const result: number = value();');
        const preview = vi.spyOn(deps.kernel!, "previewAtomicBatch");
        const result = await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "pkg/api.ts", content: 'export function value(): string { return "bad"; }' } }, deps);
        expect(result.status).toBe("deny");
        expect(result.error).toContain("batch_edit");
        expect(preview).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(root, "pkg/api.ts"), "utf8")).toContain("number");
    });
    it("rejects a known importer compiled under another tsconfig", async () => {
        const { root, deps } = fixture();
        fs.mkdirSync(path.join(root, "tests"));
        fs.writeFileSync(path.join(root, "tests/caller.ts"), 'import { count } from "../a"; export const result: number = count;');
        await deps.engine.initialize();
        await deps.engine.indexDirectory(root);
        expect(await deps.engine.findDependents("a.ts")).toContain("tests/caller.ts");
        const result = await validateNativeEdit({ tool_name: "Write", tool_input: { file_path: "a.ts", content: 'export const count: string = "bad";' } }, deps);
        expect(result.status).toBe("deny");
        expect(result.error).toContain("batch_edit");
        expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("number");
    });
    it("forwards Python importers from the graph to the LSP preview", async () => {
        const { root, deps } = fixture();
        const file = path.join(root, "api.py");
        fs.writeFileSync(file, "def amount():\n    return 1\n");
        vi.spyOn(deps.kernel!, "isBooted").mockReturnValue(true);
        vi.spyOn(deps.kernel!, "getSemanticCoverage").mockReturnValue({ backend: "lsp", languageId: "python" });
        const graph = vi.spyOn(deps.engine, "findDependents").mockResolvedValue(["caller.py"]);
        const preview = vi.spyOn(deps.kernel!, "previewAtomicBatch").mockResolvedValue({
            safe: true, exitCode: 0, latencyMs: "0.00", lspCoverage: [{ languageId: "python", checked: 1, skipped: 0 }],
        });
        const result = await validateNativeEdit({ tool_name: "Edit", tool_input: { file_path: "api.py", old_string: "return 1", new_string: "return 2" } }, deps);
        expect(result.status).toBe("allow");
        expect(graph).toHaveBeenCalledWith("api.py");
        expect(preview).toHaveBeenCalledWith([{ targetFile: file, proposedContent: "def amount():\n    return 2\n", baseContent: "def amount():\n    return 1\n" }], ["caller.py"]);
        expect(fs.readFileSync(file, "utf8")).toContain("return 1");
    });
    it("rejects an IDE save during validation", async () => {
        const { file, deps } = fixture();
        const validate = deps.sandbox.validateCode.bind(deps.sandbox);
        vi.spyOn(deps.sandbox, "validateCode").mockImplementation(async (code, language) => {
            const result = await validate(code, language);
            fs.writeFileSync(file, "export const count: number = 99;\n");
            return result;
        });
        expect((await validateNativeEdit(edit("= 1", "= 2"), deps)).status).toBe("deny");
        expect(fs.readFileSync(file, "utf8")).toContain("= 99");
    });
    it("allows valid multi-line LF Edit on a CRLF file on disk", async () => {
        const { file, deps } = fixture();
        fs.writeFileSync(file, "export function total(a: number): number {\r\n    return a + 1;\r\n}\r\n");
        const res = await validateNativeEdit(
            edit("export function total(a: number): number {\n    return a + 1;\n}", "export function total(a: number): number {\n    return a + 2;\n}"),
            deps,
        );
        expect(res).toEqual({ status: "allow" });
    });
    it("blocks newly added suppression comments without false positives on strings, legacy comments, or test @ts-expect-error", async () => {
        const { root, file, deps } = fixture();
        const tsIgnore = "// " + "@ts-ignore";
        const tsExpectErr = "// " + "@ts-expect-error";
        const pyIgnore = "# type: " + "ignore";

        // 1. Blocks newly added @ts-ignore comment in production TS
        const blockedTs = await validateNativeEdit(
            edit("export const count: number = 1;", `${tsIgnore}\nexport const count: number = "bad";`),
            deps,
        );
        expect(blockedTs.status).toBe("deny");
        expect(blockedTs.error).toContain("Anti-Sweep Shield");

        // 2. Blocks newly added @ts-expect-error in production TS
        const blockedProdExpect = await validateNativeEdit(
            edit("export const count: number = 1;", `${tsExpectErr}\nexport const count: number = "bad";`),
            deps,
        );
        expect(blockedProdExpect.status).toBe("deny");
        expect(blockedProdExpect.error).toContain("Anti-Sweep Shield");

        // 3. Blocks newly added # type: ignore in Python
        deps.nrekiMode = "syntax";
        const pyFile = path.join(root, "calc.py");
        fs.writeFileSync(pyFile, "def run(x: int) -> int:\n    return x + 1\n");
        const blockedPy = await validateNativeEdit({
            tool_name: "Edit",
            tool_input: { file_path: "calc.py", old_string: "    return x + 1", new_string: `    return x + "bad"  ${pyIgnore}` },
        }, deps);
        expect(blockedPy.status).toBe("deny");
        expect(blockedPy.error).toContain("Anti-Sweep Shield");

        // 4. NO false positive when suppression text appears inside a string/template literal
        const stringLiteralEdit = await validateNativeEdit(
            edit("export const count: number = 1;", `export const count: number = 1;\nexport const doc = "${tsIgnore}";\nexport const tpl = \`${pyIgnore}\`;`),
            deps,
        );
        expect(stringLiteralEdit).toEqual({ status: "allow" });

        // 5. NO false positive when editing a file that already has a legacy suppression comment
        fs.writeFileSync(file, `${tsIgnore}\nexport const legacyVal = 1;\nexport const count: number = 1;\n`);
        const legacyEdit = await validateNativeEdit(edit("export const count: number = 1;", "export const count: number = 2;"), deps);
        expect(legacyEdit).toEqual({ status: "allow" });

        // 6. NO false positive on @ts-expect-error in test files, while @ts-ignore is still blocked in test files
        fs.mkdirSync(path.join(root, "tests"), { recursive: true });
        fs.writeFileSync(path.join(root, "tests", "a.test.ts"), "export const sample = 1;\n");
        const allowedTestExpect = await validateNativeEdit({
            tool_name: "Edit",
            tool_input: { file_path: "tests/a.test.ts", old_string: "export const sample = 1;", new_string: `${tsExpectErr}\nexport const sample: number = "neg";` },
        }, deps);
        expect(allowedTestExpect).toEqual({ status: "allow" });

        const blockedTestIgnore = await validateNativeEdit({
            tool_name: "Edit",
            tool_input: { file_path: "tests/a.test.ts", old_string: "export const sample = 1;", new_string: `${tsIgnore}\nexport const sample: number = "neg";` },
        }, deps);
        expect(blockedTestIgnore.status).toBe("deny");
    });
});
