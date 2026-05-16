/**
 * scripts/eval-phase5/runners/hybrid-runner.ts
 *
 * Sprint 6.3.6: late-fusion RRF runner. This intentionally lives in
 * the evaluation layer, not the NREKI engine. It runs NREKI and BM25
 * independently, fuses their file-level rankings, then reuses the
 * source runner chunks for the winning files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runNREKI } from "./nreki-runner.js";
import { runBM25 } from "./bm25-runner.js";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult, TokenCost } from "../types-runners.js";
import { payloadTokens } from "../utils/tokenizer.js";

const RRF_K = 60;

type RunnerFn = (
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
) => Promise<RetrievalResult>;

export interface HybridOptions {
    nrekiRunner?: RunnerFn;
    bm25Runner?: RunnerFn;
    rrfK?: number;
}

interface RankedFile {
    file: string;
    score: number;
}

function uniqueFiles(files: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        out.push(file);
    }
    return out;
}

function addScores(
    files: string[],
    scores: Map<string, number>,
    rrfK: number,
): void {
    files.forEach((file, idx) => {
        const rank = idx + 1;
        scores.set(file, (scores.get(file) ?? 0) + 1 / (rrfK + rank));
    });
}

export function rrfFuseFiles(
    nrekiFilesInput: string[],
    bm25FilesInput: string[],
    topK: number,
    rrfK: number = RRF_K,
): string[] {
    const nrekiFiles = uniqueFiles(nrekiFilesInput);
    const bm25Files = uniqueFiles(bm25FilesInput);
    const scores = new Map<string, number>();

    addScores(nrekiFiles, scores, rrfK);
    addScores(bm25Files, scores, rrfK);

    const ranked: RankedFile[] = [...scores.entries()].map(([file, score]) => ({
        file,
        score,
    }));

    return ranked
        .sort((a, b) => {
            const scoreDiff = b.score - a.score;
            if (scoreDiff !== 0) return scoreDiff;
            return a.file.localeCompare(b.file);
        })
        .slice(0, topK)
        .map(item => item.file);
}

export function selectHybridChunks(
    fusedFiles: string[],
    nrekiChunks: ChunkResult[],
    bm25Chunks: ChunkResult[],
): ChunkResult[] {
    const out: ChunkResult[] = [];
    for (const file of fusedFiles) {
        const nrekiForFile = nrekiChunks.filter(chunk => chunk.file_path === file);
        if (nrekiForFile.length > 0) {
            out.push(...nrekiForFile);
            continue;
        }
        out.push(...bm25Chunks.filter(chunk => chunk.file_path === file));
    }
    return out;
}

async function readChunkText(repoRoot: string, chunk: ChunkResult): Promise<string> {
    const abs = path.join(repoRoot, chunk.file_path);
    const content = await fs.readFile(abs, "utf-8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(1, chunk.start_line);
    const end = Math.max(start, chunk.end_line);
    return lines.slice(start - 1, end).join("\n");
}

async function tokenCostForChunks(repoRoot: string, chunks: ChunkResult[]): Promise<TokenCost> {
    const parts = await Promise.all(chunks.map(chunk => readChunkText(repoRoot, chunk)));
    return payloadTokens(parts);
}

function mergeErrors(nrekiResult: RetrievalResult, bm25Result: RetrievalResult): string | undefined {
    const errors: string[] = [];
    if (nrekiResult.error) errors.push(`nreki: ${nrekiResult.error}`);
    if (bm25Result.error) errors.push(`bm25: ${bm25Result.error}`);
    return errors.length > 0 ? errors.join("; ") : undefined;
}

export async function runHybrid(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number = 10,
    options: HybridOptions = {},
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const fetchK = topK * 4;
    const nrekiRunner = options.nrekiRunner ?? ((t, root, k) =>
        runNREKI(t, root, k, { enableMarkovBlanket: true }));
    const bm25Runner = options.bm25Runner ?? runBM25;

    try {
        const [nrekiResult, bm25Result] = await Promise.all([
            nrekiRunner(task, repoRoot, fetchK),
            bm25Runner(task, repoRoot, fetchK),
        ]);

        const retrieved_files = rrfFuseFiles(
            nrekiResult.retrieved_files,
            bm25Result.retrieved_files,
            topK,
            options.rrfK ?? RRF_K,
        );
        const retrieved_chunks = selectHybridChunks(
            retrieved_files,
            nrekiResult.retrieved_chunks,
            bm25Result.retrieved_chunks,
        );
        const token_cost = await tokenCostForChunks(repoRoot, retrieved_chunks);
        const error = retrieved_files.length === 0 ? mergeErrors(nrekiResult, bm25Result) : undefined;

        return {
            instance_id: task.instance_id,
            retriever: "hybrid-rrf",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
            ...(error ? { error } : {}),
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "hybrid-rrf",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            error: (e as Error).message,
        };
    }
}
