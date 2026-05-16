import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    rrfFuseFiles,
    runHybrid,
} from "../scripts/eval-phase5/runners/hybrid-runner.js";
import type { PolyBenchTask } from "../scripts/eval-phase5/types.js";
import type { ChunkResult, RetrievalResult } from "../scripts/eval-phase5/types-runners.js";

function mkTask(): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "0".repeat(40),
        patch: "",
        test_patch: "",
        problem_statement: "query",
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
    };
}

function mkResult(files: string[], chunks: ChunkResult[]): RetrievalResult {
    return {
        instance_id: "owner__repo-1",
        retriever: "nreki",
        retrieved_files: files,
        retrieved_chunks: chunks,
        latency_ms: 1,
        token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }
}

describe("hybrid late-fusion runner", () => {
    let tmpDir: string | undefined;

    afterEach(async () => {
        if (tmpDir) {
            await fs.rm(tmpDir, { recursive: true, force: true });
            tmpDir = undefined;
        }
    });

    it("RRF formula correctly fuses ranked file lists", () => {
        expect(rrfFuseFiles(["a.ts", "b.ts"], ["c.ts", "d.ts"], 2))
            .toEqual(["a.ts", "c.ts"]);
    });

    it("files in both retrievers get cumulative RRF score", () => {
        expect(rrfFuseFiles(["n-only.ts", "shared.ts"], ["shared.ts", "b-only.ts"], 3))
            .toEqual(["shared.ts", "n-only.ts", "b-only.ts"]);
    });

    it("tied RRF scores break ties lexicographically by file path", () => {
        expect(rrfFuseFiles(["zeta.ts"], ["alpha.ts"], 2))
            .toEqual(["alpha.ts", "zeta.ts"]);
    });

    it("NREKI-only file uses NREKI chunks for token cost", async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-runner-"));
        await writeFiles(tmpDir, {
            "a.ts": "export const a = 1;\nexport const keep = a;",
            "b.ts": "export const b = 2;",
        });

        const res = await runHybrid(mkTask(), tmpDir, 1, {
            nrekiRunner: async () => mkResult(["a.ts"], [{ file_path: "a.ts", start_line: 1, end_line: 1 }]),
            bm25Runner: async () => mkResult(["b.ts"], [{ file_path: "b.ts", start_line: 1, end_line: 1 }]),
        });

        expect(res.retrieved_files).toEqual(["a.ts"]);
        expect(res.retrieved_chunks).toEqual([{ file_path: "a.ts", start_line: 1, end_line: 1 }]);
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
    });

    it("BM25-only file falls back to BM25 chunks", async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-runner-"));
        await writeFiles(tmpDir, {
            "b.ts": "export const bm25 = 42;",
        });

        const res = await runHybrid(mkTask(), tmpDir, 1, {
            nrekiRunner: async () => mkResult([], []),
            bm25Runner: async () => mkResult(["b.ts"], [{ file_path: "b.ts", start_line: 1, end_line: 1 }]),
        });

        expect(res.retrieved_files).toEqual(["b.ts"]);
        expect(res.retrieved_chunks).toEqual([{ file_path: "b.ts", start_line: 1, end_line: 1 }]);
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
    });

    it("top-K truncation works correctly", () => {
        expect(rrfFuseFiles(["a.ts", "b.ts", "c.ts"], ["d.ts", "e.ts", "f.ts"], 3))
            .toHaveLength(3);
    });

    it("empty NREKI result -> returns BM25 ranking", async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-runner-"));
        await writeFiles(tmpDir, {
            "a.ts": "export const a = 1;",
            "b.ts": "export const b = 2;",
        });

        const res = await runHybrid(mkTask(), tmpDir, 2, {
            nrekiRunner: async () => mkResult([], []),
            bm25Runner: async () => mkResult(
                ["a.ts", "b.ts"],
                [
                    { file_path: "a.ts", start_line: 1, end_line: 1 },
                    { file_path: "b.ts", start_line: 1, end_line: 1 },
                ],
            ),
        });

        expect(res.retrieved_files).toEqual(["a.ts", "b.ts"]);
    });

    it("empty BM25 result -> returns NREKI ranking", async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-runner-"));
        await writeFiles(tmpDir, {
            "a.ts": "export const a = 1;",
            "b.ts": "export const b = 2;",
        });

        const res = await runHybrid(mkTask(), tmpDir, 2, {
            nrekiRunner: async () => mkResult(
                ["a.ts", "b.ts"],
                [
                    { file_path: "a.ts", start_line: 1, end_line: 1 },
                    { file_path: "b.ts", start_line: 1, end_line: 1 },
                ],
            ),
            bm25Runner: async () => mkResult([], []),
        });

        expect(res.retrieved_files).toEqual(["a.ts", "b.ts"]);
    });

    it("both empty -> returns empty array", async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-runner-"));
        const res = await runHybrid(mkTask(), tmpDir, 10, {
            nrekiRunner: async () => mkResult([], []),
            bm25Runner: async () => mkResult([], []),
        });

        expect(res.retrieved_files).toEqual([]);
        expect(res.retrieved_chunks).toEqual([]);
        expect(res.token_cost.total_tokens).toBe(0);
    });
});
