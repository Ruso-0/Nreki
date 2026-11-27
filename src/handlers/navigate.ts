/**
 * handlers/navigate.ts - Pure navigate handlers (DAG: no circular dependencies).
 *
 * Each handler takes params + deps, returns McpToolResponse.
 * ZERO side effects beyond engine/parser calls.
 * Heartbeat wrapping is the router's responsibility.
 */

import path from "path";
import type Parser from "web-tree-sitter";
import type { McpToolResponse, NavigateParams, RouterDependencies } from "../router.js";
import { estimateTokens } from "../utils/token-estimator.js";
import { safePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { validatePath } from "../utils/path-guard.js";
import {
    findDefinition,
    findReferences,
    getFileSymbols,
    type SymbolKind,
    type ReferenceResult,
} from "../ast-navigator.js";
import { getPinnedText } from "../pin-memory.js";
import { repoMapToText } from "../repo-map.js";
import { extractDependencies, cleanSignature, isSensitiveSignature, escapeRegExp } from "../utils/imports.js";
import { logger } from "../utils/logger.js";
import { runDefectRadar } from "../utils/defect-radar.js";
import { engramHash, isImmortalEngram, placeEngrams } from "../utils/engram-identity.js";
import { isSecondaryPath } from "../utils/file-filter.js";
import { splitQualifiedName } from "../utils/qualified-name.js";
import { declaredEntries, isConventionalEntry } from "../utils/entry-points.js";
import { ensureKernelBooted } from "./code/kernel-bridge.js";

/** Default cap on fast_grep output lines (~4k tokens); `limit` can raise it. */
const FAST_GREP_MAX_LINES = 120;
/** Definitions shown with their body; the others are listed as locations. */
const DEFINITION_BODIES = 3;

// ─── Search ─────────────────────────────────────────────────────────

export async function handleSearch(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const query = params.query ?? "";

    // v11.2.1: non-blocking lazy index. Pre-v11.2.1 this awaited a full
    // walk that exceeded Claude Code's tool-call timeout on large repos
    // and surfaced as EOF. The handler now returns early with a hint when
    // the index is still warming; subsequent calls progressively gain
    // coverage. fast_grep remains usable in the meantime.
    engine.ensureIndexedBackground();

    const limit = typeof params.limit === "number" ? Math.min(50, Math.max(1, params.limit)) : 10;
    // Sprint 8.0 control arm (eval-only): FOVEAL_OFF=1 forces full rawCode in
    // search results so the foveal_off arm measures a vanilla retriever. When
    // FOVEAL_OFF is unset or != "1", include_raw is governed solely by the
    // caller param (byte-identical to pre-Sprint-8.0). See
    // scripts/eval-phase8/prereg-erratum-01.md.
    const include_raw = params.include_raw === true || process.env.FOVEAL_OFF === "1";

    const indexReady = engine.hasFreshIndex();
    const results = indexReady ? await engine.search(query, limit) : [];
    if (!indexReady) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `Index pending for: "${query}"\n\n` +
                    `NREKI's semantic index is warming in the background. Try again in a few seconds, ` +
                    `or use action:"fast_grep" (exact substring, RAM-resident) for immediate results.`,
            }],
        };
    }

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No semantic results found for: "${query}"\n\n` +
                    `Indexed ${engine.getStats().filesIndexed} files with ${engine.getStats().totalChunks} chunks.\n\n` +
                    `Fallback options:\n` +
                    `  - nreki_navigate action:"fast_grep" query:"<exact text>"  — exact substring match (RAM-resident, ~ms latency).\n` +
                    `  - Broaden the query (drop adjectives, use base word) and retry.\n` +
                    `  - As a last resort: host agent's grep over the project root.`,
            }],
        };
    }

    // Engrams pinned to a result's symbol travel with it, so the agent sees the
    // invariant without a separate outline call. Read-only here: invalidation
    // stays in outline. Matched by the chunk's qualified name (Class.method), so
    // an ASSERT engram survives body edits and never lands on a same-named
    // method of another class (C-02); bare keys from older engrams need the hash.
    const engramsByFile = new Map<string, ReturnType<typeof engine.getEngramsForFile>>();
    const engramLines = (r: (typeof results)[number], indent: string): string => {
        const qualified = r.qualifiedName || "";
        const bare = r.symbolName || "";
        if (!qualified && !bare) return "";
        let stored = engramsByFile.get(r.path);
        if (!stored) {
            stored = engine.getEngramsForFile(r.path);
            engramsByFile.set(r.path, stored);
        }
        if (stored.size === 0) return "";
        const bodyHash = engramHash(r.rawCode);
        const notes: string[] = [];
        for (const [key, memory] of stored) {
            const exact = qualified !== "" && key === qualified;
            const legacy = !exact && key === bare && memory.astHash === bodyHash;
            if (exact ? (memory.astHash === bodyHash || isImmortalEngram(memory.insight)) : legacy) notes.push(memory.insight);
        }
        return notes.map(n => `\n${indent}[Engram]: ${n}`).join("");
    };

    const formatted = results.map((r, i) => {
        const cleanPath = path.relative(engine.getProjectRoot(), r.path).replace(/\\/g, "/");

        if (!include_raw) {
            const tags: string[] = [r.nodeType];
            if (r.topology && r.topology.tier !== "orphan") {
                if (r.topology.isEpicenter && r.topology.inDegree > 0) {
                    const depsStr =
                        r.topology.dependents && r.topology.dependents.length > 0
                            ? ` (${r.topology.dependents.join(", ")})`
                            : "";
                    tags.push(`EPICENTER: ${r.topology.inDegree} deps${depsStr}`);
                } else if (r.topology.isBlastRadius) {
                    tags.push("coupled");
                } else if (r.topology.inDegree > 0) {
                    tags.push(`${r.topology.inDegree} deps`);
                }
            }
            const compactShort = r.shorthand
                .replace(/\{\s*\/\*\s*TG:L\d+-L\d+\s*\*\/\s*\}/g, "")
                .split("\n")
                .map(l => l.trim())
                .filter(Boolean)
                .slice(0, 2)
                .join(" ")
                .slice(0, 180);
            return `${i + 1}. ${cleanPath}:L${r.startLine}-L${r.endLine} [${tags.join(" | ")}]\n   ${compactShort}${engramLines(r, "   ")}`;
        }

        const header = `### ${i + 1}. ${cleanPath}:L${r.startLine}-L${r.endLine}`;

        let ext = path.extname(r.path).slice(1).toLowerCase();
        let lang = ext;
        let commentPrefix = "//";

        if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) { lang = 'typescript'; commentPrefix = '//'; }
        else if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) { lang = 'javascript'; commentPrefix = '//'; }
        else if (ext === 'py') { lang = 'python'; commentPrefix = '#'; }
        else if (ext === 'go') { lang = 'go'; commentPrefix = '//'; }
        else if (['kt', 'kts'].includes(ext)) { lang = 'kotlin'; commentPrefix = '//'; }
        else if (ext === 'java') { lang = 'java'; commentPrefix = '//'; }
        else if (['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'].includes(ext)) { lang = 'cpp'; commentPrefix = '//'; }
        else if (!lang) { lang = 'typescript'; commentPrefix = '//'; }

        let sensoryTag = "";
        if (r.topology && r.topology.tier !== "orphan") {
            if (r.topology.isEpicenter && r.topology.inDegree > 0) {
                const alert = r.topology.tier === "core" ? "☢️ CRITICAL CORE" : "⚠️ LOGIC HUB";
                const depsStr = r.topology.dependents && r.topology.dependents.length > 0 ? ` (Imports: ${r.topology.dependents.join(", ")}...)` : "";
                sensoryTag = `${commentPrefix} [EPICENTER | BLAST RADIUS: ${r.topology.inDegree} dependents | ${alert}]${depsStr}\n`;
            } else if (r.topology.isBlastRadius) {
                sensoryTag = `${commentPrefix} [COUPLED CONSUMER | Affected by changes to search target]\n`;
            } else if (r.topology.inDegree > 0) {
                sensoryTag = `${commentPrefix} [DEPENDENCIES: ${r.topology.inDegree} files rely on this]\n`;
            }
        }

        const shorthand = `\`\`\`${lang}\n${sensoryTag}${r.shorthand}\n\`\`\``;
        const rawSection = `\n<details><summary>Full source</summary>\n\n\`\`\`${lang}\n${r.rawCode}\n\`\`\`\n</details>`;
        const score = `Score: ${r.score.toFixed(4)} | Type: ${r.nodeType}`;
        return `${header}\n${shorthand}\n${score}${engramLines(r, "")}${rawSection}`;
    });

    // "Saved" = the raw size of the matched chunks minus what this answer cost.
    // The old ×5 multiplier was invented, and with include_raw nothing is saved.
    let rawEstimate = 0;
    if (!include_raw) for (const r of results) rawEstimate += estimateTokens(r.rawCode);

    const fileCount = new Set(results.map(r => r.path)).size;
    const joiner = include_raw ? "\n\n" : "\n";
    const resultText = `Search "${query}": ${results.length} results in ${fileCount} files\n\n` +
        formatted.join(joiner);

    const searchTokens = estimateTokens(resultText);
    const saved = Math.max(0, rawEstimate - searchTokens);

    const finalText = resultText;

    engine.logUsage("nreki_search", searchTokens, searchTokens, saved);

    return {
        content: [{
            type: "text" as const,
            text: finalText,
        }],
    };
}

