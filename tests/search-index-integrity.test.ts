/**
 * Regression tests for the v12.1.0 search/index verification pass:
 *  - context_comment is persisted, so a restarted engine ranks like a fresh one
 *  - the BM25 index is lazy (startup does not tokenize every chunk)
 *  - a schema-upgrade wipe also clears symbol_io (ids are reused afterwards)
 *  - top_level gap chunks carry real character offsets
 *  - path boosts ignore the directories ABOVE the project root
 *  - fast_grep output is capped and summarizes the overflow per file
 *  (Voyage: tests/voyage-vector-index.test.ts)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB } from "../src/database.js";
import { handleFastGrep } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

const ALPHA = [
    "/**",
    " * alpha.ts - zebracorn ledger utilities.",
    " */",
    "import fs from 'fs';",
    "",
    "export function computeTotals(items: number[]): number {",
    "    return items.reduce((a, b) => a + b, 0);",
    "}",
    "",
    "registerPlugin('GAP_CALL_MARKER');",
    "",
    "// Formats a quokkaflux report line.",
    "export function formatLine(n: number): string {",
    "    return `total=${n}`;",
    "}",
].join("\n");

describe("index persistence: fresh vs restarted engine", () => {
    let tmp: string;
    let dbPath: string;

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-integrity-"));
        fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "src", "alpha.ts"), ALPHA, "utf-8");
        fs.writeFileSync(
            path.join(tmp, "src", "beta.ts"),
            "export function unrelated(): void {\n    console.log('nothing here');\n}\n",
            "utf-8",
        );
        dbPath = path.join(tmp, ".nreki.db");
    });

    afterAll(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const fingerprint = (rs: Array<{ path: string; startLine: number }>) =>
        rs.map(r => `${path.basename(r.path)}:${r.startLine}`);

    it("ranks identically after a restart, including chunks matched only through comments", async () => {
        const e1 = new NrekiEngine({ dbPath, watchPaths: [tmp] });
        await e1.initialize();
        await e1.indexDirectory(tmp);
        const fresh = {
            header: await e1.search("zebracorn", 10),
            preceding: await e1.search("quokkaflux", 10),
        };
        e1.shutdown();

        // computeTotals contains "zebracorn" only via the file header comment,
        // formatLine contains "quokkaflux" only via its preceding // comment.
        expect(fresh.header.some(r => r.shorthand.includes("computeTotals"))).toBe(true);
        expect(fresh.preceding.some(r => r.shorthand.includes("formatLine"))).toBe(true);

        const e2 = new NrekiEngine({ dbPath, watchPaths: [tmp] });
        await e2.initialize();
        const restarted = {
            header: await e2.search("zebracorn", 10),
            preceding: await e2.search("quokkaflux", 10),
        };
        e2.shutdown();

        expect(fingerprint(restarted.header)).toEqual(fingerprint(fresh.header));
        expect(fingerprint(restarted.preceding)).toEqual(fingerprint(fresh.preceding));
    });

    it("stores real character offsets for top_level gap chunks", async () => {
        const db = new NrekiDB(dbPath, tmp);
        await db.initialize();
        const content = fs.readFileSync(path.join(tmp, "src", "alpha.ts"), "utf-8");
        // [id, path, symbol, startLine, rawCode]: path-format agnostic.
        const ids = db.exportAllChunksForCache().filter(r => r[4].includes("GAP_CALL_MARKER")).map(r => r[0]);
        const gaps = db.getChunksByIds(ids).filter(c => c.node_type === "top_level");
        db.close();
        expect(gaps.length).toBe(1);
        expect(gaps[0].start_index).toBeGreaterThan(0);
        expect(content.slice(gaps[0].start_index, gaps[0].end_index)).toBe(gaps[0].raw_code);
    });
});

