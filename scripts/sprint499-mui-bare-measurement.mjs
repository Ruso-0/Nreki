/**
 * Phase 5 C.4.B.2 Sprint 4.9.9 (Furia round 29 follow-on) — bare
 * measurement variant of the Sprint 4.9.8 mui sanity harness.
 *
 * Why: Sprint 4.9.8 measured total drift 33.8 MB, which tripped the
 * Furia round 29 "RSS plana <=20 MB" gate. Investigation revealed
 * 50 MB of that drift came from the parent's own verdict-emission
 * logging (per-task table formatting, comparison-table computation,
 * console.log spam between post-task3 snapshot and final snapshot).
 * The kernel reclamation hypothesis was intact (per-task deltas
 * within +-5 MB), but the literal harness reported a false-positive
 * leak.
 *
 * Discipline: NO console.log calls between baseline snap and final
 * snap. ONLY per-task pre/post snapshots are emitted during the hot
 * loop, and they emit single short lines. All verdict computation,
 * comparison tables, and gate evaluation happen AFTER the final
 * snapshot is taken.
 *
 * Pass criteria (same as Sprint 4.9.8, Furia round 29):
 *   * 3/3 mui tasks complete (exit 0)
 *   * Zero crashes / IPC failures / overflow warnings
 *   * Main-thread RSS drift baseline -> final <= 20 MB
 *   * Main-thread external drift <= 20 MB
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";

const TARGETS = [
    "mui__material-ui-11451",
    "mui__material-ui-22696",
    "mui__material-ui-42412",
];
const RUNNERS_LIST = [
    "fast_grep", "ripgrep", "bm25", "nreki-mbf-off", "nreki-mbf-on",
];
const WORKSPACE = ".eval-phase5-cache";
const BOOTSTRAP_PATH = fileURLToPath(
    new URL("./eval-phase5/task-worker-bootstrap.mjs", import.meta.url),
);

// Overflow-warning capture (cheap, single boolean check per write).
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

function snap() {
    if (typeof globalThis.gc === "function") globalThis.gc();
    return process.memoryUsage();
}

function runTaskInChild(input) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const child = fork(BOOTSTRAP_PATH, [], {
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        // Discard child output but watch for overflow warnings.
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

// === Hot loop: zero formatting / verdict / table emission ===

const all = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
process.stdout.write(`[bare] gc available: ${typeof globalThis.gc === "function"}\n`);

const baseline = snap();
process.stdout.write(`[bare] baseline rss=${baseline.rss} external=${baseline.external}\n`);

const perTask = [];

for (let ti = 0; ti < TARGETS.length; ti++) {
    const id = TARGETS[ti];
    const task = all.find(t => t.instance_id === id);
    if (!task) { process.stderr.write(`MISSING ${id}\n`); continue; }

    const preTask = snap();
    process.stdout.write(`[bare] task${ti + 1}/${TARGETS.length} ${id} pre rss=${preTask.rss} external=${preTask.external}\n`);

    const { output, exitCode, signal, error, wallMs } = await runTaskInChild({
        task,
        workspaceRoot: WORKSPACE,
        topK: 10,
        voyageKey: "",
        runnersList: RUNNERS_LIST,
    });

    const postTask = snap();
    process.stdout.write(`[bare] task${ti + 1}/${TARGETS.length} ${id} post rss=${postTask.rss} external=${postTask.external} exit=${exitCode} signal=${signal} wall=${wallMs}\n`);

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
        crashError: error ? String(error.message) : null,
    });
}

// FINAL snapshot taken IMMEDIATELY after the last task's post-snap,
// before any verdict-emission allocations.
const finalSnap = snap();
process.stdout.write(`[bare] FINAL rss=${finalSnap.rss} external=${finalSnap.external}\n`);

process.stdout.write = originalStdoutWrite;
process.stdout.write = makeSpy(originalStdoutWrite); // reattach so any late post-snap warning is caught

// === Verdict emission (after final snap is locked in) ===

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

const totalDriftMB = (finalSnap.rss - baseline.rss) / 1024 / 1024;
const externalDriftMB = (finalSnap.external - baseline.external) / 1024 / 1024;
const childLeaks = perTask.filter(t => t.exitCode !== 0).length;
const childCrashes = perTask.filter(t => t.crashError !== null).length;

console.log("\n=== SPRINT 4.9.9 MUI BARE-MEASUREMENT SANITY ===");
console.log(`tasks completed: ${perTask.length}/${TARGETS.length}`);
console.log(`child leaks (exit != 0): ${childLeaks}`);
console.log(`child crashes (IPC error / uncaught throw): ${childCrashes}`);
console.log(`overflow warnings: ${overflowWarnings.length}`);
console.log(`baseline RSS: ${mb(baseline.rss)} MB  external: ${mb(baseline.external)} MB`);
console.log(`final RSS:    ${mb(finalSnap.rss)} MB  external: ${mb(finalSnap.external)} MB`);
console.log(`RSS drift baseline -> final:     ${totalDriftMB.toFixed(1)} MB`);
console.log(`external drift baseline -> final: ${externalDriftMB.toFixed(1)} MB`);

console.log("\n--- per-task summary ---");
console.log("  task                                  exit  wall(s)  pre(MB)  post(MB)  RSSdel(MB)  extDel(MB)");
for (const m of perTask) {
    console.log(
        `  ${m.task.padEnd(36)} ${String(m.exitCode).padStart(4)}  ${(m.wallMs / 1000).toFixed(1).padStart(6)}  ${mb(m.rssBefore).padStart(7)}  ${mb(m.rssAfter).padStart(8)}  ${mb(m.rssDelta).padStart(10)}  ${mb(m.externalDelta).padStart(10)}`,
    );
}

const PASS_ALL_COMPLETE = perTask.length === TARGETS.length;
const PASS_NO_LEAKS = childLeaks === 0;
const PASS_NO_CRASH = childCrashes === 0;
const PASS_NO_WARNINGS = overflowWarnings.length === 0;
const PASS_RSS_PLANA = Math.abs(totalDriftMB) <= 20;
const PASS_EXTERNAL_PLANA = Math.abs(externalDriftMB) <= 20;
const ALL = PASS_ALL_COMPLETE && PASS_NO_LEAKS && PASS_NO_CRASH
    && PASS_NO_WARNINGS && PASS_RSS_PLANA && PASS_EXTERNAL_PLANA;

console.log("\n--- gates (Sprint 4.9.9 bare measurement, Furia round 29) ---");
console.log(`  3/3 mui tasks complete:                          ${PASS_ALL_COMPLETE ? "PASS" : "FAIL"} (${perTask.length}/${TARGETS.length})`);
console.log(`  no child leaks (all exit code 0):                ${PASS_NO_LEAKS ? "PASS" : "FAIL"} (${childLeaks})`);
console.log(`  no child crashes / IPC failures:                 ${PASS_NO_CRASH ? "PASS" : "FAIL"} (${childCrashes})`);
console.log(`  no "max 65535" / "too many references":          ${PASS_NO_WARNINGS ? "PASS" : "FAIL"} (${overflowWarnings.length})`);
console.log(`  main-thread RSS plana (|drift| <= 20 MB):        ${PASS_RSS_PLANA ? "PASS" : "FAIL"} (${totalDriftMB.toFixed(1)} MB)`);
console.log(`  main-thread external plana (|drift| <= 20 MB):   ${PASS_EXTERNAL_PLANA ? "PASS" : "FAIL"} (${externalDriftMB.toFixed(1)} MB)`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);
process.exit(ALL ? 0 : 1);
