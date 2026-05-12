/**
 * Phase 5 C.4.B.2 Sprint 4.9 (Furia round 28) worker-isolation stress.
 *
 * Same 10-vscode-task corpus as Sprint 4.8.5 (5 plateau-passing + 5
 * adversarial-tail tasks). The change under test: every task now runs
 * inside a Node Worker thread spawned via task-worker-bootstrap.mjs.
 * The worker imports the runner modules, executes them sequentially,
 * posts the result, and terminates -- which is what disposes the
 * tree-sitter / sql.js / tiktoken WASM linear memory.
 *
 * Pass criteria (Pipipi Code firmed):
 *   * All 10 tasks complete via workers (no crashes)
 *   * Final main-thread RSS <= 500 MB (Furia round 28 target)
 *   * Per-task RSS growth on the main thread <= 50 MB (median)
 *   * No worker leaks (each spawned worker reaches exit code 0)
 *
 * We deliberately exclude voyage (network) and aider (slow Python venv)
 * from the runner list so the harness completes in ~10-15 minutes.
 * Fast_grep, ripgrep, bm25, and both NREKI ablation cells together
 * exercise every WASM module the orchestrator loads, which is what
 * Sprint 4.8.10 measurement flagged as the 14.37 GB projection driver.
 */

import { Worker } from "node:worker_threads";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";

const TARGETS = [
    // 5 tasks Sprint 4.8.5 plateau cohort
    "microsoft__vscode-106767",
    "microsoft__vscode-108964",
    "microsoft__vscode-109750",
    "microsoft__vscode-110094",
    "microsoft__vscode-113837",
    // 5 tasks that crashed in Sprint 4 / 4.7 adversarial tail
    "microsoft__vscode-122991",
    "microsoft__vscode-135805",
    "microsoft__vscode-136347",
    "microsoft__vscode-149380",
    "microsoft__vscode-153121",
];

const RUNNERS_LIST = [
    "fast_grep", "ripgrep", "bm25", "nreki-mbf-off", "nreki-mbf-on",
];
const WORKSPACE = ".eval-phase5-cache";
const WORKER_BOOTSTRAP = new URL(
    "./eval-phase5/task-worker-bootstrap.mjs",
    import.meta.url,
);

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }
function snap(label) {
    if (global.gc) global.gc();
    const m = process.memoryUsage();
    console.log(`[mem][${label}] rss=${mb(m.rss)}MB external=${mb(m.external)}MB heapUsed=${mb(m.heapUsed)}MB`);
    return m;
}

function runTaskInWorker(input) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const worker = new Worker(WORKER_BOOTSTRAP, {
            workerData: input,
            // Suppress per-runner progress lines from the worker so the
            // stress harness output stays scannable.
            stdout: true,
            stderr: true,
        });
        worker.stdout?.on("data", () => {});
        worker.stderr?.on("data", () => {});

        let captured;
        let workerError;
        worker.once("message", msg => { captured = msg; });
        worker.once("error", err => { workerError = err; });
        worker.once("exit", code => {
            resolve({
                output: captured,
                exitCode: code,
                error: workerError,
                wallMs: Date.now() - startedAt,
            });
        });
    });
}

const all = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
const baseline = snap("baseline");
const perTask = [];
let workerLeaks = 0;
let workerCrashes = 0;

