/**
 * scripts/eval-phase5/task-worker-body.ts
 *
 * Phase 5 C.4.B.2 Sprint 4.9 (Furia round 28): worker-thread isolation
 * per task. Shared body executed either inline (vitest, useWorker=false)
 * or inside a Node Worker (production, useWorker=true).
 *
 * Side-effect goal: every `executeTaskBody` invocation is self-contained.
 * When called inside a Worker, terminating the worker disposes the WASM
 * linear memory of tree-sitter / sql.js / tiktoken so the parent process
 * RSS stays flat across the 100-task PolyBench run.
 *
 * The body itself does NOT spawn the worker -- that lives in
 * orchestrate.ts. It also does NOT cleanup the task workspace -- the
 * caller (main thread orchestrator) owns rm-rf after the worker exits
 * so we never race the worker's own filesystem handles.
 */

import { computeGroundTruth } from "./ground-truth.js";
import { cloneTaskRepo } from "./repo-cloner.js";
import {
    computeFirstHitRecall,
    computeStrictChunkContainment,
} from "./metrics.js";
import { runVoyage } from "./runners/voyage-runner.js";
import { runFastGrep } from "./runners/fast-grep-runner.js";
import { runRipgrep } from "./runners/ripgrep-runner.js";
import { runBM25 } from "./runners/bm25-runner.js";
import { runAider } from "./runners/aider-runner.js";
import { runNREKI } from "./runners/nreki-runner.js";
import { runHybrid } from "./runners/hybrid-runner.js";
import type { PolyBenchTask, GroundTruth } from "./types.js";
import type { RetrievalResult, RetrieverName } from "./types-runners.js";

/** Runner identifier surfaced in reports (extends RetrieverName with NREKI ablation cells). */
export type ReportRunnerName =
    | "voyage-3"
    | "fast_grep"
    | "ripgrep"
    | "bm25"
    | "hybrid-rrf"
    | "aider"
    | "nreki-mbf-off"
    | "nreki-mbf-on";

export const ALL_REPORT_RUNNERS: ReportRunnerName[] = [
    "voyage-3", "fast_grep", "ripgrep", "bm25", "hybrid-rrf", "aider",
    "nreki-mbf-off", "nreki-mbf-on",
];

export const DEFAULT_REPORT_RUNNERS: ReportRunnerName[] = [
    "voyage-3", "fast_grep", "ripgrep", "bm25", "aider",
    "nreki-mbf-off", "nreki-mbf-on",
];

export interface PerRunnerMetrics {
    first_hit_recall: number;
    strict_chunk_containment: number;
    token_cost: number;
    latency_ms: number;
}

export interface PerTaskResult {
    instance_id: string;
    repo: string;
    base_commit: string;
    task_category: string;
    ground_truth: GroundTruth;
    runners: Record<string, {
        result: RetrievalResult;
        metrics: PerRunnerMetrics;
    }>;
    /** Task-level error (clone failed etc.) -- runner-level errors live inside `runners`. */
    error?: string;
}

/**
 * Inputs serialised across the worker_threads boundary via structuredClone.
 * Every field is plain data so it survives the postMessage hop.
 */
export interface TaskBodyInput {
    task: PolyBenchTask;
    workspaceRoot: string;
    topK: number;
    voyageKey: string;
    runnersList: ReportRunnerName[];
}

/**
 * Output posted back to the main thread. `taskDir` is the absolute
 * path of the cloned workspace so the main thread can `rm -rf` it
 * post-worker-exit (or skip cleanup when cleanupClones=false).
 * `null` when the clone never succeeded.
 */
export interface TaskBodyOutput {
    result: PerTaskResult;
    taskDir: string | null;
}

function emptyMetrics(): PerRunnerMetrics {
    return { first_hit_recall: 0, strict_chunk_containment: 0, token_cost: 0, latency_ms: 0 };
}

export function computeMetrics(
    result: RetrievalResult,
    task: PolyBenchTask,
    ground_truth: GroundTruth,
    topK: number,
): PerRunnerMetrics {
    if (result.error) return emptyMetrics();
    return {
        first_hit_recall: computeFirstHitRecall(
            result.retrieved_files,
            ground_truth.strict_src,
            topK,
        ),
        strict_chunk_containment: computeStrictChunkContainment(
            result.retrieved_chunks,
            task.modified_nodes,
        ),
        token_cost: result.token_cost.total_tokens,
        latency_ms: result.latency_ms,
    };
}

