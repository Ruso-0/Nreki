/**
 * parser-c.test.ts - Activation smoke tests for C grammar.
 *
 * v11.0.1 C/H activation sprint.
 *
 * Test pattern note: this file does NOT include an explicit
 * afterAll(parser.shutdown()) hook. ASTParser instances register
 * themselves via registerTestResource() in their constructor, and
 * tests/setup-resource-cleanup.ts globally disposes them on test
 * file teardown.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";

describe("C grammar activation", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    it("marks C extension as supported", () => {
        expect(parser.isSupported(".c")).toBe(true);
    });

    it("indexes C functions with simple return type", async () => {
        const code = `int hello(int x) { return x + 1; }`;
        const result = await parser.parse("sample.c", code);
        const fn = result.chunks.find(c => c.symbolName === "hello");

        expect(fn).toBeDefined();
        expect(fn!.nodeType).toBe("func");
    });

    it("indexes C functions returning pointers (pointer_declarator)", async () => {
        const code = `char *strdup(const char *s) { return NULL; }`;
        const result = await parser.parse("strdup.c", code);
        const fn = result.chunks.find(c => c.symbolName === "strdup");

        expect(fn).toBeDefined();
        expect(fn!.nodeType).toBe("func");
    });

    it("indexes C functions returning double pointers", async () => {
        const code = `int **matrix_alloc(int n) { return NULL; }`;
        const result = await parser.parse("matrix.c", code);
        const fn = result.chunks.find(c => c.symbolName === "matrix_alloc");

        expect(fn).toBeDefined();
        expect(fn!.nodeType).toBe("func");
    });

    it("indexes C typedefs", async () => {
        const code = `typedef struct { int x; int y; } Point;`;
        const result = await parser.parse("sample.c", code);
        const typeChunk = result.chunks.find(c => c.symbolName === "Point");

        expect(typeChunk).toBeDefined();
        expect(typeChunk!.nodeType).toBe("type");
    });

    it("indexes C structs", async () => {
        const code = `struct Data { int id; char *name; };`;
        const result = await parser.parse("sample.c", code);
        const klass = result.chunks.find(c => c.symbolName === "Data");

        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("captures typedef forward declarations", async () => {
        const code = `
            typedef struct Foo Foo;
            typedef int (*callback_t)(int);
        `;
        const result = await parser.parse("test.c", code);

        const fooTypedef = result.chunks.find(c =>
            c.symbolName === "Foo" && c.nodeType === "type"
        );
        expect(fooTypedef).toBeDefined();

        const cbTypedef = result.chunks.find(c =>
            c.symbolName === "callback_t" && c.nodeType === "type"
        );
        expect(cbTypedef).toBeDefined();
    });

    it("parses C99 designated initializers without error", async () => {
        const code = `
            typedef struct { int x; int y; } Point;
            int main(void) {
                Point p = {.x = 1, .y = 2};
                return 0;
            }
        `;
        const result = await parser.parse("sample.c", code);

        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("does not crash on malformed C", async () => {
        const result = await parser.parse("broken.c", "int broken(");

        expect(Array.isArray(result.chunks)).toBe(true);
    });

    it("C chunks do NOT populate consumes/produces (Type Ledger guard)", async () => {
        const code = `int add(int a, int b) { return a + b; }`;
        const result = await parser.parse("test.c", code);
        const fn = result.chunks.find(c => c.symbolName === "add");

        expect(fn).toBeDefined();
        expect(fn!.consumes).toBeUndefined();
        expect(fn!.produces).toBeUndefined();
    });
});
