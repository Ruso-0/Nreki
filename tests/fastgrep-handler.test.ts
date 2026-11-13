/**
 * Unit and integration tests for handleFastGrep, handleSearch recall/compaction,
 * and repo-map semantic purpose extraction.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { handleFastGrep, handleSearch } from "../src/handlers/navigate.js";
import type { ChunkRecord } from "../src/database.js";
import type { RouterDependencies, NavigateParams } from "../src/router.js";
import { NrekiEngine } from "../src/engine.js";
import { ASTParser } from "../src/parser.js";
import { generateRepoMap, repoMapToText } from "../src/repo-map.js";

function mkChunk(partial: {
    path: string;
    raw_code: string;
    start_line: number;
    symbol_name: string;
}): ChunkRecord {
    return {
        id: 0,
        path: partial.path,
        shorthand: "",
        raw_code: partial.raw_code,
        node_type: "function_declaration",
        start_line: partial.start_line,
        end_line: partial.start_line + partial.raw_code.split("\n").length - 1,
        start_index: 0,
        end_index: partial.raw_code.length,
        symbol_name: partial.symbol_name,
    };
}

function mkDeps(chunks: ChunkRecord[]): RouterDependencies {
    const mockEngine = {
        initialize: async () => {},
        getProjectRoot: () => "/test",
        hasIndexedFiles: () => true,
        getStats: () => ({ filesIndexed: chunks.length, totalChunks: chunks.length }),
        indexDirectory: async () => ({ indexed: 0, skipped: 0, errors: 0 }),
        logUsage: () => {},
        fastGrep: async (query: string, limit: number) =>
            chunks.filter(c => c.raw_code.includes(query)).slice(0, limit).map(c => ({
                path: c.path,
                raw_code: c.raw_code,
                start_line: c.start_line,
                symbol_name: c.symbol_name,
            })),
    };
    return { engine: mockEngine } as unknown as RouterDependencies;
}

describe("handleFastGrep correctness & deduplication", () => {
    const mockChunks: ChunkRecord[] = [
        mkChunk({
            path: "/test/file1.ts",
            symbol_name: "funcA",
            start_line: 10,
            raw_code: "export function funcA() {\n  const x = 1;\n  return x;\n}",
        }),
        mkChunk({
            path: "/test/file1.ts",
            symbol_name: "funcB",
            start_line: 20,
            raw_code: "export function funcB() {\n  export const y = 2;\n  return y;\n}",
        }),
        mkChunk({
            path: "/test/file2.ts",
            symbol_name: "funcC",
            start_line: 30,
            raw_code: "const nohit = \"other code\";\nexport const z = 3;",
        }),
    ];

    it("returns 'No matches found' when query has no matches", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "NONEXISTENT_TOKEN" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        expect(result.content[0].text).toContain("No matches found");
    });

    it("finds single-hit queries with correct line numbers", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "funcA" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        const text = result.content[0].text;
        expect(text).toContain("L10");
        expect(text).toContain("Found 1 match(es)");
    });

    it("finds multiple hits in the same chunk at different lines", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        const text = result.content[0].text;
        expect(text).toContain("L10");
        expect(text).toContain("L20");
        expect(text).toContain("L21");
        expect(text).toContain("L31");
        expect(text).toContain("Found 4 match(es)");
    });

    it("does NOT report duplicate hits on the same line", async () => {
        const dup = [mkChunk({
            path: "/test/dup.ts",
            symbol_name: "dup",
            start_line: 5,
            raw_code: "export export export;",
        })];
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(dup));
        expect(result.content[0].text).toContain("Found 1 match(es)");
    });

    it("deduplicates overlapping class and method chunks on the same line, attributing to the innermost method", async () => {
        const overlapping = [
            mkChunk({
                path: "/test/service.ts",
                symbol_name: "UserService",
                start_line: 10,
                raw_code: [
                    "export class UserService {",
                    "  private count = 0;",
                    "  loginUser() {",
                    "    return 'SECRET_LOGIN_MARKER';",
                    "  }",
                    "}",
                ].join("\n"),
            }),
            mkChunk({
                path: "/test/service.ts",
                symbol_name: "loginUser",
                start_line: 12,
                raw_code: [
                    "  loginUser() {",
                    "    return 'SECRET_LOGIN_MARKER';",
                    "  }",
                ].join("\n"),
            }),
        ];
        const result = await handleFastGrep({ action: "fast_grep", query: "SECRET_LOGIN_MARKER" }, mkDeps(overlapping));
        const text = result.content[0].text;
        expect(text).toContain("Found 1 match(es)");
        expect(text).toContain("service.ts :: loginUser (L13)");
        expect(text).not.toContain("service.ts :: UserService (L13)");
    });

    it("handles hits in the last line without trailing newline", async () => {
        const chunk = [mkChunk({
            path: "/test/noNl.ts",
            symbol_name: "tail",
            start_line: 1,
            raw_code: "line1\nline2\nexport const end = 1",
        })];
        const params: NavigateParams = { action: "fast_grep", query: "export" };
        const result = await handleFastGrep(params, mkDeps(chunk));
        const text = result.content[0].text;
        expect(text).toContain("L3");
        expect(text).toContain("export const end = 1");
    });

    it("handles multi-line queries", async () => {
        const params: NavigateParams = { action: "fast_grep", query: "1;\n  return" };
        const result = await handleFastGrep(params, mkDeps(mockChunks));
        expect(result.content[0].text).toContain("match spans multiple lines");
    });
});

describe("Full lexical & conceptual recall (indexAstChunks + BM25 + repo-map purpose)", () => {
    let tmpDir: string;
    let engine: NrekiEngine;
    let parser: ASTParser;

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-recall-test-"));
        const srcDir = path.join(tmpDir, "src", "utils");
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(
            path.join(srcDir, "path-jail.ts"),
            [
                "/**",
                " * path-jail.ts - Path traversal protection for NREKI.",
                " *",
                " * Prevents a file path from escaping the project directory.",
                " */",
                "import path from 'path';",
                "import { TOP_LEVEL_IMPORT_MARKER } from './other.js';",
                "",
                "// Top-level registration call outside any function/class",
                "registerSecurityHook('TOP_LEVEL_CALL_MARKER');",
                "",
                "/**",
                " * Validates that target stays inside rootDir.",
                " */",
                "export function safePath(rootDir: string, target: string): string {",
                "    return path.resolve(rootDir, target);",
                "}",
            ].join("\n"),
            "utf-8",
        );

        engine = new NrekiEngine({
            dbPath: path.join(tmpDir, ".nreki.db"),
            watchPaths: [tmpDir],
        });
        await engine.initialize();
        await engine.indexDirectory(tmpDir);

        parser = new ASTParser();
        await parser.initialize();
    });

    afterAll(() => {
        engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("fast_grep finds imports, file headers, and top-level calls outside functions", async () => {
        const deps = { engine } as unknown as RouterDependencies;

        const impRes = await handleFastGrep({ action: "fast_grep", query: "TOP_LEVEL_IMPORT_MARKER" }, deps);
        expect(impRes.content[0].text).toContain("path-jail.ts");
        expect(impRes.content[0].text).toContain("L7");

        const callRes = await handleFastGrep({ action: "fast_grep", query: "TOP_LEVEL_CALL_MARKER" }, deps);
        expect(callRes.content[0].text).toContain("path-jail.ts");
        expect(callRes.content[0].text).toContain("L10");
    });

    it("BM25 search finds file by conceptual query matching header/JSDoc and stems inflected words", async () => {
        const deps = { engine } as unknown as RouterDependencies;
        const res = await handleSearch(
            { action: "search", query: "what prevents a file path from escaping the project directory" },
            deps,
        );
        const text = res.content[0].text;
        expect(text).toContain("path-jail.ts");
        expect(text).toContain("safePath");
    });

    it("repoMapToText includes 1-line file purpose extracted from header comment", async () => {
        const map = await generateRepoMap(tmpDir, parser);
        expect(repoMapToText(map, "full", 0)).toContain("Path traversal protection for NREKI.");
        // skeleton stays CORE/BRIDGE-only: a leaf is counted, not listed
        const skeleton = repoMapToText(map, "skeleton", 0);
        expect(skeleton).not.toContain("Path traversal protection for NREKI.");
        expect(skeleton).toContain("[1 peripheral files]");
    });
});

