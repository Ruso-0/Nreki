/**
 * code/read.ts - handleRead + handleCompress handlers.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, CodeParams, RouterDependencies } from "../../router.js";
import type { CompressionLevel, AdvancedCompressionResult } from "../../compressor.js";
import { estimateTokens } from "../../utils/token-estimator.js";
import { safePath } from "../../utils/path-jail.js";
import { shouldProcess } from "../../utils/file-filter.js";
import { readSource } from "../../utils/read-source.js";
import { extractDependencies, cleanSignature, isSensitiveSignature } from "../../utils/imports.js";
import { tfcCompress } from "../../compressor-foveal.js";
import { validatePath } from "../../utils/path-guard.js";

// ─── Honest compression labels ──────────────────────────────────────
//
// v12.0.1: headers used to report a CHARACTER reduction and never said what
// was dropped, so a medium "read" (signatures + ≤5 key lines per symbol) was
// easy to mistake for the file. Measured on 10 real files it answered 11/30
// questions whose answer was in the code.

const SKELETON_HINT = `Bodies omitted — exact code: compress focus:"<symbol>"; whole file: read (verbatim by default).`;

function percentFewer(before: number, after: number): number {
    return before > 0 ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;
}

/** What an AdvancedCompressor output contains, in tokens, plainly. */
function describeAdvanced(result: AdvancedCompressionResult, originalTokens: number): { label: string; skeleton: boolean } {
    const outTokens = estimateTokens(result.compressed);
    const skeleton = result.breakdown.structuralReduction > 0;
    const what = !skeleton
        ? "code verbatim minus comments/docstrings/logging (whitespace normalized)"
        : result.level === "aggressive"
            ? "SKELETON: signatures only, bodies replaced by stubs"
            : "SKELETON: signatures + up to 5 key lines per symbol, most body logic omitted";
    return {
        label: `${what}. ${originalTokens.toLocaleString()} → ${outTokens.toLocaleString()} tokens (${percentFewer(originalTokens, outTokens)}% fewer)`,
        skeleton,
    };
}

const TIER_LABEL: Record<1 | 2 | 3, string> = {
    1: "SKELETON: signatures only, bodies omitted",
    2: "SKELETON: signatures + key lines, most body logic omitted",
    3: "SKELETON: signatures + docs + key lines, most body logic omitted",
};

// ─── Read ───────────────────────────────────────────────────────────

