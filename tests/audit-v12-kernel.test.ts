/**
 * Regression tests for the v12.0.0 security / integrity audit (kernel layer).
 * Each block names the audit finding it pins down.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Parser from "web-tree-sitter";
import { fileURLToPath } from "url";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { classifyAndGenerateShadow } from "../src/hologram/shadow-generator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

function writeFiles(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

function makeProject(files: Record<string, string>, compilerOptions: Record<string, unknown> = {}, dir?: string): string {
    const root = dir ?? mkTmp("nreki-audit-");
    fs.mkdirSync(root, { recursive: true });
    writeFiles(root, files);
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "commonjs", strict: true, noEmit: true,
            esModuleInterop: true, skipLibCheck: true, ...compilerOptions,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    return root;
}

afterEach(() => {
    while (tmpDirs.length > 0) {
        const d = tmpDirs.pop()!;
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

// ─── NREKI-SEC-01 ───────────────────────────────────────────────────

describe("SEC-01: WAL crash recovery treats wal.json as untrusted input", () => {
    it("refuses entries that escape the project, hit sensitive files or use foreign backups", () => {
        const base = mkTmp("nreki-wal-");
        const dir = path.join(base, "project");
        const outside = path.join(base, "outside");
        fs.mkdirSync(outside);
        makeProject({ "index.ts": "export const a = 1;\n" }, {}, dir);

        const victimDelete = path.join(outside, "important.txt");
        const victimOverwrite = path.join(outside, "config.txt");
        fs.writeFileSync(victimDelete, "keep me");
        fs.writeFileSync(victimOverwrite, "original");
        const hook = path.join(dir, ".git", "hooks", "pre-commit");
        writeFiles(dir, { ".git/hooks/pre-commit": "#!/bin/sh\nexit 0\n" });

        const txDir = path.join(dir, ".nreki", "transactions");
        fs.mkdirSync(txDir, { recursive: true });
        fs.writeFileSync(path.join(txDir, "deadbeef.bak"), "PWNED");
        const outsideBak = path.join(outside, "cafebabe.bak");
        fs.writeFileSync(outsideBak, "PWNED");
        fs.writeFileSync(path.join(txDir, "wal.json"), JSON.stringify({
            status: "pending",
            files: [
                { target: "../outside/important.txt", backup: null },
                { target: victimOverwrite, backup: path.join(txDir, "deadbeef.bak") },
                { target: ".git/hooks/pre-commit", backup: path.join(txDir, "deadbeef.bak") },
                { target: path.join(dir, "index.ts"), backup: outsideBak },
            ],
        }));

        new NrekiKernel().boot(dir);

        expect(fs.readFileSync(victimDelete, "utf8")).toBe("keep me");
        expect(fs.readFileSync(victimOverwrite, "utf8")).toBe("original");
        expect(fs.readFileSync(hook, "utf8")).toContain("exit 0");
        expect(fs.readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("export const a = 1;\n");
        expect(fs.existsSync(outsideBak)).toBe(true);
    });

    it("still restores a legitimate crashed transaction", () => {
        const dir = makeProject({ "index.ts": "HALF-WRITTEN" });
        const txDir = path.join(dir, ".nreki", "transactions");
        fs.mkdirSync(txDir, { recursive: true });
        fs.writeFileSync(path.join(txDir, "abcd1234.bak"), "export const a = 1;\n");
        fs.writeFileSync(path.join(txDir, "wal.json"), JSON.stringify({
            status: "pending",
            files: [{ target: path.join(dir, "index.ts"), backup: path.join(txDir, "abcd1234.bak") }],
        }));

        new NrekiKernel().boot(dir);

        expect(fs.readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("export const a = 1;\n");
        expect(fs.existsSync(txDir)).toBe(false);
    });

    it("leaves a WAL owned by another live process untouched (it is mid-commit)", () => {
        const dir = makeProject({ "index.ts": "HALF-WRITTEN" });
        const txDir = path.join(dir, ".nreki", "transactions");
        fs.mkdirSync(txDir, { recursive: true });
        fs.writeFileSync(path.join(txDir, "abcd1234.bak"), "export const a = 1;\n");
        fs.writeFileSync(path.join(txDir, "wal.json"), JSON.stringify({
            status: "pending",
            pid: process.ppid, // the test runner: alive and not us
            files: [{ target: path.join(dir, "index.ts"), backup: path.join(txDir, "abcd1234.bak") }],
        }));

        new NrekiKernel().boot(dir);

        expect(fs.readFileSync(path.join(dir, "index.ts"), "utf8")).toBe("HALF-WRITTEN");
        expect(fs.existsSync(path.join(txDir, "wal.json"))).toBe(true);
    });

    it("recovers a dead process's per-pid WAL while leaving a live one alone", () => {
        const dir = makeProject({ "a.ts": "HALF-A", "b.ts": "HALF-B" });
        const txDir = path.join(dir, ".nreki", "transactions");
        fs.mkdirSync(txDir, { recursive: true });
        fs.writeFileSync(path.join(txDir, "aaaaaaaa.bak"), "export const a = 1;\n");
        fs.writeFileSync(path.join(txDir, "bbbbbbbb.bak"), "export const b = 1;\n");
        const deadPid = 2_000_000_000; // far beyond any real PID
        fs.writeFileSync(path.join(txDir, `wal-${deadPid}.json`), JSON.stringify({
            status: "pending", pid: deadPid,
            files: [{ target: path.join(dir, "a.ts"), backup: path.join(txDir, "aaaaaaaa.bak") }],
        }));
        fs.writeFileSync(path.join(txDir, `wal-${process.ppid}.json`), JSON.stringify({
            status: "pending", pid: process.ppid,
            files: [{ target: path.join(dir, "b.ts"), backup: path.join(txDir, "bbbbbbbb.bak") }],
        }));

        new NrekiKernel().boot(dir);

        expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("export const a = 1;\n");
        expect(fs.readFileSync(path.join(dir, "b.ts"), "utf8")).toBe("HALF-B");
        expect(fs.existsSync(path.join(txDir, `wal-${deadPid}.json`))).toBe(false);
        expect(fs.existsSync(path.join(txDir, `wal-${process.ppid}.json`))).toBe(true);
    });
});

// ─── NREKI-SEC-02 ───────────────────────────────────────────────────

describe("SEC-02: auto-heal write targets are jailed", () => {
    it("only regular, non-sensitive project files outside node_modules/.git/.nreki are writable", (ctx) => {
        const base = mkTmp("nreki-heal-");
        const outside = path.join(base, "outside");
        fs.mkdirSync(outside);
        const dir = makeProject({ "src/a.ts": "export const a = 1;\n" }, {}, path.join(base, "project"));
        const kernel = new NrekiKernel();
        kernel.boot(dir);
        const can = (p: string): boolean => (kernel as any).isHealWritable(toPosix(p));

        expect(can(path.join(dir, "src", "a.ts"))).toBe(true);
        expect(can(path.join(dir, "src", "new-file.ts"))).toBe(true);
        expect(can(path.join(outside, "x.ts"))).toBe(false);
        expect(can(path.join(dir, ".env"))).toBe(false);
        expect(can(path.join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
        expect(can(path.join(dir, ".claude", "settings.json"))).toBe(false);
        expect(can(path.join(dir, "node_modules", "pkg", "index.d.ts"))).toBe(false);
        expect(can(path.join(dir, ".nreki", "x.ts"))).toBe(false);

        // Directory symlink (junction on Windows) inside the repo pointing outside.
        try {
            fs.symlinkSync(outside, path.join(dir, "linked"), "junction");
            expect(can(path.join(dir, "linked", "x.ts"))).toBe(false);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
            // Reported as skipped, not green: the symlink half did not run.
            ctx.skip("cannot create a junction/symlink here (EPERM)");
        }
    });
});

// ─── NREKI-INT-01 ───────────────────────────────────────────────────

describe("INT-01: errors inside node_modules neither reject nor silently drop the edit", () => {
    it("commits the agent's edit and actually writes it to disk", async () => {
        const dir = makeProject({
            "src/shape.ts": "export interface Shape<T> { v: T }\n",
            "src/index.ts": `import { s } from "badpkg";\nexport const n = s;\n`,
            "node_modules/badpkg/package.json": JSON.stringify({ name: "badpkg", types: "index.d.ts" }),
            "node_modules/badpkg/index.d.ts":
                `import type { Shape } from "../../src/shape";\nexport declare const s: Shape<number>;\n`,
        }, { skipLibCheck: false });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");

        const shape = path.join(dir, "src", "shape.ts");
        const next = "export interface Shape { v: number }\n"; // breaks only node_modules/badpkg
        const result = await kernel.interceptAtomicBatch([{ targetFile: shape, proposedContent: next }]);
        expect(result.safe).toBe(true);

        await kernel.commitToDisk();
        expect(fs.readFileSync(shape, "utf8")).toBe(next);
    });
});

// ─── NREKI-INT-02 ───────────────────────────────────────────────────

describe("INT-02: committing an edit invalidates its hologram shadow", () => {
    let parser: Parser;
    let tsLanguage: Parser.Language;
    beforeAll(async () => {
        await Parser.init();
        parser = new Parser();
        tsLanguage = await Parser.Language.load(path.join(__dirname, "..", "wasm", "tree-sitter-typescript.wasm"));
    });

    it("later edits type-check against the NEW signature, not the stale shadow", async () => {
        const dir = makeProject({
            "utils.ts": "export function calc(x: number): number { return x; }\n",
            "consumer.ts": `import { calc } from "./utils";\nexport const a: number = calc(1);\n`,
            "other.ts": `import { calc } from "./utils";\nexport const b: number = calc(2);\n`,
        });
        const kernel = new NrekiKernel();
        kernel.setJitParser(parser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        kernel.boot(dir, "hologram");

        // Edit 1: touching consumer.ts makes JIT shadow utils.ts (x: number).
        let r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "consumer.ts"),
            proposedContent: `import { calc } from "./utils";\nexport const a: number = calc(10);\n`,
        }]);
        expect(r.safe).toBe(true);
        await kernel.commitToDisk();

        // Edit 2: change the signature of utils.ts.
        r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "utils.ts"),
            proposedContent: "export function calc(x: string): string { return x; }\n",
        }]);
        expect(r.safe).toBe(true);
        await kernel.commitToDisk();

        // Edit 3: code that is valid ONLY against the new signature.
        r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "other.ts"),
            proposedContent: `import { calc } from "./utils";\nexport const b: string = calc("ok");\n`,
        }]);
        expect(r.errorText ?? "").not.toContain("not assignable");
        expect(r.safe).toBe(true);
    });
});

// ─── NREKI-INT-03 ───────────────────────────────────────────────────

describe("INT-03: commit never clobbers a concurrent external modification", () => {
    it("aborts with NrekiConflictError, keeps the user's change, and stays usable", async () => {
        const dir = makeProject({ "a.ts": "export const a = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const a = path.join(dir, "a.ts");

        const r = await kernel.interceptAtomicBatch([{
            targetFile: a, proposedContent: "export const a = 2;\n", baseContent: "export const a = 1;\n",
        }]);
        expect(r.safe).toBe(true);

        fs.writeFileSync(a, "export const a = 99; // saved in the IDE meanwhile\n");
        await expect(kernel.commitToDisk()).rejects.toMatchObject({ name: "NrekiConflictError" });
        expect(fs.readFileSync(a, "utf8")).toBe("export const a = 99; // saved in the IDE meanwhile\n");

        const r2 = await kernel.interceptAtomicBatch([{ targetFile: a, proposedContent: "export const a = 3;\n" }]);
        expect(r2.safe).toBe(true);
        await kernel.commitToDisk();
        expect(fs.readFileSync(a, "utf8")).toBe("export const a = 3;\n");
    });
});

// ─── NREKI-INT-05 ───────────────────────────────────────────────────

describe("INT-05: external restore (undo) re-synchronizes the kernel", () => {
    it("a reverted pre-existing error is not reported as a NEW error on an unrelated edit", async () => {
        const broken = `export const x: number = "oops";\n`;
        const dir = makeProject({ "a.ts": broken, "b.ts": "export const b = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const a = path.join(dir, "a.ts");

        // Fix the pre-existing error and commit (baseline now has 0 errors).
        let r = await kernel.interceptAtomicBatch([{ targetFile: a, proposedContent: "export const x: number = 1;\n" }]);
        expect(r.safe).toBe(true);
        await kernel.commitToDisk();

        // "undo": restore the old content on disk behind the kernel's back.
        fs.writeFileSync(a, broken);
        await kernel.notifyExternalChange([a]);

        r = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, "b.ts"), proposedContent: "export const b = 2;\n" }]);
        expect(r.safe).toBe(true);
    });
});

// ─── NREKI-GAR-04 ───────────────────────────────────────────────────

describe("GAR-04: auto-heal never fabricates business values or guesses imports", () => {
    it("does not fill a missing required property with a default value", async () => {
        const dir = makeProject({ "a.ts": "export const o = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "a.ts"),
            proposedContent: "export const o: { price: number; requiresAuth: boolean } = { price: 10 };\n",
        }]);
        expect(r.safe).toBe(false);
        expect(r.healedFiles ?? []).toHaveLength(0);
    });

    it("refuses to auto-import a name exported by two different modules", async () => {
        const dir = makeProject({
            "a.ts": "export function parseConfig(s: string) { return s; }\n",
            "b.ts": "export function parseConfig(s: string) { return s.trim(); }\n",
            "main.ts": "export const m = 1;\n",
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "main.ts"),
            proposedContent: `export const m = parseConfig("x");\n`,
        }]);
        expect(r.safe).toBe(false);
    });

    it("still auto-imports when the candidate module is unique", async () => {
        const dir = makeProject({
            "c.ts": "export function onlyHere(n: number) { return n; }\n",
            "main.ts": "export const m = 1;\n",
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const r = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "main.ts"),
            proposedContent: "export const m = onlyHere(1);\n",
        }]);
        expect(r.safe).toBe(true);
        expect(r.errorText ?? "").toContain("AUTO-HEAL");
    });
});

// ─── NREKI-INT-07 / ROB-02 / SEC-05 / GAR-01 helpers ────────────────

describe("kernel helpers hardened by the audit", () => {
    it("getLspOffset clamps to the line end and to EOF (INT-07)", () => {
        const dir = makeProject({ "a.ts": "export const a = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir);
        const off = (c: string, l: number, ch: number): number => (kernel as any).getLspOffset(c, l, ch);

        const text = "ab\r\ncdef\r\nlast";
        expect(off(text, 0, 99)).toBe(2);          // never past "ab", never splits \r\n
        expect(off(text, 1, 2)).toBe(6);
        expect(off(text, 2, 99)).toBe(text.length);
        expect(off(text, 7, 0)).toBe(text.length); // line beyond EOF → end of document
        expect(off("line0\nline1_no_newline", 5, 2)).toBe("line0\nline1_no_newline".length);
    });

    it("getScriptVersion changes after a commit even when the LS never saw the staged version (ROB-02)", async () => {
        const dir = makeProject({ "a.ts": "export const a = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const a = toPosix(path.join(dir, "a.ts"));
        const version = (): string => (kernel as any).tsBackend.vfsAdapter.getScriptVersion(a);

        const before = version();
        await kernel.interceptAtomicBatch([{ targetFile: a, proposedContent: "export const a = 2;\n" }]);
        await kernel.commitToDisk();
        expect(version()).not.toBe(before);
    });

    it("sensitive files do not exist for the compiler or the LanguageService (SEC-05)", () => {
        const dir = makeProject({ "a.ts": "export const a = 1;\n", "config.env.ts": "export const KEY = 'sk-live';\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir);
        const secret = toPosix(path.join(dir, "config.env.ts"));
        const adapter = (kernel as any).tsBackend.vfsAdapter;
        expect(kernel.host.fileExists(secret)).toBe(false);
        expect(adapter.getScriptSnapshot(secret)).toBeUndefined();
    });

    it("reports which semantic checker covers a file (GAR-01)", () => {
        const dir = makeProject({ "a.ts": "export const a = 1;\n" }, { allowJs: true });
        const kernel = new NrekiKernel();
        kernel.boot(dir);
        expect(kernel.getSemanticCoverage(path.join(dir, "a.ts")).backend).toBe("typescript");
        expect(kernel.getSemanticCoverage(path.join(dir, "x.js")).backend).toBeNull(); // allowJs without checkJs
        expect(kernel.getSemanticCoverage(path.join(dir, "Main.kt")).backend).toBeNull();
    });
});
