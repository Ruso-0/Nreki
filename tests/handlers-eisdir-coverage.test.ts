/**
 * handlers-eisdir-coverage.test.ts — v11.4.2 regression suite.
 *
 * v11.4.0 added a stat-guard to read/compress only. v11.4.1 user feedback
 * + audit surfaced that set_plan, engram, and outline were still vulnerable
 * to EISDIR / silent-fail on directory paths.
 *
 * v11.4.2 centralizes the guard in src/utils/path-guard.ts and applies it
 * to all user-reachable readSource callsites. This file pins that contract
 * so a future refactor cannot quietly drop the guard from any one handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCode, handleNavigate, handleGuard, type RouterDependencies } from "../src/router.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import fs from "fs";
import path from "path";
import os from "os";

function createMinimalDeps(tmpDir: string): RouterDependencies {
    const mockEngine = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getParser: vi.fn().mockReturnValue({
            initialize: vi.fn().mockResolvedValue(undefined),
            parse: vi.fn().mockResolvedValue({ chunks: [] }),
            isSupported: vi.fn().mockReturnValue(true),
        }),
        getProjectRoot: vi.fn().mockReturnValue(tmpDir),
        resolveImportSignatures: vi.fn().mockReturnValue([]),
        compressFileAdvanced: vi.fn().mockResolvedValue({
            compressed: "", originalSize: 0, compressedSize: 0, ratio: 1, tokensSaved: 0,
            breakdown: { preprocessingReduction: 0, tokenFilterReduction: 0, structuralReduction: 0 },
        }),
        markFileRead: vi.fn(),
        incrementAutoContext: vi.fn(),
        logUsage: vi.fn(),
        getEngramsForFile: vi.fn().mockReturnValue([]),
        upsertEngram: vi.fn(),
    } as any;

    return {
        engine: mockEngine,
        monitor: new TokenMonitor(),
        sandbox: new AstSandbox(),
        circuitBreaker: new CircuitBreaker(),
    };
}

describe("v11.4.2 — set_plan EISDIR/missing guard", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1142-setplan-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("BLOCKS set_plan with directory path (was EISDIR crash in v11.4.1)", async () => {
        fs.mkdirSync(path.join(tmpDir, "plans"));

        const result = await handleGuard("set_plan", { action: "set_plan", text: "plans" }, deps);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).toMatch(/Markdown plan file/i);
        expect(text).not.toMatch(/EISDIR/i);
    });

    it("BLOCKS set_plan with missing file", async () => {
        const result = await handleGuard("set_plan", { action: "set_plan", text: "ghost-plan.md" }, deps);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path not found/i);
    });
});

describe("v11.4.2 — engram EISDIR/missing guard", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1142-engram-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("BLOCKS engram with directory path (was EISDIR crash in v11.4.1)", async () => {
        fs.mkdirSync(path.join(tmpDir, "src"));

        const result = await handleGuard(
            "engram",
            { action: "engram", path: "src", symbol: "foo", text: "ASSERT: test" },
            deps,
        );

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).toMatch(/source file path/i);
        expect(text).not.toMatch(/EISDIR/i);
    });
});

describe("v11.4.2 — outline directory hint (was silent 'no symbols found' in v11.4.1)", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1142-outline-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("BLOCKS outline with directory path and gives an actionable hint", async () => {
        fs.mkdirSync(path.join(tmpDir, "lib"));

        const result = await handleNavigate("outline", { action: "outline", path: "lib" }, deps);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).toMatch(/single file/i);
        expect(text).toMatch(/search|fast_grep|hybrid_search/i);
        // Must NOT regress to v11.4.1 silent-fail wording:
        expect(text).not.toMatch(/may be empty, unsupported, or contain no declarations/i);
    });
});

describe("v11.4.2 — read/compress still work (no regression on v11.4.0 fix)", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1142-readcomp-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("read with directory → structured directory error (regression guard)", async () => {
        fs.mkdirSync(path.join(tmpDir, "src"));
        const result = await handleCode("read", { action: "read", path: "src" }, deps);
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).not.toMatch(/EISDIR/i);
    });

    it("compress with directory → structured directory error (regression guard)", async () => {
        fs.mkdirSync(path.join(tmpDir, "src"));
        const result = await handleCode("compress", { action: "compress", path: "src" }, deps);
        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).not.toMatch(/EISDIR/i);
    });
});
