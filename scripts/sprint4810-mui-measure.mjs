/**
 * Sprint 4.8.10 — empirical mui-workspace memory growth measurement.
 *
 * Sprint 4.8.5 measured 10 vscode tasks: ~30 MB RSS / task linear.
 * Sprint 4.8.10 measures 3 mui tasks at different PR eras to test
 * whether the per-task growth scales with workspace size or is
 * roughly constant. That answers whether the C.4.B projection of
 * ~3 GB residual (assuming mui at ~10 MB/task) is realistic, or
 * whether mui itself adds large per-task overhead.
 *
 * Pure measurement — NO fix, NO gate threshold to pass/fail.
 * Output is the empirical curve. Auditor decides Path A/B/C.
 */
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./eval-phase5/polybench-loader.js";
import { cloneTaskRepo } from "./eval-phase5/repo-cloner.js";
import { NrekiEngine } from "../src/engine.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const TARGETS = [
    "mui__material-ui-11451",  // PR 11451 — early era (alphabetical first of 70)
    "mui__material-ui-22696",  // PR 22696 — mid era
    "mui__material-ui-42412",  // PR 42412 — late era (alphabetical last of 70)
];
const ENGINES_PER_TASK = 3;
const WORKSPACE = ".eval-phase5-cache";

const overflowWarnings = [];
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);
function spy(orig) {
    return (chunk) => {
        const t = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
        if (t.includes("too many references") || t.includes("max 65535")) overflowWarnings.push(t.slice(0, 200));
        return orig(chunk);
    };
}
process.stdout.write = spy(origStdout);
process.stderr.write = spy(origStderr);

function mb(n) { return (n / 1024 / 1024).toFixed(1); }
function snap(label) {
    if (global.gc) global.gc();
    const m = process.memoryUsage();
    console.log(`[mem][${label}] rss=${mb(m.rss)}MB external=${mb(m.external)}MB`);
    return m;
}

const all = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
const baseline = snap("baseline");
const perTask = [];

for (let ti = 0; ti < TARGETS.length; ti++) {
    const id = TARGETS[ti];
    const task = all.find(t => t.instance_id === id);
    if (!task) { console.error(`MISSING ${id}`); continue; }
    console.log(`\n=== TASK ${ti + 1}/${TARGETS.length}: ${id} ===`);

    const tStart = Date.now();
    const taskDir = await cloneTaskRepo(task, WORKSPACE);
    const pre = snap(`pre-engines task${ti + 1}`);

    let totalChunks = 0;
    for (let ei = 0; ei < ENGINES_PER_TASK; ei++) {
        const dbPath = path.join(taskDir, `.nreki.db.sprint4810-${ei}`);
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
            totalChunks += stats.indexed;
            console.log(`  engine ${ei + 1}/${ENGINES_PER_TASK}: indexed=${stats.indexed} hits=${hits.length}`);
        } catch (err) {
            console.error(`  engine ${ei + 1}/${ENGINES_PER_TASK}: ERROR ${err.message}`);
        } finally {
            try { engine.shutdown(); } catch {}
        }
    }
    const post = snap(`post task${ti + 1}`);
    const wallMs = Date.now() - tStart;
    perTask.push({
        task: id,
        pre_rss: pre.rss,
        post_rss: post.rss,
        delta_rss_mb: (post.rss - pre.rss) / 1024 / 1024,
        post_external_mb: post.external / 1024 / 1024,
        chunks: totalChunks,
        wall_seconds: wallMs / 1000,
    });

    try { await fs.rm(taskDir, { recursive: true, force: true }); } catch {}
}

process.stdout.write = origStdout;
process.stderr.write = origStderr;

const final = snap("final");
const totalGrowthMb = (final.rss - baseline.rss) / 1024 / 1024;

console.log("\n=== SPRINT 4.8.10 mui RESULT ===");
console.log(`overflow warnings: ${overflowWarnings.length}`);
console.log(`baseline RSS: ${mb(baseline.rss)} MB`);
console.log(`final RSS:    ${mb(final.rss)} MB`);
console.log(`total growth: ${totalGrowthMb.toFixed(1)} MB`);

console.log("\n--- per-mui-task profile ---");
console.log("task                                 | indexed | wall(s) | Δrss(MB) | post_external(MB)");
console.log("-".repeat(95));
for (const t of perTask) {
    console.log(
        `${t.task.padEnd(36)} | ${t.chunks.toString().padStart(7)} | ${t.wall_seconds.toFixed(1).padStart(7)} | ${t.delta_rss_mb.toFixed(1).padStart(8)} | ${t.post_external_mb.toFixed(1).padStart(15)}`,
    );
}

const muiAvgGrowth = perTask.reduce((s, t) => s + t.delta_rss_mb, 0) / perTask.length;
console.log(`\nmui per-task avg Δrss: ${muiAvgGrowth.toFixed(1)} MB`);

// C.4.B projection -- mix Sprint 4.8.5 vscode empirical with this mui empirical.
const vscodeRemaining = 13;
const vscodePerTask = 30;             // Sprint 4.8.5 empirical
const muiRemaining = 70;
const smallTasks = 3 + 3 + 1;         // tailwind + code-server + angular
const smallPerTask = 5;               // assumption
const baselineMb = 80;
const projectedMb =
    baselineMb +
    vscodeRemaining * vscodePerTask +
    muiRemaining * muiAvgGrowth +
    smallTasks * smallPerTask;
const projectedGb = projectedMb / 1024;

console.log("\n=== C.4.B 100-task projection ===");
console.log(`  baseline:           ${baselineMb} MB`);
console.log(`  vscode 13 × 30 MB:  ${vscodeRemaining * vscodePerTask} MB (Sprint 4.8.5 empirical)`);
console.log(`  mui 70 × ${muiAvgGrowth.toFixed(1)} MB:  ${(muiRemaining * muiAvgGrowth).toFixed(0)} MB (THIS sprint empirical)`);
console.log(`  small 7 × 5 MB:     ${smallTasks * smallPerTask} MB (assumption)`);
console.log(`  ─────────────────────────────────`);
console.log(`  projected total:    ${projectedMb.toFixed(0)} MB = ${projectedGb.toFixed(2)} GB`);

console.log("\n=== Furia round 28 verdict ===");
if (projectedGb < 4) {
    console.log(`VERDICT: Path A APPROVED (<4 GB threshold satisfied)`);
} else if (projectedGb >= 10) {
    console.log(`VERDICT: Path B MANDATORY (≥10 GB threshold breached)`);
} else {
    console.log(`VERDICT: 4-10 GB band — discussion needed`);
}
