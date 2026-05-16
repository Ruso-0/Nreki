/**
 * Multi-language activation gate test.
 *
 * Loads each newly-activated WASM grammar and verifies:
 *   1. Grammar loads without error
 *   2. Query compiles against the loaded grammar
 *   3. At least one chunk is extracted from a minimal fixture
 *
 * This test serves as a regression guard against tree-sitter-wasms
 * upgrades that might change grammar versions and break node-name
 * compatibility. If this test fails, the activation of the affected
 * language regresses to silent failure for end users.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ASTParser } from "../src/parser.js";

const CASES = [
    { ext: ".kt", file: "Sample.kt", code: "fun helloWorld(): String { return \"hi\" }" },
    { ext: ".kts", file: "Sample.kts", code: "fun helloWorld(): String { return \"hi\" }" },
    { ext: ".java", file: "Sample.java", code: "public class Sample { public String helloWorld() { return \"hi\"; } }" },
    { ext: ".cpp", file: "sample.cpp", code: "int helloWorld() { return 1; }" },
    { ext: ".cc", file: "sample.cc", code: "int helloWorld() { return 1; }" },
    { ext: ".cxx", file: "sample.cxx", code: "int helloWorld() { return 1; }" },
    { ext: ".hpp", file: "sample.hpp", code: "class Greeter { public: int helloWorld(); };" },
    { ext: ".hh", file: "sample.hh", code: "class Greeter { public: int helloWorld(); };" },
    { ext: ".hxx", file: "sample.hxx", code: "class Greeter { public: int helloWorld(); };" },
    { ext: ".c", file: "sample.c", code: "int helloWorld(void) { return 1; }" },
    { ext: ".h", file: "sample.h", code: "int helloWorld(void);" },
];

describe("multi-language parser activation gate", () => {
    let parser: ASTParser;

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    for (const c of CASES) {
        it(`loads grammar, compiles query, and extracts chunks for ${c.ext}`, async () => {
            expect(parser.isSupported(c.ext)).toBe(true);

            const result = await parser.parse(c.file, c.code);

            expect(result.chunks.length).toBeGreaterThanOrEqual(1);
        });
    }
});
