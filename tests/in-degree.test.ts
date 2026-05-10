import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { NrekiDB } from "../src/database.js";
import { computeInDegrees, rankByInDegree } from "../src/search/in-degree.js";

describe("Sub-sprint C.2: in-degree calculator (Phase 3 anti-hub)", () => {
    let db: NrekiDB;
    let testDbPath: string;

    beforeEach(async () => {
        testDbPath = path.join(
            os.tmpdir(),
            `nreki-indeg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
        );
        db = new NrekiDB(testDbPath);
        await db.initialize();
    });

    afterEach(() => {
        try { db.close(); } catch { /* ignore */ }
        try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    });

    function mkChunk(filePath: string, symbolName: string): number {
        return db.insertChunk(
            filePath,
            `[func] ${symbolName}()`,
            `function ${symbolName}(){}`,
            "func",
            1, 1, 0, 10, symbolName,
        );
    }

    it("empty subset returns empty map", () => {
        expect(computeInDegrees(db, [])).toEqual(new Map());
    });

    it("chunk without produces gets inDegree 0", () => {
        const id = mkChunk("/a.ts", "noProd");
        db.insertSymbolIosBulk([
            { chunkId: id, ioType: "consumes", typeName: "Foo" },
        ]);
        const scores = computeInDegrees(db, [id]);
        expect(scores.get(id)).toBe(0);
    });

    it("chunk producing type consumed by 1 other → inDegree 1", () => {
        const producer = mkChunk("/p.ts", "producer");
        const consumer = mkChunk("/c.ts", "consumer");
        db.insertSymbolIosBulk([
            { chunkId: producer, ioType: "produces", typeName: "Widget" },
            { chunkId: consumer, ioType: "consumes", typeName: "Widget" },
        ]);
        const scores = computeInDegrees(db, [producer]);
        expect(scores.get(producer)).toBe(1);
    });

    it("chunk producing type consumed by 3 distinct chunks → inDegree 3", () => {
        const producer = mkChunk("/p.ts", "factory");
        const c1 = mkChunk("/c1.ts", "c1");
        const c2 = mkChunk("/c2.ts", "c2");
        const c3 = mkChunk("/c3.ts", "c3");
        db.insertSymbolIosBulk([
            { chunkId: producer, ioType: "produces", typeName: "Token" },
            { chunkId: c1, ioType: "consumes", typeName: "Token" },
            { chunkId: c2, ioType: "consumes", typeName: "Token" },
            { chunkId: c3, ioType: "consumes", typeName: "Token" },
        ]);
        expect(computeInDegrees(db, [producer]).get(producer)).toBe(3);
    });

    it("self-references excluded from inDegree", () => {
        const id = mkChunk("/self.ts", "selfRef");
        db.insertSymbolIosBulk([
            { chunkId: id, ioType: "produces", typeName: "Self" },
            { chunkId: id, ioType: "consumes", typeName: "Self" },
        ]);
        expect(computeInDegrees(db, [id]).get(id)).toBe(0);
    });

    it("multiple produced types overlap-counted once per consumer", () => {
        const producer = mkChunk("/p.ts", "multiOut");
        const consumer = mkChunk("/c.ts", "consumer");
        db.insertSymbolIosBulk([
            { chunkId: producer, ioType: "produces", typeName: "TypeA" },
            { chunkId: producer, ioType: "produces", typeName: "TypeB" },
            { chunkId: consumer, ioType: "consumes", typeName: "TypeA" },
            { chunkId: consumer, ioType: "consumes", typeName: "TypeB" },
        ]);
        // Consumer references via TWO types but counts as 1.
        expect(computeInDegrees(db, [producer]).get(producer)).toBe(1);
    });

    it("global scope: counts consumers OUTSIDE the subset", () => {
        const producer = mkChunk("/p.ts", "globalProd");
        const externalConsumer = mkChunk("/ext.ts", "external");
        db.insertSymbolIosBulk([
            { chunkId: producer, ioType: "produces", typeName: "Shared" },
            { chunkId: externalConsumer, ioType: "consumes", typeName: "Shared" },
        ]);
        // Subset is just [producer]. External consumer is not in subset
        // but still counted because scoring is GLOBAL.
        expect(computeInDegrees(db, [producer]).get(producer)).toBe(1);
    });

    it("rankByInDegree sorts DESC with stable id-asc tiebreaker", () => {
        const lo = mkChunk("/lo.ts", "low");
        const hi = mkChunk("/hi.ts", "hi");
        const mid1 = mkChunk("/m1.ts", "mid1");
        const mid2 = mkChunk("/m2.ts", "mid2");
        // hi: 2 consumers; mid1+mid2: 1 consumer each (tie); lo: 0 consumers
        const cA = mkChunk("/cA.ts", "cA");
        const cB = mkChunk("/cB.ts", "cB");
        const cC = mkChunk("/cC.ts", "cC");
        const cD = mkChunk("/cD.ts", "cD");
        db.insertSymbolIosBulk([
            { chunkId: hi, ioType: "produces", typeName: "Hi" },
            { chunkId: mid1, ioType: "produces", typeName: "M1" },
            { chunkId: mid2, ioType: "produces", typeName: "M2" },
            { chunkId: cA, ioType: "consumes", typeName: "Hi" },
            { chunkId: cB, ioType: "consumes", typeName: "Hi" },
            { chunkId: cC, ioType: "consumes", typeName: "M1" },
            { chunkId: cD, ioType: "consumes", typeName: "M2" },
        ]);

        const ranked = rankByInDegree(db, [lo, mid2, hi, mid1]);
        expect(ranked[0]).toBe(hi);
        // Tie between mid1 and mid2 → ascending chunk_id wins
        expect(ranked[1]).toBe(mid1);
        expect(ranked[2]).toBe(mid2);
        expect(ranked[3]).toBe(lo);
    });

    it("rankByInDegree empty input returns empty array", () => {
        expect(rankByInDegree(db, [])).toEqual([]);
    });

    it("subset with mixed missing/zero/positive scores", () => {
        const a = mkChunk("/a.ts", "a"); // 0 consumers
        const b = mkChunk("/b.ts", "b"); // 2 consumers
        const cb1 = mkChunk("/cb1.ts", "cb1");
        const cb2 = mkChunk("/cb2.ts", "cb2");
        db.insertSymbolIosBulk([
            // Type name "Beta" (multi-char) — single letter "B" would be
            // filtered by C.1 defense-in-depth in insertSymbolIosBulk.
            { chunkId: b, ioType: "produces", typeName: "Beta" },
            { chunkId: cb1, ioType: "consumes", typeName: "Beta" },
            { chunkId: cb2, ioType: "consumes", typeName: "Beta" },
        ]);
        const scores = computeInDegrees(db, [a, b]);
        expect(scores.get(a)).toBe(0);
        expect(scores.get(b)).toBe(2);
    });
});
