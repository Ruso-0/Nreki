/**
 * handlers/type-graph.ts — Phase 3 nreki_navigate action="type_graph".
 *
 * Pure Type Ledger walker. Pipeline 5-pasos firmado Furia post 3
 * latigazos al auditor:
 *   #38 type_closure naming fraude matemático (K=∞ implied) → "type_graph"
 *   #39 RRF/BM25 cruce de rayos arquitectónico (Layer 2 ↔ 3) → CERO mezcla
 *   #40 TFC-Pro caja negra para chunks heterogéneos → Knapsack manual O(1)
 *
 * No BM25, no RRF, no TFC-Pro, no fallback lexical. Si seed type
 * no existe en symbol_io, return advisory honesto (NOCASE fallback
 * + sugerencia action:"search").
 *
 * Pipeline:
 *   1. Validation (param sanitization + clamp)
 *   2. Seed lookup con NOCASE fallback educando alucinación casing LLM
 *   3. BFS graph walk con visited Set + depth tracking + maxNodes cap
 *   4. Anti-hub ranking via rankByInDegree (Sub-sprint C.2)
 *   5. Knapsack rendering O(1) con relation tags + overflow shorthand
 */

import path from "node:path";
import type { McpToolResponse, NavigateParams, RouterDependencies } from "../router.js";
import { rankByInDegree } from "../search/in-degree.js";
import { estimateTokens } from "../utils/token-estimator.js";

type Relation = "CONSUMES" | "PRODUCES" | "CONSUMES & PRODUCES";

interface Tag {
    relation: Relation;
    relType: string;
}

const DEFAULTS = {
    walkDepth: 1,
    maxNodes: 50,
    direction: "bidirectional" as const,
    tokenBudget: 3000,
};

