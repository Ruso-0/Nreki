// src/kernel/healer.ts
import * as path from "path";
import type {
    NrekiStructuredError,
    MicroUndoState,
    HealingResult,
    TsHealingContext,
    LspHealingContext,
} from "./types.js";

export async function attemptAutoHealing(
    initialErrors: NrekiStructuredError[],
    parentEditedFiles: ReadonlySet<string>,
    filesToEvaluate: Set<string>,
    ctx: TsHealingContext,
): Promise<HealingResult> {
    if (initialErrors.length === 0) {
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    const MAX_ITERATIONS = 10;
    const fixDescriptions = new Set<string>();
    const localEditedFiles = new Set(parentEditedFiles);
    const newlyTouchedFiles = new Set<string>();
    const healUndoLog = new Map<string, MicroUndoState>();
    const failedFixHashes = new Set<string>();

    let currentErrors: NrekiStructuredError[] = initialErrors;
    let iteration = 0;

    while (currentErrors.length > 0 && iteration < MAX_ITERATIONS) {
        let appliedAnyFix = false;

        for (const error of currentErrors) {
            const fixes = await ctx.getAutoFixes(error.file, error);
            if (fixes.length === 0) continue;
            const bestFix = fixes[0];
            const fixHash = `${error.file}:${error.line}:${bestFix.description}`;
            if (failedFixHashes.has(fixHash)) continue;

            const microUndoLog = new Map<string, MicroUndoState>();
            for (const change of bestFix.changes) {
                const state = ctx.createSavepoint(change.filePath);
                microUndoLog.set(change.filePath, state);
                if (!healUndoLog.has(change.filePath)) healUndoLog.set(change.filePath, state);
            }

            for (const change of bestFix.changes) {
                let content = ctx.readContent(change.filePath);
                const sorted = [...change.textChanges].sort((a, b) => b.start - a.start);
                for (const tc of sorted) {
                    content = content.slice(0, tc.start) + tc.newText + content.slice(tc.start + tc.length);
                }
                ctx.applyMicroPatch(change.filePath, content);
                localEditedFiles.add(change.filePath);
                if (!parentEditedFiles.has(change.filePath)) newlyTouchedFiles.add(change.filePath);
            }

            const evalSet = new Set(filesToEvaluate);
            for (const f of localEditedFiles) evalSet.add(f);
            const newErrors = await ctx.recompileAndEvaluate(evalSet, localEditedFiles);

            if (newErrors.length >= currentErrors.length) {
                await ctx.executeRollback(microUndoLog, false);
                for (const [p] of microUndoLog) {
                    if (!parentEditedFiles.has(p)) localEditedFiles.delete(p);
                    newlyTouchedFiles.delete(p);
                }
                failedFixHashes.add(fixHash);
            } else {
                const preview = bestFix.changes.map(c => {
                    const file = path.basename(c.filePath);
                    const texts = c.textChanges.map(t => t.newText.trim()).filter(Boolean);
                    return `${file}: [${texts.join(", ")}]`;
                }).join(" | ");
                fixDescriptions.add(`- ${bestFix.description} -> \`${preview}\``);
                appliedAnyFix = true;
                currentErrors = newErrors;
                break;
            }
        }

        if (!appliedAnyFix) break;
        iteration++;
    }

    if (currentErrors.length > 0) {
        if (healUndoLog.size > 0) {
            await ctx.executeRollback(healUndoLog, true);
        }
        ctx.recordStat(false);
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    ctx.recordStat(true);
    return { healed: true, appliedFixes: Array.from(fixDescriptions), newlyTouchedFiles, finalErrors: [] };
}

export async function attemptLspAutoHealing(
    initialErrors: NrekiStructuredError[],
    parentEditedFiles: ReadonlySet<string>,
    ctx: LspHealingContext,
): Promise<HealingResult> {
    if (initialErrors.length === 0 || ctx.isDead()) {
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    const MAX_ITERATIONS = 2;
    const fixDescriptions = new Set<string>();
    const localEditedFiles = new Set(parentEditedFiles);
    const newlyTouchedFiles = new Set<string>();
    const healUndoLog = new Map<string, MicroUndoState>();
    const failedFixHashes = new Set<string>();

    let currentErrors = initialErrors;
    let iteration = 0;

    while (currentErrors.length > 0 && iteration < MAX_ITERATIONS) {
        let appliedAnyFix = false;

        for (const error of currentErrors) {
            const lspRange = {
                start: { line: error.line - 1, character: Math.max(0, error.column - 1) },
                end: { line: error.line - 1, character: error.column },
            };
            const diagnostic = {
                range: lspRange,
                message: error.message,
                code: error.code.replace(`${ctx.languageId}-`, ""),
            };

            let fixes: any[];
            try { fixes = await ctx.requestCodeActions(error.file, diagnostic); }
            catch { continue; }
            if (!fixes || fixes.length === 0) continue;

            const safeFixes = fixes.filter((f: any) => {
                const title = (f.title || "").toLowerCase();
                if (title.includes("remove") || title.includes("delete")) return false;
                return title.includes("import") || title.includes("add ");
            });
            if (safeFixes.length === 0) continue;

            const bestFix = safeFixes[0];
            const fixDesc = bestFix.title || `Add import in ${path.basename(error.file)}`;
            const fixHash = `${error.file}:${error.line}:${fixDesc}`;
            if (failedFixHashes.has(fixHash)) continue;

            const changePath = ctx.resolvePath(bestFix.filePath || error.file);
            if (!changePath) { failedFixHashes.add(fixHash); continue; }

            const microUndoLog = new Map<string, MicroUndoState>();
            const state = ctx.createSavepoint(changePath);
            microUndoLog.set(changePath, state);
            if (!healUndoLog.has(changePath)) healUndoLog.set(changePath, state);

            let content: string;
            try { content = ctx.readContent(changePath); }
            catch { failedFixHashes.add(fixHash); continue; }

            const startIdx = ctx.getLspOffset(content, bestFix.range.start.line, bestFix.range.start.character);
            const endIdx = ctx.getLspOffset(content, bestFix.range.end.line, bestFix.range.end.character);
            content = content.slice(0, startIdx) + bestFix.newText + content.slice(endIdx);

            ctx.applyMicroPatch(changePath, content);
            localEditedFiles.add(changePath);
            if (!parentEditedFiles.has(changePath)) newlyTouchedFiles.add(changePath);

            let newErrors: NrekiStructuredError[];
            try { newErrors = await ctx.validateLspEdits(localEditedFiles); }
            catch { newErrors = currentErrors; }

            if (newErrors.length >= currentErrors.length) {
                await ctx.executeRollback(microUndoLog, false);
                if (!parentEditedFiles.has(changePath)) localEditedFiles.delete(changePath);
                newlyTouchedFiles.delete(changePath);
                failedFixHashes.add(fixHash);
            } else {
                fixDescriptions.add(`- LSP Auto-Heal (${ctx.languageId}): ${fixDesc}`);
                appliedAnyFix = true;
                currentErrors = newErrors;
                break;
            }
        }

        if (!appliedAnyFix) break;
        iteration++;
    }

    if (currentErrors.length > 0) {
        if (healUndoLog.size > 0) {
            await ctx.executeRollback(healUndoLog, true);
        }
        ctx.recordStat(false);
        return { healed: false, appliedFixes: [], newlyTouchedFiles: new Set(), finalErrors: initialErrors };
    }

    ctx.recordStat(true);
    return { healed: true, appliedFixes: Array.from(fixDescriptions), newlyTouchedFiles, finalErrors: [] };
}
