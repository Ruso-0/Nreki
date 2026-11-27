/**
 * handlers/guard.ts - Pure guard handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ZERO side effects beyond engine/monitor/circuitBreaker calls.
 * Heartbeat wrapping is the router's responsibility.
 */

import path from "path";
import type { McpToolResponse, GuardParams, RouterDependencies } from "../router.js";
import {
    ENGRAM_MAX_CHARS, engramHash, isImmortalEngram, qualifiedNames, resolveEngramTarget,
} from "../utils/engram-identity.js";
import { estimateTokens } from "../utils/token-estimator.js";
import { safePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { validatePath } from "../utils/path-guard.js";
import { addPin, removePin, listPins } from "../pin-memory.js";
import { latencyTracker } from "../utils/latency-tracker.js";
import { trackedNrekiState } from "../utils/state-hygiene.js";
import { logger } from "../utils/logger.js";
import { computeAudit, formatAuditReport } from "../audit.js";

// ─── Pin ────────────────────────────────────────────────────────────

export async function handlePin(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = deps.engine.getProjectRoot();
    const text = typeof params.text === "string" ? params.text : "";

    if (!text) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `text` is required for the pin action.",
            }],
            isError: true,
        };
    }

    const result = addPin(projectRoot, text, "agent");
    if (!result.success) {
        return {
            content: [{
                type: "text" as const,
                text: `Pin failed: ${result.error}`,
            }],
            isError: true,
        };
    }

    const pins = listPins(projectRoot);
    return {
        content: [{
            type: "text" as const,
            text: `[OK] Pin added: ID "${result.pin.id}" — "${result.pin.text}" (${pins.length}/10)`,
        }],
    };
}

// ─── Unpin ──────────────────────────────────────────────────────────

export async function handleUnpin(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const projectRoot = deps.engine.getProjectRoot();
    const index = typeof params.index === "number" ? params.index : undefined;
    const id = typeof params.id === "string" ? params.id : undefined;

    let pinId = id;
    if (!pinId && typeof index === "number") {
        const allPins = listPins(projectRoot);
        const sorted = [...allPins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const target = sorted[index - 1];
        pinId = target?.id;
    }

    if (!pinId) {
        return {
            content: [{
                type: "text" as const,
                text: "Error: `index` or `id` is required for the unpin action.",
            }],
            isError: true,
        };
    }

    const removed = removePin(projectRoot, pinId);
    if (!removed) {
        return {
            content: [{
                type: "text" as const,
                text: `Pin not found: ID "${pinId}"`,
            }],
            isError: true,
        };
    }

    return {
        content: [{
            type: "text" as const,
            text: `[OK] Pin removed: ID "${pinId}"`,
        }],
    };
}

// ─── Status ─────────────────────────────────────────────────────────

export async function handleStatus(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor } = deps;
    await engine.initialize();

    // What NREKI itself measured. The agent's own token counter is not visible
    // to an MCP server: the monitor reads ~/.claude/usage.jsonl, which Claude
    // Code does not write, so it printed "Total Used: 0 tokens / API Calls: 0"
    // and agents took that for NREKI's numbers (2026-11-27).
    const burn = monitor.computeBurnRate();
    const prediction = monitor.predictExhaustion();
    const calls = latencyTracker.getCallTotals();
    const sinceUtc = new Date(calls.since).toISOString().slice(11, 16);
    const header = [
        "NREKI status",
        calls.calls > 0
            ? `  This session: ${calls.calls} NREKI call(s), ~${calls.tokens.toLocaleString("en-US")} tokens returned (since ${sinceUtc} UTC).`
            : "  This session: no NREKI calls yet.",
    ];
    const report = burn.apiCalls > 0
        ? `${header.join("\n")}\n${monitor.generateReport()}`
        : `${header.join("\n")}\n  Agent token usage: not visible to NREKI (the agent does not share its counter).`;

    const stats = engine.getStats();
    const root = engine.getProjectRoot();
    const notes: string[] = [];
    const tracked = trackedNrekiState(root);
    if (tracked.length > 0) {
        const shown = tracked.slice(0, 3).join(", ") + (tracked.length > 3 ? ` +${tracked.length - 3}` : "");
        notes.push(
            `  ⚠ git tracks NREKI's local state (${shown}). It is signed for this user only (other clones ` +
            `quarantine it) and changes every session. Untrack it, keeping the files: git rm -r --cached .nreki.db .nreki`,
        );
    }
    if (process.env.NREKI_NATIVE_PREFLIGHT !== "1") {
        notes.push("  Native Edit/Write: not pre-validated (opt-in: NREKI_NATIVE_PREFLIGHT=1); batch_edit validates before writing.");
    }
    const indexSection = [
        "",
        "Index Status:",
        `  Files: ${stats.filesIndexed}`,
        `  Chunks: ${stats.totalChunks}`,
        `  Compression: ${(stats.compressionRatio * 100).toFixed(1)}%`,
        `  Watched: ${stats.watchedPaths.join(", ")}`,
        ...notes,
    ].join("\n");

    const latencySection = [
        "",
        "Latency (last 200 ops):",
        latencyTracker.getSummary(),
    ].join("\n");

    const heavyFiles = engine.getTopHeavyFiles(5);
    let dangerZones = "";
    if (heavyFiles.length > 0) {
        dangerZones = [
            "",
            "DANGER ZONES (Heaviest unread files):",
            "Do NOT read these raw. Use nreki_code action:\"compress\".",
            ...heavyFiles.map(f =>
                `  - ${path.relative(root, f.path).replace(/\\/g, "/")} (~${f.estimated_tokens.toLocaleString()} tokens)`
            ),
        ].join("\n");
    }

    let recommendations = "";
    if (prediction.alertLevel === "critical") {
        recommendations =
            "\n\nRECOMMENDATIONS:\n" +
            "  1. Switch to aggressive compression for all file reads\n" +
            "  2. Use nreki_navigate action:\"search\" instead of reading files directly\n" +
            "  3. Minimize output length - emit only patches\n" +
            "  4. Consider starting a new session soon";
    } else if (prediction.alertLevel === "warning") {
        recommendations =
            "\n\nRECOMMENDATIONS:\n" +
            "  1. Use nreki_code action:\"compress\" for files > 100 lines\n" +
            "  2. Prefer nreki_navigate action:\"search\" over grep/glob\n" +
            "  3. Keep responses concise";
    }

    return {
        content: [{
            type: "text" as const,
            text:
                report +
                indexSection +
                latencySection +
                dangerZones +
                recommendations,
        }],
    };
}

