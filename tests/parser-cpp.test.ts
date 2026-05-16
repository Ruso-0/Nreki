/**
 * parser-cpp.test.ts - Activation smoke tests for C++ grammar.
 *
 * v11.0.x multi-language sprint.
 *
 * Test pattern note: this file does NOT include an explicit
 * afterAll(parser.shutdown()) hook. ASTParser instances register
 * themselves via registerTestResource() in their constructor, and
 * tests/setup-resource-cleanup.ts globally disposes them on test
 * file teardown. This is the same pattern used in parser-tsx.test.ts
 * and parser-modern-ts.test.ts; the Furia Round 35 WASM hygiene
 * rule is satisfied by the global setup file.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";

describe("C++ grammar activation", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    it("marks C++ extensions as supported", () => {
        for (const ext of [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]) {
            expect(parser.isSupported(ext)).toBe(true);
        }
    });

    it("indexes C++ functions", async () => {
        const code = `
            #include <string>
            std::string helloWorld(const std::string& name) {
                return "Hello, " + name + "!";
            }
        `;
        const result = await parser.parse("sample.cpp", code);
        const fn = result.chunks.find(c => c.symbolName === "helloWorld");

        expect(fn).toBeDefined();
        expect(fn!.nodeType).toBe("func");
    });

    it("indexes C++ classes", async () => {
        const code = `
            class Greeter {
            public:
                const char* greet() const;
            };
        `;
        const result = await parser.parse("sample.cpp", code);
        const klass = result.chunks.find(c => c.symbolName === "Greeter");

        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("does not crash on malformed C++", async () => {
        const result = await parser.parse("broken.cpp", "int broken(");

        expect(Array.isArray(result.chunks)).toBe(true);
    });

    it("C++ chunks do NOT populate consumes/produces (Type Ledger guard)", async () => {
        const code = `
            std::string greet(const std::string& name, int age) {
                return name + std::to_string(age);
            }
        `;
        const result = await parser.parse("test.cpp", code);
        const fn = result.chunks.find(c => c.symbolName === "greet");

        expect(fn).toBeDefined();
        expect(fn!.consumes).toBeUndefined();
        expect(fn!.produces).toBeUndefined();
    });
});
