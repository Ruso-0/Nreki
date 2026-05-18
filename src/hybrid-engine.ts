/**
 * src/hybrid-engine.ts — Production Hybrid RRF retrieval engine.
 *
 * Phase 5.5.2 migration: ported from
 *   scripts/eval-phase5/runners/hybrid-runner.ts
 * Combines NREKI's Type Ledger semantic retrieval (file-level dedup) +
 * BM25 lexical retrieval via Reciprocal Rank Fusion at file level,
 * then re-attaches AST-aware chunks for NREKI-contributed files and
 * optionally applies foveal compression to BM25-only files (Reto 5).
 *
 * Empirical basis (Sprint 6.4 paper, N=99):
 *   Hybrid FHR 0.566 vs NREKI 0.414 vs BM25 0.374
 *   9/10 deltas Bonferroni-significant α=0.01
 *
 * Production differences vs. eval runner:
 *   - No PolyBenchTask wrapping — accepts free-text query.
 *   - Uses in-process NrekiEngine + BM25Engine (no per-task engine spin-up).
 *   - Optional foveal compression on BM25-only files (Reto 5 architectural
 *     integration; eval runner did NOT do this, hence higher token cost).
 *   - Returns unified result list with source tracking ("nreki" | "bm25" | "both").
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { NrekiEngine } from "./engine.js";
import type { SearchResult } from "./engine-types.js";
import { BM25Engine } from "./bm25-engine.js";
import { tfcCompress } from "./compressor-foveal.js";

/** Reciprocal Rank Fusion constant (Cormack et al. 2009, sostained Sprint 6.4). */
export const DEFAULT_RRF_K = 60;

/** Origin of a hybrid hit — used for diagnostics and downstream decisions. */
export type HybridSource = "nreki" | "bm25" | "both";

/**
 * Unified hybrid result. Each entry represents one chunk surfaced by
 * the fusion pipeline. NREKI-contributed chunks carry AST coordinates
 * (start_line/end_line) plus rawCode; BM25-only files carry a synthetic
 * chunk spanning the foveal-compressed payload (start_line=1).
 */
export interface HybridSearchResult {
    /** Workspace-relative, forward-slash path. */
    path: string;
    /** 1-indexed inclusive start line of the surfaced range. */
    startLine: number;
    /** 1-indexed inclusive end line of the surfaced range. */
    endLine: number;
    /** Fused RRF score (file-level; same value for all chunks of a file). */
    score: number;
    /** Raw payload text — AST rawCode for NREKI hits or foveal-compressed for BM25. */
    content: string;
    /** Which engine surfaced this file. */
    source: HybridSource;
    /** Node type for NREKI hits; "bm25_file" for BM25-only fallback. */
    nodeType: string;
}

export interface HybridSearchOptions {
    /** Top-K files in fused output. Default 10. */
    topK?: number;
    /** RRF constant — higher dampens the head of either list. Default 60. */
    rrfK?: number;
    /**
     * Apply foveal compression to BM25-only files post-fusion (Reto 5).
     * Default true. Disable for paradigm-faithful eval reproduction.
     */
    applyFovealOnBm25?: boolean;
    /** Max cross-file Type Ledger parafovea hops in foveal pass. Default 10. */
    maxCrossFile?: number;
    /**
     * Pool size fetched from each retriever before fusion (must be
     * >= topK so RRF has rank signal beyond cutoff). Default topK*4.
     */
    fetchPoolMultiplier?: number;
}

interface RankedFile {
    file: string;
    score: number;
}

function uniqueFiles(files: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push(f);
    }
    return out;
}

function addRRFScores(
    files: string[],
    scores: Map<string, number>,
    rrfK: number,
): void {
    files.forEach((file, idx) => {
        const rank = idx + 1;
        scores.set(file, (scores.get(file) ?? 0) + 1 / (rrfK + rank));
    });
}

/**
 * Reciprocal Rank Fusion at file level. Deterministic tie-breaker
 * via localeCompare so identical scores yield stable ordering across
 * runs and platforms (Sprint 6.4 reproducibility requirement).
 */
export function rrfFuseFiles(
    nrekiFilesInput: string[],
    bm25FilesInput: string[],
    topK: number,
    rrfK: number = DEFAULT_RRF_K,
): string[] {
    const nrekiFiles = uniqueFiles(nrekiFilesInput);
    const bm25Files = uniqueFiles(bm25FilesInput);
    const scores = new Map<string, number>();
    addRRFScores(nrekiFiles, scores, rrfK);
    addRRFScores(bm25Files, scores, rrfK);

    const ranked: RankedFile[] = [...scores.entries()].map(([file, score]) => ({ file, score }));
    return ranked
        .sort((a, b) => {
            const d = b.score - a.score;
            return d !== 0 ? d : a.file.localeCompare(b.file);
        })
        .slice(0, topK)
        .map(r => r.file);
}