// ─── Definition ─────────────────────────────────────────────────────

export async function handleDefinition(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbol = params.symbol ?? "";
    const root = engine.getProjectRoot();
    const parser = engine.getParser();
    const kind = typeof params.kind === "string" ? params.kind : "any";
    // With the engine, candidates come from the index instead of re-reading the tree.
    const results = await findDefinition(root, parser, symbol, kind as SymbolKind, engine);

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No definition found for symbol: "${symbol}"` +
                    (kind !== "any" ? ` (kind: ${kind})` : ""),
            }],
        };
    }

    // A name defined in many places: the first bodies, the rest as locations
    // (every body was printed, with no budget).
    const shown = results.slice(0, DEFINITION_BODIES);
    const formatted = shown.map((r, i) => {
        const exported = r.exportedAs ? ` [exported: ${r.exportedAs}]` : "";
        return (
            `### ${i + 1}. ${r.filePath}:L${r.startLine}-L${r.endLine} (${r.kind}${exported})\n` +
            `**Signature:** \`${r.signature}\`\n` +
            `\`\`\`\n${r.body}\n\`\`\``
        );
    });
    if (results.length > shown.length) {
        formatted.push(`Also defined at: ${results.slice(shown.length)
            .map(r => `${r.filePath}:L${r.startLine}-L${r.endLine} (${r.kind})`).join("; ")}`);
    }

    const bodyTokens = shown.reduce(
        (sum, r) => sum + estimateTokens(r.body), 0,
    );

    const autoContext = params.auto_context !== false;
    let autoContextBlock = "";
    let extraTokens = 0;

    if (autoContext && results.length > 0) {
        try {
            const targetResult = results[0];
            const ext = path.extname(targetResult.filePath).toLowerCase();
            const fileContent = readSource(safePath(root, targetResult.filePath));

            const allImports = extractDependencies(fileContent, ext);

            const usedDeps = allImports.filter(d => {
                const safeName = escapeRegExp(d.localName);
                const regex = new RegExp(`(^|[^a-zA-Z0-9_$])${safeName}(?=[^a-zA-Z0-9_$]|$)`);
                return shown.some(r => regex.test(r.body));
            });

            if (usedDeps.length > 0) {
                const rawSignatures = engine.resolveImportSignatures(usedDeps.slice(0, 10));
                const safeSigs = rawSignatures
                    .map(s => `- \`${cleanSignature(s.raw)}\` (from ${path.basename(s.path)})`)
                    .filter(s => !isSensitiveSignature(s));

                if (safeSigs.length > 0) {
                    autoContextBlock =
                        `\n\n### Related Signatures (auto-detected, may be incomplete)\n` +
                        `NREKI resolved these external dependencies used in the definition:\n` +
                        safeSigs.join("\n");
                    extraTokens = estimateTokens(autoContextBlock);
                    engine.incrementAutoContext();
                }
            }
        } catch {
            // Never crash the tool on auto-context failure
        }
    }

    engine.logUsage("nreki_navigate:definition", bodyTokens + extraTokens, bodyTokens + extraTokens, 0);

    return {
        content: [{
            type: "text" as const,
            text:
                `## Definition: ${symbol}\n` +
                `Found ${results.length} definition(s).\n\n` +
                formatted.join("\n\n") +
                autoContextBlock,
        }],
    };
}

