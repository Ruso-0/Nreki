/**
 * Phase 5 C.3.A voyage-runner tests.
 *
 * Mocks `globalThis.fetch` to avoid hitting the real Voyage API.
 * The Gate 4 smoke test (separate file under data/) exercises the
 * real endpoint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    voyageEmbed,
    cosineSimilarity,
    runVoyage,
    VOYAGE_MODEL,
} from "../../../scripts/eval-phase5/runners/voyage-runner.js";
import type { PolyBenchTask } from "../../../scripts/eval-phase5/types.js";

const DUMMY_KEY = "TEST_KEY_PLACEHOLDER";

function makeOkResponse(embeddings: number[][], totalTokens: number): Response {
    const body = {
        object: "list",
        data: embeddings.map((e, i) => ({ object: "embedding", embedding: e, index: i })),
        model: VOYAGE_MODEL,
        usage: { total_tokens: totalTokens },
    };
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

function makeErrorResponse(status: number, body = ""): Response {
    return new Response(body, { status });
}

function makeUnitVec(dim: number, idx: number): number[] {
    const v = new Array(dim).fill(0);
    v[idx % dim] = 1;
    return v;
}

function mkTask(overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "abc",
        patch: "",
        test_patch: "",
        problem_statement: "the bug appears in the foo handler",
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

describe("Phase 5 C.3.A: voyageEmbed", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("happy path: 3 strings → 3 embeddings, totals returned", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            makeOkResponse([makeUnitVec(4, 0), makeUnitVec(4, 1), makeUnitVec(4, 2)], 42),
        );
        vi.stubGlobal("fetch", fetchMock);

        const promise = voyageEmbed(["a", "b", "c"], "document", DUMMY_KEY);
        await vi.runAllTimersAsync();
        const out = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(out.embeddings).toHaveLength(3);
        expect(out.totalTokens).toBe(42);
    });

    it("splits batches of >128 into separate calls", async () => {
        const inputs = Array(200).fill(0).map((_, i) => `text-${i}`);
        const fetchMock = vi.fn()
            // First batch: 128 embeddings
            .mockResolvedValueOnce(
                makeOkResponse(Array(128).fill(0).map((_, i) => makeUnitVec(4, i)), 1280),
            )
            // Second batch: 72 embeddings
            .mockResolvedValueOnce(
                makeOkResponse(Array(72).fill(0).map((_, i) => makeUnitVec(4, i)), 720),
            );
        vi.stubGlobal("fetch", fetchMock);

        const promise = voyageEmbed(inputs, "document", DUMMY_KEY);
        await vi.runAllTimersAsync();
        const out = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(out.embeddings).toHaveLength(200);
        expect(out.totalTokens).toBe(2000);
    });

    it("throws clear message on 401 (auth fail)", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorResponse(401, "unauthorized")));
        await expect(
            voyageEmbed(["x"], "document", DUMMY_KEY),
        ).rejects.toThrow(/Check VOYAGE_API_KEY/);
    });

    it("backs off and retries on 429, eventually succeeds", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(makeErrorResponse(429))
            .mockResolvedValueOnce(makeErrorResponse(429))
            .mockResolvedValueOnce(makeOkResponse([makeUnitVec(4, 0)], 10));
        vi.stubGlobal("fetch", fetchMock);

        const promise = voyageEmbed(["x"], "document", DUMMY_KEY);
        await vi.runAllTimersAsync();
        const out = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(out.embeddings).toHaveLength(1);
    });

    it("throws after 3 persistent 429 retries", async () => {
        const fetchMock = vi.fn().mockResolvedValue(makeErrorResponse(429));
        vi.stubGlobal("fetch", fetchMock);

        const promise = voyageEmbed(["x"], "document", DUMMY_KEY);
        // Catch the rejection by attaching the handler before advancing timers
        const expectation = expect(promise).rejects.toThrow(/rate-limited after 3 retries/);
        await vi.runAllTimersAsync();
        await expectation;
        // 4 attempts: initial + 3 retries.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});

describe("Phase 5 C.3.A: cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
        expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    });

    it("returns 0 for orthogonal vectors and zero-norm vectors", () => {
        expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
        expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
        expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0);
    });

    it("returns -1 for opposite vectors", () => {
        expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6);
    });

    it("throws on dimension mismatch", () => {
        expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(
            /dimension mismatch: 2 vs 3/,
        );
    });
});

describe("Phase 5 C.3.A: runVoyage", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "voyage-runner-"));
        vi.unstubAllGlobals();
    });
    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
        vi.unstubAllGlobals();
    });

    async function writeFile(rel: string, content: string): Promise<void> {
        const abs = path.join(tmpRoot, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }

    it("end-to-end: walks repo, retrieves top-K files with token_cost", async () => {
        await writeFile("src/a.ts", "export function a() { return 1; }");
        await writeFile("src/b.ts", "export function b() { return 2; }");
        await writeFile("src/c.ts", "export function c() { return 3; }");
        await writeFile("src/d.ts", "export function d() { return 4; }");
        await writeFile("src/e.ts", "export function e() { return 5; }");

        // 1st call: doc embeddings for 5 files (1 chunk each).
        // 2nd call: query embedding (1 vec).
        const docVecs = [
            [1, 0, 0, 0], // a — perfect match to query
            [0, 1, 0, 0],
            [0.9, 0.1, 0, 0], // close-ish to query
            [0, 0, 1, 0],
            [0, 0, 0, 1],
        ];
        const queryVec = [1, 0, 0, 0];
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(makeOkResponse(docVecs, 50))
            .mockResolvedValueOnce(makeOkResponse([queryVec], 10));
        vi.stubGlobal("fetch", fetchMock);

        const result = await runVoyage(mkTask(), tmpRoot, 3, DUMMY_KEY);

        expect(result.retriever).toBe("voyage-3");
        expect(result.error).toBeUndefined();
        expect(result.retrieved_files).toHaveLength(3);
        // Top must be a.ts (perfect match), then c.ts, then anything.
        expect(result.retrieved_files[0]).toBe("src/a.ts");
        expect(result.retrieved_files[1]).toBe("src/c.ts");
        expect(result.token_cost?.total_tokens).toBe(60);
        expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    });

    it("anti-tests filter excludes *.test.ts from retrieved_files", async () => {
        await writeFile("src/foo.ts", "production code");
        await writeFile("tests/foo.test.ts", "test code");
        await writeFile("src/bar.spec.ts", "another test code");
        await writeFile("src/__tests__/baz.ts", "nested test code");
        await writeFile("src/real.ts", "more production code");

        // Only src/foo.ts and src/real.ts should reach Voyage.
        const docVecs = [makeUnitVec(4, 0), makeUnitVec(4, 1)];
        const queryVec = [1, 0, 0, 0];
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(makeOkResponse(docVecs, 20))
            .mockResolvedValueOnce(makeOkResponse([queryVec], 5));
        vi.stubGlobal("fetch", fetchMock);

        const result = await runVoyage(mkTask(), tmpRoot, 10, DUMMY_KEY);

        expect(result.error).toBeUndefined();
        expect(result.retrieved_files.sort()).toEqual(["src/foo.ts", "src/real.ts"]);
        expect(result.retrieved_files).not.toContain("tests/foo.test.ts");
        expect(result.retrieved_files).not.toContain("src/bar.spec.ts");
        expect(result.retrieved_files).not.toContain("src/__tests__/baz.ts");
    });

    it("returns error + retrieved_files=[] on mid-task API failure", async () => {
        await writeFile("src/a.ts", "code");
        await writeFile("src/b.ts", "code");
        // First (doc embed) call fails with 500 + retry also fails.
        const fetchMock = vi.fn()
            .mockResolvedValue(makeErrorResponse(500, "internal error"));
        vi.stubGlobal("fetch", fetchMock);

        const result = await runVoyage(mkTask(), tmpRoot, 10, DUMMY_KEY);

        expect(result.retrieved_files).toEqual([]);
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/Voyage API/);
        expect(result.retriever).toBe("voyage-3");
    });
});
