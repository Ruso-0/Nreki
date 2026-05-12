/**
 * Phase 5 C.4.B.2 Sprint 4.9.8 (Furia round 29) mui child_process
 * sanity check.
 *
 * Sprint 4.9.5 demonstrated worker_threads isolation provided 0.9x
 * reduction for mui (V8 page allocator retains pages from torn-down
 * isolates inside the parent process). Sprint 4.9.8 mutates the
 * transport to child_process.fork() so the kernel reclaims every
 * page on child exit. This harness re-runs the same 3 mui tasks
 * (11451, 22696, 42412) to verify the kernel-reclamation hypothesis
 * empirically before committing or relaunching C.4.B.
 *
 * Pass criteria firmados Furia round 29:
 *   * 3/3 mui tasks complete via children (exit code 0)
 *   * Zero child crashes / IPC failures
 *   * Main thread RSS ABSOLUTAMENTE PLANA across all 3 tasks
 *     (tolerance: <20 MB drift across the entire run)
 *   * Zero "max 65535" / "too many references" warnings
 *   * External memory main thread: ~base level constant
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";

const TARGETS = [
    "mui__material-ui-11451",  // 2,265 chunks (Sprint 4.8.10: +178 MB no-worker; 4.9.5: +144 MB worker_threads)
    "mui__material-ui-22696",  // 6,897 chunks (4.8.10: +123 MB; 4.9.5: +132 MB)
    "mui__material-ui-42412",  // 21,303 chunks (4.8.10: +308 MB; 4.9.5: +304 MB)
];

const RUNNERS_LIST = [
    "fast_grep", "ripgrep", "bm25", "nreki-mbf-off", "nreki-mbf-on",
];
const WORKSPACE = ".eval-phase5-cache";
const BOOTSTRAP_PATH = fileURLToPath(
    new URL("./eval-phase5/task-worker-bootstrap.mjs", import.meta.url),
);

// Capture "max 65535" / "too many references" stderr/stdout writes
// from the orchestrator process itself. Child stdout/stderr is also
// piped through dedicated handlers below.
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

/**
 * Fork the child, attach IPC listeners FIRST, send the input, then
 * await the result message and the child's exit. Same ordering as
 * orchestrate.ts's runTaskInChild and tests/eval-phase5/.
 */
function runTaskInChild(input) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const child = fork(BOOTSTRAP_PATH, [], {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        child.stdout?.on("data", chunk => {
            const text = chunk.toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                overflowWarnings.push(`[child stdout] ${text.slice(0, 200)}`);
            }
        });
        child.stderr?.on("data", chunk => {
            const text = chunk.toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                overflowWarnings.push(`[child stderr] ${text.slice(0, 200)}`);
            }
        });

        let captured;
        let childError;
        child.once("message", msg => { captured = msg; });
        child.once("error", err => { childError = err; });
        child.once("exit", (code, signal) => {
            resolve({
                output: captured,
                exitCode: code,
                signal,
                error: childError,
                wallMs: Date.now() - startedAt,
            });
        });
        child.send({ input });
    });
}

const all = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
const baseline = snap("baseline");
const perTask = [];
let childLeaks = 0;
let childCrashes = 0;

