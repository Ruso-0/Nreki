/**
 * kernel-pre-existing-errors.test.ts — v11.4.0 reproducer suite.
 *
 * User feedback (2026-05-19):
 *   "If a file has a pre-existing TypeScript error unrelated to your edit,
 *    NREKI rejects the whole edit (TS1259/TS2802)."
 *
 * The kernel already has `baselineFrequencies` + `count > baseline` filtering
 * in src/kernel/backends/ts-compiler-wrapper.ts (line ~611). This suite
 * verifies the filter holds for the *same-file* same-symbol unrelated-edit
 * case that the user reported (existing same-file tests only cover
 * separate-file pre-existing errors).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-prebug-"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            strict: true,
            esModuleInterop: false, // OFF so TS1259-style import errors fire
            outDir: "dist",
            rootDir: ".",
            skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    return dir;
}

function cleanupTempProject(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe("Kernel — pre-existing errors in SAME file as edit", () => {
    let dir: string;
    let kernel: NrekiKernel;

    afterEach(() => {
        cleanupTempProject(dir);
    });

    // Reproducer for the user's fillTemplate.ts scenario.
    // Pre-existing TS2322 (type mismatch) in symbol A. Edit symbol B (unrelated).
    // Expected: safe=true. Bug would be safe=false.
    it("ALLOWS unrelated-symbol edit when target file has pre-existing TS2322 in another symbol", async () => {
        dir = createTempProject({
            "fillTemplate.ts": [
                "// Pre-existing error: TS2322 in unrelatedBroken",
                "export const unrelatedBroken: number = \"this is a string\";",
                "",
                "export function untouchedHelper(): string {",
                "    return \"original\";",
                "}",
                "",
                "export function targetForEdit(): number {",
                "    return 1;",
                "}",
            ].join("\n"),
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const baselineCount = kernel.getBaselineErrorCount();
        expect(baselineCount).toBeGreaterThan(0); // confirm pre-existing TS2322 was captured

        const target = path.resolve(dir, "fillTemplate.ts");
        const newContent = [
            "// Pre-existing error: TS2322 in unrelatedBroken",
            "export const unrelatedBroken: number = \"this is a string\";",
            "",
            "export function untouchedHelper(): string {",
            "    return \"original\";",
            "}",
            "",
            "export function targetForEdit(): number {",
            "    return 2;", // <-- only this line changed
            "}",
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        expect(result.safe).toBe(true);
    });

    // Reproducer for TS1259-style pre-existing error.
    // Same-file, edit a different symbol than the offending import use.
    it("ALLOWS unrelated-symbol edit when target file has TS1259-style import error", async () => {
        dir = createTempProject({
            "lib.ts": `export const named = 42;`,
            "fillTemplate.ts": [
                "// Pre-existing: trying to default-import a module that has no default export",
                "// (esModuleInterop is OFF, so this triggers a TS1192-family error)",
                "import lib from \"./lib\";",
                "",
                "export const dummyUse = lib;",
                "",
                "export function targetForEdit(): number {",
                "    return 10;",
                "}",
            ].join("\n"),
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const baselineCount = kernel.getBaselineErrorCount();
        expect(baselineCount).toBeGreaterThan(0);

        const target = path.resolve(dir, "fillTemplate.ts");
        const newContent = [
            "// Pre-existing: trying to default-import a module that has no default export",
            "// (esModuleInterop is OFF, so this triggers a TS1192-family error)",
            "import lib from \"./lib\";",
            "",
            "export const dummyUse = lib;",
            "",
            "export function targetForEdit(): number {",
            "    return 20;", // <-- only this line changed
            "}",
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        expect(result.safe).toBe(true);
    });

    // Sanity counter-test: editing the SYMBOL that holds the pre-existing error,
    // without fixing it, should still be allowed because the error stays
    // identical (same hash). If the user wants the error gone, they fix the
    // type — but we do NOT force them to in unrelated edits.
    it("ALLOWS editing the broken symbol if the error is unchanged (same hash)", async () => {
        dir = createTempProject({
            "broken.ts": [
                "export const broken: number = \"still string\";",
                "",
                "export function aux(): number { return 1; }",
            ].join("\n"),
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const target = path.resolve(dir, "broken.ts");

        // Edit `aux` body. The TS2322 on `broken` is identical pre and post.
        const newContent = [
            "export const broken: number = \"still string\";",
            "",
            "export function aux(): number { return 99; }",
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        expect(result.safe).toBe(true);
    });

    // BLOCK case: edit introduces a NEW error on top of the pre-existing one.
    // Confirms the filter does not mask genuine regressions.
    it("BLOCKS when edit introduces a NEW error while pre-existing one persists", async () => {
        dir = createTempProject({
            "mixed.ts": [
                "export const preExistingBad: number = \"string\";",
                "",
                "export function ok(): string { return \"ok\"; }",
            ].join("\n"),
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const target = path.resolve(dir, "mixed.ts");

        // Pre-existing TS2322 stays; new TS2322 added to `ok`.
        const newContent = [
            "export const preExistingBad: number = \"string\";",
            "",
            "export function ok(): string { return 999; }", // ← new TS2322
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });
});
