/**
 * scripts/eval-phase5/types-runners.ts
 *
 * Phase 5 C.3 common runner schema. Every retrieval baseline
 * (Voyage-3, fast_grep, ripgrep, BM25, NREKI, Aider) returns the
 * same RetrievalResult shape so the evaluator can aggregate
 * metrics uniformly.
 */

export type RetrieverName =
    | "voyage-3"
    | "fast_grep"
    | "ripgrep"
    | "bm25"
    | "nreki"
    | "aider";

/**
 * AST-level chunk match. Used when a retriever can resolve to
 * tree-sitter nodes (NREKI). Optional for retrievers that work
 * at file granularity only.
 */
export interface AstChunk {
    file_path: string;
    /** Intermediate AST segments (e.g. ["program", "class_declaration:X"]). */
    ast_path: string[];
    terminal_kind: string;
    terminal_name: string;
    /** Optional confidence/similarity score, retriever-specific. */
    score?: number;
}

/**
 * Token consumption for LLM/embedding API-backed retrievers.
 */
export interface TokenCost {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** Populated when model pricing is known at call time. */
    estimated_usd?: number;
}

/**
 * Universal retrieval result returned by every runner.
 * `retrieved_files` is the headline output (ordered top-K, highest
 * score first). `retrieved_chunks` is populated only by AST-aware
 * retrievers.
 */
export interface RetrievalResult {
    instance_id: string;
    retriever: RetrieverName;
    retrieved_files: string[];
    retrieved_chunks?: AstChunk[];
    latency_ms: number;
    token_cost?: TokenCost;
    /** Populated when the runner failed mid-task; retrieved_files may be []. */
    error?: string;
}
