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
import { statfsSync, existsSync, appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./polybench-loader.js";
import { computeGroundTruth } from "./ground-truth.js";
import {
    executeTaskBody,
    ALL_REPORT_RUNNERS,
    type ReportRunnerName,
    type PerTaskResult,
    type PerRunnerMetrics,
    type TaskBodyInput,
    type TaskBodyOutput,
} from "./task-worker-body.js";
import {
    percentile,
    mean,
} from "./metrics.js";
import { printConsoleSummary, writeJsonReport } from "./report.js";

// Re-export for backwards compatibility with downstream tooling (report
// generators, scripts/analyze-suspects-*.ts) that pulled these types
// from orchestrate.ts before Sprint 4.9.
export {
    ALL_REPORT_RUNNERS,
    type ReportRunnerName,
    type PerTaskResult,
    type PerRunnerMetrics,
};

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
    /**
     * Phase 5 C.4.B.0c (Furia round 24 P0): JSON-Lines path for
     * incremental, append-only per-task results. Each completed
     * task (success or per-runner failure) appends a single line
     * with the PerTaskResult shape. Default: undefined (disabled).
     *
     * Pair with `resume` to recover from interruptions during the
     * 2-3h C.4.B run without re-executing already-completed tasks.
     */
    outputJsonlPath?: string;
    /**
     * If true and `outputJsonlPath` exists, parse it and skip any
     * task whose instance_id is already in the file. Default true.
     * Set to false to force a clean restart even when prior state
     * is present.
     */
    resume?: boolean;
    /**
     * Phase 5 C.4.B.2 Sprint 4.9.8 (Furia round 29): isolate each task
     * in a fresh Node child process so the kernel reclaims every page
     * the task owned on exit (Sprint 4.9 used worker_threads, which
     * empirically failed for mui -- V8 retains pages from torn-down
     * isolates in the parent's address space; Sprint 4.9.5 reduction
     * factor was 0.9x).
     *
     * Default: true in production, false under vitest (a forked child
     * cannot honor vi.mock across process boundaries). Explicit
     * `false` keeps the in-process loop for debugging.
     *
     * The option name is retained verbatim for backwards compatibility
     * with downstream tooling -- semantically it now toggles the
     * child_process transport rather than worker_threads.
     */
    useWorker?: boolean;
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

/**
 * Parse an existing JSONL state file and return the set of
 * instance_ids that already have a recorded outcome. Malformed
 * lines are skipped (warned to stderr) rather than fatal -- the
 * worst case is we re-execute a task whose JSONL line was
 * truncated by a crash mid-write.
 */
export async function readCompletedTaskIds(jsonlPath: string): Promise<Set<string>> {
    const done = new Set<string>();
    if (!existsSync(jsonlPath)) return done;
    const rl = readline.createInterface({
        input: createReadStream(jsonlPath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as { instance_id?: string };
            if (parsed.instance_id) done.add(parsed.instance_id);
        } catch {
            process.stderr.write(
                `[orchestrate] WARN: skipping malformed JSONL line in ${jsonlPath}\n`,
            );
        }
    }
    return done;
}

/**
 * Append a per-task result line atomically. We use sync append so
 * the OS gives us the strongest "either the whole line or nothing"
 * guarantee available without an fsync (good enough: the worst
 * case is a partial line on hard crash, which readCompletedTaskIds
 * tolerates).
 */
export function appendTaskResultJsonl(jsonlPath: string, result: PerTaskResult): void {
    appendFileSync(jsonlPath, JSON.stringify(result) + "\n", { encoding: "utf-8" });
}

/**
 * Phase 5 C.4.B.2 Sprint 4.9.8 (Furia round 29): spawn an isolated
 * Node child process that imports the runner code, executes the task
 * body, posts the result over IPC, and exits. The kernel reclaims all
 * pages the child owned on exit, so the parent's RSS stays flat
 * regardless of how memory-hungry an individual task was.
 *
 * Sprint 4.9 used `worker_threads` which empirically failed to
 * isolate mui tasks (V8 page allocator retains pages from torn-down
 * isolates inside the parent's address space; Sprint 4.9.5 measured
 * a 0.9x reduction -- effectively zero). child_process restores true
 * OS-level isolation at the cost of ~50-200 ms startup per task.
 *
 * Resolves with the TaskBodyOutput observed on the parent. Never
 * rejects -- child startup failures / unexpected exits are funneled
 * into a synthetic TaskBodyOutput with a task-level error so the
 * orchestrator's outer loop can keep going (single bad task does not
 * abort the run).
 */
function runTaskInChild(input: TaskBodyInput): Promise<TaskBodyOutput> {
    return new Promise(resolve => {
        // Bootstrap is a .mjs shim that registers tsx/esm in the
        // child, then dynamic-imports the .ts task-worker entry. The
        // task-worker waits for an IPC message on process.on("message"),
        // executes it, posts the result, and exits.
        const bootstrapPath = fileURLToPath(
            new URL("./task-worker-bootstrap.mjs", import.meta.url),
        );
        const child = fork(bootstrapPath, [], {
            // stdio: ipc channel + inherit stdout/stderr so per-runner
            // progress lines surface in the orchestrator console.
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            // Inherit env (RG_BINARY / AIDER_BINARY seeded by the
            // orchestrator pre-flight) without exposing the parent's
            // arg array to the child.
            env: process.env,
        });

        let captured: TaskBodyOutput | undefined;
        let childError: Error | undefined;

        child.once("message", (msg: unknown) => {
            captured = msg as TaskBodyOutput;
        });
        child.once("error", (err: Error) => {
            childError = err;
        });
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            if (captured) {
                resolve(captured);
                return;
            }
            const reason = childError
                ? `child error: ${childError.message}`
                : signal
                    ? `child killed by signal ${signal}`
                    : `child exited code=${code} without posting a message`;
            resolve({
                result: {
                    instance_id: input.task.instance_id,
                    repo: input.task.repo,
                    base_commit: input.task.base_commit,
                    task_category: input.task.task_category,
                    ground_truth: computeGroundTruth(input.task),
                    runners: {},
                    error: reason,
                },
                taskDir: null,
            });
        });

        // Send the task input over IPC after listeners are wired so
        // a fast child cannot post-message before we are listening.
        child.send({ input }, (sendErr: Error | null) => {
            if (sendErr) childError = sendErr;
        });
    });
}

