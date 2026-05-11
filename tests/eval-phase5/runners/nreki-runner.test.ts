/**
 * Phase 5 C.3.E.3 NREKI runner tests.
 *
 * Mocks NREKI internals (`tfcCompress` + a stub NrekiEngine) so the
 * suite never touches real SQLite / tree-sitter. The Gate 4 smoke
 * test (gitignored) exercises the real pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../../src/compressor-foveal.js", () => ({
    tfcCompress: vi.fn(),
}));

import {
    runNREKI,
    extractFocus,
    FOCUS_DECL_REGEX,
    NREKI_TOP_MAX_CROSS_FILE,
} from "../../../scripts/eval-phase5/runners/nreki-runner.js";
import { tfcCompress } from "../../../src/compressor-foveal.js";
import type { NrekiEngine } from "../../../src/engine.js";
import type { SearchResult } from "../../../src/engine-types.js";
import type { PolyBenchTask } from "../../../scripts/eval-phase5/types.js";

let REPO_ROOT: string;

function mkTask(problem: string, overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "abc",
        patch: "",
        test_patch: "",
        problem_statement: problem,
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
        ...overrides,
    };
}

function mkSearchResult(relPath: string, body: string, score = 1): SearchResult {
    return {
        path: path.join(REPO_ROOT, relPath),
        shorthand: body.slice(0, 40),
        rawCode: body,
        nodeType: "class_declaration",
        startLine: 1,
        endLine: 10,
        score,
    };
}

/**
 * Write a file inside REPO_ROOT so the runner's fs.readFile succeeds
 * and the tfcCompress mock is actually invoked (instead of the runner
 * falling back to the chunk's rawCode on a missing-file error).
 */
async function seed(relPath: string, content: string): Promise<void> {
    const abs = path.join(REPO_ROOT, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
}

interface StubEngineConfig {
    mbf: boolean;
    hits: SearchResult[];
    searchThrows?: Error;
}

function makeStubEngine(cfg: StubEngineConfig): NrekiEngine {
    const stub = {
        initialize: vi.fn().mockResolvedValue(undefined),
        hasIndexedFiles: vi.fn().mockReturnValue(true),
        indexDirectory: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0, errors: 0 }),
        search: vi.fn(async () => {
            if (cfg.searchThrows) throw cfg.searchThrows;
            return cfg.hits;
        }),
        isMarkovBlanketEnabled: vi.fn().mockReturnValue(cfg.mbf),
        shutdown: vi.fn(),
        // Methods that tfcCompress / other call paths might touch -- not
        // exercised because we mock tfcCompress, but kept so the engine
        // satisfies the type at runtime if any pass-through occurs.
        getParser: vi.fn(),
    } as unknown as NrekiEngine;
    return stub;
}

const tfcMock = tfcCompress as unknown as ReturnType<typeof vi.fn>;

function mockTfcSuccess(compressed = "FOVEAL_PAYLOAD"): void {
    tfcMock.mockResolvedValue({
        kind: "success",
        data: {
            compressed,
            originalSize: 1000,
            compressedSize: compressed.length,
            ratio: 0.5,
            tokensSaved: 100,
            zones: {
                foveas: ["Foo"],
                localParafovea: 1,
                externalParafovea: 0,
                upstream: 0,
                darkMatterLines: 0,
                crossFileUpstream: 0,
                crossFileDownstream: 0,
                crossFileTruncated: 0,
            },
        },
    });
}

beforeEach(async () => {
    tfcMock.mockReset();
    mockTfcSuccess();
    REPO_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "nreki-runner-test-"));
});

afterEach(async () => {
    await fs.rm(REPO_ROOT, { recursive: true, force: true });
});