// ─── Report ─────────────────────────────────────────────────────────

export async function handleReport(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, monitor, circuitBreaker } = deps;
    await engine.initialize();

    const sessionReport = engine.getSessionReport();
    const burnRate = monitor.computeBurnRate();
    const prediction = monitor.predictExhaustion();
    // This session's rows only (buffered ones included): without `since` it summed every session the DB ever saw.
    const usageStats = engine.getUsageStats(engine.getSessionStart?.());
    const calls = latencyTracker.getCallTotals();
    const cbStats = circuitBreaker.getStats();
    const pins = listPins(deps.engine.getProjectRoot());

    const fileTypeRows = sessionReport.byFileType.length > 0
        ? sessionReport.byFileType.map(ft =>
            `  ${ft.ext.padEnd(6)} - ${ft.count} files, ` +
            `avg ${(ft.ratio * 100).toFixed(0)}% compression, ` +
            `${ft.tokensSaved.toLocaleString()} tokens saved`,
        ).join("\n")
        : "  (no compressions yet)";

    let trendMsg = "Stable";
    if (burnRate.tokensPerMinute > 0) {
        trendMsg = burnRate.tokensPerMinute > 3000
            ? "High (consider aggressive compression)"
            : burnRate.tokensPerMinute > 1000
                ? "Moderate"
                : "Low (efficient usage)";
    }

    let modelRec = "No recommendation yet (insufficient data).";
    if (sessionReport.totalTokensSaved > 0) {
        const sonnetSavings = sessionReport.savedUsdSonnet;
        const opusSavings = sessionReport.savedUsdOpus;
        if (opusSavings > 0.50) {
            modelRec = `Consider Sonnet for exploration to save ~$${(opusSavings - sonnetSavings).toFixed(2)}/session. Use Opus for final implementation.`;
        } else {
            modelRec = `Current usage is efficient. NREKI has saved $${sonnetSavings.toFixed(3)} (Sonnet) / $${opusSavings.toFixed(3)} (Opus).`;
        }
    }

    const modelName = burnRate.estimatedCostUsd > 0
        // Opus 5.5 = $4/MTok = $0.000004/tok input.
        // Sonnet 5.5 = $2/MTok = $0.000002/tok. Midpoint = $0.000003.
        ? (burnRate.estimatedCostUsd / Math.max(1, burnRate.totalConsumed) >= 0.000003
            ? "Opus" : "Sonnet")
        : "Unknown";

    const usdStr = Math.max(
        sessionReport.savedUsdSonnet,
        sessionReport.savedUsdOpus,
    ).toFixed(2);

    const receipt = [
        "NREKI Session Report",
        `Duration: ${sessionReport.durationMinutes}min | Tokens Saved: ${sessionReport.totalTokensSaved.toLocaleString()} | Output Avoided: ${usageStats.total_saved.toLocaleString()}`,
        `Edits: ${cbStats.totalToolCalls} | Loops Blocked: ${cbStats.loopsDetected} | Redirects: ${cbStats.redirectsIssued}/${cbStats.redirectsSuccessful}`,
        `Pins: ${pins.length} | Injections: ${sessionReport.autoContextInjections} | Est. Savings: $${usdStr} (${modelName})`,
    ].join("\n");

    let healthScoreStr = "";
    if (deps.kernel && deps.kernel.isBooted() && deps.chronos) {
        healthScoreStr = deps.chronos.getHealthReport(
            deps.kernel.getInitialErrorCount(),
            deps.kernel.getCurrentErrorCount(),
        ) + "\n\n";
    }

    const hostUsage = burnRate.apiCalls > 0
        ? [
            `Burn Rate: ${burnRate.tokensPerMinute.toLocaleString()} tok/min`,
            `Trend: ${trendMsg}`,
            `Prediction: ${prediction.message}`,
        ]
        : ["Agent token usage: not visible to NREKI (the agent does not share its counter)."];
    const report = [
        "NREKI - Session Report",
        "",
        `Session Duration: ${sessionReport.durationMinutes} min`,
        `NREKI calls: ${calls.calls} (~${calls.tokens.toLocaleString("en-US")} tokens returned)`,
        `Total Tokens Saved: ${sessionReport.totalTokensSaved.toLocaleString()}`,
        `Total Processed: ${sessionReport.totalOriginalTokens.toLocaleString()}`,
        `Overall Compression: ${(sessionReport.overallRatio * 100).toFixed(1)}%`,
        "",
        "USD Saved (estimated):",
        `  Sonnet 5.5 ($2/M input): $${sessionReport.savedUsdSonnet.toFixed(3)}`,
        `  Opus 5.5 ($4/M input): $${sessionReport.savedUsdOpus.toFixed(3)}`,
        "",
        "Per-File-Type Breakdown:",
        fileTypeRows,
        "",
        ...hostUsage,
        "",
        `Model Recommendation: ${modelRec}`,
    ].join("\n");

    return {
        content: [{
            type: "text" as const,
            text: healthScoreStr + report + "\n\n" + receipt,
        }],
    };
}

