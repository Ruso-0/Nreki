/**
 * compressor-foveal-cross-file.ts — Phase 4 Markov Blanket Foveal cross-file injection.
 *
 * Surgical extension to compressor-foveal.ts (TFC-Ultra). Adds CROSS-FILE
 * parafovea via Type Ledger queries. Single-file parafovea continues handled
 * by extractCausalRefs regex (orthogonal layer).
 *
 * Spec firmada Furia round 12:
 *   - K=1 strict (walk_depth máximo 1, K=2 RECHAZADO)
 *   - max_cross_file=10 hard cap pre-truncate
 *   - Anti-hub via rankByInDegree (Sub-sprint C.2)
 *   - Filter same-file (single-file ya cubierto regex existente)
 *   - Defensive ignore on DB lookup fail (FAIL-OPEN, Furia #7)
 *   - cleanSignature render pure (NO TFC-Pro recursive call, latigazo #40)
 *
 * @license Proprietary — @ruso-0/nreki-turbo
 */

import { rankByInDegree } from "./search/in-degree.js";
import { cleanSignature } from "./utils/imports.js";
import type { NrekiEngine } from "./engine.js";

export interface CrossFileChunk {
    chunkId: number;
    path: string;
    symbolName: string;
    shorthand: string;
    relation: "upstream" | "downstream";
    seedType: string;
}

export interface CrossFileFovea {
    path: string;
    symbolName: string;
}

/**
 * Extract cross-file parafovea via Type Ledger.
 *
 * For each fovea:
 *   1. Lookup chunkId via getChunkIdByPathAndSymbol (fail-open if null).
 *   2. getSymbolIOByChunkId → {consumes, produces}.
 *   3. Upstream = chunks consuming fovea-produced types (cross-file only).
 *   4. Downstream = chunks producing fovea-consumed types (cross-file only).
 *   5. Anti-hub rank unique chunk_ids by inDegree.
 *   6. Truncate UNIQUE chunks to maxCrossFile cap.
 *   7. Return all relation entries for those unique chunks.
 */
export function extractTypeLedgerParafovea(
    foveas: CrossFileFovea[],
    engine: NrekiEngine,
    maxCrossFile: number = 10,
): CrossFileChunk[] {
    if (foveas.length === 0 || maxCrossFile === 0) return [];

    // Foveas paths set: filter chunks in same file as ANY fovea.
    const foveaPaths = new Set(foveas.map(f => f.path));

    // Collect (chunkId, relation, seedType) tuples per fovea.
    const collected: Array<{
        chunkId: number;
        relation: "upstream" | "downstream";
        seedType: string;
    }> = [];

    for (const fovea of foveas) {
        const foveaChunkId = engine.getChunkIdByPathAndSymbol(fovea.path, fovea.symbolName);
        if (foveaChunkId === null) continue; // Furia #7 fail-open

        const io = engine.getSymbolIOByChunkId(foveaChunkId);

        // Upstream: chunks consuming what this fovea produces.
        for (const producedType of io.produces) {
            for (const consumerId of engine.getChunksByConsumedType(producedType)) {
                if (consumerId === foveaChunkId) continue;
                collected.push({ chunkId: consumerId, relation: "upstream", seedType: producedType });
            }
        }

        // Downstream: chunks producing what this fovea consumes.
        for (const consumedType of io.consumes) {
            for (const producerId of engine.getChunksByProducedType(consumedType)) {
                if (producerId === foveaChunkId) continue;
                collected.push({ chunkId: producerId, relation: "downstream", seedType: consumedType });
            }
        }
    }

    if (collected.length === 0) return [];

    // Hydrate unique chunk_ids → ChunkRecord[] (need path to filter same-file).
    const uniqueIds = Array.from(new Set(collected.map(c => c.chunkId)));
    const records = engine.getChunksByIds(uniqueIds);
    const recordById = new Map(records.map(r => [r.id, r]));

    // Filter same-file (single-file ya cubierto por regex existente).
    const crossFileIds = uniqueIds.filter(id => {
        const r = recordById.get(id);
        return r !== undefined && !foveaPaths.has(r.path);
    });

    if (crossFileIds.length === 0) return [];

    // Anti-hub: rank unique cross-file ids by inDegree DESC.
    const ranked = rankByInDegree(engine, crossFileIds);

    // Truncate UNIQUE chunks to maxCrossFile (each unique chunk counts once
    // toward budget regardless of how many relations it has).
    const topIds = new Set(ranked.slice(0, maxCrossFile));

    // Materialize CrossFileChunk[] preserving all relation entries for
    // top chunks. Order: ranked-desc, with relations grouped per chunk.
    const result: CrossFileChunk[] = [];
    for (const chunkId of ranked) {
        if (!topIds.has(chunkId)) continue;
        const record = recordById.get(chunkId);
        if (!record) continue;
        for (const c of collected) {
            if (c.chunkId !== chunkId) continue;
            result.push({
                chunkId,
                path: record.path,
                symbolName: record.symbol_name,
                shorthand: record.shorthand,
                relation: c.relation,
                seedType: c.seedType,
            });
        }
    }

    return result;
}

