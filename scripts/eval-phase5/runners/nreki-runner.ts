/**
 * scripts/eval-phase5/runners/nreki-runner.ts
 *
 * Phase 5 C.3.E.3: NREKI complete system runner.
 *
 * Sixth and final baseline. Drives NREKI's integrated retrieval
 * pipeline (T-RAG search + tectonic relevance scoring + foveal
 * compression with optional Markov Blanket Foveal cross-file
 * injection) for a single PolyBenchTask and emits the universal
 * RetrievalResult shape.
 *
 * Furia round 19 P1 ablation:
 *   { enableMarkovBlanket: false } -> maxCrossFile = 0 (no Phase 4)
 *   { enableMarkovBlanket: true  } -> maxCrossFile = 10 (default)
 *   Both cells run on the same HEAD -- no git checkout cross-commit.
 *
 * Furia round 19 #3: token_cost measures the payload delivered to
 * the downstream agent. For NREKI that's the foveal-compressed
 * text from tfcCompress.compressed (not raw chunk source). This
 * is what makes the MBF toggle observable in token_cost.
 *
 * Engine ownership: if options.engine is provided, the runner
 * reuses it and does NOT shut it down (caller owns the lifetime).
 * Otherwise the runner constructs a fresh engine per call and
 * shuts down in finally.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NrekiEngine } from "../../../src/engine.js";
import { tfcCompress } from "../../../src/compressor-foveal.js";
import type { SearchResult } from "../../../src/engine-types.js";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { payloadTokens } from "../utils/tokenizer.js";

/** Default maxCrossFile passed to tfcCompress when MBF is on. */
export const NREKI_TOP_MAX_CROSS_FILE = 10;

/**
 * Focus extraction regex. Captures the identifier after a top-level
 * TypeScript declaration keyword. Supports export + default modifiers
 * and async on function. Multiline via `m` flag so it matches the
 * first such declaration within a chunk's rawCode.
 */
export const FOCUS_DECL_REGEX =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:class|function|interface|const|enum|type|let|var)\s+(\w+)/m;

/**
 * Extract a focus symbol for tfcCompress from a SearchResult's rawCode.
 * Falls back to the filename (without extension) when no top-level
 * declaration is matched (anonymous chunks, JSX fragments, etc.).
 */
