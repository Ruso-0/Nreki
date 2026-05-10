/**
 * In-degree calculator over the symbol_io Type Ledger graph.
 *
 * Used by Phase 3 nreki_navigate action="type_graph" anti-hub
 * ordering: before applying maxNodes LIMIT, sort candidate chunks
 * by GLOBAL authority score (chunks whose produced types are
 * referenced by many other chunks). Determinismo + surface
 * arquitectónicamente weight chunks first.
 *
 * Decision rationale (auditor C.2 sign-off): inDegree puro instead
 * of PageRank. K=1 default walks produce small slices (≤50 chunks);
 * recursive damping factor propagation is over-engineering. Future
 * upgrade to PageRank if K=2+ usage shows ranking degradation.
 *
 * Pure function over symbol_io. Deterministic. O(N × avgProduces ×
 * avgConsumersPerType) — bounded by maxNodes spec.
 */

/**
 * Minimal type ledger query surface required by inDegree scoring.
 * Both NrekiDB (direct) and NrekiEngine (facade) satisfy this
 * structurally — handler code passes the engine, tests pass the db.
 */
export interface TypeLedgerSource {
    getSymbolIOByChunkId(chunkId: number): { consumes: string[]; produces: string[] };
    getChunksByConsumedType(typeName: string): number[];
}

/**
 * Compute in-degree per chunk in the given subset.
 *
 * inDegree(chunk) = count of OTHER distinct chunks that consume any
 * type this chunk produces. Self-references excluded. Multiple paths
 * via overlapping types counted once per consumer chunk.
 *
 * Counting scope: GLOBAL graph (all chunks in symbol_io), not just
 * the subset. This measures architectural importance across the
 * entire codebase, which is what "anti-hub ordering" requires.
 *
 * @param db        Type ledger source with symbol_io queries.
 * @param subset    Chunk IDs to score. Empty input → empty map.
 * @returns         Map<chunkId, inDegree>. Every input id appears
 *                  in result (with value 0 if no produces or no
 *                  consumers exist globally).
 */
export function computeInDegrees(
    db: TypeLedgerSource,
    subset: number[],
): Map<number, number> {
    const result = new Map<number, number>();
    if (subset.length === 0) return result;
    for (const chunkId of subset) {
        const { produces } = db.getSymbolIOByChunkId(chunkId);
        if (produces.length === 0) {
            result.set(chunkId, 0);
            continue;
        }
        const consumers = new Set<number>();
        for (const typeName of produces) {
            for (const consumerId of db.getChunksByConsumedType(typeName)) {
                if (consumerId !== chunkId) consumers.add(consumerId);
            }
        }
        result.set(chunkId, consumers.size);
    }
    return result;
}

/**
 * Convenience wrapper: returns subset sorted by inDegree DESC, with
 * stable tiebreaker by ascending chunk_id (deterministic across runs).
 */
export function rankByInDegree(
    db: TypeLedgerSource,
    subset: number[],
): number[] {
    const scores = computeInDegrees(db, subset);
    return subset.slice().sort((a, b) => {
        const sa = scores.get(a) ?? 0;
        const sb = scores.get(b) ?? 0;
        if (sb !== sa) return sb - sa;
        return a - b;
    });
}
