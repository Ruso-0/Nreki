/**
 * scripts/eval-phase5/orchestrate.ts
 *
 * Phase 5 C.4.A batch evaluator. Drives PolyBench tasks through
 * the 6 baseline retrievers plus NREKI Markov-Blanket ablation on
 * the same HEAD (Furia round 19 P1).
 *
 * Pipeline per task:
 *   1. cloneTaskRepo + Time-Travel checkout (base_commit)
 *   2. computeGroundTruth(task) -> strict_src files + modified_nodes
 *   3. 7 sequential runner invocations (5 baselines + NREKI x2)
 *      Per-runner try/catch (Furia round 19 P1 isolation extended:
 *      one runner failure does NOT abort other runners on the same
 *      task)
 *   4. Metrics per runner via metrics.ts
 *   5. Cleanup clone if cleanupClones=true (default true)
 *   6. Sleep taskDelayMs (default 0 dry-run, 200 recommended C.4.B)
 *
 * Pre-flight:
 *   - Disk free >= minDiskGB on the workspaceRoot drive (default 5)
 *   - VOYAGE_API_KEY present (or voyage runner skipped)
 *   - .venv-aider/Scripts/aider.exe or AIDER_BINARY env present
 *     (or aider runner skipped)
 *
 * CLI form:
 *   npx tsx scripts/eval-phase5/orchestrate.ts \
 *     [--dry-run] \
 *     [--task-ids id1,id2,id3] \
 *     [--top-k 10] \
 *     [--workspace .eval-phase5-cache] \
 *     [--output results.json] \
 *     [--task-delay-ms 0] \
 *     [--no-cleanup] \
 *     [--csv scripts/eval-phase5/data/polybench-verified.csv]
 */

