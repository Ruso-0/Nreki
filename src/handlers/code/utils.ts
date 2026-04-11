/**
 * code/utils.ts - handleUndo + handleFilterOutput handlers.
 */

import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import { safePath } from "../../utils/path-jail.js";
import { restoreBackup } from "../../undo.js";
import { filterTerminalOutput } from "../../terminal-filter.js";

// ─── Undo ───────────────────────────────────────────────────────────

export async function handleUndo(
    params: CodeParams,
    _deps: RouterDependencies,
): Promise<McpToolResponse> {
    const file = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(process.cwd(), file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
    }

    try {
        const message = restoreBackup(process.cwd(), resolvedPath);
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: SUCCESS\n\n${message}\n\n[NREKI: file restored]`,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `## nreki_undo: FAILED\n\n${(err as Error).message}\n\n[NREKI saved ~0 tokens]`,
            }],
        };
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
                text: `Error: "output" is required for the filter_output action.\n\n[NREKI saved ~0 tokens]`,
            }],
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
    summaryLines.push(`[NREKI saved ~${saved.toLocaleString()} tokens on this filter]`);

    return {
        content: [{
            type: "text" as const,
            text: summaryLines.join("\n") + circuitWarning,
        }],
    };
}
