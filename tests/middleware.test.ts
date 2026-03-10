/**
 * middleware.test.ts — Tests for v3.0 middleware layer.
 *
 * Covers:
 * - Validator: valid code passes, invalid code blocked with details
 * - Circuit breaker middleware: auto-reset, trip behavior, isError flag
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker, containsError } from "../src/circuit-breaker.js";
import {
    wrapWithCircuitBreaker,
    resetMiddlewareState,
} from "../src/middleware/circuit-breaker.js";
import {
    validateBeforeWrite,
    formatValidationErrors,
} from "../src/middleware/validator.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { McpToolResponse } from "../src/router.js";

// ─── Validator Middleware ────────────────────────────────────────────

describe("Validator Middleware", () => {
    let sandbox: AstSandbox;

    beforeEach(async () => {
        sandbox = new AstSandbox();
    });

    it("should pass valid TypeScript code", async () => {
        const code = `function greet(name: string): string {
    return "Hello, " + name;
}`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        expect(result.valid).toBe(true);
        expect(result.errors.length).toBe(0);
    });

    it("should pass valid JavaScript code", async () => {
        const code = `const sum = (a, b) => a + b;
module.exports = { sum };`;
        const result = await validateBeforeWrite(code, "javascript", sandbox);
        expect(result.valid).toBe(true);
    });

    it("should block code with syntax errors", async () => {
        const code = `function broken( {
    return "missing paren";
}`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should provide error details with line and column", async () => {
        const code = `const x = {
    a: 1,
    b:
};`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (!result.valid) {
            expect(result.errors[0]).toHaveProperty("line");
            expect(result.errors[0]).toHaveProperty("column");
        }
    });

    it("should format errors as human-readable string", async () => {
        const code = `function bad( { return 1; }`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (!result.valid) {
            const formatted = formatValidationErrors(result);
            expect(formatted).toContain("Validation: FAILED");
            expect(formatted).toContain("syntax error");
        }
    });

    it("should return empty string for valid code formatting", async () => {
        const code = `const x = 42;`;
        const result = await validateBeforeWrite(code, "typescript", sandbox);
        if (result.valid) {
            const formatted = formatValidationErrors(result);
            expect(formatted).toBe("");
        }
    });
});

// ─── Circuit Breaker Middleware ─────────────────────────────────────

describe("Circuit Breaker Middleware", () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        cb = new CircuitBreaker();
        resetMiddlewareState();
    });

    it("should pass through successful handler responses", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Success!" }],
        });

        const result = await wrapWithCircuitBreaker(cb, "tg_navigate", "search", handler);
        expect(result.content[0].text).toBe("Success!");
        expect(result.isError).toBeUndefined();
    });

    it("should pass through handler errors without tripping on first occurrence", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: something failed" }],
            isError: true,
        });

        const result = await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler);
        expect(result.isError).toBe(true);
        // First error should not trip the breaker
        expect(result.content[0].text).toContain("TypeError");
        expect(result.content[0].text).not.toContain("CIRCUIT BREAKER");
    });

    it("should trip after 3 identical errors on same tool/action", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot read property 'x'" }],
            isError: true,
        });

        await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");
        const result = await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("CIRCUIT BREAKER");
    });

    it("should return isError: true when breaker trips", async () => {
        const error = "TypeError: Same recurring error";
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: error }],
            isError: true,
        });

        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");
        }

        // Next call should be blocked immediately
        const successHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "This should not execute" }],
        });

        const result = await wrapWithCircuitBreaker(cb, "tg_code", "edit", successHandler);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("CIRCUIT BREAKER TRIPPED");
        expect(result.content[0].text).toContain("human");
    });

    it("should auto-reset when a different tool/action is called", async () => {
        const error = "TypeError: Same error";
        const errorHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: error }],
            isError: true,
        });

        // Trip the breaker
        for (let i = 0; i < 3; i++) {
            await wrapWithCircuitBreaker(cb, "tg_code", "edit", errorHandler, "src/foo.ts");
        }

        expect(cb.getState().tripped).toBe(true);

        // Different tool/action should reset
        const successHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Search result" }],
        });

        const result = await wrapWithCircuitBreaker(cb, "tg_navigate", "search", successHandler);
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe("Search result");
    });

    it("should record non-error calls for file write tracking", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Edit successful" }],
        });

        await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", handler, "src/foo.ts");

        const stats = cb.getStats();
        expect(stats.totalToolCalls).toBeGreaterThanOrEqual(2);
    });

    it("should detect errors in response text even without isError flag", async () => {
        const handler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Build failed with 5 errors\nTypeError: something" }],
        });

        // containsError detects error patterns in text
        expect(containsError("Build failed with 5 errors")).toBe(true);
        expect(containsError("All tests passed")).toBe(false);
    });
});
