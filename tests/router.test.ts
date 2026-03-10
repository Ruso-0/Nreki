/**
 * router.test.ts — Tests for the v3.0 router dispatcher.
 *
 * Covers:
 * - All 14 {tool, action} dispatch combinations
 * - Invalid action handling
 * - Error response formatting
 * - Correct delegation to handler functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    handleNavigate,
    handleCode,
    handleGuard,
    type RouterDependencies,
    type McpToolResponse,
} from "../src/router.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Mock dependencies ──────────────────────────────────────────────

function createMockDeps(): RouterDependencies {
    const mockEngine = {
        initialize: vi.fn().mockResolvedValue(undefined),
        initializeEmbedder: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockReturnValue({
            filesIndexed: 10,
            totalChunks: 100,
            compressionRatio: 0.6,
            watchedPaths: ["/test"],
        }),
        getParser: vi.fn().mockReturnValue({
            initialize: vi.fn().mockResolvedValue(undefined),
            parse: vi.fn().mockResolvedValue({ chunks: [] }),
            isSupported: vi.fn().mockReturnValue(true),
        }),
        getProjectRoot: vi.fn().mockReturnValue(process.cwd()),
        indexDirectory: vi.fn().mockResolvedValue({ indexed: 5, skipped: 0, errors: 0 }),
        getRepoMap: vi.fn().mockResolvedValue({
            map: {},
            text: "# Repo Map\nfile1.ts\nfile2.ts",
            fromCache: false,
        }),
        compressFile: vi.fn().mockResolvedValue({
            compressed: "function foo() { ... }",
            chunksFound: 3,
            originalSize: 1000,
            compressedSize: 200,
            ratio: 0.8,
            tokensSaved: 200,
        }),
        compressFileAdvanced: vi.fn().mockResolvedValue({
            compressed: "fn foo() => ...",
            originalSize: 1000,
            compressedSize: 200,
            ratio: 0.8,
            tokensSaved: 200,
            breakdown: {
                preprocessingReduction: 100,
                tokenFilterReduction: 300,
                structuralReduction: 400,
            },
        }),
        logUsage: vi.fn(),
        getSessionReport: vi.fn().mockReturnValue({
            totalTokensSaved: 5000,
            totalOriginalTokens: 15000,
            overallRatio: 0.66,
            durationMinutes: 10,
            savedUsdSonnet: 0.015,
            savedUsdOpus: 0.075,
            byFileType: [],
        }),
        getUsageStats: vi.fn().mockReturnValue({
            total_input: 1000,
            total_output: 500,
            total_saved: 3000,
            tool_calls: 15,
        }),
        shutdown: vi.fn(),
    } as any;

    const monitor = new TokenMonitor();
    const sandbox = new AstSandbox();
    const circuitBreaker = new CircuitBreaker();

    return {
        engine: mockEngine,
        monitor,
        sandbox,
        circuitBreaker,
    };
}

// ─── tg_navigate dispatch ───────────────────────────────────────────

describe("handleNavigate", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("dispatches 'search' action correctly", async () => {
        const result = await handleNavigate("search", "database init", undefined, deps);
        expect(result.content).toBeDefined();
        expect(result.content[0].type).toBe("text");
        expect(result.isError).toBeUndefined();
    });

    it("dispatches 'search' with results from engine", async () => {
        deps.engine.search = vi.fn().mockResolvedValue([
            {
                path: "/test/file.ts",
                shorthand: "fn init()",
                rawCode: "function init() { ... }",
                nodeType: "function",
                startLine: 1,
                endLine: 5,
                score: 0.95,
            },
        ]);
        const result = await handleNavigate("search", "init", undefined, deps);
        expect(result.content[0].text).toContain("init");
        expect(result.content[0].text).toContain("TokenGuard");
    });

    it("dispatches 'definition' action correctly", async () => {
        const result = await handleNavigate("definition", "MyClass", undefined, deps);
        expect(result.content[0].type).toBe("text");
        // No definition found in mock, so message should indicate that
        expect(result.content[0].text).toContain("MyClass");
    });

    it("dispatches 'references' action correctly", async () => {
        const result = await handleNavigate("references", "handleSearch", undefined, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'outline' action correctly", async () => {
        const result = await handleNavigate("outline", "src/router.ts", undefined, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'map' action correctly", async () => {
        const result = await handleNavigate("map", undefined, undefined, deps);
        expect(result.content[0].text).toContain("Repo Map");
    });

    it("dispatches 'map' with refresh option", async () => {
        const result = await handleNavigate("map", undefined, { refresh: true }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("returns error for invalid action", async () => {
        const result = await handleNavigate("invalid_action", "test", undefined, deps);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown tg_navigate action");
        expect(result.content[0].text).toContain("invalid_action");
    });

    it("lists valid actions in error message", async () => {
        const result = await handleNavigate("wrong", "test", undefined, deps);
        expect(result.content[0].text).toContain("search");
        expect(result.content[0].text).toContain("definition");
        expect(result.content[0].text).toContain("references");
        expect(result.content[0].text).toContain("outline");
        expect(result.content[0].text).toContain("map");
    });
});

// ─── tg_code dispatch ───────────────────────────────────────────────

describe("handleCode", () => {
    let deps: RouterDependencies;
    let tmpDir: string;

    beforeEach(() => {
        deps = createMockDeps();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-"));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    });

    it("dispatches 'read' action correctly", async () => {
        const testFile = path.join(tmpDir, "test.ts");
        fs.writeFileSync(testFile, "const x = 1;\n".repeat(100));

        const result = await handleCode("read", testFile, undefined, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'compress' action correctly", async () => {
        const testFile = path.join(tmpDir, "compress-test.ts");
        fs.writeFileSync(testFile, "function foo() { return 1; }\n".repeat(50));

        const result = await handleCode("compress", testFile, { level: "medium" }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'edit' requires symbol and new_code", async () => {
        const result = await handleCode("edit", "test.ts", {}, deps);
        expect(result.content[0].text).toContain("symbol");
        expect(result.content[0].text).toContain("new_code");
    });

    it("dispatches 'undo' requires valid file", async () => {
        const result = await handleCode("undo", "nonexistent.ts", undefined, deps);
        expect(result.content[0].text).toContain("tg_undo");
    });

    it("dispatches 'terminal' requires output", async () => {
        const result = await handleCode("terminal", undefined, {}, deps);
        expect(result.content[0].text).toContain("command");
    });

    it("dispatches 'terminal' filters noisy output", async () => {
        const noisyOutput = "Error: something broke\n".repeat(10) +
            "\x1b[31mRed text\x1b[0m\n".repeat(5) +
            "  at node_modules/foo.js:42:10\n".repeat(20);

        const result = await handleCode("terminal", undefined, { output: noisyOutput }, deps);
        expect(result.content[0].text).toContain("Terminal Filter");
    });

    it("returns error for invalid action", async () => {
        const result = await handleCode("deploy", "file.ts", undefined, deps);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown tg_code action");
        expect(result.content[0].text).toContain("deploy");
    });

    it("lists valid actions in error message", async () => {
        const result = await handleCode("wrong", "file.ts", undefined, deps);
        expect(result.content[0].text).toContain("read");
        expect(result.content[0].text).toContain("compress");
        expect(result.content[0].text).toContain("edit");
        expect(result.content[0].text).toContain("undo");
        expect(result.content[0].text).toContain("terminal");
    });
});

// ─── tg_guard dispatch ──────────────────────────────────────────────

describe("handleGuard", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("dispatches 'pin' action correctly", async () => {
        const result = await handleGuard("pin", { text: "Always use camelCase" }, deps);
        expect(result.content[0].text).toContain("Pin");
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'pin' requires text", async () => {
        const result = await handleGuard("pin", {}, deps);
        expect(result.content[0].text).toContain("text");
    });

    it("dispatches 'unpin' action correctly", async () => {
        // Pin first, then unpin
        await handleGuard("pin", { text: "Test rule" }, deps);
        const result = await handleGuard("unpin", { id: "pin_001" }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("dispatches 'status' action correctly", async () => {
        const result = await handleGuard("status", undefined, deps);
        expect(result.content[0].text).toContain("Index Status");
    });

    it("dispatches 'report' action correctly", async () => {
        const result = await handleGuard("report", undefined, deps);
        expect(result.content[0].text).toContain("Session Report");
    });

    it("returns error for invalid action", async () => {
        const result = await handleGuard("deploy", undefined, deps);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown tg_guard action");
    });

    it("lists valid actions in error message", async () => {
        const result = await handleGuard("wrong", undefined, deps);
        expect(result.content[0].text).toContain("pin");
        expect(result.content[0].text).toContain("unpin");
        expect(result.content[0].text).toContain("status");
        expect(result.content[0].text).toContain("report");
    });
});

// ─── Response format ────────────────────────────────────────────────

describe("Response format", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("all responses have content array with text type", async () => {
        const results: McpToolResponse[] = [
            await handleNavigate("search", "test", undefined, deps),
            await handleCode("terminal", undefined, { output: "hello" }, deps),
            await handleGuard("status", undefined, deps),
        ];

        for (const result of results) {
            expect(result.content).toBeInstanceOf(Array);
            expect(result.content.length).toBeGreaterThan(0);
            expect(result.content[0].type).toBe("text");
            expect(typeof result.content[0].text).toBe("string");
        }
    });

    it("error responses always have isError: true", async () => {
        const errors: McpToolResponse[] = [
            await handleNavigate("bad_action", "", undefined, deps),
            await handleCode("bad_action", "", undefined, deps),
            await handleGuard("bad_action", undefined, deps),
        ];

        for (const result of errors) {
            expect(result.isError).toBe(true);
        }
    });

    it("successful responses do not set isError", async () => {
        const success = await handleNavigate("search", "test", undefined, deps);
        expect(success.isError).toBeUndefined();
    });
});
