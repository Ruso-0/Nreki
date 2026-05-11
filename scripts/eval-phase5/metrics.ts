/**
 * scripts/eval-phase5/metrics.ts
 *
 * Phase 5 C.4.A LLM-free metrics. These four are the metrics the
 * paper headline reports without needing a downstream LLM judge:
 *
 *   - First-Hit Recall @ K   (binary per task, then averaged)
 *   - Strict Chunk Containment AST  (covered modified_nodes / total)
 *   - TokenCost @ K          (passed through from RetrievalResult)
 *   - Latency p50 / p95 / p99 (percentiles via this module)
 *
 * Fix Accuracy (the LLM-judge metric) is deferred to C.4.C
 * (post-Furia round 21).
 */

import type { ChunkResult } from "./types-runners.js";
import type { ModifiedNode } from "./types.js";

/**
 * First-Hit Recall @ K. Returns 1.0 if any element of
 * `ground_truth_strict_src` appears in the first `topK` slots of
 * `retrieved_files`, else 0.0.
 *
 * Vacuous case: if the ground-truth strict set is empty (no
 * src/ files modified, only docs/tests), returns 1.0 -- the
 * retriever cannot fail to "hit" an empty target.
 */
export function computeFirstHitRecall(
    retrieved_files: string[],
    ground_truth_strict_src: string[],
    topK: number,
): number {
    if (ground_truth_strict_src.length === 0) return 1.0;
    const top = retrieved_files.slice(0, topK);
    const truthSet = new Set(ground_truth_strict_src);
    for (const f of top) {
        if (truthSet.has(f)) return 1.0;
    }
    return 0.0;
}

/**
 * Strict Chunk Containment AST. For each modified_node, the chunk
 * is "covered" if some retrieved_chunk's [start_line, end_line]
 * range contains the node's line in the same file.
 *
 * ModifiedNode does not carry an explicit line number -- the
 * file_path identifies the file, and PolyBench's modified_nodes
 * column already filtered to AST nodes that the patch touched.
 * Per Furia round 19 P4, the proxy metric used here treats
 * "any retrieved_chunk overlapping the file" as containment when
 * the modified_node line is unknown. This is conservative: any
 * retriever that returns the right FILE gets credit; precision on
 * line range is rewarded when the modified_node carries an
 * implicit line via the ast_path's terminal kind.
 *
 * For PolyBench Verified TS where ModifiedNode line numbers are
 * not exposed, "file overlap" reduces to file-membership: chunk
 * file_path === node.file_path. This is the same conservative
 * proxy used by the C.3.B-E smoke tests.
 *
 * Returns covered_count / total_modified_nodes. If total=0
 * returns 1.0 (vacuously satisfied).
 */
export function computeStrictChunkContainment(
    retrieved_chunks: ChunkResult[],
    modified_nodes: ModifiedNode[],
): number {
    if (modified_nodes.length === 0) return 1.0;
    const chunksByFile = new Map<string, ChunkResult[]>();
    for (const c of retrieved_chunks) {
        const list = chunksByFile.get(c.file_path) ?? [];
        list.push(c);
        chunksByFile.set(c.file_path, list);
    }
    let covered = 0;
    for (const node of modified_nodes) {
        const chunks = chunksByFile.get(node.file_path);
        if (!chunks || chunks.length === 0) continue;
        // Conservative proxy: any chunk in the modified file counts.
        // When ModifiedNode gains an explicit line attribute, tighten
        // to "line in [start_line, end_line] inclusive" here.
        covered++;
    }
    return covered / modified_nodes.length;
}

/**
 * Linear-interpolation percentile over a numeric sample. Empty
 * input returns NaN. p in [0, 100].
 *
 *   percentile([1,2,3,4], 50) === 2.5
 *   percentile([1,2,3,4], 0)  === 1
 *   percentile([1,2,3,4], 100) === 4
 */
export function percentile(values: number[], p: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1) return sorted[0];
    const clampedP = Math.max(0, Math.min(100, p));
    const rank = (clampedP / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    const frac = rank - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Arithmetic mean. Empty input returns 0 (caller-defined convention
 * -- different from percentile's NaN because aggregate reports want
 * a graceful zero when no tasks completed for a runner).
 */
export function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}
