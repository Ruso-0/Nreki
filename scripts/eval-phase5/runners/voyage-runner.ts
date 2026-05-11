/**
 * scripts/eval-phase5/runners/voyage-runner.ts
 *
 * Phase 5 C.3.A: Voyage AI dense retrieval baseline.
 *
 * Model: voyage-code-3 (1024-dim embeddings, 32k context window,
 *        specialized for code).
 * Source: https://docs.voyageai.com/docs/embeddings
 * Free tier: 200M tokens/month (verified May 2026).
 *
 * Flow per task:
 *   walk repo  ->  chunk files  ->  embed batches
 *                                       |
 *   problem_statement ----[query embed]--+
 *                                       v
 *               cosine similarity -> max-pool per file -> top-K
 *
 * Anti-tests filter: file walk excludes *.test.*, *.spec.*, /test/,
 * /tests/, /__tests__/ — consistent with ground-truth.ts MORTAL
 * filter (Furia round 13 #8). Reuses isTestFile from ground-truth.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { payloadTokens } from "../utils/tokenizer.js";
import { lineAtOffset } from "../utils/chunks.js";

export const VOYAGE_MODEL = "voyage-code-3";
export const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
export const DEFAULT_TOP_K = 10;

/** Voyage API limit per request. */
const MAX_BATCH = 128;
/** Char-based chunking parameters (simple sliding window, no AST). */
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;
/** Inter-batch sleep to stay below ~300 RPM tier limit. */
const INTER_BATCH_SLEEP_MS = 200;
/** 429 backoff schedule. */
const BACKOFF_SCHEDULE_MS = [2000, 4000, 8000];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

interface VoyageEmbedResponse {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
    usage: { total_tokens: number };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Embed an array of texts via Voyage API in batches of 128.
 *
 * @param texts      Strings to embed (max 32k tokens per text).
 * @param inputType  'document' for code chunks, 'query' for the
 *                   issue problem_statement.
 * @param apiKey     VOYAGE_API_KEY value (caller reads from env).
 *
 * @throws on auth failure (401/403), persistent rate limit
 *         (3 retries on 429), or 5xx after one retry.
 */
export async function voyageEmbed(
    texts: string[],
    inputType: "document" | "query",
    apiKey: string,
): Promise<{ embeddings: number[][]; totalTokens: number }> {
    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        const response = await embedBatchWithRetry(batch, inputType, apiKey);
        // Voyage returns data with `index` referring to position in batch;
        // sort by index to preserve input order.
        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        for (const item of sorted) {
            embeddings.push(item.embedding);
        }
        totalTokens += response.usage.total_tokens;

        // Inter-batch sleep (skip after the final batch).
        if (i + MAX_BATCH < texts.length) {
            await sleep(INTER_BATCH_SLEEP_MS);
        }
    }

    return { embeddings, totalTokens };
}