describe("extractFocus", () => {
    it("captures a class declaration", () => {
        expect(extractFocus("export class Foo { bar() {} }", "src/foo.ts")).toBe("Foo");
    });

    it("captures a plain (unexported) class declaration", () => {
        expect(extractFocus("class Bar {}", "src/bar.ts")).toBe("Bar");
    });

    it("captures a function declaration", () => {
        expect(extractFocus("export function baz() { return 1; }", "src/baz.ts")).toBe("baz");
    });

    it("captures const / let / var declarations", () => {
        expect(extractFocus("export const Alpha = 1;", "src/a.ts")).toBe("Alpha");
        expect(extractFocus("let Beta = 2;", "src/b.ts")).toBe("Beta");
        expect(extractFocus("var Gamma = 3;", "src/g.ts")).toBe("Gamma");
    });

    it("captures async function declarations", () => {
        expect(extractFocus("export async function loadFoo() {}", "src/loader.ts")).toBe("loadFoo");
    });

    it("captures `export default class` form", () => {
        expect(extractFocus("export default class Suggest {}", "src/suggest.ts")).toBe("Suggest");
    });

    it("falls back to basename when no declaration is found", () => {
        expect(extractFocus("// only comments", "src/orphan.ts")).toBe("orphan");
        expect(extractFocus("", "src/empty.tsx")).toBe("empty");
    });

    it("FOCUS_DECL_REGEX is exported (sanity)", () => {
        expect(FOCUS_DECL_REGEX).toBeInstanceOf(RegExp);
    });
});