// ─── References ─────────────────────────────────────────────────────

export async function handleReferences(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbol = params.symbol ?? "";
    const root = engine.getProjectRoot();
    const parser = engine.getParser();
    const results = await findReferences(root, parser, symbol, engine);

    if (results.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `No references found for: "${symbol}"`,
            }],
        };
    }

    const byFile = new Map<string, ReferenceResult[]>();
    for (const ref of results) {
        const arr = byFile.get(ref.filePath) || [];
        arr.push(ref);
        byFile.set(ref.filePath, arr);
    }

    const formatted: string[] = [];
    for (const [file, refs] of [...byFile.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
        formatted.push(`### ${file} (${refs.length} reference${refs.length > 1 ? "s" : ""})`);
        for (const ref of refs) {
            formatted.push(`**L${ref.line}:**`);
            formatted.push(`\`\`\`\n${ref.context}\n\`\`\``);
        }
    }

    const refTokens = results.reduce(
        (sum, r) => sum + estimateTokens(r.context), 0,
    );

    engine.logUsage("nreki_refs", refTokens, refTokens, 0);

    const qualified = splitQualifiedName(symbol);
    return {
        content: [{
            type: "text" as const,
            text:
                `## References: ${symbol}\n` +
                (qualified ? `Matched by member name "${qualified.member}": call sites do not name the class.\n` : "") +
                `Found ${results.length} reference(s) across ${byFile.size} file(s).\n\n` +
                formatted.join("\n"),
        }],
    };
}

// ─── Outline ────────────────────────────────────────────────────────

