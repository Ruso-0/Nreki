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
 * Execution modes (C.1.1 split-mode flags, mutually exclusive):
 *   --fetch-only      Stage 1+2 only (fetch + saveRaw), exit 0. Always
 *                     re-fetches even if candidates-raw.json exists.
 *   --force-fetch     Full pipeline, force fresh fetch (overwrites
 *                     existing candidates-raw.json).
 *   (no flag)         Smart default. If candidates-raw.json exists,
 *                     skip Stage 1+2 (no rate-limit burn on resume) and
 *                     run Stage 3+4+5 only. Otherwise full pipeline.
 *   --help / -h       Print usage, exit 0.
 *
 * Resilience: reviewer-harness already persists incremental approvals
 * after each decision (see reviewer-harness.ts header). This file
 * exposes that resilience at orchestrator level — any mode can be
 * resumed safely.
 *
 * Usage:
 *   1. Set GITHUB_TOKEN env var (read scope sufficient).
 *   2. npx tsx scripts/eval-phase5/curate.ts [flag]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBugCandidates, saveBugCandidates } from "./dataset-fetcher.js";
import { reviewBlindly } from "./reviewer-harness.js";
import { computeGroundTruth } from "./ground-truth.js";
import type { BugCandidate, CuratedTask, RepoMetadata } from "./types.js";

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
const RAW_PATH = path.join(DATA_DIR, "candidates-raw.json");
const APPROVED_PATH = path.join(DATA_DIR, "candidates-approved.json");
const FINAL_PATH = path.join(DATA_DIR, "dataset-final.json");

export type Mode =
    | { kind: "full" }
    | { kind: "fetch-only" }
    | { kind: "force-fetch" }
    | { kind: "help" }
    | { kind: "error"; message: string };

const KNOWN_FLAGS = new Set([
    "--fetch-only",
    "--force-fetch",
    "--help",
    "-h",
]);

/**
 * Parse CLI args into an execution Mode. Pure function (no I/O).
 *
 * Rules:
 *   - --help / -h short-circuit (other flags ignored).
 *   - --fetch-only and --force-fetch are mutually exclusive.
 *   - Unknown flags → error.
 *   - No flags → full (smart default).
 */
export function parseArgs(argv: string[]): Mode {
    if (argv.includes("--help") || argv.includes("-h")) {
        return { kind: "help" };
    }

    for (const arg of argv) {
        if (!KNOWN_FLAGS.has(arg)) {
            return { kind: "error", message: `Unknown flag: ${arg}` };
        }
    }

    const fetchOnly = argv.includes("--fetch-only");
    const forceFetch = argv.includes("--force-fetch");

    if (fetchOnly && forceFetch) {
        return {
            kind: "error",
            message: "Conflicting flags: --fetch-only and --force-fetch are mutually exclusive",
        };
    }
    if (fetchOnly) return { kind: "fetch-only" };
    if (forceFetch) return { kind: "force-fetch" };
    return { kind: "full" };
}

const USAGE = `Usage: npx tsx scripts/eval-phase5/curate.ts [flag]

Flags (mutually exclusive):
  --fetch-only      Stage 1+2 only (fetch + saveRaw), then exit.
  --force-fetch     Full pipeline, force fresh fetch (overwrite raw).
  --help, -h        Show this message.

Default (no flag): smart resume. Skips fetch if candidates-raw.json
exists; otherwise runs full pipeline.
`;

async function ensureDataDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function rawExists(): Promise<boolean> {
    try {
        await fs.access(RAW_PATH);
        return true;
    } catch {
        return false;
    }
}

/**
 * Stage 1+2: fetch candidates from each target repo, tag with tier,
 * save consolidated raw JSON. Returns the in-memory array for chaining.
 */
async function runFetchStage(): Promise<BugCandidate[]> {
    const allCandidates: BugCandidate[] = [];
    for (const target of TARGET_REPOS) {
        process.stdout.write(`Fetching candidates from ${target.name}... `);
        const c = await fetchBugCandidates(
            target.name,
            target.cutoff_date,
            target.max_candidates,
        );
        for (const cand of c) {
            (cand as CuratedTask & { tier?: string }).tier = target.tier;
        }
        allCandidates.push(...c);
        process.stdout.write(`${c.length} found\n`);
    }

    await saveBugCandidates(allCandidates, RAW_PATH);
    process.stdout.write(`\nSaved ${allCandidates.length} raw candidates to ${RAW_PATH}\n`);
    return allCandidates;
}

async function loadRawCandidates(): Promise<BugCandidate[]> {
    const txt = await fs.readFile(RAW_PATH, "utf-8");
    return JSON.parse(txt) as BugCandidate[];
}

/**
 * Stage 3+4+5: blind review, compute ground truth on approved, write
 * final dataset.
 */
async function runReviewAndFinalize(candidates: BugCandidate[]): Promise<void> {
    const reviewed = await reviewBlindly(candidates, APPROVED_PATH);

    const finalDataset: CuratedTask[] = reviewed
        .filter(c => c.blind_approved === true)
        .map(c => ({
            ...c,
            ground_truth: computeGroundTruth(c),
        }));

    await fs.writeFile(FINAL_PATH, JSON.stringify(finalDataset, null, 2), "utf-8");

    process.stdout.write("\n");
    process.stdout.write("=".repeat(70) + "\n");
    process.stdout.write(`Final curated dataset: ${finalDataset.length} approved tasks\n`);
    process.stdout.write(`Saved to ${FINAL_PATH}\n`);
    process.stdout.write("=".repeat(70) + "\n");
}

async function main(): Promise<void> {
    const mode = parseArgs(process.argv.slice(2));

    switch (mode.kind) {
        case "help":
            process.stdout.write(USAGE);
            return;

        case "error":
            process.stderr.write(`${mode.message}\n\n${USAGE}`);
            process.exit(1);
            return;

        case "fetch-only": {
            await ensureDataDir();
            await runFetchStage();
            return;
        }

        case "force-fetch": {
            await ensureDataDir();
            const candidates = await runFetchStage();
            await runReviewAndFinalize(candidates);
            return;
        }

        case "full": {
            await ensureDataDir();
            let candidates: BugCandidate[];
            if (await rawExists()) {
                process.stdout.write(
                    `Found existing candidates-raw.json, skipping fetch (use --force-fetch to override)\n`,
                );
                candidates = await loadRawCandidates();
            } else {
                candidates = await runFetchStage();
            }
            await runReviewAndFinalize(candidates);
            return;
        }
    }
}

// Run main() only when invoked directly (npx tsx curate.ts), not when
// imported by tests. Standard ESM "is-main-module" check.
const invokedDirectly =
    process.argv[1] !== undefined &&
    process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    main().catch(e => {
        process.stderr.write(`Curation failed: ${(e as Error).message}\n`);
        process.exit(1);
    });
}