import * as fs from "node:fs/promises";
import { statfsSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./polybench-loader.js";
import { computeGroundTruth } from "./ground-truth.js";
import { cloneTaskRepo } from "./repo-cloner.js";
import type { PolyBenchTask, GroundTruth } from "./types.js";
import type { RetrievalResult, RetrieverName } from "./types-runners.js";
import { runVoyage } from "./runners/voyage-runner.js";
import { runFastGrep } from "./runners/fast-grep-runner.js";
import { runRipgrep } from "./runners/ripgrep-runner.js";
import { runBM25 } from "./runners/bm25-runner.js";
import { runAider } from "./runners/aider-runner.js";
import { runNREKI } from "./runners/nreki-runner.js";
import {
    computeFirstHitRecall,
    computeStrictChunkContainment,
    percentile,
    mean,
} from "./metrics.js";
import { printConsoleSummary, writeJsonReport } from "./report.js";

/** Runner identifier surfaced in reports (extends RetrieverName with NREKI ablation cells). */
export type ReportRunnerName =
    | "voyage-3"
    | "fast_grep"
    | "ripgrep"
    | "bm25"
    | "aider"
    | "nreki-mbf-off"
    | "nreki-mbf-on";

export const ALL_REPORT_RUNNERS: ReportRunnerName[] = [
    "voyage-3", "fast_grep", "ripgrep", "bm25", "aider",
    "nreki-mbf-off", "nreki-mbf-on",
];

export interface OrchestrateOptions {
    csvPath?: string;
    /** Specific PolyBench instance_ids; if empty, run all 100. */
    taskIds?: string[];
    /** Top-K cap passed to every runner. Default 10. */
    topK?: number;
    /** Parent directory for cloned task workspaces. */
    workspaceRoot: string;
    /** JSON output path. */
    outputPath: string;
    /** Which runners to invoke; default = ALL_REPORT_RUNNERS. */
    runners?: ReportRunnerName[];
    /** rm-rf the task clone after each task completes. Default true. */
    cleanupClones?: boolean;
    /** Sleep between tasks (Voyage rate limit cushion). Default 0. */
    taskDelayMs?: number;
    /** Abort orchestration if free disk on workspaceRoot drive < minDiskGB. Default 5. */
    minDiskGB?: number;
}

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

export interface PerRunnerAggregate {
    first_hit_recall_mean: number;
    strict_chunk_containment_mean: number;
    token_cost_mean: number;
    token_cost_p50: number;
    token_cost_p95: number;
    latency_ms_p50: number;
    latency_ms_p95: number;
    latency_ms_p99: number;
    error_rate: number;
    completed_tasks: number;
}

export interface AggregateReport {
    timestamp_utc: string;
    options: OrchestrateOptions;
    total_tasks_attempted: number;
    total_tasks_completed: number;
    per_runner: Record<string, PerRunnerAggregate>;
    per_task: PerTaskResult[];
}

/**
 * On Windows dev hosts where `rg` lives only as a bash function (the
 * Claude Code harness wrapper) and not as a PATH-resolvable binary,
 * seed RG_BINARY from a few well-known bundled locations so the
 * ripgrep child_process.spawn finds the .exe. No-op on non-Windows
 * or when RG_BINARY is already set. Lifted verbatim from the
 * C.3.B-E smoke tests so the orchestrator's runtime env matches.
 */
function maybeSeedRgBinary(): void {
    if (process.env.RG_BINARY) return;
    if (os.platform() !== "win32") return;
    const home = os.homedir();
    const candidates = [
        path.join(home, "AppData", "Local", "Programs", "Antigravity",
            "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
        path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code",
            "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
        path.join("C:\\", "Program Files", "Microsoft VS Code",
            "resources", "app", "node_modules", "@vscode", "ripgrep", "bin", "rg.exe"),
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            process.env.RG_BINARY = c;
            return;
        }
    }
}

/**
 * If the default Aider venv exists, seed AIDER_BINARY to its absolute
 * path so the runner does not have to bake the relative path into
 * its default. No-op if AIDER_BINARY is already set or the venv is
 * missing (the runner then surfaces a clear binary-not-found error
 * per task).
 */
function maybeSeedAiderBinary(): void {
    if (process.env.AIDER_BINARY) return;
    const candidate = path.resolve(".venv-aider", "Scripts", "aider.exe");
    if (existsSync(candidate)) process.env.AIDER_BINARY = candidate;
}

function freeDiskBytes(p: string): number {
    try {
        const s = statfsSync(p);
        return s.bavail * s.bsize;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

async function preflightDisk(workspaceRoot: string, minDiskGB: number): Promise<void> {
    await fs.mkdir(workspaceRoot, { recursive: true });
    const free = freeDiskBytes(workspaceRoot);
    if (!Number.isFinite(free)) return; // statfs unsupported -- skip check
    const freeGB = free / 1024 / 1024 / 1024;
    if (freeGB < minDiskGB) {
        throw new Error(
            `Pre-flight: free disk ${freeGB.toFixed(2)} GB on ${workspaceRoot} < required ${minDiskGB} GB`,
        );
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function emptyMetrics(): PerRunnerMetrics {
    return { first_hit_recall: 0, strict_chunk_containment: 0, token_cost: 0, latency_ms: 0 };
}

function computeMetrics(
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

/**
 * Per-task runner dispatch table. Each entry returns a Promise of a
 * RetrievalResult tagged with its ReportRunnerName. The orchestrator
 * awaits these sequentially with per-runner try/catch so a single
 * failure cannot abort the task (D2 firmed).
 *
 * Aider and Voyage have skip-conditions evaluated in the caller.
 */
async function invokeRunner(
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
        case "aider":
            return runAider(task, repoRoot, topK);
        case "nreki-mbf-off":
            return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: false });
        case "nreki-mbf-on":
            return runNREKI(task, repoRoot, topK, { enableMarkovBlanket: true });
    }
}

/** Map a ReportRunnerName back to the canonical RetrieverName for the result. */
function canonicalRetrieverName(name: ReportRunnerName): RetrieverName {
    if (name === "nreki-mbf-off" || name === "nreki-mbf-on") return "nreki";
    return name as RetrieverName;
}

export async function orchestrate(options: OrchestrateOptions): Promise<AggregateReport> {
    const topK = options.topK ?? 10;
    const csvPath = options.csvPath ?? DEFAULT_CSV_PATH;
    const cleanupClones = options.cleanupClones ?? true;
    const taskDelayMs = options.taskDelayMs ?? 0;
    const minDiskGB = options.minDiskGB ?? 5;
    const runnersList = options.runners ?? ALL_REPORT_RUNNERS;

    await preflightDisk(options.workspaceRoot, minDiskGB);
    maybeSeedRgBinary();
    maybeSeedAiderBinary();

    const allTasks = await loadPolyBenchVerified(csvPath);
    const taskFilter = new Set(options.taskIds ?? []);
    const tasks = taskFilter.size > 0
        ? allTasks.filter(t => taskFilter.has(t.instance_id))
        : allTasks;

    if (tasks.length === 0) {
        throw new Error(
            `No tasks matched filter [${[...taskFilter].join(", ")}] from ${allTasks.length} total`,
        );
    }

    const voyageKey = process.env.VOYAGE_API_KEY || "";
    const perTask: PerTaskResult[] = [];

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        process.stdout.write(
            `\n[${i + 1}/${tasks.length}] ${task.instance_id} (${task.repo})\n`,
        );

        let taskDir = "";
        try {
            taskDir = await cloneTaskRepo(task, options.workspaceRoot);
        } catch (e) {
            perTask.push({
                instance_id: task.instance_id,
                repo: task.repo,
                base_commit: task.base_commit,
                task_category: task.task_category,
                ground_truth: computeGroundTruth(task),
                runners: {},
                error: `clone failed: ${(e as Error).message}`,
            });
            if (taskDelayMs > 0) await sleep(taskDelayMs);
            continue;
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

        perTask.push(taskResult);

        if (cleanupClones) {
            try {
                await fs.rm(taskDir, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
        }
        if (taskDelayMs > 0 && i < tasks.length - 1) await sleep(taskDelayMs);
    }

    // Aggregate per-runner.
    const per_runner: Record<string, PerRunnerAggregate> = {};
    for (const name of runnersList) {
        const cells = perTask
            .map(t => t.runners[name])
            .filter((c): c is NonNullable<typeof c> => c !== undefined);
        const okCells = cells.filter(c => !c.result.error);

        const recalls = okCells.map(c => c.metrics.first_hit_recall);
        const chunks = okCells.map(c => c.metrics.strict_chunk_containment);
        const tokens = okCells.map(c => c.metrics.token_cost);
        const latencies = okCells.map(c => c.metrics.latency_ms);

        per_runner[name] = {
            first_hit_recall_mean: mean(recalls),
            strict_chunk_containment_mean: mean(chunks),
            token_cost_mean: mean(tokens),
            token_cost_p50: percentile(tokens, 50),
            token_cost_p95: percentile(tokens, 95),
            latency_ms_p50: percentile(latencies, 50),
            latency_ms_p95: percentile(latencies, 95),
            latency_ms_p99: percentile(latencies, 99),
            error_rate: cells.length > 0 ? (cells.length - okCells.length) / cells.length : 0,
            completed_tasks: okCells.length,
        };
    }

    const report: AggregateReport = {
        timestamp_utc: new Date().toISOString(),
        options,
        total_tasks_attempted: tasks.length,
        total_tasks_completed: perTask.filter(t => !t.error).length,
        per_runner,
        per_task: perTask,
    };

    await writeJsonReport(report, options.outputPath);
    printConsoleSummary(report);

    return report;
}

// ─── CLI ─────────────────────────────────────────────────────────

function parseArgv(argv: string[]): OrchestrateOptions {
    const args = argv.slice(2);
    const opts: OrchestrateOptions = {
        workspaceRoot: ".eval-phase5-cache",
        outputPath: "results-dryrun.json",
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = () => args[++i];
        switch (a) {
            case "--dry-run": /* informational; default flags already match */ break;
            case "--task-ids": opts.taskIds = next().split(",").filter(Boolean); break;
            case "--top-k": opts.topK = parseInt(next(), 10); break;
            case "--workspace": opts.workspaceRoot = next(); break;
            case "--output": opts.outputPath = next(); break;
            case "--csv": opts.csvPath = next(); break;
            case "--task-delay-ms": opts.taskDelayMs = parseInt(next(), 10); break;
            case "--no-cleanup": opts.cleanupClones = false; break;
            case "--min-disk-gb": opts.minDiskGB = parseFloat(next()); break;
            case "--help":
                console.log(`Usage: orchestrate.ts [--dry-run] [--task-ids id1,id2] [--top-k 10] [--workspace dir] [--output file] [--csv path] [--task-delay-ms 0] [--no-cleanup] [--min-disk-gb 5]`);
                process.exit(0);
        }
    }
    return opts;
}

const isDirectInvocation = (() => {
    try {
        const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
        const here = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
        return entry === here || entry.endsWith("orchestrate.ts");
    } catch {
        return false;
    }
})();

if (isDirectInvocation) {
    const opts = parseArgv(process.argv);
    orchestrate(opts).catch(err => {
        console.error(`Orchestrator threw: ${(err as Error).message}`);
        process.exit(1);
    });
}