function computeTriageRisk(name: string, rawCode: string, linesCount: number): string {
    if (!rawCode) return "[LOW]";
    let score = 0;
    const reasons: string[] = [];
    if (linesCount <= 3) { score -= 2; }
    else if (linesCount > 50) { score += 3; reasons.push(">50L"); }
    else if (linesCount > 20) { score += 1; }
    const cleanCode = rawCode
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, "");
    const branches = (cleanCode.match(/\b(if|else|switch|case|catch|for|while)\b/g) || []).length +
                     (cleanCode.match(/(?<!\?)\?(?!\.|:|\?)/g) || []).length;
    if (branches > 6) { score += 3; reasons.push(`${branches} branches`); }
    else if (branches > 2) { score += 1; }
    const calls = (cleanCode.match(/\b[a-zA-Z_]\w*\s*\(/g) || []).length;
    if (calls > 15) { score += 1; reasons.push("ext deps"); }
    const mutations = (cleanCode.match(/\+=|-=|\*=|\/=|%=|\+\+|--|\.push\(|\.pop\(|\.shift\(|\.unshift\(|\.splice\(|\.set\(|\.delete\(|\.clear\(|\.add\(/g) || []).length;
    if (mutations > 2) { score += 2; reasons.push("state mutation"); }
    else if (mutations > 0) { score += 1; reasons.push("mutates state"); }
    if (/calculate|validate|process|compute|handle|update|sync|transform|parse|execute|mutate|match/i.test(name)) {
        score += 2;
        reasons.push("biz logic");
    }
    if (/pnl|price|volume|amount|balance|margin|risk|vwap|liquidation|drawdown|position|order|fill|iceberg|trade/i.test(name)) {
        score += 2;
        reasons.push("critical domain");
    }
    const mathOps = (cleanCode.match(/(?:\w|\]|\))\s*(?:[-+*/%](?![=+*-]))\s*(?:\w|\(|\[)/g) || []).length;
    if (mathOps > 3) {
        score += 2;
        reasons.push("math heavy");
    } else if (mathOps > 0) {
        score += 1;
    }
    if (/\bas\s+any\b|:\s*any\b/.test(cleanCode)) {
        score += 2;
        reasons.push("type gap");
    }
    if (score >= 5) return `[HIGH \u2014 ${reasons.slice(0, 3).join(", ")}]`;
    if (score >= 3) return `[MED \u2014 ${reasons.slice(0, 2).join(", ")}]`;
    return `[LOW]`;
}

export async function handleOutline(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const file = params.path ?? "";
    const root = engine.getProjectRoot();
    let resolvedPath: string;
    try {
        resolvedPath = safePath(root, file);
    } catch (err) {
        return {
            content: [{
                type: "text" as const,
                text: `Security error: ${(err as Error).message}`,
            }],
        };
    }

    const outlineGuard = validatePath({
        absolutePath: resolvedPath,
        userPath: file,
        projectRoot: root,
        toolName: "outline",
    });
    if (!outlineGuard.ok) {
        return {
            content: [{
                type: "text" as const,
                text: `${outlineGuard.error}\nHint: ${outlineGuard.hint}`,
            }],
            isError: true,
        };
    }

    const parser = engine.getParser();
    const symbols = await getFileSymbols(resolvedPath, parser, root);

    if (symbols.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text:
                    `No symbols found in: ${file}\n` +
                    `(File may be empty, unsupported, or contain no declarations.)`,
            }],
        };
    }

    const relPath = path.relative(root, resolvedPath).replace(/\\/g, "/");
    const lines = [`## Outline: ${relPath}`, `${symbols.length} symbol(s)`, ""];

    const placement = placeEngrams(
        symbols.map(s => ({ qualified: s.qualifiedName ?? s.name, bare: s.name, body: s.body, startLine: s.startLine })),
        deps.engine.getEngramsForFile(resolvedPath),
    );
    for (const key of placement.invalidated) deps.engine.deleteEngram(resolvedPath, key);
    for (const { from, to } of placement.rekeyed) deps.engine.renameEngram(resolvedPath, from, to);
    const invalidatedCount = placement.invalidated.length;

    const lowRiskSymbols: string[] = [];

    // v10.7.0 (NREKI Way): Ghost Oracle pre-fetch. Entry files are exempt —
    // they're referenced by the runtime/test-runner, not by the import graph,
    // so a 0-ref result would be a false positive on them.
    const isEntryFile = /^(index|main|app|setup|server|cli|vite-env)\./i.test(path.basename(resolvedPath)) ||
                        /^(.*\.)?config\./i.test(path.basename(resolvedPath)) ||
                        /\.(test|spec)\./i.test(resolvedPath);

    const ghostCache = new Map<string, boolean>();
    const symbolsToGhostCheck = Array.from(new Set(
        symbols
            .filter(s => s.exportedAs && s.kind !== "type" && s.kind !== "interface" && !s.name.startsWith("_") && !isEntryFile)
            .map(s => s.name)
    ));
    await Promise.all(symbolsToGhostCheck.map(async (name) => {
        const candidateFiles = await deps.engine.searchFilesBySymbol(name);
        const hasExt = candidateFiles.some((f: string) => path.relative(root, f).replace(/\\/g, "/") !== relPath);
        ghostCache.set(name, hasExt);
    }));

    for (const [symIndex, sym] of symbols.entries()) {
        const exported = sym.exportedAs ? ` [${sym.exportedAs}]` : "";
        const linesCount = sym.endLine - sym.startLine + 1;
        const riskTag = computeTriageRisk(sym.name, sym.body, linesCount);

        // Engrams are matched by qualified name + body hash (utils/engram-identity);
        // "ASSERT…" engrams survive body changes (v10.7.0).
        const insights = placement.shown.get(symIndex);
        const hasValidEngram = insights !== undefined;
        const engramLine: string | null = hasValidEngram
            ? insights.map(text => `  [Engram]: ${text}`).join("\n")
            : placement.invalidatedAt.has(symIndex)
                ? `  [Engram invalidated: code mutated since memory was saved]`
                : null;

        // v10.7.0: parasitic defect radar + ghost tag rendered inline.
        const defects = runDefectRadar(sym.body);
        const defectTag = defects.length > 0
            ? ` ⚠️ [${defects.map(d => d.label).join(", ")}]`
            : "";
        const ghostTag = ghostCache.get(sym.name) === false
            ? " 👻 [0 ext refs]"
            : "";

        if (riskTag === "[LOW]" && !hasValidEngram && !params.signatures && defects.length === 0 && !ghostTag) {
            lowRiskSymbols.push(sym.name);
            continue;
        }

        lines.push(
            `- **${sym.kind}** \`${sym.name}\`${exported} ${riskTag}${defectTag}${ghostTag} - L${sym.startLine}-L${sym.endLine}`,
        );
        lines.push(`  \`${sym.signature}\``);
        if (engramLine) lines.push(engramLine);
    }

    if (invalidatedCount > 0) {
        lines.push(`\nNote: ${invalidatedCount} obsolete engram(s) automatically deleted because their underlying code changed.`);
    }

    if (lowRiskSymbols.length > 0) {
        lines.push("");
        lines.push(`--- ${lowRiskSymbols.length} LOW-risk symbols (trivial, not shown — pass signatures:true to expand) ---`);
        lines.push(lowRiskSymbols.join(", "));
    }

    if (symbols.length > 3) {
        lines.push("");
        lines.push(`*Tip: Read multiple high-risk symbols in one call: nreki_code action:"compress" focus:"func1, func2, func3"*`);
    }

    const highRiskSymbols = symbols.filter((sym) => {
        const linesCount = sym.endLine - sym.startLine + 1;
        const tag = computeTriageRisk(sym.name, sym.body, linesCount);
        return tag.startsWith("[HIGH");
    });

    // ─── DYNAMIC RISK EXPANSION (v10.x) ───
    // Sprint 8.0 control arm (eval-only): FOVEAL_OFF=1 lifts the triage-risk
    // filter and the token budget so outline returns the body of every method
    // with no [BUDGET LIMIT REACHED] truncation (vanilla full dump). When
    // FOVEAL_OFF is unset or != "1", MAX_EXPAND_TOKENS and `expandable` are
    // byte-identical to pre-Sprint-8.0. See scripts/eval-phase8/prereg-erratum-01.md.
    const fovealOff = process.env.FOVEAL_OFF === "1";
    // 2,000: an outline is asked for symbols; up to 6,000 tokens of bodies came
    // with it, unasked, and were re-sent on every later turn.
    const MAX_EXPAND_TOKENS = fovealOff ? Number.POSITIVE_INFINITY : 2000;

    const expandable = (fovealOff
        ? symbols
        : highRiskSymbols.filter((sym) => (sym.endLine - sym.startLine + 1) <= 150))
        .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine));

    const autoExpanded: typeof expandable = [];
    const omittedHighRisk: string[] = [];
    let expandedTokens = 0;

    for (const sym of expandable) {
        const symTokens = estimateTokens(sym.body);
        if (expandedTokens + symTokens > MAX_EXPAND_TOKENS) {
            omittedHighRisk.push(sym.name);
            continue;
        }
        autoExpanded.push(sym);
        expandedTokens += symTokens;
    }

    if (autoExpanded.length > 0) {
        lines.push("");
        lines.push(`--- AUTO-EXPANDED HIGH-RISK CODE (${autoExpanded.length} symbols, ~${expandedTokens.toLocaleString()} tokens) ---`);

        autoExpanded.sort((a, b) => a.startLine - b.startLine);

        for (const sym of autoExpanded) {
            lines.push("");
            lines.push(`### ${sym.name} (L${sym.startLine}-L${sym.endLine})`);
            lines.push("```typescript");
            lines.push(sym.body);
            lines.push("```");
        }
        // Their full bodies are now in the agent's context: editing them is not
        // blind, so the enforcer must not demand a second read of the same code.
        deps.enforcer?.registerFocusedSymbols(resolvedPath, autoExpanded.map(s => s.name));
    }

    if (omittedHighRisk.length > 0) {
        lines.push("");
        lines.push(`[BUDGET LIMIT REACHED] ${omittedHighRisk.length} HIGH-risk symbols were not expanded to save context.`);
        lines.push(`To read them: nreki_code action:"compress" focus:"${omittedHighRisk.slice(0, 8).join(", ")}"`);
    }

    const outlineTokens = estimateTokens(lines.join("\n"));

    try {
        const fullContent = readSource(resolvedPath);
        const fullTokens = estimateTokens(fullContent);
        const saved = Math.max(0, fullTokens - outlineTokens);

        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, saved);

    } catch {
        engine.logUsage("nreki_outline", outlineTokens, outlineTokens, 0);
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

// ─── Map ────────────────────────────────────────────────────────────

export async function handleMap(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    // v11.2.1: kick off indexing in the background instead of awaiting it
    // — the repo map renders from whatever is already in the DB and the
    // next call picks up the freshly-indexed entries.
    if (!engine.hasIndexedFiles()) {
        engine.ensureIndexedBackground();
    }

    const refresh = params.refresh === true;
    const { text: cachedText, map } = await engine.getRepoMap(refresh);

    // Depth selection: skeleton (default) or full. Pressure >0.7 forces skeleton unless explicitly full.
    const depth = (params.depth === "full") ? "full" : "skeleton";
    const pressure = deps.pressure ?? 0;
    const effectiveDepth = (pressure > 0.7 && params.depth !== "full") ? "skeleton" as const : depth as "skeleton" | "full";

    // If full depth requested, regenerate text from map (cached text is always skeleton)
    const text = effectiveDepth === "full" ? repoMapToText(map, "full", pressure) : cachedText;

    const pinnedText = getPinnedText(engine.getProjectRoot());
    const fullText = text + (pinnedText ? "\n" + pinnedText : "");
    const tokens = estimateTokens(fullText);

    engine.logUsage("nreki_map", tokens, tokens, 0);

    return {
        content: [{
            type: "text" as const,
            text: fullText,
        }],
    };
}

// ─── Prepare Refactor ───────────────────────────────────────────────

/** Node types that are dangerous for automated refactoring (strings, comments, keys). */
const DANGEROUS_REFACTOR_NODES = new Set([
    "string", "string_fragment", "string_content",
    "template_string", "template_substitution",
    "interpreted_string_literal", "raw_string_literal",
    "concatenated_string",
    "comment", "line_comment", "block_comment",
    "jsx_text",
    "property_identifier", "shorthand_property_identifier",
]);

/** Parent types that represent key-value pairs (left child = key). */
const KV_PARENTS = new Set(["pair", "dictionary", "keyed_element", "property_assignment"]);

function classifyRefactorConfidence(
    node: Parser.SyntaxNode,
): "high" | "review" {
    const nodeType = node.type;
    const parentType = node.parent?.type || "";

    if (DANGEROUS_REFACTOR_NODES.has(nodeType) || DANGEROUS_REFACTOR_NODES.has(parentType)) {
        return "review";
    }

    if (KV_PARENTS.has(parentType) && node.parent?.child(0) === node) {
        return "review";
    }

    return "high";
}

export async function handlePrepareRefactor(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const symbolName = params.symbol;
    if (!symbolName) {
        return {
            content: [{ type: "text" as const, text: 'Error: "symbol" is required for prepare_refactor.' }],
            isError: true,
        };
    }

    // ─── NREKI LAYER 2: TYPE-SAFE PREDICTIVE BLAST RADIUS ───
    if (deps.kernel?.isBooted()) {
        try {
            const parser = engine.getParser();
            const root = engine.getProjectRoot();
            const defs = await findDefinition(root, parser, symbolName, "any", engine);

            if (defs.length > 0) {
                const targetFile = safePath(deps.engine.getProjectRoot(), defs[0].filePath);
                const br = deps.kernel.predictBlastRadius(targetFile, symbolName);

                const jitWarning = deps.chronos ? deps.chronos.getContextWarnings(targetFile) : "";

                const lines: string[] = [
                    `## Refactor Simulator: \`${symbolName}\``,
                    `**Source:** \`${defs[0].filePath}\` (L${defs[0].startLine})\n`,
                    jitWarning,
                    br.report,
                ];

                return {
                    content: [{ type: "text" as const, text: lines.join("\n") }],
                };
            }
        } catch (err) {
            logger.error("Predictive Blast Radius failed:", err);
            // Fallthrough to Layer 1 (AST heuristics)
        }
    }
    // ─── LAYER 1: HEURISTIC AST FALLBACK ───

    const parser = engine.getParser();

    const candidatePaths = await engine.searchFilesBySymbol(symbolName);
    const candidateFiles = new Set(candidatePaths);

    const highConfidence: Array<{ file: string; line: number; context: string }> = [];
    const reviewManually: Array<{ file: string; line: number; context: string; reason: string }> = [];

    for (const filePath of candidateFiles) {
        let fullPath: string;
        try {
            fullPath = safePath(deps.engine.getProjectRoot(), filePath);
        } catch { continue; }

        let content: string;
        try {
            content = readSource(fullPath);
        } catch { continue; }

        const contentLines = content.split("\n");
        const fp = filePath;

        await parser.parseRaw(fullPath, content, (tree: Parser.Tree) => {
            function visit(node: Parser.SyntaxNode) {
                if (
                    (node.type === "identifier" || node.type === "type_identifier" ||
                     node.type === "property_identifier" || node.type === "shorthand_property_identifier") &&
                    node.text === symbolName
                ) {
                    const line = node.startPosition.row + 1;
                    const lineContent = contentLines[node.startPosition.row]?.trim() || "";
                    const confidence = classifyRefactorConfidence(node);

                    if (confidence === "high") {
                        highConfidence.push({ file: fp, line, context: lineContent });
                    } else {
                        reviewManually.push({
                            file: fp, line, context: lineContent,
                            reason: `parent: ${node.parent?.type || "unknown"}`,
                        });
                    }
                }
                for (let i = 0; i < node.childCount; i++) {
                    visit(node.child(i)!);
                }
            }
            visit(tree.rootNode);
        });
    }

    // Project-relative POSIX paths: absolute Windows paths were ~3× longer and
    // doubled again by JSON escaping.
    const projectRoot = deps.engine.getProjectRoot();
    const rel = (file: string): string => path.relative(projectRoot, file).replace(/\\/g, "/") || file;

    const lines: string[] = [`## Prepare Refactor: \`${symbolName}\``];

    if (highConfidence.length > 0) {
        lines.push(`### HIGH CONFIDENCE (${highConfidence.length} - structural usage)`);
        for (const m of highConfidence) {
            lines.push(`  ${rel(m.file)}:L${m.line} - \`${m.context}\``);
        }
    }

    if (reviewManually.length > 0) {
        lines.push(`### REVIEW MANUALLY (${reviewManually.length} - may be string/key/comment)`);
        for (const m of reviewManually) {
            lines.push(`  ${rel(m.file)}:L${m.line} - \`${m.context}\` (${m.reason})`);
        }
    }

    if (highConfidence.length === 0 && reviewManually.length === 0) {
        lines.push(`No occurrences of \`${symbolName}\` found in the project.`);
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
    };
}

// ─── Orphan Candidates Oracle (Transitive Sweep) ────────────────────

export async function handleOrphanOracle(
    _params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    // v11.2.1: non-blocking lazy index. orphan_oracle reads whatever is
    // already in the repo map; if the index is warming, the answer may be
    // incomplete on this call but the next call will see new entries.
    if (!engine.hasIndexedFiles()) {
        engine.ensureIndexedBackground();
    }

    const { map } = await engine.getRepoMap();
    const graph = await engine.getDependencyGraph();

    // Roots: conventional entry names/folders (matched on the file NAME: the old
    // patterns ran on the whole path, so src/main.tsx and src/App.tsx were never
    // roots) plus what HTML pages and package.json declare (utils/entry-points.ts).
    const declared = declaredEntries(engine.getProjectRoot(), map.entries.map(e => e.filePath));

    const reachable = new Set<string>();
    const roots: string[] = [];

    // O(E) Forward graph from importedBy inversion
    const forwardGraph = new Map<string, string[]>();
    for (const entry of map.entries) {
        forwardGraph.set(entry.filePath, []);
    }
    for (const [target, consumers] of graph.importedBy.entries()) {
        for (const consumer of consumers) {
            const depsList = forwardGraph.get(consumer) || [];
            depsList.push(target);
            forwardGraph.set(consumer, depsList);
        }
    }

    // 1. Identify structural roots
    for (const entry of map.entries) {
        const file = entry.filePath;
        if (isConventionalEntry(file) || declared.has(file)) {
            roots.push(file);
            reachable.add(file);
        }
    }

    // 2. DFS Reachability (Mark)
    const stack = [...roots];
    while (stack.length > 0) {
        const current = stack.pop()!;
        const neighbors = forwardGraph.get(current) || [];
        for (const n of neighbors) {
            if (!reachable.has(n)) {
                reachable.add(n);
                stack.push(n);
            }
        }
    }

    // 3. Sweep: unreachable files with exports = orphan candidates
    const orphanFiles: Array<{ file: string; lines: number; exports: string[] }> = [];
    let savedLines = 0;

    for (const entry of map.entries) {
        if (!reachable.has(entry.filePath) && entry.exports.length > 0) {
            orphanFiles.push({
                file: entry.filePath,
                lines: entry.lineCount,
                exports: entry.exports,
            });
            savedLines += entry.lineCount;
        }
    }

    if (orphanFiles.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `Orphan Review\n\nTransitive reachability analysis complete. ` +
                    `Your architecture is lean. No statically isolated modules found.`,
            }],
        };
    }

    orphanFiles.sort((a, b) => b.lines - a.lines);
    // A candidate that is imported is only as dead as its importers: say who they are.
    const formatted = orphanFiles.map(df => {
        const importers = [...(graph.importedBy.get(df.file) ?? [])];
        const via = importers.length > 0
            ? `; imported only by unreachable ${importers.slice(0, 2).map(i => `\`${i}\``).join(", ")}${importers.length > 2 ? ` +${importers.length - 2}` : ""}`
            : "";
        return `- \`${df.file}\` (${df.lines} lines${via})\n  *Exports:* ` +
            `${df.exports.slice(0, 4).join(", ")}${df.exports.length > 4 ? "..." : ""}`;
    });

    return {
        content: [{
            type: "text" as const,
            text: `Orphan Candidates Oracle (Zero Static Reachability)\n\n` +
                `Mark-and-Sweep reachability analysis from framework roots.\n` +
                `Found **${orphanFiles.length} files** that export logic but are ` +
                `completely unreachable via static imports ` +
                `(including transitive barrel sweeps).\n\n` +
                `⚠️ **CRITICAL WARNING:**\n` +
                `Static analysis cannot detect:\n` +
                `1. Dynamic imports (\`await import()\`).\n` +
                `2. Dependency Injection or Reflection.\n\n` +
                `**Review manually before deleting.** ` +
                `Potential savings: **~${savedLines} lines**.\n\n` +
                `*NREKI edits do not delete files: after the review, delete them with your own tools and re-run the build.*\n\n` +
                `### Candidates:\n${formatted.join("\n")}`,
        }],
    };
}

