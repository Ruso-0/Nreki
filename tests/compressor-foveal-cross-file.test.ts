/**
 * Phase 4 Markov Blanket Foveal — extractTypeLedgerParafovea + render tests.
 *
 * Uses real NrekiDB (sql.js in-memory) — same pattern as
 * tests/database-symbol-io.test.ts. Validates Furia round 12 spec:
 *   - K=1 strict cross-file extraction
 *   - Anti-hub ranking via rankByInDegree
 *   - max_cross_file hard cap (UNIQUE chunks)
 *   - Same-file filter
 *   - Defensive ignore on DB lookup fail (FAIL-OPEN)
 *   - cleanSignature render pure
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NrekiDB } from "../src/database.js";
import {
    extractTypeLedgerParafovea,
    countTotalCrossFileBeforeTruncation,
    renderCrossFileUpstream,
    renderCrossFileDownstream,
    renderTruncationAdvisory,
    computeCrossFileBytes,
    type CrossFileChunk,
} from "../src/compressor-foveal-cross-file.js";

// Minimal engine adapter satisfying the structural surface used by
// extractTypeLedgerParafovea + rankByInDegree.
function mkEngineAdapter(db: NrekiDB) {
    return {
        getChunkIdByPathAndSymbol: (p: string, s: string) =>
            db.getChunkIdByPathAndSymbol(p, s),
        getSymbolIOByChunkId: (id: number) =>
            db.getSymbolIOByChunkId(id),
        getChunksByConsumedType: (t: string) =>
            db.getChunksByConsumedType(t),
        getChunksByProducedType: (t: string) =>
            db.getChunksByProducedType(t),
        getChunksByIds: (ids: number[]) =>
            db.getChunksByIds(ids),
    } as any;
}

describe("Phase 4: extractTypeLedgerParafovea", () => {
    let db: NrekiDB;
    let testDbPath: string;

    beforeEach(async () => {
        testDbPath = path.join(
            os.tmpdir(),
            `nreki-p4xfile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
            filePath, `[func] ${symbolName}()`, `function ${symbolName}(){}`,
            "func", 1, 1, 0, 10, symbolName,
        );
    }

    it("extracts upstream chunks consuming fovea-produced types", () => {
        const fovea = mkChunk("/proj/fovea.ts", "produceUser");
        const consumer = mkChunk("/proj/consumer.ts", "useUser");
        db.insertSymbolIosBulk([
            { chunkId: fovea, ioType: "produces", typeName: "UserType" },
            { chunkId: consumer, ioType: "consumes", typeName: "UserType" },
        ]);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "produceUser" }],
            mkEngineAdapter(db),
            10,
        );

        expect(result).toHaveLength(1);
        expect(result[0].relation).toBe("upstream");
        expect(result[0].symbolName).toBe("useUser");
        expect(result[0].seedType).toBe("UserType");
        expect(result[0].path).toBe("/proj/consumer.ts");
    });

    it("extracts downstream chunks producing fovea-consumed types", () => {
        const fovea = mkChunk("/proj/fovea.ts", "needsConfig");
        const producer = mkChunk("/proj/producer.ts", "makeConfig");
        db.insertSymbolIosBulk([
            { chunkId: fovea, ioType: "consumes", typeName: "ConfigType" },
            { chunkId: producer, ioType: "produces", typeName: "ConfigType" },
        ]);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "needsConfig" }],
            mkEngineAdapter(db),
            10,
        );

        expect(result).toHaveLength(1);
        expect(result[0].relation).toBe("downstream");
        expect(result[0].symbolName).toBe("makeConfig");
    });

    it("filters same-file chunks (single-file ya cubierto regex)", () => {
        const fovea = mkChunk("/proj/same.ts", "fovea");
        const sameFile = mkChunk("/proj/same.ts", "neighbor");
        const crossFile = mkChunk("/proj/other.ts", "external");
        db.insertSymbolIosBulk([
            { chunkId: fovea, ioType: "produces", typeName: "Shared" },
            { chunkId: sameFile, ioType: "consumes", typeName: "Shared" },
            { chunkId: crossFile, ioType: "consumes", typeName: "Shared" },
        ]);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/same.ts", symbolName: "fovea" }],
            mkEngineAdapter(db),
            10,
        );

        expect(result).toHaveLength(1);
        expect(result[0].path).toBe("/proj/other.ts");
        expect(result[0].symbolName).toBe("external");
    });

    it("defensive ignore on DB lookup fail (FAIL-OPEN)", () => {
        // No chunks inserted — fovea path/symbol unknown to DB.
        const result = extractTypeLedgerParafovea(
            [{ path: "/never/indexed.ts", symbolName: "ghost" }],
            mkEngineAdapter(db),
            10,
        );
        expect(result).toEqual([]);
    });

    it("anti-hub ranking via rankByInDegree (highest authority first)", () => {
        const fovea = mkChunk("/proj/fovea.ts", "fovea");
        // Two consumers — one of them is itself a hub (other chunks consume IT).
        const hubConsumer = mkChunk("/proj/hub.ts", "hubConsumer");
        const leafConsumer = mkChunk("/proj/leaf.ts", "leafConsumer");
        const tertiary = mkChunk("/proj/tertiary.ts", "tertiary");

        db.insertSymbolIosBulk([
            { chunkId: fovea, ioType: "produces", typeName: "Seed" },
            { chunkId: hubConsumer, ioType: "consumes", typeName: "Seed" },
            { chunkId: leafConsumer, ioType: "consumes", typeName: "Seed" },
            // hubConsumer is itself authoritative: produces type that another consumes
            { chunkId: hubConsumer, ioType: "produces", typeName: "HubOutput" },
            { chunkId: tertiary, ioType: "consumes", typeName: "HubOutput" },
        ]);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "fovea" }],
            mkEngineAdapter(db),
            10,
        );

        // Both consumers should appear, but hubConsumer ranked first (higher inDegree)
        expect(result.length).toBe(2);
        expect(result[0].symbolName).toBe("hubConsumer");
        expect(result[1].symbolName).toBe("leafConsumer");
    });

    it("max_cross_file hard cap enforces UNIQUE chunk count", () => {
        const fovea = mkChunk("/proj/fovea.ts", "fovea");
        // Create 5 cross-file consumers
        const consumerIds: number[] = [];
        for (let i = 1; i <= 5; i++) {
            const id = mkChunk(`/proj/c${i}.ts`, `c${i}`);
            consumerIds.push(id);
        }
        const ioRows = [
            { chunkId: fovea, ioType: "produces" as const, typeName: "Hub" },
            ...consumerIds.map(id => ({
                chunkId: id, ioType: "consumes" as const, typeName: "Hub",
            })),
        ];
        db.insertSymbolIosBulk(ioRows);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "fovea" }],
            mkEngineAdapter(db),
            3, // Hard cap = 3
        );

        // 5 candidates, capped to 3 unique chunks
        const uniquePaths = new Set(result.map(c => c.path));
        expect(uniquePaths.size).toBe(3);
    });

    it("max_cross_file=0 returns empty", () => {
        const fovea = mkChunk("/proj/fovea.ts", "fovea");
        const consumer = mkChunk("/proj/c.ts", "c");
        db.insertSymbolIosBulk([
            { chunkId: fovea, ioType: "produces", typeName: "T1" },
            { chunkId: consumer, ioType: "consumes", typeName: "T1" },
        ]);

        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "fovea" }],
            mkEngineAdapter(db),
            0,
        );
        expect(result).toEqual([]);
    });

    it("empty result when fovea has no symbol_io relations", () => {
        mkChunk("/proj/fovea.ts", "isolated");
        // No insertSymbolIosBulk for fovea
        const result = extractTypeLedgerParafovea(
            [{ path: "/proj/fovea.ts", symbolName: "isolated" }],
            mkEngineAdapter(db),
            10,
        );
        expect(result).toEqual([]);
    });

    it("countTotalCrossFileBeforeTruncation reports pre-cap count", () => {
        const fovea = mkChunk("/proj/fovea.ts", "fovea");
        for (let i = 1; i <= 4; i++) {
            const id = mkChunk(`/proj/c${i}.ts`, `c${i}`);
            db.insertSymbolIosBulk([
                { chunkId: fovea, ioType: "produces", typeName: `T${i}` },
                { chunkId: id, ioType: "consumes", typeName: `T${i}` },
            ]);
        }
        const total = countTotalCrossFileBeforeTruncation(
            [{ path: "/proj/fovea.ts", symbolName: "fovea" }],
            mkEngineAdapter(db),
        );
        expect(total).toBe(4);
    });
});

describe("Phase 4: render functions (Furia #3 cleanSignature pure)", () => {
    function mkChunk(rel: "upstream" | "downstream", symbolName: string, shorthand: string): CrossFileChunk {
        return {
            chunkId: 0,
            path: `/proj/${symbolName}.ts`,
            symbolName,
            shorthand,
            relation: rel,
            seedType: "Shared",
        };
    }

    it("renderCrossFileUpstream produces [UPSTREAM] tagged lines", () => {
        const out = renderCrossFileUpstream([
            mkChunk("upstream", "consumerA", "[func] consumerA()"),
            mkChunk("upstream", "consumerB", "[func] consumerB()"),
        ]);
        expect(out).toContain("UPSTREAM CROSS-FILE");
        expect(out).toContain("[UPSTREAM]: /proj/consumerA.ts::consumerA");
        expect(out).toContain("[UPSTREAM]: /proj/consumerB.ts::consumerB");
    });

    it("renderCrossFileDownstream applies cleanSignature", () => {
        const out = renderCrossFileDownstream([
            mkChunk("downstream", "providerA", "[func] providerA(): ConfigType"),
        ]);
        expect(out).toContain("DOWNSTREAM CROSS-FILE");
        expect(out).toContain("[DOWNSTREAM /proj/providerA.ts::providerA]");
    });

    it("renderCrossFileUpstream filters out downstream entries", () => {
        const out = renderCrossFileUpstream([
            mkChunk("downstream", "shouldNotAppear", "[func] x()"),
        ]);
        expect(out).toBe("");
    });

    it("renderCrossFileDownstream filters out upstream entries", () => {
        const out = renderCrossFileDownstream([
            mkChunk("upstream", "shouldNotAppear", "[func] x()"),
        ]);
        expect(out).toBe("");
    });

    it("empty arrays produce empty output (no headers)", () => {
        expect(renderCrossFileUpstream([])).toBe("");
        expect(renderCrossFileDownstream([])).toBe("");
    });

    it("dedup: same chunk via multiple types appears once per render", () => {
        const out = renderCrossFileUpstream([
            { chunkId: 1, path: "/proj/x.ts", symbolName: "x", shorthand: "[func] x()", relation: "upstream", seedType: "T1" },
            { chunkId: 1, path: "/proj/x.ts", symbolName: "x", shorthand: "[func] x()", relation: "upstream", seedType: "T2" },
        ]);
        // Should contain the line once
        const matches = out.match(/\[UPSTREAM\]: \/proj\/x\.ts::x/g) ?? [];
        expect(matches.length).toBe(1);
    });

    it("renderTruncationAdvisory shows omitted count when truncated", () => {
        const out = renderTruncationAdvisory(15, 10);
        expect(out).toContain("5 more cross-file relations omitted");
    });

    it("renderTruncationAdvisory empty when no truncation", () => {
        expect(renderTruncationAdvisory(5, 10)).toBe("");
        expect(renderTruncationAdvisory(10, 10)).toBe("");
    });

    it("computeCrossFileBytes sums lengths plus newlines", () => {
        const u = "abc";       // 3
        const d = "defgh";     // 5
        const a = "ij";        // 2
        // Total: 3+1 + 5+1 + 2+1 = 13
        expect(computeCrossFileBytes(u, d, a)).toBe(13);
    });

    it("computeCrossFileBytes treats empty strings as zero contribution", () => {
        expect(computeCrossFileBytes("", "", "")).toBe(0);
        expect(computeCrossFileBytes("abc", "", "")).toBe(4);
    });
});
