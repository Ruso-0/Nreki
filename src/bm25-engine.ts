/**
 * src/bm25-engine.ts — Production BM25 lexical retrieval engine.
 *
 * Phase 5.5.2 migration: ported from
 *   scripts/eval-phase5/runners/bm25-runner.ts
 * to production runtime so nreki_navigate action="hybrid_search" can
 * fuse Type Ledger semantic + BM25 lexical via RRF.
 *
 * Standard Okapi BM25 (Robertson/Walker 1994, k1=1.5, b=0.75):
 *   score(D, Q) = Σ IDF(qi) · (f(qi,D)·(k1+1)) /
 *                 (f(qi,D) + k1·(1 - b + b·|D|/avgdl))
 *   IDF(qi)    = ln((N - n(qi) + 0.5) / (n(qi) + 0.5) + 1)
 *
 * Tokenization: code-aware (PascalCase + snake_case + camelCase split,
 * 2-char minimum, no stopword removal — IDF handles common terms).
 *
 * Production differences vs. eval runner:
 *   - Index built lazily on first search() call, cached in-memory
 *     (eval rebuilds per-task).
 *   - File walk uses NREKI's project root + DEFAULT_EXTENSIONS via
 *     constructor params (eval hard-codes .ts/.tsx/.js/.jsx).
 *   - No anti-tests filter by default (eval excludes for ground-truth
 *     alignment; production users may legitimately search tests).
 *   - `invalidate()` method for chokidar wiring (call on file change).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

const CAMEL_SEP = String.fromCharCode(124);

/** Extensions BM25 indexes by default. Mirrors NREKI engine DEFAULT_EXTENSIONS. */
const DEFAULT_SOURCE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".mts", ".cts",
    ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go",
    ".kt", ".kts",
    ".java",
    ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
    ".c", ".h",
]);

/** Directory names excluded during the walk. Mirrors NREKI engine DEFAULT_IGNORE
 * plus benchmark/fixture roots that bloat lexical signal without user value. */
const DEFAULT_EXCLUDED_DIRS = new Set([
    "node_modules", ".git", ".nreki", "dist", "build", "coverage",
    ".next", "__pycache__", "corpus",
]);

export interface BM25DocStats {
    path: string;
    term_freq: Map<string, number>;
    length: number;
}

export interface BM25Index {
    docs: BM25DocStats[];
    avg_doc_length: number;
    doc_freq: Map<string, number>;
    total_docs: number;
}

export interface BM25SearchResult {
    /** Workspace-relative, forward-slash path. */
    path: string;
    /** Raw BM25 score (not normalized; higher = more relevant). */
    score: number;
}

export interface BM25EngineOptions {
    /** Override default source extensions (e.g. for narrow language scope). */
    extensions?: ReadonlySet<string>;
    /**
     * Override default excluded directory names. Use this when your
     * project has a custom build/fixture root (e.g. ".turbo", "vendor").
     * Pattern is exact-name match on directory basename.
     */
    excludedDirs?: ReadonlySet<string>;
    /** k1 saturation parameter. Default 1.5 (Robertson/Walker canonical). */
    k1?: number;
    /** b length-normalization parameter. Default 0.75. */
    b?: number;
}

/**
 * Decompose an identifier-shaped token into subtokens. Returns the
 * original lowercase token plus PascalCase / snake_case parts.
 * Returns [] for tokens shorter than 2 chars.
 */
