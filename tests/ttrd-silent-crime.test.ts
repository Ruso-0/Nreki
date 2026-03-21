import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

describe("TTRD: silent type degradation", () => {
    let tmpDir: string;
    let kernel: NrekiKernel;

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ttrd-"));

        // Strict contract
        fs.writeFileSync(path.join(tmpDir, "api.ts"), `
            export interface RetryConfig { count: number; delay: number; }
            export function initService(config: RetryConfig): void { }
        `);

        // Consumer that depends on the contract
        fs.writeFileSync(path.join(tmpDir, "main.ts"), `
            import { initService } from "./api";
            export function run() { initService({ count: 3, delay: 100 }); }
        `);

        fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                target: "ES2022",
                module: "commonjs",
                strict: true,
                noEmit: true,
                esModuleInterop: true,
                skipLibCheck: true,
            },
            include: ["./**/*.ts"],
            exclude: ["node_modules"],
        }));

        kernel = new NrekiKernel();
        kernel.boot(tmpDir, "project");
    });

    afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("catches parameter type degraded to any", async () => {
        // Agent changes RetryConfig to any. TypeScript says nothing.
        const mutatedCode = `
            export interface RetryConfig { count: number; delay: number; }
            export function initService(config: any): void { }
        `;

        const result = await kernel.interceptAtomicBatch([
            { targetFile: path.join(tmpDir, "api.ts"), proposedContent: mutatedCode }
        ]);

        // Compiler approves (0 errors)
        expect(result.safe).toBe(true);
        expect(result.structured?.length || 0).toBe(0);

        // TTRD catches the degradation
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.length).toBe(1);

        const reg = result.regressions![0];
        expect(reg.symbol).toBe("initService");

        // Use toContain, not toBe. TypeChecker string format changes between TS versions.
        expect(reg.oldType).toContain("RetryConfig");
        expect(reg.oldType).not.toContain("any");
        expect(reg.newType).toContain("any");
        expect(reg.newType).not.toContain("RetryConfig");
    });
});
