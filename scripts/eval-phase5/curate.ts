/**
 * scripts/eval-phase5/curate.ts
 *
 * Phase 5 SWE-Bench-TS-Lite C.1: Curation orchestrator.
 *
 * Pipeline:
 *   1. Fetch candidates from GitHub API per target repo (Furia round 11
 *      stratified small/medium/large)
 *   2. Save raw candidates JSON (audit trail)
 *   3. Run blind reviewer harness (Furia round 13 #1, anti-confirmation-bias)
 *   4. Compute ground truth for approved candidates (Furia round 13 #8
 *      anti-tests filter mortal)
 *   5. Save final curated dataset
 *
 * Usage:
 *   1. Set GITHUB_TOKEN env var (read scope sufficient).
 *   2. npx tsx scripts/eval-phase5/curate.ts
 *
 * NOT executed during C.1 commit. Manual step post-commit when reviewer
 * available + GITHUB_TOKEN configured.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fetchBugCandidates, saveBugCandidates } from "./dataset-fetcher.js";
import { reviewBlindly } from "./reviewer-harness.js";
import { computeGroundTruth } from "./ground-truth.js";
import type { CuratedTask, RepoMetadata } from "./types.js";

interface TargetRepo extends RepoMetadata {
    /** Hard cap on raw candidates fetched per repo (pre-review). */
    max_candidates: number;
}

/**
 * Stratified target repos (Furia round 11 + 13).
 * cutoff_date = Claude knowledge cutoff for evaluator model.
 *
 * NOTE: commits_post_cutoff is documented as 0 here (placeholder).
 * Real value populated post-fetch via audit script (out of C.1 scope).
 */
const TARGET_REPOS: TargetRepo[] = [
    {
        name: "date-fns/date-fns",
        tier: "small",
        cutoff_date: "2026-01-31",
        commits_post_cutoff: 0,
        max_candidates: 50,
    },
    {
        name: "trpc/trpc",
        tier: "medium",
        cutoff_date: "2026-01-31",
        commits_post_cutoff: 0,
        max_candidates: 50,
    },
    {
        name: "microsoft/TypeScript",
        tier: "large",
        cutoff_date: "2026-01-31",
        commits_post_cutoff: 0,
        max_candidates: 50,
    },
];

const DATA_DIR = path.join("scripts", "eval-phase5", "data");

async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function main(): Promise<void> {
    await ensureDataDir();

    // ── Stage 1+2: fetch + save raw candidates ────────────────────
    const allCandidates = [];
    for (const target of TARGET_REPOS) {
        process.stdout.write(`Fetching candidates from ${target.name}... `);
        const c = await fetchBugCandidates(
            target.name,
            target.cutoff_date,
            target.max_candidates,
        );
        // Tag each candidate with tier metadata for downstream stratification.
        for (const cand of c) {
            (cand as CuratedTask & { tier?: string }).tier = target.tier;
        }
        allCandidates.push(...c);
        process.stdout.write(`${c.length} found\n`);
    }

    const rawPath = path.join(DATA_DIR, "candidates-raw.json");
    await saveBugCandidates(allCandidates, rawPath);
    process.stdout.write(`\nSaved ${allCandidates.length} raw candidates to ${rawPath}\n`);

    // ── Stage 3: blind review ────────────────────────────────────
    const approvedPath = path.join(DATA_DIR, "candidates-approved.json");
    const reviewed = await reviewBlindly(allCandidates, approvedPath);

    // ── Stage 4+5: compute ground truth + final dataset ──────────
    const finalDataset: CuratedTask[] = reviewed
        .filter(c => c.blind_approved === true)
        .map(c => ({
            ...c,
            ground_truth: computeGroundTruth(c),
        }));

    const finalPath = path.join(DATA_DIR, "dataset-final.json");
    await fs.writeFile(finalPath, JSON.stringify(finalDataset, null, 2), "utf-8");

    process.stdout.write("\n");
    process.stdout.write("=".repeat(70) + "\n");
    process.stdout.write(`Final curated dataset: ${finalDataset.length} approved tasks\n`);
    process.stdout.write(`Saved to ${finalPath}\n`);
    process.stdout.write("=".repeat(70) + "\n");
}

main().catch(e => {
    process.stderr.write(`Curation failed: ${(e as Error).message}\n`);
    process.exit(1);
});