export function extractFocus(rawCode: string, filePath: string): string {
    const m = rawCode.match(FOCUS_DECL_REGEX);
    if (m && m[1]) return m[1];
    const base = path.basename(filePath);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

export interface NrekiRunnerOptions {
    /**
     * Pre-built engine reused across tasks (C.4 orchestrator cache).
     * If omitted the runner constructs a fresh engine per call and
     * shuts it down in `finally`.
     */
    engine?: NrekiEngine;
    /**
     * When constructing the engine, set this flag. Default: true.
     * Ignored when `engine` is provided (the caller-built engine
     * already has its own flag).
     */
    enableMarkovBlanket?: boolean;
    /**
     * tfcCompress `maxCrossFile` parameter when MBF is on.
     * Default: NREKI_TOP_MAX_CROSS_FILE (10).
     */
    topMaxCrossFile?: number;
}

function normalisePath(repoRoot: string, abs: string): string {
    return path.relative(repoRoot, abs).split(path.sep).join("/");
}

/**
 * Run NREKI complete system retrieval for a single PolyBenchTask.
 *
 * See module header for the pipeline summary. Errors are captured
 * into RetrievalResult.error rather than thrown so the evaluator
 * can iterate many tasks without aborting on a single bad repo.
 */
export async function runNREKI(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    options: NrekiRunnerOptions = {},
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const ownsEngine = !options.engine;
    const engine = options.engine ?? new NrekiEngine({
        dbPath: path.join(repoRoot, ".nreki.db"),
        watchPaths: [repoRoot],
        enableMarkovBlanket: options.enableMarkovBlanket ?? true,
    });
    const topMaxCrossFile = options.topMaxCrossFile ?? NREKI_TOP_MAX_CROSS_FILE;

    try {
        await engine.initialize();
        if (!engine.hasIndexedFiles()) {
            await engine.indexDirectory(repoRoot);
        }

        // 1. T-RAG search over the issue body. We fetch a deeper pool
        //    (topK * 3) than needed so the anti-tests filter has room
        //    to drop test hits without starving retrieved_files.
        const fetchLimit = Math.max(topK * 3, topK);
        const allHits: SearchResult[] = await engine.search(
            task.problem_statement,
            fetchLimit,
        );

        // 2. Anti-tests filter + path normalization. Track per-chunk
        //    info so we can dedup files but keep multiple chunks if
        //    they share a file.
        const filtered: Array<{
            relPath: string;
            chunk: ChunkResult;
            rawCode: string;
        }> = [];
        for (const sr of allHits) {
            const relPath = normalisePath(repoRoot, sr.path);
            if (isTestFile(relPath)) continue;
            filtered.push({
                relPath,
                chunk: {
                    file_path: relPath,
                    start_line: sr.startLine,
                    end_line: sr.endLine,
                    score: sr.score,
                },
                rawCode: sr.rawCode,
            });
        }

        if (filtered.length === 0) {
            return {
                instance_id: task.instance_id,
                retriever: "nreki",
                retrieved_files: [],
                retrieved_chunks: [],
                latency_ms: Date.now() - startedAt,
                token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                error: "no source chunks indexed or all results were test files",
            };
        }

        // 3. retrieved_chunks (cap to topK) + dedup retrieved_files.
        const topChunks = filtered.slice(0, topK);
        const retrieved_chunks: ChunkResult[] = topChunks.map(f => f.chunk);

        const seenPaths = new Set<string>();
        const retrieved_files: string[] = [];
        // We keep a parallel map of file -> top-scoring SearchResult so
        // tfcCompress can use the strongest match as its focus.
        const fileFocus = new Map<string, { rawCode: string; relPath: string }>();
        for (const f of topChunks) {
            if (!seenPaths.has(f.relPath)) {
                seenPaths.add(f.relPath);
                retrieved_files.push(f.relPath);
                fileFocus.set(f.relPath, { rawCode: f.rawCode, relPath: f.relPath });
            }
        }

        // 4. Foveal compression per unique file. maxCrossFile gates the
        //    Phase 4 cross-file Type Ledger parafovea (Furia round 19 P1).
        const maxCrossFile = engine.isMarkovBlanketEnabled() ? topMaxCrossFile : 0;
        const compressedTexts: string[] = [];
        for (const relPath of retrieved_files) {
            const focusEntry = fileFocus.get(relPath)!;
            const focus = extractFocus(focusEntry.rawCode, relPath);
            const absPath = path.join(repoRoot, relPath);

            let content = "";
            try {
                content = await fs.readFile(absPath, "utf-8");
            } catch {
                // Unreadable file -- fall back to the chunk's rawCode so
                // token_cost still reflects what NREKI surfaced.
                compressedTexts.push(focusEntry.rawCode);
                continue;
            }

            const tfc = await tfcCompress(absPath, content, focus, engine, {
                maxCrossFile,
            });
            if (tfc.kind === "success") {
                compressedTexts.push(tfc.data.compressed);
            } else {
                // shield_tripped or not_found: fall back to raw chunk text
                // (NREKI would have surfaced raw via the fallback path in
                // the production handler too).
                compressedTexts.push(focusEntry.rawCode);
            }
        }

        const token_cost = payloadTokens(compressedTexts);

        return {
            instance_id: task.instance_id,
            retriever: "nreki",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "nreki",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            error: (e as Error).message,
        };
    } finally {
        if (ownsEngine) {
            try {
                engine.shutdown();
            } catch {
                /* best effort -- shutdown races on stale watchers are non-fatal here */
            }
        }
    }
}
