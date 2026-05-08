import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { NrekiDB, type FastGrepCacheRow } from "../src/database.js";
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

            let lastSeen = 0;
            for (let i = 0; i < cache.size; i++) {
                if (cache.paths[i] === "") continue;
                expect(cache.chunkIds[i]).toBeGreaterThan(lastSeen);
                lastSeen = cache.chunkIds[i];
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

    it("tombstoneByPath limpia solo los slots del path indicado", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function a2() {}", { filePath: "src/a.ts", symbolName: "a2" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            cache.tombstoneByPath("src/a.ts");

            expect(cache.size).toBe(3);
            expect(cache.rawCodes[0]).toBe("");
            expect(cache.paths[0]).toBe("");
            expect(cache.rawCodes[1]).toBe("");
            expect(cache.paths[1]).toBe("");
            expect(cache.rawCodes[2]).toBe("export function b1() {}");
            expect(cache.paths[2]).toBe("src/b.ts");
        });
    });

    it("tombstoneByPath es idempotente", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function a2() {}", { filePath: "src/a.ts", symbolName: "a2" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            cache.tombstoneByPath("src/a.ts");
            const afterFirst = {
                rawCodes: [...cache.rawCodes],
                paths: [...cache.paths],
                symbols: [...cache.symbols],
                startLines: [...cache.startLines],
                chunkIds: [...cache.chunkIds],
            };

            cache.tombstoneByPath("src/a.ts");

            expect(cache.rawCodes).toEqual(afterFirst.rawCodes);
            expect(cache.paths).toEqual(afterFirst.paths);
            expect(cache.symbols).toEqual(afterFirst.symbols);
            expect([...cache.startLines]).toEqual(afterFirst.startLines);
            expect([...cache.chunkIds]).toEqual(afterFirst.chunkIds);
        });
    });

    it("tombstoneByPath con path inexistente es no-op", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            const rawCodes = [...cache.rawCodes];

            cache.tombstoneByPath("/nonexistent/file.ts");

            expect(cache.rawCodes).toEqual(rawCodes);
        });
    });

    it("tombstoneByPath con string vacío es no-op (defensive)", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            const rawCodes = [...cache.rawCodes];

            cache.tombstoneByPath("");

            expect(cache.rawCodes).toEqual(rawCodes);
        });
    });

    it("appendChunks crece arrays correctamente", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            const row: FastGrepCacheRow = [99, "src/new.ts", "newSym", 42, "line1\nline2"];

            cache.appendChunks([row]);

            expect(cache.size).toBe(3);
            expect(cache.paths[2]).toBe("src/new.ts");
            expect(cache.symbols[2]).toBe("newSym");
            expect(cache.startLines[2]).toBe(42);
            expect(cache.chunkIds[2]).toBe(99);
            expect(cache.rawCodes[2]).toBe("line1\nline2");
            expect(cache.lineMaps[2].length).toBe(1);
        });
    });

    it("appendChunks de array vacio es no-op", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            const before = {
                size: cache.size,
                paths: [...cache.paths],
                symbols: [...cache.symbols],
                rawCodes: [...cache.rawCodes],
                lineMapLengths: cache.lineMaps.map((m) => m.length),
                startLines: [...cache.startLines],
                chunkIds: [...cache.chunkIds],
            };

            cache.appendChunks([]);

            expect(cache.size).toBe(before.size);
            expect(cache.paths).toEqual(before.paths);
            expect(cache.symbols).toEqual(before.symbols);
            expect(cache.rawCodes).toEqual(before.rawCodes);
            expect(cache.lineMaps.map((m) => m.length)).toEqual(before.lineMapLengths);
            expect([...cache.startLines]).toEqual(before.startLines);
            expect([...cache.chunkIds]).toEqual(before.chunkIds);
        });
    });

    it("tombstone + append simula re-index limpio", async () => {
        await withDb(async (db) => {
            insertChunk(db, "export function a1() {}", { filePath: "src/a.ts", symbolName: "a1" });
            insertChunk(db, "export function a2() {}", { filePath: "src/a.ts", symbolName: "a2" });
            insertChunk(db, "export function b1() {}", { filePath: "src/b.ts", symbolName: "b1" });

            const cache = new FastGrepRAMCache();
            cache.populateFromDatabase(db);
            cache.tombstoneByPath("src/a.ts");
            cache.appendChunks([[4, "src/a.ts", "a3", 1, "export function a3() {}"]]);

            expect(cache.size).toBe(4);
            expect(cache.paths[0]).toBe("");
            expect(cache.paths[1]).toBe("");
            expect(cache.paths[2]).toBe("src/b.ts");
            expect(cache.paths[3]).toBe("src/a.ts");
            expect(cache.chunkIds[3]).toBe(4);
        });
    });

    it("engine.indexFile actualiza fgCache incrementalmente", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-fg-incremental-"));
        const srcDir = path.join(dir, "src");
        fs.mkdirSync(srcDir);
        const filePath = path.join(srcDir, "x.ts");
        fs.writeFileSync(filePath, "export function foo() { return 1; }");

        const engine = new NrekiEngine({ dbPath: path.join(dir, "engine.db"), watchPaths: [srcDir] });
        try {
            await engine.indexFile(filePath);
            expect(engine.fgCache.size).toBeGreaterThan(0);
            expect(engine.fgCache.symbols).toContain("foo");

            fs.writeFileSync(filePath, "export function bar() { return 2; }");
            await engine.indexFile(filePath);

            const liveSymbols = engine.fgCache.symbols.filter((_, i) => engine.fgCache.paths[i] !== "");
            expect(liveSymbols).toContain("bar");
            expect(liveSymbols).not.toContain("foo");
            expect(engine.fgCache.paths.some((p) => p === "")).toBe(true);
        } finally {
            engine.shutdown();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
