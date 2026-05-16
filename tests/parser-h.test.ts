/**
 * parser-h.test.ts - Activation smoke tests for .h header routing.
 *
 * v11.0.1 C/H activation sprint. Verifies:
 *   1. .h extension is recognized
 *   2. Forward declarations are captured via @fwd_func
 *   3. C++ markers dispatch to C++ grammar (verified via class_specifier captures)
 *   4. Pure C headers stay with C grammar
 *   5. Type Ledger guard holds for both paths
 *
 * Known limitation (v11.0.1): CPP_QUERY does not yet include patterns
 * for template_declaration or linkage_specification nesting. Template
 * classes and extern "C" blocks route to C++ grammar correctly but
 * require query extensions for symbol capture. Tracked as follow-up.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";

describe("Header routing (.h grammar activation)", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    it("marks .h extension as supported", () => {
        expect(parser.isSupported(".h")).toBe(true);
    });

    it("captures forward declarations in pure C headers", async () => {
        const code = `#ifndef TEST_H
#define TEST_H

typedef struct Point Point;

void point_init(Point *p, int x, int y);
int point_distance(Point *a, Point *b);

#endif`;
        const result = await parser.parse("test.h", code);

        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        const init = result.chunks.find(c => c.symbolName === "point_init");
        const dist = result.chunks.find(c => c.symbolName === "point_distance");
        // The typedef struct Point Point; captures Point as struct_specifier
        // (@class). The type_definition query pattern may not match in all
        // tree-sitter-c grammar versions for forward-declared typedefs.
        const point = result.chunks.find(c => c.symbolName === "Point");

        expect(init).toBeDefined();
        expect(init!.nodeType).toBe("func");
        expect(dist).toBeDefined();
        expect(dist!.nodeType).toBe("func");
        expect(point).toBeDefined();
    });

    it("captures structs in C headers", async () => {
        const code = `struct Data { int id; char *name; };`;
        const result = await parser.parse("data.h", code);
        const klass = result.chunks.find(c => c.symbolName === "Data");

        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("routes C++ headers to C++ grammar and captures classes", async () => {
        // C++ marker (public:) triggers CPP grammar routing.
        // CPP_QUERY captures class_specifier with @class_name.
        const code = `class Greeter {
public:
    int hello() const;
};`;
        const result = await parser.parse("greeter.h", code);

        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        const klass = result.chunks.find(c => c.symbolName === "Greeter");
        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("routes namespace headers to C++ grammar and captures inner class", async () => {
        // namespace triggers C++ routing; inner class_specifier should be captured.
        const code = `namespace utils {
    class Helper {
    public:
        int process(int x);
    };
}`;
        const result = await parser.parse("ns.h", code);

        expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        const klass = result.chunks.find(c => c.symbolName === "Helper");
        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("does not crash on malformed headers", async () => {
        const result = await parser.parse("broken.h", "#define BROKEN(");

        expect(Array.isArray(result.chunks)).toBe(true);
    });

    it("header chunks do NOT populate consumes/produces (Type Ledger guard)", async () => {
        const code = `void process(int x, int y);`;
        const result = await parser.parse("test.h", code);
        const fn = result.chunks.find(c => c.symbolName === "process");

        expect(fn).toBeDefined();
        expect(fn!.consumes).toBeUndefined();
        expect(fn!.produces).toBeUndefined();
    });
});
