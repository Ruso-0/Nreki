/**
 * Unit tests for handleTypeGraph (Phase 3 nreki_navigate type_graph).
 *
 * Uses a mock engine that satisfies only the methods handleTypeGraph
 * calls, with an in-memory graph for deterministic walks. NO sql.js.
 */

import { describe, it, expect } from "vitest";
import { handleTypeGraph } from "../src/handlers/type-graph.js";
import type { ChunkRecord } from "../src/database.js";
import type { RouterDependencies, NavigateParams } from "../src/router.js";

interface MockChunk {
    id: number;
    path: string;
    raw_code: string;
    symbol_name: string;
    consumes: string[];
    produces: string[];
}

function buildChunkRecord(c: MockChunk, startLine = 1): ChunkRecord {
    const lines = c.raw_code.split("\n");
    return {
        id: c.id,
        path: c.path,
        shorthand: `[func] ${c.symbol_name}()`,
        raw_code: c.raw_code,
        node_type: "function_declaration",
        start_line: startLine,
        end_line: startLine + lines.length - 1,
        start_index: 0,
        end_index: c.raw_code.length,
        symbol_name: c.symbol_name,
    };
}

function mkDeps(chunks: MockChunk[]): RouterDependencies {
    const byConsumed = new Map<string, number[]>();
    const byProduced = new Map<string, number[]>();
    const ioByChunk = new Map<number, { consumes: string[]; produces: string[] }>();
    const allTypes = new Set<string>();

    for (const c of chunks) {
        ioByChunk.set(c.id, { consumes: c.consumes, produces: c.produces });
        for (const t of c.consumes) {
            allTypes.add(t);
            const list = byConsumed.get(t) ?? [];
            list.push(c.id);
            byConsumed.set(t, list);
        }
        for (const t of c.produces) {
            allTypes.add(t);
            const list = byProduced.get(t) ?? [];
            list.push(c.id);
            byProduced.set(t, list);
        }
    }

    const mockEngine = {
        initialize: async () => {},
        hasIndexedFiles: () => true,
        indexDirectory: async () => ({ indexed: 0, skipped: 0, errors: 0 }),
        getProjectRoot: () => "/test",
        getChunksByConsumedType: (typeName: string) => byConsumed.get(typeName) ?? [],
        getChunksByProducedType: (typeName: string) => byProduced.get(typeName) ?? [],
        getSymbolIOByChunkId: (chunkId: number) =>
            ioByChunk.get(chunkId) ?? { consumes: [], produces: [] },
        getChunksByIds: (ids: number[]) => {
            const map = new Map(chunks.map(c => [c.id, buildChunkRecord(c)]));
            return ids.map(id => map.get(id)).filter((c): c is ChunkRecord => c !== undefined);
        },
        getAllTypeNames: () => Array.from(allTypes),
    };
    return { engine: mockEngine } as unknown as RouterDependencies;
}

