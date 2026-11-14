/**
 * code/edit.ts - handleEdit + handleBatchEdit handlers.
 */

import path from "path";
import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import type { NrekiInterceptResult } from "../../kernel/nreki-kernel.js";
import { estimateTokens } from "../../utils/token-estimator.js";
import { safePath } from "../../utils/path-jail.js";
import { semanticEdit, batchSemanticEdit, detectSignatureChange, type EditMode, type BatchEditOp } from "../../semantic-edit.js";
import { acquireFileLock, releaseFileLock } from "../../middleware/file-lock.js";
import { logger } from "../../utils/logger.js";
import { ensureKernelBooted, processKernelResult } from "./kernel-bridge.js";
import { buildValidationBanner, describeKernelUnavailable, type DependentsScope } from "./validation-banner.js";
import { formatBlastRadius, verifiedImporters } from "./blast-radius.js";

/** Max importers type-checked per edit in file/hologram mode (unveil/check cost bound). */
const DEPENDENT_CHECK_CAP = 50;

const isConflictError = (err: unknown): boolean => (err as Error)?.name === "NrekiConflictError";

/** True when the file's semantic checker is an LSP sidecar (Go, Python). A failing lookup means "no". */
function isLspCovered(kernel: NonNullable<RouterDependencies["kernel"]>, file: string): boolean {
    try {
        return kernel.getSemanticCoverage(file).backend === "lsp";
    } catch {
        return false;
    }
}

/** The TypeScript program can type-check this importer: not a test under another tsconfig, not plain JS. */
function inTypeScriptProgram(kernel: NonNullable<RouterDependencies["kernel"]>, file: string): boolean {
    try {
        const cov = kernel.getSemanticCoverage(file);
        return cov.backend === "typescript" && !cov.outsideProgram;
    } catch {
        return false;
    }
}

/**
 * File mode, TypeScript: the importers of `files`, from the import graph and from
 * the compiler's own resolution (tsconfig aliases, which the graph misses), split
 * into those the program checks and those it cannot. The kernel used to be
 * handed importers outside the program: it skipped them, and they were counted
 * as checked.
 */
async function typeScriptImporters(
    deps: RouterDependencies, files: string[], graphImporters: Iterable<string>,
): Promise<{ inside: string[]; outside: number }> {
    const found = new Set<string>(graphImporters);
    for (const d of (await deps.kernel!.findTypeScriptImporters(files)) ?? []) found.add(d);
    for (const f of files) found.delete(f.replace(/\\/g, "/"));
    const inside = [...found].filter(d => inTypeScriptProgram(deps.kernel!, d));
    return { inside, outside: found.size - inside.length };
}

/** Files auto-heal patched beyond the ones edited: their importers were not checked. */
function healedOthers(result: NrekiInterceptResult | undefined, edited: string[]): string[] {
    const norm = (p: string) => {
        const posix = path.resolve(p).replace(/\\/g, "/");
        return process.platform === "win32" ? posix.toLowerCase() : posix;
    };
    const mine = new Set(edited.map(norm));
    return (result?.healedFiles ?? []).filter(f => !mine.has(norm(f)));
}