export async function handleRead(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    // read + focus asks for symbols, not the file. focus used to be ignored:
    // four reads returned four whole files (4,764 tokens) in the 2026-11-13
    // Codex A/B, where the four symbols were ~300 tokens.
    if (typeof params.focus === "string" && params.focus.trim() !== "" && params.compress !== true && !params.level) {
        return handleCompress(params, deps);
    }

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(engine.getProjectRoot(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }

    try {
        const guard = validatePath({
            absolutePath: resolvedPath,
            userPath: file_path,
            projectRoot: engine.getProjectRoot(),
            toolName: "read",
        });
        if (!guard.ok) {
            return {
                content: [{ type: "text" as const, text: `${guard.error}\nHint: ${guard.hint}` }],
                isError: true,
            };
        }
        const stat = fs.statSync(resolvedPath);

        const filterResult = shouldProcess(resolvedPath, stat.size);
        if (!filterResult.process) {
            return {
                content: [{
                    type: "text" as const,
                    text: `File skipped: ${filterResult.reason}`,
                }],
            };
        }

        const rawContent = readSource(resolvedPath);

        const autoContext = params.auto_context === true;
        let autoContextBlock = "";
        let extraTokens = 0;

        if (autoContext) {
            try {
                const ext = path.extname(resolvedPath).toLowerCase();
                const depsList = extractDependencies(rawContent, ext);

                if (depsList.length > 0) {
                    const rawSignatures = engine.resolveImportSignatures(depsList.slice(0, 15));
                    const safeSigs = rawSignatures
                        .map(s => `- \`${cleanSignature(s.raw)}\` (from ${path.basename(s.path)})`)
                        .filter(s => !isSensitiveSignature(s));

                    if (safeSigs.length > 0) {
                        autoContextBlock =
                            `\n\n### Related Signatures (auto-detected, may be incomplete)\n` +
                            `NREKI resolved these external dependencies imported in this file:\n` +
                            safeSigs.join("\n");
                        extraTokens = estimateTokens(autoContextBlock);
                        engine.incrementAutoContext();
                    }
                }
            } catch {
                // Never crash on auto-context failure
            }
        }

        // Verbatim reads count too: the heartbeat and context pressure are driven
        // by total_output, and only the compressed paths used to log (T-01).
        const logVerbatim = () => {
            const shown = estimateTokens(rawContent) + extraTokens;
            engine.logUsage("nreki_read", shown, shown, 0);
        };

        const lineCount = rawContent.split("\n").length;
        if (stat.size < 1024 || lineCount < 100) {
            engine.markFileRead(resolvedPath);
            logVerbatim();
            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);
            deps.enforcer?.registerRawRead(resolvedPath);
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `${path.basename(resolvedPath)} (raw, ${lineCount}L)\n\n` +
                        (deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "") +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock,
                }],
            };
        }

        // v12.0.1: verbatim by default. A skeleton is opt-in (compress:true or an
        // explicit level); files >12k tokens still get the AUTO-SHIELD below.
        const compress = params.compress === true || typeof params.level === "string";
        const level: CompressionLevel = (typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level))
            ? params.level as CompressionLevel
            : "medium";

        if (!compress) {
            const forceRaw = params._nreki_bypass === "chronos_recovery";
            const fullTokens = estimateTokens(rawContent);

            // ─── ZERO-BOUNCE I/O (v9.0) ─────────────────────────────
            if (!forceRaw && fullTokens > 12000) {
                const zbResult = await engine.compressFileAdvanced(resolvedPath, "medium", rawContent);
                engine.markFileRead(resolvedPath);
                // CRITICAL: Do NOT call chronos.markReadUncompressed here.
                // The agent did not see the raw logic. Edit gating stays active for fragile files.

                engine.logUsage(
                    "nreki_read",
                    estimateTokens(zbResult.compressed) + extraTokens,
                    estimateTokens(zbResult.compressed) + extraTokens,
                    zbResult.tokensSaved,
                );

                const shield = describeAdvanced(zbResult, fullTokens);
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `[AUTO-SHIELD: File >12k tokens (${fullTokens.toLocaleString()}t) — returned compressed, NOT verbatim. ` +
                            `${shield.label}. To inspect bodies, use compress with focus:"<symbol>".]\n\n` +
                            `\`\`\`\n${zbResult.compressed}\n\`\`\`` +
                            (autoContextBlock ? `\n\n${autoContextBlock}` : ""),
                    }],
                };
            }
            // ─── END ZERO-BOUNCE ─────────────────────────────────────

            engine.markFileRead(resolvedPath);
            logVerbatim();

            if (deps.chronos) deps.chronos.markReadUncompressed(resolvedPath);
            // The agent saw every body verbatim: edits of this file are not blind.
            deps.enforcer?.registerRawRead(resolvedPath);

            const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";

            return {
                content: [{
                    type: "text" as const,
                    text:
                        `${path.basename(resolvedPath)} (raw)\n\n` +
                        jitWarning +
                        `\`\`\`\n${rawContent}\n\`\`\`\n\n` +
                        autoContextBlock,
                }],
            };
        }

        const result = await engine.compressFileAdvanced(resolvedPath, level, rawContent);
        engine.markFileRead(resolvedPath);
        const saved = result.tokensSaved;

        engine.logUsage(
            "nreki_read",
            estimateTokens(result.compressed) + extraTokens,
            estimateTokens(result.compressed) + extraTokens,
            saved,
        );

        const mapHint = level === "aggressive"
            ? "See nreki_navigate action:\"map\" for full project structure. Showing only the requested code:\n\n"
            : "";

        const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(resolvedPath) : "";
        const described = describeAdvanced(result, estimateTokens(rawContent));

        return {
            content: [{
                type: "text" as const,
                text:
                    `${path.basename(resolvedPath)} (${level}) — ${described.label}.\n` +
                    (described.skeleton ? `${SKELETON_HINT}\n` : "") + `\n` +
                    mapHint +
                    jitWarning +
                    `\`\`\`\n${result.compressed}\n\`\`\`\n\n` +
                    autoContextBlock,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error reading ${file_path}: ${(err as Error).message}`,
            }],
            // READ_ONLY_ACTIONS skip the text heuristic in the circuit breaker;
            // without the explicit flag ENOENT loops were recorded as successes.
            isError: true,
        };
    }
}

// ─── Compress ───────────────────────────────────────────────────────

export async function handleCompress(
    params: CodeParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file_path = params.path ?? "";
    let resolvedPath: string;
    try {
        resolvedPath = safePath(engine.getProjectRoot(), file_path);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }

    try {
        const guard = validatePath({
            absolutePath: resolvedPath,
            userPath: file_path,
            projectRoot: engine.getProjectRoot(),
            toolName: "compress",
        });
        if (!guard.ok) {
            return {
                content: [{ type: "text" as const, text: `${guard.error}\nHint: ${guard.hint}` }],
                isError: true,
            };
        }

        const compression_level = typeof params.level === "string" &&
            ["light", "medium", "aggressive"].includes(params.level)
            ? params.level as CompressionLevel
            : undefined;

        const focus = typeof params.focus === "string" ? params.focus : undefined;

        // Small file bypass for compress
        if (!focus) {
            const rawForBypass = readSource(resolvedPath);
            const bypassLineCount = rawForBypass.split("\n").length;
            if (bypassLineCount < 100) {
                engine.markFileRead(resolvedPath);
                const shown = estimateTokens(rawForBypass);
                engine.logUsage("nreki_compress", shown, shown, 0);
                return {
                    content: [{
                        type: "text" as const,
                        text: `${path.basename(resolvedPath)} (raw, ${bypassLineCount}L — below threshold)\n\n\`\`\`\n${rawForBypass}\n\`\`\``,
                    }],
                };
            }
        }

        // TFC-PRO INJECTION
        if (focus) {
            // Sprint 8.0 control arm (eval-only): FOVEAL_OFF=1 skips the
            // tfcCompress invocation entirely and returns the raw file so the
            // foveal_off arm measures a vanilla read. When FOVEAL_OFF is unset
            // or != "1" this branch is never taken and the path below is
            // byte-identical to pre-Sprint-8.0 behaviour. See
            // scripts/eval-phase8/prereg-erratum-01.md.
            if (process.env.FOVEAL_OFF === "1") {
                const rawForControl = readSource(resolvedPath);
                engine.markFileRead(resolvedPath);
                return {
                    content: [{
                        type: "text" as const,
                        text: `${path.basename(resolvedPath)} (raw, FOVEAL_OFF control arm)\n\n\`\`\`\n${rawForControl}\n\`\`\``,
                    }],
                };
            }

            const ext = path.extname(resolvedPath).toLowerCase();
            const isWeb = [".css", ".html", ".json"].includes(ext);

            if (!isWeb && focus && /\s/.test(focus) && !focus.includes(",")) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error: focus="${focus}" appears to be multiple symbols separated by spaces. Use comma-separated format: focus:"a,b,c". For exact strings with spaces, this validation only triggers in non-web file types.`
                    }],
                    isError: true,
                };
            }

            const content = readSource(resolvedPath);
            // Phase 4 Markov Blanket Foveal cross-file params (Furia round 12).
            const tfcPayload = await tfcCompress(resolvedPath, content, focus, engine, {
                walkDepth: params.walk_depth,
                maxCrossFile: params.max_cross_file,
            });

            if (tfcPayload.kind === "success") {
                const tfcResult = tfcPayload.data;
                engine.markFileRead(resolvedPath);

                const compressedTokens = estimateTokens(tfcResult.compressed);
                engine.logUsage("nreki_compress_tfc",
                    compressedTokens,
                    compressedTokens,
                    tfcResult.tokensSaved
                );

                // One header line. The char/zone statistics it carried were for
                // humans; the agent pays them on every later request.
                const name = path.basename(resolvedPath);
                const whole = tfcResult.compressed === content;
                const header = whole
                    ? `${name} (whole file, ${content.split("\n").length}L)`
                    : `${name} [${tfcResult.zones.foveas.join(", ")}]` +
                        (tfcResult.zones.darkMatterLines > 0 ? ` — ${tfcResult.zones.darkMatterLines} unrelated lines omitted` : "");
                return {
                    content: [{
                        type: "text" as const,
                        text: `${header}\n\n\`\`\`\n${tfcResult.compressed}\n\`\`\``,
                    }],
                };
            } else if (tfcPayload.kind === "shield_tripped") {
                // The focus is most of the file: the file itself is barely larger
                // than any view of it. It used to answer an ERROR asking for a
                // second call (action:"read"), i.e. one more full-context turn.
                engine.markFileRead(resolvedPath);
                const tokens = estimateTokens(content);
                engine.logUsage("nreki_compress_tfc", tokens, tokens, 0);
                return {
                    content: [{
                        type: "text" as const,
                        text: `${path.basename(resolvedPath)} (whole file, ${content.split("\n").length}L: "${focus}" is most of it)\n\n\`\`\`\n${content}\n\`\`\``,
                    }],
                };
            } else {
                // kind === "not_found"
                const parser = engine.getParser();
                if (!parser.isSupported(ext)) {
                    return {
                        content: [{
                            type: "text" as const,
                            text: `No parser for '${ext}': use action:"read".`
                        }],
                        isError: true,
                    };
                }

                // List the names so the retry needs no outline call in between,
                // closest to what was asked first (a typo's target is not cut off).
                const want = focus.toLowerCase();
                const shared = (n: string): number => {
                    const a = n.toLowerCase();
                    let k = 0;
                    while (k < a.length && k < want.length && a[k] === want[k]) k++;
                    return k;
                };
                const available = [...(tfcPayload.available ?? [])].sort((a, b) => shared(b) - shared(a));
                const shown = available.slice(0, 40).join(", ");
                const more = available.length > 40 ? `, +${available.length - 40} more` : "";
                return {
                    content: [{
                        type: "text" as const,
                        text: `Symbol "${focus}" not found in ${path.basename(resolvedPath)}.` +
                            (available.length > 0 ? ` Symbols: ${shown}${more}` : ""),
                    }],
                    isError: true,
                };
            }
        }

        if (compression_level) {
            const original = readSource(resolvedPath);
            const result = await engine.compressFileAdvanced(resolvedPath, compression_level, original);
            const saved = result.tokensSaved;

            engine.logUsage(
                "nreki_compress",
                estimateTokens(result.compressed),
                estimateTokens(result.compressed),
                saved,
            );

            const described = describeAdvanced(result, estimateTokens(original));
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `${path.basename(resolvedPath)} (${compression_level}) — ${described.label}.\n` +
                        (described.skeleton ? `${SKELETON_HINT}\n` : "") + `\n` +
                        `\`\`\`\n${result.compressed}\n\`\`\``,
                }],
            };
        }

        const tier = typeof params.tier === "number"
            ? Math.min(3, Math.max(1, params.tier)) as 1 | 2 | 3
            : 1;

        const result = await engine.compressFile(resolvedPath, tier, focus);
        const saved = result.tokensSaved;
        const outTokens = estimateTokens(result.compressed);

        engine.logUsage(
            "nreki_compress",
            outTokens,
            outTokens,
            saved,
        );

        const originalTokens = estimateTokens(readSource(resolvedPath));
        return {
            content: [{
                type: "text" as const,
                text:
                    `${path.basename(resolvedPath)} (tier ${tier}, ${result.chunksFound} chunks) — ${TIER_LABEL[tier]}. ` +
                    `${originalTokens.toLocaleString()} → ${outTokens.toLocaleString()} tokens ` +
                    `(${percentFewer(originalTokens, outTokens)}% fewer).\n${SKELETON_HINT}\n\n` +
                    `\`\`\`\n${result.compressed}\n\`\`\``,
            }],
        };
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Error compressing ${file_path}: ${(err as Error).message}`,
            }],
            isError: true,
        };
    }
}
