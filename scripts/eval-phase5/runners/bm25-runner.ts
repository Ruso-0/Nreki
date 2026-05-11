/**
 * scripts/eval-phase5/runners/bm25-runner.ts
 *
 * Phase 5 C.3.C: standalone BM25 statistical lexical retrieval.
 *
 * Standard Okapi BM25:
 *   score(D, Q) = sum over qi of:
 *                 IDF(qi) * (f(qi,D)*(k1+1)) /
 *                 (f(qi,D) + k1 * (1 - b + b * |D|/avgdl))
 *   IDF(qi)    = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *
 * Default parameters k1=1.5, b=0.75 -- the canonical Robertson/
 * Walker tuning that has held up across IR benchmarks since 1994.
 * b=0.75 length-normalises so short docs aren't unfairly boosted;
 * k1=1.5 saturates term-frequency, preventing one runaway term
 * from dominating a doc's score.
 *
 * NREKI's internal KeywordIndex is intentionally NOT reused:
 * it carries Porter stemming + a stopword set tuned for the
 * NREKI pipeline and is rowid-tied to SQLite chunks. Comparing
 * NREKI-vs-NREKI in C.3.E would not measure paradigm choice.
 *
 * Custom tokenization (code-aware):
 *   - lowercase
 *   - non-alphanumeric split (slashes, dots, hyphens all separators)
 *   - identifier decomposition: PascalCase + snake_case split
 *     into subtokens; the original lowercase token is kept too
 *     so queries that mention the full identifier still match
 *   - 2-char minimum
 *   - NO stopword removal -- IDF naturally down-weights common words
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { constructQuery } from "./query-construction.js";
import { payloadTokens } from "../utils/tokenizer.js";
import { readFileChunk } from "../utils/chunks.js";

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
export const DEFAULT_TOP_K = 10;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const CAMEL_SEP = String.fromCharCode(124);

export interface BM25DocStats {
    path: string;
    tokens: string[];
    term_freq: Map<string, number>;
    length: number;
}

export interface BM25Index {
    docs: BM25DocStats[];
    avg_doc_length: number;
    doc_freq: Map<string, number>;
    total_docs: number;
}

/**
 * Decompose an identifier-shaped token into subtokens. Returns the
 * original lowercase token plus any CamelCase / snake_case parts.
 * Returns [] for tokens shorter than 2 chars.
 */
function splitIdentifier(token: string): string[] {
    const lower = token.toLowerCase();
    if (lower.length < 2) return [];
    const parts = new Set<string>();
    parts.add(lower);

    for (const piece of lower.split("_")) {
        if (piece.length >= 2) parts.add(piece);
    }

    // PascalCase / camelCase split. Operates on the original-case
    // token: insert a boundary marker before every uppercase that
    // follows a lowercase or another uppercase->lowercase transition,
    // then split on the marker.
    //   "SuggestModel"   -> ["Suggest", "Model"]
    //   "HTTPServer"     -> ["HTTP", "Server"]
    //   "parseURLPath"   -> ["parse", "URL", "Path"]
    const camelBoundary = token
        .replace(/([a-z0-9])([A-Z])/g, `$1${CAMEL_SEP}$2`)
        .replace(/([A-Z]+)([A-Z][a-z])/g, `$1${CAMEL_SEP}$2`)
        .split(CAMEL_SEP);
    for (const piece of camelBoundary) {
        const p = piece.toLowerCase();
        if (p.length >= 2) parts.add(p);
    }

    return [...parts];
}

/**
 * Tokenize text for BM25 indexing. See module doc for design notes.
 */
export function tokenizeForBM25(text: string): string[] {
    const out: string[] = [];
    // Underscore is preserved in this first split so snake_case
    // identifiers survive intact -- splitIdentifier then decomposes
    // them into subtokens *and* keeps the original (e.g.
    // "parse_modified_nodes" -> both the full id and ["parse","modified","nodes"]).
    const raw = text.split(/[^a-zA-Z0-9_]+/);
    for (const tok of raw) {
        if (tok.length < 2) continue;
        for (const sub of splitIdentifier(tok)) {
            out.push(sub);
        }
    }
    return out;
}

