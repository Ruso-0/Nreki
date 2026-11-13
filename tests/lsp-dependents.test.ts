/**
 * Go/Python: an edit is judged against the files that DEPEND on the edited one
 * (same package, importers), not only against documents that happened to be
 * open in the language server. Covers the dependency graph that finds them
 * (Go packages, Python relative/package imports), the kernel + sidecar that
 * open them, and the bounded lists of a rejection / blast-radius note.
 * Each behavioural test failed before its fix.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { LspSidecarBase } from "../src/kernel/backends/lsp-sidecar-base.js";
import { GoLspSidecar } from "../src/kernel/backends/go-sidecar.js";
import {
    buildDependencyGraph, extractImports, extractPythonGraphImports, findGoModules,
    type GoModule, type RepoMapEntry,
} from "../src/repo-map.js";
import { formatErrorList, ERROR_LIST_CAP } from "../src/kernel/error-format.js";
import { formatBlastRadius, verifiedImporters, BLAST_RADIUS_LIST_CAP } from "../src/handlers/code/blast-radius.js";
import { handleEdit, handleBatchEdit } from "../src/handlers/code/edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { RouterDependencies } from "../src/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockServerPath = path.resolve(__dirname, "mock-lsp-server.ts");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

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

// ─── The dependency graph finds Go and Python importers ─────────────

function entry(filePath: string, content: string): RepoMapEntry {
    const ext = path.extname(filePath);
    const imports = extractImports(content, ext);
    const graphImports = ext === ".py" ? extractPythonGraphImports(content).filter(i => !imports.includes(i)) : [];
    return { filePath, exports: [], signatures: [], imports, lineCount: 1, ...(graphImports.length > 0 ? { graphImports } : {}) };
}

async function importers(files: Record<string, string>, goModules: GoModule[] = []): Promise<(target: string) => string[]> {
    const entries = Object.entries(files).map(([f, c]) => entry(f, c));
    const graph = await buildDependencyGraph(entries, Object.keys(files).sort(), { goModules });
    return (target: string) => [...(graph.importedBy.get(target) ?? [])].sort();
}

describe("dependency graph: Go imports name packages", () => {
    const demo: GoModule[] = [{ dir: "", modulePath: "example.com/demo" }];
    const files = {
        "main.go": "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/demo/util\"\n)\n\nfunc main() { fmt.Println(util.N()) }\n",
        "util.go": "package main\n\nfunc local() int { return 1 }\n",
        "util/u.go": "package util\n\nfunc N() int { return 1 }\n",
        "util/extra.go": "package util\n\nfunc M() int { return 2 }\n",
        "util/u_test.go": "package util\n\nimport \"testing\"\n\nfunc TestN(t *testing.T) {}\n",
        "cmd/app/app.go": "package main\n\nimport \"example.com/demo/util\"\n\nfunc main() { _ = util.N() }\n",
    };

    it("every file of the imported package gets the importer, through the module path", async () => {
        const of = await importers(files, demo);
        expect(of("util/u.go")).toEqual(["cmd/app/app.go", "main.go"]);
        expect(of("util/extra.go")).toEqual(["cmd/app/app.go", "main.go"]);
    });

    it("a file that merely shares the package's name is not a target, nor is a test file", async () => {
        const of = await importers(files, demo);
        expect(of("util.go")).toEqual([]); // the old suffix lookup resolved ".../util" to this file
        expect(of("util/u_test.go")).toEqual([]);
    });

    it("resolves inside a nested module and ignores other modules", async () => {
        const of = await importers({
            "svc/main.go": "package main\n\nimport (\n\t\"example.com/svc/internal/db\"\n\t\"github.com/other/db\"\n)\n",
            "svc/internal/db/db.go": "package db\n",
            "db/db.go": "package db\n",
        }, [{ dir: "svc", modulePath: "example.com/svc" }]);
        expect(of("svc/internal/db/db.go")).toEqual(["svc/main.go"]);
        expect(of("db/db.go")).toEqual([]);
    });

    it("without a go.mod falls back to the longest directory suffix", async () => {
        const of = await importers({
            "cmd/main.go": "package main\n\nimport \"github.com/x/proj/pkg/store\"\n",
            "pkg/store/s.go": "package store\n",
        });
        expect(of("pkg/store/s.go")).toEqual(["cmd/main.go"]);
    });

    it("findGoModules reads the module path of each go.mod above Go sources", () => {
        const dir = tmp("nreki-gomod-", {
            "go.mod": "module example.com/demo\n\ngo 1.22\n",
            "tools/go.mod": "// tools\nmodule \"example.com/tools\"\n",
            "tools/gen/gen.go": "package gen\n",
            "main.go": "package main\n",
        });
        expect(findGoModules(dir, ["main.go", "tools/gen/gen.go"])).toEqual([
            { dir: "", modulePath: "example.com/demo" },
            { dir: "tools", modulePath: "example.com/tools" },
        ]);
    });
});

describe("dependency graph: Python imports", () => {
    it("relative imports, packages and `from pkg import module`", async () => {
        const of = await importers({
            "pkg/__init__.py": "VERSION = 1\n",
            "pkg/a.py": "from .b import x\nfrom . import c\nfrom ..top import t\n",
            "pkg/b.py": "x = 1\n",
            "pkg/c.py": "y = 2\n",
            "pkg/sub/__init__.py": "",
            "pkg/sub/m.py": "from ..b import x\nfrom .. import c as cc\n",
            "top.py": "t = 3\n",
            "app.py": "import pkg\nfrom pkg import b, c as see\nfrom pkg.sub import m\n",
        });
        expect(of("pkg/b.py")).toEqual(["app.py", "pkg/a.py", "pkg/sub/m.py"]);
        expect(of("pkg/c.py")).toEqual(["app.py", "pkg/a.py", "pkg/sub/m.py"]);
        expect(of("pkg/__init__.py")).toEqual(["app.py", "pkg/a.py", "pkg/sub/m.py"]);
        expect(of("pkg/sub/m.py")).toEqual(["app.py"]);
        expect(of("top.py")).toEqual(["pkg/a.py"]); // "..top" from pkg/a.py: the directory above pkg
    });

    it("`..name` climbs one package per extra dot", async () => {
        const of = await importers({
            "pkg/sub/m.py": "from ..core import d\nfrom ...shared import s\n",
            "pkg/core.py": "d = 1\n",
            "shared.py": "s = 1\n",
        });
        expect(of("pkg/core.py")).toEqual(["pkg/sub/m.py"]);
        expect(of("shared.py")).toEqual(["pkg/sub/m.py"]);
    });

    it("imports inside a function, parenthesised lists and `import a, b`", async () => {
        const of = await importers({
            "lib.py": "def helper(): ...\n",
            "tools.py": "def t(): ...\n",
            "lazy.py": "def run():\n    from lib import helper\n    return helper()\n",
            "multi.py": "import lib, tools as tt\n",
            "paren.py": "from pkg import (\n    one,  # first\n    two as second,\n)\n",
            "pkg/__init__.py": "",
            "pkg/one.py": "",
            "pkg/two.py": "",
        });
        expect(of("lib.py")).toEqual(["lazy.py", "multi.py"]);
        expect(of("tools.py")).toEqual(["multi.py"]);
        expect(of("pkg/one.py")).toEqual(["paren.py"]);
        expect(of("pkg/two.py")).toEqual(["paren.py"]);
    });

    it("an import rooted in a subdirectory resolves to the nearest candidate", async () => {
        const of = await importers({
            "backend/app/main.py": "from app.core.auth import check\nimport utils\n",
            "backend/app/core/auth.py": "def check(): ...\n",
            "backend/app/utils.py": "",
            "worker/utils.py": "",
            "worker/job.py": "import utils\n",
        });
        expect(of("backend/app/core/auth.py")).toEqual(["backend/app/main.py"]);
        expect(of("backend/app/utils.py")).toEqual(["backend/app/main.py"]);
        expect(of("worker/utils.py")).toEqual(["worker/job.py"]);
    });

    it("TypeScript resolution is untouched", async () => {
        const of = await importers({
            "src/a.ts": "import { b } from \"./b\";\nimport x from \"../lib/x.js\";\n",
            "src/b.ts": "export const b = 1;\n",
            "lib/x.ts": "export default 1;\n",
        });
        expect(of("src/b.ts")).toEqual(["src/a.ts"]);
        expect(of("lib/x.ts")).toEqual(["src/a.ts"]);
    });
});

// ─── Kernel + sidecar open the dependents ───────────────────────────

class MockLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        super(projectRoot, [process.execPath, tsxCli, mockServerPath], "mock", { MOCK_LSP_SCENARIO: "marker_errors" });
    }
}

/** Like a Go package: every .py file of a directory is compiled together. */
class PackageMockSidecar extends MockLspSidecar {
    override companionFiles(filePath: string): string[] {
        const dir = path.dirname(filePath);
        return fs.readdirSync(dir)
            .filter(n => n.endsWith(".py") && n !== path.basename(filePath))
            .sort()
            .map(n => path.join(dir, n).replace(/\\/g, "/"));
    }
}

