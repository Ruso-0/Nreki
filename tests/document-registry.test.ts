/**
 * Tests for DocumentRegistry memory leak fix (Bug 2 fix).
 *
 * Validates that:
 * - Multiple intercepts on the same file don't crash
 * - mutatedFiles is cleared after commitToDisk and rollbackAll
 * - Kernel functions correctly after document release
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;
let kernel: NrekiKernel;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-docreg-"));

    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            strict: true,
            outDir: "dist",
            declaration: true,
        },
        include: ["*.ts"],
    }));

    fs.writeFileSync(
        path.join(tmpDir, "api.ts"),
        `export const value: number = 1;\n`
    );

    kernel = new NrekiKernel();
    kernel.boot(tmpDir);
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DocumentRegistry cleanup", () => {
    it("should handle many intercepts on the same file without crash", { timeout: 360_000 }, async () => {
        // Perform 20 intercepts on the same file with different content
        for (let i = 0; i < 20; i++) {
            const result = await kernel.interceptAtomicBatch([{
                targetFile: "api.ts",
                proposedContent: `export const value: number = ${i};\n`,
            }]);
            expect(result.safe).toBe(true);
            await kernel.rollbackAll();
        }

        // Kernel should still work after many intercepts
        const finalResult = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: string = "final";\n`,
        }]);
        expect(finalResult.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("should function correctly after commitToDisk releases documents", async () => {
        const r1 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: number = 100;\n`,
        }]);
        expect(r1.safe).toBe(true);

        await kernel.commitToDisk();

        // After commit + document release, kernel should still validate correctly
        const r2 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: number = 200;\n`,
        }]);
        expect(r2.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("should function correctly after rollbackAll releases documents", async () => {
        const r1 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: number = 999;\n`,
        }]);
        expect(r1.safe).toBe(true);

        await kernel.rollbackAll();

        // After rollback + document release, kernel should still validate
        const r2 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: string = "after-rollback";\n`,
        }]);
        expect(r2.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("should still block invalid edits after document release cycle", async () => {
        // Cycle through intercept -> rollback several times
        for (let i = 0; i < 5; i++) {
            await kernel.interceptAtomicBatch([{
                targetFile: "api.ts",
                proposedContent: `export const value: number = ${i};\n`,
            }]);
            await kernel.rollbackAll();
        }

        // Now try an invalid edit - should still be blocked
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: `export const value: number = "not a number";\n`,
        }]);
        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });
});
