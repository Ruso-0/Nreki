/**
 * scripts/eval-phase5/runners/fast-grep-runner.ts
 *
 * Phase 5 C.3.B: NREKI fast_grep lexical retrieval baseline.
 *
 * fast_grep is NREKI's V8-SIMD substring engine over an
 * AST-aware chunk cache (FastGrepRAMCache). Per chunk it does
 * a single `rawCode.indexOf(query)` and returns hits with file
 * path + symbol name + start line.
 *
 * Flow per task:
 *   keywords = constructQuery(problem_statement)
 *   prepare(workspace) — initialize engine, index dir (one-shot)
 *   for each keyword: aggregate hit count per file
 *   anti-tests filter (consistent with ground-truth.ts MORTAL)
 *   top-K by aggregate score
 *
 * Driver abstraction (FastGrepDriver) lets tests inject a stub
 * instead of spinning up a real NrekiEngine. Default driver
 * uses NrekiEngine with a per-workspace SQLite DB.
 */

import * as path from "node:path";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { constructQuery } from "./query-construction.js";
import { NrekiEngine } from "../../../src/engine.js";
import { payloadTokens } from "../utils/tokenizer.js";
import { readFileChunk } from "../utils/chunks.js";

export const FAST_GREP_DEFAULT_LIMIT = 50;

/**
 * Pluggable backend so tests can inject a fake without spinning
 * up SQLite + Tree-sitter. `query` returns hits for a single keyword.
 */
export interface FastGrepDriver {
    prepare(workspaceRoot: string): Promise<void>;
    query(keyword: string, limit: number): Promise<{ path: string }[]>;
    /** Optional cleanup hook (close DB handles, etc.). */
    dispose?(): Promise<void>;
}

/**
 * Default driver backed by NrekiEngine. The SQLite DB lives inside
 * the workspace (gitignored by NREKI's own ignore patterns), so
 * different concurrent workspaces never collide.
 */
export class NrekiEngineFastGrepDriver implements FastGrepDriver {
    private engine: NrekiEngine | null = null;
    private workspaceRoot: string = "";

    async prepare(workspaceRoot: string): Promise<void> {
        this.workspaceRoot = workspaceRoot;
        this.engine = new NrekiEngine({
            dbPath: path.join(workspaceRoot, ".nreki.db"),
            watchPaths: [workspaceRoot],
        });
        await this.engine.initialize();
        if (!this.engine.hasIndexedFiles()) {
            await this.engine.indexDirectory(workspaceRoot);
        }
    }

    async query(keyword: string, limit: number): Promise<{ path: string }[]> {
        if (!this.engine) throw new Error("FastGrepDriver: prepare() not called");
        const hits = await this.engine.fastGrep(keyword, limit);
        // engine.fastGrep returns absolute paths; normalize to
        // workspace-relative forward-slash paths so anti-tests
        // patterns and ground-truth comparisons line up.
        return hits.map(h => ({
            path: path
                .relative(this.workspaceRoot, h.path)
                .split(path.sep)
                .join("/"),
        }));
    }
}

/**
 * Run NREKI fast_grep retrieval for a single PolyBenchTask.
 *
 * @param task          PolyBenchTask with problem_statement.
 * @param repoRoot      Cloned workspace root (caller is responsible
 *                      for clone @ base_commit).
 * @param topK          Headline cap on returned file count.
 * @param driver        Optional injected driver (tests). Defaults to
 *                      NrekiEngineFastGrepDriver.
 */
export async function runFastGrep(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    driver?: FastGrepDriver,
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const drv = driver ?? new NrekiEngineFastGrepDriver();

    try {
        await drv.prepare(repoRoot);
        const keywords = constructQuery(task.problem_statement);

        const fileScore = new Map<string, number>();
        for (const kw of keywords) {
            if (kw.length < 3) continue; // engine.fastGrep rejects <3
            const hits = await drv.query(kw, FAST_GREP_DEFAULT_LIMIT);
            for (const h of hits) {
                if (isTestFile(h.path)) continue;
                fileScore.set(h.path, (fileScore.get(h.path) ?? 0) + 1);
            }
        }

        const ranked = [...fileScore.entries()].sort((a, b) => b[1] - a[1]);
        const top = ranked.slice(0, topK);
        const retrieved_files = top.map(([f]) => f);

        // File-level chunks: fast_grep returns AST hits internally but
        // the driver interface erases line ranges. Aggregating to whole
        // files keeps the retrofit consistent with BM25/ripgrep and
        // matches Furia round 20's "Archivo completo" case for runners
        // without retained chunk granularity.
        const chunkPayloads = await Promise.all(
            top.map(([f, score]) => readFileChunk(repoRoot, f, score)),
        );
        const retrieved_chunks: ChunkResult[] = chunkPayloads.map(p => p.chunk);
        const token_cost = payloadTokens(chunkPayloads.map(p => p.text));

        return {
            instance_id: task.instance_id,
            retriever: "fast_grep",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "fast_grep",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            error: (e as Error).message,
        };
    } finally {
        if (drv.dispose) {
            try {
                await drv.dispose();
            } catch {
                /* swallow — best effort */
            }
        }
    }
}