/**
 * Compute total collected count (pre-truncation) for advisory message.
 * Returns the UNIQUE cross-file chunk count BEFORE maxCrossFile cap applied.
 *
 * Used to surface to agent how many cross-file relations were omitted.
 */
export function countTotalCrossFileBeforeTruncation(
    foveas: CrossFileFovea[],
    engine: NrekiEngine,
): number {
    if (foveas.length === 0) return 0;
    const foveaPaths = new Set(foveas.map(f => f.path));
    const allIds = new Set<number>();

    for (const fovea of foveas) {
        const foveaChunkId = engine.getChunkIdByPathAndSymbol(fovea.path, fovea.symbolName);
        if (foveaChunkId === null) continue;
        const io = engine.getSymbolIOByChunkId(foveaChunkId);
        for (const t of io.produces) {
            for (const id of engine.getChunksByConsumedType(t)) {
                if (id !== foveaChunkId) allIds.add(id);
            }
        }
        for (const t of io.consumes) {
            for (const id of engine.getChunksByProducedType(t)) {
                if (id !== foveaChunkId) allIds.add(id);
            }
        }
    }

    if (allIds.size === 0) return 0;

    const records = engine.getChunksByIds(Array.from(allIds));
    return records.filter(r => !foveaPaths.has(r.path)).length;
}

// ─── Render functions (Furia #3 cleanSignature pure) ───────────────────

/**
 * Render upstream cross-file chunks (consumers of fovea-produced types).
 * Format: `// [UPSTREAM]: relPath::symbolName` per line.
 * Empty input → empty string (caller decides whether to emit header).
 */
export function renderCrossFileUpstream(
    chunks: CrossFileChunk[],
    relPath?: (path: string) => string,
): string {
    const upstream = chunks.filter(c => c.relation === "upstream");
    if (upstream.length === 0) return "";

    // Dedup by (path, symbolName) — same chunk via multiple types appears once.
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of upstream) {
        const display = relPath ? relPath(c.path) : c.path;
        const key = `${display}::${c.symbolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`// [UPSTREAM]: ${key}`);
    }

    return [
        "// ─── UPSTREAM CROSS-FILE (Type Ledger consumers) ───",
        ...lines,
    ].join("\n");
}

/**
 * Render downstream cross-file chunks (producers of fovea-consumed types).
 * Format: `// [DOWNSTREAM relPath::symbolName]: <cleanSignature>`.
 * Empty input → empty string.
 */
export function renderCrossFileDownstream(
    chunks: CrossFileChunk[],
    relPath?: (path: string) => string,
): string {
    const downstream = chunks.filter(c => c.relation === "downstream");
    if (downstream.length === 0) return "";

    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of downstream) {
        const display = relPath ? relPath(c.path) : c.path;
        const key = `${display}::${c.symbolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sig = cleanSignature(c.shorthand);
        lines.push(`// [DOWNSTREAM ${key}]: ${sig}`);
    }

    return [
        "// ─── DOWNSTREAM CROSS-FILE (Type Ledger producers) ───",
        ...lines,
    ].join("\n");
}

/**
 * Render advisory line when truncation occurred. Empty if no truncation.
 */
export function renderTruncationAdvisory(totalCollected: number, shown: number): string {
    if (totalCollected <= shown) return "";
    const omitted = totalCollected - shown;
    return `// ... and ${omitted} more cross-file relations omitted`;
}

/**
 * Estimate bytes contributed by cross-file render block.
 * Used by Density Shield exemption (Furia #50): cross-file bytes are
 * EXCLUDED from compressedSize when computing the shield ratio.
 */
export function computeCrossFileBytes(
    upstream: string,
    downstream: string,
    advisory: string,
): number {
    let total = 0;
    if (upstream) total += upstream.length + 1; // + newline
    if (downstream) total += downstream.length + 1;
    if (advisory) total += advisory.length + 1;
    return total;
}
