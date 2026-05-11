/**
 * scripts/eval-phase5/report.ts
 *
 * Console table renderer + JSON serializer for the C.4.A
 * AggregateReport. Pure presentation -- no metric computation
 * (that lives in metrics.ts) and no I/O business logic (that
 * lives in orchestrate.ts).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AggregateReport } from "./orchestrate.js";

function pad(s: string, w: number, leftAlign = true): string {
    if (s.length >= w) return s.slice(0, w);
    const fill = " ".repeat(w - s.length);
    return leftAlign ? s + fill : fill + s;
}

function fmtNum(n: number, decimals = 3): string {
    if (Number.isNaN(n)) return "NaN";
    if (!Number.isFinite(n)) return n > 0 ? "+Inf" : "-Inf";
    return n.toFixed(decimals);
}

function fmtMs(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    return Math.round(n).toString() + "ms";
}

/**
 * Print the AggregateReport as a per-runner console table plus a
 * brief task-completion footer. Goes to stdout via console.log.
 */
export function printConsoleSummary(report: AggregateReport): void {
    console.log("");
    console.log("======================================================================");
    console.log(`Phase 5 C.4.A aggregate report`);
    console.log(`Tasks attempted: ${report.total_tasks_attempted}`);
    console.log(`Tasks completed: ${report.total_tasks_completed}`);
    console.log("======================================================================");
    console.log("");

    const header =
        `${pad("Runner", 16)} | ${pad("recall_mean", 12, false)} | ${pad("chunk_mean", 11, false)} | ${pad("tok_mean", 9, false)} | ${pad("p50_ms", 8, false)} | ${pad("p95_ms", 8, false)} | ${pad("p99_ms", 8, false)} | ${pad("err%", 6, false)}`;
    console.log(header);
    console.log("-".repeat(header.length));

    const runners = Object.keys(report.per_runner).sort();
    for (const r of runners) {
        const s = report.per_runner[r];
        const line =
            `${pad(r, 16)} | ${pad(fmtNum(s.first_hit_recall_mean), 12, false)} | ${pad(fmtNum(s.strict_chunk_containment_mean), 11, false)} | ${pad(fmtNum(s.token_cost_mean, 1), 9, false)} | ${pad(fmtMs(s.latency_ms_p50), 8, false)} | ${pad(fmtMs(s.latency_ms_p95), 8, false)} | ${pad(fmtMs(s.latency_ms_p99), 8, false)} | ${pad(fmtNum(s.error_rate * 100, 1), 6, false)}`;
        console.log(line);
    }

    console.log("");
    console.log("Per-task summary:");
    for (const t of report.per_task) {
        if (t.error) {
            console.log(`  ${t.instance_id}: TASK ERROR -- ${t.error}`);
            continue;
        }
        const runnerNames = Object.keys(t.runners).sort();
        const okRunners = runnerNames.filter(n => !t.runners[n].result.error);
        console.log(`  ${t.instance_id} (${t.repo}): ${okRunners.length}/${runnerNames.length} runners ok`);
        for (const n of runnerNames) {
            const rs = t.runners[n];
            if (rs.result.error) {
                console.log(`    ${pad(n, 16)} ERROR: ${rs.result.error.slice(0, 80)}`);
            } else {
                console.log(
                    `    ${pad(n, 16)} recall=${fmtNum(rs.metrics.first_hit_recall, 0)} chunk=${fmtNum(rs.metrics.strict_chunk_containment)} tok=${rs.metrics.token_cost} lat=${rs.metrics.latency_ms}ms`,
                );
            }
        }
    }
    console.log("");
}

/**
 * Serialize the report to a JSON file. Returns the absolute path
 * written. Parent directory is created if missing.
 */
export async function writeJsonReport(
    report: AggregateReport,
    outputPath: string,
): Promise<string> {
    const abs = path.resolve(outputPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(report, null, 2), "utf-8");
    return abs;
}
