/**
 * NREKI Prisma Benchmark - Tests kernel against Prisma's deeply nested generated types.
 *
 * Boots NREKI kernel against prisma-test project (with @prisma/client generated types)
 * and runs simulated edits to verify type checking on complex ORM types.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=8192 npx tsx tests/prisma-benchmark.ts
 */

import * as path from "path";
import * as fs from "fs";
import {
    NrekiKernel,
    type NrekiInterceptResult,
} from "../src/kernel/nreki-kernel.js";
import { detectMode } from "../src/index.js";

// ─── Config ────────────────────────────────────────────────────────
const PRISMA_DIR = path.resolve("prisma-test");
const INDEX_PATH = path.join(PRISMA_DIR, "src", "index.ts");

// ─── Helpers ───────────────────────────────────────────────────────
function formatMB(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
    console.log("═══════════════════════════════════════════════════");
    console.log("  NREKI Prisma Deep Types Benchmark");
    console.log("═══════════════════════════════════════════════════\n");

    // Verify project exists
    if (!fs.existsSync(INDEX_PATH)) {
        console.error(`ERROR: ${INDEX_PATH} not found.`);
        console.error("Run the Prisma setup first.");
        process.exit(1);
    }

    // ── Phase 1: Mode Detection ────────────────────────────────────
    console.log("--- PHASE 1: Mode Detection ---");
    const detectStart = performance.now();
    const detectedMode = detectMode(PRISMA_DIR);
    const detectLatencyMs = (performance.now() - detectStart).toFixed(1);
    console.log(`Detected mode:     ${detectedMode}`);
    console.log(`Detection latency: ${detectLatencyMs}ms`);

    // Count TypeScript files
    let tsFileCount = 0;
    function countTs(dir: string) {
        const ignore = new Set(["node_modules", "dist", "build", ".git", ".prisma"]);
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory() && !ignore.has(entry.name) && !entry.name.startsWith(".")) {
                    countTs(path.join(dir, entry.name));
                } else if (/\.(ts|tsx)$/i.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                    tsFileCount++;
                }
            }
        } catch {}
    }
    countTs(PRISMA_DIR);
    console.log(`TS files (excl. node_modules): ${tsFileCount}`);

    // ── Phase 2: Boot ──────────────────────────────────────────────
    console.log("\n--- PHASE 2: Kernel Boot ---");
    const kernel = new NrekiKernel();

    // Force project mode for small projects
    const bootMode = "project";
    console.log(`Boot mode: ${bootMode} (forced for complete type checking)`);

    const memBefore = process.memoryUsage();
    const bootStart = performance.now();

    try {
        kernel.boot(PRISMA_DIR, bootMode);
    } catch (err: any) {
        console.error(`Boot failed: ${err.message}`);
        process.exit(1);
    }

    const bootTimeMs = performance.now() - bootStart;
    const bootTimeSec = (bootTimeMs / 1000).toFixed(2);
    const memAfter = process.memoryUsage();
    const heapDelta = memAfter.heapUsed - memBefore.heapUsed;
    const trackedFiles = kernel.getTrackedFiles();
    const baselineErrors = kernel.getBaselineErrorCount();

    console.log(`Boot time:        ${bootTimeSec}s`);
    console.log(`Files tracked:    ${trackedFiles}`);
    console.log(`Baseline errors:  ${baselineErrors}`);
    console.log(`Heap delta:       ${formatMB(heapDelta)}`);
    console.log(`RSS:              ${formatMB(memAfter.rss)}`);

    // ── Phase 3: Simulated Edits ───────────────────────────────────
    const indexContent = fs.readFileSync(INDEX_PATH, "utf-8");

    // ── Test A: Safe edit (add comment) ────────────────────────────
    console.log("\n--- TEST A: Safe Edit (append comment to index.ts) ---");
    const safeContent = indexContent + "\n// NREKI prisma benchmark\n";
    let resultA: NrekiInterceptResult;
    try {
        resultA = await kernel.interceptAtomicBatch([
            { targetFile: INDEX_PATH, proposedContent: safeContent },
        ]);
        console.log(`Safe:    ${resultA.safe}`);
        console.log(`Latency: ${resultA.latencyMs}ms`);
        console.log(`Errors:  ${resultA.structured?.length ?? 0}`);
        console.log(`Verdict: ${resultA.safe ? "PASS ✅" : "FAIL ❌"}`);
    } finally {
        await kernel.rollbackAll();
    }

    // ── Test B: Break Prisma type (wrong field in create) ──────────
    console.log("\n--- TEST B: Type Break (wrong field in Prisma create) ---");
    const brokenCreate = indexContent.replace(
        'email,\n      name,',
        'email,\n      name,\n      nonExistentField: "break",'
    );
    if (brokenCreate !== indexContent) {
        let resultB: NrekiInterceptResult;
        try {
            resultB = await kernel.interceptAtomicBatch([
                { targetFile: INDEX_PATH, proposedContent: brokenCreate },
            ]);
            console.log(`Safe:    ${resultB.safe}`);
            console.log(`Latency: ${resultB.latencyMs}ms`);
            console.log(`Errors:  ${resultB.structured?.length ?? 0}`);
            console.log(`Verdict: ${resultB.safe ? "MISSED ⚠️" : "CAUGHT ✅"}`);
            if (resultB.structured) {
                for (const err of resultB.structured.slice(0, 5)) {
                    console.log(`  → ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 120)}`);
                }
            }
        } finally {
            await kernel.rollbackAll();
        }
    } else {
        console.log("SKIP: regex did not match");
    }

    // ── Test C: Wrong return type (UserWithEverything → string) ────
    console.log("\n--- TEST C: Return Type Mismatch (UserWithEverything → string) ---");
    const brokenReturn = indexContent.replace(
        "): Promise<UserWithEverything> {",
        "): Promise<string> {"
    );
    if (brokenReturn !== indexContent) {
        let resultC: NrekiInterceptResult;
        try {
            resultC = await kernel.interceptAtomicBatch([
                { targetFile: INDEX_PATH, proposedContent: brokenReturn },
            ]);
            console.log(`Safe:    ${resultC.safe}`);
            console.log(`Latency: ${resultC.latencyMs}ms`);
            console.log(`Errors:  ${resultC.structured?.length ?? 0}`);
            console.log(`Verdict: ${resultC.safe ? "MISSED ⚠️" : "CAUGHT ✅"}`);
            if (resultC.structured) {
                for (const err of resultC.structured.slice(0, 5)) {
                    console.log(`  → ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 120)}`);
                }
            }
        } finally {
            await kernel.rollbackAll();
        }
    } else {
        console.log("SKIP: regex did not match");
    }

    // ── Test D: Break include shape (wrong nested include) ─────────
    console.log("\n--- TEST D: Nested Include Mismatch ---");
    const brokenInclude = indexContent.replace(
        "include: {\n      profile: true,\n      posts: {",
        "include: {\n      profile: true,\n      fakePosts: {"
    );
    if (brokenInclude !== indexContent) {
        let resultD: NrekiInterceptResult;
        try {
            resultD = await kernel.interceptAtomicBatch([
                { targetFile: INDEX_PATH, proposedContent: brokenInclude },
            ]);
            console.log(`Safe:    ${resultD.safe}`);
            console.log(`Latency: ${resultD.latencyMs}ms`);
            console.log(`Errors:  ${resultD.structured?.length ?? 0}`);
            console.log(`Verdict: ${resultD.safe ? "MISSED ⚠️" : "CAUGHT ✅"}`);
            if (resultD.structured) {
                for (const err of resultD.structured.slice(0, 5)) {
                    console.log(`  → ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 120)}`);
                }
            }
        } finally {
            await kernel.rollbackAll();
        }
    } else {
        console.log("SKIP: regex did not match");
    }

    // ── Test E: TTRD - Weaken a typed return to any ────────────────
    console.log("\n--- TEST E: TTRD Regression (typed return → any) ---");
    const weakenedReturn = indexContent.replace(
        "): Promise<PostWithDetails[]> {\n  return prisma.post.findMany",
        "): Promise<any> {\n  return prisma.post.findMany"
    );
    if (weakenedReturn !== indexContent) {
        let resultE: NrekiInterceptResult;
        try {
            resultE = await kernel.interceptAtomicBatch([
                { targetFile: INDEX_PATH, proposedContent: weakenedReturn },
            ]);
            const hasRegressions = resultE.regressions && resultE.regressions.length > 0;
            console.log(`Safe:        ${resultE.safe}`);
            console.log(`Latency:     ${resultE.latencyMs}ms`);
            console.log(`Errors:      ${resultE.structured?.length ?? 0}`);
            console.log(`Regressions: ${resultE.regressions?.length ?? 0}`);
            if (hasRegressions) {
                console.log(`Verdict: DETECTED ✅ (TTRD regression caught)`);
                for (const reg of resultE.regressions!) {
                    console.log(`  → ${reg.symbol}: ${reg.oldType} → ${reg.newType}`);
                }
            } else if (!resultE.safe) {
                console.log(`Verdict: CAUGHT ✅ (compilation errors)`);
            } else {
                console.log(`Verdict: MISSED ⚠️`);
            }
        } finally {
            await kernel.rollbackAll();
        }
    } else {
        console.log("SKIP: regex did not match");
    }

    // ── Summary ────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  PRISMA BENCHMARK SUMMARY");
    console.log("═══════════════════════════════════════════════════");
    console.log(`Boot:             ${bootTimeSec}s`);
    console.log(`Files tracked:    ${trackedFiles}`);
    console.log(`Baseline errors:  ${baselineErrors}`);
    console.log(`Heap:             ${formatMB(heapDelta)}`);
    console.log(`RSS:              ${formatMB(memAfter.rss)}`);
    console.log("═══════════════════════════════════════════════════");
}

main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