async function project(files: Record<string, string>, Sidecar: new (root: string) => MockLspSidecar = MockLspSidecar) {
    const dir = tmp("nreki-lsp-deps-", files);
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["./**/*.ts"] }));
    const sidecar = new Sidecar(dir);
    const kernel = new NrekiKernel();
    kernel.boot(dir, "project");
    kernel.registerSidecar(".py", sidecar);
    cleanups.push(() => kernel.shutdownSidecars());
    const edit = (file: string, proposedContent: string, dependents: string[] = []) =>
        kernel.interceptAtomicBatch([{ targetFile: path.join(dir, file), proposedContent }], dependents);
    return { dir, sidecar, kernel, edit };
}

const listed = (r: { structured?: Array<{ file: string; message: string }> }) =>
    (r.structured ?? []).map(e => `${path.basename(e.file)}: ${e.message}`);

describe("kernel: dependents are opened in the LSP before the edit is measured", () => {
    it("rejects an edit that breaks an importer no one ever opened", async () => {
        const { edit, kernel, sidecar, dir } = await project({ "lib.py": "DEF(helper)\n", "consumer.py": "NEEDS(helper)\n" });

        const breaking = await edit("lib.py", "z = 1\n", ["consumer.py"]);
        expect(breaking.safe).toBe(false);
        expect(listed(breaking)).toEqual(["consumer.py: mock undefined helper"]);
        expect(sidecar.hasOpenDocument(path.join(dir, "consumer.py"))).toBe(true);

        const harmless = await edit("lib.py", "DEF(helper)\nz = 1\n", ["consumer.py"]);
        expect(harmless.safe).toBe(true);
        expect(harmless.lspCoverage).toEqual([{ languageId: "mock", checked: 1, skipped: 0 }]);
        await kernel.commitToDisk();
    });

    it("an error the importer already had does not reject the edit", async () => {
        const { edit } = await project({ "lib.py": "DEF(helper)\n", "consumer.py": "NEEDS(helper)\nERR(old)\n" });
        expect((await edit("lib.py", "DEF(helper)\nz = 1\n", ["consumer.py"])).safe).toBe(true);
    });

    it("files of the same compilation unit are opened without any import graph", async () => {
        const { edit } = await project({ "lib.py": "DEF(greet)\n", "main.py": "NEEDS(greet)\n" }, PackageMockSidecar);
        const r = await edit("lib.py", "z = 1\n"); // no dependents passed
        expect(r.safe).toBe(false);
        expect(listed(r)).toEqual(["main.py: mock undefined greet"]);
    });

    it("caps the dependents it opens and says how many it left out", async () => {
        const files: Record<string, string> = { "lib.py": "DEF(helper)\n" };
        const dependents: string[] = [];
        for (let i = 0; i < NrekiKernel.LSP_DEPENDENT_CAP + 10; i++) {
            files[`c${String(i).padStart(2, "0")}.py`] = "NEEDS(helper)\n";
            dependents.push(`c${String(i).padStart(2, "0")}.py`);
        }
        const { edit, sidecar } = await project(files);
        const r = await edit("lib.py", "DEF(helper)\nz = 1\n", dependents);
        expect(r.safe).toBe(true);
        expect(r.lspCoverage).toEqual([{ languageId: "mock", checked: NrekiKernel.LSP_DEPENDENT_CAP, skipped: 10 }]);
        expect(sidecar.openDocumentCount()).toBe(NrekiKernel.LSP_DEPENDENT_CAP + 1);
    });

    it("a dependent the graph lists but that is gone from disk is not counted", async () => {
        const { edit } = await project({ "lib.py": "DEF(helper)\n" });
        const r = await edit("lib.py", "DEF(helper)\nz = 1\n", ["deleted.py"]);
        expect(r.safe).toBe(true);
        expect(r.lspCoverage).toEqual([{ languageId: "mock", checked: 0, skipped: 0 }]);
    });

    it("an open document follows the disk: a file fixed outside NREKI is not judged at its old text", async () => {
        const { edit, kernel, dir } = await project({ "lib.py": "DEF(helper)\n", "consumer.py": "NEEDS(helper)\n" });
        // consumer.py becomes an open document through an ordinary edit.
        expect((await edit("consumer.py", "NEEDS(helper)\ny = 0\n")).safe).toBe(true);
        await kernel.commitToDisk();

        // The user rewrites it in their editor: it no longer needs helper.
        fs.writeFileSync(path.join(dir, "consumer.py"), "y = 1\n# rewritten outside NREKI, longer than before\n");
        const removal = await edit("lib.py", "z = 1\n");
        expect(listed(removal)).toEqual([]); // the stale overlay still said NEEDS(helper)
        expect(removal.safe).toBe(true);
    });

    it("guard: an error typed into an open document outside NREKI is not blamed on the edit", async () => {
        const { edit, kernel, dir } = await project({ "lib.py": "DEF(helper)\n", "other.py": "x = 1\n" });
        expect((await edit("lib.py", "DEF(helper)\nz = 1\n", ["other.py"])).safe).toBe(true);
        await kernel.commitToDisk();

        fs.writeFileSync(path.join(dir, "other.py"), "x = 1\nERR(typo_made_in_the_editor)\n");
        const next = await edit("lib.py", "DEF(helper)\nz = 2\n"); // other.py is open, not named this time
        expect(listed(next)).toEqual([]);
        expect(next.safe).toBe(true);
    });

    it("keeps the set of open documents bounded across edits", async () => {
        const files: Record<string, string> = { "lib.py": "DEF(helper)\n" };
        for (let i = 0; i < 160; i++) files[`m${i}.py`] = "x = 1\n";
        const { edit, kernel, sidecar, dir } = await project(files);

        for (let round = 0; round < 4; round++) {
            const dependents = Array.from({ length: 40 }, (_, i) => `m${round * 40 + i}.py`);
            const r = await edit("lib.py", `DEF(helper)\nround = ${round}\n`, dependents);
            expect(r.safe).toBe(true);
            await kernel.commitToDisk();
            expect(sidecar.openDocumentCount()).toBeLessThanOrEqual(LspSidecarBase.MAX_OPEN_DOCUMENTS);
        }
        // The most recent dependents are the ones kept.
        expect(sidecar.hasOpenDocument(path.join(dir, "m159.py"))).toBe(true);
        expect(sidecar.hasOpenDocument(path.join(dir, "m0.py"))).toBe(false);
    });
});

