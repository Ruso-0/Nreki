#!/usr/bin/env tsx
/**
 * Sprint 8.0 Phase 2 OFFLINE PILOT — gross_savings tokenization-only.
 *
 * Furia Q5 demanded: "API-key blocker is real for Pass@1 but IRRELEVANT for
 * tokenization math. Do the offline pilot or admit the protocol is theater."
 *
 * What this measures (offline, no API key needed):
 *   gross_savings(t) = tokens(rawCode of GT file containing edit target)
 *                      − tokens(tfcCompress output, focus = GT symbol)
 *
 *   tokens = tiktoken cl100k_base BPE count
 *
 * What this does NOT measure (deferred, needs API + Docker):
 *   reexpansion_cost(t) — requires real agent loop
 *   silent_damage attribution — requires both arms run on same task
 *   Pass@1                  — requires PolyBench test_command (Docker)
 *
 * Why publishable anyway: gross_savings is the CEILING. AHORRO_NETO can
 * only be LOWER than gross_savings. So:
 *   - gross_savings_pct < 0 → AHORRO_NETO < 0 (foveal is fraud)
 *   - gross_savings_pct > 0 → AHORRO_NETO ∈ [some_negative, gross_pct]
 *
 * The 77% Sprint 6.8 number is gross_savings_pct measured against NREKI's
 * own top-K chunks. Sprint 8.0 pilot measures it against the FULL FILE
 * containing the GT edit target — the right baseline for "what an agent
 * would see if it just read the file raw".
 *
 * Pre-registered split (Furia Q4): large-file (>300 LOC) vs small-file.
 *
 * Sample: N = 30 (every 3rd task from the 100). Cap on size to keep the
 * pilot bounded — full N=100 + later integration in Sprint 8.0.1.
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { NrekiEngine } from "../../src/engine.js";
import { tfcCompress } from "../../src/compressor-foveal.js";
import { Tiktoken } from "tiktoken/lite";
import cl100kBase from "tiktoken/encoders/cl100k_base.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const FULL_RESULTS = path.join(ROOT, "results-c4b-full.json");
const CACHE = path.join(ROOT, ".eval-phase5-cache", "task-workspaces");
const OUT_JSONL = path.join(__dirname, "sprint80-offline-pilot.jsonl");
const OUT_MD = path.join(__dirname, "sprint80-offline-pilot.md");

const SAMPLE_STRIDE = 3; // every 3rd task → N ≈ 33
const LARGE_FILE_LOC_THRESHOLD = 300;

const enc = new Tiktoken(
    cl100kBase.bpe_ranks,
    cl100kBase.special_tokens,
    cl100kBase.pat_str,
);

function tokens(s: string): number {
    return enc.encode(s).length;
}

function slugToTaskDir(repo: string, pullNumber: number): string {
    return path.join(CACHE, `task-${repo.replace("/", "-")}-pr${pullNumber}`);
}

function locOf(s: string): number {
    return s.split("\n").length;
}

interface PilotRow {
    instance_id: string;
    repo: string;
    gt_file: string;
    gt_file_loc: number;
    bucket: "large" | "small";
    focus_symbol: string | null;
    tokens_raw_file: number;
    tokens_tfc_compressed: number | null;
    tfc_kind: "success" | "shield_tripped" | "not_found" | "bypassed_small" | "skipped_no_engine";
    gross_savings: number | null;
    gross_savings_pct: number | null;
    error?: string;
}

function pickFocusSymbol(rawCode: string): string | null {
    /**
     * Heuristic focus picker for OFFLINE pilot:
     *   1. Match `export (default )?(function|class|const|interface|type|enum) <Name>`
     *      and pick the FIRST exported declaration. This matches Sprint 6.6
     *      ground_truth.strict_src convention where the patched file's top
     *      export is usually the edit target.
     *   2. Fall back to first `function <Name>(`.
     *   3. If none, return null and skip this task.
     *
     * Honest caveat: this heuristic does NOT use the PolyBench `patch`
     * field to find the exact modified node. A future iteration should
     * parse the patch hunks and pick the symbol whose lines the patch
     * touches. Current heuristic likely picks a similar but not identical
     * symbol — we accept that bias for the offline pilot's gross_savings
     * estimate.
     */
    const exportMatch = rawCode.match(
        /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (exportMatch) return exportMatch[1];
    const funcMatch = rawCode.match(/(?:^|\n)\s*function\s+([A-Za-z_$][\w$]*)/);
    if (funcMatch) return funcMatch[1];
    return null;
}

