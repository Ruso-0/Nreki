/**
 * code/utils.ts - handleUndo + handleFilterOutput handlers.
 */

import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import { safePath } from "../../utils/path-jail.js";
import { restoreBackupWithContent } from "../../undo.js";
import { filterTerminalOutput } from "../../terminal-filter.js";
import { acquireFileLock, releaseFileLock } from "../../middleware/file-lock.js";
import { logger } from "../../utils/logger.js";

// ─── Undo ───────────────────────────────────────────────────────────

export async function handleUndo(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const file = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(deps.engine.getProjectRoot(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }

    // NREKI-INT-05: undo used to write behind the back of a concurrent edit.
    const lock = acquireFileLock(resolvedPath, "nreki_code:undo");
    if (!lock.acquired) {
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: BLOCKED\n\nFile is locked by a concurrent edit (${lock.heldBy}, ${lock.heldForMs}ms ago). Retry when it finishes.`,
            }],
            isError: true,
        };
    }

    try {
        const { message, content } = restoreBackupWithContent(deps.engine.getProjectRoot(), resolvedPath);

        // Disk changed outside the kernel: re-sync VFS, LanguageService, baseline,
        // hologram shadows and LSP overlays, or later edits validate against the
        // undone code (brain-split).
        deps.engine.expectInternalEdit(resolvedPath, content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
        deps.engine.invalidateCachedGraph();
        if (deps.kernel?.isBooted()) {
            try {
                await deps.kernel.notifyExternalChange([resolvedPath]);
            } catch (syncErr) {
                logger.error(`Kernel re-sync after undo failed: ${syncErr}`);
            }
        }

        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: SUCCESS\n\n${message}`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: FAILED\n\n${(err as Error).message}`,
            }],
            isError: true,
        };
    } finally {
        releaseFileLock(resolvedPath);
    }
}

// ─── Filter Output ──────────────────────────────────────────────────

export async function handleFilterOutput(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, circuitBreaker } = deps;

    const output = typeof params.output === "string" ? params.output : "";
    const max_lines = typeof params.max_lines === "number"
        ? Math.min(1000, Math.max(1, params.max_lines))
        : 100;

    if (!output) {
        return {
            content: [{
                type: "text" as const,
                text: `Error: "output" is required for the filter_output action.`,
            }],
            isError: true,
        };
    }

    const result = filterTerminalOutput(output, max_lines);

    engine.logUsage(
        "nreki_filter_output",
        result.filtered_tokens,
        result.filtered_tokens,
        Math.max(0, result.original_tokens - result.filtered_tokens),
    );

    let circuitWarning = "";
    if (result.error_summary.errorCount > 0) {
        const loopCheck = circuitBreaker.recordToolCall(
            "nreki_filter_output",
            output,
            result.error_summary.affectedFiles[0] ?? undefined,
        );
        if (loopCheck.tripped) {
            circuitWarning =
                "\n\n## ⚠️ CIRCUIT BREAKER TRIPPED\n" +
                `**${loopCheck.reason}**\n` +
                "**STOP all fix attempts and ask the human for guidance.**\n";
        }
    }

    const summaryLines = [
        `## Terminal Filter Results`,
        `${result.original_tokens.toLocaleString()} → ${result.filtered_tokens.toLocaleString()} tokens ` +
        `(${result.reduction_percent}% reduction)`,
        "",
    ];

    if (result.error_summary.errorCount > 0) {
        summaryLines.push(`### Error Summary`);
        summaryLines.push(`${result.error_summary.summary}`);
        summaryLines.push("");
        if (result.error_summary.uniqueErrors.length > 0) {
            summaryLines.push(`**Unique errors (${result.error_summary.uniqueErrors.length}):**`);
            for (const err of result.error_summary.uniqueErrors.slice(0, 20)) {
                summaryLines.push(`- ${err}`);
            }
            summaryLines.push("");
        }
        if (result.error_summary.affectedFiles.length > 0) {
            summaryLines.push(`**Affected files:** ${result.error_summary.affectedFiles.join(", ")}`);
            summaryLines.push("");
        }
    }

    summaryLines.push("### Filtered Output");
    summaryLines.push("```");
    summaryLines.push(result.filtered_text);
    summaryLines.push("```");

    const saved = Math.max(0, result.original_tokens - result.filtered_tokens);
    summaryLines.push("");
    summaryLines.push(`${saved.toLocaleString()} tokens saved by filter.`);

    return {
        content: [{
            type: "text" as const,
            text: summaryLines.join("\n") + circuitWarning,
        }],
    };
}