/** Copy-pasteable recovery call. JSON.stringify escapes quotes/backslashes in paths. */
function chronosRecoveryCall(filePath: string): string {
    return JSON.stringify({
        name: "nreki_code",
        arguments: { action: "read", path: filePath, compress: false, _nreki_bypass: "chronos_recovery" },
    });
}

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
    const search_text = typeof params.search_text === "string" ? params.search_text : undefined;
    const replace_text = typeof params.replace_text === "string" ? params.replace_text : undefined;

    const mode = (typeof params.mode === "string" && ["replace", "insert_before", "insert_after", "patch"].includes(params.mode))
        ? params.mode as EditMode
        : "replace";

    if (!symbol) {
        return { content: [{ type: "text" as const, text: `Error: "symbol" is required.` }], isError: true };
    }
    if (mode !== "patch" && !new_code) {
        return { content: [{ type: "text" as const, text: `Error: "new_code" is required for mode "${mode}".` }], isError: true };
    }
    if (mode === "patch" && (!search_text || search_text.length < 2)) {
        return { content: [{ type: "text" as const, text: `Error: "search_text" (min 2 chars) is required for patch mode.` }], isError: true };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(engine.getProjectRoot(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
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
                    `Wait for the current edit to complete and retry.`,
            }],
            isError: true,
        };
    }

    // A patch is matched against the current source: it needs no full read first
    // (the block cost a read turn for an edit that cannot touch unseen code).
    if (mode !== "patch" && deps.chronos && deps.chronos.isHighFriction(resolvedPath)) {
        if (!deps.chronos.hasReadUncompressed(resolvedPath)) {
            releaseFileLock(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Edit Blocked - High Friction File\n\n` +
                        `File \`${path.basename(resolvedPath)}\` has high historical error rate.\n` +
                        `Required: read the full file before editing, with chronos recovery bypass.\n\n` +
                        `**Emit this exact JSON-RPC tool call:**\n` +
                        `\`\`\`json\n` +
                        `${chronosRecoveryCall(file)}\n` +
                        `\`\`\`\n\n` +
                        `After NREKI returns the file content, retry your edit.`,
                }],
                isError: true,
            };
        }
    }

    try {
        const parser = engine.getParser();

        const useKernel = await ensureKernelBooted(deps);

        const result = await semanticEdit(
            resolvedPath,
            symbol,
            new_code || undefined,
            parser,
            sandbox,
            engine.getProjectRoot(),
            mode,
            useKernel,
            search_text,
            replace_text,
        );

        if (!result.success || (useKernel && !result.newContent)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Semantic Edit: FAILED\n\n` +
                        `**Symbol:** ${symbol}\n` +
                        `**File:** ${file}\n\n` +
                        `${result.error}`,
                }],
                isError: true,
            };
        }

        if (result.newContent) {
            engine.expectInternalEdit(resolvedPath, result.newContent);
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let kernelResult: NrekiInterceptResult | undefined;
        let ttrdFeedback = "";
        const depScope: DependentsScope = { lookedUp: false, checked: 0, total: 0 };
        // Importers handed to the kernel with the edit: TypeScript ones are
        // type-checked, Go/Python ones are opened in their LSP sidecar.
        let dependentsToInject: string[] = [];
        let lspImportersUnknown = false;
        if (useKernel && deps.kernel) {
            const relPath = path.relative(engine.getProjectRoot(), resolvedPath).replace(/\\/g, "/");
            if (isLspCovered(deps.kernel, resolvedPath)) {
                // Go/Python, in every mode: gopls/pyright only report OPEN documents,
                // so the kernel opens the importers (plus the files of the same Go
                // package) before it measures the edit. It caps them and reports
                // how many it left out.
                try {
                    dependentsToInject = await engine.findDependents(relPath);
                } catch {
                    lspImportersUnknown = true;
                }
            } else if (deps.nrekiMode === "file") {
                // NREKI-INT-06: file mode used to type-check ONLY the edited file, so a
                // signature change breaking every importer was committed as [OK].
                try {
                    const { inside, outside } = await typeScriptImporters(deps, [relPath], await engine.findDependents(relPath));
                    dependentsToInject = inside.slice(0, DEPENDENT_CHECK_CAP);
                    Object.assign(depScope, { lookedUp: true, total: inside.length, notInProgram: outside });
                } catch {
                    dependentsToInject = [];
                }
            } else if (deps.nrekiMode === "hologram") {
                try {
                    const allDependents = await engine.findDependents(relPath);
                    Object.assign(depScope, { lookedUp: true, total: allDependents.length });
                    if (allDependents.length <= DEPENDENT_CHECK_CAP) {
                        dependentsToInject = allDependents;
                    } else {
                        // O(1) AST-based signature diff. The old split("\n")
                        // approach missed multiline exports (Prettier formatting) entirely.
                        // detectSignatureChange (already used at L206) + oldRawCode/newRawCode
                        // (already in semanticEdit result) = zero extra I/O, zero parser.
                        let sigChanged = false;
                        if (mode === "replace" || mode === "patch") {
                            if (result.oldRawCode && result.newRawCode) {
                                const oldExported = result.oldRawCode.trim().startsWith("export");
                                const newExported = result.newRawCode.trim().startsWith("export");
                                if (oldExported !== newExported || (oldExported && detectSignatureChange(result.oldRawCode, result.newRawCode))) {
                                    sigChanged = true;
                                }
                            }
                        } else if (result.newRawCode && result.newRawCode.trim().startsWith("export")) {
                            sigChanged = true;
                        }

                        if (sigChanged) {
                            releaseFileLock(resolvedPath);
                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `Edit blocked: signature change affects ${allDependents.length} files. ` +
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
            depScope.checked = dependentsToInject.length;

            try {
                kernelResult = await deps.kernel.interceptAtomicBatch([
                    { targetFile: resolvedPath, proposedContent: result.newContent!, baseContent: result.baseContent },
                ], dependentsToInject, params.compute_diff === true);

                const verifyResult = await processKernelResult(
                    kernelResult,
                    [resolvedPath],
                    deps,
                    `## Semantic Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                    `**Symbol:** ${symbol}\n` +
                    `**File:** ${file}\n\n`,
                );
                if (verifyResult.response) {
                    engine.cancelInternalEdit(resolvedPath);
                    return verifyResult.response;
                }
                ttrdFeedback = verifyResult.ttrdFeedback;

            } catch (kernelError) {
                engine.cancelInternalEdit(resolvedPath);
                logger.error(`Kernel error during edit verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                if (isConflictError(kernelError)) {
                    return {
                        content: [{ type: "text" as const, text: `## Edit: CONFLICT\n\n${(kernelError as Error).message}` }],
                        isError: true,
                    };
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
                            `Retry the edit, or apply manually if you trust the change.`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        {
            const healerActed = useKernel && kernelResult?.healedFiles && kernelResult.healedFiles.length > 0;
            if (result.topologyChanged || healerActed) {
                engine.invalidateCachedGraph();
            }
        }

        engine.logUsage(
            "nreki_code:edit",
            estimateTokens(result.newRawCode ?? new_code),
            estimateTokens(result.newRawCode ?? new_code),
            result.tokensAvoided,
        );

        let blastRadiusWarning = "";
        if (result.oldRawCode && result.newRawCode && (mode === "replace" || mode === "patch")) {
            try {
                const sigChanged = detectSignatureChange(result.oldRawCode, result.newRawCode);
                if (sigChanged) {
                    const relPath = path.relative(engine.getProjectRoot(), resolvedPath).replace(/\\/g, "/");
                    const dependents = await engine.findDependents(relPath);
                    if (dependents.length > 0) {
                        blastRadiusWarning = formatBlastRadius(
                            `Signature of "${symbol}" changed`,
                            dependents,
                            verifiedImporters(dependents, {
                                kernelRan: useKernel && !!kernelResult,
                                kernel: deps.kernel,
                                mode: deps.nrekiMode,
                                injected: dependentsToInject,
                                degradedLanguages: kernelResult?.degradedLanguages,
                                lspCoverage: kernelResult?.lspCoverage,
                            }),
                        );
                    }
                }
            } catch { /* non-fatal */ }
        }

        // ─── FIEDLER BRIDGE GUARD (v₂ ≈ 0 detection) ────────────────
        let bridgeGuard = "";
        try {
            const graph = await engine.getDependencyGraph();
            if (graph.clusters) {
                const relPath = path.relative(engine.getProjectRoot(), resolvedPath).replace(/\\/g, "/");
                const cluster = graph.clusters.get(relPath);
                if (cluster === "bridge") {
                    const v2 = graph.v2Score?.get(relPath) || 0;
                    const inDeg = graph.inDegree.get(relPath) || 0;
                    bridgeGuard =
                        `\n[BRIDGE GUARD] ${relPath} (v2=${v2.toFixed(4)}) is a critical structural bridge ` +
                        `with ${inDeg} dependent(s). Fix dependents via batch_edit if signature changed.`;
                }
            }
        } catch { /* non-fatal: graph may not be available */ }

        // Dense M2M telemetry
        logger.info(`[EDIT] ${file}::${symbol} — saved ~${result.tokensAvoided} tokens`);

        let feedback = `[OK] ${file} modified: ${symbol} (${result.oldLines}→${result.newLines} lines)`;
        if (kernelResult?.errorText) feedback += `\n${kernelResult.errorText}`;
        if (kernelResult?.warnings?.length) feedback += `\n${kernelResult.warnings.join("\n")}`;
        if (ttrdFeedback) feedback += `\n[TTRD] ${ttrdFeedback.replace(/\n/g, " ").trim()}`;
        if (blastRadiusWarning) feedback += blastRadiusWarning;
        if (bridgeGuard) feedback += bridgeGuard;
        feedback += "\n" + buildValidationBanner({
            kernelRan: useKernel && !!deps.kernel,
            reasonNoKernel: describeKernelUnavailable(!!deps.kernel, deps.nrekiMode),
            mode: deps.nrekiMode,
            files: [resolvedPath],
            coverage: deps.kernel ? (f) => deps.kernel!.getSemanticCoverage(f) : undefined,
            degradedLanguages: kernelResult?.degradedLanguages,
            dependents: depScope,
            lspCoverage: kernelResult?.lspCoverage,
            lspImportersUnknown,
            exportedApiUnchanged: kernelResult?.exportedApiUnchanged,
            declaresGlobals: kernelResult?.declaresGlobals,
            programChanged: kernelResult?.programChanged,
            healedOthers: healedOthers(kernelResult, [resolvedPath]),
        });

        return {
            content: [{
                type: "text" as const,
                text: feedback.trim(),
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
                text: `Error: "edits" array is required for batch_edit.`,
            }],
            isError: true,
        };
    }

    for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        if (!e.path || !e.symbol) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Error: edit[${i}] missing required fields (path, symbol).`,
                }],
                isError: true,
            };
        }
        if (e.mode !== "patch" && !e.new_code) {
            return {
                content: [{
                    type: "text" as const,
                    text: `Error: edit[${i}] missing "new_code" (required for ${e.mode ?? "replace"} mode).`,
                }],
                isError: true,
            };
        }
    }

    const uniquePathSet = new Set<string>();
    const uniquePaths: string[] = [];
    for (const e of edits) {
        try {
            const resolved = safePath(engine.getProjectRoot(), e.path);
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
                    `File \`${path.relative(engine.getProjectRoot(), p)}\` is locked by another edit (${lock.heldBy}, ${lock.heldForMs}ms).\n` +
                    `Wait for it to finish, then resend the full batch.`
                }],
                isError: true,
            };
        }
        acquiredLocks.push(p);
    }

    if (deps.chronos) {
        for (const p of uniquePaths) {
            // Only patches for this file: matched against its source, no full read needed.
            const onlyPatches = edits.every(e => {
                try { return safePath(engine.getProjectRoot(), e.path) !== p || e.mode === "patch"; } catch { return true; }
            });
            if (!onlyPatches && deps.chronos.isHighFriction(p) && !deps.chronos.hasReadUncompressed(p)) {
                for (const rp of acquiredLocks) releaseFileLock(rp);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Edit Blocked - High Friction File\n\n` +
                            `File \`${path.relative(engine.getProjectRoot(), p)}\` has high historical error rate.\n` +
                            `Required: read the full file before editing, with chronos recovery bypass.\n\n` +
                            `**Emit this exact JSON-RPC tool call:**\n` +
                            `\`\`\`json\n` +
                            `${chronosRecoveryCall(path.relative(engine.getProjectRoot(), p))}\n` +
                            `\`\`\`\n\n` +
                            `After NREKI returns the file content, retry your batch edit.`,
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
            mode: (e.mode && ["replace", "insert_before", "insert_after", "patch"].includes(e.mode))
                ? e.mode as EditMode
                : "replace",
            search_text: e.search_text,
            replace_text: e.replace_text,
        }));

        const useKernel = await ensureKernelBooted(deps);

        const result = await batchSemanticEdit(batchOps, parser, sandbox, engine.getProjectRoot(), useKernel);

        if (!result.success || (useKernel && !result.vfs)) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `## Batch Edit: TRANSACTION ABORTED\n\n` +
                        `**Edits requested:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n` +
                        `${result.error}\n\n` +
                        `No files were modified.`,
                }],
                isError: true,
            };
        }

        if (result.vfs) {
            for (const [vfsPath, virtualContent] of result.vfs.entries()) {
                engine.expectInternalEdit(vfsPath, virtualContent);
            }
        }

        // ─── NREKI Layer 2: Cross-file semantic verification ─────────
        let batchKernelResult: NrekiInterceptResult | undefined;
        let batchTtrdFeedback = "";
        const batchDepScope: DependentsScope = { lookedUp: false, checked: 0, total: 0 };
        // Importers handed to the kernel with the batch (TS: type-checked; Go/Python: opened in the LSP).
        let batchInjected: string[] = [];
        let batchLspImportersUnknown = false;
        if (useKernel && deps.kernel) {
            try {
                const kernelEdits: Array<{ targetFile: string; proposedContent: string | null; baseContent?: string }> = [];
                for (const [filePath, content] of result.vfs!.entries()) {
                    kernelEdits.push({ targetFile: filePath, proposedContent: content, baseContent: result.baseContents?.get(filePath) });
                }

                // result.files are OS-relative (backslashes on Windows); the graph is POSIX.
                const batchFiles = new Set(result.files.map(f => f.replace(/\\/g, "/")));
                const isLspFile = (rel: string): boolean => isLspCovered(deps.kernel!, rel);

                // Go/Python files, in every mode: their importers are opened in the
                // LSP sidecar with the edit (it only reports open documents).
                const lspDependents = new Set<string>();
                try {
                    for (const fp of batchFiles) {
                        if (!isLspFile(fp)) continue;
                        for (const d of await engine.findDependents(fp)) {
                            if (!batchFiles.has(d)) lspDependents.add(d);
                        }
                    }
                } catch {
                    batchLspImportersUnknown = true;
                }

                let batchDependents: string[] = [];
                if (deps.nrekiMode === "file" || deps.nrekiMode === "hologram") {
                    let sigChanged = false;
                    let allDepSet: Set<string> | undefined;
                    try {
                        for (const edit of batchOps) {
                            if (edit.mode && edit.mode !== "replace" && edit.mode !== "patch") continue;
                            if (isLspFile(edit.path)) continue; // the importer cap below is TypeScript's
                            const key = `${safePath(engine.getProjectRoot(), edit.path)}::${edit.symbol}`;
                            const oldRaw = result.oldRawCodes?.get(key);
                            const newRaw = result.newRawCodes?.get(key);
                            if (oldRaw && newRaw && detectSignatureChange(oldRaw, newRaw)) sigChanged = true;
                        }
                        allDepSet = new Set<string>();
                        for (const fp of batchFiles) {
                            if (isLspFile(fp)) continue;
                            for (const d of await engine.findDependents(fp)) allDepSet.add(d);
                        }
                        for (const fp of batchFiles) allDepSet.delete(fp);
                        let notInProgram = 0;
                        if (deps.nrekiMode === "file") {
                            const tsFiles = [...batchFiles].filter(fp => !isLspFile(fp));
                            const { inside, outside } = await typeScriptImporters(deps, tsFiles, allDepSet);
                            allDepSet = new Set(inside.filter(d => !batchFiles.has(d)));
                            notInProgram = outside;
                        }
                        Object.assign(batchDepScope, { lookedUp: true, total: allDepSet.size, notInProgram });
                    } catch { /* graph unavailable — reported in the banner */ }

                    if (allDepSet) {
                        if (allDepSet.size <= DEPENDENT_CHECK_CAP) {
                            batchDependents = [...allDepSet];
                        } else if (deps.nrekiMode === "file") {
                            batchDependents = [...allDepSet].slice(0, DEPENDENT_CHECK_CAP);
                        } else if (sigChanged) {
                            // NREKI-INT-06: mirror handleEdit. The batch path used to fall
                            // through with ZERO dependents and commit, leaving every caller
                            // outside the batch unvalidated.
                            for (const vfsPath of result.vfs!.keys()) engine.cancelInternalEdit(vfsPath);
                            return {
                                content: [{
                                    type: "text" as const,
                                    text:
                                        `## Batch Edit: BLOCKED\n\n` +
                                        `Signature change affects ${allDepSet.size} importer(s) outside this batch ` +
                                        `(hologram mode validates at most ${DEPENDENT_CHECK_CAP}). ` +
                                        `Add the affected callers to the batch until ≤ ${DEPENDENT_CHECK_CAP} remain outside, ` +
                                        `or split the change. No files were modified.`,
                                }],
                                isError: true,
                            };
                        }
                    }
                }
                batchDepScope.checked = batchDependents.length;
                batchInjected = [...batchDependents, ...lspDependents];

                if (kernelEdits.length > 0) {
                    batchKernelResult = await deps.kernel.interceptAtomicBatch(kernelEdits, batchInjected, params.compute_diff === true);
                    const committedFiles = Array.from(result.vfs!.keys());

                    const verifyResult = await processKernelResult(
                        batchKernelResult,
                        committedFiles,
                        deps,
                        `## Batch Edit: BLOCKED BY NREKI (Layer 2)\n\n` +
                        `**Edits attempted:** ${result.editCount}\n` +
                        `**Files involved:** ${result.fileCount}\n\n`,
                    );
                    if (verifyResult.response) {
                        if (result.vfs) {
                            for (const vfsPath of result.vfs.keys()) {
                                engine.cancelInternalEdit(vfsPath);
                            }
                        }
                        return verifyResult.response;
                    }
                    batchTtrdFeedback = verifyResult.ttrdFeedback;
                }
            } catch (kernelError) {
                if (result.vfs) {
                    for (const vfsPath of result.vfs.keys()) {
                        engine.cancelInternalEdit(vfsPath);
                    }
                }
                logger.error(`Kernel error during batch verification: ${kernelError}`);
                try { await deps.kernel.rollbackAll(); } catch (e) {
                    logger.error(`Rollback after kernel crash also failed: ${e}`);
                }
                for (const rp of acquiredLocks) releaseFileLock(rp);
                if (isConflictError(kernelError)) {
                    return {
                        content: [{ type: "text" as const, text: `## Batch Edit: CONFLICT\n\n${(kernelError as Error).message}` }],
                        isError: true,
                    };
                }
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `## Batch Edit: KERNEL ERROR\n\n` +
                            `All ${result.editCount} edits passed AST validation (Layer 1) but the kernel ` +
                            `crashed during cross-file semantic verification (Layer 2).\n\n` +
                            `**Error:** ${kernelError}\n\n` +
                            `No files were modified. The kernel has been reset.\n` +
                            `Retry the batch edit, or apply edits individually.`,
                    }],
                    isError: true,
                };
            }
        }
        // ─── End NREKI Layer 2 ───────────────────────────────────────

        {
            const healerActed = useKernel && batchKernelResult?.healedFiles && batchKernelResult.healedFiles.length > 0;
            if (result.topologyChanged || healerActed) {
                engine.invalidateCachedGraph();
            }
        }

        let blastRadiusWarning = "";
        if (result.oldRawCodes && result.newRawCodes) {
            try {
                const changedSymbols: string[] = [];
                for (const edit of batchOps) {
                    if (edit.mode && edit.mode !== "replace" && edit.mode !== "patch") continue;
                    const key = `${safePath(engine.getProjectRoot(), edit.path)}::${edit.symbol}`;
                    const oldRaw = result.oldRawCodes.get(key);
                    const newRaw = result.newRawCodes.get(key);
                    if (oldRaw && newRaw && detectSignatureChange(oldRaw, newRaw)) {
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
                    for (const f of result.files) allDependents.delete(f.replace(/\\/g, "/"));

                    const importers = [...allDependents];
                    blastRadiusWarning = formatBlastRadius(
                        `Signature changed: ${changedSymbols.join(", ")}`,
                        importers,
                        verifiedImporters(importers, {
                            kernelRan: useKernel && !!batchKernelResult,
                            kernel: deps.kernel,
                            mode: deps.nrekiMode,
                            injected: batchInjected,
                            degradedLanguages: batchKernelResult?.degradedLanguages,
                            lspCoverage: batchKernelResult?.lspCoverage,
                        }),
                    );
                }
            } catch { /* non-fatal */ }
        }

        logger.info(`[BATCH_EDIT] ${result.fileCount} files — complete`);

        // POSIX separators: a Windows "\" is escaped to "\\" by every JSON transport.
        let feedback = `[OK] ${result.fileCount} files modified: ${result.files.map(f => f.replace(/\\/g, "/")).join(", ")}`;
        // NREKI-GAR-02: batch_edit is the path agents are told to use, yet it dropped
        // auto-heal notices (incl. collateral files NREKI patched on disk), LSP
        // offline/failed warnings and Python/Go TTRD alerts. handleEdit always had them.
        if (batchKernelResult?.errorText) feedback += `\n${batchKernelResult.errorText}`;
        if (batchKernelResult?.warnings?.length) feedback += `\n${batchKernelResult.warnings.join("\n")}`;
        if (batchTtrdFeedback) feedback += `\n[TTRD] ${batchTtrdFeedback.replace(/\n/g, " ").trim()}`;
        if (blastRadiusWarning) feedback += blastRadiusWarning;
        feedback += "\n" + buildValidationBanner({
            kernelRan: useKernel && !!deps.kernel,
            reasonNoKernel: describeKernelUnavailable(!!deps.kernel, deps.nrekiMode),
            mode: deps.nrekiMode,
            files: result.vfs ? [...result.vfs.keys()] : result.files,
            coverage: deps.kernel ? (f) => deps.kernel!.getSemanticCoverage(f) : undefined,
            degradedLanguages: batchKernelResult?.degradedLanguages,
            dependents: batchDepScope,
            lspCoverage: batchKernelResult?.lspCoverage,
            lspImportersUnknown: batchLspImportersUnknown,
            exportedApiUnchanged: batchKernelResult?.exportedApiUnchanged,
            declaresGlobals: batchKernelResult?.declaresGlobals,
            programChanged: batchKernelResult?.programChanged,
            healedOthers: healedOthers(batchKernelResult, result.vfs ? [...result.vfs.keys()] : result.files),
        });

        return {
            content: [{
                type: "text" as const,
                text: feedback.trim(),
            }],
        };
    } finally {
        for (const p of acquiredLocks) releaseFileLock(p);
    }
}