const LIMITS = {
    walkDepth: { min: 1, max: 2 },
    maxNodes: { min: 1, max: 100 },
    tokenBudget: { min: 0, max: 100_000 },
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function errorResponse(message: string): McpToolResponse {
    return {
        content: [{ type: "text" as const, text: message }],
    };
}

export async function handleTypeGraph(
    params: NavigateParams,
    deps: RouterDependencies,
): Promise<McpToolResponse> {
    const { engine } = deps;
    await engine.initialize();

    if (!engine.hasIndexedFiles()) {
        await engine.indexDirectory(engine.getProjectRoot());
    }

    // ── 1. Validation ─────────────────────────────────────────────
    const seedType = (params.type_name ?? "").trim();
    if (!seedType) {
        return errorResponse(
            `nreki_navigate action:"type_graph" requires param type_name (the seed type).\n` +
            `Example: nreki_navigate action:"type_graph" type_name:"User" walk_depth:1`,
        );
    }
    const walkDepth = clamp(params.walk_depth ?? DEFAULTS.walkDepth, LIMITS.walkDepth.min, LIMITS.walkDepth.max);
    const maxNodes = clamp(params.max_nodes ?? DEFAULTS.maxNodes, LIMITS.maxNodes.min, LIMITS.maxNodes.max);
    const direction: "bidirectional" | "consumers" | "producers" =
        params.direction === "consumers" || params.direction === "producers"
            ? params.direction
            : DEFAULTS.direction;
    const tokenBudget = clamp(params.token_budget ?? DEFAULTS.tokenBudget, LIMITS.tokenBudget.min, LIMITS.tokenBudget.max);

    // ── 2. Seed lookup (with NOCASE fallback) ─────────────────────
    const seedConsumers = direction === "producers" ? [] : engine.getChunksByConsumedType(seedType);
    const seedProducers = direction === "consumers" ? [] : engine.getChunksByProducedType(seedType);

    if (seedConsumers.length === 0 && seedProducers.length === 0) {
        // NOCASE educational fallback
        const allTypes = engine.getAllTypeNames();
        const lower = seedType.toLowerCase();
        const ciMatch = allTypes.find(t => t.toLowerCase() === lower && t !== seedType);
        if (ciMatch) {
            return errorResponse(
                `Type '${seedType}' not found in Type Ledger.\n` +
                `Did you mean '${ciMatch}' (case mismatch)?\n` +
                `Type names are case-sensitive in the symbol_io ledger.`,
            );
        }
        return errorResponse(
            `Type '${seedType}' not found in Type Ledger.\n` +
            `This type has no consumes/produces relations indexed.\n` +
            `For fuzzy lexical lookup try: nreki_navigate action:"search" query:"${seedType}"`,
        );
    }

    // ── 3. BFS walk with visited Set + depth tracking ────────────
    const tags = new Map<number, Tag>();
    const visited = new Set<number>();
    const queue: Array<{ chunkId: number; depth: number }> = [];

    const upgradeRelation = (existing: Relation, incoming: "CONSUMES" | "PRODUCES"): Relation => {
        if (existing === "CONSUMES & PRODUCES") return existing;
        if (existing === incoming) return existing;
        return "CONSUMES & PRODUCES";
    };

    // depth = number of hops taken from seed type to reach this chunk.
    // Seed neighbors are at depth=1 (1 hop). For walk_depth=1, we DO NOT
    // enqueue them (they're already at the depth limit). For walk_depth=2,
    // we enqueue depth=1 chunks for one expansion to depth=2.
    const addNode = (
        chunkId: number,
        relation: "CONSUMES" | "PRODUCES",
        relType: string,
        depth: number,
    ): void => {
        if (visited.has(chunkId)) {
            const existing = tags.get(chunkId);
            if (existing && existing.relType === relType) {
                tags.set(chunkId, {
                    relation: upgradeRelation(existing.relation, relation),
                    relType,
                });
            }
            return;
        }
        if (visited.size >= maxNodes) return;
        visited.add(chunkId);
        tags.set(chunkId, { relation, relType });
        if (depth < walkDepth) queue.push({ chunkId, depth });
    };

    for (const id of seedConsumers) addNode(id, "CONSUMES", seedType, 1);
    for (const id of seedProducers) addNode(id, "PRODUCES", seedType, 1);

    while (queue.length > 0 && visited.size < maxNodes) {
        const { chunkId, depth } = queue.shift()!;
        const nextDepth = depth + 1;
        const io = engine.getSymbolIOByChunkId(chunkId);
        const otherTypes = new Set([...io.consumes, ...io.produces].filter(t => t !== seedType));
        for (const t of otherTypes) {
            if (visited.size >= maxNodes) break;
            if (direction !== "producers") {
                for (const cid of engine.getChunksByConsumedType(t)) {
                    if (visited.size >= maxNodes) break;
                    addNode(cid, "CONSUMES", t, nextDepth);
                }
            }
            if (direction !== "consumers") {
                for (const cid of engine.getChunksByProducedType(t)) {
                    if (visited.size >= maxNodes) break;
                    addNode(cid, "PRODUCES", t, nextDepth);
                }
            }
        }
    }

    // ── 4. Anti-hub ranking ───────────────────────────────────────
    const visitedArr = Array.from(visited);
    const ranked = rankByInDegree(engine, visitedArr);

    // ── 5. Knapsack rendering (manual greedy O(1) per chunk) ─────
    const chunks = engine.getChunksByIds(ranked);
    const chunkMap = new Map(chunks.map(c => [c.id, c]));

    let usedTokens = 0;
    let renderedCount = 0;
    const blocks: string[] = [];
    const overflowShorthands: string[] = [];

    const projectRoot = engine.getProjectRoot();

    for (const id of ranked) {
        const chunk = chunkMap.get(id);
        if (!chunk) continue;
        const tag = tags.get(id);
        if (!tag) continue;
        const tagStr = `[${tag.relation}: ${tag.relType}]`;
        const cleanPath = path.relative(projectRoot, chunk.path).replace(/\\/g, "/");
        const header = `### ${tagStr} ${cleanPath}:L${chunk.start_line}-L${chunk.end_line}`;
        const body = "```\n" + chunk.raw_code + "\n```";
        const block = `${header}\n${body}\n`;
        const tokens = estimateTokens(block, true);

        if (usedTokens + tokens <= tokenBudget) {
            blocks.push(block);
            usedTokens += tokens;
            renderedCount++;
        } else {
            overflowShorthands.push(`- ${tagStr} ${chunk.shorthand} — ${cleanPath}:L${chunk.start_line}`);
        }
    }

    const truncatedCount = overflowShorthands.length;

    // ── Response shape ────────────────────────────────────────────
    const headerJson = {
        seed_type: seedType,
        walk_depth: walkDepth,
        direction,
        max_nodes: maxNodes,
        token_budget: tokenBudget,
        total_visited: visited.size,
        returned_chunks: renderedCount,
        truncated_count: truncatedCount,
        tokens_used: usedTokens,
    };

    let text = "## type_graph result\n\n";
    text += "```json\n" + JSON.stringify(headerJson, null, 2) + "\n```\n\n";

    if (renderedCount === 0 && truncatedCount === 0) {
        text += `No chunks reachable within depth=${walkDepth} for seed='${seedType}'.\n`;
    } else {
        text += blocks.join("\n");
        if (overflowShorthands.length > 0) {
            text += `\n### Truncated by token_budget (${truncatedCount} chunks beyond ${tokenBudget} budget)\n`;
            text += overflowShorthands.join("\n") + "\n";
        }
    }

    return {
        content: [{ type: "text" as const, text }],
    };
}