/** Map a ReportRunnerName back to the canonical RetrieverName for the result. */
export function canonicalRetrieverName(name: ReportRunnerName): RetrieverName {
    if (name === "nreki-mbf-off" || name === "nreki-mbf-on") return "nreki";
    if (name === "hybrid-rrf") return "hybrid-rrf";
    return name as RetrieverName;
}

/**
 * Per-task runner dispatch table. Each entry returns a Promise of a
 * RetrievalResult tagged with its ReportRunnerName. The orchestrator
 * awaits these sequentially with per-runner try/catch so a single
 * failure cannot abort the task (D2 firmed). Aider and Voyage have
 * skip-conditions evaluated here.
 */
export async function invokeRunner(
    name: ReportRunnerName,
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    voyageKey: string | undefined,
): Promise<RetrievalResult> {
    switch (name) {
        case "voyage-3":
            if (!voyageKey) {
                return {
                    instance_id: task.instance_id,
                    retriever: "voyage-3",
                    retrieved_files: [], retrieved_chunks: [],
                    latency_ms: 0,
                    token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    error: "VOYAGE_API_KEY missing in env",
                };
            }
            return runVoyage(task, repoRoot, topK, voyageKey);
        case "fast_grep":
            return runFastGrep(task, repoRoot, topK);
        case "ripgrep":
            return runRipgrep(task, repoRoot, topK);
        case "bm25":
            return runBM25(task, repoRoot, topK);
        case "hybrid-rrf":
            return runHybrid(task, repoRoot, topK);
        case "aider":
            return runAider(task, repoRoot, topK);
        case "nreki-mbf-off":
            return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: false });
        case "nreki-mbf-on":
            return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: true });
    }
}

/**
 * Execute a single PolyBenchTask: clone workspace, compute ground truth,
 * invoke each runner sequentially with per-runner try/catch. Returns
 * the PerTaskResult plus the workspace directory (so the caller can
 * cleanup after this function returns / after the worker exits).
 *
 * Never throws -- task-level failures (clone) become `error` on the
 * result; runner-level failures become `runners[name].result.error`.
 */
export async function executeTaskBody(input: TaskBodyInput): Promise<TaskBodyOutput> {
    const { task, workspaceRoot, topK, voyageKey, runnersList } = input;

    let taskDir = "";
    try {
        taskDir = await cloneTaskRepo(task, workspaceRoot);
    } catch (e) {
        return {
            result: {
                instance_id: task.instance_id,
                repo: task.repo,
                base_commit: task.base_commit,
                task_category: task.task_category,
                ground_truth: computeGroundTruth(task),
                runners: {},
                error: `clone failed: ${(e as Error).message}`,
            },
            taskDir: null,
        };
    }

    const ground_truth = computeGroundTruth(task);
    const taskResult: PerTaskResult = {
        instance_id: task.instance_id,
        repo: task.repo,
        base_commit: task.base_commit,
        task_category: task.task_category,
        ground_truth,
        runners: {},
    };

    for (const name of runnersList) {
        const cellStart = Date.now();
        process.stdout.write(`  - ${name} ... `);
        let result: RetrievalResult;
        try {
            result = await invokeRunner(name, task, taskDir, topK, voyageKey);
        } catch (e) {
            // Runner did not catch internally -- isolate it here so the
            // task can continue with remaining runners (D2 firmed).
            result = {
                instance_id: task.instance_id,
                retriever: canonicalRetrieverName(name),
                retrieved_files: [], retrieved_chunks: [],
                latency_ms: Date.now() - cellStart,
                token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                error: `uncaught: ${(e as Error).message}`,
            };
        }
        const metrics = computeMetrics(result, task, ground_truth, topK);
        taskResult.runners[name] = { result, metrics };
        if (result.error) {
            process.stdout.write(`ERROR (${result.error.slice(0, 60)})\n`);
        } else {
            process.stdout.write(
                `recall=${metrics.first_hit_recall} chunk=${metrics.strict_chunk_containment.toFixed(2)} tok=${metrics.token_cost} lat=${metrics.latency_ms}ms\n`,
            );
        }
    }

    return { result: taskResult, taskDir };
}
