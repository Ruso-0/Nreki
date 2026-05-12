/**
 * Phase 5 C.4.B.2 Sprint 4.9.5 (Furia round 28) mui worker-isolation
 * sanity check.
 *
 * Sprint 4.9 demonstrated worker isolation works on 10 vscode tasks
 * (warmup +500 MB on task 1, then median +13.3 MB / task plateau).
 * BUT Sprint 4.8.10 already burned us once on the vscode->mui
 * extrapolation (10 MB assumption was 20x off; mui empirical was
 * 203 MB / task). So before relaunching C.4.B and before committing
 * Sprint 4.9, we measure the same 3 mui tasks (11451, 22696, 42412)
 * under the worker-isolation pattern.
 *
 * Pass criteria (auditor firmadas):
 *   * 3/3 mui tasks complete via workers (exit code 0)
 *   * Zero worker crashes
 *   * Worker WASM disposed (external memory <50 MB on main thread)
 *   * mui per-task RSS growth <100 MB post-warmup (looser than vscode
 *     50 MB because mui chunk counts are 3-10x larger)
 *   * Zero "max 65535" warnings
 *   * Projection C.4.B 100 tasks <5 GB final RSS
 */

import { Worker } from "node:worker_threads";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";

const TARGETS = [
    "mui__material-ui-11451",  // 2,265 chunks (Sprint 4.8.10: +178 MB)
    "mui__material-ui-22696",  // 6,897 chunks (Sprint 4.8.10: +123 MB)
    "mui__material-ui-42412",  // 21,303 chunks (Sprint 4.8.10: +308 MB)
];

// Same runner subset as Sprint 4.9 stress: skip voyage (network) and
// aider (Python venv) to keep wall-clock manageable while exercising
// every WASM module the orchestrator loads.
const RUNNERS_LIST = [
    "fast_grep", "ripgrep", "bm25", "nreki-mbf-off", "nreki-mbf-on",
];
const WORKSPACE = ".eval-phase5-cache";
const WORKER_BOOTSTRAP = new URL(
    "./eval-phase5/task-worker-bootstrap.mjs",
    import.meta.url,
);

// Capture "max 65535" / "too many references" warnings from stdout +
// stderr so we can assert zero of them survived in the worker layer.
const overflowWarnings = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
function makeSpy(orig) {
    return chunk => {
        const text = typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf-8");
        if (text.includes("too many references") || text.includes("max 65535")) {
            overflowWarnings.push(text.slice(0, 200));
        }
        return orig(chunk);
    };
}
process.stdout.write = makeSpy(originalStdoutWrite);
process.stderr.write = makeSpy(originalStderrWrite);

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
            stdout: true,
            stderr: true,
        });
        // Spy on worker stdout/stderr too so warnings emitted inside
        // the worker are caught (workers do NOT inherit our spied
        // process.stdout.write of the parent).
        worker.stdout?.on("data", chunk => {
            const text = chunk.toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                overflowWarnings.push(`[worker stdout] ${text.slice(0, 200)}`);
            }
        });
        worker.stderr?.on("data", chunk => {
            const text = chunk.toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                overflowWarnings.push(`[worker stderr] ${text.slice(0, 200)}`);
            }
        });

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
    console.log(`\n=== MUI TASK ${ti + 1}/${TARGETS.length}: ${id} ===`);

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
    if (error) workerCrashes++;

    // Pull chunks-indexed from the NREKI runner metadata if present.
    let chunksIndexed = null;
    const nrekiCell = output?.result?.runners?.["nreki-mbf-on"]
        ?? output?.result?.runners?.["nreki-mbf-off"];
    if (nrekiCell?.result?.metadata?.ts_files_count != null) {
        chunksIndexed = nrekiCell.result.metadata.ts_files_count;
    }

    // Cleanup worker's cloned workspace on main thread.
    if (output?.taskDir) {
        try { await fs.rm(output.taskDir, { recursive: true, force: true }); } catch {}
    }

    perTask.push({
        task: id,
        exitCode,
        wallMs,
        rssBefore: preTask.rss,
        rssAfter: postTask.rss,
        rssDelta: postTask.rss - preTask.rss,
        externalBefore: preTask.external,
        externalAfter: postTask.external,
        externalDelta: postTask.external - preTask.external,
        chunksIndexed,
        runnerCount: output?.result?.runners ? Object.keys(output.result.runners).length : 0,
        taskError: output?.result?.error ?? null,
    });
}

process.stdout.write = originalStdoutWrite;
process.stderr.write = originalStderrWrite;

const final = snap("final");

console.log("\n=== SPRINT 4.9.5 MUI WORKER-ISOLATION SANITY ===");
console.log(`tasks completed: ${perTask.length}/${TARGETS.length}`);
console.log(`worker leaks (exit != 0): ${workerLeaks}`);
console.log(`worker crashes (uncaught throw): ${workerCrashes}`);
console.log(`overflow warnings ("max 65535" / "too many references"): ${overflowWarnings.length}`);
if (overflowWarnings.length > 0) {
    console.log("  first 3 captured:");
    for (const w of overflowWarnings.slice(0, 3)) console.log(`    ${w.replace(/\n/g, " ")}`);
}
console.log(`baseline RSS: ${mb(baseline.rss)} MB`);
console.log(`final RSS: ${mb(final.rss)} MB`);
console.log(`final external (WASM residual main thread): ${mb(final.external)} MB`);