for (let ti = 0; ti < TARGETS.length; ti++) {
    const id = TARGETS[ti];
    const task = all.find(t => t.instance_id === id);
    if (!task) { console.error(`MISSING ${id}`); continue; }
    console.log(`\n=== MUI TASK ${ti + 1}/${TARGETS.length}: ${id} ===`);

    const preTask = snap(`pre task${ti + 1}`);
    const { output, exitCode, signal, error, wallMs } = await runTaskInChild({
        task,
        workspaceRoot: WORKSPACE,
        topK: 10,
        voyageKey: "",
        runnersList: RUNNERS_LIST,
    });
    const postTask = snap(`post task${ti + 1} (exit=${exitCode}, signal=${signal}, wall=${wallMs}ms)`);

    if (exitCode !== 0) childLeaks++;
    if (error) childCrashes++;

    let chunksIndexed = null;
    const nrekiCell = output?.result?.runners?.["nreki-mbf-on"]
        ?? output?.result?.runners?.["nreki-mbf-off"];
    if (nrekiCell?.result?.metadata?.ts_files_count != null) {
        chunksIndexed = nrekiCell.result.metadata.ts_files_count;
    }

    // Cleanup the worker's cloned workspace on main thread.
    if (output?.taskDir) {
        try { await fs.rm(output.taskDir, { recursive: true, force: true }); } catch {}
    }

    perTask.push({
        task: id,
        exitCode,
        signal,
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
const totalDriftMB = (final.rss - baseline.rss) / 1024 / 1024;
const externalFinalMB = final.external / 1024 / 1024;
const externalBaselineMB = baseline.external / 1024 / 1024;
const externalDriftMB = externalFinalMB - externalBaselineMB;

console.log("\n=== SPRINT 4.9.8 MUI CHILD_PROCESS SANITY ===");
console.log(`tasks completed: ${perTask.length}/${TARGETS.length}`);
console.log(`child leaks (exit != 0): ${childLeaks}`);
console.log(`child crashes (uncaught throw / IPC error): ${childCrashes}`);
console.log(`overflow warnings ("max 65535" / "too many references"): ${overflowWarnings.length}`);
if (overflowWarnings.length > 0) {
    console.log("  first 3 captured:");
    for (const w of overflowWarnings.slice(0, 3)) console.log(`    ${w.replace(/\n/g, " ")}`);
}
console.log(`baseline RSS: ${mb(baseline.rss)} MB`);
console.log(`final RSS: ${mb(final.rss)} MB`);
console.log(`total RSS drift (final - baseline): ${totalDriftMB.toFixed(1)} MB`);
console.log(`baseline external: ${externalBaselineMB.toFixed(1)} MB`);
console.log(`final external: ${externalFinalMB.toFixed(1)} MB`);
console.log(`external drift: ${externalDriftMB.toFixed(1)} MB`);

console.log("\n--- per-task summary ---");
console.log("  task                                  exit  wall(s)  pre(MB)  post(MB)  RSSdel(MB)  extDel(MB)  files");
for (const m of perTask) {
    console.log(
        `  ${m.task.padEnd(36)} ${String(m.exitCode).padStart(4)}  ${(m.wallMs / 1000).toFixed(1).padStart(6)}  ${mb(m.rssBefore).padStart(7)}  ${mb(m.rssAfter).padStart(8)}  ${mb(m.rssDelta).padStart(10)}  ${mb(m.externalDelta).padStart(10)}  ${String(m.chunksIndexed ?? "n/a")}`,
    );
}

// Comparison vs Sprint 4.9.5 (worker_threads) and 4.8.10 (no isolation)
const SPRINT_4_8_10_MUI_AVG_MB = 203;
const SPRINT_4_9_5_MUI_AVG_MB = 197;
const muiAvgDeltaMB = perTask.length > 0
    ? perTask.reduce((a, b) => a + b.rssDelta, 0) / perTask.length / 1024 / 1024
    : Number.POSITIVE_INFINITY;

console.log("\n--- comparison ---");
console.log(`  Sprint 4.8.10 (no isolation):       avg ${SPRINT_4_8_10_MUI_AVG_MB} MB / mui task`);
console.log(`  Sprint 4.9.5 (worker_threads):      avg ${SPRINT_4_9_5_MUI_AVG_MB} MB / mui task`);
console.log(`  Sprint 4.9.8 (child_process):       avg ${muiAvgDeltaMB.toFixed(1)} MB / mui task`);
const reductionVsNo = muiAvgDeltaMB > 0
    ? SPRINT_4_8_10_MUI_AVG_MB / muiAvgDeltaMB
    : Number.POSITIVE_INFINITY;
const reductionVsWorker = muiAvgDeltaMB > 0
    ? SPRINT_4_9_5_MUI_AVG_MB / muiAvgDeltaMB
    : Number.POSITIVE_INFINITY;
console.log(`  reduction vs no-isolation:          ${reductionVsNo.toFixed(1)}x`);
console.log(`  reduction vs worker_threads:        ${reductionVsWorker.toFixed(1)}x`);

// Projection 100 tasks
const baselineMB = baseline.rss / 1024 / 1024;
const projectedFinalRssMB = baselineMB + 100 * muiAvgDeltaMB;
console.log("\n--- projection C.4.B 100-task final RSS ---");
console.log(`  Sprint 4.8.10 model:                ${((baselineMB + 100 * SPRINT_4_8_10_MUI_AVG_MB) / 1024).toFixed(2)} GB`);
console.log(`  Sprint 4.9.5 model:                 ${((baselineMB + 100 * SPRINT_4_9_5_MUI_AVG_MB) / 1024).toFixed(2)} GB`);
console.log(`  Sprint 4.9.8 model (this run):      ${(projectedFinalRssMB / 1024).toFixed(2)} GB`);
console.log(`  14 GB host headroom:                ${projectedFinalRssMB / 1024 < 14 ? "PASS" : "FAIL"}`);

const PASS_ALL_COMPLETE = perTask.length === TARGETS.length;
const PASS_NO_LEAKS = childLeaks === 0;
const PASS_NO_CRASH = childCrashes === 0;
const PASS_NO_WARNINGS = overflowWarnings.length === 0;
const PASS_RSS_PLANA = Math.abs(totalDriftMB) <= 20;
const PASS_EXTERNAL_PLANA = Math.abs(externalDriftMB) <= 20;
const ALL = PASS_ALL_COMPLETE && PASS_NO_LEAKS && PASS_NO_CRASH
    && PASS_NO_WARNINGS && PASS_RSS_PLANA && PASS_EXTERNAL_PLANA;

console.log("\n--- gates (Sprint 4.9.8 mui child_process sanity, Furia round 29) ---");
console.log(`  3/3 mui tasks complete:                          ${PASS_ALL_COMPLETE ? "PASS" : "FAIL"} (${perTask.length}/${TARGETS.length})`);
console.log(`  no child leaks (all exit code 0):                ${PASS_NO_LEAKS ? "PASS" : "FAIL"} (${childLeaks} leaks)`);
console.log(`  no child crashes / IPC failures:                 ${PASS_NO_CRASH ? "PASS" : "FAIL"} (${childCrashes} crashes)`);
console.log(`  no "max 65535" / "too many references":          ${PASS_NO_WARNINGS ? "PASS" : "FAIL"} (${overflowWarnings.length} captured)`);
console.log(`  main-thread RSS plana (|drift| <= 20 MB):        ${PASS_RSS_PLANA ? "PASS" : "FAIL"} (${totalDriftMB.toFixed(1)} MB)`);
console.log(`  main-thread external plana (|drift| <= 20 MB):   ${PASS_EXTERNAL_PLANA ? "PASS" : "FAIL"} (${externalDriftMB.toFixed(1)} MB)`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);
process.exit(ALL ? 0 : 1);