describe("GoLspSidecar.companionFiles", () => {
    it("lists the other .go files of the directory, not subpackages", () => {
        const dir = tmp("nreki-go-companions-", {
            "lib.go": "package main\n", "main.go": "package main\n", "lib_test.go": "package main\n",
            "README.md": "", "sub/x.go": "package sub\n",
        });
        const sidecar = new GoLspSidecar(dir); // not booted: companionFiles only reads the directory
        const names = sidecar.companionFiles(path.join(dir, "lib.go")).map(p => path.basename(p));
        expect(names).toEqual(["lib_test.go", "main.go"]);
        expect(sidecar.companionFiles(path.join(dir, "missing", "x.go"))).toEqual([]);
    });
});

// ─── Handlers: importers reach the kernel, and the answer stays short ──

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

function routerDeps(dir: string, kernel: NrekiKernel | undefined, mode: string, graph: Record<string, string[]>): RouterDependencies {
    return {
        engine: {
            initialize: async () => {},
            getProjectRoot: () => dir,
            getParser: () => parser,
            expectInternalEdit: vi.fn(),
            cancelInternalEdit: vi.fn(),
            invalidateCachedGraph: vi.fn(),
            logUsage: vi.fn(),
            findDependents: async (rel: string) => graph[rel.replace(/\\/g, "/")] ?? [],
            getDependencyGraph: async () => ({ importedBy: new Map(), inDegree: new Map(), tiers: new Map() }),
        },
        sandbox,
        kernel,
        nrekiMode: mode,
    } as unknown as RouterDependencies;
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");

describe("edit handlers hand Go/Python importers to the kernel in every mode", () => {
    const LIB = "def helper():\n    return DEF(helper)\n";
    const CONSUMER = "def use():\n    return NEEDS(helper)\n";

    it("edit: breaking an unopened importer is rejected, in project mode too", async () => {
        const { dir, kernel } = await project({ "lib.py": LIB, "consumer.py": CONSUMER });
        const deps = routerDeps(dir, kernel, "project", { "lib.py": ["consumer.py"] });

        const rejected = await handleEdit({ action: "edit", path: "lib.py", symbol: "helper", new_code: "def helper():\n    return 1" }, deps);
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("consumer.py");
        expect(textOf(rejected)).toContain("mock undefined helper");
        expect(fs.readFileSync(path.join(dir, "lib.py"), "utf8")).toBe(LIB);

        const ok = await handleEdit({ action: "edit", path: "lib.py", symbol: "helper", new_code: "def helper():\n    return [DEF(helper)]" }, deps);
        expect(ok.isError).not.toBe(true);
        expect(textOf(ok)).toContain("mock LSP diagnostics on the edited file(s) + 1 dependent file(s) (same package / importers) (new errors only)");
        expect(fs.readFileSync(path.join(dir, "lib.py"), "utf8")).toBe("def helper():\n    return [DEF(helper)]\n");
    });

    it("batch_edit: same, and a file of the batch is not its own dependent", async () => {
        const { dir, kernel } = await project({ "lib.py": LIB, "consumer.py": CONSUMER, "extra.py": "def e():\n    return 1\n" });
        const deps = routerDeps(dir, kernel, "project", { "lib.py": ["consumer.py", "extra.py"] });

        const rejected = await handleBatchEdit({ action: "batch_edit", edits: [
            { path: "lib.py", symbol: "helper", new_code: "def helper():\n    return 1" },
            { path: "extra.py", symbol: "e", new_code: "def e():\n    return 2" },
        ] }, deps);
        expect(rejected.isError).toBe(true);
        expect(textOf(rejected)).toContain("consumer.py");
        expect(fs.readFileSync(path.join(dir, "lib.py"), "utf8")).toBe(LIB);

        const ok = await handleBatchEdit({ action: "batch_edit", edits: [
            { path: "lib.py", symbol: "helper", new_code: "def helper():\n    return [DEF(helper)]" },
            { path: "extra.py", symbol: "e", new_code: "def e():\n    return 2" },
        ] }, deps);
        expect(ok.isError).not.toBe(true);
        expect(textOf(ok)).toContain("+ 1 dependent file(s)");
    });
});

function tsProject(importerCount: number): { dir: string; importers: string[] } {
    const files: Record<string, string> = {
        "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
        "src/math.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\n",
    };
    const importers: string[] = [];
    for (let i = 0; i < importerCount; i++) {
        const rel = `src/use${String(i).padStart(2, "0")}.ts`;
        files[rel] = `import { add } from "./math";\nexport const v${i}: number = add(${i}, 1);\n`;
        importers.push(rel);
    }
    return { dir: tmp("nreki-caps-", files), importers };
}

describe("a rejection and the blast-radius note stay bounded", () => {
    it("30 broken importers are not 30 lines", async () => {
        const { dir, importers } = tsProject(30);
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const deps = routerDeps(dir, kernel, "file", { "src/math.ts": importers });

        const res = await handleEdit({
            action: "edit", path: "src/math.ts", symbol: "add",
            new_code: "export function add(a: number, b: number, c: number): number {\n    return a + b + c;\n}",
        }, deps);
        const text = textOf(res);
        expect(res.isError).toBe(true);
        expect(text).toContain("Semantic errors (30):");
        expect(text.split("\n").filter(l => l.includes("→")).length).toBe(ERROR_LIST_CAP);
        expect(text).toContain(`+${30 - ERROR_LIST_CAP} more not listed (TS2554 ×${30 - ERROR_LIST_CAP})`);
        // The remainder is still located: its first files by name, the others as a count.
        expect(text).toContain("use23.ts, +6 more file(s)");
        expect(text).not.toContain("use24.ts");
    });

    it("importers the kernel type-checked are counted, not listed", async () => {
        const { dir, importers } = tsProject(6);
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const deps = routerDeps(dir, kernel, "file", { "src/math.ts": importers });

        const res = await handleEdit({
            action: "edit", path: "src/math.ts", symbol: "add",
            new_code: "export function add(a: number, b: number, c = 0): number {\n    return a + b + c;\n}",
        }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("[BLAST RADIUS] Signature of \"add\" changed. 6 importer(s) were checked with this edit and still compile.");
        expect(text).not.toContain("use00.ts");
        expect(text).not.toContain("Fix dependents");
    });

    it("importers nobody checked are named, up to a cap", async () => {
        const { dir, importers } = tsProject(20);
        const deps = routerDeps(dir, undefined, "syntax", { "src/math.ts": importers });

        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/math.ts", symbol: "add",
            new_code: "export function add(a: number, b: number, c = 0): number {\n    return a + b + c;\n}",
        }] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("[BLAST RADIUS] Signature changed: add. NOT checked (20 importer(s)):");
        expect(text.split("\n").filter(l => l.startsWith("  - src/use")).length).toBe(BLAST_RADIUS_LIST_CAP);
        expect(text).toContain(`+${20 - BLAST_RADIUS_LIST_CAP} more`);
    });
});

