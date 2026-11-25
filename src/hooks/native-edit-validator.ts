import fs from "fs";
import path from "path";
import type { RouterDependencies } from "../router.js";
import { safePath } from "../utils/path-jail.js";
import { antiSweepMessage, findNewSuppressions } from "../utils/suppression-guard.js";
import { ensureKernelBooted } from "../handlers/code/kernel-bridge.js";
import type { NativeEditRequest, NativeEditResponse } from "./native-edit-ipc.js";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const TEST_DIRS = new Set(["tests", "test", "__tests__", "__mocks__", "fixtures"]);
const deny = (error: string): NativeEditResponse => ({ status: "deny", error });

function isTestFile(relPath: string): boolean {
    const parts = relPath.replace(/\\/g, "/").toLowerCase().split("/");
    const base = parts[parts.length - 1] ?? "";
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || /\.test-d\.[cm]?ts$/.test(base) || /^test_.*\.py$|_test\.(?:py|go)$/.test(base)) {
        return true;
    }
    return parts.slice(0, -1).some(seg => TEST_DIRS.has(seg));
}

function replaceExact(source: string, input: Record<string, unknown>): string {
    const { old_string: oldText, new_string: newText, replace_all: all } = input;
    if (typeof oldText !== "string" || typeof newText !== "string" || oldText.length === 0
        || (all !== undefined && typeof all !== "boolean")) {
        throw new Error("NREKI: cannot validate this native edit shape. Use batch_edit.");
    }
    let needle = oldText;
    let replacement = newText;
    let first = source.indexOf(needle);
    let matchedCrlf = false;
    if (first < 0 && source.includes("\r\n") && needle.includes("\n") && !needle.includes("\r\n")) {
        const crlfNeedle = needle.replace(/\n/g, "\r\n");
        const crlfFirst = source.indexOf(crlfNeedle);
        if (crlfFirst >= 0) {
            needle = crlfNeedle;
            first = crlfFirst;
            matchedCrlf = true;
        }
    }
    if (first < 0 || (!all && source.indexOf(needle, first + 1) >= 0)) {
        throw new Error("NREKI: old_string must match the current file exactly and uniquely (or use replace_all).");
    }
    const pureCrlf = source.includes("\r\n") && !/(?:^|[^\r])\n/.test(source);
    if ((matchedCrlf || pureCrlf) && replacement.includes("\n")) {
        replacement = replacement.replace(/\r?\n/g, "\r\n");
    }
    // A function replacement avoids interpreting $&, $1 and $$ in generated code.
    return all ? source.split(needle).join(replacement) : source.replace(needle, () => replacement);
}

/** Reconstruct only documented Claude native edit shapes, against current disk text. */
export function nativeEditContent(request: NativeEditRequest, original: string | null): string | null {
    const input = request.tool_input;
    if (/^Write(File)?$/i.test(request.tool_name)) {
        if (typeof input.content !== "string") return null;
        return input.content;
    }
    if (/^Edit(File)?$/i.test(request.tool_name)) {
        if (original === null && input.old_string === "" && typeof input.new_string === "string") return input.new_string;
        if (original === null) throw new Error("NREKI: edit target no longer exists. Read it again or use Write.");
        return replaceExact(original, input);
    }
    if (/^MultiEdit(File)?$/i.test(request.tool_name)) {
        if (!Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > 100) {
            throw new Error("NREKI: MultiEdit requires 1–100 sequential edits. Use batch_edit.");
        }
        let content = original ?? "";
        for (const edit of input.edits) {
            if (typeof edit !== "object" || edit === null || Array.isArray(edit)) throw new Error("NREKI: invalid MultiEdit entry.");
            content = replaceExact(content, edit);
        }
        return content;
    }
    return null;
}

