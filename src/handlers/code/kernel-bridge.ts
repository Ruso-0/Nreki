/**
 * kernel-bridge.ts - Kernel boot + post-intercept verification pipeline.
 *
 * ensureHologramReady, ensureKernelBooted, processKernelResult
 */

import path from "path";
import type { McpToolResponse, RouterDependencies } from "../../router.js";
import type { NrekiInterceptResult, TypeRegression } from "../../kernel/nreki-kernel.js";
import type { NrekiKernel } from "../../kernel/nreki-kernel.js";
import { saveBackup, snapshotBackups } from "../../undo.js";
import { logger } from "../../utils/logger.js";
import { formatErrorList } from "../../kernel/error-format.js";

// ─── Domain-specific helper (NOT shared) ────────────────────────────

export async function ensureHologramReady(kernel: NrekiKernel, nrekiMode: string, projectRoot: string): Promise<void> {
    if (nrekiMode !== "hologram" || kernel.hasShadows() || kernel.hasJitHologram()) return;
    try {
        const Parser = (await import("web-tree-sitter")).default;
        await Parser.init();
        const jitParser = new Parser();
        const wasmDir = path.join(
            path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
            "..", "..", "..", "wasm",
        );
        const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
        const tsLanguage = await Parser.Language.load(tsLangPath);
        jitParser.setLanguage(tsLanguage);
        const { classifyAndGenerateShadow } = await import("../../hologram/shadow-generator.js");
        kernel.setJitParser(jitParser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        logger.info("JIT Holography: parser loaded on-demand.");
    } catch (err) {
        logger.warn(`JIT init failed: ${(err as Error).message}. Falling back to eager scan.`);
        const { ParserPool } = await import("../../parser-pool.js");
        const { scanProject } = await import("../../hologram/shadow-generator.js");
        const pool = new ParserPool(4);
        const scanResult = await scanProject(projectRoot, pool);
        kernel.setShadows(scanResult.prunable, scanResult.unprunable, scanResult.ambientFiles);
    }
}

/** Shared kernel boot logic for edit handlers. */
export async function ensureKernelBooted(deps: RouterDependencies): Promise<boolean> {
    if (!deps.kernel || deps.nrekiMode === "syntax") return false;
    if (!deps.kernel.isBooted()) {
        logger.info(
            `Booting kernel (${deps.nrekiMode} mode). First edit will be slower.`
        );
        try {
            await ensureHologramReady(deps.kernel, deps.nrekiMode ?? "", deps.engine.getProjectRoot());
            deps.kernel.boot(
                deps.engine.getProjectRoot(),
                deps.nrekiMode as "file" | "project" | "hologram",
            );
        } catch (err) {
            logger.error(
                `Kernel boot failed: ${(err as Error).message}. Falling back to Layer 1.`
            );
        }
    }
    return deps.kernel.isBooted();
}

// ─── H-07: Shared kernel verification + TTRD + Chronos logic ────────
//
// Extracted from handleEdit and handleBatchEdit to eliminate ~150 lines
// of duplicated post-intercept logic.

/**
 * Shared kernel verification pipeline (Layer 2).
 *
 * Given a kernel intercept result, performs:
 *   1. node_modules error filtering
 *   2. Chronos error recording
 *   3. Backup + commit/rollback
 *   4. TTRD regression tracking + debt payment
 *   5. Chronos friction sync
 *
 * @param kernelResult - result from interceptAtomicBatch
 * @param committedFiles - paths that were committed (for backup + Chronos)
 * @param deps - router dependencies (kernel, chronos)
 * @param rejectionHeader - header text for the rejection response
 */
export async function processKernelResult(
    kernelResult: NrekiInterceptResult,
    committedFiles: string[],
    deps: RouterDependencies,
    rejectionHeader: string,
): Promise<{ committed: boolean; ttrdFeedback: string; response?: McpToolResponse }> {
    const kernel = deps.kernel!;
    let ttrdFeedback = "";

    if (!kernelResult.safe) {
        // NREKI-INT-01: node_modules diagnostics are filtered inside the compiler
        // wrapper, BEFORE the verdict. By the time safe === false arrives here the
        // kernel has already rolled the transaction back, so "committing anyway"
        // wrote zero bytes while answering [OK]. A rejection is always a rejection.
        const agentErrors = kernelResult.structured ?? [];

        // Real errors in agent code — record + rollback
        if (deps.chronos) {
            const errorByFile = new Map<string, string>();
            for (const e of agentErrors) {
                if (!errorByFile.has(e.file)) errorByFile.set(e.file, e.message);
            }
            for (const [fragileFile, firstMsg] of errorByFile.entries()) {
                deps.chronos.recordSemanticError(fragileFile, firstMsg);
            }
        }

        await kernel.rollbackAll();

        // Bounded: the edited files first, the rest summarised (see error-format.ts).
        const projectRoot = deps.engine.getProjectRoot();
        const edited = new Set(committedFiles.map(f => kernel.resolvePosixPath(f)));
        const structuredInfo = agentErrors.length > 0
            ? `\n\nSemantic errors (${agentErrors.length}):\n` +
                formatErrorList(agentErrors, {
                    displayPath: (file) => path.relative(projectRoot, path.resolve(projectRoot, file)),
                    isPrimary: (e) => edited.has(kernel.resolvePosixPath(e.file)),
                })
            : `\n\n${kernelResult.errorText ?? "Validation rejected the edit."}`;

        return {
            committed: false,
            ttrdFeedback,
            response: {
                content: [{
                    type: "text" as const,
                    text:
                        `${rejectionHeader}` +
                        `Layer 1 (syntax) passed, but Layer 2 (cross-file semantics) detected errors.\n` +
                        `DISK UNTOUCHED — caught in RAM, no files modified.${structuredInfo}\n\n` +
                        `Fix the type errors and retry. If you changed a function signature, ` +
                        `use \`nreki_code action:"batch_edit"\` to update all callers in one atomic transaction.`,
                }],
                isError: true,
            },
        };
    }

    // ─── Safe: backup → commit → TTRD ───
    const root = deps.engine.getProjectRoot();
    const healed = (kernelResult.healedFiles ?? []).map(hf => path.resolve(root, hf));
    const backupTargets = [...committedFiles, ...healed];
    // If the commit aborts (conflict / OS error), the previous backups come back:
    // undo must still reach the state before the last SUCCESSFUL edit (I-03).
    const previousBackups = snapshotBackups(root, backupTargets);
    for (const fp of backupTargets) {
        try { saveBackup(root, fp); } catch {}
    }

    try {
        await kernel.commitToDisk();
    } catch (err) {
        previousBackups.restore();
        throw err;
    }
    // Only heals that actually reached disk count in the file history.
    if (deps.chronos) for (const hf of kernelResult.healedFiles ?? []) deps.chronos.recordHeal(hf);

    if (deps.chronos && kernelResult.postContracts) {
        // Regression tracking
        if (kernelResult.regressions && kernelResult.regressions.length > 0) {
            const byFile = new Map<string, TypeRegression[]>();
            for (const r of kernelResult.regressions) {
                const arr = byFile.get(r.filePath) || [];
                arr.push(r);
                byFile.set(r.filePath, arr);
            }

            const penaltyList: string[] = [];
            for (const [fPath, regs] of byFile.entries()) {
                deps.chronos.recordRegressions(path.resolve(deps.engine.getProjectRoot(), fPath), regs);
                for (const r of regs) {
                    penaltyList.push(`  - \`${r.symbol}\` in \`${path.basename(fPath)}\`: \`${r.oldType}\` -> \`${r.newType}\``);
                }
            }

            ttrdFeedback += `\n\n**TYPE REGRESSION DETECTED**\n` +
                `The edit compiled successfully, but weakened type safety:\n` +
                `${penaltyList.join("\n")}\n` +
                `This technical debt has been logged. Restore strict typing instead of using any/unknown.`;
        }

        // Debt payment tracking — v10.7.0: quantify CFI discount for the
        // LLM so the reinforcement loop carries a measurable reward, not a
        // vague "debt paid" message.
        const allPaid: string[] = [];
        let totalCfiDiscount = 0;
        for (const fp of committedFiles) {
            const posixPath = kernel.resolvePosixPath(fp);
            const fileContracts = kernelResult.postContracts.get(posixPath);

            const cfiBefore = deps.chronos.getFileCFI(fp);
            const paid = deps.chronos.assessDebtPayments(fp, fileContracts);
            const cfiAfter = deps.chronos.getFileCFI(fp);

            if (paid.length > 0) {
                totalCfiDiscount += (cfiBefore - cfiAfter);
                allPaid.push(`\`${path.basename(fp)}\`: ${paid.join(", ")}`);
            }

            const hasRegressionHere = kernelResult.regressions?.some(
                r => r.filePath === posixPath
            );
            if (!hasRegressionHere) {
                deps.chronos.recordSuccess(fp);
            }
        }

        if (allPaid.length > 0) {
            ttrdFeedback += `\n\n**[TTRD BOUNTY] TYPE DEBT PAID** 🏆\n` +
                `Strict typing restored for: ${allPaid.join(" | ")}.\n` +
                `Technical debt resolved. File friction score (CFI) reduced by ${totalCfiDiscount.toFixed(1)} points. Excellent engineering.`;
        }

        deps.chronos.syncTechDebt(
            kernel.getInitialErrorCount(),
            kernel.getCurrentErrorCount(),
        );
    } else if (deps.chronos) {
        for (const fp of committedFiles) {
            deps.chronos.recordSuccess(fp);
        }
        deps.chronos.syncTechDebt(
            kernel.getInitialErrorCount(),
            kernel.getCurrentErrorCount(),
        );
    }

    if (kernelResult.architectureDiff) {
        ttrdFeedback += kernelResult.architectureDiff;
    }

    return { committed: true, ttrdFeedback };
}
