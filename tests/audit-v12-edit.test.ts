/**
 * Regression tests for the v12.0.0 audit — edit pipeline, undo, LSP URIs
 * and the Claude Code enforcer hook.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { semanticEdit, batchSemanticEdit, applySemanticSplice } from "../src/semantic-edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { saveBackup, getBackupPath, restoreBackupWithContent } from "../src/undo.js";
import { LspSidecarBase } from "../src/kernel/backends/lsp-sidecar-base.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";
const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}
afterEach(() => {
    while (tmpDirs.length > 0) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

/** Sandbox that runs `sideEffect` the first time validation happens (simulates a concurrent writer). */
function sandboxWithSideEffect(sideEffect: () => void): AstSandbox {
    let fired = false;
    return new Proxy(sandbox, {
        get(target, prop, receiver) {
            if (prop === "validateCode") {
                return async (...args: unknown[]) => {
                    if (!fired) { fired = true; sideEffect(); }
                    return (target.validateCode as (...a: unknown[]) => unknown).apply(target, args);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    }) as AstSandbox;
}

// ─── NREKI-INT-07: line endings ─────────────────────────────────────

describe("INT-07: CRLF files keep CRLF on replace / insert", () => {
    const crlf = "export function a() {\r\n  return 1;\r\n}\r\n";
    const target = { startIndex: 0, endIndex: crlf.indexOf("}") + 1, rawCode: crlf.slice(0, crlf.indexOf("}") + 1), symbolName: "a", startLine: 1 };

    it("replace emits CRLF", () => {
        const { newContent } = applySemanticSplice(crlf, target, "export function a() {\n  return 2;\n}");
        expect(newContent).toBe("export function a() {\r\n  return 2;\r\n}\r\n");
    });

    it("insert_after neither splits \\r\\n nor injects bare \\n", () => {
        const { newContent } = applySemanticSplice(crlf, target, "export function b() {\n  return 3;\n}", "insert_after");
        expect(newContent).toBe("export function a() {\r\n  return 1;\r\n}\r\n\r\nexport function b() {\r\n  return 3;\r\n}\r\n");
        expect(/(?<!\r)\n/.test(newContent)).toBe(false);
    });

    it("a single-line symbol in a CRLF file uses the FILE's line ending", () => {
        const file = "export const x = 1;\r\nexport const y = 2;\r\n";
        const t = { startIndex: 0, endIndex: 19, rawCode: "export const x = 1;", symbolName: "x", startLine: 1 };
        const { newContent } = applySemanticSplice(file, t, "export const x = {\n  v: 1,\n};");
        expect(newContent).toBe("export const x = {\r\n  v: 1,\r\n};\r\nexport const y = 2;\r\n");
    });
});

// ─── semanticEdit / batchSemanticEdit ───────────────────────────────

describe("edit pipeline regressions", () => {
    it("GAR-03: semanticEdit rejects a NEW @ts-ignore but keeps editing files with legacy ones", async () => {
        const dir = mkTmp("nreki-sweep-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "// @ts-ignore\nexport function a() { return 1; }\nexport function b() { return 2; }\n");

        const blocked = await semanticEdit(f, "b", "export function b() {\n  // @ts-ignore\n  return nope;\n}", parser, sandbox, dir);
        expect(blocked.success).toBe(false);
        expect(blocked.error).toContain("Anti-Sweep");

        const ok = await semanticEdit(f, "b", "export function b() { return 3; }", parser, sandbox, dir);
        expect(ok.success).toBe(true);
        expect(fs.readFileSync(f, "utf8")).toContain("// @ts-ignore\nexport function a()");
    });

    it("INT-03: semanticEdit (no kernel) refuses to clobber a concurrent external write", async () => {
        const dir = mkTmp("nreki-toctou-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "export function a() { return 1; }\n");
        const racing = sandboxWithSideEffect(() => fs.writeFileSync(f, "export function a() { return 42; } // IDE save\n"));

        const res = await semanticEdit(f, "a", "export function a() { return 2; }", parser, racing, dir);
        expect(res.success).toBe(false);
        expect(res.error).toContain("CONFLICT");
        expect(fs.readFileSync(f, "utf8")).toContain("return 42");
    });

    it("INT-03: batchSemanticEdit (no kernel) aborts the whole batch on a concurrent write", async () => {
        const dir = mkTmp("nreki-toctou-batch-");
        const a = path.join(dir, "a.ts");
        const b = path.join(dir, "b.ts");
        fs.writeFileSync(a, "export function a() { return 1; }\n");
        fs.writeFileSync(b, "export function b() { return 1; }\n");
        const racing = sandboxWithSideEffect(() => fs.writeFileSync(b, "export function b() { return 99; }\n"));

        const res = await batchSemanticEdit([
            { path: "a.ts", symbol: "a", new_code: "export function a() { return 2; }" },
            { path: "b.ts", symbol: "b", new_code: "export function b() { return 2; }" },
        ], parser, racing, dir);
        expect(res.success).toBe(false);
        expect(res.error).toContain("CONFLICT");
        expect(fs.readFileSync(a, "utf8")).toContain("return 1");
        expect(fs.readFileSync(b, "utf8")).toContain("return 99");
    });

    it("ROB-02: batch_edit no longer edits a differently-cased symbol silently", async () => {
        const dir = mkTmp("nreki-case-");
        fs.writeFileSync(path.join(dir, "a.ts"), "export function Foo() { return 1; }\n");
        const res = await batchSemanticEdit([{ path: "a.ts", symbol: "foo", new_code: "export function foo() { return 2; }" }],
            parser, sandbox, dir);
        expect(res.success).toBe(false);
        expect(res.error).toContain('Did you mean "Foo"');
        expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toContain("Foo() { return 1; }");
    });

    it.runIf(isWin || process.platform === "darwin")(
        "batch_edit never loses an edit when one file is named under two spellings (case-insensitive FS)", async () => {
            const dir = mkTmp("nreki-spell-");
            const file = path.join(dir, "Foo.ts");
            fs.writeFileSync(file, "export function a() { return 1; }\nexport function b() { return 1; }\n");
            const res = await batchSemanticEdit([
                { path: "Foo.ts", symbol: "a", new_code: "export function a() { return 2; }" },
                { path: "foo.ts", symbol: "b", new_code: "export function b() { return 2; }" },
            ], parser, sandbox, dir);
            const after = fs.readFileSync(file, "utf8");
            if (isWin) {
                // safePath spells both like the disk (utils/path-case.ts): one file, read and written once.
                expect(res.success, res.error).toBe(true);
            }
            if (res.success) {
                expect(after).toContain("function a() { return 2; }");
                expect(after).toContain("function b() { return 2; }");
            } else {
                // Where the OS does not report the on-disk case, the inode guard still refuses.
                expect(res.error).toContain("two spellings");
                expect(after).toContain("function a() { return 1; }");
            }
        });

    it("INT-07: edits keep the UTF-8 BOM", async () => {
        const dir = mkTmp("nreki-bomedit-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "﻿export function a() { return 1; }\n");
        const res = await semanticEdit(f, "a", "export function a() { return 2; }", parser, sandbox, dir);
        expect(res.success).toBe(true);
        const bytes = fs.readFileSync(f);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.toString("utf8")).toContain("return 2");
    });

    it.skipIf(isWin)("INT-07: edits keep executable permissions", async () => {
        const dir = mkTmp("nreki-mode-");
        const f = path.join(dir, "cli.js");
        fs.writeFileSync(f, "#!/usr/bin/env node\nfunction main() { return 1; }\n");
        fs.chmodSync(f, 0o755);
        const res = await semanticEdit(f, "main", "function main() { return 2; }", parser, sandbox, dir);
        expect(res.success).toBe(true);
        expect(fs.statSync(f).mode & 0o777).toBe(0o755);
    });
});

// ─── NREKI-INT-05: undo ─────────────────────────────────────────────

describe("INT-05: undo safety", () => {
    it("a backup that cannot capture the current state never survives (no two-edits-ago restore)", () => {
        const dir = mkTmp("nreki-undo-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "v0");
        saveBackup(dir, f);
        expect(fs.existsSync(getBackupPath(dir, f))).toBe(true);
        fs.writeFileSync(f, Buffer.from([0x76, 0x31, 0x00])); // now binary: cannot be captured
        saveBackup(dir, f);
        expect(fs.existsSync(getBackupPath(dir, f))).toBe(false);
    });

    it("restore is atomic, returns the content and only then drops the backup", () => {
        const dir = mkTmp("nreki-undo2-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "before");
        saveBackup(dir, f);
        fs.writeFileSync(f, "after");
        const { content } = restoreBackupWithContent(dir, f);
        expect(content).toBe("before");
        expect(fs.readFileSync(f, "utf8")).toBe("before");
        expect(fs.existsSync(getBackupPath(dir, f))).toBe(false);
        expect(fs.readdirSync(dir).filter(n => n.includes(".tmp"))).toHaveLength(0);
    });
});

// ─── NREKI-INT-04: LSP URIs ─────────────────────────────────────────

const mockServerPath = path.resolve(__dirname, "mock-lsp-server.ts");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

class MockLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string, scenario: string) {
        super(projectRoot, [process.execPath, tsxCli, mockServerPath], "mock", { MOCK_LSP_SCENARIO: scenario });
    }
}

describe("INT-04: LSP works in paths with spaces and non-ASCII characters", () => {
    let sidecar: MockLspSidecar | undefined;
    afterEach(async () => {
        if (sidecar) { try { await sidecar.shutdown(); } catch { /* dead */ } sidecar = undefined; }
    });

    it("collects diagnostics and decodes code-action URIs back to real paths", async () => {
        const root = path.join(mkTmp("nreki-uri-"), "Mi Proyecto Ñ");
        fs.mkdirSync(root);
        sidecar = new MockLspSidecar(root, "missing_import");
        await sidecar.boot();
        const file = path.join(root, "my file.py");

        const errors = await sidecar.validateEdits([{ filePath: file, content: "json.loads(x)" }]);
        expect(errors.length).toBe(1);
        expect(errors[0].file).toBe(toPosix(file));

        const actions = await sidecar.requestCodeActions(file, {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            message: "missing import", code: "import-error", source: "mock",
        });
        expect(actions.length).toBe(1);
        expect(actions[0].edits[0].filePath).toBe(toPosix(file));
        expect(actions[0].edits[0].filePath).not.toContain("%20");
    });

    it("keys push diagnostics by decoded path (percent-encoded and %3A drive URIs match)", () => {
        const root = path.join(mkTmp("nreki-uri2-"), "My Project");
        sidecar = new MockLspSidecar(root, "clean");
        const file = path.join(root, "src", "a b.py");
        const key = (sidecar as any).pathKey(file);
        const encoded = (sidecar as any).toUri(file) as string;
        expect(encoded).toContain("%20");
        expect((sidecar as any).uriKey(encoded)).toBe(key);
        if (isWin) {
            const drive = encoded.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d: string) => `file:///${d.toLowerCase()}%3A`);
            expect((sidecar as any).uriKey(drive)).toBe(key);
        }
        sidecar = undefined;
    });
});

// ─── NREKI-SEC-04: enforcer hook ────────────────────────────────────

describe("SEC-04: Claude Code enforcer hook v3", () => {
    const hook = path.resolve(__dirname, "..", "templates", "hooks", "nreki-enforcer.mjs");
    // 150 lines ≈ 2k tokens: under the read budget.
    const medium = Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i}; // padding padding padding`).join("\n");
    // 30 functions x 30 lines ≈ 13k tokens: over the read budget.
    const huge = Array.from({ length: 30 }, (_, k) => [
        `export function fn${k}(a: number): number {`,
        ...Array.from({ length: 28 }, (_, j) => `    const x${k}_${j} = a + ${j}; // padding padding padding padding`),
        `}`,
    ].join("\n")).join("\n");

    function runHook(projectDir: string, tool: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
        const res = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: tool, tool_input: input }),
            env: { ...process.env, NREKI_ENFORCE_EDITS: "", NREKI_READ_MAX_TOKENS: "", CLAUDE_PROJECT_DIR: projectDir, ...env },
            cwd: projectDir,
            encoding: "utf8",
        });
        return { status: res.status, stderr: res.stderr };
    }
    function liveProject(prefix: string): string {
        const dir = mkTmp(prefix);
        fs.mkdirSync(path.join(dir, ".nreki", "sessions"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".nreki", "sessions", String(process.pid)), "");
        return dir;
    }

    it("fails open when no NREKI server is running", () => {
        const dir = mkTmp("nreki-hook-");
        fs.writeFileSync(path.join(dir, "huge.ts"), huge);
        expect(runHook(dir, "Edit", { file_path: path.join(dir, "huge.ts") }).status).toBe(0);
        expect(runHook(dir, "Read", { file_path: path.join(dir, "huge.ts") }).status).toBe(0);
    });

    it("blocks a large Read once, with the symbol outline, and lets the repeated Read through", () => {
        const dir = liveProject("nreki-hook-read-");
        const file = path.join(dir, "huge.ts");
        fs.writeFileSync(file, huge);

        const first = runHook(dir, "Read", { file_path: file });
        expect(first.status).toBe(2);
        expect(first.stderr).toContain("L1-30 function fn0");
        expect(first.stderr).toContain("L871-900 function fn29");
        expect(first.stderr).toContain("Repeat the same Read");

        expect(runHook(dir, "Read", { file_path: file }).status).toBe(0); // escape hatch
        expect(runHook(dir, "Read", { file_path: file }).status).toBe(2); // one free retry per block
    });

    it("honors offset/limit and the token budget", () => {
        const dir = liveProject("nreki-hook-range-");
        const file = path.join(dir, "huge.ts");
        fs.writeFileSync(file, huge);
        fs.writeFileSync(path.join(dir, "medium.ts"), medium);

        expect(runHook(dir, "Read", { file_path: file, offset: 100, limit: 40 }).status).toBe(0);
        expect(runHook(dir, "Read", { file_path: file, offset: 880 }).status).toBe(0); // only the tail is left
        expect(runHook(dir, "Read", { file_path: path.join(dir, "medium.ts") }).status).toBe(0);
        expect(runHook(dir, "Read", { file_path: path.join(dir, "medium.ts") }, { NREKI_READ_MAX_TOKENS: "500" }).status).toBe(2);
    });

    it("allows native Edit, MultiEdit and Write; NREKI_ENFORCE_EDITS=1 steers edits of large code files", () => {
        const dir = liveProject("nreki-hook-edit-");
        const file = path.join(dir, "medium.ts");
        fs.writeFileSync(file, medium);
        fs.writeFileSync(path.join(dir, "notes.md"), medium);

        expect(runHook(dir, "Edit", { file_path: file }).status).toBe(0);
        expect(runHook(dir, "MultiEdit", { file_path: file }).status).toBe(0);
        expect(runHook(dir, "Write", { file_path: file, content: medium }).status).toBe(0);

        const strict = { NREKI_ENFORCE_EDITS: "1" };
        const blocked = runHook(dir, "Edit", { file_path: file }, strict);
        expect(blocked.status).toBe(2);
        expect(blocked.stderr).toContain('nreki_code action:"edit"');
        expect(runHook(dir, "Write", { file_path: path.join(dir, "brand-new.ts"), content: medium }, strict).status).toBe(0);
        expect(runHook(dir, "Edit", { file_path: path.join(dir, "notes.md") }, strict).status).toBe(0);
    });

    it("leaves non-code files and paths outside the project alone", () => {
        const dir = liveProject("nreki-hook-scope-");
        const outside = mkTmp("nreki-hook-outside-");
        fs.writeFileSync(path.join(dir, "notes.md"), huge);
        fs.writeFileSync(path.join(outside, "huge.ts"), huge);

        expect(runHook(dir, "Read", { file_path: path.join(dir, "notes.md") }).status).toBe(0);
        expect(runHook(dir, "Read", { file_path: path.join(outside, "huge.ts") }).status).toBe(0);
        // e.g. Claude Code's own memory / plan / scratch files
        expect(runHook(dir, "Write", { file_path: path.join(outside, "memory.md"), content: "x" }).status).toBe(0);
    });

    it("resolves symlinks before the in-project check", (ctx) => {
        const base = mkTmp("nreki-hook-link-");
        const dir = path.join(base, "project");
        const outside = path.join(base, "outside");
        fs.mkdirSync(path.join(dir, ".nreki", "sessions"), { recursive: true });
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(dir, ".nreki", "sessions", String(process.pid)), "");
        // SMALL file: the size rule alone would allow it, only the realpath check blocks it.
        fs.writeFileSync(path.join(outside, "secret.txt"), "token=abc\n");
        try {
            fs.symlinkSync(outside, path.join(dir, "linked"), "junction");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EPERM") {
                ctx.skip("cannot create a junction/symlink here (EPERM)");
                return;
            }
            throw err;
        }

        expect(runHook(dir, "Read", { file_path: path.join(dir, "linked", "secret.txt") }).status).toBe(2);
        expect(runHook(dir, "Write", { file_path: path.join(dir, "linked", "planted.ts"), content: "x" }).status).toBe(2);
        expect(runHook(dir, "Read", { file_path: path.join(dir, "small-inside.txt") }).status).toBe(0);
    });
});
