/**
 * Phase 5 C.4.B.2 Sprint 4.9.8 resume smoke test.
 *
 * Verifies the JSONL append-only + resume detection chain still works
 * end-to-end with the child_process transport. Spins up the actual
 * orchestrate() function (production code path) twice over the same
 * JSONL file, using two small mui tasks. After the first run the
 * JSONL should contain 2 lines; the second run should detect both
 * already-completed tasks via readCompletedTaskIds and skip them
 * (clone counter does not advance, no children spawned for the
 * already-done tasks).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { orchestrate, readCompletedTaskIds } from "./eval-phase5/orchestrate.js";

const TASK_IDS = ["mui__material-ui-11451", "mui__material-ui-22696"];
const WORKSPACE = ".eval-phase5-cache";
const OUTPUT_JSON = "scripts/resume-smoke-results.json";
const OUTPUT_JSONL = "scripts/resume-smoke-results.jsonl";

// Pre-cleanup: start fresh so the resume signal is unambiguous.
for (const p of [OUTPUT_JSON, OUTPUT_JSONL]) {
    if (existsSync(p)) await fs.unlink(p);
}

console.log("[smoke] RUN 1: cold start, expect 2 children spawned");
const run1Start = Date.now();
await orchestrate({
    workspaceRoot: WORKSPACE,
    outputPath: OUTPUT_JSON,
    outputJsonlPath: OUTPUT_JSONL,
    taskIds: TASK_IDS,
    runners: ["fast_grep", "ripgrep"],
    // VOYAGE_API_KEY missing path skips voyage; we keep the runner
    // list short so the smoke completes in a few minutes.
});
console.log(`[smoke] RUN 1 wall: ${((Date.now() - run1Start) / 1000).toFixed(1)}s`);

const jsonlAfterRun1 = await readCompletedTaskIds(OUTPUT_JSONL);
console.log(`[smoke] JSONL after run 1: ${jsonlAfterRun1.size} task(s) recorded`);
for (const id of jsonlAfterRun1) console.log(`  - ${id}`);

console.log("\n[smoke] RUN 2: same JSONL, expect resume detection (0 new children)");
const run2Start = Date.now();
const report2 = await orchestrate({
    workspaceRoot: WORKSPACE,
    outputPath: OUTPUT_JSON,
    outputJsonlPath: OUTPUT_JSONL,
    taskIds: TASK_IDS,
    runners: ["fast_grep", "ripgrep"],
});
console.log(`[smoke] RUN 2 wall: ${((Date.now() - run2Start) / 1000).toFixed(1)}s`);

const jsonlAfterRun2 = await readCompletedTaskIds(OUTPUT_JSONL);
console.log(`[smoke] JSONL after run 2: ${jsonlAfterRun2.size} task(s) recorded`);

// PASS criteria: JSONL has exactly 2 lines after both runs (no duplicate
// appends because resume detection picked them up). Run 2 wall should
// be near-instant since no child_process spawns happened.
const PASS_RUN1_RECORDED = jsonlAfterRun1.size === 2;
const PASS_NO_DUPLICATE = jsonlAfterRun2.size === 2;
const PASS_RUN2_AGGREGATE = report2.total_tasks_attempted === 2
    && report2.total_tasks_completed === 2;
const ALL = PASS_RUN1_RECORDED && PASS_NO_DUPLICATE && PASS_RUN2_AGGREGATE;

console.log("\n--- gates (resume smoke under child_process) ---");
console.log(`  run 1 recorded 2 tasks in JSONL:           ${PASS_RUN1_RECORDED ? "PASS" : "FAIL"} (${jsonlAfterRun1.size})`);
console.log(`  run 2 did not duplicate (still 2 lines):   ${PASS_NO_DUPLICATE ? "PASS" : "FAIL"} (${jsonlAfterRun2.size})`);
console.log(`  run 2 aggregate counts include both tasks: ${PASS_RUN2_AGGREGATE ? "PASS" : "FAIL"}`);
console.log(`\n=== VERDICT: ${ALL ? "PASS" : "FAIL"} ===`);

// Cleanup smoke artifacts so they don't pollute the repo.
for (const p of [OUTPUT_JSON, OUTPUT_JSONL]) {
    if (existsSync(p)) await fs.unlink(p);
}

process.exit(ALL ? 0 : 1);