function diskText(file: string): string | null {
    try {
        if (fs.statSync(file).size > MAX_SOURCE_BYTES) throw new Error("NREKI: native edit target exceeds 4 MiB. Use batch_edit.");
        return fs.readFileSync(file, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

/** No source writes, undo history, auto-healing or token telemetry on this path. */
export async function validateNativeEdit(request: NativeEditRequest, deps: RouterDependencies): Promise<NativeEditResponse> {
    const input = request.tool_input;
    const target = input.file_path ?? input.path ?? input.file ?? input.target_file ?? input.absolute_path;
    if (typeof target !== "string" || target.length === 0) return { status: "skip" };
    try {
        const file = safePath(deps.engine.getProjectRoot(), target);
        const language = deps.sandbox.detectLanguage(file);
        if (!language) return { status: "skip" };
        const original = diskText(file);
        const proposed = nativeEditContent(request, original);
        if (proposed === null) return { status: "skip" };
        if (Buffer.byteLength(proposed) > MAX_SOURCE_BYTES) return deny("NREKI: native edit exceeds 4 MiB. Use batch_edit.");
        const syntax = await deps.sandbox.validateCode(proposed, language);
        if (!syntax.valid) {
            return deny(syntax.errors.length > 0
                ? syntax.errors.map(e => `${target}:${e.line}:${e.column}: ${e.nodeType} — ${e.context}`).join("\n")
                : syntax.suggestion);
        }
        const relative = path.relative(deps.engine.getProjectRoot(), file).replace(/\\/g, "/");
        let addedSuppressions = findNewSuppressions(file, original ?? "", proposed);
        if (addedSuppressions.length > 0 && typeof deps.sandbox.extractCommentText === "function") {
            const [beforeComments, afterComments] = await Promise.all([
                original ? deps.sandbox.extractCommentText(original, language) : Promise.resolve(""),
                deps.sandbox.extractCommentText(proposed, language),
            ]);
            if (beforeComments !== null && afterComments !== null) {
                addedSuppressions = findNewSuppressions(file, beforeComments, afterComments);
            }
        }
        if (isTestFile(relative)) {
            addedSuppressions = addedSuppressions.filter(s => !s.startsWith("@ts-expect-error"));
        }
        if (addedSuppressions.length > 0) {
            return deny(antiSweepMessage(relative, addedSuppressions));
        }
        if (deps.kernel && deps.nrekiMode !== "syntax") {
            if (!await ensureKernelBooted(deps)) return deny("NREKI: semantic kernel unavailable. Use batch_edit to retry.");
            const coverage = deps.kernel.getSemanticCoverage(file);
            // Match batch_edit's language coverage: Java/C/etc. and unchecked JS are syntax-only.
            if (coverage.backend !== null) {
                if (coverage.outsideProgram) {
                    return deny("NREKI: this file is outside the active tsconfig program. Use batch_edit and run its package/project compiler.");
                }
                await deps.engine.initialize();
                const graphDependents = await deps.engine.findDependents(relative);
                const compilerDependents = coverage.backend === "typescript"
                    ? await deps.kernel.findTypeScriptImporters([file]) ?? [] : [];
                const dependents = [...new Set([...graphDependents, ...compilerDependents])];
                if (coverage.backend === "typescript" && dependents.some(dependent => {
                    const c = deps.kernel!.getSemanticCoverage(dependent);
                    return c.backend !== "typescript" || c.outsideProgram;
                })) {
                    return deny("NREKI: importers outside the active TypeScript program cannot be checked silently. Use batch_edit and run their build/tests.");
                }
                const result = await deps.kernel.previewAtomicBatch([{
                    targetFile: file,
                    proposedContent: proposed.replace(/^\uFEFF/, ""),
                    baseContent: original?.replace(/^\uFEFF/, "") ?? null,
                }], dependents);
                if (!result.safe) return deny(result.errorText ?? "NREKI: native edit rejected by the kernel.");
                if (result.degradedLanguages?.length || result.lspCoverage?.some(c => c.skipped > 0)) {
                    return deny("NREKI: semantic coverage is incomplete (LSP unavailable or dependents skipped). Use batch_edit and run the language checker.");
                }
            }
        }
        // Detect IDE saves/other agents during validation. Native tools still own the final write.
        safePath(deps.engine.getProjectRoot(), target);
        if (diskText(file) !== original) return deny(`NREKI: ${path.basename(file)} changed during validation. Read it again before editing.`);
        return { status: "allow" };
    } catch (err) {
        return deny(err instanceof Error ? err.message : "NREKI: native edit validation failed.");
    }
}
