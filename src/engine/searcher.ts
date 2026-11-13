/**
 * searcher.ts - T-RAG (Topology-Aware RAG) search pipeline for NREKI (v8.5+).
 *
 * Read side: BM25, optionally fused with the whole-repository Voyage dense
 * index (BYOK, opt-in; search/vector-index.ts), then calibrated Tectonic
 * Relevance Scoring with per-file diversity.
 * Extracted from engine.ts to enforce Single Responsibility.
 */

import path from "path";
import type { NrekiDB, HybridSearchResult } from "../database.js";
import type { DependencyGraph } from "../repo-map.js";
import type { SearchResult } from "../engine-types.js";
import type { DenseHit, VectorIndex } from "../search/vector-index.js";
import { voyageLogOnce } from "../search/voyage.js";

export { resolveVoyageConfig, type VoyageConfig } from "../search/voyage.js";

/** Reciprocal-rank-fusion constant (Cormack et al.): flattens the head of each ranking. */
const RRF_K = 60;

export class SearchEngine {
    constructor(
        private db: NrekiDB,
        private getGraphFn: () => Promise<DependencyGraph>,
        private getProjectRootFn: () => string,
        private initCore: () => Promise<void>,
        private getVectors: () => VectorIndex | null = () => null,
    ) {}

    async search(query: string, limit: number = 10): Promise<SearchResult[]> {
        // 1. Fetch deep pool (5x limit, min 40) to overcome Semantic Dilution
        const fetchLimit = Math.max(limit * 5, 40);
        await this.initCore();
        let rawResults = this.db.searchKeywordOnly(query, fetchLimit);

        // Opt-in dense recall (NREKI_SEMANTIC=voyage): finds chunks that share no
        // words with the query. Any failure (no vectors yet, offline) keeps BM25.
        const vectors = this.getVectors();
        if (vectors) {
            const dense = await vectors.searchQuery(query, fetchLimit);
            if (dense && dense.length > 0) rawResults = this.fuseDense(rawResults, dense, fetchLimit);
        } else if (process.env.VOYAGE_API_KEY && !process.env.NREKI_SEMANTIC) {
            voyageLogOnce("hint", "info",
                "[NREKI] VOYAGE_API_KEY is set but the Voyage semantic index is OFF. Set NREKI_SEMANTIC=voyage to opt in.");
        }

        if (rawResults.length === 0) return [];

        // 2. Load Topological Graph (cached after first call)
        const graph = await this.getGraphFn();
        const projectRoot = this.getProjectRootFn();

        // 3. Identify Epicenters (Top 3 pure semantic matches)
        const epicenters = new Set<string>();
        for (const r of rawResults.slice(0, 3)) {
            epicenters.add(path.relative(projectRoot, r.path).replace(/\\/g, "/"));
        }

        // 4. Apply Tectonic Relevance Scoring + per-file diversity
        const scoredResults = this.applyTectonicRelevanceScoring(rawResults, graph, epicenters, projectRoot);
        scoredResults.sort((a, b) => b.score - a.score);

        // Per-file diminishing returns so a single large file with many methods
        // does not monopolize the top-K results.
        const fileCounts = new Map<string, number>();
        for (const item of scoredResults) {
            const count = fileCounts.get(item.path) || 0;
            fileCounts.set(item.path, count + 1);
            if (count === 1) item.score *= 0.55;
            else if (count >= 2) item.score *= 0.30;
        }
        scoredResults.sort((a, b) => b.score - a.score);

        return scoredResults.slice(0, limit);
    }

    /**
     * Reciprocal-rank fusion of the BM25 ranking and the dense ranking. The
     * dense ranking gets the same path prior BM25 already carries (src/ up,
     * tests/scripts down) before fusing.
     */
    private fuseDense(bm25: HybridSearchResult[], dense: DenseHit[], limit: number): HybridSearchResult[] {
        const denseRows = this.db.getChunksByIds(dense.map(d => d.id));
        const cosine = new Map(dense.map(d => [d.id, d.score]));
        const denseRanked = denseRows
            .map(c => ({ c, s: (cosine.get(c.id) ?? 0) * this.db.pathBoost(c.path, c.node_type) }))
            .sort((a, b) => b.s - a.s);

        const fused = new Map<number, number>();
        bm25.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
        denseRanked.forEach(({ c }, i) => fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (RRF_K + i + 1)));

        const byId = new Map<number, HybridSearchResult>(bm25.map(r => [r.id, r]));
        for (const { c } of denseRanked) if (!byId.has(c.id)) byId.set(c.id, { ...c, rrf_score: 0 });
        return [...fused.entries()]
            .filter(([id]) => byId.has(id))
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([id, score]) => ({ ...byId.get(id)!, rrf_score: score }));
    }

    private applyTectonicRelevanceScoring(
        rawResults: HybridSearchResult[],
        graph: DependencyGraph,
        epicenters: Set<string>,
        projectRoot: string,
    ): SearchResult[] {
        return rawResults.map(r => {
            const relPath = path.relative(projectRoot, r.path).replace(/\\/g, "/");

            const isTracked = graph.inDegree.has(relPath);
            const tier = graph.tiers.get(relPath);
            const inDegree = graph.inDegree.get(relPath) || 0;

            let isBlastRadius = false;
            for (const epi of epicenters) {
                if (epi !== relPath && graph.importedBy.get(epi)?.has(relPath)) {
                    isBlastRadius = true;
                    break;
                }
            }

            // Calibrated topological tie-breaker: rewards architectural hubs slightly
            // without letting god-object orchestrators override strong lexical matches
            // in focused leaf/utility modules.
            let gravity = 1.0;
            if (isTracked && tier) {
                const wTier = tier === "core" ? 0.12 : (tier === "logic" ? 0.06 : 0.0);
                gravity = 1.0 + wTier + (0.04 * Math.log2(1 + inDegree));
            }

            const blastBoost = isBlastRadius ? 1.03 : 1.0;
            const trs = r.rrf_score * gravity * blastBoost;

            let topDependents: string[] = [];
            if (epicenters.has(relPath) && inDegree > 0) {
                const deps = graph.importedBy.get(relPath);
                if (deps) {
                    topDependents = Array.from(deps)
                        .sort((a, b) => (graph.inDegree.get(b) || 0) - (graph.inDegree.get(a) || 0))
                        .slice(0, 3)
                        .map(d => path.basename(d));
                }
            }

            return {
                path: r.path,
                shorthand: r.shorthand,
                rawCode: r.raw_code,
                nodeType: r.node_type,
                startLine: r.start_line,
                endLine: r.end_line,
                score: trs,
                symbolName: r.symbol_name,
                qualifiedName: r.qualified_name,
                topology: {
                    tier: (tier as "core" | "logic" | "leaf" | "orphan") || "orphan",
                    inDegree,
                    isEpicenter: epicenters.has(relPath),
                    isBlastRadius,
                    dependents: topDependents,
                },
            };
        });
    }
}
