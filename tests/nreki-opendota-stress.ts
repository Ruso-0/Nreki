/**
 * NREKI vs OpenDota - Stress Test
 *
 * Tests the NREKI Kernel against a real-world TypeScript project (1600+ stars).
 * Simulates an AI agent making destructive edits and verifies
 * that NREKI catches them before they reach disk.
 *
 * Run: npx tsx tests/nreki-opendota-stress.ts
 */

import * as path from "path";
import * as fs from "fs";
import { NrekiKernel, type NrekiInterceptResult } from "../src/kernel/nreki-kernel.js";

const OPENDOTA_PROJECT = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "Temp",
    "opendota-test"
);

let breakResult: NrekiInterceptResult | undefined;

async function main() {
    if (!fs.existsSync(path.join(OPENDOTA_PROJECT, "tsconfig.json"))) {
        console.error(`OpenDota not found at ${OPENDOTA_PROJECT}`);
        console.error("Run: cd /tmp && git clone --depth 1 https://github.com/odota/core.git opendota-test && cd opendota-test && npm install");
        process.exit(1);
    }

    const kernel = new NrekiKernel();

    console.log("═══════════════════════════════════════════════════");
    console.log("  NREKI vs OpenDota - Stress Test");
    console.log("═══════════════════════════════════════════════════\n");

    // ─── TEST 1: Boot Time ──────────────────────────────────────
    console.log("--- TEST 1: Boot Time ---");
    const bootStart = performance.now();

    try {
        kernel.boot(OPENDOTA_PROJECT);
    } catch (err: any) {
        console.error(`Boot failed: ${err.message}`);
        process.exit(1);
    }

    const bootTime = ((performance.now() - bootStart) / 1000).toFixed(2);
    console.log(`Boot time: ${bootTime}s`);
    console.log(`Files tracked: ${kernel.getTrackedFiles()}`);
    console.log(`Baseline errors: ${kernel.getBaselineErrorCount()}`);

    // ─── TEST 2: Valid Edit (should PASS) ───────────────────────
    console.log("\n--- TEST 2: Valid Edit (should PASS) ---");

    const tsFiles = findTsFiles(OPENDOTA_PROJECT, 5);
    if (tsFiles.length === 0) {
        console.error("No .ts files found!");
        process.exit(1);
    }

    console.log(`Found ${tsFiles.length} .ts source files`);

    const testFile = tsFiles[0];
    const originalContent = fs.readFileSync(testFile, "utf-8");
    const validEdit = originalContent + "\n// NREKI test comment\n";

    const validResult = await kernel.interceptAtomicBatch([
        { targetFile: testFile, proposedContent: validEdit }
    ]);

    console.log(`File: ${path.relative(OPENDOTA_PROJECT, testFile)}`);
    console.log(`Result: ${validResult.safe ? "PASS" : "FAIL"}`);
    console.log(`Latency: ${validResult.latencyMs}ms`);

    if (!validResult.safe && validResult.structured) {
        for (const err of validResult.structured.slice(0, 3)) {
            console.log(`  -> ${path.relative(OPENDOTA_PROJECT, err.file)} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 120)}`);
        }
    }

    await kernel.rollbackAll();

    // ─── TEST 3: Type-Breaking Edit (should BLOCK) ──────────────
    console.log("\n--- TEST 3: Type-Breaking Edit (should BLOCK) ---");

    const breakableFile = findExportedFunction(tsFiles);

    if (breakableFile) {
        const { filePath, brokenCode, functionName } = breakableFile;

        breakResult = await kernel.interceptAtomicBatch([
            { targetFile: filePath, proposedContent: brokenCode }
        ]);

        console.log(`File: ${path.relative(OPENDOTA_PROJECT, filePath)}`);
        console.log(`Function: ${functionName}`);
        console.log(`Result: ${breakResult.safe ? "MISSED" : "BLOCKED"}`);
        console.log(`Latency: ${breakResult.latencyMs}ms`);

        if (breakResult.structured && breakResult.structured.length > 0) {
            console.log(`Errors caught: ${breakResult.structured.length}`);
            for (const err of breakResult.structured.slice(0, 5)) {
                console.log(`  -> ${path.relative(OPENDOTA_PROJECT, err.file)} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 100)}`);
            }
        }
    } else {
        console.log("Could not find a suitable function to break. Skipping.");
    }

    await kernel.rollbackAll();

    // ─── TEST 4: Syntax-Breaking Edit (should BLOCK) ────────────
    console.log("\n--- TEST 4: Syntax-Breaking Edit (should BLOCK) ---");

    const syntaxBroken = "export function broken(): number { return const let; }";

    const syntaxResult = await kernel.interceptAtomicBatch([
        { targetFile: testFile, proposedContent: syntaxBroken }
    ]);

    console.log(`File: ${path.relative(OPENDOTA_PROJECT, testFile)}`);
    console.log(`Result: ${syntaxResult.safe ? "MISSED" : "BLOCKED"}`);
    console.log(`Latency: ${syntaxResult.latencyMs}ms`);

    await kernel.rollbackAll();

    // ─── TEST 5: File Deletion ──────────────────────────────────
    console.log("\n--- TEST 5: File Deletion ---");

    const leafFile = tsFiles[tsFiles.length - 1];

    const deleteResult = await kernel.interceptAtomicBatch([
        { targetFile: leafFile, proposedContent: null }
    ]);

    console.log(`File: ${path.relative(OPENDOTA_PROJECT, leafFile)}`);
    console.log(`Result: ${deleteResult.safe ? "PASS" : "BLOCKED (has dependents)"}`);
    console.log(`Latency: ${deleteResult.latencyMs}ms`);

    await kernel.rollbackAll();

    // ─── TEST 6: Non-TypeScript File ────────────────────────────
    console.log("\n--- TEST 6: Non-TypeScript File (README.md) ---");

    const readmePath = path.join(OPENDOTA_PROJECT, "README.md");
    const readmeResult = await kernel.interceptAtomicBatch([
        { targetFile: readmePath, proposedContent: "# Modified by NREKI test" }
    ]);

    console.log(`Result: ${readmeResult.safe ? "PASS (correctly ignored)" : "BLOCKED (BUG)"}`);
    console.log(`Latency: ${readmeResult.latencyMs}ms`);

    await kernel.rollbackAll();

    // ─── SUMMARY ────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════════════════");
    console.log("  SUMMARY");
    console.log("═══════════════════════════════════════════════════");
    console.log(`Boot time:        ${bootTime}s`);
    console.log(`Files tracked:    ${kernel.getTrackedFiles()}`);
    console.log(`Baseline errors:  ${kernel.getBaselineErrorCount()}`);
    console.log(`Test 2 (valid):   ${validResult.safe ? "PASS" : "FAIL"} (${validResult.latencyMs}ms)`);
    console.log(`Test 3 (types):   ${breakableFile ? (breakResult!.safe ? "MISSED" : "CAUGHT") : "SKIP"}`);
    console.log(`Test 4 (syntax):  ${syntaxResult.safe ? "MISSED" : "CAUGHT"} (${syntaxResult.latencyMs}ms)`);
    console.log(`Test 5 (delete):  ${deleteResult.safe ? "PASS" : "BLOCKED"} (${deleteResult.latencyMs}ms)`);
    console.log(`Test 6 (non-TS):  ${readmeResult.safe ? "PASS" : "BLOCKED"} (${readmeResult.latencyMs}ms)`);
    console.log("═══════════════════════════════════════════════════");
}

function findTsFiles(dir: string, maxDepth: number, depth = 0): string[] {
    if (depth > maxDepth) return [];
    const results: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
            const full = path.join(dir, entry);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
                results.push(...findTsFiles(full, maxDepth, depth + 1));
            } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
                results.push(full);
            }
        }
    } catch { /* permission errors */ }
    return results;
}

function findExportedFunction(tsFiles: string[]): {
    filePath: string;
    originalCode: string;
    brokenCode: string;
    functionName: string;
} | null {
    for (const file of tsFiles) {
        const content = fs.readFileSync(file, "utf-8");
        const match = content.match(/export\s+function\s+(\w+)\s*\([^)]*\)\s*:\s*(\w+)\s*\{/);
        if (match) {
            const funcName = match[1];
            const returnType = match[2];
            const newType = returnType === "string" ? "number" : "string";
            const brokenCode = content.replace(
                new RegExp(`(export\\s+function\\s+${funcName}\\s*\\([^)]*\\)\\s*:\\s*)${returnType}`),
                `$1${newType}`
            );
            if (brokenCode !== content) {
                return { filePath: file, originalCode: content, brokenCode, functionName: funcName };
            }
        }
    }
    return null;
}

main().catch(console.error);
