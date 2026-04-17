/**
 * v10.7.0 — Integration tests for handleOutline (NREKI Way features).
 *
 * Covers three parasitic signals added in v10.7.0:
 *   - Ghost Oracle: exported symbols with 0 external refs get `👻 [0 ext refs]`.
 *   - Ghost Oracle entry-file exemption: exports in index/config/test files
 *     must NOT get the ghost tag (they're referenced by the runtime, not by
 *     the import graph).
 *   - Immortal ASSERT engrams: engrams whose insight starts with "ASSERT"
 *     (case-insensitive) survive AST hash mutation. Regular engrams still
 *     invalidate on mutation.
 *
 * Pattern follows tests/bugfix-audit.test.ts + tests/nreki-integration.test.ts:
 *   temp project + real NrekiEngine, no heavy mocking. The deps object only
 *   needs `engine` because handleOutline uses nothing else.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleOutline } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-outline-"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "Node16", moduleResolution: "Node16",
            strict: true, esModuleInterop: true, outDir: "dist", rootDir: ".",
            skipLibCheck: true,
        },
        include: ["./**/*.ts"], exclude: ["node_modules", "dist"],
    }));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    return dir;
}

async function bootEngine(dir: string): Promise<NrekiEngine> {
    const engine = new NrekiEngine({
        dbPath: path.join(dir, ".nreki-test.db"),
        watchPaths: [dir],
    });
    await engine.initialize();
    await engine.indexDirectory(dir);
    return engine;
}

function makeDeps(engine: NrekiEngine): RouterDependencies {
    // handleOutline only reads deps.engine — other fields are unused.
    return { engine } as unknown as RouterDependencies;
}

function extractText(response: { content: Array<{ text?: string }> }): string {
    return response.content[0]?.text ?? "";
}

describe("handleOutline — v10.7.0 Ghost Oracle + Immortal Engrams", () => {
    let dir: string;
    let engine: NrekiEngine;

    afterEach(async () => {
        if (engine) await engine.shutdown();
        if (dir) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    });

    it("ghost tag appears on exported symbol with 0 external references", async () => {
        dir = createTempProject({
            "lib.ts":
                "export function usedHelper(): number { return 1; }\n" +
                "export function lonelyExport(): number { return 42; }\n",
            "consumer.ts":
                "import { usedHelper } from \"./lib.js\";\n" +
                "export function doWork(): number { return usedHelper() + 1; }\n",
        });
        engine = await bootEngine(dir);

        const response = await handleOutline({ action: "outline", path: "lib.ts" }, makeDeps(engine));
        const text = extractText(response);

        // lonelyExport appears nowhere except its own declaration file.
        expect(text).toContain("lonelyExport");
        expect(text).toMatch(/lonelyExport.*👻 \[0 ext refs\]/);

        // usedHelper IS referenced by consumer.ts — must NOT be ghost-tagged.
        expect(text).toContain("usedHelper");
        const helperLine = text.split("\n").find(l => l.includes("usedHelper")) ?? "";
        expect(helperLine).not.toContain("👻");
    });

    it("ghost tag does NOT appear on exports in entry files (index / config / test)", async () => {
        dir = createTempProject({
            "index.ts":
                "export function main(): void { /* entry point */ }\n",
            "app.config.ts":
                "export const settings = { port: 3000 };\n",
            "foo.test.ts":
                "export function testHelper(): boolean { return true; }\n",
        });
        engine = await bootEngine(dir);

        for (const file of ["index.ts", "app.config.ts", "foo.test.ts"]) {
            const response = await handleOutline({ action: "outline", path: file }, makeDeps(engine));
            const text = extractText(response);
            // Even though main/settings/testHelper have 0 external refs, the
            // entry-file exemption keeps them off the ghost-list.
            expect(text).not.toContain("👻");
        }
    });

    it("immortal ASSERT engram survives AST-hash mutation", async () => {
        dir = createTempProject({
            "immortal.ts":
                "export function validate(input: string): boolean {\n" +
                "    return input.length > 0;\n" +
                "}\n",
        });
        engine = await bootEngine(dir);

        // Seed an engram with a DELIBERATELY WRONG hash — simulates a
        // post-mutation state where the code no longer matches the stored
        // hash. The ASSERT prefix makes it immortal anyway.
        const resolvedPath = path.resolve(dir, "immortal.ts");
        engine.upsertEngram(
            resolvedPath,
            "validate",
            "deadbeef".repeat(8), // 64-char fake SHA256
            "ASSERT input must never be null — caller guarantees pre-check.",
        );

        const response = await handleOutline({ action: "outline", path: "immortal.ts" }, makeDeps(engine));
        const text = extractText(response);

        // Engram line must render despite hash mismatch.
        expect(text).toContain("[Engram]: ASSERT input must never be null");
        expect(text).not.toContain("Engram invalidated");
        // And the "obsolete engram(s) deleted" summary must NOT fire for it.
        expect(text).not.toMatch(/obsolete engram\(s\) automatically deleted/);
    });

    it("regular engram DOES invalidate on AST-hash mutation", async () => {
        dir = createTempProject({
            "mortal.ts":
                "export function greet(name: string): string {\n" +
                "    return `hello, ${name}`;\n" +
                "}\n",
        });
        engine = await bootEngine(dir);

        const resolvedPath = path.resolve(dir, "mortal.ts");
        engine.upsertEngram(
            resolvedPath,
            "greet",
            "c0ffeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "Returns a greeting — safe to call with any utf-8 name.",
        );

        const response = await handleOutline({ action: "outline", path: "mortal.ts" }, makeDeps(engine));
        const text = extractText(response);

        // Hash mismatch + no ASSERT prefix → must invalidate.
        expect(text).toContain("Engram invalidated");
        expect(text).toMatch(/obsolete engram\(s\) automatically deleted/);
    });

    it("immortal ASSERT is case-insensitive (assert / ASSERT / AsSeRt all match)", async () => {
        dir = createTempProject({
            "ci.ts": "export function f(): number { return 1; }\n",
        });
        engine = await bootEngine(dir);

        const resolvedPath = path.resolve(dir, "ci.ts");
        engine.upsertEngram(
            resolvedPath,
            "f",
            "1234".repeat(16), // wrong hash, 64 chars
            "assert this value is always positive",
        );

        const response = await handleOutline({ action: "outline", path: "ci.ts" }, makeDeps(engine));
        const text = extractText(response);

        expect(text).toContain("[Engram]: assert this value is always positive");
        expect(text).not.toContain("Engram invalidated");
    });
});