/** Compute which source(s) surfaced each fused file. */
function classifyOrigin(
    fusedFiles: string[],
    nrekiSet: Set<string>,
    bm25Set: Set<string>,
): Map<string, HybridSource> {
    const out = new Map<string, HybridSource>();
    for (const f of fusedFiles) {
        const inN = nrekiSet.has(f);
        const inB = bm25Set.has(f);
        out.set(f, inN && inB ? "both" : inN ? "nreki" : "bm25");
    }
    return out;
}

/**
 * Focus extraction for foveal compression on BM25-only files. Uses the
 * first identifier in the query that doesn't look like a path segment.
 * Falls back to filename basename if no query identifier survives.
 */
function extractFocusForFile(query: string, filePath: string): string {
    const tokens = query.match(/[A-Za-z_][A-Za-z0-9_]+/g) ?? [];
    for (const t of tokens) {
        if (t.length >= 3 && !/^(the|and|for|with|from|into)$/i.test(t)) return t;
    }
    const base = path.basename(filePath);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Production hybrid retrieval engine. Constructed with a NrekiEngine
 * (already initialized + indexed) and a BM25Engine (lazy-built on demand).
 */
export class HybridEngine {
    constructor(
        private readonly nrekiEngine: NrekiEngine,
        private readonly bm25Engine: BM25Engine,
    ) {}

    /** Drop the BM25 cached index (call when files change). */
    invalidateBM25(): void {
        this.bm25Engine.invalidate();
    }

    /**
     * Hybrid retrieval. Returns up to `topK` files' worth of chunks,
     * each marked with source. NREKI files surface their AST chunks;
     * BM25-only files surface a foveal-compressed synthetic chunk
     * (when applyFovealOnBm25=true, default) or raw file content.
     */
    async search(
        query: string,
        options: HybridSearchOptions = {},
    ): Promise<HybridSearchResult[]> {
        const topK = options.topK ?? 10;
        const rrfK = options.rrfK ?? DEFAULT_RRF_K;
        const applyFoveal = options.applyFovealOnBm25 ?? true;
        const maxCrossFile = options.maxCrossFile ?? 10;
        const fetchMultiplier = options.fetchPoolMultiplier ?? 4;
        const fetchK = Math.max(topK * fetchMultiplier, topK);

        const projectRoot = this.nrekiEngine.getProjectRoot();

        const [nrekiHits, bm25Hits] = await Promise.all([
            this.nrekiEngine.search(query, fetchK),
            this.bm25Engine.search(query, fetchK),
        ]);

        // File-level dedup for NREKI (search returns multi-chunk files).
        const nrekiByFile = new Map<string, SearchResult[]>();
        for (const sr of nrekiHits) {
            const rel = path.relative(projectRoot, sr.path).split(path.sep).join("/");
            const arr = nrekiByFile.get(rel) ?? [];
            arr.push(sr);
            nrekiByFile.set(rel, arr);
        }
        const nrekiFileList = [...nrekiByFile.keys()];
        const bm25FileList = bm25Hits.map(h => h.path);

        const fused = rrfFuseFiles(nrekiFileList, bm25FileList, topK, rrfK);
        const nrekiSet = new Set(nrekiFileList);
        const bm25Set = new Set(bm25FileList);
        const origin = classifyOrigin(fused, nrekiSet, bm25Set);

        const scoreByFile = new Map<string, number>();
        addRRFScores(uniqueFiles(nrekiFileList), scoreByFile, rrfK);
        addRRFScores(uniqueFiles(bm25FileList), scoreByFile, rrfK);

        const results: HybridSearchResult[] = [];
        for (const rel of fused) {
            const fileScore = scoreByFile.get(rel) ?? 0;
            const src = origin.get(rel) ?? "bm25";

            if (nrekiByFile.has(rel)) {
                for (const sr of nrekiByFile.get(rel)!) {
                    results.push({
                        path: rel,
                        startLine: sr.startLine,
                        endLine: sr.endLine,
                        score: fileScore,
                        content: sr.rawCode,
                        source: src,
                        nodeType: sr.nodeType,
                    });
                }
                continue;
            }

            // BM25-only file — apply foveal compression (Reto 5) or raw fallback.
            const abs = path.join(projectRoot, rel);
            let raw: string;
            try {
                raw = await fs.readFile(abs, "utf-8");
            } catch {
                continue;
            }
            const lineCount = raw.split("\n").length;

            let payload = raw;
            // Align with compressor-foveal.ts:109 bypass threshold to avoid
            // calling tfcCompress for files it will return raw anyway.
            if (applyFoveal && lineCount >= 100) {
                const focus = extractFocusForFile(query, rel);
                try {
                    const tfc = await tfcCompress(abs, raw, focus, this.nrekiEngine, {
                        maxCrossFile,
                    });
                    if (tfc.kind === "success") {
                        payload = tfc.data.compressed;
                    }
                } catch {
                    // Non-fatal: fall back to raw content.
                }
            }

            results.push({
                path: rel,
                startLine: 1,
                endLine: lineCount,
                score: fileScore,
                content: payload,
                source: src,
                nodeType: "bm25_file",
            });
        }

        return results;
    }
}
