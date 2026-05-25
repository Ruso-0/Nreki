/**
 * search-no-results-hint.test.ts — v11.4.2 UX regression guard
 * (v12.0.0 amputation update: hybrid_search removed; hints now point to
 *  fast_grep and host-agent grep only).
 *
 * v11.4.1 user feedback: when semantic search returns empty, the user
 * resorted to native grep because the response gave no hint about
 * available fallbacks. The "Index pending" branch already suggested
 * fallbacks — the "No results" branch was asymmetric.
 *
 * v11.4.2 added fallback hints to the "No semantic results found" branch.
 * v12.0.0 amputated hybrid_search; the hint set is now {fast_grep,
 * broaden query, host grep}.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleNavigate, type RouterDependencies } from "../src/router.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import fs from "fs";
import path from "path";
import os from "os";

function depsWithEmptySearch(tmpDir: string, hasIndexed: boolean): RouterDependencies {
    const engine = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getProjectRoot: vi.fn().mockReturnValue(tmpDir),
        hasIndexedFiles: vi.fn().mockReturnValue(hasIndexed),
        ensureIndexedBackground: vi.fn().mockReturnValue(false),
        search: vi.fn().mockResolvedValue([]),
        getStats: vi.fn().mockReturnValue({
            filesIndexed: 42, totalChunks: 1234, compressionRatio: 0.6, watchedPaths: [tmpDir],
        }),
        getParser: vi.fn().mockReturnValue({
            initialize: vi.fn().mockResolvedValue(undefined),
            isSupported: vi.fn().mockReturnValue(true),
        }),
        logUsage: vi.fn(),
    } as any;

    return {
        engine,
        monitor: new TokenMonitor(),
        sandbox: new AstSandbox(),
        circuitBreaker: new CircuitBreaker(),
    };
}

describe("v11.4.2 — search 'No results' fallback hint", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v1142-search-"));
    });

    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

    it("emits fallback hints (fast_grep, broaden query, host grep) on empty results", async () => {
        const deps = depsWithEmptySearch(tmpDir, /* hasIndexed */ true);

        const result = await handleNavigate("search", {
            action: "search",
            query: "nonexistent-symbol-xyz",
        }, deps);

        const text = (result.content[0] as { text: string }).text;

        // Header retained
        expect(text).toMatch(/No semantic results found/i);

        // Three remaining fallback paths
        expect(text).toMatch(/fast_grep/);
        expect(text).toMatch(/Broaden the query|broader query/i);
        expect(text).toMatch(/grep/);

        // Anti-regression: hybrid_search must NOT reappear (v12.0.0 amputation).
        expect(text).not.toMatch(/hybrid_search/);
    });

    it("does NOT regress 'Index pending' branch when index is warming", async () => {
        const deps = depsWithEmptySearch(tmpDir, /* hasIndexed */ false);
        (deps.engine.ensureIndexedBackground as ReturnType<typeof vi.fn>).mockReturnValue(true);

        const result = await handleNavigate("search", {
            action: "search",
            query: "anything",
        }, deps);

        const text = (result.content[0] as { text: string }).text;
        expect(text).toMatch(/Index pending/i);
        expect(text).toMatch(/fast_grep/);
        // v12.0.0 anti-regression: hybrid_search must NOT appear here either.
        expect(text).not.toMatch(/hybrid_search/);
    });
});
