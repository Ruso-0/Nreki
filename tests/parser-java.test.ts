/**
 * parser-java.test.ts - Activation smoke tests for Java grammar.
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

describe("Java grammar activation", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    it("marks Java extension as supported", () => {
        expect(parser.isSupported(".java")).toBe(true);
    });

    it("indexes Java methods", async () => {
        const code = `
            package com.example;
            public class Sample {
                public String helloWorld(String name) {
                    return "Hello, " + name + "!";
                }
            }
        `;
        const result = await parser.parse("Sample.java", code);
        const method = result.chunks.find(c => c.symbolName === "helloWorld");

        expect(method).toBeDefined();
        expect(method!.nodeType).toBe("method");
    });

    it("indexes Java classes", async () => {
        const code = `
            public class Greeter {
                public String greet() { return "hi"; }
            }
        `;
        const result = await parser.parse("Greeter.java", code);
        const klass = result.chunks.find(c => c.symbolName === "Greeter");

        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("does not crash on malformed Java", async () => {
        const result = await parser.parse("Broken.java", "public class Broken {");

        expect(Array.isArray(result.chunks)).toBe(true);
    });

    it("Java chunks do NOT populate consumes/produces (Type Ledger guard)", async () => {
        const code = `
            public class Sample {
                public String greet(String name, Integer age) {
                    return name + age;
                }
            }
        `;
        const result = await parser.parse("Sample.java", code);
        const method = result.chunks.find(c => c.symbolName === "greet");

        expect(method).toBeDefined();
        expect(method!.consumes).toBeUndefined();
        expect(method!.produces).toBeUndefined();
    });
});
