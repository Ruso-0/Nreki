/**
 * NREKI vs VSCode - File Mode Benchmark (READ-ONLY AUDIT)
 *
 * Tests the NREKI Kernel against the Microsoft VSCode codebase (~5000+ TS files)
 * using performance mode auto-detection. VSCode triggers "file" mode (>1000 files),
 * which runs semantic checks only on edited files - no cascade evaluation.
 *
 * All edits are simulated in the kernel's VFS (RAM only).
 * ZERO writes to the vscode/ directory. commitToDisk() is NEVER called.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=8192 npx tsx tests/nreki-vscode-benchmark.ts
 */

import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import {
    NrekiKernel,
    type NrekiInterceptResult,
    type NrekiStructuredError,
    type TypeRegression,
} from "../src/kernel/nreki-kernel.js";
import { detectMode } from "../src/index.js";

// ─── Config ────────────────────────────────────────────────────────

const VSCODE_DIR = path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "Temp",
    "vscode-nreki-bench"
);
const VSCODE_SRC = path.join(VSCODE_DIR, "src");
const TSCONFIG_PATH = path.join(VSCODE_SRC, "tsconfig.json");
const REPORT_PATH = path.join(process.cwd(), "nreki-vscode-benchmark.md");

// Previous project-mode benchmark results for comparison
const PREVIOUS_PROJECT_MODE = {
    bootTimeSec: "111",
    testB_latencyMs: "644000",
    testB_errors: 6107,
    testD_latencyMs: "331000",
    testD_errors: 35704,
    oomCrashes: "yes",
};

// ─── Types ─────────────────────────────────────────────────────────