describe("formatErrorList / formatBlastRadius", () => {
    const err = (file: string, code = "TS2554", message = "Expected 3 arguments, but got 2.") =>
        ({ file, line: 2, column: 27, code, message });

    it("a short list is printed in full; the edited file comes first", () => {
        const out = formatErrorList([err("b.ts"), err("a.ts", "TS2322", "nope")], { isPrimary: e => e.file === "a.ts" });
        expect(out).toBe("  → a.ts (2,27): TS2322 - nope\n  → b.ts (2,27): TS2554 - Expected 3 arguments, but got 2.");
    });

    it("a long list keeps the first ones and summarises the rest by code and file", () => {
        const errors = [...Array.from({ length: 40 }, (_, i) => err(`f${i}.ts`)), err("z.ts", "TS2322", "other")];
        const lines = formatErrorList(errors).split("\n");
        expect(lines).toHaveLength(ERROR_LIST_CAP + 1);
        expect(lines[ERROR_LIST_CAP]).toContain(`+${41 - ERROR_LIST_CAP} more not listed (TS2554 ×28, TS2322 ×1) in: f12.ts`);
        expect(lines[ERROR_LIST_CAP]).toMatch(/\+\d+ more file\(s\)$/);
    });

    it("clips one enormous diagnostic", () => {
        const out = formatErrorList([err("a.ts", "TS2322", "x".repeat(5000))]);
        expect(out.length).toBeLessThan(800);
        expect(out).toContain("[+4400 chars]");
    });

    it("blast radius: verified importers are a count, the rest a capped list", () => {
        const deps = Array.from({ length: 20 }, (_, i) => `src/u${i}.ts`);
        expect(formatBlastRadius("Signature of \"f\" changed", deps, new Set(deps)))
            .toBe("\n[BLAST RADIUS] Signature of \"f\" changed. 20 importer(s) were checked with this edit and still compile.");
        const partial = formatBlastRadius("Signature of \"f\" changed", deps, new Set(deps.slice(0, 18)));
        expect(partial).toContain("18 importer(s) were checked with this edit and still compile. NOT checked (2 importer(s)):\n  - src/u18.ts\n  - src/u19.ts\n");
        expect(formatBlastRadius("Signature changed: f", [], new Set())).toBe("\n[BLAST RADIUS] Signature changed: f.");
    });

    it("verifiedImporters: only what the kernel really checked", () => {
        const coverage = (f: string) => f.endsWith(".py") ? { backend: "lsp" as const, languageId: "python" }
            : f.endsWith(".js") ? { backend: null }
            : { backend: "typescript" as const, outsideProgram: f.includes("excluded") };
        const kernel = { getSemanticCoverage: coverage } as unknown as NrekiKernel;
        const deps = ["a.ts", "b.ts", "excluded/c.ts", "d.js", "e.py"];

        expect([...verifiedImporters(deps, { kernelRan: false, kernel, mode: "project", injected: deps })]).toEqual([]);
        expect([...verifiedImporters(deps, { kernelRan: true, kernel, mode: "project", injected: [] })]).toEqual(["a.ts", "b.ts"]);
        expect([...verifiedImporters(deps, { kernelRan: true, kernel, mode: "file", injected: ["a.ts", "e.py"] })]).toEqual(["a.ts"]);
        expect([...verifiedImporters(deps, {
            kernelRan: true, kernel, mode: "file", injected: ["a.ts", "e.py"],
            lspCoverage: [{ languageId: "python", checked: 1, skipped: 0 }],
        })]).toEqual(["a.ts", "e.py"]);
        expect([...verifiedImporters(deps, {
            kernelRan: true, kernel, mode: "file", injected: ["e.py"],
            lspCoverage: [{ languageId: "python", checked: 50, skipped: 3 }],
        })]).toEqual([]);
        expect([...verifiedImporters(deps, {
            kernelRan: true, kernel, mode: "file", injected: ["e.py"], degradedLanguages: ["python"],
            lspCoverage: [{ languageId: "python", checked: 1, skipped: 0 }],
        })]).toEqual([]);
    });
});
