#!/usr/bin/env node
/**
 * Diagnostic: boot hologram kernel on VSCode, inspect baseline errors and ambient files.
 */
import path from "path";
import fs from "fs";
import { NrekiKernel } from "../dist/kernel/nreki-kernel.js";
import { ParserPool } from "../dist/parser-pool.js";
import { scanProject } from "../dist/hologram/shadow-generator.js";

const VSCODE_SRC = path.join(
    process.env.LOCALAPPDATA || "",
    "Temp", "vscode-nreki-bench", "src"
);

if (!fs.existsSync(VSCODE_SRC)) {
    console.error("VSCode repo not found at", VSCODE_SRC);
    process.exit(1);
}

async function main() {
    console.log("=== HOLOGRAM DIAGNOSTIC ===\n");

    // Step 1: Scan
    console.log("Step 1: Scanning project...");
    const pool = new ParserPool(4);
    const t0 = performance.now();
    const scan = await scanProject(VSCODE_SRC, pool);
    const scanMs = (performance.now() - t0).toFixed(0);

    console.log(`  Scan time: ${scanMs}ms`);
    console.log(`  Total files: ${scan.stats.total}`);
    console.log(`  Prunable: ${scan.stats.pruned}`);
    console.log(`  Unprunable: ${scan.stats.unpruned}`);
    console.log(`  No exports: ${scan.stats.noExports}`);
    console.log(`  Ambient files: ${scan.ambientFiles.length}`);

    // Step 2: Show ambient files
    console.log("\n--- Ambient files (first 20) ---");
    for (const f of scan.ambientFiles.slice(0, 20)) {
        console.log(`  ${f}`);
    }

    // Check for @types/node specifically
    const nodeTypes = scan.ambientFiles.filter(f => f.includes("@types") && f.includes("node"));
    console.log(`\n@types/node entries: ${nodeTypes.length}`);
    for (const f of nodeTypes) {
        console.log(`  ${f}`);
    }

    // Step 3: Boot hologram kernel
    console.log("\nStep 2: Booting hologram kernel...");
    const kernel = new NrekiKernel();
    kernel.setShadows(scan.prunable, scan.unprunable, scan.ambientFiles);

    const t1 = performance.now();
    kernel.boot(VSCODE_SRC, "hologram");
    const bootMs = (performance.now() - t1).toFixed(0);

    console.log(`  Boot time: ${bootMs}ms`);
    console.log(`  Tracked files (rootNames): ${kernel.getTrackedFiles()}`);
    console.log(`  Baseline error count: ${kernel.getBaselineErrorCount()}`);
    console.log(`  Initial error count: ${kernel.getInitialErrorCount()}`);

    // Step 4: Get actual baseline diagnostic details
    console.log("\n--- First 20 baseline diagnostics ---");
    const program = kernel.getProgram();
    if (program) {
        let count = 0;
        // Global diagnostics
        for (const diag of program.getGlobalDiagnostics()) {
            if (count >= 20) break;
            const msg = typeof diag.messageText === "string"
                ? diag.messageText
                : diag.messageText.messageText;
            const file = diag.file ? path.basename(diag.file.fileName) : "global";
            console.log(`  [TS${diag.code}] ${file}: ${msg.slice(0, 120)}`);
            count++;
        }

        // Semantic diagnostics from source files
        for (const sf of program.getSourceFiles()) {
            if (count >= 20) break;
            const diags = program.getSemanticDiagnostics(sf);
            for (const diag of diags) {
                if (count >= 20) break;
                const msg = typeof diag.messageText === "string"
                    ? diag.messageText
                    : diag.messageText.messageText;
                const file = diag.file ? path.basename(diag.file.fileName) : "global";
                const line = diag.file && diag.start !== undefined
                    ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1
                    : "?";
                console.log(`  [TS${diag.code}] ${file}:${line}: ${msg.slice(0, 120)}`);
                count++;
            }
        }
        console.log(`  (showed ${count} of ${kernel.getBaselineErrorCount()} total)`);

        // Count errors by code
        console.log("\n--- Error code breakdown (top 10) ---");
        const codeCounts = new Map();
        for (const sf of program.getSourceFiles()) {
            for (const diag of program.getSemanticDiagnostics(sf)) {
                codeCounts.set(diag.code, (codeCounts.get(diag.code) || 0) + 1);
            }
        }
        for (const diag of program.getGlobalDiagnostics()) {
            codeCounts.set(diag.code, (codeCounts.get(diag.code) || 0) + 1);
        }
        const sorted = [...codeCounts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [code, count] of sorted.slice(0, 10)) {
            console.log(`  TS${code}: ${count} occurrences`);
        }
    }

    // Step 5: Check node: protocol resolution
    console.log("\n--- node: protocol check ---");
    const bootstrapNodeDts = scan.ambientFiles.find(f => f.includes("bootstrap-node"));
    console.log(`  bootstrap-node in ambient: ${bootstrapNodeDts || "NOT FOUND"}`);

    // Check if node_modules/@types/node has node:path etc
    const typesNodeDir = path.join(VSCODE_SRC, "..", "node_modules", "@types", "node");
    if (fs.existsSync(typesNodeDir)) {
        console.log(`  @types/node dir exists: YES`);
        const pathDts = path.join(typesNodeDir, "path.d.ts");
        console.log(`  @types/node/path.d.ts exists: ${fs.existsSync(pathDts)}`);
    } else {
        console.log(`  @types/node dir exists: NO`);
        // Check at vscode root level
        const altPath = path.join(VSCODE_SRC, "..", "node_modules", "@types", "node");
        console.log(`  Alt @types/node: ${fs.existsSync(altPath)}`);
    }

    console.log("\n=== DIAGNOSTIC COMPLETE ===");
}

main().catch(err => {
    console.error("FATAL:", err.message);
    console.error(err.stack);
    process.exit(1);
});
