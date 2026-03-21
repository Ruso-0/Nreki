import { describe, it, expect } from "vitest";
import { AstSandbox } from "../src/ast-sandbox.js";

describe("ParserPool via AstSandbox", () => {
    it("should validate TypeScript code correctly", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const result = await sandbox.validateCode(
            `export function add(a: number, b: number): number { return a + b; }`,
            "typescript"
        );
        expect(result.valid).toBe(true);
    });

    it("should detect syntax errors", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const result = await sandbox.validateCode(
            `export function add(a: number, b: number { return a + b; }`,
            "typescript"
        );
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should handle concurrent calls with the SAME language safely", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();

        const validCode = `const x: number = 42;`;
        const brokenCode = `const x: number = ;`;

        // Fire 10 concurrent validations for TypeScript
        const results = await Promise.all(
            Array.from({ length: 10 }, (_, i) =>
                sandbox.validateCode(i % 2 === 0 ? validCode : brokenCode, "typescript")
            )
        );

        for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) {
                expect(results[i].valid).toBe(true);
            } else {
                expect(results[i].valid).toBe(false);
            }
        }
    });

    it("should handle concurrent calls with DIFFERENT languages safely", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();

        const tsCode = `export const x: number = 42;`;
        const jsCode = `export const y = 42;`;

        // Fire concurrent TS and JS validations
        const results = await Promise.all([
            sandbox.validateCode(tsCode, "typescript"),
            sandbox.validateCode(jsCode, "javascript"),
            sandbox.validateCode(tsCode, "typescript"),
            sandbox.validateCode(jsCode, "javascript"),
            sandbox.validateCode(tsCode, "typescript"),
        ]);

        for (const result of results) {
            expect(result.valid).toBe(true);
        }
    });

    it("should handle backpressure when pool is exhausted", async () => {
        const sandbox = new AstSandbox();
        await sandbox.initialize();

        // Fire more concurrent calls than pool size (4) for same language
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                sandbox.validateCode(`const a = 1;`, "typescript")
            )
        );

        for (const result of results) {
            expect(result.valid).toBe(true);
        }
    });
});