async function walkSourceFiles(workspaceRoot: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            const rel = path.relative(workspaceRoot, abs).split(path.sep).join("/");
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name === ".git") continue;
                await walk(abs);
                continue;
            }
            if (!e.isFile()) continue;
            if (!SOURCE_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
            if (isTestFile(rel)) continue;
            out.push(rel);
        }
    }
    await walk(workspaceRoot);
    return out.sort();
}

async function readFileAsText(absPath: string): Promise<string> {
    try {
        return await fs.readFile(absPath, "utf-8");
    } catch {
        return "";
    }
}

function buildDocStats(rel: string, content: string): BM25DocStats {
    const tokens = tokenizeForBM25(content);
    const tf = new Map<string, number>();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    return { path: rel, tokens, term_freq: tf, length: tokens.length };
}

/**
 * Build an in-memory BM25 index over a workspace. Anti-tests filter
 * applied at walk time -- excluded files are never indexed.
 */
export async function buildBM25Index(workspaceRoot: string): Promise<BM25Index> {
    const files = await walkSourceFiles(workspaceRoot);
    const docs: BM25DocStats[] = [];
    const docFreq = new Map<string, number>();
    let totalLength = 0;

    for (const rel of files) {
        const content = await readFileAsText(path.join(workspaceRoot, rel));
        const stats = buildDocStats(rel, content);
        docs.push(stats);
        totalLength += stats.length;
        for (const term of stats.term_freq.keys()) {
            docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
        }
    }

    return {
        docs,
        avg_doc_length: docs.length > 0 ? totalLength / docs.length : 0,
        doc_freq: docFreq,
        total_docs: docs.length,
    };
}

/**
 * Score a doc against query terms. Repeated query terms accumulate
 * (so queries like ["foo","foo","bar"] weigh foo twice).
 */
export function scoreBM25(
    doc: BM25DocStats,
    queryTerms: string[],
    index: BM25Index,
    k1: number = BM25_K1,
    b: number = BM25_B,
): number {
    if (index.total_docs === 0 || index.avg_doc_length === 0) return 0;
    let score = 0;
    const avgdl = index.avg_doc_length;
    const N = index.total_docs;

    for (const qi of queryTerms) {
        const tf = doc.term_freq.get(qi);
        if (tf === undefined) continue;
        const df = index.doc_freq.get(qi) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        const denom = tf + k1 * (1 - b + b * (doc.length / avgdl));
        const tfPart = (tf * (k1 + 1)) / denom;
        score += idf * tfPart;
    }
    return score;
}

/**
 * Tokenize a list of query keywords (from constructQuery) the same
 * way docs are tokenized, so identifier subtokens line up. Dedups
 * preserving order isn't needed -- BM25 sums per term, repeats are
 * meaningful (already weighted via tf).
 */
function expandQueryTerms(keywords: string[]): string[] {
    const out: string[] = [];
    for (const k of keywords) {
        for (const t of tokenizeForBM25(k)) {
            out.push(t);
        }
    }
    return out;
}

/**
 * Run BM25 retrieval for a single PolyBenchTask. Anti-tests filter
 * applied at index time (defensive re-filter at retrieval -- see
 * Furia round 13 #8 -- also catches any case-sensitivity drift).
 */
export async function runBM25(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    k1: number = BM25_K1,
    b: number = BM25_B,
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    try {
        const keywords = constructQuery(task.problem_statement);
        const queryTerms = expandQueryTerms(keywords);
        const index = await buildBM25Index(repoRoot);

        const scored: Array<[string, number]> = [];
        for (const doc of index.docs) {
            if (isTestFile(doc.path)) continue;
            const s = scoreBM25(doc, queryTerms, index, k1, b);
            if (s > 0) scored.push([doc.path, s]);
        }
        scored.sort((a, b2) => b2[1] - a[1]);
        const top = scored.slice(0, topK);
        const retrieved_files = top.map(([f]) => f);

        // File-level chunks (Furia round 20: BM25 = full file). This is
        // the deliberate token-cost ceiling that exposes the Pareto
        // frontier vs. AST-granular retrievers.
        const chunkPayloads = await Promise.all(
            top.map(([f, score]) => readFileChunk(repoRoot, f, score)),
        );
        const retrieved_chunks: ChunkResult[] = chunkPayloads.map(p => p.chunk);
        const token_cost = payloadTokens(chunkPayloads.map(p => p.text));

        return {
            instance_id: task.instance_id,
            retriever: "bm25",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "bm25",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            error: (e as Error).message,
        };
    }
}
