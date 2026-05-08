import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { NrekiDB } from "../src/database.js";
import { NrekiEngine } from "../src/engine.js";
import { FastGrepRAMCache } from "../src/search/fastgrep-cache.js";

async function withDb<T>(fn: (db: NrekiDB, dir: string, dbPath: string) => Promise<T> | T): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-fg-cache-"));
    const dbPath = path.join(dir, "cache.db");
    const db = new NrekiDB(dbPath);
    await db.initialize();
    try {
        return await fn(db, dir, dbPath);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function insertChunk(
    db: NrekiDB,
    rawCode: string,
    opts: { filePath?: string; symbolName?: string; startLine?: number; shorthand?: string } = {},
): number {
    const filePath = opts.filePath ?? "/tmp/cache-test.ts";
    const shorthand = opts.shorthand ?? `[fn] ${opts.symbolName ?? "sample"}()`;
    return db.insertChunk(
        filePath,
        shorthand,
        rawCode,
        "function",
        opts.startLine ?? 1,
        opts.startLine ?? 1,
        new Float32Array(0),
        0,
        rawCode.length,
        opts.symbolName ?? "sample",
    );
}

describe("FastGrepRAMCache", () => {
    it("populates SoA arrays from database chunks", async () => {
        await withDb(async (db) => {
            const id = insertChunk(db, "export function alpha() {}", {
                filePath: "/tmp/alpha.ts",
                symbolName: "alpha",
                startLine: 7,
            });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect(cache.size).toBe(1);
            expect(cache.chunkIds[0]).toBe(id);
            expect(cache.startLines[0]).toBe(7);
            expect(cache.paths[0]).toBe("/tmp/alpha.ts");
            expect(cache.symbols[0]).toBe("alpha");
            expect(cache.rawCodes[0]).toBe("export function alpha() {}");
        });
    });

    it("builds newline offset line maps", async () => {
        await withDb(async (db) => {
            insertChunk(db, "a\nbc\ndef");

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect([...cache.lineMaps[0]]).toEqual([1, 4]);
        });
    });

    it("replaces previous cache contents on populate", async () => {
        await withDb(async (db) => {
            insertChunk(db, "function one() {}", { symbolName: "one" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            expect(cache.size).toBe(1);

            insertChunk(db, "function two() {}", { symbolName: "two" });
            cache.populateFromDatabase(db);

            expect(cache.size).toBe(2);
            expect(cache.symbols).toEqual(["one", "two"]);
        });
    });

    it("preserves empty symbols as empty strings", async () => {
        await withDb(async (db) => {
            insertChunk(db, "const anonymous = true;", { symbolName: "" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect(cache.symbols[0]).toBe("");
        });
    });

    it("engine initialize populates fgCache from existing DB", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-fg-engine-"));
        const dbPath = path.join(dir, "engine.db");
        const filePath = path.join(dir, "sample.ts");
        fs.writeFileSync(filePath, "export function bootCached() { return 1; }");

        const db = new NrekiDB(dbPath);
        await db.initialize();
        insertChunk(db, "export function bootCached() { return 1; }", {
            filePath,
            symbolName: "bootCached",
        });
        db.upsertFile(filePath, db.hashContent("export function bootCached() { return 1; }"));
        db.close();

        const engine = new NrekiEngine({ dbPath, watchPaths: [dir] });
        await engine.initialize();
        try {
            expect(engine.fgCache.size).toBe(1);
            expect(engine.fgCache.symbols[0]).toBe("bootCached");
            expect(engine.fgCache.rawCodes[0]).toContain("bootCached");
        } finally {
            engine.shutdown();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("DB vacia produce cache vacio", async () => {
        await withDb(async (db) => {
            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect(cache.size).toBe(0);
            expect(cache.rawCodes.length).toBe(0);
            expect(cache.lineMaps.length).toBe(0);
        });
    });

    it("chunk grande de 10KB construye lineMap correcto", async () => {
        await withDb(async (db) => {
            const rawCode = "line\n".repeat(2000);
            insertChunk(db, rawCode);

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect(cache.lineMaps[0].length).toBe(2000);
            expect(cache.rawCodes[0].length).toBe(10000);
        });
    });

    it("chunkIds son monotonicos crecientes", async () => {
        await withDb(async (db) => {
            for (let i = 0; i < 5; i++) {
                insertChunk(db, `function f${i}() { return ${i}; }`, {
                    filePath: `/tmp/f${i}.ts`,
                    symbolName: `f${i}`,
                });
            }

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            for (let i = 1; i < cache.chunkIds.length; i++) {
                expect(cache.chunkIds[i]).toBeGreaterThan(cache.chunkIds[i - 1]);
            }
        });
    });

    it("valida integridad perfecta contra SQLite sin lanzar error", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function validates() { return true; }", {
                symbolName: "validates",
            });
            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            expect(() => cache.validateAgainstDatabase(db)).not.toThrow();
        });
    });

    it("falla validacion si la RAM diverge del disco", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function diverges() { return false; }", {
                symbolName: "diverges",
            });
            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);

            const originalCode = cache.rawCodes[0];
            cache.rawCodes[0] = "MUTATED_BY_TEST";
            expect(() => cache.validateAgainstDatabase(db)).toThrow(/RawCode mismatch/);
            cache.rawCodes[0] = originalCode;
        });
    });
});
