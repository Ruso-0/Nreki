/**
 * compressor-foveal.ts — Hyper-Causal Topological Foveal Compression (TFC-Ultra)
 *
 * Architecture by Jherson Eddie Tintaya Holguin (Ruso-0).
 *
 * Asymmetric context sculpting for Frontier Models.
 * PROMPT CACHE INVERSION:
 * [Imports] -> [Dark Matter] -> [External] -> [Downstream] -> [Upstream] -> [FOVEA]
 *
 * CACHE PHYSICS:
 * Static sections (Imports, Dark Matter, External) MUST remain byte-identical.
 * All dynamic metadata (Foci names, line counts) are pushed to the VOLATILE
 * bottom section to preserve Anthropic's Prefix Cache.
 *
 * v8.6 (TFC-Ultra): O(1) parafoveal overhead
 *   - Upstream vectorial collapse: N callers → 1 plain name line
 *   - Downstream event horizon: top-10 + cleanSignature()
 *   - Density Shield 0.85: fail-safe fallback to legacy aggressive
 *
 * @license Proprietary — @ruso-0/nreki-turbo
 */

import path from "path";
import crypto from "crypto";
import { type ParsedChunk, type ParseResult, normalizeWebSymbol } from "./parser.js";
import { extractDependencies, cleanSignature } from "./utils/imports.js";
import { estimateTokens } from "./utils/token-estimator.js";
import { findQualifiedChunk, splitQualifiedName } from "./utils/qualified-name.js";
import type { NrekiEngine } from "./engine.js";
import {
    extractTypeLedgerParafovea,
    countTotalCrossFileBeforeTruncation,
    renderCrossFileUpstream,
    renderCrossFileDownstream,
    renderTruncationAdvisory,
    computeCrossFileBytes,
} from "./compressor-foveal-cross-file.js";

// 🔥 TFC v2: TRUE LRU AST CACHE 🔥
// Prevents re-parsing Tree-sitter when content hasn't mutated.
// Map's insertion order + delete+set on hit = true LRU in O(1).
const tfcParseCache = new Map<string, { hash: string; result: ParseResult }>();
const MAX_CACHE_ENTRIES = 10;

export interface TfcResult {
    compressed: string;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    tokensSaved: number;
    zones: {
        foveas: string[];
        localParafovea: number;
        externalParafovea: number;
        upstream: number;
        darkMatterLines: number;
        // Phase 4 cross-file Type Ledger metrics
        crossFileUpstream: number;
        crossFileDownstream: number;
        crossFileTruncated: number;
    };
}

export type TfcResultPayload =
    | { kind: "success"; data: TfcResult }
    /** `available`: the file's symbol names, so the caller can answer "did you mean" without another call. */
    | { kind: "not_found"; available?: string[] }
    | { kind: "shield_tripped"; ratio: number; originalSize: number; compressedSize: number };

const NOISE_WORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "throw", "new", "await",
    "function", "class", "typeof", "instanceof", "delete", "void", "yield",
    "import", "export", "from", "as", "console", "require", "module", "process",
    "true", "false", "null", "undefined", "any", "unknown", "never",
    "string", "number", "boolean", "Record", "Partial", "Omit", "Pick",
    "Math", "JSON", "Object", "Array", "String", "Number", "Promise",
    "Map", "Set", "Error", "setTimeout", "setInterval"
]);