describe("NrekiDB: schema upgrade wipe and path boosts", () => {
    let tmp: string;

    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-db-integrity-"));
    });

    afterAll(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("clears symbol_io when an outdated schema forces a re-index", async () => {
        const dbPath = path.join(tmp, "upgrade.db");
        const db1 = new NrekiDB(dbPath);
        await db1.initialize();
        const id = db1.insertChunk("/p/src/a.ts", "function a()", "function a() {}", "function", 1, 1, 0, 15, "a");
        db1.insertSymbolIosBulk([{ chunkId: id, ioType: "consumes", typeName: "StaleType" }]);
        db1.setMetadata("parser_schema_version", "4");
        db1.save();
        db1.close();

        const db2 = new NrekiDB(dbPath);
        await db2.initialize();
        expect(db2.getAllTypeNames()).toEqual([]);
        expect(db2.getStats().total_chunks).toBe(0);
        db2.close();
    });

    it("computes path boosts relative to the project root", async () => {
        // A root that itself lives under a "scripts" folder used to put every
        // file in the 0.4 bucket, so src/ lost its boost.
        const root = path.join(tmp, "scripts", "proj");
        const db = new NrekiDB(path.join(tmp, "boost.db"), root);
        await db.initialize();
        const body = "export function handler() { return 'flamingo'; }";
        db.insertChunk(path.join(root, "src", "one.ts"), "function handler()", body, "function", 1, 1, 0, body.length, "handler");
        db.insertChunk(path.join(root, "tests", "two.ts"), "function handler()", body, "function", 1, 1, 0, body.length, "handler");
        const res = db.searchKeywordOnly("flamingo", 5);
        db.close();
        expect(res).toHaveLength(2);
        expect(path.basename(res[0].path)).toBe("one.ts");
        expect(res[0].rrf_score / res[1].rrf_score).toBeGreaterThan(2);
    });

    it("builds the BM25 index lazily from the stored rows", async () => {
        const dbPath = path.join(tmp, "lazy.db");
        const db1 = new NrekiDB(dbPath, tmp);
        await db1.initialize();
        db1.insertChunk(path.join(tmp, "src", "c.ts"), "function c()", "function c() {}", "function", 1, 1, 0, 15, "c", "pelican notes");
        db1.save();
        db1.close();

        const db2 = new NrekiDB(dbPath, tmp);
        await db2.initialize();
        // Deleting and inserting before the first search must not corrupt the deferred build.
        db2.clearChunks(path.join(tmp, "src", "c.ts"));
        db2.insertChunk(path.join(tmp, "src", "d.ts"), "function d()", "function d() {}", "function", 1, 1, 0, 15, "d", "pelican again");
        const res = db2.searchKeywordOnly("pelican", 5);
        db2.close();
        expect(res.map(r => path.basename(r.path))).toEqual(["d.ts"]);
    });
});

describe("fast_grep output cap", () => {
    function deps(hits: Array<{ path: string; raw_code: string; start_line: number; symbol_name: string }>): RouterDependencies {
        return {
            engine: {
                initialize: async () => {},
                getProjectRoot: () => path.resolve("/repo"),
                hasIndexedFiles: () => true,
                indexDirectory: async () => ({ indexed: 0, skipped: 0, errors: 0 }),
                fastGrep: async (q: string, limit: number) => hits.filter(h => h.raw_code.includes(q)).slice(0, limit),
            },
        } as unknown as RouterDependencies;
    }
    const manyLines = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");
    const hits = [
        { path: path.resolve("/repo/tests/a.test.ts"), raw_code: manyLines(100), start_line: 1, symbol_name: "t" },
        { path: path.resolve("/repo/src/b.ts"), raw_code: manyLines(100), start_line: 1, symbol_name: "b" },
        { path: path.resolve("/repo/src/c.ts"), raw_code: manyLines(100), start_line: 1, symbol_name: "c" },
    ];
    const hitLines = (text: string) => text.split("\n").filter(l => / :: /.test(l));

    it("prints at most 120 lines, production code first, and summarizes the rest per file", async () => {
        const text = (await handleFastGrep({ action: "fast_grep", query: "const " }, deps(hits))).content[0].text ?? "";
        const shown = hitLines(text);
        expect(text).toContain("Found 300 match(es)");
        expect(shown).toHaveLength(120);
        expect(shown[0].startsWith("src/b.ts")).toBe(true);
        expect(shown.some(l => l.startsWith("tests/"))).toBe(false);
        expect(text).toContain("180 more match(es) in: src/c.ts (80), tests/a.test.ts (100)");
    });

    it("an explicit limit raises the line cap", async () => {
        const text = (await handleFastGrep({ action: "fast_grep", query: "const ", limit: 500 }, deps(hits))).content[0].text ?? "";
        expect(hitLines(text)).toHaveLength(300);
        expect(text).not.toContain("Output capped");
    });
});
