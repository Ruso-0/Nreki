/**
 * Phase 5 C.4.A orchestrator tests.
 *
 * Mocks repo-cloner and every runner so the suite never touches
 * the network, git, NREKI internals, or tiktoken's BPE binary.
 * The Gate 4 dry-run (3 real PolyBench tasks) exercises the
 * unmocked path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../scripts/eval-phase5/repo-cloner.js", () => ({
    cloneTaskRepo: vi.fn(async (task, workspaceRoot) => {
        const dir = path.join(workspaceRoot, `task-${task.repo.replace("/", "-")}-pr${task.pr_number}`);
        await fs.mkdir(dir, { recursive: true });
        return dir;
    }),
    installTaskDeps: vi.fn(),
}));

vi.mock("../../scripts/eval-phase5/runners/voyage-runner.js", () => ({
    runVoyage: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/runners/fast-grep-runner.js", () => ({
    runFastGrep: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/runners/ripgrep-runner.js", () => ({
    runRipgrep: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/runners/bm25-runner.js", () => ({
    runBM25: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/runners/aider-runner.js", () => ({
    runAider: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/runners/nreki-runner.js", () => ({
    runNREKI: vi.fn(),
}));
vi.mock("../../scripts/eval-phase5/polybench-loader.js", () => ({
    loadPolyBenchVerified: vi.fn(),
    DEFAULT_CSV_PATH: "MOCKED",
}));

import { orchestrate } from "../../scripts/eval-phase5/orchestrate.js";
import type { PolyBenchTask } from "../../scripts/eval-phase5/types.js";
import type { RetrievalResult } from "../../scripts/eval-phase5/types-runners.js";
import { runVoyage } from "../../scripts/eval-phase5/runners/voyage-runner.js";
import { runFastGrep } from "../../scripts/eval-phase5/runners/fast-grep-runner.js";
import { runRipgrep } from "../../scripts/eval-phase5/runners/ripgrep-runner.js";
import { runBM25 } from "../../scripts/eval-phase5/runners/bm25-runner.js";
import { runAider } from "../../scripts/eval-phase5/runners/aider-runner.js";
import { runNREKI } from "../../scripts/eval-phase5/runners/nreki-runner.js";
import { loadPolyBenchVerified } from "../../scripts/eval-phase5/polybench-loader.js";
import { cloneTaskRepo } from "../../scripts/eval-phase5/repo-cloner.js";

const m = <T>(fn: T): ReturnType<typeof vi.fn> => fn as unknown as ReturnType<typeof vi.fn>;

function fakeTask(id: string, repo = "owner/repo"): PolyBenchTask {
    const patch = "diff --git a/src/a.ts b/src/a.ts\n@@\n-x\n+y\n";
    return {
        repo,
        pr_number: 1,
        instance_id: id,
        base_commit: "0".repeat(40),
        patch,
        test_patch: "",
        problem_statement: "fix x in src/a.ts",
        modified_nodes: [{
            raw_path: "src/a.ts->program->class:A",
            file_path: "src/a.ts",
            ast_path: ["program"],
            terminal_kind: "class",
            terminal_name: "A",
        }],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
    };
}

function fakeResult(retriever: RetrievalResult["retriever"], hit = true, tok = 100, lat = 50): RetrievalResult {
    return {
        instance_id: "x",
        retriever,
        retrieved_files: hit ? ["src/a.ts"] : ["src/other.ts"],
        retrieved_chunks: hit ? [{ file_path: "src/a.ts", start_line: 1, end_line: 100 }] : [],
        latency_ms: lat,
        token_cost: { input_tokens: tok, output_tokens: 0, total_tokens: tok },
    };
}

let WORKSPACE: string;
let OUTPUT: string;

beforeEach(async () => {
    WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "orch-test-"));
    OUTPUT = path.join(WORKSPACE, "results.json");

    m(loadPolyBenchVerified).mockReset();
    m(cloneTaskRepo).mockClear();
    m(runVoyage).mockReset();
    m(runFastGrep).mockReset();
    m(runRipgrep).mockReset();
    m(runBM25).mockReset();
    m(runAider).mockReset();
    m(runNREKI).mockReset();

    m(runVoyage).mockResolvedValue(fakeResult("voyage-3", true, 200, 80));
    m(runFastGrep).mockResolvedValue(fakeResult("fast_grep", true, 90, 100));
    m(runRipgrep).mockResolvedValue(fakeResult("ripgrep", true, 95, 120));
    m(runBM25).mockResolvedValue(fakeResult("bm25", true, 180, 10));
    m(runAider).mockResolvedValue(fakeResult("aider", true, 220, 8000));
    // NREKI: MBF=off cheaper, MBF=on richer. Two mocks distinguishable by call order.
    m(runNREKI)
        .mockResolvedValueOnce(fakeResult("nreki", true, 30, 200))   // off
        .mockResolvedValueOnce(fakeResult("nreki", true, 50, 300));  // on
});

afterEach(async () => {
    process.env.VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "test-key";
    await fs.rm(WORKSPACE, { recursive: true, force: true });
});

describe("orchestrate", () => {
    it("happy path: 1 task * 7 runners produces per-task + aggregate report", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);

        const report = await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1"],
            topK: 10,
        });

        expect(report.total_tasks_attempted).toBe(1);
        expect(report.total_tasks_completed).toBe(1);
        expect(Object.keys(report.per_runner).sort()).toEqual([
            "aider", "bm25", "fast_grep", "nreki-mbf-off", "nreki-mbf-on", "ripgrep", "voyage-3",
        ]);
        expect(report.per_runner["voyage-3"].first_hit_recall_mean).toBe(1);
        // Aggregate latency p50 of a single-task run is just that latency.
        expect(report.per_runner["voyage-3"].latency_ms_p50).toBe(80);
        // The JSON was written.
        const written = JSON.parse(await fs.readFile(OUTPUT, "utf-8"));
        expect(written.total_tasks_completed).toBe(1);
    });

    it("per-runner error isolation: 1 runner throwing does NOT abort the task", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);
        m(runAider).mockRejectedValue(new Error("aider went boom"));

        const report = await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1"],
            topK: 10,
        });

        const t = report.per_task[0];
        expect(t.runners["aider"].result.error).toMatch(/aider went boom/);
        // Other 6 runners still completed.
        for (const n of ["voyage-3", "fast_grep", "ripgrep", "bm25", "nreki-mbf-off", "nreki-mbf-on"]) {
            expect(t.runners[n].result.error).toBeUndefined();
        }
        expect(report.per_runner["aider"].error_rate).toBe(1);
        expect(report.per_runner["bm25"].error_rate).toBe(0);
    });

    it("Voyage skipped with clear error when VOYAGE_API_KEY is missing", async () => {
        const original = process.env.VOYAGE_API_KEY;
        delete process.env.VOYAGE_API_KEY;
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);

        const report = await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1"],
        });
        expect(report.per_task[0].runners["voyage-3"].result.error).toMatch(/VOYAGE_API_KEY missing/);

        if (original) process.env.VOYAGE_API_KEY = original;
    });

    it("disk-check abort: throws when free disk < minDiskGB", async () => {
        // 10 PB minimum -- impossible to satisfy
        await expect(
            orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                taskIds: ["t1"],
                minDiskGB: 1e10,
            }),
        ).rejects.toThrow(/free disk/i);
    });

    it("cleanupClones=true removes the task directory after completion", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);

        await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1"],
            cleanupClones: true,
        });
        const cloneDir = path.join(WORKSPACE, "task-owner-repo-pr1");
        await expect(fs.stat(cloneDir)).rejects.toThrow(/ENOENT/);
    });

    it("cleanupClones=false leaves the task directory intact", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);

        await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1"],
            cleanupClones: false,
        });
        const cloneDir = path.join(WORKSPACE, "task-owner-repo-pr1");
        const s = await fs.stat(cloneDir);
        expect(s.isDirectory()).toBe(true);
    });

    it("aggregation: mean / p50 / p95 / p99 across multiple tasks", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([
            fakeTask("t1"), fakeTask("t2"), fakeTask("t3"),
        ]);
        // Make voyage latencies a known sample: 10, 20, 30 -> p50=20, p95=29, mean=20.
        m(runVoyage)
            .mockResolvedValueOnce(fakeResult("voyage-3", true, 100, 10))
            .mockResolvedValueOnce(fakeResult("voyage-3", true, 100, 20))
            .mockResolvedValueOnce(fakeResult("voyage-3", true, 100, 30));
        // Re-seed NREKI for 3 tasks * 2 cells = 6 calls.
        m(runNREKI).mockReset();
        for (let i = 0; i < 6; i++) {
            m(runNREKI).mockResolvedValueOnce(fakeResult("nreki", true, 50, 100 + i));
        }

        const report = await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1", "t2", "t3"],
        });

        const v = report.per_runner["voyage-3"];
        expect(v.latency_ms_p50).toBe(20);
        expect(v.token_cost_mean).toBe(100);
        expect(v.completed_tasks).toBe(3);
    });

    it("clone failure for a task records task-level error but other tasks proceed", async () => {
        process.env.VOYAGE_API_KEY = "test-key";
        m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1"), fakeTask("t2")]);
        m(cloneTaskRepo)
            .mockRejectedValueOnce(new Error("Time-Travel guard failed"))
            .mockImplementationOnce(async (task, ws) => {
                const dir = path.join(ws, `task-${task.repo.replace("/", "-")}-pr${task.pr_number}-2`);
                await fs.mkdir(dir, { recursive: true });
                return dir;
            });
        // Re-seed NREKI for the surviving task.
        m(runNREKI).mockReset();
        m(runNREKI)
            .mockResolvedValueOnce(fakeResult("nreki", true, 30, 200))
            .mockResolvedValueOnce(fakeResult("nreki", true, 50, 300));

        const report = await orchestrate({
            workspaceRoot: WORKSPACE,
            outputPath: OUTPUT,
            taskIds: ["t1", "t2"],
        });

        expect(report.per_task[0].error).toMatch(/clone failed/);
        expect(report.per_task[1].error).toBeUndefined();
        expect(report.total_tasks_attempted).toBe(2);
        expect(report.total_tasks_completed).toBe(1);
    });

    // Phase 5 C.4.B.0c -- Furia round 24 P0: incremental state + resume.
    describe("JSONL incremental state + resume (C.4.B.0c)", () => {
        it("outputJsonlPath: appends one line per task as the loop progresses", async () => {
            process.env.VOYAGE_API_KEY = "test-key";
            m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1"), fakeTask("t2")]);
            // Re-seed NREKI for 2 tasks * 2 cells.
            m(runNREKI).mockReset();
            for (let i = 0; i < 4; i++) {
                m(runNREKI).mockResolvedValueOnce(fakeResult("nreki", true, 40, 100 + i));
            }
            const jsonlPath = path.join(WORKSPACE, "results.jsonl");
            await orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                outputJsonlPath: jsonlPath,
                taskIds: ["t1", "t2"],
            });

            const content = await fs.readFile(jsonlPath, "utf-8");
            const lines = content.trim().split("\n");
            expect(lines).toHaveLength(2);
            const parsed = lines.map(l => JSON.parse(l));
            expect(parsed[0].instance_id).toBe("t1");
            expect(parsed[1].instance_id).toBe("t2");
            // Per-task PerTaskResult shape preserved (runners populated).
            expect(Object.keys(parsed[0].runners).length).toBeGreaterThan(0);
        });

        it("resume: pre-existing JSONL line for t1 -> only t2 is executed", async () => {
            process.env.VOYAGE_API_KEY = "test-key";
            m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1"), fakeTask("t2")]);
            // Pre-seed JSONL with a completed t1.
            const jsonlPath = path.join(WORKSPACE, "results.jsonl");
            const preCompleted = {
                instance_id: "t1",
                repo: "owner/repo",
                base_commit: "0".repeat(40),
                task_category: "Bug Fix",
                ground_truth: { strict_src: ["src/a.ts"], modified_nodes: [] },
                runners: {
                    "voyage-3": {
                        result: fakeResult("voyage-3", true, 200, 80),
                        metrics: { first_hit_recall: 1, strict_chunk_containment: 1, token_cost: 200, latency_ms: 80 },
                    },
                },
            };
            await fs.writeFile(jsonlPath, JSON.stringify(preCompleted) + "\n", "utf-8");

            // Re-seed NREKI for just t2 (2 cells).
            m(runNREKI).mockReset();
            m(runNREKI)
                .mockResolvedValueOnce(fakeResult("nreki", true, 30, 200))
                .mockResolvedValueOnce(fakeResult("nreki", true, 50, 300));

            const report = await orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                outputJsonlPath: jsonlPath,
                taskIds: ["t1", "t2"],
            });

            // t1 came from JSONL (not re-cloned, not re-runner-invoked).
            expect(m(cloneTaskRepo)).toHaveBeenCalledTimes(1);
            expect(m(cloneTaskRepo).mock.calls[0][0].instance_id).toBe("t2");
            expect(m(runVoyage)).toHaveBeenCalledTimes(1);
            // Aggregate spans both tasks.
            expect(report.total_tasks_attempted).toBe(2);
            const ids = report.per_task.map(t => t.instance_id).sort();
            expect(ids).toEqual(["t1", "t2"]);
        });

        it("resume=false: even with existing JSONL, all tasks re-execute", async () => {
            process.env.VOYAGE_API_KEY = "test-key";
            m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);
            const jsonlPath = path.join(WORKSPACE, "results.jsonl");
            // Pre-seed with t1 -- but resume:false should ignore it.
            await fs.writeFile(
                jsonlPath,
                JSON.stringify({ instance_id: "t1", repo: "owner/repo", runners: {} }) + "\n",
                "utf-8",
            );
            await orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                outputJsonlPath: jsonlPath,
                resume: false,
                taskIds: ["t1"],
            });
            // t1 cloned despite pre-existing JSONL row.
            expect(m(cloneTaskRepo)).toHaveBeenCalledTimes(1);
            expect(m(cloneTaskRepo).mock.calls[0][0].instance_id).toBe("t1");
        });

        it("clone failure also appends a state line (so resume skips it next run)", async () => {
            process.env.VOYAGE_API_KEY = "test-key";
            m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);
            m(cloneTaskRepo).mockRejectedValueOnce(new Error("Time-Travel guard"));
            const jsonlPath = path.join(WORKSPACE, "results.jsonl");
            await orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                outputJsonlPath: jsonlPath,
                taskIds: ["t1"],
            });
            const content = await fs.readFile(jsonlPath, "utf-8");
            const parsed = JSON.parse(content.trim());
            expect(parsed.instance_id).toBe("t1");
            expect(parsed.error).toMatch(/clone failed/);
        });

        it("malformed JSONL line: warned, skipped, run proceeds", async () => {
            process.env.VOYAGE_API_KEY = "test-key";
            m(loadPolyBenchVerified).mockResolvedValue([fakeTask("t1")]);
            const jsonlPath = path.join(WORKSPACE, "results.jsonl");
            // First line is garbage; we expect the run to proceed and t1 to execute.
            await fs.writeFile(jsonlPath, "{ NOT JSON ;;;\n", "utf-8");
            await orchestrate({
                workspaceRoot: WORKSPACE,
                outputPath: OUTPUT,
                outputJsonlPath: jsonlPath,
                taskIds: ["t1"],
            });
            expect(m(cloneTaskRepo)).toHaveBeenCalledTimes(1);
        });
    });
});