/**
 * Dispatch a single task. In worker mode the WASM-heavy runner code
 * runs inside a fresh child Node process (Sprint 4.9.8); the kernel
 * disposes all pages on exit. Inline mode reuses the parent's module
 * graph -- used by vitest so vi.mock interception works across runner
 * invocations. (The option name `useWorker` is preserved for backward
 * compatibility with downstream tooling; semantically it now toggles
 * the child_process transport.)
 */
async function runTask(
    input: TaskBodyInput,
    useWorker: boolean,
): Promise<TaskBodyOutput> {
    return useWorker ? runTaskInChild(input) : executeTaskBody(input);
}

export async function orchestrate(options: OrchestrateOptions): Promise<AggregateReport> {
    const topK = options.topK ?? 10;
    const csvPath = options.csvPath ?? DEFAULT_CSV_PATH;
    const cleanupClones = options.cleanupClones ?? true;
    const taskDelayMs = options.taskDelayMs ?? 0;
    const minDiskGB = options.minDiskGB ?? 5;
    const runnersList = options.runners ?? ALL_REPORT_RUNNERS;
    const resume = options.resume ?? true;
    const jsonlPath = options.outputJsonlPath;

    await preflightDisk(options.workspaceRoot, minDiskGB);
    maybeSeedRgBinary();
    maybeSeedAiderBinary();

    const allTasks = await loadPolyBenchVerified(csvPath);
    const taskFilter = new Set(options.taskIds ?? []);
    const filteredTasks = taskFilter.size > 0
        ? allTasks.filter(t => taskFilter.has(t.instance_id))
        : allTasks;

    if (filteredTasks.length === 0) {
        throw new Error(
            `No tasks matched filter [${[...taskFilter].join(", ")}] from ${allTasks.length} total`,
        );
    }

    // Phase 5 C.4.B.0c resume detection. If a JSONL state file exists
    // and resume is on, hydrate previously-completed PerTaskResult rows
    // and skip those instance_ids in the loop below.
    const perTask: PerTaskResult[] = [];
    const completedIds = new Set<string>();
    if (jsonlPath && resume && existsSync(jsonlPath)) {
        const rl = readline.createInterface({
            input: createReadStream(jsonlPath, { encoding: "utf-8" }),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const parsed = JSON.parse(trimmed) as PerTaskResult;
                if (parsed.instance_id && !completedIds.has(parsed.instance_id)) {
                    completedIds.add(parsed.instance_id);
                    perTask.push(parsed);
                }
            } catch {
                process.stderr.write(
                    `[orchestrate] WARN: malformed JSONL line skipped\n`,
                );
            }
        }
        if (completedIds.size > 0) {
            process.stdout.write(
                `[orchestrate] Resuming from ${jsonlPath}: ${completedIds.size} task(s) already complete\n`,
            );
        }
    }

    // Tasks remaining = filtered minus already-completed (when resuming).
    const tasks = filteredTasks.filter(t => !completedIds.has(t.instance_id));

    const voyageKey = process.env.VOYAGE_API_KEY || "";
    // Sprint 4.9: workers are the production default. Vitest cannot
    // honor vi.mock across thread boundaries, so suppress workers when
    // the test runner is active. Explicit options.useWorker overrides.
    const useWorker = options.useWorker ?? !process.env.VITEST;

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        process.stdout.write(
            `\n[${i + 1}/${tasks.length}] ${task.instance_id} (${task.repo})\n`,
        );

        const { result: taskResult, taskDir } = await runTask(
            {
                task,
                workspaceRoot: options.workspaceRoot,
                topK,
                voyageKey,
                runnersList,
            },
            useWorker,
        );

        perTask.push(taskResult);
        if (jsonlPath) appendTaskResultJsonl(jsonlPath, taskResult);

        // Cleanup runs on the main thread after the worker has exited
        // so we never race the worker's own filesystem handles.
        if (cleanupClones && taskDir) {
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
        // Resume: aggregate over the FULL filtered task set (including
        // resumed-from-JSONL rows) so the headline counts a 100-task
        // run as 100, not "100 minus what we already had".
        total_tasks_attempted: filteredTasks.length,
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
            case "--output-jsonl": opts.outputJsonlPath = next(); break;
            case "--no-resume": opts.resume = false; break;
            case "--no-worker": opts.useWorker = false; break;
            case "--help":
                console.log(`Usage: orchestrate.ts [--dry-run] [--task-ids id1,id2] [--top-k 10] [--workspace dir] [--output file] [--output-jsonl file] [--no-resume] [--no-worker] [--csv path] [--task-delay-ms 0] [--no-cleanup] [--min-disk-gb 5]`);
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