async function main() {
    const full = JSON.parse(readFileSync(FULL_RESULTS, "utf-8"));
    const tasks: any[] = full.per_task;
    const sorted = [...tasks].sort((a, b) =>
        a.instance_id.localeCompare(b.instance_id));
    const picked = sorted.filter((_, i) => i % SAMPLE_STRIDE === 0);
    console.error(`Offline pilot N = ${picked.length} tasks (stride ${SAMPLE_STRIDE} of ${sorted.length})`);

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sprint80-pilot-"));
    const engine = new NrekiEngine({ dbPath: path.join(tmpDir, "nreki.db") });
    await engine.initialize();

    const rows: PilotRow[] = [];

    for (let i = 0; i < picked.length; i++) {
        const t = picked[i];
        const gts: string[] = t.ground_truth.strict_src ?? [];
        if (gts.length === 0) {
            rows.push({
                instance_id: t.instance_id,
                repo: t.repo,
                gt_file: "",
                gt_file_loc: 0,
                bucket: "small",
                focus_symbol: null,
                tokens_raw_file: 0,
                tokens_tfc_compressed: null,
                tfc_kind: "skipped_no_engine",
                gross_savings: null,
                gross_savings_pct: null,
                error: "no ground_truth.strict_src",
            });
            continue;
        }
        // Pick the LARGEST GT file (the one where compression matters most).
        const pullNumber = parseInt(t.instance_id.split("-").pop()!, 10);
        const workspace = slugToTaskDir(t.repo, pullNumber);

        let chosenGt: { rel: string; abs: string; raw: string; loc: number } | null = null;
        for (const rel of gts) {
            const abs = path.join(workspace, rel);
            if (!existsSync(abs)) continue;
            const raw = readFileSync(abs, "utf-8");
            const loc = locOf(raw);
            if (chosenGt === null || loc > chosenGt.loc) {
                chosenGt = { rel, abs, raw, loc };
            }
        }
        if (chosenGt === null) {
            rows.push({
                instance_id: t.instance_id,
                repo: t.repo,
                gt_file: gts[0],
                gt_file_loc: 0,
                bucket: "small",
                focus_symbol: null,
                tokens_raw_file: 0,
                tokens_tfc_compressed: null,
                tfc_kind: "not_found",
                gross_savings: null,
                gross_savings_pct: null,
                error: `workspace files missing under ${workspace}`,
            });
            continue;
        }

        const bucket: "large" | "small" =
            chosenGt.loc > LARGE_FILE_LOC_THRESHOLD ? "large" : "small";
        const rawTokens = tokens(chosenGt.raw);
        const focus = pickFocusSymbol(chosenGt.raw);

        if (focus === null) {
            rows.push({
                instance_id: t.instance_id,
                repo: t.repo,
                gt_file: chosenGt.rel,
                gt_file_loc: chosenGt.loc,
                bucket,
                focus_symbol: null,
                tokens_raw_file: rawTokens,
                tokens_tfc_compressed: null,
                tfc_kind: "skipped_no_engine",
                gross_savings: null,
                gross_savings_pct: null,
                error: "no exportable focus symbol found",
            });
            continue;
        }

        try {
            const compressResult = await tfcCompress(
                chosenGt.abs,
                chosenGt.raw,
                focus,
                engine,
                { maxCrossFile: 0 },  // pilot ignores cross-file; same in both arms
            );

            if (compressResult.kind === "success") {
                const compTokens = tokens(compressResult.data.compressed);
                const gross = rawTokens - compTokens;
                rows.push({
                    instance_id: t.instance_id, repo: t.repo,
                    gt_file: chosenGt.rel, gt_file_loc: chosenGt.loc, bucket,
                    focus_symbol: focus,
                    tokens_raw_file: rawTokens,
                    tokens_tfc_compressed: compTokens,
                    tfc_kind: "success",
                    gross_savings: gross,
                    gross_savings_pct: rawTokens > 0 ? gross / rawTokens : 0,
                });
            } else if (compressResult.kind === "shield_tripped") {
                rows.push({
                    instance_id: t.instance_id, repo: t.repo,
                    gt_file: chosenGt.rel, gt_file_loc: chosenGt.loc, bucket,
                    focus_symbol: focus,
                    tokens_raw_file: rawTokens,
                    tokens_tfc_compressed: null,
                    tfc_kind: "shield_tripped",
                    gross_savings: 0,
                    gross_savings_pct: 0,
                    error: `density shield 0.85 tripped, ratio=${compressResult.ratio.toFixed(3)}`,
                });
            } else {
                rows.push({
                    instance_id: t.instance_id, repo: t.repo,
                    gt_file: chosenGt.rel, gt_file_loc: chosenGt.loc, bucket,
                    focus_symbol: focus,
                    tokens_raw_file: rawTokens,
                    tokens_tfc_compressed: null,
                    tfc_kind: "not_found",
                    gross_savings: null,
                    gross_savings_pct: null,
                    error: "tfcCompress returned not_found",
                });
            }
        } catch (e) {
            rows.push({
                instance_id: t.instance_id, repo: t.repo,
                gt_file: chosenGt.rel, gt_file_loc: chosenGt.loc, bucket,
                focus_symbol: focus,
                tokens_raw_file: rawTokens,
                tokens_tfc_compressed: null,
                tfc_kind: "skipped_no_engine",
                gross_savings: null,
                gross_savings_pct: null,
                error: `tfcCompress threw: ${(e as Error).message}`,
            });
        }

        if ((i + 1) % 5 === 0) {
            console.error(`  ...${i + 1}/${picked.length}`);
        }
    }

    // Write outputs BEFORE shutdown so a shutdown error never loses data.
    writeFileSync(OUT_JSONL,
        rows.map(r => JSON.stringify(r)).join("\n") + "\n",
        "utf-8");
    console.error(`Wrote ${OUT_JSONL}`);

    // Aggregate
    function summarize(subset: PilotRow[], label: string): string[] {
        const succ = subset.filter(r => r.gross_savings !== null && r.tfc_kind === "success");
        if (succ.length === 0) return [`### ${label}: 0 successful compressions`];
        const pcts = succ.map(r => r.gross_savings_pct!).sort((a, b) => a - b);
        const mean = pcts.reduce((s, x) => s + x, 0) / pcts.length;
        const median = pcts[Math.floor(pcts.length / 2)];
        const p10 = pcts[Math.floor(0.1 * pcts.length)];
        const p90 = pcts[Math.floor(0.9 * pcts.length)];
        const grossAbs = succ.map(r => r.gross_savings!).reduce((s, x) => s + x, 0);
        const rawAbs = succ.map(r => r.tokens_raw_file).reduce((s, x) => s + x, 0);
        const globalPct = rawAbs > 0 ? grossAbs / rawAbs : 0;
        const shieldCount = subset.filter(r => r.tfc_kind === "shield_tripped").length;
        const notFoundCount = subset.filter(r => r.tfc_kind === "not_found").length;
        const skippedCount = subset.filter(r => r.tfc_kind === "skipped_no_engine").length;
        return [
            `### ${label} (N = ${subset.length})`,
            ``,
            `- successful compressions: ${succ.length}`,
            `- density-shield tripped: ${shieldCount}  (TFC fell back to legacy, no usable foveal output)`,
            `- focus not found in file: ${notFoundCount}`,
            `- pilot skipped (no engine / no export): ${skippedCount}`,
            ``,
            `- gross_savings_pct global (Σtokens-weighted): ${(globalPct * 100).toFixed(1)}%`,
            `- gross_savings_pct per-task median: ${(median * 100).toFixed(1)}%`,
            `- gross_savings_pct per-task mean: ${(mean * 100).toFixed(1)}%`,
            `- gross_savings_pct p10 / p90: ${(p10 * 100).toFixed(1)}% / ${(p90 * 100).toFixed(1)}%`,
            ``,
        ];
    }

    const md: string[] = [
        "# Sprint 8.0 Phase 2 — OFFLINE pilot (Furia Q5 mandated)",
        "",
        "**Scope:** offline tokenization-only measurement of `gross_savings(t)` over a stride-3 sample of PolyBench Verified TS (N=33). NO API calls, NO Docker, NO agent loop.",
        "",
        "**Method:** for each task, locate the largest GT file at base_commit. Pick the first `export function|class|const|interface|type|enum` symbol as focus. Call `tfcCompress(file, content, focus, engine, {maxCrossFile:0})`. Count tokens with tiktoken `cl100k_base` (real BPE).",
        "",
        "**What this is NOT:** AHORRO_NETO. Re-expansion cost is not measurable offline. This pilot bounds the CEILING of AHORRO_NETO.",
        "",
        "## Headline (Furia Q4: two-bucket split, never averaged)",
        "",
        ...summarize(rows.filter(r => r.bucket === "large"), "Large-file subset (>300 LOC)"),
        ...summarize(rows.filter(r => r.bucket === "small"), "Small-file subset (≤300 LOC)"),
        "## Honest interpretation",
        "",
        "- These numbers are the GROSS upper bound on AHORRO_NETO. Re-expansion costs only subtract from here, they cannot add.",
        "- The Sprint 6.8 headline (77% global, 78.5% per-task median) was measured against NREKI's own top-K AST chunks. This pilot measures against the FULL FILE the agent would otherwise read raw — a different (typically stricter) baseline.",
        "- If the small-file subset shows negative gross_savings, that means tfcCompress's 100-line bypass is correct: those files are NOT compressed and savings are zero by design. A negative number indicates header overhead vs raw, which would mean the bypass is firing AT THE WRONG threshold.",
        "- The `density_shield_tripped` count is non-zero indicator that on those tasks, foveal compression FAILED to beat 15% improvement and the compressor returned `shield_tripped` (no compression delivered). Production handlers fall back to legacy aggressive in that case, which IS lossy compression but NOT measured here.",
        "",
        "## What remains for Sprint 8.0.1 (NOT measurable here)",
        "",
        "1. `reexpansion_cost(t)` — needs real agent. Requires ANTHROPIC_API_KEY ≥ 30 chars.",
        "2. Silent-damage attribution — needs both arms run on same task with PolyBench test_command. Requires Docker.",
        "3. F2P pass-rate comparison (foveal_on vs foveal_off) — same blockers.",
        "4. Bootstrap CI95 on AHORRO_NETO — needs the above to be measured first.",
        "",
        "## Raw data",
        "",
        `- per-task rows: \`scripts/eval-phase8/sprint80-offline-pilot.jsonl\` (N=${rows.length})`,
        `- methodology: this file's preamble + sprint80-prereg.md`,
        `- tokenizer: tiktoken cl100k_base (offline BPE, no network)`,
    ];

    writeFileSync(OUT_MD, md.join("\n") + "\n", "utf-8");
    console.error(`Wrote ${OUT_MD}`);

    try { await engine.shutdown(); } catch { /* shutdown failures don't invalidate offline pilot results */ }
}

main().catch(e => {
    console.error("Pilot crashed:", (e as Error).stack);
    process.exit(2);
});