interface TestResult {
    name: string;
    description: string;
    mode: string;
    expected: string;
    verdict: string;
    errorsFound: number;
    filesAffected: number;
    latency: string;
    structured?: NrekiStructuredError[];
    regressions?: TypeRegression[];
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatMB(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function readVSCodeFile(relativePath: string): string {
    return fs.readFileSync(path.join(VSCODE_SRC, relativePath), "utf-8");
}

function resolveVSCodePath(relativePath: string): string {
    return path.join(VSCODE_SRC, relativePath);
}

function uniqueFiles(structured?: NrekiStructuredError[]): number {
    if (!structured || structured.length === 0) return 0;
    return new Set(structured.map(e => e.file)).size;
}

function formatErrors(structured?: NrekiStructuredError[], limit = 50): string {
    if (!structured || structured.length === 0) return "No errors.\n";
    const lines = structured.slice(0, limit).map(e =>
        `- \`${e.file}\` (${e.line},${e.column}): **${e.code}** - ${e.message.slice(0, 200)}`
    );
    if (structured.length > limit) {
        lines.push(`\n*...and ${structured.length - limit} more errors*`);
    }
    return lines.join("\n") + "\n";
}

function formatRegressions(regressions?: TypeRegression[]): string {
    if (!regressions || regressions.length === 0) return "No regressions detected.\n";
    return regressions.map(r =>
        `- \`${r.symbol}\` in \`${r.filePath}\`: \`${r.oldType}\` -> \`${r.newType}\``
    ).join("\n") + "\n";
}

// ─── Phase 1: Clone ───────────────────────────────────────────────

function cloneVSCode(): void {
    if (fs.existsSync(TSCONFIG_PATH)) {
        console.log(`VSCode repo found at ${VSCODE_DIR}`);
        return;
    }
    console.log("Cloning microsoft/vscode (depth 1)... This may take a few minutes.");
    execSync(
        `git clone --depth 1 https://github.com/microsoft/vscode.git "${VSCODE_DIR}"`,
        { stdio: "inherit", timeout: 300_000 }
    );
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
    console.log("===============================================================");
    console.log("  NREKI vs VSCode - File Mode Benchmark (READ-ONLY AUDIT)");
    console.log("===============================================================\n");

    // ── Phase 1: Clone ──────────────────────────────────────────────
    cloneVSCode();

    // ── Phase 2: Mode Detection ─────────────────────────────────────
    console.log("--- PHASE 2: Mode Detection ---");
    const detectStart = performance.now();
    const detectedMode = detectMode(VSCODE_SRC);
    const detectLatencyMs = (performance.now() - detectStart).toFixed(1);

    console.log(`Detected mode:    ${detectedMode}`);
    console.log(`Detection latency: ${detectLatencyMs}ms`);

    if (detectedMode !== "hologram" && detectedMode !== "file") {
        console.log(`WARNING: Expected mode "hologram" or "file" (>1000 files), got "${detectedMode}"`);
    }

    // Guard: boot() only accepts "file" | "project" | "hologram", not "syntax"
    const bootMode = detectedMode === "syntax" ? undefined : detectedMode;

    // ── Phase 3: Boot ───────────────────────────────────────────────
    const kernel = new NrekiKernel();

    console.log("\n--- PHASE 3: Boot ---");
    console.log(`Booting kernel in "${bootMode ?? "project"}" mode against ${VSCODE_SRC}...`);
    console.log("(This may take 30-120s for VSCode's scale)\n");

    const memBefore = process.memoryUsage();
    const bootStart = performance.now();

    try {
        // Hologram mode: scan for shadows before booting
        if (bootMode === "hologram") {
            const { ParserPool } = await import("../src/parser-pool.js");
            const { scanProject } = await import("../src/hologram/shadow-generator.js");
            const pool = new ParserPool(4);
            console.log("Scanning project for holographic shadows...");
            const scanResult = await scanProject(VSCODE_SRC, pool);
            console.log(
                `Shadow scan: ${scanResult.stats.pruned} prunable, ` +
                `${scanResult.stats.unpruned} unprunable, ` +
                `${scanResult.ambientFiles.length} ambient`
            );
            kernel.setShadows(
                scanResult.prunable, scanResult.unprunable, scanResult.ambientFiles,
            );
        }
        kernel.boot(VSCODE_SRC, bootMode as any);
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

    // ── Phase 4: Simulated Edits ────────────────────────────────────
    const results: TestResult[] = [];
    const actualMode = bootMode ?? "project";

    // ── Test A: Safe edit (comment append) ──────────────────────────
    console.log("\n--- TEST A: Safe Edit (comment in types.ts) ---");

    const typesPath = resolveVSCodePath("vs/base/common/types.ts");
    let testAVerdict = "SKIP";

    if (fs.existsSync(typesPath)) {
        const typesOriginal = readVSCodeFile("vs/base/common/types.ts");
        const typesSafe = typesOriginal + "\n// NREKI benchmark test\n";
        let resultA: NrekiInterceptResult;

        try {
            resultA = await kernel.interceptAtomicBatch([
                { targetFile: typesPath, proposedContent: typesSafe }
            ]);
            testAVerdict = resultA.safe ? "PASS" : "FAIL";
            console.log(`Result: ${testAVerdict}`);
            console.log(`Latency: ${resultA.latencyMs}ms`);

            if (!resultA.safe && resultA.structured) {
                for (const err of resultA.structured.slice(0, 3)) {
                    console.log(`  -> ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 120)}`);
                }
            }

            results.push({
                name: "A",
                description: "Safe edit (comment in types.ts)",
                mode: actualMode,
                expected: "safe: true",
                verdict: testAVerdict,
                errorsFound: resultA.structured?.length ?? 0,
                filesAffected: uniqueFiles(resultA.structured),
                latency: resultA.latencyMs ?? "N/A",
                structured: resultA.structured,
            });
        } finally {
            await kernel.rollbackAll();
        }
    } else {
        console.log("SKIP: vs/base/common/types.ts not found");
        results.push({
            name: "A", description: "Safe edit (comment in types.ts)",
            mode: actualMode, expected: "safe: true", verdict: "SKIP",
            errorsFound: 0, filesAffected: 0, latency: "N/A",
        });
    }

    // ── Test B: Local type break in edited file ─────────────────────
    console.log("\n--- TEST B: Local Type Break in event.ts (IDisposable -> number) ---");

    const eventPath = resolveVSCodePath("vs/base/common/event.ts");
    let testBVerdict = "SKIP";

    if (fs.existsSync(eventPath)) {
        const eventOriginal = readVSCodeFile("vs/base/common/event.ts");

        // Replace IDisposable return in the Event<T> interface call signature
        const eventBroken = eventOriginal.replace(
            /(\)\s*:\s*)IDisposable\s*;/,
            "$1number;"
        );

        if (eventBroken === eventOriginal) {
            console.log("SKIP: Could not apply Event<T> mutation (regex did not match)");
            results.push({
                name: "B", description: "Local type break in event.ts (IDisposable -> number)",
                mode: actualMode, expected: "safe: false (local errors in event.ts)",
                verdict: "SKIP",
                errorsFound: 0, filesAffected: 0, latency: "N/A",
            });
        } else {
            let resultB: NrekiInterceptResult;
            try {
                resultB = await kernel.interceptAtomicBatch([
                    { targetFile: eventPath, proposedContent: eventBroken }
                ]);
                testBVerdict = resultB.safe ? "MISSED" : "CAUGHT";
                console.log(`Result: ${testBVerdict}`);
                console.log(`Latency: ${resultB.latencyMs}ms`);
                console.log(`Errors: ${resultB.structured?.length ?? 0}`);
                console.log(`Files affected: ${uniqueFiles(resultB.structured)}`);
                console.log(`(Previous project mode: ${PREVIOUS_PROJECT_MODE.testB_errors} errors)`);

                if (resultB.structured) {
                    for (const err of resultB.structured.slice(0, 5)) {
                        console.log(`  -> ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 100)}`);
                    }
                }

                results.push({
                    name: "B",
                    description: "Local type break in event.ts (IDisposable -> number)",
                    mode: actualMode,
                    expected: "safe: false (local errors in event.ts)",
                    verdict: testBVerdict,
                    errorsFound: resultB.structured?.length ?? 0,
                    filesAffected: uniqueFiles(resultB.structured),
                    latency: resultB.latencyMs ?? "N/A",
                    structured: resultB.structured,
                });
            } finally {
                await kernel.rollbackAll();
            }
        }
    } else {
        console.log("SKIP: vs/base/common/event.ts not found");
        results.push({
            name: "B", description: "Local type break in event.ts (IDisposable -> number)",
            mode: actualMode, expected: "safe: false (local errors in event.ts)",
            verdict: "SKIP",
            errorsFound: 0, filesAffected: 0, latency: "N/A",
        });
    }

    // ── Test C: TTRD type weakening (isString -> any) ───────────────
    console.log("\n--- TEST C: TTRD Type Weakening (isString -> any) ---");

    const typesPathC = resolveVSCodePath("vs/base/common/types.ts");
    let testCVerdict = "SKIP";

    if (fs.existsSync(typesPathC)) {
        const typesOriginalC = readVSCodeFile("vs/base/common/types.ts");

        // Weaken isString return type from type predicate to any
        const typesWeakened = typesOriginalC.replace(
            /export function isString\(([^)]+)\)\s*:\s*\w+\s+is\s+string/,
            "export function isString($1): any"
        );

        if (typesWeakened === typesOriginalC) {
            console.log("SKIP: Could not apply isString mutation (regex did not match)");
            results.push({
                name: "C", description: "TTRD type weakening (isString -> any)",
                mode: actualMode, expected: "regression detected",
                verdict: "SKIP",
                errorsFound: 0, filesAffected: 0, latency: "N/A",
            });
        } else {
            let resultC: NrekiInterceptResult;
            try {
                resultC = await kernel.interceptAtomicBatch([
                    { targetFile: typesPathC, proposedContent: typesWeakened }
                ]);

                const hasErrors = !resultC.safe;
                const hasRegressions = resultC.regressions && resultC.regressions.length > 0;

                if (hasErrors) {
                    testCVerdict = "CAUGHT (compilation errors)";
                } else if (hasRegressions) {
                    testCVerdict = "DETECTED (TTRD regression)";
                } else {
                    testCVerdict = "MISSED";
                }

                console.log(`Safe: ${resultC.safe}`);
                console.log(`Compilation errors: ${resultC.structured?.length ?? 0}`);
                console.log(`Regressions: ${resultC.regressions?.length ?? 0}`);
                console.log(`Result: ${testCVerdict}`);
                console.log(`Latency: ${resultC.latencyMs}ms`);

                if (resultC.regressions) {
                    for (const reg of resultC.regressions) {
                        console.log(`  -> ${reg.symbol}: ${reg.oldType} -> ${reg.newType}`);
                    }
                }

                results.push({
                    name: "C",
                    description: "TTRD type weakening (isString -> any)",
                    mode: actualMode,
                    expected: "regression detected",
                    verdict: testCVerdict,
                    errorsFound: resultC.structured?.length ?? 0,
                    filesAffected: uniqueFiles(resultC.structured),
                    latency: resultC.latencyMs ?? "N/A",
                    structured: resultC.structured,
                    regressions: resultC.regressions,
                });
            } finally {
                await kernel.rollbackAll();
            }
        }
    } else {
        console.log("SKIP: vs/base/common/types.ts not found");
        results.push({
            name: "C", description: "TTRD type weakening (isString -> any)",
            mode: actualMode, expected: "regression detected",
            verdict: "SKIP",
            errorsFound: 0, filesAffected: 0, latency: "N/A",
        });
    }

    // ── Test D: Cross-file break / file mode limitation ─────────────
    console.log("\n--- TEST D: Cross-file Break / File Mode Limitation (IDisposable) ---");

    const lifecyclePath = resolveVSCodePath("vs/base/common/lifecycle.ts");
    let testDVerdict = "SKIP";

    if (fs.existsSync(lifecyclePath)) {
        const lifecycleOriginal = readVSCodeFile("vs/base/common/lifecycle.ts");

        // Add a required property to IDisposable
        const lifecycleBroken = lifecycleOriginal.replace(
            /(export interface IDisposable\s*\{[^}]*dispose\(\)\s*:\s*void\s*;)/,
            "$1\n\t__nrekiTestProperty: string;"
        );

        if (lifecycleBroken === lifecycleOriginal) {
            console.log("SKIP: Could not apply IDisposable mutation (regex did not match)");
            results.push({
                name: "D", description: "Cross-file break / file mode limitation (IDisposable)",
                mode: actualMode, expected: "safe: true (file mode skips cascade)",
                verdict: "SKIP",
                errorsFound: 0, filesAffected: 0, latency: "N/A",
            });
        } else {
            let resultD: NrekiInterceptResult;
            try {
                resultD = await kernel.interceptAtomicBatch([
                    { targetFile: lifecyclePath, proposedContent: lifecycleBroken }
                ]);
                testDVerdict = resultD.safe ? "LIMITATION (expected)" : "CAUGHT";
                console.log(`Result: ${testDVerdict}`);
                console.log(`Latency: ${resultD.latencyMs}ms`);
                console.log(`Errors: ${resultD.structured?.length ?? 0}`);
                console.log(`Files affected: ${uniqueFiles(resultD.structured)}`);
                console.log(`(Previous project mode: ${PREVIOUS_PROJECT_MODE.testD_errors} cascade errors)`);

                if (resultD.structured) {
                    for (const err of resultD.structured.slice(0, 5)) {
                        console.log(`  -> ${err.file} (${err.line},${err.column}): ${err.code} - ${err.message.slice(0, 100)}`);
                    }
                }

                results.push({
                    name: "D",
                    description: "Cross-file break / file mode limitation (IDisposable)",
                    mode: actualMode,
                    expected: "safe: true (file mode skips cascade)",
                    verdict: testDVerdict,
                    errorsFound: resultD.structured?.length ?? 0,
                    filesAffected: uniqueFiles(resultD.structured),
                    latency: resultD.latencyMs ?? "N/A",
                    structured: resultD.structured,
                });
            } finally {
                await kernel.rollbackAll();
            }
        }
    } else {
        console.log("SKIP: vs/base/common/lifecycle.ts not found");
        results.push({
            name: "D", description: "Cross-file break / file mode limitation (IDisposable)",
            mode: actualMode, expected: "safe: true (file mode skips cascade)",
            verdict: "SKIP",
            errorsFound: 0, filesAffected: 0, latency: "N/A",
        });
    }

    // ── Phase 5: Console Summary ────────────────────────────────────
    console.log("\n===============================================================");
    console.log("  SUMMARY");
    console.log("===============================================================");
    console.log(`Detected mode:    ${detectedMode}`);
    console.log(`Boot mode:        ${actualMode}`);
    console.log(`Boot time:        ${bootTimeSec}s`);
    console.log(`Files tracked:    ${trackedFiles}`);
    console.log(`Baseline errors:  ${baselineErrors}`);
    console.log(`Heap delta:       ${formatMB(heapDelta)}`);
    console.log(`RSS:              ${formatMB(memAfter.rss)}`);
    console.log("");
    for (const r of results) {
        console.log(`Test ${r.name} (${r.description}): ${r.verdict} | errors=${r.errorsFound} files=${r.filesAffected} latency=${r.latency}ms`);
    }
    console.log("===============================================================");

    // Hoisted for Phase 5c comparison
    let prewarmBootMsH = 0;
    let prewarmInterceptMsH = 0;

    // ── Phase 5b: Pre-warmed Hologram Benchmark ────────────────────
    // Simulates real agent usage: pre-warm completes during agent's read phase,
    // so the agent only experiences boot + first intercept latency.
    if (bootMode === "hologram") {
        console.log("\n--- PHASE 5b: Hologram (Pre-warmed) ---");
        console.log("Simulating real usage: scan already complete, measuring boot + first edit only.\n");

        const { ParserPool } = await import("../src/parser-pool.js");
        const { scanProject } = await import("../src/hologram/shadow-generator.js");

        // Step 1: Pre-warm (not measured - happens during agent reading)
        const pool2 = new ParserPool(4);
        const scanResult2 = await scanProject(VSCODE_SRC, pool2);

        // Step 2: Measure only boot
        const kernel2 = new NrekiKernel();
        kernel2.setShadows(scanResult2.prunable, scanResult2.unprunable, scanResult2.ambientFiles);

        const prewarmMem = process.memoryUsage();
        const prewarmBootStart = performance.now();
        kernel2.boot(VSCODE_SRC, "hologram");
        const prewarmBootMs = performance.now() - prewarmBootStart;

        // Step 3: Measure first intercept (includes deferred baseline capture)
        const prewarmTypesPath = resolveVSCodePath("vs/base/common/types.ts");
        let prewarmInterceptMs = 0;
        if (fs.existsSync(prewarmTypesPath)) {
            const original = readVSCodeFile("vs/base/common/types.ts");
            const safe = original + "\n// pre-warm test\n";
            const t0 = performance.now();
            const r = await kernel2.interceptAtomicBatch([
                { targetFile: prewarmTypesPath, proposedContent: safe },
            ]);
            prewarmInterceptMs = performance.now() - t0;
            await kernel2.rollbackAll();
            console.log(`First intercept:  ${r.safe ? "PASS" : "FAIL"} (${prewarmInterceptMs.toFixed(0)}ms)`);
        }

        const prewarmMemAfter = process.memoryUsage();
        const prewarmHeap = prewarmMemAfter.heapUsed - prewarmMem.heapUsed;

        prewarmBootMsH = prewarmBootMs;
        prewarmInterceptMsH = prewarmInterceptMs;

        console.log(`Boot (pre-warmed): ${(prewarmBootMs / 1000).toFixed(2)}s`);
        console.log(`First edit total:  ${((prewarmBootMs + prewarmInterceptMs) / 1000).toFixed(2)}s`);
        console.log(`Heap delta:        ${formatMB(prewarmHeap)}`);
        console.log(`RSS:               ${formatMB(prewarmMemAfter.rss)}`);

        console.log("\n--- Comparison ---");
        console.log(`| Metric              | Project | File   | Hologram | Hologram (pre-warmed) |`);
        console.log(`|---------------------|---------|--------|----------|-----------------------|`);
        console.log(`| Boot                | 111s    | 91.6s  | ${bootTimeSec}s   | ${(prewarmBootMs / 1000).toFixed(2)}s |`);
        console.log(`| First edit latency  | 644s    | 55s    | ${results[0]?.latency ?? "?"}ms | ${prewarmInterceptMs.toFixed(0)}ms |`);
        console.log(`| Heap delta          | OOM     | 284 MB | ${formatMB(heapDelta)} | ${formatMB(prewarmHeap)} |`);
    }

    // ── Phase 5c: JIT Holography (Cold, no pre-scan) ───────────────
    if (bootMode === "hologram") {
        console.log("\n--- PHASE 5c: JIT Holography (Cold, no pre-scan) ---");
        console.log("Simulating JIT mode: WASM loaded, NO scanProject, shadows on-demand.\n");

        const Parser = (await import("web-tree-sitter")).default;
        await Parser.init();
        const jitParser = new Parser();
        const wasmDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")), "..", "wasm");
        const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
        const tsLang = await Parser.Language.load(tsLangPath);
        jitParser.setLanguage(tsLang);

        const { classifyAndGenerateShadow } = await import("../src/hologram/shadow-generator.js");
        const kernelJIT = new NrekiKernel();
        kernelJIT.setJitParser(jitParser, tsLang);
        kernelJIT.setJitClassifier(classifyAndGenerateShadow);
        // NO setShadows() — kernel boots without pre-computed shadows

        const memBeforeJIT = process.memoryUsage();
        const jitBootStart = performance.now();
        kernelJIT.boot(VSCODE_SRC, "hologram");
        const jitBootMs = performance.now() - jitBootStart;
        console.log(`Boot (JIT, no scan): ${(jitBootMs / 1000).toFixed(2)}s`);

        // Run first intercept to measure JIT shadow generation cost
        const typesPath5c = resolveVSCodePath("vs/base/common/types.ts");
        let jitInterceptMs = 0;
        if (fs.existsSync(typesPath5c)) {
            const typesContent5c = readVSCodeFile("vs/base/common/types.ts");
            const editStart5c = performance.now();
            const result5c = await kernelJIT.interceptAtomicBatch([
                { targetFile: typesPath5c, proposedContent: typesContent5c + "\n// JIT test\n" },
            ]);
            jitInterceptMs = performance.now() - editStart5c;
            console.log(`First intercept:    ${result5c.safe ? "PASS" : "BLOCKED"} (${jitInterceptMs.toFixed(0)}ms)`);
        }

        const memAfterJIT = process.memoryUsage();
        console.log(`Boot (JIT):         ${(jitBootMs / 1000).toFixed(2)}s`);
        console.log(`First edit total:   ${((jitBootMs + jitInterceptMs) / 1000).toFixed(2)}s`);
        console.log(`JIT cache size:     ${kernelJIT.getJitCacheSize()} files classified on-demand`);
        console.log(`Heap delta:         ${formatMB(memAfterJIT.heapUsed - memBeforeJIT.heapUsed)}`);
        console.log(`RSS:                ${formatMB(memAfterJIT.rss)}`);

        console.log("\n--- Full Comparison ---");
        console.log(`| Metric              | Hologram (eager) | Hologram (pre-warmed) | JIT Holography |`);
        console.log(`|---------------------|------------------|-----------------------|----------------|`);
        console.log(`| Boot                | ${bootTimeSec}s          | ${(prewarmBootMsH / 1000).toFixed(2)}s                | ${(jitBootMs / 1000).toFixed(2)}s          |`);
        console.log(`| First edit          | ${results[0]?.latency ?? "?"}ms        | ${prewarmInterceptMsH.toFixed(0)}ms                 | ${jitInterceptMs.toFixed(0)}ms          |`);
        console.log(`| Files never touched | 0                | 0                     | ~${(5584 - kernelJIT.getJitCacheSize())}        |`);
    }

    // ── Phase 6: Verification ───────────────────────────────────────
    console.log("\n--- PHASE 6: Verification (VSCode Untouched) ---");
    let gitStatusOutput = "";
    let modifiedFileCount = 0;
    try {
        gitStatusOutput = execSync(`git -C "${VSCODE_DIR}" status --short`, {
            encoding: "utf-8",
            timeout: 10_000,
        });
        modifiedFileCount = gitStatusOutput.trim().split("\n").filter(l => l.trim().length > 0).length;
    } catch (err: any) {
        gitStatusOutput = `ERROR: ${err.message}`;
    }

    console.log(`Modified files: ${modifiedFileCount}`);
    if (modifiedFileCount === 0) {
        console.log("VERIFIED: VSCode repo is untouched.");
    } else {
        console.log("WARNING: VSCode repo has unexpected modifications:");
        console.log(gitStatusOutput);
    }

    // ── Write Markdown Report ───────────────────────────────────────
    const now = new Date().toISOString();
    const testB = results.find(r => r.name === "B");
    const testC = results.find(r => r.name === "C");
    const testD = results.find(r => r.name === "D");

    const reportLines: string[] = [
        `# NREKI vs VSCode - File Mode Benchmark Report`,
        ``,
        `Generated: ${now}`,
        `NREKI Kernel: v5.3.0`,
        `VSCode: latest (depth 1 clone)`,
        `Mode: ${detectedMode} (auto-detected via detectMode)`,
        ``,
        `## 1. Mode Detection`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| detectMode() result | ${detectedMode} |`,
        `| Detection latency | ${detectLatencyMs}ms |`,
        `| Expected mode | file (>1000 TS files) |`,
        ``,
        `## 2. Boot Metrics`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Boot Mode | ${actualMode} |`,
        `| Boot Time | ${bootTimeSec}s |`,
        `| Files Tracked | ${trackedFiles} |`,
        `| Baseline Errors | ${baselineErrors} |`,
        `| Heap Delta | ${formatMB(heapDelta)} |`,
        `| RSS | ${formatMB(memAfter.rss)} |`,
        ``,
        `## 3. Simulated Edit Results`,
        ``,
        `| Test | Description | Mode | Expected | Result | Errors | Files Affected | Latency |`,
        `|------|-------------|------|----------|--------|--------|----------------|---------|`,
    ];

    for (const r of results) {
        reportLines.push(
            `| ${r.name} | ${r.description} | ${r.mode} | ${r.expected} | ${r.verdict} | ${r.errorsFound} | ${r.filesAffected} | ${r.latency}ms |`
        );
    }

    // Comparison table
    reportLines.push(
        ``,
        `## 4. Performance Comparison: File Mode vs Project Mode`,
        ``,
        `| Metric | Project Mode (previous) | File Mode (this run) |`,
        `|--------|-------------------------|----------------------|`,
        `| Boot time | ${PREVIOUS_PROJECT_MODE.bootTimeSec}s | ${bootTimeSec}s |`,
        `| Test B latency | ${(Number(PREVIOUS_PROJECT_MODE.testB_latencyMs) / 1000).toFixed(0)}s | ${testB?.latency ?? "N/A"}ms |`,
        `| Test B errors | ${PREVIOUS_PROJECT_MODE.testB_errors} | ${testB?.errorsFound ?? "N/A"} |`,
        `| Test D latency | ${(Number(PREVIOUS_PROJECT_MODE.testD_latencyMs) / 1000).toFixed(0)}s | ${testD?.latency ?? "N/A"}ms |`,
        `| Test D errors | ${PREVIOUS_PROJECT_MODE.testD_errors} | ${testD?.errorsFound ?? "N/A"} |`,
        `| OOM crashes | ${PREVIOUS_PROJECT_MODE.oomCrashes} | no |`,
    );

    // Detailed error listings
    reportLines.push(``, `## 5. Detailed Error Listings`, ``);

    reportLines.push(`### Test B - Local Type Break (event.ts)`, ``);
    if (testB && testB.verdict !== "SKIP") {
        reportLines.push(formatErrors(testB.structured));
    } else {
        reportLines.push("Test was skipped.\n");
    }

    reportLines.push(`### Test D - Cross-file Break (IDisposable)`, ``);
    if (testD && testD.verdict !== "SKIP") {
        reportLines.push(formatErrors(testD.structured));
    } else {
        reportLines.push("Test was skipped.\n");
    }

    // TTRD regressions
    reportLines.push(`## 6. TTRD Regression Details (Test C)`, ``);
    if (testC && testC.verdict !== "SKIP") {
        reportLines.push(formatRegressions(testC.regressions));
        if (testC.structured && testC.structured.length > 0) {
            reportLines.push(``, `#### Compilation Errors`, ``);
            reportLines.push(formatErrors(testC.structured));
        }
    } else {
        reportLines.push("Test was skipped.\n");
    }

    // Tradeoffs
    reportLines.push(
        `## 7. File Mode Tradeoffs`,
        ``,
        `**What file mode catches:**`,
        `- Syntax errors in edited files`,
        `- Semantic errors local to edited files (e.g., wrong return type)`,
        `- Type regressions (TTRD) in edited files' exports`,
        ``,
        `**What file mode misses:**`,
        `- Cascade errors in downstream consumers (e.g., ${PREVIOUS_PROJECT_MODE.testD_errors.toLocaleString()} IDisposable implementors)`,
        `- Cross-file type incompatibilities that only manifest in importing files`,
        ``,
        `**When to use file mode:**`,
        `- Large codebases (>1000 files) where project mode causes OOM or multi-minute latencies`,
        `- Rapid iteration where local correctness is sufficient`,
        `- When combined with periodic project-mode verification`,
    );

    // Verification
    reportLines.push(
        ``,
        `## 8. VSCode Integrity Verification`,
        ``,
        `| Check | Result |`,
        `|-------|--------|`,
        `| Modified files | ${modifiedFileCount} |`,
        `| Status | ${modifiedFileCount === 0 ? "VERIFIED: VSCode repo untouched" : "WARNING: unexpected modifications"} |`,
    );

    if (modifiedFileCount > 0) {
        reportLines.push(``, `\`\`\``, gitStatusOutput.trim(), `\`\`\``);
    }

    const report = reportLines.join("\n");
    fs.writeFileSync(REPORT_PATH, report, "utf-8");
    console.log(`\nReport saved to: ${REPORT_PATH}`);
}

main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