export function splitIdentifier(token: string): string[] {
    const lower = token.toLowerCase();
    if (lower.length < 2) return [];
    const parts = new Set<string>();
    parts.add(lower);

    for (const piece of lower.split("_")) {
        if (piece.length >= 2) parts.add(piece);
    }

    // PascalCase / camelCase split:
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

/** Tokenize text for BM25 indexing. See module doc for design notes. */
export function tokenizeForBM25(text: string): string[] {
    const out: string[] = [];
    const raw = text.split(/[^a-zA-Z0-9_]+/);
    for (const tok of raw) {
        if (tok.length < 2) continue;
        for (const sub of splitIdentifier(tok)) {
            out.push(sub);
        }
    }
    return out;
}

function buildDocStats(rel: string, content: string): BM25DocStats {
    const tokens = tokenizeForBM25(content);
    const tf = new Map<string, number>();
    for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    return { path: rel, term_freq: tf, length: tokens.length };
}

/**
 * Score a doc against query terms. Repeated query terms accumulate
 * (so ["foo","foo","bar"] weighs foo twice).
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

/** Tokenize a free-text query the same way docs are tokenized. */
export function tokenizeQuery(query: string): string[] {
    return tokenizeForBM25(query);
}

/**
 * Production BM25 retrieval engine. Lazy-builds an in-memory file-level
 * index on first search(); caches until invalidate() is called.
 */
export class BM25Engine {
    private indexCache: BM25Index | null = null;
    private readonly extensions: ReadonlySet<string>;
    private readonly excludedDirs: ReadonlySet<string>;
    private readonly k1: number;
    private readonly b: number;

    constructor(private readonly projectRoot: string, opts: BM25EngineOptions = {}) {
        this.extensions = opts.extensions ?? DEFAULT_SOURCE_EXTENSIONS;
        this.excludedDirs = opts.excludedDirs ?? DEFAULT_EXCLUDED_DIRS;
        this.k1 = opts.k1 ?? BM25_K1;
        this.b = opts.b ?? BM25_B;
    }

    /** Drop the cached index. Call when project files change on disk. */
    invalidate(): void {
        this.indexCache = null;
    }

    /** True if an index has been built and cached. */
    hasIndex(): boolean {
        return this.indexCache !== null;
    }

    /** Number of files in the cached index (0 if not built). */
    indexedFileCount(): number {
        return this.indexCache?.total_docs ?? 0;
    }

    /**
     * Top-K BM25 retrieval. Returns ranked file-level scores
     * (highest first). Empty array if query has no indexable tokens
     * or no doc matches.
     */
    async search(query: string, topK: number = 10): Promise<BM25SearchResult[]> {
        const index = await this.ensureIndex();
        const queryTerms = tokenizeQuery(query);
        if (queryTerms.length === 0) return [];

        const scored: Array<[string, number]> = [];
        for (const doc of index.docs) {
            const s = scoreBM25(doc, queryTerms, index, this.k1, this.b);
            if (s > 0) scored.push([doc.path, s]);
        }
        scored.sort((a, b2) => {
            const d = b2[1] - a[1];
            return d !== 0 ? d : a[0].localeCompare(b2[0]);
        });
        return scored.slice(0, topK).map(([p, score]) => ({ path: p, score }));
    }

    private async ensureIndex(): Promise<BM25Index> {
        if (this.indexCache) return this.indexCache;
        this.indexCache = await this.buildIndex();
        return this.indexCache;
    }

    private async buildIndex(): Promise<BM25Index> {
        const files = await this.walkSourceFiles();
        const docs: BM25DocStats[] = [];
        const docFreq = new Map<string, number>();
        let totalLength = 0;

        for (const rel of files) {
            const abs = path.join(this.projectRoot, rel);
            let content: string;
            try {
                content = await fs.readFile(abs, "utf-8");
            } catch {
                continue;
            }
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

    private async walkSourceFiles(): Promise<string[]> {
        const out: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            let entries: import("node:fs").Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) {
                    // Skip explicit excludes + ANY dot-prefixed directory.
                    // Dot dirs catch .git, .next, .nreki, .venv-*, .cache,
                    // and any tool-specific scratch space without enumeration.
                    if (this.excludedDirs.has(e.name)) continue;
                    if (e.name.startsWith(".")) continue;
                    await walk(abs);
                    continue;
                }
                if (!e.isFile()) continue;
                if (!this.extensions.has(path.extname(e.name).toLowerCase())) continue;
                const rel = path.relative(this.projectRoot, abs).split(path.sep).join("/");
                out.push(rel);
            }
        };
        await walk(this.projectRoot);
        out.sort();
        return out;
    }
}
