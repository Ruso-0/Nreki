import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";

describe("parser type I/O extraction (sub-sprint 2.2)", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    async function parseFirstChunk(code: string, file = "fixture.ts") {
        const result = await parser.parse(file, code);
        expect(result.chunks.length).toBeGreaterThan(0);
        return result.chunks[0];
    }

    async function parseChunkBySymbol(code: string, symbolName: string, file = "fixture.ts") {
        const result = await parser.parse(file, code);
        const chunk = result.chunks.find((c) => c.symbolName === symbolName);
        expect(chunk, `chunk "${symbolName}" not found among [${result.chunks.map(c => c.symbolName).join(", ")}]`).toBeDefined();
        return chunk!;
    }

    it("(a) Result<T> unwraps to T (Result in expanded UNWRAP)", async () => {
        const chunk = await parseFirstChunk(
            "function processOrder(order: Order): Result<Invoice> { return null as any; }"
        );
        expect(chunk.consumes).toEqual(["Order"]);
        expect(chunk.produces).toEqual(["Invoice"]);
    });

    it("(b) Promise<User[]> unwraps to User", async () => {
        const chunk = await parseFirstChunk(
            "async function fetchUsers(): Promise<User[]> { return []; }"
        );
        expect(chunk.consumes).toEqual([]);
        expect(chunk.produces).toEqual(["User"]);
    });

    it("(c) any/void are discarded", async () => {
        const chunk = await parseFirstChunk(
            "function noop(x: any): void { return; }"
        );
        expect(chunk.consumes).toEqual([]);
        expect(chunk.produces).toEqual([]);
    });

    it("(d) class method: Promise<void> produces nothing", async () => {
        const chunk = await parseChunkBySymbol(
            "class Repo { save(item: Item): Promise<void> { return Promise.resolve(); } }",
            "save",
        );
        expect(chunk.nodeType).toBe("method");
        expect(chunk.consumes).toEqual(["Item"]);
        expect(chunk.produces).toEqual([]);
    });

    it("(e) nested generic Promise<Map<string,User>> reduces to Map (documented regex gap)", async () => {
        const chunk = await parseFirstChunk(
            "function f(): Promise<Map<string, User>> { return new Map(); }"
        );
        expect(chunk.produces).toEqual(["Map"]);
    });

    it("(f) Either kept as container; Option<User> unwraps to User", async () => {
        const chunk = await parseFirstChunk(
            "function h(e: Either<Error, Token>): Option<User> { return null as any; }"
        );
        expect(chunk.consumes).toEqual(["Either"]);
        expect(chunk.produces).toEqual(["User"]);
    });

    it("(g) non-callable nodes (class) leave consumes/produces undefined", async () => {
        const chunk = await parseChunkBySymbol(
            "class MyClass { }",
            "MyClass",
        );
        expect(chunk.nodeType).toBe("class");
        expect(chunk.consumes).toBeUndefined();
        expect(chunk.produces).toBeUndefined();
    });
});
