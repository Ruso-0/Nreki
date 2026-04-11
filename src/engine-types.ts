/**
 * engine-types.ts - Shared type definitions for NREKI Engine (v8.5+)
 *
 * Extracted from engine.ts to break circular import topology between
 * the orchestrator and its sub-pipelines (IndexPipeline, SearchEngine).
 */

export interface SearchResult {
    path: string;
    shorthand: string;
    rawCode: string;
    nodeType: string;
    startLine: number;
    endLine: number;
    score: number;
    topology?: {
        tier: "core" | "logic" | "leaf" | "orphan";
        inDegree: number;
        isEpicenter: boolean;
        isBlastRadius: boolean;
        dependents: string[];
    };
}

export interface IndexStats {
    filesIndexed: number;
    totalChunks: number;
    totalRawChars: number;
    totalShorthandChars: number;
    compressionRatio: number;
    watchedPaths: string[];
}

export interface EngineConfig {
    dbPath?: string;
    watchPaths?: string[];
    extensions?: string[];
    ignorePaths?: string[];
    wasmDir?: string;
    enableEmbeddings?: boolean;
}

export interface SessionReport {
    /** Session duration in minutes. */
    durationMinutes: number;
    /** Total tokens saved across all compressions. */
    totalTokensSaved: number;
    /** Total original tokens processed. */
    totalOriginalTokens: number;
    /** Overall compression ratio. */
    overallRatio: number;
    /** USD saved at Sonnet pricing ($3/M input). */
    savedUsdSonnet: number;
    /** USD saved at Opus pricing ($15/M input). */
    savedUsdOpus: number;
    /** Per-file-type breakdown. */
    byFileType: Array<{
        ext: string;
        count: number;
        tokensSaved: number;
        originalTokens: number;
        ratio: number;
    }>;
    /** Number of auto-context injections in this session */
    autoContextInjections: number;
}
