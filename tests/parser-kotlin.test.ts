/**
 * parser-kotlin.test.ts - Activation smoke tests for Kotlin grammar.
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

describe("Kotlin grammar activation", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    it("marks Kotlin extensions as supported", () => {
        expect(parser.isSupported(".kt")).toBe(true);
        expect(parser.isSupported(".kts")).toBe(true);
    });

    it("indexes Kotlin functions", async () => {
        const code = `
            package com.example
            fun helloWorld(name: String): String {
                return "Hello, $name!"
            }
        `;
        const result = await parser.parse("sample.kt", code);
        const fn = result.chunks.find(c => c.symbolName === "helloWorld");

        expect(fn).toBeDefined();
        expect(fn!.nodeType).toBe("func");
    });

    it("indexes Kotlin classes", async () => {
        const code = `
            class Greeter {
                fun greet() = "hi"
            }
        `;
        const result = await parser.parse("sample.kt", code);
        const klass = result.chunks.find(c => c.symbolName === "Greeter");

        expect(klass).toBeDefined();
        expect(klass!.nodeType).toBe("class");
    });

    it("does not crash on malformed Kotlin", async () => {
        const result = await parser.parse("broken.kt", "fun broken(");

        expect(Array.isArray(result.chunks)).toBe(true);
    });

    it("Kotlin chunks do NOT populate consumes/produces (Type Ledger guard)", async () => {
        const code = `
            fun greet(name: String, age: Int): String {
                return "Hello, $name, age $age"
            }
        `;
        const result = await parser.parse("test.kt", code);
        const fn = result.chunks.find(c => c.symbolName === "greet");

        expect(fn).toBeDefined();
        expect(fn!.consumes).toBeUndefined();
        expect(fn!.produces).toBeUndefined();
    });
});
