import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";
import { extractTypeIO } from "../src/utils/type-extractor.js";

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

describe("Sub-sprint 2.2.2.2: reserved words filtering", () => {
    const reserved = [
        "typeof", "asserts", "keyof", "infer",
        "extends", "is", "in", "as",
        "satisfies", "readonly",
    ];

    it.each(reserved)("discards reserved word '%s' from consumes", (token) => {
        const result = extractTypeIO(`function f(x: ${token}): void {}`);
        expect(result.consumes).not.toContain(token);
    });
});

describe("Sub-sprint 2.2.2.2: single-letter generic filtering", () => {
    it("discards single-letter T from consumes and produces", () => {
        const result = extractTypeIO("function f<T>(x: T): T {}");
        expect(result.consumes).not.toContain("T");
        expect(result.produces).not.toContain("T");
    });

    it("discards single-letter K, V, R", () => {
        const r1 = extractTypeIO("function f(x: K): V {}");
        expect(r1.consumes).not.toContain("K");
        expect(r1.produces).not.toContain("V");
        const r2 = extractTypeIO("function g(x: P): R {}");
        expect(r2.consumes).not.toContain("P");
        expect(r2.produces).not.toContain("R");
    });

    it("preserves real custom 2-char types (ID, DB)", () => {
        const result = extractTypeIO("function f(x: ID): DB {}");
        expect(result.consumes).toContain("ID");
        expect(result.produces).toContain("DB");
    });

    it("preserves multi-char identifiers", () => {
        const result = extractTypeIO("function f(x: User): Order {}");
        expect(result.consumes).toContain("User");
        expect(result.produces).toContain("Order");
    });
});

describe("Sub-sprint 2.2.2.2: inline object literal handling (structural fix)", () => {
    it("does not emit inline object as type when wrapped in Promise", () => {
        const sample =
            "async function f(): Promise<{ a: string; b: number }> { return null as any; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n]/);
        }
    });

    it("does not emit union as type when wrapped in Promise", () => {
        const sample = "async function h(): Promise<string[] | Error> { return []; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n|]/);
            expect(t).not.toMatch(/\s/);
        }
    });

    it("does not emit intersection as type when wrapped in Promise", () => {
        const sample =
            "async function g(): Promise<T & { name: string }> { return null as any; }";
        const result = extractTypeIO(sample);
        for (const t of result.produces) {
            expect(t).not.toMatch(/[{\[\(\n&]/);
        }
    });

    it("control: Promise<User> still unwraps to User", () => {
        const sample = "async function f(): Promise<User> { return null as any; }";
        const result = extractTypeIO(sample);
        expect(result.produces).toContain("User");
    });

    it("Promise<Result<User>> stops at Result (documented regex gap, L11-L13)", () => {
        // TYPE_TOKEN's `<[^>]+>` greedy match captures "Promise<Result<User>"
        // (one '>' short of full nested closure), so recursive unwrap stops
        // at "Result". Sub-sprint 2.2.2.2 preserves this baseline; nested
        // generic depth is a separate concern.
        const sample = "async function f(): Promise<Result<User>> { return null as any; }";
        const result = extractTypeIO(sample);
        expect(result.produces).toContain("Result");
    });
});