function extractCausalRefs(code: string): Set<string> {
    const refs = new Set<string>();
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/\b([a-zA-Z_]\w*)\.[a-zA-Z_]\w*\s*\(/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/(?::\s*|<|extends\s+|implements\s+|as\s+)([A-Z][a-zA-Z0-9_]*)/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/this\.([a-zA-Z_]\w*)/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    for (const m of code.matchAll(/\b([A-Z_][A-Z0-9_]{2,})\b/g)) if (!NOISE_WORDS.has(m[1])) refs.add(m[1]);
    return refs;
}

export interface TfcCrossFileOptions {
    /** Phase 4: K-hop expansion. Furia round 12: K=1 ESTRICTO, max=1. */
    walkDepth?: number;
    /** Phase 4: hard cap on UNIQUE cross-file chunks. Default 10. */
    maxCrossFile?: number;
}

export async function tfcCompress(
    filePath: string,
    content: string,
    focusInput: string,
    engine: NrekiEngine,
    crossFileOpts?: TfcCrossFileOptions,
): Promise<TfcResultPayload> {
    const originalSize = content.length;

    // Sprint 8.0 control arm (eval-only): FOVEAL_OFF=1 forces the bypass
    // unconditionally so the foveal_off arm delivers raw content with zero
    // compression. When FOVEAL_OFF is unset or any value other than "1",
    // `fovealOff` is false and the condition below is byte-identical to the
    // pre-Sprint-8.0 behaviour (prereg foveal_on arm frozen). See
    // scripts/eval-phase8/prereg-erratum-01.md.
    const fovealOff = process.env.FOVEAL_OFF === "1";

    // No small-file bypass any more: a focus on a 17-line file returned all 17
    // lines (133 tokens for a 4-line `clamp` in the 2026-11-13 A/B). The header
    // is one line now, and a focus that is most of the file still gets the
    // whole file (Density Shield below → the handler returns it).
    if (fovealOff) {
        return {
            kind: "success",
            data: {
                compressed: content,
                originalSize,
                compressedSize: originalSize,
                ratio: 0,
                tokensSaved: 0,
                zones: {
                    foveas: focusInput.split(",").map(s => s.trim()).filter(Boolean),
                    localParafovea: 0,
                    externalParafovea: 0,
                    upstream: 0,
                    darkMatterLines: 0,
                    crossFileUpstream: 0,
                    crossFileDownstream: 0,
                    crossFileTruncated: 0,
                },
            },
        };
    }

    // O(1) parse cache by content hash
    const contentHash = crypto.createHash("sha256").update(content).digest("hex");
    let parseResult: ParseResult;

    const cached = tfcParseCache.get(filePath);
    if (cached && cached.hash === contentHash) {
        // TRUE LRU: delete + re-set promotes entry to MRU position
        tfcParseCache.delete(filePath);
        tfcParseCache.set(filePath, cached);
        parseResult = cached.result;
    } else {
        const parser = engine.getParser();
        try {
            parseResult = await parser.parse(filePath, content);
            if (parseResult.chunks.length > 0) {
                // Evict oldest (first key by insertion order)
                if (tfcParseCache.size >= MAX_CACHE_ENTRIES) {
                    const oldestKey = tfcParseCache.keys().next().value;
                    if (oldestKey !== undefined) tfcParseCache.delete(oldestKey);
                }
                tfcParseCache.set(filePath, { hash: contentHash, result: parseResult });
            }
        } catch { return { kind: "not_found" }; }
    }

    if (parseResult.chunks.length === 0) return { kind: "not_found" };

    // 1. MULTI-FOCAL TARGETS + OVERLOAD FIX
    // v10.18.1: shared normalizeWebSymbol covers CSS+HTML+JSON uniformly.
    // Previous inline regex covered only CSS (despite isCss naming HTML too,
    // it ran identical CSS rules). JSON foci were never normalized.
    const ext = path.extname(filePath).toLowerCase();

    const rawFoci = focusInput.split(",").map(s => normalizeWebSymbol(s.trim(), ext)).filter(Boolean);
    const foveas = new Set<ParsedChunk>();

    for (const raw of rawFoci) {
        // `Class.method` (also ::, #, ->): that member; else match its member name.
        const qualified = splitQualifiedName(raw);
        if (qualified) {
            const hit = findQualifiedChunk(parseResult.chunks, raw, c => c.symbolName);
            if (hit.chunk) {
                foveas.add(hit.chunk);
                continue;
            }
        }
        const focus = (qualified?.member ?? raw).toLowerCase();
        const matches = parseResult.chunks.filter(c =>
            c.symbolName.toLowerCase() === focus ||
            c.symbolName.toLowerCase().includes(focus)
        );
        for (const m of matches) foveas.add(m);
    }
    if (foveas.size === 0) {
        const available = [...new Set(parseResult.chunks.map(c => c.symbolName).filter(Boolean))];
        return { kind: "not_found", available };
    }

    // 2. CAUSAL RAYTRACING
    const foveaUses = new Set<string>();
    const foveaNames = new Set<string>();

    for (const f of foveas) {
        foveaNames.add(f.symbolName);
        const refs = extractCausalRefs(f.rawCode + "\n" + f.shorthand);
        for (const r of refs) foveaUses.add(r);
    }

    // 🔥 TFC-Ultra: upstream collapses to Set<string> for O(1) overhead
    const upstreamNames = new Set<string>();
    const downstream = new Set<ParsedChunk>();
    let darkMatterLines = 0;

    for (const chunk of parseResult.chunks) {
        if (foveas.has(chunk)) continue;

        const chunkRefs = extractCausalRefs(chunk.rawCode);
        let isUpstream = false;
        for (const fname of foveaNames) {
            if (chunkRefs.has(fname)) {
                isUpstream = true;
                break;
            }
        }

        if (isUpstream) {
            upstreamNames.add(chunk.symbolName || "anonymous");
        } else if (foveaUses.has(chunk.symbolName)) {
            downstream.add(chunk);
        } else {
            // Dark matter: orthogonal logic. Only count lines, no Set needed.
            darkMatterLines += (chunk.endLine - chunk.startLine + 1);
        }
    }

    // 3. PHASE 4: CROSS-FILE TYPE LEDGER PARAFOVEA (Furia round 12)
    // K=1 strict (walkDepth clamped to max 1). Anti-hub via rankByInDegree.
    // Fail-open if Type Ledger lookup misses (defensive).
    const _walkDepth = Math.max(0, Math.min(1, crossFileOpts?.walkDepth ?? 1));
    const maxCrossFile = Math.max(0, Math.min(50, crossFileOpts?.maxCrossFile ?? 10));
    const foveaPaths = new Set([filePath]);
    const foveaCrossFileInputs = Array.from(foveas).map(f => ({
        path: filePath,
        symbolName: f.symbolName,
    }));
    const crossFileChunks = (_walkDepth >= 1 && maxCrossFile > 0)
        ? extractTypeLedgerParafovea(foveaCrossFileInputs, engine, maxCrossFile)
        : [];
    const crossFileTotalPre = crossFileChunks.length > 0
        ? countTotalCrossFileBeforeTruncation(foveaCrossFileInputs, engine)
        : 0;

    // FURIA #51: Type Ledger symbols PRECEDE BM25 lexical (dedup).
    // External Parafovea via BM25 operates on residual after Ledger filter.
    const ledgerResolvedSymbols = new Set(crossFileChunks.map(c => c.symbolName));

    // 4. CAUSAL PAST (External Imports — BM25 over residual post-dedup)
    const allImports = extractDependencies(content, ext);
    const usedImports = allImports.filter(imp => {
        // FURIA #51 dedup: skip imports already resolved by Type Ledger.
        if (ledgerResolvedSymbols.has(imp.localName)) return false;
        const safeName = imp.localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(^|[^a-zA-Z0-9_$])${safeName}(?=[^a-zA-Z0-9_$]|$)`);
        for (const f of foveas) {
            if (regex.test(f.rawCode)) return true;
        }
        return false;
    });

    let externalParafoveaText = "";
    let externalCount = 0;
    if (usedImports.length > 0) {
        const rawSignatures = engine.resolveImportSignatures(usedImports.slice(0, 15));
        if (rawSignatures.length > 0) {
            externalCount = rawSignatures.length;
            externalParafoveaText = rawSignatures
                .map(s => `  import ${path.basename(s.path)} -> \`${cleanSignature(s.raw)}\``)
                .join("\n");
            engine.incrementAutoContext();
        }
    }

    // PHASE 4: Pre-render cross-file blocks for output assembly + bytes accounting.
    const projectRootForRel = engine.getProjectRoot();
    const relPathFn = (p: string): string =>
        path.relative(projectRootForRel, p).replace(/\\/g, "/");
    const crossFileUpstreamText = renderCrossFileUpstream(crossFileChunks, relPathFn);
    const crossFileDownstreamText = renderCrossFileDownstream(crossFileChunks, relPathFn);
    const crossFileAdvisoryText = renderTruncationAdvisory(
        crossFileTotalPre,
        new Set(crossFileChunks.map(c => c.chunkId)).size,
    );
    const crossFileBytesTotal = computeCrossFileBytes(
        crossFileUpstreamText, crossFileDownstreamText, crossFileAdvisoryText,
    );
    void foveaPaths;

    // 4. CAUSAL FUTURE (who imports this file)
    const relPath = path.relative(engine.getProjectRoot(), filePath).replace(/\\/g, "/");
    const dependents = await engine.findDependents(relPath);

    // 5. ASSEMBLY. Only lines the agent can act on: a tool result stays in the
    // conversation and is paid again on every later request of the session.
    // The banners this used to carry (TOPOLOGICAL LAYOUT, TFC METADATA,
    // FOVEA 100% Resolution…) cost ~150 tokens per call around a 3-line body.
    const parts: string[] = [];

    const earliestStart = parseResult.chunks.reduce((min, c) => c.startIndex < min ? c.startIndex : min, Infinity);
    const preamble = content.substring(0, earliestStart).split("\n")
        .filter(l => /^(import|export|from|require|type|interface)/.test(l.trim()) || l.trim() === "")
        .join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (preamble) { parts.push(preamble); parts.push(""); }

    const notes: string[] = [];
    if (externalParafoveaText) notes.push("// imports used:", externalParafoveaText);
    if (dependents.length > 0) {
        notes.push(`// imported by ${dependents.length} file(s): ${dependents.slice(0, 5).join(", ")}${dependents.length > 5 ? ", …" : ""}`);
    }
    if (upstreamNames.size > 0) {
        // N callers → 1 line of plain names.
        const names = Array.from(upstreamNames).sort();
        notes.push(`// called in this file by: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` (+${names.length - 10})` : ""}`);
    }
    if (crossFileUpstreamText) notes.push(crossFileUpstreamText);
    if (downstream.size > 0) {
        // Top 10 local deps, cleanSignature strips JSDocs and whitespace waste.
        notes.push("// uses from this file:");
        const sortedDownstream = Array.from(downstream).sort((a, b) => a.startIndex - b.startIndex);
        for (const c of sortedDownstream.slice(0, 10)) notes.push(cleanSignature(c.shorthand));
        if (downstream.size > 10) notes.push(`// … +${downstream.size - 10} more`);
    }
    if (crossFileDownstreamText) notes.push(crossFileDownstreamText);
    if (crossFileAdvisoryText) notes.push(crossFileAdvisoryText);
    if (notes.length > 0) { parts.push(...notes); parts.push(""); }

    const sortedFoveas = Array.from(foveas).sort((a, b) => a.startIndex - b.startIndex);
    for (const f of sortedFoveas) {
        parts.push(`/* L${f.startLine}-L${f.endLine} */`);
        parts.push(f.rawCode);
        parts.push("");
    }

    const compressed = parts.join("\n").trim();
    const compressedSize = compressed.length;

    // 🔥 DENSITY SHIELD 0.85 (stricter — require ≥15% real compression) 🔥
    // v8.6: raised the bar from 0.95 to 0.85. If TFC-Ultra can't beat 15%
    // against the raw file, fall through to legacy aggressive (which averages
    // ~85% reduction). Mathematical guarantee: TFC never loses to baseline.
    //
    // Patterns this catches:
    //  - God Class focus (fovea = entire file, metadata overhead wins)
    //  - Marginal compression cases where the agent's choice of focus is
    //    barely useful (better to give them the full aggressive summary)
    // FURIA #50 Density Shield exemption: cross-file bytes are EXCLUDED
    // from the compressedSize used for the shield ratio. Razón: shield
    // evalúa compresión del archivo principal, NO el contexto externo
    // injection. Sumar cross-file invierte la semántica del shield
    // (penalizaría contexto útil).
    const compressedSizeForShield = Math.max(0, compressedSize - crossFileBytesTotal);
    if (compressedSizeForShield >= originalSize * 0.85) {
        return {
            kind: "shield_tripped",
            ratio: 1 - (compressedSizeForShield / originalSize),
            originalSize,
            compressedSize
        };
    }

    const tokensSaved = Math.max(0, estimateTokens(content) - estimateTokens(compressed));

    return {
        kind: "success",
        data: {
            compressed, originalSize, compressedSize,
            ratio: 1 - (compressedSize / originalSize),
            tokensSaved,
            zones: {
                foveas: Array.from(foveaNames),
                localParafovea: downstream.size,
                externalParafovea: externalCount,
                upstream: upstreamNames.size,
                darkMatterLines,
                crossFileUpstream: crossFileChunks.filter(c => c.relation === "upstream").length,
                crossFileDownstream: crossFileChunks.filter(c => c.relation === "downstream").length,
                crossFileTruncated: Math.max(0, crossFileTotalPre - new Set(crossFileChunks.map(c => c.chunkId)).size),
            }
        }
    };
}