// ─── Reset ──────────────────────────────────────────────────────────

export async function handleReset(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { circuitBreaker } = deps;
    const state = circuitBreaker.getState();

    if (state.escalationLevel === 0 && !state.tripped) {
        return {
            content: [{
                type: "text" as const,
                text: "## Circuit Breaker: ALREADY CLEAR\n\nNo active trip to reset.",
            }],
        };
    }

    const prevLevel = state.escalationLevel;
    circuitBreaker.reset();

    return {
        content: [{
            type: "text" as const,
            text: `[OK] Circuit breaker reset from level ${prevLevel}.`,
        }],
    };
}

// ─── Audit ──────────────────────────────────────────────────────────

export async function handleAudit(
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine, kernel, chronos } = deps;
    await engine.initialize();

    if (!engine.hasIndexedFiles()) {
        logger.info("First-time project indexing — this may take a moment for large repos.");
        await engine.indexDirectory(engine.getProjectRoot());
    }

    const graph = await engine.getDependencyGraph();
    const { map } = await engine.getRepoMap();
    const allFiles = map.entries.map(e => e.filePath);
    const projectRoot = engine.getProjectRoot();

    const report = await computeAudit(graph, allFiles, projectRoot, kernel, chronos);
    const text = formatAuditReport(report);

    return {
        content: [{
            type: "text" as const,
            text,
        }],
    };
}

// ─── Set Plan ───────────────────────────────────────────────────────

