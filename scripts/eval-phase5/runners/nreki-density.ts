/**
 * scripts/eval-phase5/runners/nreki-density.ts
 *
 * Phase 5 C.4.B.0c (Furia round 24 latigazo #82): on-the-fly NREKI
 * Type Ledger density measurement. Computed strictly from the
 * already-public NREKI engine API + a workspace walk, so we do NOT
 * touch src/ (NREKI core invariant).
 *
 * Surface:
 *   computeNrekiDensity(repoRoot, engine) -> Promise<NrekiDensity>
 *
 * Method:
 *   1. Walk repoRoot for .ts/.tsx/.js/.jsx files (filtered against the
 *      same noise dirs we exclude everywhere else in Phase 5).
 *   2. Iterate engine.getAllTypeNames(); for each type, union the
 *      chunk_ids returned by getChunksByConsumedType + ByProducedType.
 *      Sum row counts -> edges. Union chunk_ids -> non-isolated chunks.
 *   3. Hydrate chunk_ids -> ChunkRecord via engine.getChunksByIds, map
 *      to distinct file paths, intersect with the .ts/.tsx workspace
 *      set to compute ts_isolated_pct.
 *   4. era_pct_ts_files = TS files / (TS + JS files) in the workspace.
 *
 * Why per-task here vs once-per-run: NREKI re-indexes per task
 * workspace (each PolyBenchTask has its own clone at base_commit),
 * so the Type Ledger is task-specific. The cost is O(types * 2 SQL
 * lookups) + one workspace walk -- negligible vs Voyage/Aider latency.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NrekiEngine } from "../../../src/engine.js";

export interface NrekiDensity {
    ts_files_count: number;
    ts_edges_count: number;
    ts_density: number;
    ts_isolated_pct: number;
    era_pct_ts_files: number;
}

/**
 * Directories we never recurse into during the workspace walk. Mirrors
 * src/engine.ts DEFAULT_IGNORE so density reflects what NREKI would
 * actually index (.git, node_modules, dist, build artifacts).
 */
const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    "__pycache__",
    ".nreki",
]);

interface WorkspaceWalkResult {
    tsFiles: Set<string>;
    jsFiles: Set<string>;
}

/**
 * Walk the workspace and bucket source files by extension. Paths are
 * stored as forward-slash-normalised, workspace-relative strings so
 * they can be intersected with NREKI's path representation (which is
 * also normalised in the runner).
 */
export async function walkWorkspaceSources(
    repoRoot: string,
): Promise<WorkspaceWalkResult> {
    const tsFiles = new Set<string>();
    const jsFiles = new Set<string>();

    async function visit(absDir: string): Promise<void> {
        let entries: import("node:fs").Dirent[];
        try {
            entries = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                await visit(path.join(absDir, e.name));
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") {
                    continue;
                }
                if (e.name.endsWith(".d.ts")) continue;
                const abs = path.join(absDir, e.name);
                const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
                if (ext === ".ts" || ext === ".tsx") tsFiles.add(rel);
                else jsFiles.add(rel);
            }
        }
    }

    await visit(repoRoot);
    return { tsFiles, jsFiles };
}

/**
 * Subset of NrekiEngine surface we actually call. Declared as a structural
 * type so tests can stub it without dragging in the full engine.
 */
export interface DensityEngine {
    getAllTypeNames(): string[];
    getChunksByConsumedType(typeName: string): number[];
    getChunksByProducedType(typeName: string): number[];
    getChunksByIds(ids: number[]): Array<{ path: string }>;
}

/**
 * Compute Type Ledger density for the workspace currently indexed by
 * the supplied engine. The engine MUST have been initialised and
 * `indexDirectory(repoRoot)` already invoked -- this function is a
 * read-only consumer of the resulting state.
 */
export async function computeNrekiDensity(
    repoRoot: string,
    engine: DensityEngine,
): Promise<NrekiDensity> {
    const { tsFiles, jsFiles } = await walkWorkspaceSources(repoRoot);
    const ts_files_count = tsFiles.size;
    const totalSource = tsFiles.size + jsFiles.size;
    const era_pct_ts_files = totalSource > 0 ? tsFiles.size / totalSource : 0;

    let edges = 0;
    const chunkIdsWithEdges = new Set<number>();
    for (const typeName of engine.getAllTypeNames()) {
        const consumes = engine.getChunksByConsumedType(typeName);
        const produces = engine.getChunksByProducedType(typeName);
        edges += consumes.length + produces.length;
        for (const id of consumes) chunkIdsWithEdges.add(id);
        for (const id of produces) chunkIdsWithEdges.add(id);
    }

    // Hydrate edge-bearing chunks to paths, then count distinct TS
    // files that own at least one edge. Files NREKI indexed but
    // which produced zero symbol_io rows count as "isolated" for
    // density purposes.
    const nonIsolatedTsFiles = new Set<string>();
    if (chunkIdsWithEdges.size > 0) {
        const chunks = engine.getChunksByIds([...chunkIdsWithEdges]);
        for (const c of chunks) {
            const rel = path.relative(repoRoot, c.path).split(path.sep).join("/");
            if (tsFiles.has(rel)) nonIsolatedTsFiles.add(rel);
        }
    }

    const ts_density = ts_files_count > 0 ? edges / ts_files_count : 0;
    const isolatedCount = ts_files_count - nonIsolatedTsFiles.size;
    const ts_isolated_pct = ts_files_count > 0 ? isolatedCount / ts_files_count : 0;

    return {
        ts_files_count,
        ts_edges_count: edges,
        ts_density,
        ts_isolated_pct,
        era_pct_ts_files,
    };
}
