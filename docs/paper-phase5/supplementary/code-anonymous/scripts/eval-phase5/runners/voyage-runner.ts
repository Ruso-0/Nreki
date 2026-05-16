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
import { computeTokenCost, payloadTokens } from "../utils/tokenizer.js";
import { logger } from "../../../src/utils/logger.js";
import { lineAtOffset } from "../utils/chunks.js";

export const VOYAGE_MODEL = "voyage-code-3";
export const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
export const DEFAULT_TOP_K = 10;

/**
 * Sentinel prefix used on the RetrievalResult.error field when a task
 * is intentionally excluded from the Voyage subset (Phase 5 C.4.B.1).
 * The orchestrator / reporting layer pattern-matches on this to keep
 * subset SKIPs visually distinct from "VOYAGE_API_KEY missing" or
 * genuine API failures.
 */
export const VOYAGE_SUBSET_SKIP_PREFIX = "Voyage SKIPPED (not in subset)";

/**
 * Furia round 25 stratified Voyage subsampling + Sprint 4 partial state.
 *
 * Original Furia composition: 5 vscode + 12 mui + 3 mixed = N=20
 * Empirical adjustment: Sprint 4 completed 6 vscode tasks before Ctrl+C
 *   (token budget consumed already). Preserving completed data:
 *   6 vscode (ya done) + 0 vscode nuevos + 12 mui + 3 mixed = N=21
 *
 * Auditor decision: +1 vscode over Furia plan acceptable for paper
 * claim integrity (stratification spirit preserved at 6±1).
 *
 * Tasks NOT in this set: runVoyage returns SKIPPED sentinel via
 * RetrievalResult.error. Other runners (NREKI, Aider, BM25,
 * fast_grep, ripgrep) run N=100 normal.
 *
 * Mui task selection is deterministic: all 70 mui instance_ids
 * sorted lexicographically, indices [0, 6, 12, 18, 24, 30, 36, 42,
 * 48, 54, 60, 69] span the era spectrum (PR 11k..42k).
 *
 * Mixed selection picks the lexicographic-first task per remaining
 * repo (deterministic, reproducible).
 */
export const VOYAGE_SUBSET_TASKS: Set<string> = new Set([
    // 6 vscode tasks ALREADY COMPLETED in Sprint 4 (preserve data):
    "microsoft__vscode-106767",
    "microsoft__vscode-108964",
    "microsoft__vscode-109750",
    "microsoft__vscode-110094",
    "microsoft__vscode-113837",
    "microsoft__vscode-122991",

    // 12 mui tasks (alphabetical-sorted indices [0,6,12,18,24,30,36,42,48,54,60,69]):
    "mui__material-ui-11451",
    "mui__material-ui-12968",
    "mui__material-ui-14364",
    "mui__material-ui-15526",
    "mui__material-ui-18257",
    "mui__material-ui-19257",
    "mui__material-ui-20252",
    "mui__material-ui-22696",
    "mui__material-ui-25072",
    "mui__material-ui-26746",
    "mui__material-ui-29023",
    "mui__material-ui-42412",

    // 3 mixed (lexicographic-first per remaining repo):
    "tailwindlabs__tailwindcss-116",
    "coder__code-server-3277",
    "angular__angular-37561",
]);

/** Voyage API item-count cap per request. */
const MAX_BATCH = 128;
/**
 * Voyage per-request token ceiling for voyage-code-3. Observed
 * ~120K hard limit (HTTP 400 above); we keep a 25% safety margin.
 * Mui-class monorepos (4000+ chunks, mixed .js minified bundles)
 * blew past the previous count-only batching with HTTP 400 -- see
 * Phase 5 C.4.B.0a probe.
 */
const MAX_TOKENS_PER_BATCH = 80_000;
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
/**
 * Split `texts` into batches that respect BOTH the item-count cap
 * (MAX_BATCH) and the per-request token ceiling (MAX_TOKENS_PER_BATCH).
 *
 * Tokens are counted once via the cl100k_base singleton -- the same
 * tokenizer used for the universal token_cost metric, so any drift
 * between batching estimate and Voyage's internal count is bounded
 * by tokenizer-family differences (Voyage uses its own BPE; cl100k
 * has been observed ~3-5% off in either direction).
 *
 * Pathological chunks whose own token count exceeds the budget are
 * emitted as singleton batches (server-side truncation may apply --
 * better to surface the chunk than to drop it). A warning is logged
 * so post-hoc analysis can flag minified-bundle pollution.
 *
 * Exported for unit tests.
 */
export function batchChunksByTokens(texts: string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
        const chunkTokens = computeTokenCost(text);

        if (chunkTokens > MAX_TOKENS_PER_BATCH) {
            // Flush whatever we were building first.
            if (current.length > 0) {
                batches.push(current);
                current = [];
                currentTokens = 0;
            }
            // Emit the pathological chunk on its own; surface it to the
            // logs so audits can correlate with minified-bundle paths.
            batches.push([text]);
            logger.warn(
                `[voyage] pathological chunk ${chunkTokens} tokens (> ${MAX_TOKENS_PER_BATCH} budget); emitted as singleton.`,
            );
            continue;
        }

        const wouldExceedTokens = currentTokens + chunkTokens > MAX_TOKENS_PER_BATCH;
        const wouldExceedCount = current.length >= MAX_BATCH;
        if (wouldExceedTokens || wouldExceedCount) {
            batches.push(current);
            current = [text];
            currentTokens = chunkTokens;
            continue;
        }

        current.push(text);
        currentTokens += chunkTokens;
    }

    if (current.length > 0) batches.push(current);
    return batches;
}

export async function voyageEmbed(
    texts: string[],
    inputType: "document" | "query",
    apiKey: string,
): Promise<{ embeddings: number[][]; totalTokens: number }> {
    const embeddings: number[][] = [];
    let totalTokens = 0;

    const batches = batchChunksByTokens(texts);
    for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const response = await embedBatchWithRetry(batch, inputType, apiKey);
        // Voyage returns data with `index` referring to position in batch;
        // sort by index to preserve input order.
        const sorted = [...response.data].sort((a, b) => a.index - b.index);
        for (const item of sorted) {
            embeddings.push(item.embedding);
        }
        totalTokens += response.usage.total_tokens;

        // Inter-batch sleep (skip after the final batch).
        if (bi < batches.length - 1) {
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

    // Phase 5 C.4.B.1 (Furia round 25): stratified Voyage subsampling.
    // Tasks outside VOYAGE_SUBSET_TASKS short-circuit immediately with
    // a distinguishable error sentinel. Wall-clock cost ~0; preserves
    // the apples-to-apples ground truth and metric pipeline so the
    // aggregate report still has a 100-row per-task table.
    if (!VOYAGE_SUBSET_TASKS.has(task.instance_id)) {
        return {
            instance_id: task.instance_id,
            retriever: "voyage-3",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: emptyTokenCost,
            error: `${VOYAGE_SUBSET_SKIP_PREFIX} ${VOYAGE_SUBSET_TASKS.size}`,
        };
    }

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
                // Voyage rejects empty / whitespace-only inputs with HTTP
                // 400 ("Input cannot contain empty strings or empty lists").
                // Empty .js files and pure-comment files surface here as
                // zero-length chunks; skip them so chunkFileIndex /
                // chunkStartLine / chunkEndLine stay aligned with the
                // embedding output array.
                if (p.text.length === 0 || /^\s*$/.test(p.text)) continue;
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