export async function handleSetPlan(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    await deps.engine.initialize();

    if (!params.text) {
        return {
            content: [{ type: "text" as const, text: "Error: provide the file path to your plan via 'text'." }],
            isError: true,
        };
    }

    let resolvedPath: string;
    try {
        resolvedPath = safePath(deps.engine.getProjectRoot(), params.text);
    } catch (err) {
        return {
            content: [{ type: "text" as const, text: `## Set Plan: FAILED\n\n${(err as Error).message}` }],
            isError: true,
        };
    }

    const planGuard = validatePath({
        absolutePath: resolvedPath,
        userPath: params.text,
        projectRoot: deps.engine.getProjectRoot(),
        toolName: "set_plan",
    });
    if (!planGuard.ok) {
        return {
            content: [{
                type: "text" as const,
                text: `## Set Plan: FAILED\n\n${planGuard.error}\nHint: ${planGuard.hint}`,
            }],
            isError: true,
        };
    }

    const planContent = readSource(resolvedPath);
    const planTokens = estimateTokens(planContent);

    if (planTokens > 4000) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `## Set Plan: REJECTED (Too Large)\n\n` +
                    `Your plan is estimated at **~${planTokens.toLocaleString()} tokens**.\n` +
                    `NREKI injects this every ~15 tool calls. A plan this large will burn ` +
                    `context rapidly and accelerate compaction instead of preventing it.\n\n` +
                    `**Action:** Summarize your \`${path.basename(resolvedPath)}\` into strict ` +
                    `bullet points (aim for < 1,500 tokens), then try again.`,
            }],
            isError: true,
        };
    }

    deps.engine.setMetadata("nreki_master_plan", path.relative(deps.engine.getProjectRoot(), resolvedPath).replace(/\\/g, "/"));
    const usage = deps.engine.getUsageStats();
    deps.engine.setMetadata(
        "nreki_plan_last_drift",
        // Same measure applyContextHeartbeat compares against (T-02): the sum
        // was ~2x larger, so the next safe call reset it and fired at once.
        String(usage.total_output),
    );

    return {
        content: [{
            type: "text" as const,
            text:
                `## Master Plan Anchored\n\n` +
                `**Path:** ${resolvedPath}\n` +
                `**Cost:** ~${planTokens.toLocaleString()} tokens per heartbeat\n\n` +
                `NREKI's Context Heartbeat is now ACTIVE. It will silently re-inject ` +
                `these constraints every ~15 tool calls during context-gathering operations.\n\n` +
                `*Tip: Use \`nreki_guard action:"memorize"\` as you progress to leave notes for your future self.*`,
        }],
    };
}

// ─── Memorize ───────────────────────────────────────────────────────

export async function handleMemorize(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    await deps.engine.initialize();

    if (!params.text) {
        return {
            content: [{ type: "text" as const, text: "Error: provide thoughts to memorize via 'text'." }],
            isError: true,
        };
    }

    if (params.text.length > 5000) {
        return {
            content: [{ type: "text" as const, text: "Error: scratchpad text too long (max 5,000 chars). Summarize your notes." }],
            isError: true,
        };
    }

    deps.engine.setMetadata("nreki_scratchpad", params.text);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Memory Saved\n\n` +
                `NREKI has written your thoughts to the Active Scratchpad. ` +
                `If context compaction occurs, these notes will be automatically ` +
                `re-injected so you don't lose your train of thought.`,
        }],
    };
}

// ─── Engram ─────────────────────────────────────────────────────────

export async function handleEngram(
    params: GuardParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    await deps.engine.initialize();

    const file = params.path ?? "";
    const symbol = params.symbol ?? "";
    const insight = params.text ?? "";

    if (!file || !symbol || !insight) {
        return {
            content: [{ type: "text" as const, text: "Error: engram requires path, symbol, and text (the insight)." }],
            isError: true,
        };
    }
    if (insight.length > ENGRAM_MAX_CHARS) {
        // Printed in every outline of the file: a long note costs tokens on every read.
        return {
            content: [{
                type: "text" as const,
                text: `Error: engram text is ${insight.length} chars (max ${ENGRAM_MAX_CHARS}). Keep it to the invariant or gotcha.`,
            }],
            isError: true,
        };
    }

    const root = deps.engine.getProjectRoot();
    let resolvedPath: string;
    try {
        resolvedPath = safePath(root, file);
    } catch (err) {
        return {
            content: [{ type: "text" as const, text: `Security error: ${(err as Error).message}` }],
            isError: true,
        };
    }

    const engramGuard = validatePath({
        absolutePath: resolvedPath,
        userPath: file,
        projectRoot: root,
        toolName: "engram",
    });
    if (!engramGuard.ok) {
        return {
            content: [{
                type: "text" as const,
                text: `Engram failed: ${engramGuard.error}\nHint: ${engramGuard.hint}`,
            }],
            isError: true,
        };
    }

    const content = readSource(resolvedPath);
    const parser = deps.engine.getParser();
    const parseResult = await parser.parse(resolvedPath, content);
    const qualified = qualifiedNames(parseResult.chunks);
    const symbols = parseResult.chunks
        .map((c, i) => ({ qualified: qualified[i], bare: c.symbolName, body: c.rawCode, startLine: c.startLine, endLine: c.endLine }))
        .filter(s => s.qualified !== "");
    const target = resolveEngramTarget(symbols, symbol);
    if (!target.ok) {
        return {
            content: [{ type: "text" as const, text: `Error: ${target.error} (in ${file})` }],
            isError: true,
        };
    }

    const anchor = target.symbol;
    deps.engine.upsertEngram(resolvedPath, anchor.qualified, engramHash(anchor.body), insight);
    const lifetime = isImmortalEngram(insight)
        ? "ASSERT engram: it survives code changes."
        : "If this symbol's code changes, the engram is deleted (prefix the text with ASSERT to keep it).";

    return {
        content: [{
            type: "text" as const,
            text: `[Engram Anchored] \`${anchor.qualified}\` (L${anchor.startLine}). ${lifetime}`,
        }],
    };
}
