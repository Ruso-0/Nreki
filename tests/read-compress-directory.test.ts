/**
 * read-compress-directory.test.ts — v11.4.0 EISDIR fix.
 *
 * User feedback (2026-05-19):
 *   "compress on a directory crashes with EISDIR".
 *
 * Pre-fix: `fs.statSync` succeeded for a directory (stat.size = 0 or arbitrary),
 * shouldProcess returned true, then `readSource` → `fs.readFileSync(dir)`
 * threw EISDIR and the MCP server surfaced an opaque crash.
 *
 * Fix: explicit `stat.isDirectory()` guard in both handleRead and handleCompress,
 * returning a clean error message that points to the correct tool
 * (`nreki_navigate action:"outline" / "fast_grep" / "search"`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCode, type RouterDependencies } from "../src/router.js";
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
        compressFile: vi.fn().mockResolvedValue({
            compressed: "", chunksFound: 0, originalSize: 0, compressedSize: 0, ratio: 1, tokensSaved: 0,
        }),
        compressFileAdvanced: vi.fn().mockResolvedValue({
            compressed: "", originalSize: 0, compressedSize: 0, ratio: 1, tokensSaved: 0,
            breakdown: { preprocessingReduction: 0, tokenFilterReduction: 0, structuralReduction: 0 },
        }),
        markFileRead: vi.fn(),
        incrementAutoContext: vi.fn(),
        logUsage: vi.fn(),
    } as any;

    return {
        engine: mockEngine,
        monitor: new TokenMonitor(),
        sandbox: new AstSandbox(),
        circuitBreaker: new CircuitBreaker(),
    };
}

describe("nreki_code action:\"read\" — directory and missing-file guards", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-eisdir-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("returns clean error (not EISDIR crash) when path is a directory", async () => {
        const subDir = path.join(tmpDir, "src");
        fs.mkdirSync(subDir);

        const result = await handleCode("read", { action: "read", path: "src" }, deps);

        expect(result.isError).toBe(true);
        expect(result.content[0].type).toBe("text");
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).toMatch(/nreki_navigate/);
        expect(text).not.toMatch(/EISDIR/i);
    });

    it("returns clean error when path does not exist", async () => {
        const result = await handleCode("read", { action: "read", path: "does/not/exist.ts" }, deps);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path not found/i);
        expect(text).toMatch(/nreki_navigate/);
    });
});

describe("nreki_code action:\"compress\" — directory and missing-file guards", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-eisdir-c-"));
        deps = createMinimalDeps(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("returns clean error (not EISDIR crash) when compress path is a directory", async () => {
        const subDir = path.join(tmpDir, "lib");
        fs.mkdirSync(subDir);

        const result = await handleCode("compress", { action: "compress", path: "lib" }, deps);

        expect(result.isError).toBe(true);
        expect(result.content[0].type).toBe("text");
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path is a directory/i);
        expect(text).toMatch(/nreki_navigate/);
        expect(text).not.toMatch(/EISDIR/i);
    });

    it("returns clean error when compress path does not exist", async () => {
        const result = await handleCode("compress", { action: "compress", path: "ghost.ts" }, deps);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Path not found/i);
    });
});