describe("runNREKI", () => {
    it("happy path: 3 SearchResults -> retrieved_files=3, chunks=3, token_cost>0", async () => {
        await seed("src/SuggestModel.ts", "export class SuggestModel { triggerWith() {} }");
        await seed("src/CompletionModel.ts", "export class CompletionModel {}");
        await seed("src/utils.ts", "export function parseTokens(s: string) { return []; }");
        const engine = makeStubEngine({
            mbf: true,
            hits: [
                mkSearchResult("src/SuggestModel.ts", "export class SuggestModel {}", 0.9),
                mkSearchResult("src/CompletionModel.ts", "export class CompletionModel {}", 0.8),
                mkSearchResult("src/utils.ts", "export function parseTokens() {}", 0.7),
            ],
        });
        const res = await runNREKI(mkTask("SuggestModel.triggerWith"), REPO_ROOT, 3, { engine });
        expect(res.error).toBeUndefined();
        expect(res.retriever).toBe("nreki");
        expect(res.retrieved_files).toHaveLength(3);
        expect(res.retrieved_chunks).toHaveLength(3);
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
    });

    it("anti-tests filter excludes test files post-search", async () => {
        await seed("src/foo.ts", "export function foo() {}");
        await seed("src/bar.ts", "export function bar() {}");
        const engine = makeStubEngine({
            mbf: true,
            hits: [
                mkSearchResult("src/foo.ts", "export function foo() {}"),
                mkSearchResult("tests/foo.test.ts", "describe('foo', () => {})"),
                mkSearchResult("src/bar.ts", "export function bar() {}"),
            ],
        });
        const res = await runNREKI(mkTask("foo"), REPO_ROOT, 5, { engine });
        expect(res.retrieved_files).toContain("src/foo.ts");
        expect(res.retrieved_files).toContain("src/bar.ts");
        expect(res.retrieved_files).not.toContain("tests/foo.test.ts");
    });

    it("dedups retrieved_files when multiple chunks share a file", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        await seed("src/bar.ts", "export class Bar {}");
        const engine = makeStubEngine({
            mbf: true,
            hits: [
                mkSearchResult("src/foo.ts", "export class Foo { a() {} }"),
                mkSearchResult("src/foo.ts", "export class Foo { b() {} }"),
                mkSearchResult("src/foo.ts", "export class Foo { c() {} }"),
                mkSearchResult("src/bar.ts", "export class Bar {}"),
                mkSearchResult("src/bar.ts", "export class Bar { method() {} }"),
            ],
        });
        const res = await runNREKI(mkTask("Foo"), REPO_ROOT, 10, { engine });
        expect(res.retrieved_files).toHaveLength(2);
        expect(res.retrieved_chunks).toHaveLength(5);
    });

    it("respects topK cap on retrieved_chunks", async () => {
        for (let i = 0; i < 10; i++) {
            await seed(`src/f${i}.ts`, `export const x${i} = ${i};`);
        }
        const hits = Array.from({ length: 10 }, (_, i) =>
            mkSearchResult(`src/f${i}.ts`, `export const x${i} = ${i};`),
        );
        const engine = makeStubEngine({ mbf: true, hits });
        const res = await runNREKI(mkTask("anything"), REPO_ROOT, 3, { engine });
        expect(res.retrieved_chunks).toHaveLength(3);
        expect(res.retrieved_files).toHaveLength(3);
    });

    it("enableMarkovBlanket=false -> tfcCompress invoked with maxCrossFile=0", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        const engine = makeStubEngine({
            mbf: false,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine });
        expect(tfcMock).toHaveBeenCalledTimes(1);
        const opts = tfcMock.mock.calls[0][4];
        expect(opts.maxCrossFile).toBe(0);
    });

    it("enableMarkovBlanket=true -> tfcCompress invoked with maxCrossFile=NREKI_TOP_MAX_CROSS_FILE", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine });
        expect(tfcMock).toHaveBeenCalledTimes(1);
        const opts = tfcMock.mock.calls[0][4];
        expect(opts.maxCrossFile).toBe(NREKI_TOP_MAX_CROSS_FILE);
    });

    it("topMaxCrossFile option overrides the default when MBF is on", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine, topMaxCrossFile: 25 });
        expect(tfcMock.mock.calls[0][4].maxCrossFile).toBe(25);
    });

    it("pre-built engine (options.engine) is NOT shut down by the runner", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine });
        expect((engine.shutdown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("tfcCompress returning kind:not_found -> fallback to rawCode (no crash)", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        tfcMock.mockReset();
        tfcMock.mockResolvedValue({ kind: "not_found" });
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        const res = await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine });
        expect(res.error).toBeUndefined();
        // Token cost still positive because we tokenize the raw chunk fallback.
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
    });

    it("tfcCompress returning kind:shield_tripped -> fallback to rawCode", async () => {
        await seed("src/foo.ts", "export class Foo {}");
        tfcMock.mockReset();
        tfcMock.mockResolvedValue({
            kind: "shield_tripped",
            ratio: 0.9,
            originalSize: 100,
            compressedSize: 90,
        });
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/foo.ts", "export class Foo {}")],
        });
        const res = await runNREKI(mkTask("Foo"), REPO_ROOT, 1, { engine });
        expect(res.error).toBeUndefined();
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
    });

    it("engine.search throwing -> RetrievalResult.error populated, no exception bubbled", async () => {
        const engine = makeStubEngine({
            mbf: true,
            hits: [],
            searchThrows: new Error("BM25 explosion"),
        });
        const res = await runNREKI(mkTask("anything"), REPO_ROOT, 3, { engine });
        expect(res.error).toContain("BM25 explosion");
        expect(res.retrieved_files).toEqual([]);
        expect(res.retrieved_chunks).toEqual([]);
        expect(res.token_cost.total_tokens).toBe(0);
    });

    it("empty SearchResult set -> retrieved_files=[] with explanatory error", async () => {
        const engine = makeStubEngine({ mbf: true, hits: [] });
        const res = await runNREKI(mkTask("nothing matches"), REPO_ROOT, 3, { engine });
        expect(res.retrieved_files).toEqual([]);
        expect(res.error).toMatch(/no source chunks|all results were test files/);
    });

    it("all SearchResults are test files -> retrieved_files=[] with explanatory error", async () => {
        const engine = makeStubEngine({
            mbf: true,
            hits: [
                mkSearchResult("tests/a.test.ts", "describe('a', () => {})"),
                mkSearchResult("tests/b.spec.ts", "describe('b', () => {})"),
            ],
        });
        const res = await runNREKI(mkTask("foo"), REPO_ROOT, 3, { engine });
        expect(res.retrieved_files).toEqual([]);
        expect(res.error).toMatch(/no source chunks|all results were test files/);
    });

    it("retrieved_chunks carry workspace-relative forward-slash paths", async () => {
        await seed("src/nested/dir/file.ts", "export const x = 1;");
        const engine = makeStubEngine({
            mbf: true,
            hits: [mkSearchResult("src/nested/dir/file.ts", "export const x = 1;")],
        });
        const res = await runNREKI(mkTask("x"), REPO_ROOT, 1, { engine });
        expect(res.retrieved_chunks[0].file_path).toBe("src/nested/dir/file.ts");
        expect(res.retrieved_chunks[0].file_path).not.toContain("\\");
    });
});