console.log("\n--- per-task summary ---");
console.log("  task                                  exit  wall(s)  pre(MB)  post(MB)  RSSdel(MB)  extDel(MB)  chunks(files)  runners");
for (const m of perTask) {
    console.log(
        `  ${m.task.padEnd(36)} ${String(m.exitCode).padStart(4)}  ${(m.wallMs / 1000).toFixed(1).padStart(6)}  ${mb(m.rssBefore).padStart(7)}  ${mb(m.rssAfter).padStart(8)}  ${mb(m.rssDelta).padStart(10)}  ${mb(m.externalDelta).padStart(10)}  ${String(m.chunksIndexed ?? "n/a").padStart(13)}  ${m.runnerCount}`,
    );
}

// Post-warmup growth: drop task 1 (warmup hit) and average tasks 2..3.
// With only 3 mui tasks, this is a coarse signal but enough to decide
// whether mui follows the vscode plateau pattern.
const postWarmupDeltas = perTask.slice(1).map(m => m.rssDelta);
const muiPostWarmupAvgMB = postWarmupDeltas.length > 0
    ? postWarmupDeltas.reduce((a, b) => a + b, 0) / postWarmupDeltas.length / 1024 / 1024
    : Number.POSITIVE_INFINITY;
const muiTask1WarmupMB = perTask.length > 0
    ? perTask[0].rssDelta / 1024 / 1024
    : Number.POSITIVE_INFINITY;

// Sprint 4.8.10 baseline (per-task RSS growth WITHOUT worker isolation):
const SPRINT_4_8_10_MUI_AVG_MB = 203;

// Projection C.4.B (100 PolyBench tasks total). Use measured warmup
// + measured mui post-warmup avg as the upper-bound model.
const PROJECTED_TASKS = 100;
const baselineMB = baseline.rss / 1024 / 1024;
const projectedFinalRssMB = baselineMB
    + muiTask1WarmupMB
    + (PROJECTED_TASKS - 1) * muiPostWarmupAvgMB;
const projectedNoWorkerMB = baselineMB + PROJECTED_TASKS * SPRINT_4_8_10_MUI_AVG_MB;

console.log("\n--- comparison vs Sprint 4.8.10 (no worker isolation) ---");
console.log(`  Sprint 4.8.10 mui avg RSS growth / task: ${SPRINT_4_8_10_MUI_AVG_MB} MB`);
console.log(`  Sprint 4.9.5 mui avg post-warmup growth: ${muiPostWarmupAvgMB.toFixed(1)} MB`);
const reduction = muiPostWarmupAvgMB > 0
    ? SPRINT_4_8_10_MUI_AVG_MB / muiPostWarmupAvgMB
    : Number.POSITIVE_INFINITY;
console.log(`  reduction factor: ${reduction.toFixed(1)}x`);

console.log("\n--- projection C.4.B 100-task final RSS ---");
console.log(`  no worker isolation (Sprint 4.8.10 model): ${(projectedNoWorkerMB / 1024).toFixed(2)} GB`);
console.log(`  with worker isolation (Sprint 4.9.5 model): ${(projectedFinalRssMB / 1024).toFixed(2)} GB`);
console.log(`  14 GB host headroom: ${projectedFinalRssMB / 1024 < 14 ? "PASS" : "FAIL"}`);

const PASS_ALL_COMPLETE = perTask.length === TARGETS.length;
const PASS_NO_LEAKS = workerLeaks === 0;
const PASS_NO_CRASH = workerCrashes === 0;
const PASS_NO_WARNINGS = overflowWarnings.length === 0;
const PASS_WASM_DISPOSED = final.external / 1024 / 1024 <= 50;
const PASS_POST_WARMUP = muiPostWarmupAvgMB <= 100;
const PASS_PROJECTION = projectedFinalRssMB / 1024 < 5;
const ALL = PASS_ALL_COMPLETE && PASS_NO_LEAKS && PASS_NO_CRASH && PASS_NO_WARNINGS
    && PASS_WASM_DISPOSED && PASS_POST_WARMUP && PASS_PROJECTION;

console.log("\n--- gates (Sprint 4.9.5 mui sanity spec) ---");
console.log(`  3/3 mui tasks complete:                       ${PASS_ALL_COMPLETE ? "PASS" : "FAIL"} (${perTask.length}/${TARGETS.length})`);
console.log(`  no worker leaks (all exit code 0):            ${PASS_NO_LEAKS ? "PASS" : "FAIL"} (${workerLeaks} leaks)`);
console.log(`  no worker crashes:                            ${PASS_NO_CRASH ? "PASS" : "FAIL"} (${workerCrashes} crashes)`);
console.log(`  no "max 65535" / "too many references":       ${PASS_NO_WARNINGS ? "PASS" : "FAIL"} (${overflowWarnings.length} captured)`);
console.log(`  WASM disposed (final external <= 50 MB):      ${PASS_WASM_DISPOSED ? "PASS" : "FAIL"} (${mb(final.external)} MB)`);
console.log(`  mui post-warmup RSS growth <= 100 MB / task:  ${PASS_POST_WARMUP ? "PASS" : "FAIL"} (${muiPostWarmupAvgMB.toFixed(1)} MB)`);
console.log(`  projection 100 tasks < 5 GB:                  ${PASS_PROJECTION ? "PASS" : "FAIL"} (${(projectedFinalRssMB / 1024).toFixed(2)} GB)`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);
process.exit(ALL ? 0 : 1);
