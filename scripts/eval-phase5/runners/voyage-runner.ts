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
import type { RetrievalResult, TokenCost } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";

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
    const tokenCost: TokenCost = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
    };

    try {
        // 1. Walk source files.
        const files = await listSourceFiles(repoRoot);
        if (files.length === 0) {
            return {
                instance_id: task.instance_id,
                retriever: "voyage-3",
                retrieved_files: [],
                latency_ms: Date.now() - startedAt,
                token_cost: tokenCost,
                error: "No source files found under repoRoot after anti-tests filter",
            };
        }

        // 2. Read + chunk each file. Track which file each chunk came from.
        const chunkTexts: string[] = [];
        const chunkFileIndex: number[] = []; // index into `files`
        for (let fi = 0; fi < files.length; fi++) {
            const abs = path.join(repoRoot, files[fi]);
            const content = await fs.readFile(abs, "utf-8");
            const chunks = chunkText(content);
            for (const c of chunks) {
                chunkTexts.push(c);
                chunkFileIndex.push(fi);
            }
        }

        // 3. Embed all chunks (documents).
        const docEmbed = await voyageEmbed(chunkTexts, "document", apiKey);
        tokenCost.input_tokens += docEmbed.totalTokens;

        // 4. Embed the query.
        const queryEmbed = await voyageEmbed(
            [task.problem_statement],
            "query",
            apiKey,
        );
        tokenCost.input_tokens += queryEmbed.totalTokens;
        tokenCost.total_tokens = tokenCost.input_tokens + tokenCost.output_tokens;

        // 5. Cosine similarity query vs each chunk.
        const q = queryEmbed.embeddings[0];
        const chunkScores: number[] = docEmbed.embeddings.map(e =>
            cosineSimilarity(q, e),
        );

        // 6. Max-pool per file.
        const fileScore = new Map<number, number>();
        for (let ci = 0; ci < chunkScores.length; ci++) {
            const fi = chunkFileIndex[ci];
            const prev = fileScore.get(fi);
            if (prev === undefined || chunkScores[ci] > prev) {
                fileScore.set(fi, chunkScores[ci]);
            }
        }

        // 7. Sort files by score desc, take top-K.
        const ranked: Array<[string, number]> = [];
        for (const [fi, score] of fileScore) {
            ranked.push([files[fi], score]);
        }
        ranked.sort((a, b) => b[1] - a[1]);
        const retrieved_files = ranked.slice(0, topK).map(([f]) => f);

        return {
            instance_id: task.instance_id,
            retriever: "voyage-3",
            retrieved_files,
            latency_ms: Date.now() - startedAt,
            token_cost: tokenCost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "voyage-3",
            retrieved_files: [],
            latency_ms: Date.now() - startedAt,
            token_cost: tokenCost,
            error: (e as Error).message,
        };
    }
}