// ─── Type Shape Oracle ───────────────────────────────────────────────

export async function handleTypeShape(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    if (!deps.kernel || deps.nrekiMode === "syntax") {
        return {
            content: [{ type: "text" as const, text: "Error: type_shape requires a TypeScript project with tsconfig.json." }],
            isError: true,
        };
    }

    // The kernel boots lazily (first edit). Asking for a type before any edit
    // used to answer "kernel not booted… retry", and retrying never helped.
    if (!(await ensureKernelBooted(deps))) {
        return {
            content: [{ type: "text" as const, text: "Error: TypeScript kernel failed to boot (see NREKI logs). Ensure tsconfig.json is valid." }],
            isError: true,
        };
    }

    const symbol = params.symbol ?? "";
    const file = params.path ?? "";
    if (!symbol || !file) {
        return {
            content: [{ type: "text" as const, text: "Error: type_shape requires both path and symbol." }],
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

    const shape = deps.kernel.getTypeShape(resolvedPath, symbol);
    if (!shape) {
        return {
            content: [{ type: "text" as const, text: `Oracle: type shape for \`${symbol}\` not found in ${file}. Ensure the symbol is exported or declared at the top level.` }],
            isError: true,
        };
    }

    return {
        content: [{
            type: "text" as const,
            text: `Oracle: Type Shape for \`${symbol}\`\n\n\`\`\`typescript\n${shape}\n\`\`\``,
        }],
    };
}

/**
 * fast_grep: Ultra-fast exact substring match returning AST-aware coordinates.
 * Uses SQLite INSTR over the chunks.raw_code column. Each hit is reported with
 * the file path + AST symbol containing it + exact line number + context.
 *
 * Handles multi-line queries: for a query with "\n", the reported snippet is the
 * first line of the QUERY (not the chunk), since printing the first line of a large
 * chunk would be misleading when the match is deep inside.
 */
export async function handleFastGrep(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    const query = params.query ?? "";
    if (query.length < 3) {
        return {
            content: [{ type: "text" as const, text: "Error: fast_grep query must be at least 3 characters." }],
            isError: true,
        };
    }

    // engine.fastGrep shares the same first-use reconciliation as search.

    const explicitLimit = typeof params.limit === "number" ? Math.min(500, Math.max(1, params.limit)) : null;
    const limit = explicitLimit ?? 200;
    // Output cap: a broad query ("const ", "return ") over 200 chunks printed
    // 10-20k tokens. Hits past the cap are summarized per file instead. An
    // explicit `limit` raises the cap for agents that really want every line.
    const maxLines = Math.max(FAST_GREP_MAX_LINES, explicitLimit ?? 0);
    // Exact case first. With no exact hit, any case: "LIMPIEZA" found nothing in
    // a site that says "Limpieza", and the agent had to guess "impieza" (2026-11-27).
    let ignoreCase = params.ignore_case === true;
    let chunks = await engine.fastGrep(query, limit, { ignoreCase });
    let caseNote = "";
    if (chunks.length === 0 && !ignoreCase && query.toLowerCase() !== query.toUpperCase()) {
        chunks = await engine.fastGrep(query, limit, { ignoreCase: true });
        if (chunks.length > 0) {
            ignoreCase = true;
            caseNote = "No exact-case match; these match ignoring case.\n";
        }
    }

    if (chunks.length === 0) {
        const tried = ignoreCase || query.toLowerCase() !== query.toUpperCase() ? " (in any case)" : "";
        return {
            content: [{ type: "text" as const, text: `No matches found for substring: "${query}"${tried}.` }],
        };
    }
    const anyCase = ignoreCase ? new RegExp(escapeRegExp(query), "gi") : null;
    /** Next match of the query in `raw` from `from`: its offset (-1 = none) and length. */
    const nextMatch = (raw: string, from: number): { at: number; len: number } => {
        if (!anyCase) return { at: raw.indexOf(query, from), len: query.length };
        anyCase.lastIndex = from;
        const m = anyCase.exec(raw);
        return m ? { at: m.index, len: Math.max(1, m[0].length) } : { at: -1, len: 0 };
    };

    const root = engine.getProjectRoot();
    const byFile = new Map<string, typeof chunks>();
    for (const c of chunks) {
        const arr = byFile.get(c.path) || [];
        arr.push(c);
        byFile.set(c.path, arr);
    }

    const lines = [`## Semantic Fast Grep: "${query}"${ignoreCase ? " (any case)" : ""}\n${caseNote}`];
    let matchCount = 0;
    let shownCount = 0;
    const overflow: Array<{ relPath: string; count: number }> = [];

    const isMultiLine = query.includes("\n");
    let multiLineSnippet = "";
    if (isMultiLine) {
        const nlIdx = query.indexOf("\n");
        const preview = (nlIdx === -1 ? query : query.substring(0, nlIdx)).trim();
        multiLineSnippet = preview.length > 80 ? preview.substring(0, 80) + "..." : preview + "...";
    }

    // Production code first, then tests/scripts/docs; alphabetical inside each group.
    const orderedFiles = [...byFile.entries()]
        .map(([file, fileChunks]) => ({ fileChunks, relPath: path.relative(root, file).replace(/\\/g, "/") }))
        .sort((a, b) =>
            Number(isSecondaryPath(a.relPath)) - Number(isSecondaryPath(b.relPath)) ||
            a.relPath.localeCompare(b.relPath));

    for (const { fileChunks, relPath } of orderedFiles) {

        // Sort chunks from most specific (innermost method/function) to broadest (enclosing class)
        // and prefer named symbols over top-level gap chunks so each line is reported once under
        // its most specific AST symbol.
        const sortedChunks = [...fileChunks].sort((a, b) => {
            const aNamed = a.symbol_name ? 0 : 1;
            const bNamed = b.symbol_name ? 0 : 1;
            if (aNamed !== bNamed) return aNamed - bNamed;
            return a.raw_code.length - b.raw_code.length;
        });

        const reportedLines = new Set<number>();
        const fileHits: Array<{ line: number; text: string }> = [];

        for (const chunk of sortedChunks) {
            const symName = chunk.symbol_name || "<top-level>";
            let match = nextMatch(chunk.raw_code, 0);
            let scanPos = match.at;
            if (scanPos === -1) continue;

            let currentLineOffset = 0;
            let currentLineStart = 0;
            let nextNl = chunk.raw_code.indexOf("\n");

            while (scanPos !== -1) {
                while (nextNl !== -1 && nextNl < scanPos) {
                    currentLineOffset++;
                    currentLineStart = nextNl + 1;
                    nextNl = chunk.raw_code.indexOf("\n", currentLineStart);
                }

                const exactLine = chunk.start_line + currentLineOffset;

                if (!reportedLines.has(exactLine)) {
                    reportedLines.add(exactLine);
                    matchCount++;

                    if (isMultiLine) {
                        fileHits.push({
                            line: exactLine,
                            text: `${relPath} :: ${symName} (L${exactLine}) [match spans multiple lines]: ${multiLineSnippet}`,
                        });
                    } else {
                        const lineEnd = nextNl !== -1 ? nextNl : chunk.raw_code.length;
                        const context = chunk.raw_code.substring(currentLineStart, lineEnd).trim().slice(0, 160);
                        fileHits.push({
                            line: exactLine,
                            text: `${relPath} :: ${symName} (L${exactLine}): ${context}`,
                        });
                    }
                }

                match = nextMatch(chunk.raw_code, scanPos + match.len);
                scanPos = match.at;
            }
        }

        fileHits.sort((a, b) => a.line - b.line);
        const room = Math.max(0, maxLines - shownCount);
        for (const hit of fileHits.slice(0, room)) lines.push(hit.text);
        shownCount += Math.min(room, fileHits.length);
        if (fileHits.length > room) overflow.push({ relPath, count: fileHits.length - room });
    }

    lines.splice(1, 0, `Found ${matchCount} match(es) within ${chunks.length} AST symbol(s).\n`);
    if (overflow.length > 0) {
        const hidden = matchCount - shownCount;
        const listed = overflow.slice(0, 40).map(o => `${o.relPath} (${o.count})`).join(", ");
        const more = overflow.length > 40 ? `, +${overflow.length - 40} more files` : "";
        lines.push(
            `\n[Output capped at ${shownCount} lines. ${hidden} more match(es) in: ${listed}${more}. ` +
            `Refine the query, or pass limit (up to 500) to show more lines.]`,
        );
    }
    if (chunks.length >= limit) {
        lines.push(`\n[Showing first ${chunks.length} matching chunks (limit=${limit}). Pass a higher limit (up to 500) or refine query if needed.]`);
    }

    const finalText = lines.join("\n");

    return {
        content: [{ type: "text" as const, text: finalText }],
    };
}