async function embedBatchWithRetry(
    batch: string[],
    inputType: "document" | "query",
    apiKey: string,
): Promise<VoyageEmbedResponse> {
    let serverRetried = false;
    for (let backoffAttempt = 0; backoffAttempt <= BACKOFF_SCHEDULE_MS.length; backoffAttempt++) {
        const res = await fetch(VOYAGE_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                input: batch,
                model: VOYAGE_MODEL,
                input_type: inputType,
            }),
        });

        if (res.ok) {
            return (await res.json()) as VoyageEmbedResponse;
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error(
                `Voyage API auth failed (HTTP ${res.status}). Check VOYAGE_API_KEY.`,
            );
        }

        if (res.status === 429) {
            if (backoffAttempt < BACKOFF_SCHEDULE_MS.length) {
                await sleep(BACKOFF_SCHEDULE_MS[backoffAttempt]);
                continue;
            }
            throw new Error(
                `Voyage API rate-limited after ${BACKOFF_SCHEDULE_MS.length} retries`,
            );
        }

        if (res.status >= 500 && res.status < 600) {
            if (!serverRetried) {
                serverRetried = true;
                await sleep(1000);
                continue;
            }
            const body = await res.text().catch(() => "");
            throw new Error(`Voyage API server error HTTP ${res.status}: ${body.slice(0, 200)}`);
        }

        // Any other 4xx
        const body = await res.text().catch(() => "");
        throw new Error(`Voyage API error HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    // Unreachable; loop always returns or throws.
    throw new Error("voyageEmbed: exhausted retry loop unexpectedly");
}

/**
 * Cosine similarity over equal-length numeric vectors.
 * Returns 0 when either vector is zero-norm.
 *
 * @throws on dimension mismatch.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(
            `cosineSimilarity dimension mismatch: ${a.length} vs ${b.length}`,
        );
    }
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Recursively list source files (TS/TSX/JS/JSX) under repoRoot,
 * skipping the anti-tests filter pattern and node_modules/.git.
 */
async function listSourceFiles(repoRoot: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git") continue;
                await walk(abs);
                continue;
            }
            if (!e.isFile()) continue;
            const ext = path.extname(e.name).toLowerCase();
            if (!SOURCE_EXTENSIONS.has(ext)) continue;
            if (isTestFile(rel)) continue;
            out.push(rel);
        }
    }
    await walk(repoRoot);
    return out.sort();
}

/**
 * Sliding-window chunk a string into ~CHUNK_SIZE pieces with
 * CHUNK_OVERLAP overlap. Returns the original text as a single
 * chunk when shorter than CHUNK_SIZE.
 */
function chunkText(content: string): string[] {
    if (content.length <= CHUNK_SIZE) return [content];
    const chunks: string[] = [];
    const step = CHUNK_SIZE - CHUNK_OVERLAP;
    for (let i = 0; i < content.length; i += step) {
        const end = Math.min(i + CHUNK_SIZE, content.length);
        chunks.push(content.slice(i, end));
        if (end === content.length) break;
    }
    return chunks;
}

/**
 * Same sliding-window decomposition as chunkText, but emits the
 * character offsets of each chunk so callers can map back to
 * source line ranges for ChunkResult emission.
 */
function chunkTextWithOffsets(
    content: string,
): Array<{ text: string; start_char: number; end_char: number }> {
    if (content.length <= CHUNK_SIZE) {
        return [{ text: content, start_char: 0, end_char: content.length }];
    }
    const out: Array<{ text: string; start_char: number; end_char: number }> = [];
    const step = CHUNK_SIZE - CHUNK_OVERLAP;
    for (let i = 0; i < content.length; i += step) {
        const end = Math.min(i + CHUNK_SIZE, content.length);
        out.push({ text: content.slice(i, end), start_char: i, end_char: end });
        if (end === content.length) break;
    }
    return out;
}

/**
 * Run Voyage dense retrieval for a single PolyBenchTask.
 *
 * Caller is responsible for cloning task.repo at task.base_commit
 * to `repoRoot` beforehand (see repo-cloner.ts). This function
 * does NOT touch the network for git operations — only for the
 * Voyage embedding API.
 *
 * Returns `error` populated and `retrieved_files: []` on mid-task
 * failure, rather than throwing — the evaluator iterates many
 * tasks and a single API blip should not abort the run.
 */
export async function runVoyage(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    apiKey: string,
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const emptyTokenCost = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    try {
        // 1. Walk source files.
        const files = await listSourceFiles(repoRoot);
        if (files.length === 0) {
            return {
                instance_id: task.instance_id,
                retriever: "voyage-3",
                retrieved_files: [],
                retrieved_chunks: [],
                latency_ms: Date.now() - startedAt,
                token_cost: emptyTokenCost,
                error: "No source files found under repoRoot after anti-tests filter",
            };
        }

        // 2. Read + chunk each file. Track file index AND char offsets per chunk
        //    so we can map a winning chunk back to source line ranges.
        const chunkTexts: string[] = [];
        const chunkFileIndex: number[] = [];
        const chunkStartLine: number[] = [];
        const chunkEndLine: number[] = [];
        const fileContents: string[] = new Array(files.length);
        for (let fi = 0; fi < files.length; fi++) {
            const abs = path.join(repoRoot, files[fi]);
            const content = await fs.readFile(abs, "utf-8");
            fileContents[fi] = content;
            const pieces = chunkTextWithOffsets(content);
            for (const p of pieces) {
                chunkTexts.push(p.text);
                chunkFileIndex.push(fi);
                chunkStartLine.push(lineAtOffset(content, p.start_char));
                // end_line is the line containing the LAST character of the
                // chunk (inclusive). For an empty trailing slice this still
                // resolves to a valid line via lineAtOffset's clamping.
                chunkEndLine.push(lineAtOffset(content, Math.max(p.end_char - 1, p.start_char)));
            }
        }

        // 3. Embed all chunks (documents) + query.
        const docEmbed = await voyageEmbed(chunkTexts, "document", apiKey);
        const queryEmbed = await voyageEmbed([task.problem_statement], "query", apiKey);

        // 4. Cosine similarity query vs each chunk.
        const q = queryEmbed.embeddings[0];
        const chunkScores: number[] = docEmbed.embeddings.map(e =>
            cosineSimilarity(q, e),
        );

        // 5. Max-pool per file but remember WHICH chunk won so we can emit
        //    its line range as the file's ChunkResult.
        const bestChunkPerFile = new Map<number, { ci: number; score: number }>();
        for (let ci = 0; ci < chunkScores.length; ci++) {
            const fi = chunkFileIndex[ci];
            const prev = bestChunkPerFile.get(fi);
            if (prev === undefined || chunkScores[ci] > prev.score) {
                bestChunkPerFile.set(fi, { ci, score: chunkScores[ci] });
            }
        }

        // 6. Rank files by their best chunk score, take top-K.
        const ranked: Array<{ fi: number; ci: number; score: number }> = [];
        for (const [fi, info] of bestChunkPerFile) {
            ranked.push({ fi, ci: info.ci, score: info.score });
        }
        ranked.sort((a, b) => b.score - a.score);
        const top = ranked.slice(0, topK);

        const retrieved_files = top.map(t => files[t.fi]);
        const retrieved_chunks: ChunkResult[] = top.map(t => ({
            file_path: files[t.fi],
            start_line: chunkStartLine[t.ci],
            end_line: chunkEndLine[t.ci],
            score: t.score,
        }));

        // 7. Universal token_cost over the chunk texts actually delivered
        //    to the downstream agent. This is the Furia round 20 currency,
        //    not the Voyage API billing -- those are different concepts.
        const token_cost = payloadTokens(top.map(t => chunkTexts[t.ci]));

        return {
            instance_id: task.instance_id,
            retriever: "voyage-3",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "voyage-3",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: emptyTokenCost,
            error: (e as Error).message,
        };
    }
}