for (let ti = 0; ti < TARGETS.length; ti++) {
    const id = TARGETS[ti];
    const task = all.find(t => t.instance_id === id);
    if (!task) { console.error(`MISSING ${id}`); continue; }
    console.log(`\n=== TASK ${ti + 1}/${TARGETS.length}: ${id} ===`);

    const preTask = snap(`pre task${ti + 1}`);
    const { output, exitCode, error, wallMs } = await runTaskInWorker({
        task,
        workspaceRoot: WORKSPACE,
        topK: 10,
        voyageKey: "",
        runnersList: RUNNERS_LIST,
    });
    const postTask = snap(`post task${ti + 1} (exit=${exitCode}, wall=${wallMs}ms)`);

    if (exitCode !== 0) workerLeaks++;
    if (!output || (output.result && output.result.error && !output.result.error.startsWith("clone failed"))) {
        // clone failures are not crashes; only treat actual worker-side
        // throws / missing-message exits as crashes.
        if (error) workerCrashes++;
    }

    // Cleanup the worker's cloned workspace on the main thread (Sprint
    // 4.9 contract: worker doesn't rm so we never race its handles).
    if (output?.taskDir) {
        try {
            await fs.rm(output.taskDir, { recursive: true, force: true });
        } catch {}
    }

    perTask.push({
        task: id,
        exitCode,
        wallMs,
        rssBefore: preTask.rss,
        rssAfter: postTask.rss,
        rssDelta: postTask.rss - preTask.rss,
        runnerCount: output?.result?.runners ? Object.keys(output.result.runners).length : 0,
        taskError: output?.result?.error ?? null,
    });
}

const final = snap("final");

const rssGrowth = (final.rss - baseline.rss) / 1024 / 1024;
const finalRssMB = final.rss / 1024 / 1024;

console.log("\n=== SPRINT 4.9 WORKER-ISOLATION RESULT ===");
console.log(`tasks completed: ${perTask.length}/${TARGETS.length}`);
console.log(`worker leaks (exit != 0): ${workerLeaks}`);
console.log(`worker crashes (uncaught throw): ${workerCrashes}`);
console.log(`RSS growth baseline -> final: ${rssGrowth.toFixed(1)} MB`);
console.log(`final RSS: ${finalRssMB.toFixed(1)} MB`);

console.log("\n--- per-task summary ---");
console.log("  task                                     exit  wall(s)  pre(MB)  post(MB)  delta(MB)  runners");
for (const m of perTask) {
    console.log(
        `  ${m.task.padEnd(40)} ${String(m.exitCode).padStart(4)}  ${(m.wallMs / 1000).toFixed(1).padStart(6)}  ${mb(m.rssBefore).padStart(7)}  ${mb(m.rssAfter).padStart(8)}  ${mb(m.rssDelta).padStart(9)}  ${m.runnerCount}`,
    );
}

// Plateau check: median delta across all tasks
const deltas = perTask.map(m => m.rssDelta).sort((a, b) => a - b);
const medianDelta = deltas.length > 0
    ? deltas[Math.floor(deltas.length / 2)] / 1024 / 1024
    : Number.POSITIVE_INFINITY;

const PASS_ALL_COMPLETE = perTask.length === TARGETS.length;
const PASS_NO_LEAKS = workerLeaks === 0;
const PASS_NO_CRASH = workerCrashes === 0;
const PASS_FINAL_RSS = finalRssMB <= 500;
const PASS_PLATEAU = medianDelta <= 50;
const ALL = PASS_ALL_COMPLETE && PASS_NO_LEAKS && PASS_NO_CRASH && PASS_FINAL_RSS && PASS_PLATEAU;

console.log("\n--- gates (Sprint 4.9 worker-isolation spec) ---");
console.log(`  all 10 tasks complete:                    ${PASS_ALL_COMPLETE ? "PASS" : "FAIL"} (${perTask.length}/${TARGETS.length})`);
console.log(`  no worker leaks (all exit code 0):        ${PASS_NO_LEAKS ? "PASS" : "FAIL"} (${workerLeaks} leaks)`);
console.log(`  no worker crashes:                        ${PASS_NO_CRASH ? "PASS" : "FAIL"} (${workerCrashes} crashes)`);
console.log(`  final main-thread RSS <= 500 MB:          ${PASS_FINAL_RSS ? "PASS" : "FAIL"} (${finalRssMB.toFixed(1)} MB)`);
console.log(`  median per-task RSS delta <= 50 MB:       ${PASS_PLATEAU ? "PASS" : "FAIL"} (${medianDelta.toFixed(1)} MB)`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);
process.exit(ALL ? 0 : 1);
