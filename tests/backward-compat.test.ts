/**
 * backward-compat.test.ts — Backward compatibility tests for v3.0.
 *
 * For each of the 16 original tools, verifies that the equivalent
 * router call produces a valid response structure. This ensures
 * all original functionality is accessible through the new 3-tool API.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    handleNavigate,
    handleCode,
    handleGuard,
    type RouterDependencies,
} from "../src/router.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";

// ─── Shared mock ────────────────────────────────────────────────────

function createMockDeps(): RouterDependencies {
    const mockEngine = {
        initialize: vi.fn().mockResolvedValue(undefined),
        initializeEmbedder: vi.fn().mockResolvedValue(undefined),
        search: vi.fn().mockResolvedValue([
            {
                path: "/src/file.ts",
                shorthand: "fn init()",
                rawCode: "function init() { return 1; }",
                nodeType: "function",
                startLine: 1,
                endLine: 3,
                score: 0.85,
            },
        ]),
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
            text: "# Repo Map\nsrc/index.ts\nsrc/router.ts",
            fromCache: true,
        }),
        compressFile: vi.fn().mockResolvedValue({
            compressed: "fn foo() => ...",
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

    return {
        engine: mockEngine,
        monitor: new TokenMonitor(),
        sandbox: new AstSandbox(),
        circuitBreaker: new CircuitBreaker(),
    };
}

// ─── Original tg_navigate tools ─────────────────────────────────────

describe("Backward Compatibility: tg_navigate tools", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("tg_search → tg_navigate action:'search'", async () => {
        const result = await handleNavigate("search", "database initialization", { limit: 5 }, deps);
        expect(result.content[0].text).toContain("Search");
        expect(result.content[0].text).toContain("TokenGuard");
        expect(result.isError).toBeUndefined();
    });

    it("tg_def → tg_navigate action:'definition'", async () => {
        const result = await handleNavigate("definition", "CircuitBreaker", { kind: "class" }, deps);
        expect(result.content).toBeDefined();
        expect(result.content[0].type).toBe("text");
    });

    it("tg_refs → tg_navigate action:'references'", async () => {
        const result = await handleNavigate("references", "handleSearch", undefined, deps);
        expect(result.content).toBeDefined();
        expect(result.content[0].type).toBe("text");
    });

    it("tg_outline → tg_navigate action:'outline'", async () => {
        const result = await handleNavigate("outline", "src/router.ts", undefined, deps);
        expect(result.content).toBeDefined();
        expect(result.content[0].type).toBe("text");
    });

    it("tg_map → tg_navigate action:'map'", async () => {
        const result = await handleNavigate("map", undefined, { refresh: false }, deps);
        expect(result.content[0].text).toContain("Repo Map");
        expect(result.content[0].text).toContain("prompt-cacheable");
    });
});

// ─── Original tg_code tools ─────────────────────────────────────────

describe("Backward Compatibility: tg_code tools", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("tg_read → tg_code action:'read'", async () => {
        // Read with a non-existent file should return an error
        const result = await handleCode("read", "nonexistent.ts", undefined, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("tg_compress → tg_code action:'compress'", async () => {
        const result = await handleCode("compress", "nonexistent.ts", { level: "medium" }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("tg_semantic_edit → tg_code action:'edit'", async () => {
        const result = await handleCode("edit", "test.ts", {
            symbol: "myFunction",
            new_code: "function myFunction() { return 42; }",
        }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("tg_undo → tg_code action:'undo'", async () => {
        const result = await handleCode("undo", "no-backup.ts", undefined, deps);
        expect(result.content[0].text).toContain("tg_undo");
    });

    it("tg_terminal → tg_code action:'terminal'", async () => {
        const noisy = "npm ERR! code ELIFECYCLE\nerror TS2345: Argument mismatch\n" +
            "  at Module._compile (internal/modules/cjs/loader.js:1063:30)\n" +
            "  at node_modules/ts-node/src/index.ts:1618:12\n";
        const result = await handleCode("terminal", undefined, { output: noisy, max_lines: 50 }, deps);
        expect(result.content[0].text).toContain("Terminal Filter");
        expect(result.content[0].text).toContain("reduction");
    });
});

// ─── Original tg_guard tools ────────────────────────────────────────

describe("Backward Compatibility: tg_guard tools", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("tg_pin → tg_guard action:'pin'", async () => {
        const result = await handleGuard("pin", { text: "Always use strict null checks" }, deps);
        expect(result.content[0].text).toContain("Pin");
        // Could be ADDED or FAILED (max pins) depending on existing state
        expect(result.content[0].type).toBe("text");
    });

    it("tg_pin (remove) → tg_guard action:'unpin'", async () => {
        // Pin first, then try to unpin
        await handleGuard("pin", { text: "Test rule to remove" }, deps);
        const result = await handleGuard("unpin", { id: "pin_001" }, deps);
        expect(result.content[0].type).toBe("text");
    });

    it("tg_status → tg_guard action:'status'", async () => {
        const result = await handleGuard("status", undefined, deps);
        expect(result.content[0].text).toContain("Index Status");
        expect(result.content[0].text).toContain("Files");
        expect(result.content[0].text).toContain("Chunks");
    });

    it("tg_session_report → tg_guard action:'report'", async () => {
        const result = await handleGuard("report", undefined, deps);
        expect(result.content[0].text).toContain("Session Report");
        expect(result.content[0].text).toContain("RECEIPT");
        expect(result.content[0].text).toContain("Tokens Saved");
    });
});

// ─── Removed tools validation ───────────────────────────────────────

describe("Removed tools are correctly integrated", () => {
    let deps: RouterDependencies;

    beforeEach(() => {
        deps = createMockDeps();
    });

    it("tg_validate is now automatic inside tg_code edit — edit with missing symbol reports error", async () => {
        const result = await handleCode("edit", "test.ts", { symbol: "", new_code: "" }, deps);
        expect(result.content[0].text).toContain("symbol");
    });

    it("tg_circuit_breaker is now passive middleware — breaker accessible via guard status", async () => {
        const result = await handleGuard("status", undefined, deps);
        expect(result.content[0].type).toBe("text");
    });
});
