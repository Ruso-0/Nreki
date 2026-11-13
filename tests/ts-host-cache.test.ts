/**
 * The TypeScript compiler host in a long-lived server.
 *
 * `ts.createIncrementalCompilerHost` is built for one compilation: it caches
 * every fileExists() answer and the text of every .json file forever, and it
 * re-parses every source file for each new program. NREKI keeps one host for
 * the whole session, so both hurt: files created later stayed "missing", JSON
 * modules stayed at their first content, and each edit re-parsed the project.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function project(files: Record<string, string>, compilerOptions: Record<string, unknown> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ts-host-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ES2022", module: "commonjs", strict: true, noEmit: true, skipLibCheck: true, types: [], ...compilerOptions },
        include: ["./**/*.ts"],
    }));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    return dir;
}

interface BackendView {
    tsProgram: { getSourceFile(p: string): object | undefined; getSourceFiles(): readonly object[] };
    sourceFiles: Map<string, unknown>;
}
const backendOf = (kernel: NrekiKernel) => (kernel as unknown as { tsBackend: BackendView }).tsBackend;
const posix = (p: string) => p.replace(/\\/g, "/");

describe("compiler host: parsed files are kept across program builds", () => {
    async function threeFiles() {
        const dir = project({
            "dep.ts": "export const x: number = 1;\n",
            "app.ts": "import { x } from \"./dep\";\nexport const a: number = x;\n",
            "other.ts": "export const o = 1;\n",
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const edit = async (file: string, proposedContent: string) => {
            const r = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, file), proposedContent }]);
            if (r.safe) await kernel.commitToDisk();
            return r;
        };
        const parsed = (file: string) => backendOf(kernel).tsProgram.getSourceFile(posix(path.join(dir, file)));
        return { dir, kernel, edit, parsed };
    }

    it("hands the same SourceFile back while the text is unchanged, a new one when it changes", async () => {
        const { edit, parsed } = await threeFiles();
        expect((await edit("other.ts", "export const o = 2;\n")).safe).toBe(true);
        const dep = parsed("dep.ts"), other = parsed("other.ts");
        expect(dep).toBeDefined();

        expect((await edit("other.ts", "export const o = 3;\n")).safe).toBe(true);
        expect(parsed("dep.ts")).toBe(dep);         // untouched: not parsed again
        expect(parsed("other.ts")).not.toBe(other); // edited: parsed again
    });

    it("never serves a stale parse: a file rewritten outside NREKI is re-read", async () => {
        const { dir, edit } = await threeFiles();
        expect((await edit("other.ts", "export const o = 2;\n")).safe).toBe(true); // dep.ts is cached now

        fs.writeFileSync(path.join(dir, "dep.ts"), "export const x: string = \"s\";\n"); // IDE save, git checkout...
        const asNumber = await edit("app.ts", "import { x } from \"./dep\";\nexport const a: number = x + 1;\n");
        expect(asNumber.safe).toBe(false); // x is a string now
        const asString = await edit("app.ts", "import { x } from \"./dep\";\nexport const a: string = x.toUpperCase();\n");
        expect(asString.errorText ?? "").toBe("");
        expect(asString.safe).toBe(true);
    });

    it("parses everything again when the compiler options change", async () => {
        const { dir, kernel, edit, parsed } = await threeFiles();
        expect((await edit("other.ts", "export const o = 2;\n")).safe).toBe(true);
        const dep = parsed("dep.ts");

        const tsconfig = path.join(dir, "tsconfig.json");
        fs.writeFileSync(tsconfig, fs.readFileSync(tsconfig, "utf8").replace("ES2022", "ES2019"));
        await kernel.rollbackAll(); // re-reads tsconfig.json
        expect((await edit("other.ts", "export const o = 3;\n")).safe).toBe(true);
        expect(parsed("dep.ts")).not.toBe(dep);
    });

    it("does not accumulate old versions of an edited file", async () => {
        const { kernel, edit } = await threeFiles();
        for (let i = 0; i < 12; i++) expect((await edit("other.ts", `export const o = ${i + 10};\n`)).safe).toBe(true);
        const backend = backendOf(kernel);
        expect(backend.sourceFiles.size).toBe(backend.tsProgram.getSourceFiles().length);
    });
});

describe("compiler host: no answer outlives the file system", () => {
    it("resolves an import to a file created after a failed attempt", async () => {
        const dir = project({ "app.ts": "export const a = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const app = path.join(dir, "app.ts");
        const withImport = "import { x } from \"./newmod\";\nexport const a = x;\n";

        const before = await kernel.interceptAtomicBatch([{ targetFile: app, proposedContent: withImport }]);
        expect(before.safe).toBe(false); // newmod does not exist yet

        fs.writeFileSync(path.join(dir, "newmod.ts"), "export const x = 1;\n"); // created outside NREKI
        const after = await kernel.interceptAtomicBatch([{ targetFile: app, proposedContent: withImport }]);
        expect(after.errorText ?? "").toBe("");
        expect(after.safe).toBe(true);
    });

    it("type-checks against a JSON module as last committed, not as first read", async () => {
        const dir = project({
            "data.json": "{ \"a\": 1 }\n",
            "app.ts": "import data from \"./data.json\";\nexport const v: number = data.a;\n",
        }, { resolveJsonModule: true, esModuleInterop: true });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");

        const json = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, "data.json"), proposedContent: "{ \"a\": 1, \"b\": 2 }\n" }]);
        expect(json.safe).toBe(true);
        await kernel.commitToDisk();

        const app = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "app.ts"),
            proposedContent: "import data from \"./data.json\";\nexport const v: number = data.a + data.b;\n",
        }]);
        expect(app.errorText ?? "").toBe("");
        expect(app.safe).toBe(true);
    });
});