describe("handleTypeGraph (Sub-sprint C.3)", () => {
    it("missing type_name returns usage advisory", async () => {
        const params: NavigateParams = { action: "type_graph" };
        const result = await handleTypeGraph(params, mkDeps([]));
        expect(result.content[0].text).toContain("requires param type_name");
    });

    it("seed_type not found returns search suggestion", async () => {
        const params: NavigateParams = { action: "type_graph", type_name: "Nonexistent" };
        const result = await handleTypeGraph(params, mkDeps([]));
        const text = result.content[0].text;
        expect(text).toContain("not found");
        expect(text).toContain('action:"search"');
    });

    it("NOCASE fallback suggests case-corrected name", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/a.ts", raw_code: "fn a", symbol_name: "a", consumes: ["User"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "user" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("not found");
        expect(text).toContain("Did you mean 'User'");
    });

    it("depth=1 bidirectional returns consumers and producers tagged", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/c.ts", raw_code: "fn consumer", symbol_name: "consumer", consumes: ["User"], produces: [] },
            { id: 2, path: "/test/p.ts", raw_code: "fn producer", symbol_name: "producer", consumes: [], produces: ["User"] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("[CONSUMES: User]");
        expect(text).toContain("[PRODUCES: User]");
        expect(text).toContain("c.ts:L1");
        expect(text).toContain("p.ts:L1");
    });

    it("direction='consumers' filters out producers", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/c.ts", raw_code: "consumer", symbol_name: "c", consumes: ["User"], produces: [] },
            { id: 2, path: "/test/p.ts", raw_code: "producer", symbol_name: "p", consumes: [], produces: ["User"] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User", direction: "consumers" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("[CONSUMES: User]");
        expect(text).not.toContain("[PRODUCES: User]");
    });

    it("direction='producers' filters out consumers", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/c.ts", raw_code: "consumer", symbol_name: "c", consumes: ["User"], produces: [] },
            { id: 2, path: "/test/p.ts", raw_code: "producer", symbol_name: "p", consumes: [], produces: ["User"] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User", direction: "producers" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("[PRODUCES: User]");
        expect(text).not.toContain("[CONSUMES: User]");
    });

    it("CONSUMES & PRODUCES merged tag when chunk does both for same type", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/both.ts", raw_code: "both", symbol_name: "b", consumes: ["User"], produces: ["User"] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        expect(result.content[0].text).toContain("[CONSUMES & PRODUCES: User]");
    });

    it("depth=2 expands one more hop via OTHER types", async () => {
        const chunks: MockChunk[] = [
            // Hop 0: consumer1 consumes seed=User AND produces Token
            { id: 1, path: "/test/h0.ts", raw_code: "h0", symbol_name: "h0", consumes: ["User"], produces: ["Token"] },
            // Hop 1: hop1 consumes Token (reachable only via depth=2)
            { id: 2, path: "/test/h1.ts", raw_code: "h1", symbol_name: "h1", consumes: ["Token"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User", walk_depth: 2 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("h0.ts:L1");
        expect(text).toContain("h1.ts:L1");
        expect(text).toContain("[CONSUMES: Token]");
    });

    it("depth=1 does NOT expand to depth=2 reachable chunks", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/h0.ts", raw_code: "h0", symbol_name: "h0", consumes: ["User"], produces: ["Token"] },
            { id: 2, path: "/test/h1.ts", raw_code: "h1", symbol_name: "h1", consumes: ["Token"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "User", walk_depth: 1 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("h0.ts:L1");
        expect(text).not.toContain("h1.ts:L1");
    });

    it("cycle detection: visited Set prevents re-processing", async () => {
        // h0 produces Cycle, h1 consumes Cycle and produces Cycle → infinite without dedup
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/h0.ts", raw_code: "h0", symbol_name: "h0", consumes: [], produces: ["Cycle"] },
            { id: 2, path: "/test/h1.ts", raw_code: "h1", symbol_name: "h1", consumes: ["Cycle"], produces: ["Cycle"] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "Cycle", walk_depth: 2 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        // Both chunks present, no infinite loop
        expect(text).toContain("h0.ts:L1");
        expect(text).toContain("h1.ts:L1");
        // total_visited should be exactly 2
        expect(text).toContain('"total_visited": 2');
    });

    it("max_nodes hard cap truncates BFS", async () => {
        const chunks: MockChunk[] = [];
        for (let i = 1; i <= 20; i++) {
            chunks.push({
                id: i, path: `/test/c${i}.ts`, raw_code: `code ${i}`,
                symbol_name: `c${i}`, consumes: ["Hub"], produces: [],
            });
        }
        const params: NavigateParams = { action: "type_graph", type_name: "Hub", max_nodes: 5 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain('"total_visited": 5');
        expect(text).toContain('"max_nodes": 5');
    });

    it("token_budget overflow listed as shorthand", async () => {
        const longCode = "x".repeat(2000);
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/big1.ts", raw_code: longCode, symbol_name: "big1", consumes: ["X"], produces: [] },
            { id: 2, path: "/test/big2.ts", raw_code: longCode, symbol_name: "big2", consumes: ["X"], produces: [] },
            { id: 3, path: "/test/big3.ts", raw_code: longCode, symbol_name: "big3", consumes: ["X"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "X", token_budget: 700 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("Truncated by token_budget");
        // truncated_count must be > 0
        expect(text).toMatch(/"truncated_count":\s*[1-9]/);
    });

    it("token_budget=0 places all chunks in overflow", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/a.ts", raw_code: "a", symbol_name: "a", consumes: ["X"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "X", token_budget: 0 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain('"returned_chunks": 0');
        expect(text).toContain('"truncated_count": 1');
        expect(text).toContain("Truncated by token_budget");
    });

    it("response shape includes structured header JSON block", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/a.ts", raw_code: "a", symbol_name: "a", consumes: ["X"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "X" };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        const text = result.content[0].text;
        expect(text).toContain("## type_graph result");
        expect(text).toContain('"seed_type": "X"');
        expect(text).toContain('"walk_depth": 1');
        expect(text).toContain('"direction": "bidirectional"');
        expect(text).toContain('"total_visited":');
        expect(text).toContain('"returned_chunks":');
        expect(text).toContain('"truncated_count":');
        expect(text).toContain('"tokens_used":');
    });

    it("walk_depth clamps over-max to 2", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/a.ts", raw_code: "a", symbol_name: "a", consumes: ["X"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "X", walk_depth: 99 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        expect(result.content[0].text).toContain('"walk_depth": 2');
    });

    it("max_nodes clamps over-max to 100", async () => {
        const chunks: MockChunk[] = [
            { id: 1, path: "/test/a.ts", raw_code: "a", symbol_name: "a", consumes: ["X"], produces: [] },
        ];
        const params: NavigateParams = { action: "type_graph", type_name: "X", max_nodes: 9999 };
        const result = await handleTypeGraph(params, mkDeps(chunks));
        expect(result.content[0].text).toContain('"max_nodes": 100');
    });
});
