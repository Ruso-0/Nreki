import { describe, expect, it, vi } from "vitest";

import { extractTypeLedgerParafovea } from "../src/compressor-foveal-cross-file.js";

interface MockRecord {
    id: number;
    path: string;
    symbol_name: string;
    shorthand: string;
}

interface MockEngineOptions {
    lookup?: Map<string, number>;
    io?: Map<number, { consumes: string[]; produces: string[] }>;
    consumedBy?: Map<string, number[]>;
    producedBy?: Map<string, number[]>;
    records?: MockRecord[];
    search?: ReturnType<typeof vi.fn>;
}

function key(path: string, symbol: string): string {
    return `${path}::${symbol}`;
}

function mkRecord(id: number, path: string, symbol: string): MockRecord {
    return {
        id,
        path,
        symbol_name: symbol,
        shorthand: `[func] ${symbol}()`,
    };
}

function mkEngine(options: MockEngineOptions) {
    const lookup = options.lookup ?? new Map<string, number>();
    const io = options.io ?? new Map<number, { consumes: string[]; produces: string[] }>();
    const consumedBy = options.consumedBy ?? new Map<string, number[]>();
    const producedBy = options.producedBy ?? new Map<string, number[]>();
    const records = options.records ?? [];
    const search = options.search ?? vi.fn(() => []);

    return {
        getChunkIdByPathAndSymbol: (path: string, symbolName: string) =>
            lookup.get(key(path, symbolName)) ?? null,
        getSymbolIOByChunkId: (id: number) =>
            io.get(id) ?? { consumes: [], produces: [] },
        getChunksByConsumedType: (typeName: string) =>
            consumedBy.get(typeName) ?? [],
        getChunksByProducedType: (typeName: string) =>
            producedBy.get(typeName) ?? [],
        getChunksByIds: (ids: number[]) =>
            records.filter(r => ids.includes(r.id)),
        search,
    } as any;
}

describe("cross-file Type Ledger BM25 fallback", () => {
    it("Type Ledger resolves directly -> BM25 fallback NOT triggered", () => {
        const search = vi.fn(() => [{ chunkId: 99, score: 10 }]);
        const engine = mkEngine({
            lookup: new Map([[key("/src/fovea.ts", "makeUser"), 1]]),
            io: new Map([[1, { consumes: [], produces: ["User"] }]]),
            consumedBy: new Map([["User", [2]]]),
            records: [
                mkRecord(1, "/src/fovea.ts", "makeUser"),
                mkRecord(2, "/src/consumer.ts", "useUser"),
            ],
            search,
        });

        const result = extractTypeLedgerParafovea(
            [{ path: "/src/fovea.ts", symbolName: "makeUser" }],
            engine,
            10,
        );

        expect(search).not.toHaveBeenCalled();
        expect(result).toHaveLength(1);
        expect(result[0].source).toBe("type-ledger");
        expect(result[0].relation).toBe("upstream");
    });

    it("Type Ledger fails -> BM25 fallback returns chunks", () => {
        const engine = mkEngine({
            search: vi.fn(() => [{ chunkId: 2, score: 10 }]),
            records: [mkRecord(2, "/src/fallback.ts", "fallbackHit")],
        });

        const result = extractTypeLedgerParafovea(
            [{ path: "/src/missing.ts", symbolName: "MissingSymbol" }],
            engine,
            10,
        );

        expect(result).toHaveLength(1);
        expect(result[0].chunkId).toBe(2);
        expect(result[0].source).toBe("bm25-fallback");
        expect(result[0].score).toBe(5);
    });

    it("Dedup works: chunk via both sources counted once", () => {
        const engine = mkEngine({
            lookup: new Map([[key("/src/fovea.ts", "makeUser"), 1]]),
            io: new Map([[1, { consumes: [], produces: ["User"] }]]),
            consumedBy: new Map([["User", [2]]]),
            records: [
                mkRecord(1, "/src/fovea.ts", "makeUser"),
                mkRecord(2, "/src/shared.ts", "sharedHit"),
                mkRecord(3, "/src/fallback.ts", "fallbackHit"),
            ],
            search: vi.fn(() => [
                { chunkId: 2, score: 10 },
                { chunkId: 3, score: 8 },
            ]),
        });

        const result = extractTypeLedgerParafovea(
            [
                { path: "/src/fovea.ts", symbolName: "makeUser" },
                { path: "/src/missing.ts", symbolName: "MissingSymbol" },
            ],
            engine,
            10,
        );

        const ids = result.map(r => r.chunkId);
        expect(ids.filter(id => id === 2)).toHaveLength(1);
        expect(ids).toContain(3);
        expect(result.find(r => r.chunkId === 2)?.source).toBe("type-ledger");
    });

    it("Empty BM25 results: no crash, continues silently", () => {
        const engine = mkEngine({
            search: vi.fn(() => []),
            records: [],
        });

        const result = extractTypeLedgerParafovea(
            [{ path: "/src/missing.ts", symbolName: "MissingSymbol" }],
            engine,
            10,
        );

        expect(result).toEqual([]);
    });
});
