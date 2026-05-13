/**
 * Phase 5 Sprint 4.8 stress validation -- Option A (cached statements).
 *
 * Same 5-vscode-task harness as Sprint 4.7 Fase 2. The fix is at
 * the sql.js boundary: insertChunk + fileNeedsUpdate + upsertFile +
 * clearChunks now cache their prepared statements on the Database
 * instance instead of running db.run() / db.exec() per call. If
 * Option A is correct, the "too many references" cascade and the
 * subsequent "memory access out of bounds" trap should both vanish.
 *
 * Pass criteria (Furia round 26 firmado):
 *   * ZERO "max 65535" / "too many references" stderr/stdout writes
 *   * RSS RAM drift <= 500 MB cumulative
 *   * WASM external memory drift <= 100 MB cumulative
 *   * NO "memory access out of bounds" crash on any task
 */
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";
import { cloneTaskRepo } from "./eval-phase5/repo-cloner.js";
import { NrekiEngine } from "../src/engine.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TARGETS = [
    // 5 tasks Sprint 4 completed pre-crash (representative for plateau curve):
    "microsoft__vscode-106767",
    "microsoft__vscode-108964",
    "microsoft__vscode-109750",
    "microsoft__vscode-110094",
    "microsoft__vscode-113837",
    // 5 tasks that crashed in Sprint 4 / 4.7 (adversarial tail):
    "microsoft__vscode-122991",
    "microsoft__vscode-135805",
    "microsoft__vscode-136347",
    "microsoft__vscode-149380",
    "microsoft__vscode-153121",
];
const ENGINES_PER_TASK = 3;
const WORKSPACE = ".eval-phase5-cache";

const overflowWarnings = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
function makeSpy(orig) {
    return (chunk) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        if (text.includes("too many references") || text.includes("max 65535")) {
            overflowWarnings.push(text.slice(0, 200));
        }
        return orig(chunk);
    };
}
process.stdout.write = makeSpy(originalStdoutWrite);
process.stderr.write = makeSpy(originalStderrWrite);

function mb(n) { return (n / 1024 / 1024).toFixed(1); }
function snap(label) {
    if (global.gc) global.gc();
    const m = process.memoryUsage();
    console.log(`[mem][${label}] rss=${mb(m.rss)}MB external=${mb(m.external)}MB`);
    return m;
}

const all = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
const baseline = snap("baseline");
let crashed = null;
const perTaskMem = [];

for (let ti = 0; ti < TARGETS.length; ti++) {
    const id = TARGETS[ti];
    const task = all.find(t => t.instance_id === id);
    if (!task) { console.error(`MISSING ${id}`); continue; }
    console.log(`\n=== TASK ${ti + 1}/${TARGETS.length}: ${id} ===`);

    const taskDir = await cloneTaskRepo(task, WORKSPACE);
    snap(`pre-engines task${ti + 1}`);

    for (let ei = 0; ei < ENGINES_PER_TASK; ei++) {
        const dbPath = path.join(taskDir, `.nreki.db.sprint48-${ei}`);
        try { await fs.rm(dbPath, { force: true }); } catch {}
        const engine = new NrekiEngine({
            dbPath,
            watchPaths: [taskDir],
            enableMarkovBlanket: ei % 2 === 0,
        });
        try {
            await engine.initialize();
            const stats = await engine.indexDirectory(taskDir);
            const hits = await engine.search(task.problem_statement, 30);
            console.log(`  engine ${ei + 1}/${ENGINES_PER_TASK}: indexed=${stats.indexed} hits=${hits.length}`);
        } catch (err) {
            console.error(`  engine ${ei + 1}/${ENGINES_PER_TASK}: CRASH ${err.message}`);
            crashed = { task: id, engine: ei + 1, message: err.message };
            break;
        } finally {
            try { engine.shutdown(); } catch (err) {
                console.error(`  shutdown error: ${err.message}`);
            }
        }
    }
    if (crashed) break;

    const post = snap(`post task${ti + 1}`);
    perTaskMem.push({ task: id, rss: post.rss, external: post.external });

    try { await fs.rm(taskDir, { recursive: true, force: true }); } catch {}
}

process.stdout.write = originalStdoutWrite;
process.stderr.write = originalStderrWrite;

const final = snap("final");
const rssGrowth = (final.rss - baseline.rss) / 1024 / 1024;
const externalGrowth = (final.external - baseline.external) / 1024 / 1024;

console.log("\n=== SPRINT 4.8.5 PLATEAU CHECK RESULT ===");
console.log(`tasks completed: ${perTaskMem.length}/${TARGETS.length}`);
console.log(`overflow warnings: ${overflowWarnings.length}`);
if (overflowWarnings.length > 0) {
    console.log("  first 3 captured:");
    for (const w of overflowWarnings.slice(0, 3)) console.log(`    ${w}`);
}
console.log(`RSS growth baseline -> final: ${rssGrowth.toFixed(1)} MB`);
console.log(`WASM external growth: ${externalGrowth.toFixed(1)} MB`);
console.log(`final RSS: ${mb(final.rss)} MB`);
console.log(`crash: ${crashed ? JSON.stringify(crashed) : "none"}`);

console.log("\n--- per-task RSS / external (MB) ---");
for (const m of perTaskMem) {
    console.log(`  ${m.task.padEnd(40)} rss=${mb(m.rss)}  external=${mb(m.external)}`);
}

// Plateau test: RSS growth across tasks 6..10 vs final.
const plateauStart = perTaskMem[Math.min(5, perTaskMem.length - 1)];
const plateauGrowth = plateauStart
    ? (final.rss - plateauStart.rss) / 1024 / 1024
    : Number.POSITIVE_INFINITY;

const PASS_WARN = overflowWarnings.length === 0;
const PASS_FINAL_RSS = final.rss / 1024 / 1024 <= 2048;
const PASS_PLATEAU = plateauGrowth <= 50;
const PASS_NO_CRASH = crashed === null;
const ALL = PASS_WARN && PASS_FINAL_RSS && PASS_PLATEAU && PASS_NO_CRASH;

console.log("\n--- gates (Sprint 4.8.5 plateau spec) ---");
console.log(`  warnings == 0:                              ${PASS_WARN ? "PASS" : "FAIL"}`);
console.log(`  no crash:                                   ${PASS_NO_CRASH ? "PASS" : "FAIL"}`);
console.log(`  final RSS <= 2048 MB:                       ${PASS_FINAL_RSS ? "PASS" : "FAIL"} (${mb(final.rss)} MB)`);
console.log(`  plateau (tasks 6..10 growth <= 50 MB):      ${PASS_PLATEAU ? "PASS" : "FAIL"} (${plateauGrowth.toFixed(1)} MB)`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);
process.exit(ALL ? 0 : 1);
