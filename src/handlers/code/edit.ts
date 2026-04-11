/**
 * code/edit.ts - handleEdit + handleBatchEdit handlers.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import type { NrekiInterceptResult } from "../../kernel/nreki-kernel.js";
import { Embedder } from "../../embedder.js";
import { safePath } from "../../utils/path-jail.js";
import { semanticEdit, batchSemanticEdit, detectSignatureChange, type EditMode, type BatchEditOp } from "../../semantic-edit.js";
import { acquireFileLock, releaseFileLock } from "../../middleware/file-lock.js";
import { logger } from "../../utils/logger.js";
import { ensureKernelBooted, processKernelResult } from "./kernel-bridge.js";

// ─── Edit ───────────────────────────────────────────────────────────

export async function handleEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const file = params.path ?? "";
    const symbol = typeof params.symbol === "string" ? params.symbol : "";
    const new_code = typeof params.new_code === "string" ? params.new_code : "";

    if (!symbol || !new_code) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "symbol" and "new_code" are required for the edit action.\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    const lockResult = acquireFileLock(resolvedPath, "nreki_code:edit");
    if (!lockResult.acquired) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: BLOCKED\n\n` +
                    `File is currently locked by a concurrent edit (${lockResult.heldBy}, ${lockResult.heldForMs}ms ago).\n` +
                    `Wait for the current edit to complete and retry.\n\n` +
                    `[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    if (deps.chronos && deps.chronos.isHighFriction(resolvedPath)) {
        if (!deps.chronos.hasReadUncompressed(resolvedPath)) {
            releaseFileLock(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Edit Blocked - High Friction File\n\n` +
                        `File \`${path.basename(resolvedPath)}\` has high historical error rate (high Cognitive Friction Index).\n` +
                        `You attempted a blind edit without mapping its full logic into your context.\n\n` +
                        `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${file}"\` first.\n` +
                        `NREKI will unlock the edit once you have read the uncompressed code.\n\n` +
                        `[NREKI: Chronos edit gating active]`,
                }],
                isError: true,
            };
        }
    }

    try {
        const parser = engine.getParser();
        const mode = (typeof params.mode === "string" && ["replace", "insert_before", "insert_after"].includes(params.mode))
            ? params.mode as EditMode
            : "replace";

        const useKernel = await ensureKernelBooted(deps);

        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code,
            parser,
            sandbox,
            mode,
            useKernel,
        );

        if (!result.success || (useKernel && !result.newContent)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Semantic Edit: FAILED\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n\n` +
                        `${result.error}\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let kernelResult: NrekiInterceptResult | undefined;
        let ttrdFeedback = "";
        if (useKernel && deps.kernel) {
            let dependentsToInject: string[] = [];
            if (deps.nrekiMode === "hologram") {
                try {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const allDependents = await engine.findDependents(relPath);
                    if (allDependents.length <= 50) {
                        dependentsToInject = allDependents;
                    } else {
                        const oldContent = fs.readFileSync(resolvedPath, "utf-8");
                        const newContent = result.newContent!;
                        const oldExports = oldContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        const newExports = newContent.split("\n").filter(l => l.trim().startsWith("export")).join("\n");
                        if (oldExports !== newExports) {
                            releaseFileLock(resolvedPath);
                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `[NREKI] Edit blocked: signature change affects ${allDependents.length} files. ` +
                                        `Validating this cascade exceeds safe limits. ` +
                                        `Use batch_edit to migrate callers explicitly.`
                                }],
                                isError: true
                            };
                        }
                        dependentsToInject = [];
                    }
                } catch {
                    dependentsToInject = [];
                }
            }

            try {
                kernelResult = await deps.kernel.interceptAtomicBatch([
                    { targetFile: resolvedPath, proposedContent: result.newContent! },
                ], dependentsToInject);

                const verifyResult = await processKernelResult(
                    kernelResult,
                    [resolvedPath],
                    deps,
                    `## Semantic Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n\n`,
                );
                if (verifyResult.response) return verifyResult.response;
                ttrdFeedback = verifyResult.ttrdFeedback;

            } catch (kernelError) {
                logger.error(`Kernel error during edit verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit: KERNEL ERROR\n\n` +
                            `The edit passed AST validation (Layer 1) but the kernel crashed during ` +
                            `cross-file semantic verification (Layer 2).\n\n` +
                            `**Error:** ${kernelError}\n\n` +
                            `The file was NOT modified. The kernel has been reset.\n` +
                            `Retry the edit, or apply manually if you trust the change.\n\n` +
                            `[NREKI saved ~0 tokens]`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        engine.logUsage(
            "nreki_code:edit",
            Embedder.estimateTokens(new_code),
            Embedder.estimateTokens(new_code),
            result.tokensAvoided,
        );

        let blastRadiusWarning = "";
        if (result.oldRawCode && mode === "replace") {
            try {
                const sigChanged = detectSignatureChange(result.oldRawCode, new_code);
                if (sigChanged) {
                    const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                    const dependents = await engine.findDependents(relPath);
                    if (dependents.length > 0) {
                        const depList = dependents.map(d => `  - ${d}`).join("\n");
                        blastRadiusWarning =
                            `\n\n**[BLAST RADIUS]** Signature of \`${symbol}\` changed.\n` +
                            `This file is imported by:\n${depList}\n\n` +
                            `If you altered parameters or return types, use \`nreki_code action:"batch_edit"\` ` +
                            `to update those files before running tests.`;
                    }
                }
            } catch { /* non-fatal */ }
        }

        // ─── FIEDLER BRIDGE GUARD (v₂ ≈ 0 detection) ────────────────
        let bridgeGuard = "";
        try {
            const graph = await engine.getDependencyGraph();
            if (graph.clusters) {
                const relPath = path.relative(process.cwd(), resolvedPath).replace(/\\/g, "/");
                const cluster = graph.clusters.get(relPath);
                if (cluster === "bridge") {
                    const v2 = graph.v2Score?.get(relPath) || 0;
                    const inDeg = graph.inDegree.get(relPath) || 0;
                    bridgeGuard =
                        `\n\n🛑 **NREKI STRUCTURAL GUARD**\n` +
                        `Target \`${relPath}\` (v₂=${v2.toFixed(4)}) is a **CRITICAL STRUCTURAL BRIDGE** ` +
                        `between architectural domains.\n` +
                        `It is a **load-bearing wall** with ${inDeg} dependent file(s).\n\n` +
                        `**DO NOT** bypass it by creating parallel paths.\n` +
                        `If you modified its signature, use \`nreki_code action:"batch_edit"\` ` +
                        `to migrate all dependents safely.\n` +
                        `[NREKI: Fiedler Bridge Detection]`;
                }
            }
        } catch { /* non-fatal: graph may not be available */ }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Semantic Edit: SUCCESS\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n` +
                    `**Lines:** ${result.oldLines} → ${result.newLines}\n` +
                    `**Syntax:** validated ✓\n\n` +
                    `[NREKI saved ~${result.tokensAvoided.toLocaleString()} tokens vs native read+edit]` +
                    (kernelResult?.errorText ? `\n\n${kernelResult.errorText}` : "") +
                    (kernelResult?.warnings?.length ? `\n\n${kernelResult.warnings.join("\n")}` : "") +
                    ttrdFeedback +
                    blastRadiusWarning +
                    bridgeGuard,
            }],
        };
    } finally {
        releaseFileLock(resolvedPath);
    }
}

// ─── Batch Edit ─────────────────────────────────────────────────────

export async function handleBatchEdit(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, sandbox } = deps;
    await engine.initialize();

    const edits = params.edits;
    if (!edits || edits.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "edits" array is required for batch_edit.\n\n[NREKI saved ~0 tokens]`,
            }],
            isError: true,
        };
    }

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (!e.path || !e.symbol || !e.new_code) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Error: edit[${i}] missing required fields (path, symbol, new_code).\n\n[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }
    }

    const uniquePathSet = new Set<string>();
    const uniquePaths: string[] = [];
    for (const e of edits) {
        try {
            const resolved = safePath(process.cwd(), e.path);
            if (!uniquePathSet.has(resolved)) { uniquePathSet.add(resolved); uniquePaths.push(resolved); }
        } catch (err) {
            return {
                content: [{ type: "text" as const, text: `Security error in edit path "${e.path}": ${(err as Error).message}` }],
                isError: true,
            };
        }
    }

    uniquePaths.sort();
    const acquiredLocks: string[] = [];
    for (const p of uniquePaths) {
        const lock = acquireFileLock(p, "nreki_code:batch_edit");
        if (!lock.acquired) {
            for (const rp of acquiredLocks) releaseFileLock(rp);
            return {
                content: [{ type: "text" as const, text:
                    `## Batch Edit: BLOCKED\n\n` +
                    `File \`${path.relative(process.cwd(), p)}\` is locked by another edit (${lock.heldBy}, ${lock.heldForMs}ms).\n` +
                    `Wait for it to finish, then resend the full batch.\n\n[NREKI saved ~0 tokens]`
                }],
                isError: true,
            };
        }
        acquiredLocks.push(p);
    }

    if (deps.chronos) {
        for (const p of uniquePaths) {
            if (deps.chronos.isHighFriction(p) && !deps.chronos.hasReadUncompressed(p)) {
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit Blocked - High Friction File\n\n` +
                            `File \`${path.relative(process.cwd(), p)}\` has high historical error rate.\n` +
                            `You MUST read it uncompressed before including it in a batch edit.\n\n` +
                            `**ACTION REQUIRED**: Run \`nreki_code action:"read" compress:false path:"${path.relative(process.cwd(), p)}"\` first.\n\n` +
                            `[NREKI: Chronos edit gating active]`,
                    }],
                    isError: true,
                };
            }
        }
    }

    try {
        const parser = engine.getParser();
        const batchOps: BatchEditOp[] = edits.map(e => ({
            path: e.path,
            symbol: e.symbol,
            new_code: e.new_code,
            mode: (e.mode && ["replace", "insert_before", "insert_after"].includes(e.mode))
                ? e.mode as EditMode
                : "replace",
        }));

        const useKernel = await ensureKernelBooted(deps);

        const result = await batchSemanticEdit(batchOps, parser, sandbox, process.cwd(), useKernel);

        if (!result.success || (useKernel && !result.vfs)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Batch Edit: TRANSACTION ABORTED\n\n` +
                        `**Edits requested:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n` +
                        `${result.error}\n\n` +
                        `No files were modified.\n\n` +
                        `[NREKI saved ~0 tokens]`,
                }],
                isError: true,
            };
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let batchTtrdFeedback = "";
        if (useKernel && deps.kernel) {
            try {
                const kernelEdits: Array<{ targetFile: string; proposedContent: string | null }> = [];
                for (const [filePath, content] of result.vfs!.entries()) {
                    kernelEdits.push({ targetFile: filePath, proposedContent: content });
                }

                let batchDependents: string[] = [];
                if (deps.nrekiMode === "hologram" && result.oldRawCodes) {
                    try {
                        const changedFiles = new Set<string>();
                        for (const edit of batchOps) {
                            if (edit.mode && edit.mode !== "replace") continue;
                            const key = `${edit.path}::${edit.symbol}`;
                            const oldRaw = result.oldRawCodes.get(key);
                            if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                                changedFiles.add(
                                    path.relative(process.cwd(), safePath(process.cwd(), edit.path)).replace(/\\/g, "/")
                                );
                            }
                        }
                        if (changedFiles.size > 0) {
                            const allDepSet = new Set<string>();
                            for (const fp of changedFiles) {
                                const fileDeps2 = await engine.findDependents(fp);
                                for (const d of fileDeps2) allDepSet.add(d);
                            }
                            for (const fp of result.files) {
                                allDepSet.delete(fp);
                            }
                            if (allDepSet.size <= 50) {
                                batchDependents = [...allDepSet];
                            }
                        }
                    } catch { /* non-fatal */ }
                }

                if (kernelEdits.length > 0) {
                    const kernelResult = await deps.kernel.interceptAtomicBatch(kernelEdits, batchDependents, true);
                    const committedFiles = Array.from(result.vfs!.keys());

                    const verifyResult = await processKernelResult(
                        kernelResult,
                        committedFiles,
                        deps,
                        `## Batch Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                        `**Edits attempted:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n`,
                    );
                    if (verifyResult.response) return verifyResult.response;
                    batchTtrdFeedback = verifyResult.ttrdFeedback;
                }
            } catch (kernelError) {
                logger.error(`Kernel error during batch verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Batch Edit: KERNEL ERROR\n\n` +
                            `All ${result.editCount} edits passed AST validation (Layer 1) but the kernel ` +
                            `crashed during cross-file semantic verification (Layer 2).\n\n` +
                            `**Error:** ${kernelError}\n\n` +
                            `No files were modified. The kernel has been reset.\n` +
                            `Retry the batch edit, or apply edits individually.\n\n` +
                            `[NREKI saved ~0 tokens]`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        const fileList = result.files.map(f => `  - ${f}`).join("\n");

        let blastRadiusWarning = "";
        if (result.oldRawCodes) {
            try {
                const changedSymbols: string[] = [];
                for (const edit of batchOps) {
                    if (edit.mode && edit.mode !== "replace") continue;
                    const key = `${edit.path}::${edit.symbol}`;
                    const oldRaw = result.oldRawCodes.get(key);
                    if (oldRaw && detectSignatureChange(oldRaw, edit.new_code)) {
                        changedSymbols.push(edit.symbol);
                    }
                }
                if (changedSymbols.length > 0) {
                    const allDependents = new Set<string>();
                    for (const filePath of result.files) {
                        try {
                            const fileDeps = await engine.findDependents(filePath);
                            for (const d of fileDeps) allDependents.add(d);
                        } catch { /* non-fatal */ }
                    }
                    for (const f of result.files) allDependents.delete(f);

                    const depList = allDependents.size > 0
                        ? `\nFiles that import these modules:\n${[...allDependents].map(d => `  - ${d}`).join("\n")}\n`
                        : "";

                    blastRadiusWarning =
                        `\n\n**[BLAST RADIUS]** Signature changed for: ${changedSymbols.map(s => `\`${s}\``).join(", ")}.` +
                        depList +
                        `\nIf you altered parameters or return types, use \`nreki_code action:"batch_edit"\` to update those files before running tests.`;
                }
            } catch { /* non-fatal */ }
        }

        return {
            content: [{
                type: "text" as const,
                text:
                    `## Batch Edit: SUCCESS\n\n` +
                    `**Edits applied:** ${result.editCount}\n` +
                    `**Files modified:** ${result.fileCount}\n` +
                    `${fileList}\n\n` +
                    `All files passed syntax validation.\n` +
                    `Run \`npm run typecheck\` or your tests to verify types.\n\n` +
                    `[NREKI batch edit complete]` +
                    batchTtrdFeedback +
                    blastRadiusWarning,
            }],
        };
    } finally {
        for (const p of acquiredLocks) releaseFileLock(p);
    }
}
