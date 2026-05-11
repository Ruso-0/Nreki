/**
 * scripts/eval-phase5/types-runners.ts
 *
 * Phase 5 C.3 common runner schema. Every retrieval baseline
 * (Voyage-3, fast_grep, ripgrep, BM25, NREKI, Aider) returns the
 * same RetrievalResult shape so the evaluator can aggregate
 * metrics uniformly.
 *
 * C.3.E.1 foundation (Furia rounds 19 #3 + 20):
 *   - ChunkResult universal across runners (paradigm-natural ranges)
 *   - retrieved_chunks + token_cost mandatory (was optional)
 *   - tiktoken cl100k_base as single source of truth for token_cost
 *     (see utils/tokenizer.ts)
 */

export type RetrieverName =
    | "voyage-3"
    | "fast_grep"
    | "ripgrep"
    | "bm25"
    | "nreki"
    | "aider";

/**
 * Universal chunk representation for retrieved_chunks across all
 * runners. Each runner emits chunks per its natural paradigm:
 *   - NREKI: AST nodes with foveal injection ranges
 *   - BM25 / ripgrep (file mode): start=1, end=last_line
 *   - Voyage: sliding-window ranges in original file
 *   - fast_grep: file-level ranges (AST hits aggregated per file)
 *   - Aider: function/class block ranges from repo-map
 */
export interface ChunkResult {
    /** Workspace-relative, forward-slash path. */
    file_path: string;
    /** 1-indexed inclusive line where the chunk starts. */
    start_line: number;
    /** 1-indexed inclusive line where the chunk ends. */
    end_line: number;
    /** Optional retriever-specific score (cosine sim / BM25 score / etc.). */
    score?: number;
}

/**
 * Token consumption for any retriever. Populated by every runner via
 * `payloadTokens(...)` from utils/tokenizer.ts so absolute counts
 * are comparable apples-to-apples across paradigms.
 */
export interface TokenCost {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** Populated when model pricing is known at call time. */
    estimated_usd?: number;
}

/**
 * Universal retrieval result returned by every runner. `retrieved_files`
 * is the headline output (ordered top-K, highest score first).
 * `retrieved_chunks` carries the payload granularity for the
 * paradigm-natural chunking strategy and feeds token_cost.
 */
export interface RetrievalResult {
    instance_id: string;
    retriever: RetrieverName;
    retrieved_files: string[];
    retrieved_chunks: ChunkResult[];
    latency_ms: number;
    token_cost: TokenCost;
    /** Populated when the runner failed mid-task; retrieved_files may be []. */
    error?: string;
}
