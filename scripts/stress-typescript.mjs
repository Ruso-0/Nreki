/**
 * stress-typescript.mjs — Stress test NREKI kernel against the TypeScript compiler repo.
 *
 * Boots the kernel on src/compiler (77 files, 54K-line checker.ts),
 * then tests valid edits, type-breaking edits, and TTRD regression detection.
 */

import { NrekiKernel } from "../dist/kernel/nreki-kernel.js";
import * as fs from "fs";
import * as path from "path";

// Resolve to Windows-native path (Git Bash /tmp maps to C:\Users\...\AppData\Local\Temp)
import { resolve } from "path";
const PROJECT_ROOT = resolve(process.env.TEMP || process.env.TMP || "/tmp", "typescript-stress-test", "src", "compiler");
const TARGET_FILE = "corePublic.ts";

const results = {
    bootTime: null,
    filesTracked: null,
    baselineErrors: null,
    ramAtBoot: null,
    validEditLatency: null,
    validEditSafe: null,
    breakingEditLatency: null,
    breakingEditSafe: null,
    breakingEditErrors: null,
    ttrdLatency: null,
    ttrdRegressionsDetected: null,
    ttrdDetails: null,
    ramAtEnd: null,
};

function mb(bytes) {
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatTable(r) {
    const lines = [
        "",
        "+---------------------------------------------+---------------------------+",
        "| Metric                                      | Value                     |",
        "+---------------------------------------------+---------------------------+",
        `| Boot time                                   | ${String(r.bootTime ?? "FAILED").padEnd(25)} |`,
        `| Files tracked                               | ${String(r.filesTracked ?? "N/A").padEnd(25)} |`,
        `| Baseline errors                             | ${String(r.baselineErrors ?? "N/A").padEnd(25)} |`,
        `| RAM at boot                                 | ${String(r.ramAtBoot ?? "N/A").padEnd(25)} |`,
        `| Valid edit latency                          | ${String(r.validEditLatency ?? "FAILED").padEnd(25)} |`,
        `| Valid edit safe                             | ${String(r.validEditSafe ?? "N/A").padEnd(25)} |`,
        `| Breaking edit latency                       | ${String(r.breakingEditLatency ?? "FAILED").padEnd(25)} |`,
        `| Breaking edit safe                          | ${String(r.breakingEditSafe ?? "N/A").padEnd(25)} |`,
        `| Breaking edit errors caught                 | ${String(r.breakingEditErrors ?? "N/A").padEnd(25)} |`,
        `| TTRD latency                                | ${String(r.ttrdLatency ?? "FAILED").padEnd(25)} |`,
        `| TTRD regression detected                    | ${String(r.ttrdRegressionsDetected ?? "N/A").padEnd(25)} |`,
        `| TTRD details                                | ${String(r.ttrdDetails ?? "N/A").padEnd(25)} |`,
        `| RAM at end                                  | ${String(r.ramAtEnd ?? "N/A").padEnd(25)} |`,
        "+---------------------------------------------+---------------------------+",
    ];
    return lines.join("\n");
}

// ─── Step 2: Boot ────────────────────────────────────────────────────

console.log("=== NREKI Kernel Stress Test: TypeScript Compiler ===\n");
console.log(`Project: ${PROJECT_ROOT}`);
console.log(`Target file: ${TARGET_FILE}\n`);

let kernel;

try {
    console.log("[Step 2] Booting kernel on TypeScript compiler...");
    const t0 = performance.now();

    kernel = new NrekiKernel();

    // Set a 120s timeout
    const timeoutId = setTimeout(() => {
        console.error("FATAL: Boot exceeded 120 seconds. Aborting.");
        process.exit(1);
    }, 120_000);

    kernel.boot(PROJECT_ROOT);
    clearTimeout(timeoutId);

    const bootMs = performance.now() - t0;
    results.bootTime = (bootMs / 1000).toFixed(2) + "s";
    results.filesTracked = kernel.getTrackedFiles();
    results.baselineErrors = kernel.getBaselineErrorCount();
    results.ramAtBoot = mb(process.memoryUsage().heapUsed);

    console.log(`  Boot time: ${results.bootTime}`);
    console.log(`  Files tracked: ${results.filesTracked}`);
    console.log(`  Baseline errors: ${results.baselineErrors}`);
    console.log(`  RAM: ${results.ramAtBoot}`);
    console.log("");
} catch (err) {
    console.error(`[Step 2] BOOT FAILED: ${err.message}`);
    console.error(err.stack);
    results.bootTime = `FAILED: ${err.message.substring(0, 60)}`;
    results.ramAtBoot = mb(process.memoryUsage().heapUsed);
    console.log(formatTable(results));
    process.exit(1);
}

// ─── Step 3: Valid edit ──────────────────────────────────────────────

try {
    console.log("[Step 3] Valid edit test (harmless string change)...");

    const filePath = path.resolve(PROJECT_ROOT, TARGET_FILE);
    const original = fs.readFileSync(filePath, "utf-8");

    // Change the version string: "6.0" -> "6.1" (harmless literal change)
    const modified = original.replace(
        'export const versionMajorMinor = "6.0"',
        'export const versionMajorMinor = "6.1"',
    );

    if (modified === original) {
        throw new Error("String replacement did not match — file format changed?");
    }

    const t0 = performance.now();
    const result = await kernel.interceptAtomicBatch([
        { targetFile: filePath, proposedContent: modified },
    ]);
    const latencyMs = performance.now() - t0;

    results.validEditLatency = latencyMs.toFixed(0) + "ms";
    results.validEditSafe = result.safe;

    console.log(`  Safe: ${result.safe}`);
    console.log(`  Latency: ${results.validEditLatency}`);
    if (result.errorText) console.log(`  Note: ${result.errorText.substring(0, 100)}`);
    console.log("");

    // Rollback so we start clean for next test
    await kernel.rollbackAll();
} catch (err) {
    console.error(`[Step 3] VALID EDIT FAILED: ${err.message}`);
    console.error(err.stack);
    results.validEditLatency = `FAILED: ${err.message.substring(0, 60)}`;
    try { await kernel.rollbackAll(); } catch {}
}

// ─── Step 4: Type-breaking edit ──────────────────────────────────────

try {
    console.log("[Step 4] Type-breaking edit test (change return type)...");

    const filePath = path.resolve(PROJECT_ROOT, TARGET_FILE);
    const original = fs.readFileSync(filePath, "utf-8");

    // Change `versionMajorMinor` type from string literal to number.
    // Original: export const versionMajorMinor = "6.0";
    // Modified: export const versionMajorMinor: number = 999;
    // This should break the template literal: `${versionMajorMinor}.0-dev`
    const modified = original.replace(
        'export const versionMajorMinor = "6.0"',
        'export const versionMajorMinor: number = 999',
    );

    if (modified === original) {
        throw new Error("String replacement did not match — file format changed?");
    }

    const t0 = performance.now();
    const result = await kernel.interceptAtomicBatch([
        { targetFile: filePath, proposedContent: modified },
    ]);
    const latencyMs = performance.now() - t0;

    results.breakingEditLatency = latencyMs.toFixed(0) + "ms";
    results.breakingEditSafe = result.safe;
    results.breakingEditErrors = result.structured?.length ?? 0;

    console.log(`  Safe: ${result.safe} (expected: false)`);
    console.log(`  Errors caught: ${results.breakingEditErrors}`);
    console.log(`  Latency: ${results.breakingEditLatency}`);
    if (result.structured?.length > 0) {
        for (const e of result.structured.slice(0, 5)) {
            console.log(`    → ${e.file}:${e.line} ${e.code} - ${e.message.substring(0, 80)}`);
        }
        if (result.structured.length > 5) {
            console.log(`    ... and ${result.structured.length - 5} more`);
        }
    }
    console.log("");

    // Rollback
    await kernel.rollbackAll();
} catch (err) {
    console.error(`[Step 4] BREAKING EDIT FAILED: ${err.message}`);
    console.error(err.stack);
    results.breakingEditLatency = `FAILED: ${err.message.substring(0, 60)}`;
    try { await kernel.rollbackAll(); } catch {}
}

// ─── Step 5: TTRD test ───────────────────────────────────────────────

try {
    console.log("[Step 5] TTRD test (change type to any)...");

    const filePath = path.resolve(PROJECT_ROOT, TARGET_FILE);
    const original = fs.readFileSync(filePath, "utf-8");

    // Change: export const version: string = ...
    // To:     export const version: any = ...
    // This weakens the type from string to any — TTRD should flag it.
    const modified = original.replace(
        "export const version: string =",
        "export const version: any =",
    );

    if (modified === original) {
        throw new Error("String replacement did not match — file format changed?");
    }

    const t0 = performance.now();
    const result = await kernel.interceptAtomicBatch([
        { targetFile: filePath, proposedContent: modified },
    ]);
    const latencyMs = performance.now() - t0;

    results.ttrdLatency = latencyMs.toFixed(0) + "ms";
    results.ttrdRegressionsDetected = result.regressions
        ? `YES (${result.regressions.length})`
        : "NO";

    if (result.regressions?.length > 0) {
        const r = result.regressions[0];
        results.ttrdDetails = `${r.symbol}: ${r.oldType.substring(0, 15)} -> ${r.newType}`;
    } else {
        results.ttrdDetails = "none";
    }

    console.log(`  Safe: ${result.safe}`);
    console.log(`  Regressions: ${results.ttrdRegressionsDetected}`);
    if (result.regressions) {
        for (const r of result.regressions) {
            console.log(`    → ${r.symbol}: "${r.oldType}" -> "${r.newType}"`);
        }
    }
    console.log(`  Latency: ${results.ttrdLatency}`);
    console.log("");

    await kernel.rollbackAll();
} catch (err) {
    console.error(`[Step 5] TTRD TEST FAILED: ${err.message}`);
    console.error(err.stack);
    results.ttrdLatency = `FAILED: ${err.message.substring(0, 60)}`;
    try { await kernel.rollbackAll(); } catch {}
}

// ─── Step 6: Cross-file type breakage ────────────────────────────────

const CROSSFILE_TARGET = "utilities.ts";

const crossFileResults = {
    latency: null,
    safe: null,
    errorCount: null,
    affectedFiles: null,
    details: null,
};

try {
    console.log("[Step 6] Cross-file type breakage (getFullWidth: number -> string)...");
    console.log("  Target: utilities.ts:getFullWidth — used in parser.ts line 4005");

    const filePath = path.resolve(PROJECT_ROOT, CROSSFILE_TARGET);
    const original = fs.readFileSync(filePath, "utf-8");

    // Change: export function getFullWidth(node: Node): number {
    // To:     export function getFullWidth(node: Node): string {
    //         return String(node.end - node.pos);
    //
    // This makes getFullWidth return string instead of number.
    // parser.ts uses `getFullWidth(name) === 0` — comparing string to number → TS error.
    // Note: TypeScript repo uses CRLF, so match with regex to handle either line ending.
    const modified = original.replace(
        /export function getFullWidth\(node: Node\): number \{\r?\n    return node\.end - node\.pos;\r?\n\}/,
        "export function getFullWidth(node: Node): string {\n    return String(node.end - node.pos);\n}",
    );

    if (modified === original) {
        throw new Error("String replacement did not match — file format may differ (line endings?)");
    }

    const t0 = performance.now();
    const result = await kernel.interceptAtomicBatch([
        { targetFile: filePath, proposedContent: modified },
    ]);
    const latencyMs = performance.now() - t0;

    crossFileResults.latency = latencyMs.toFixed(0) + "ms";
    crossFileResults.safe = result.safe;
    crossFileResults.errorCount = result.structured?.length ?? 0;

    // Collect affected files from structured errors
    if (result.structured?.length > 0) {
        const fileSet = new Set(result.structured.map(e => e.file));
        crossFileResults.affectedFiles = Array.from(fileSet);
    }

    console.log(`  Safe: ${result.safe} (expected: false)`);
    console.log(`  Errors caught: ${crossFileResults.errorCount}`);
    console.log(`  Latency: ${crossFileResults.latency}`);
    if (crossFileResults.affectedFiles) {
        console.log(`  Affected files: ${crossFileResults.affectedFiles.join(", ")}`);
    }
    if (result.structured?.length > 0) {
        for (const e of result.structured.slice(0, 10)) {
            console.log(`    → ${e.file}:${e.line} ${e.code} - ${e.message.substring(0, 100)}`);
        }
        if (result.structured.length > 10) {
            console.log(`    ... and ${result.structured.length - 10} more`);
        }
    }
    console.log("");

    // Rollback
    await kernel.rollbackAll();
} catch (err) {
    console.error(`[Step 6] CROSS-FILE BREAKAGE FAILED: ${err.message}`);
    console.error(err.stack);
    crossFileResults.latency = `FAILED: ${err.message.substring(0, 60)}`;
    try { await kernel.rollbackAll(); } catch {}
}

// ─── Step 7: Summary ─────────────────────────────────────────────────

results.ramAtEnd = mb(process.memoryUsage().heapUsed);

console.log("=== STRESS TEST COMPLETE ===");

// Extended table with cross-file results
function formatFullTable(r, xf) {
    const lines = [
        "",
        "+---------------------------------------------+------------------------------------------+",
        "| Metric                                      | Value                                    |",
        "+---------------------------------------------+------------------------------------------+",
        `| Boot time                                   | ${String(r.bootTime ?? "FAILED").padEnd(40)} |`,
        `| Files tracked                               | ${String(r.filesTracked ?? "N/A").padEnd(40)} |`,
        `| Baseline errors                             | ${String(r.baselineErrors ?? "N/A").padEnd(40)} |`,
        `| RAM at boot                                 | ${String(r.ramAtBoot ?? "N/A").padEnd(40)} |`,
        `| Valid edit latency                          | ${String(r.validEditLatency ?? "FAILED").padEnd(40)} |`,
        `| Valid edit safe                             | ${String(r.validEditSafe ?? "N/A").padEnd(40)} |`,
        `| Breaking edit latency                       | ${String(r.breakingEditLatency ?? "FAILED").padEnd(40)} |`,
        `| Breaking edit safe                          | ${String(r.breakingEditSafe ?? "N/A").padEnd(40)} |`,
        `| Breaking edit errors caught                 | ${String(r.breakingEditErrors ?? "N/A").padEnd(40)} |`,
        `| TTRD latency                                | ${String(r.ttrdLatency ?? "FAILED").padEnd(40)} |`,
        `| TTRD regression detected                    | ${String(r.ttrdRegressionsDetected ?? "N/A").padEnd(40)} |`,
        `| TTRD details                                | ${String(r.ttrdDetails ?? "N/A").padEnd(40)} |`,
        "+---------------------------------------------+------------------------------------------+",
        `| Cross-file breakage latency                 | ${String(xf.latency ?? "FAILED").padEnd(40)} |`,
        `| Cross-file breakage safe                    | ${String(xf.safe ?? "N/A").padEnd(40)} |`,
        `| Cross-file errors caught                    | ${String(xf.errorCount ?? "N/A").padEnd(40)} |`,
        `| Cross-file affected files                   | ${String((xf.affectedFiles ?? []).join(", ") || "N/A").padEnd(40)} |`,
        "+---------------------------------------------+------------------------------------------+",
        `| RAM at end                                  | ${String(r.ramAtEnd ?? "N/A").padEnd(40)} |`,
        "+---------------------------------------------+------------------------------------------+",
    ];
    return lines.join("\n");
}

console.log(formatFullTable(results, crossFileResults));
