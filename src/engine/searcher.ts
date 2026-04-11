/**
 * searcher.ts - T-RAG (Topology-Aware RAG) search pipeline for NREKI (v8.5+).
 *
 * Read side: hybrid search + Tectonic Relevance Scoring.
 * Extracted from engine.ts to enforce Single Responsibility.
 */

import path from "path";
import type { NrekiDB } from "../database.js";
import type { Embedder } from "../embedder.js";
import type { DependencyGraph } from "../repo-map.js";
import type { EngineConfig, SearchResult } from "../engine-types.js";

export class SearchEngine {
    constructor(
        private db: NrekiDB,
        private embedder: Embedder,
        private config: Required<EngineConfig>,
        private getGraphFn: () => Promise<DependencyGraph>,
        private getProjectRootFn: () => string,
        private initCore: () => Promise<void>,
        private initEmbedder: () => Promise<void>,
    ) {}

    async search(query: string, limit: number = 10): Promise<SearchResult[]> {
        // 1. Fetch deep pool (5x limit) to overcome Semantic Dilution
        const fetchLimit = limit * 5;
        let rawResults: import("../database.js").HybridSearchResult[];

        if (!this.config.enableEmbeddings) {
            await this.initCore();
            rawResults = this.db.searchKeywordOnly(query, fetchLimit);
        } else {
            await this.initEmbedder();
            const { embedding } = await this.embedder.embed(query);
            rawResults = this.db.searchHybrid(embedding, query, fetchLimit);
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

        // 4. Apply Tectonic Relevance Scoring + sort
        const scoredResults = this.applyTectonicRelevanceScoring(rawResults, graph, epicenters, projectRoot);
        scoredResults.sort((a, b) => b.score - a.score);
        return scoredResults.slice(0, limit);
    }

    private applyTectonicRelevanceScoring(
        rawResults: import("../database.js").HybridSearchResult[],
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

            let gravity = 1.0;
            if (isTracked && tier) {
                const wTier = tier === "core" ? 0.5 : (tier === "logic" ? 0.2 : 0.0);
                gravity = 1.0 + wTier + (0.15 * Math.log2(1 + inDegree));
            }

            const blastBoost = isBlastRadius ? 1.5 : 1.0;
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
