/**
 * tests/bm25-engine.test.ts — Phase 5.5.2 BM25 engine unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
    BM25Engine,
    tokenizeForBM25,
    splitIdentifier,
    scoreBM25,
    BM25_K1,
    BM25_B,
    type BM25Index,
    type BM25DocStats,
} from "../src/bm25-engine.js";

describe("BM25 tokenization", () => {
    it("splits PascalCase identifiers into subtokens + lowercase original", () => {
        const parts = new Set(splitIdentifier("SuggestModel"));
        expect(parts.has("suggestmodel")).toBe(true);
        expect(parts.has("suggest")).toBe(true);
        expect(parts.has("model")).toBe(true);
    });

    it("splits snake_case identifiers into subtokens", () => {
        const parts = new Set(splitIdentifier("parse_modified_nodes"));
        expect(parts.has("parse_modified_nodes")).toBe(true);
        expect(parts.has("parse")).toBe(true);
        expect(parts.has("modified")).toBe(true);
        expect(parts.has("nodes")).toBe(true);
    });

    it("handles acronym-adjacent boundaries (HTTPServer -> HTTP, Server)", () => {
        const parts = new Set(splitIdentifier("HTTPServer"));
        expect(parts.has("http")).toBe(true);
        expect(parts.has("server")).toBe(true);
    });

    it("returns empty for tokens shorter than 2 chars", () => {
        expect(splitIdentifier("a")).toEqual([]);
        expect(splitIdentifier("")).toEqual([]);
    });

    it("tokenizeForBM25 strips non-alphanumeric separators (slashes, dots)", () => {
        const toks = tokenizeForBM25("src/foo.bar-baz.ts");
        expect(toks).toContain("src");
        expect(toks).toContain("foo");
        expect(toks).toContain("bar");
        expect(toks).toContain("baz");
    });
});

describe("scoreBM25 (Okapi BM25 math)", () => {
    function makeIndex(docs: Array<{ path: string; tokens: string[] }>): BM25Index {
        const stats: BM25DocStats[] = [];
        const docFreq = new Map<string, number>();
        let total = 0;
        for (const d of docs) {
            const tf = new Map<string, number>();
            for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
            stats.push({ path: d.path, term_freq: tf, length: d.tokens.length });
            total += d.tokens.length;
            for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        }
        return {
            docs: stats,
            avg_doc_length: stats.length > 0 ? total / stats.length : 0,
            doc_freq: docFreq,
            total_docs: stats.length,
        };
    }

    it("returns 0 for empty index", () => {
        const empty: BM25Index = { docs: [], avg_doc_length: 0, doc_freq: new Map(), total_docs: 0 };
        expect(scoreBM25(
            { path: "x", term_freq: new Map([["foo", 1]]), length: 1 },
            ["foo"], empty,
        )).toBe(0);
    });

    it("rare term scores higher than common term (IDF dominates)", () => {
        const idx = makeIndex([
            { path: "a.ts", tokens: ["common", "common", "rare"] },
            { path: "b.ts", tokens: ["common", "common"] },
            { path: "c.ts", tokens: ["common"] },
        ]);
        const docA = idx.docs[0];
        const rareScore = scoreBM25(docA, ["rare"], idx);
        const commonScore = scoreBM25(docA, ["common"], idx);
        expect(rareScore).toBeGreaterThan(commonScore);
    });

    it("term-frequency saturates (k1 prevents runaway terms)", () => {
        const idx = makeIndex([
            { path: "a.ts", tokens: ["foo"] },
            { path: "b.ts", tokens: ["bar"] },
        ]);
        const doc1 = { path: "x", term_freq: new Map([["foo", 1]]), length: 1 };
        const doc100 = { path: "y", term_freq: new Map([["foo", 100]]), length: 100 };
        const s1 = scoreBM25(doc1, ["foo"], idx);
        const s100 = scoreBM25(doc100, ["foo"], idx, BM25_K1, BM25_B);
        expect(s100).toBeLessThan(s1 * 10);
    });
});

describe("BM25Engine end-to-end", () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nreki-bm25-"));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    async function write(rel: string, content: string): Promise<void> {
        const abs = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }

    it("ranks the file containing the exact identifier match first", async () => {
        await write("src/cache.ts", "export function clearCache() { return 1; }");
        await write("src/helper.ts", "export function unrelated() { return 2; }");
        await write("src/types.ts", "export type Foo = string;");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("clearCache", 3);

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].path).toBe("src/cache.ts");
    });

    it("returns ranked file-level scores (highest first)", async () => {
        await write("src/a.ts", "alpha beta alpha gamma alpha");
        await write("src/b.ts", "beta gamma");
        await write("src/c.ts", "delta epsilon");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("alpha", 3);

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].path).toBe("src/a.ts");
        for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }
    });

    it("uses workspace-relative forward-slash paths", async () => {
        await write("nested/dir/file.ts", "export const matchme = 1;");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("matchme", 1);

        expect(results[0].path).toBe("nested/dir/file.ts");
    });

    it("skips excluded directories (node_modules)", async () => {
        await write("src/real.ts", "export const realfile = 1;");
        await write("node_modules/pkg/junk.ts", "export const realfile = 2;");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("realfile", 5);

        expect(results.length).toBe(1);
        expect(results[0].path).toBe("src/real.ts");
    });

    it("returns empty for queries with no indexable tokens", async () => {
        await write("src/a.ts", "export const x = 1;");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("", 10);
        expect(results).toEqual([]);
    });

    it("caches the index across searches and invalidate() drops it", async () => {
        await write("src/a.ts", "alpha beta");

        const engine = new BM25Engine(tmpDir);
        expect(engine.hasIndex()).toBe(false);
        await engine.search("alpha", 1);
        expect(engine.hasIndex()).toBe(true);
        expect(engine.indexedFileCount()).toBe(1);

        engine.invalidate();
        expect(engine.hasIndex()).toBe(false);

        await write("src/b.ts", "alpha beta");
        await engine.search("alpha", 5);
        expect(engine.indexedFileCount()).toBe(2);
    });

    it("PascalCase query identifier matches snake_case body via subtoken overlap", async () => {
        await write("src/handler.ts", "function parse_user_input() {}");
        await write("src/other.ts", "function unrelated() {}");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("parseUserInput", 3);

        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].path).toBe("src/handler.ts");
    });

    it("deterministic tie-break by localeCompare on equal scores", async () => {
        await write("src/zfile.ts", "uniqueterm");
        await write("src/afile.ts", "uniqueterm");

        const engine = new BM25Engine(tmpDir);
        const results = await engine.search("uniqueterm", 5);

        expect(results.length).toBe(2);
        expect(results[0].path).toBe("src/afile.ts");
        expect(results[1].path).toBe("src/zfile.ts");
    });
});
