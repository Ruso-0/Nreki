import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NrekiDB } from "../src/database.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("symbol_io ledger (v10.20.0)", () => {
    let testDbPath: string;
    let testVecPath: string;
    let db: NrekiDB;

    beforeEach(async () => {
        testDbPath = path.join(
            os.tmpdir(),
            `nreki-symio-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
        );
        testVecPath = testDbPath.replace(/\.db$/, ".vec");
        db = new NrekiDB(testDbPath);
        await db.initialize();
    });

    afterEach(() => {
        try { db.close(); } catch { /* ignore */ }
        try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(testVecPath); } catch { /* ignore */ }
    });

    function insertFakeChunk(filePath: string, symbolName: string): number {
        return db.insertChunk(
            filePath,
            `[func] ${symbolName}()`,
            `function ${symbolName}(){}`,
            "func",
            1,
            1,
            new Float32Array(0),
            0,
            10,
            symbolName,
        );
    }

    it("(a) insertSymbolIosBulk + getChunksByConsumedType returns matching chunk", () => {
        const chunkId = insertFakeChunk("/fake/a.ts", "consumerFn");
        db.insertSymbolIosBulk([
            { chunkId, ioType: "consumes", typeName: "User" },
            { chunkId, ioType: "consumes", typeName: "Token" },
        ]);

        expect(db.getChunksByConsumedType("User")).toEqual([chunkId]);
        expect(db.getChunksByConsumedType("Token")).toEqual([chunkId]);
        expect(db.getChunksByConsumedType("Nonexistent")).toEqual([]);
    });

    it("(b) two chunks producing the same type → both ids returned", () => {
        const id1 = insertFakeChunk("/fake/b1.ts", "factoryOne");
        const id2 = insertFakeChunk("/fake/b2.ts", "factoryTwo");
        db.insertSymbolIosBulk([
            { chunkId: id1, ioType: "produces", typeName: "Widget" },
            { chunkId: id2, ioType: "produces", typeName: "Widget" },
        ]);

        const ids = db.getChunksByProducedType("Widget").sort((x, y) => x - y);
        expect(ids).toEqual([id1, id2].sort((x, y) => x - y));
    });

    it("(c) clearChunks(path) cascades into symbol_io", () => {
        const filePath = "/fake/c.ts";
        const chunkId = insertFakeChunk(filePath, "transient");
        db.insertSymbolIosBulk([
            { chunkId, ioType: "consumes", typeName: "Foo" },
            { chunkId, ioType: "produces", typeName: "Bar" },
        ]);

        expect(db.getChunksByConsumedType("Foo")).toEqual([chunkId]);
        expect(db.getChunksByProducedType("Bar")).toEqual([chunkId]);

        db.clearChunks(filePath);

        expect(db.getChunksByConsumedType("Foo")).toEqual([]);
        expect(db.getChunksByProducedType("Bar")).toEqual([]);
    });

    it("(d) duplicate (chunk_id, io_type, type_name) is OR IGNOREd, no throw", () => {
        const chunkId = insertFakeChunk("/fake/d.ts", "dupFn");
        expect(() => {
            db.insertSymbolIosBulk([
                { chunkId, ioType: "consumes", typeName: "Dup" },
                { chunkId, ioType: "consumes", typeName: "Dup" },
            ]);
        }).not.toThrow();

        expect(db.getChunksByConsumedType("Dup")).toEqual([chunkId]);
    });

    // ─── Phase 3 type_graph prerequisites (Sub-sprint C.1) ──────────

    describe("Sub-sprint C.1: Phase 3 prerequisites", () => {
        it("getSymbolIOByChunkId returns both consumes and produces", () => {
            const chunkId = insertFakeChunk("/fake/io1.ts", "transformer");
            db.insertSymbolIosBulk([
                { chunkId, ioType: "consumes", typeName: "Input" },
                { chunkId, ioType: "consumes", typeName: "Config" },
                { chunkId, ioType: "produces", typeName: "Output" },
            ]);

            const io = db.getSymbolIOByChunkId(chunkId);
            expect(io.consumes.sort()).toEqual(["Config", "Input"]);
            expect(io.produces).toEqual(["Output"]);
        });

        it("getSymbolIOByChunkId returns empty arrays for unknown chunk", () => {
            const io = db.getSymbolIOByChunkId(999999);
            expect(io.consumes).toEqual([]);
            expect(io.produces).toEqual([]);
        });

        it("getSymbolIOByChunkId returns empty arrays for chunk without io", () => {
            const chunkId = insertFakeChunk("/fake/io2.ts", "noIo");
            const io = db.getSymbolIOByChunkId(chunkId);
            expect(io.consumes).toEqual([]);
            expect(io.produces).toEqual([]);
        });

        it("getChunksByIds returns hydrated ChunkRecords in requested order", () => {
            const id1 = insertFakeChunk("/fake/batch1.ts", "alpha");
            const id2 = insertFakeChunk("/fake/batch2.ts", "beta");
            const id3 = insertFakeChunk("/fake/batch3.ts", "gamma");

            const chunks = db.getChunksByIds([id3, id1, id2]);
            expect(chunks).toHaveLength(3);
            expect(chunks[0].id).toBe(id3);
            expect(chunks[1].id).toBe(id1);
            expect(chunks[2].id).toBe(id2);
            // Validate via path (helper insertFakeChunk passes args in legacy
            // order so symbol_name is unreliable; path is positional arg #1).
            expect(chunks[0].path).toBe("/fake/batch3.ts");
        });

        it("getChunksByIds skips missing ids without throwing", () => {
            const realId = insertFakeChunk("/fake/batch-mix.ts", "real");
            const chunks = db.getChunksByIds([realId, 999999, 888888]);
            expect(chunks).toHaveLength(1);
            expect(chunks[0].id).toBe(realId);
        });

        it("getChunksByIds returns empty array for empty input", () => {
            expect(db.getChunksByIds([])).toEqual([]);
        });

        it("insertSymbolIosBulk filters single-letter UPPERCASE generics", () => {
            const chunkId = insertFakeChunk("/fake/generic.ts", "transform");
            db.insertSymbolIosBulk([
                { chunkId, ioType: "consumes", typeName: "T" },
                { chunkId, ioType: "consumes", typeName: "U" },
                { chunkId, ioType: "consumes", typeName: "K" },
                { chunkId, ioType: "consumes", typeName: "RealType" },
                { chunkId, ioType: "produces", typeName: "V" },
                { chunkId, ioType: "produces", typeName: "Result" },
            ]);

            const io = db.getSymbolIOByChunkId(chunkId);
            expect(io.consumes).toEqual(["RealType"]);
            expect(io.produces).toEqual(["Result"]);
        });

        it("insertSymbolIosBulk preserves multi-letter and lowercase identifiers", () => {
            const chunkId = insertFakeChunk("/fake/preserve.ts", "preserveFn");
            db.insertSymbolIosBulk([
                { chunkId, ioType: "consumes", typeName: "Th" },     // 2 chars uppercase
                { chunkId, ioType: "consumes", typeName: "x" },      // 1 char lowercase (predicate subject)
                { chunkId, ioType: "produces", typeName: "T1" },     // T+digit
            ]);

            const io = db.getSymbolIOByChunkId(chunkId);
            expect(io.consumes.sort()).toEqual(["Th", "x"]);
            expect(io.produces).toEqual(["T1"]);
        });

        it("insertSymbolIosBulk with all single-letter input is no-op", () => {
            const chunkId = insertFakeChunk("/fake/empty.ts", "allGenerics");
            expect(() => {
                db.insertSymbolIosBulk([
                    { chunkId, ioType: "consumes", typeName: "T" },
                    { chunkId, ioType: "produces", typeName: "U" },
                ]);
            }).not.toThrow();

            const io = db.getSymbolIOByChunkId(chunkId);
            expect(io.consumes).toEqual([]);
            expect(io.produces).toEqual([]);
        });
    });
});
