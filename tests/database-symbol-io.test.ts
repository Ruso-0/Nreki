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
});
