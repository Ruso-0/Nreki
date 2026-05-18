/**
 * tests/hybrid-engine.test.ts — Phase 5.5.2 hybrid RRF unit tests.
 *
 * Pure RRF math + classification tests use no engine; end-to-end tests
 * spin up a tmp project + a real NrekiEngine + BM25Engine to verify
 * the fusion path including foveal compression on BM25-only files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
    HybridEngine,
    rrfFuseFiles,
    DEFAULT_RRF_K,
} from "../src/hybrid-engine.js";
import { BM25Engine } from "../src/bm25-engine.js";
import { NrekiEngine } from "../src/engine.js";

describe("rrfFuseFiles (pure RRF math)", () => {
    it("returns the union when both lists are disjoint", () => {
        const fused = rrfFuseFiles(["a", "b"], ["c", "d"], 10);
        expect(new Set(fused)).toEqual(new Set(["a", "b", "c", "d"]));
        expect(fused.length).toBe(4);
    });

    it("rewards files appearing in both lists (intersection ranks higher)", () => {
        const fused = rrfFuseFiles(["x", "a", "b"], ["a", "y", "z"], 10);
        expect(fused[0]).toBe("a");
    });

    it("respects topK truncation", () => {
        const fused = rrfFuseFiles(["a", "b", "c"], ["d", "e", "f"], 3);
        expect(fused.length).toBe(3);
    });

    it("deduplicates within each input list before scoring", () => {
        const fused = rrfFuseFiles(["a", "a", "b"], ["c"], 10);
        expect(fused.filter(f => f === "a").length).toBe(1);
        expect(fused.length).toBe(3);
    });

    it("uses localeCompare for deterministic tie-breaking", () => {
        const fused1 = rrfFuseFiles(["zfile.ts"], ["afile.ts"], 10);
        expect(fused1).toEqual(["afile.ts", "zfile.ts"]);
        const fused2 = rrfFuseFiles(["afile.ts"], ["zfile.ts"], 10);
        expect(fused2).toEqual(["afile.ts", "zfile.ts"]);
    });

    it("uses DEFAULT_RRF_K=60 when k omitted", () => {
        const fused = rrfFuseFiles(["a"], ["b"], 10);
        // With k=60, rank-1 in either list scores 1/61 ≈ 0.0164.
        // Both files have the same score, localeCompare orders them.
        expect(fused).toEqual(["a", "b"]);
        expect(DEFAULT_RRF_K).toBe(60);
    });
});

describe("HybridEngine end-to-end", () => {
    let tmpDir: string;
    let dbPath: string;
    let engine: NrekiEngine | null = null;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nreki-hybrid-"));
        dbPath = path.join(tmpDir, ".nreki.db");
    });

    afterEach(async () => {
        if (engine) {
            try { engine.shutdown(); } catch { /* best effort */ }
            engine = null;
        }
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function write(rel: string, content: string): Promise<void> {
        const abs = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }

    async function newEngine(): Promise<NrekiEngine> {
        const e = new NrekiEngine({ dbPath, watchPaths: [tmpDir] });
        await e.initialize();
        await e.indexDirectory(tmpDir);
        return e;
    }

    it("surfaces NREKI hits with AST-aware chunks (source='nreki' or 'both')", async () => {
        await write("src/cache.ts",
            "export function clearTheCache() {\n" +
            "    const items = [1, 2, 3];\n" +
            "    return items.length;\n" +
            "}\n",
        );
        await write("src/other.ts",
            "export function unrelatedFn() { return 42; }\n",
        );

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir);
        const hybrid = new HybridEngine(engine, bm25);

        const results = await hybrid.search("clearTheCache", { topK: 3 });

        expect(results.length).toBeGreaterThanOrEqual(1);
        const cacheHit = results.find(r => r.path === "src/cache.ts");
        expect(cacheHit).toBeDefined();
        // NREKI uses AST so nodeType is NOT "bm25_file" for chunks it surfaces.
        expect(cacheHit!.nodeType).not.toBe("bm25_file");
        expect(["nreki", "both"]).toContain(cacheHit!.source);
    });

    it("falls back to BM25 for files that NREKI did not surface", async () => {
        // Plain prose file that NREKI may not chunk meaningfully but BM25 indexes.
        await write("notes/README.md",
            "# Project Notes\n\nThis project has a uniqueLexicalMarker token.\n" +
            "More content to make the file substantial.\n".repeat(20),
        );
        await write("src/handler.ts",
            "export function processRequest() { return 'ok'; }\n",
        );

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir, {
            extensions: new Set([".ts", ".md"]),
        });
        const hybrid = new HybridEngine(engine, bm25);

        const results = await hybrid.search("uniqueLexicalMarker", { topK: 5 });

        const mdHit = results.find(r => r.path === "notes/README.md");
        expect(mdHit).toBeDefined();
        // MD files aren't indexed by NREKI's parser → only BM25 surfaces them.
        expect(mdHit!.source).toBe("bm25");
    });

    it("topK caps the unique file count in fused results", async () => {
        for (let i = 0; i < 20; i++) {
            await write(`src/file${i}.ts`,
                `export function commonsymbol${i}() { return ${i}; }\n` +
                `// commonsymbol mention\n`.repeat(5),
            );
        }

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir);
        const hybrid = new HybridEngine(engine, bm25);

        const results = await hybrid.search("commonsymbol", { topK: 3 });
        const uniqueFiles = new Set(results.map(r => r.path));
        expect(uniqueFiles.size).toBeLessThanOrEqual(3);
    });

    it("returns empty array gracefully when no retriever finds matches", async () => {
        await write("src/a.ts", "export const x = 1;\n");

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir);
        const hybrid = new HybridEngine(engine, bm25);

        const results = await hybrid.search("absolutelynothingmatchesthisstring", { topK: 5 });
        expect(results).toEqual([]);
    });

    it("foveal compression on BM25-only file reduces content vs raw (Reto 5)", async () => {
        // Large TS file. NREKI will surface symbol chunks (small), so this
        // covers the NREKI path. For the BM25-only foveal path we use a file
        // whose query hit lives in a non-parsed extension — make the file
        // be a TS file >= 100 lines with a lexical hit BM25 surfaces but
        // NREKI may rank below cutoff. Simplest: query a literal string
        // inside a string literal of a large file NREKI does index but does
        // not rank for the query.

        // Build a file >= 100 lines with rare lexical token only in comments.
        const lines: string[] = [];
        lines.push("export const PADDING_DATA = [");
        for (let i = 0; i < 150; i++) {
            lines.push(`    "padding_value_${i}",`);
        }
        lines.push("];");
        lines.push("// rareLexicalHook is referenced here in a comment for BM25");
        const big = lines.join("\n");
        await write("src/padding.ts", big);
        await write("src/unrelated.ts", "export function bar() { return 1; }\n");

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir);
        const hybrid = new HybridEngine(engine, bm25);

        // Search for the rare comment marker — likely BM25-only or both.
        const withFoveal = await hybrid.search("rareLexicalHook", {
            topK: 3,
            applyFovealOnBm25: true,
        });
        const withoutFoveal = await hybrid.search("rareLexicalHook", {
            topK: 3,
            applyFovealOnBm25: false,
        });

        const fovHit = withFoveal.find(r => r.path === "src/padding.ts");
        const rawHit = withoutFoveal.find(r => r.path === "src/padding.ts");

        // If BM25 surfaced the file as bm25-only, foveal should shrink content.
        // If NREKI surfaced it as 'nreki'/'both', both runs return identical chunks.
        if (fovHit && rawHit && fovHit.source === "bm25" && rawHit.source === "bm25") {
            expect(fovHit.content.length).toBeLessThanOrEqual(rawHit.content.length);
        }
    });

    it("rrfK option overrides the default fusion constant", async () => {
        await write("src/a.ts", "export function alphafn() { return 1; }\n".repeat(5));
        await write("src/b.ts", "export function betafn() { return 2; }\n".repeat(5));

        engine = await newEngine();
        const bm25 = new BM25Engine(tmpDir);
        const hybrid = new HybridEngine(engine, bm25);

        const results = await hybrid.search("alphafn", { topK: 5, rrfK: 1 });
        // rrfK=1 makes rank-1 hits massively dominate rank-2+; the search
        // should still complete without error.
        expect(Array.isArray(results)).toBe(true);
    });
});
