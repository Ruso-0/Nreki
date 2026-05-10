/**
 * scripts/eval-phase5/types.ts
 *
 * Phase 5 SWE-Bench-TS-Lite shared interfaces.
 * Spec firmada UNION rounds 10+11+13 (commit c625345 TECH_DEBT.md).
 */

export interface BugCandidate {
    /** "owner/repo" GitHub coordinate (e.g. "trpc/trpc"). */
    repo: string;
    /** Pull request number. */
    pr_number: number;
    /** PR title (used by blind reviewer). */
    pr_title: string;
    /** Linked issue URL (null si no hay issue). */
    issue_url: string | null;
    /** Issue body — what blind reviewer reads. NEVER include PR diff. */
    issue_text: string | null;
    /** SHA of base commit (PRE-fix). Time-Travel guard target. */
    base_commit: string;
    /** SHA of merge commit (POST-fix). For ground truth diff extraction. */
    merge_commit: string;
    /** Files modified by the PR diff. Used to compute ground truth. */
    modified_files: string[];
    /** Labels applied to the PR (e.g. ["bug", "regression"]). */
    pr_labels: string[];
    /** ISO timestamp of when the candidate was fetched. */
    curated_at: string;
    /** Optional notes from blind reviewer. */
    reviewer_notes?: string;
    /**
     * Blind review verdict: null = not reviewed, true = approved
     * (issue text sufficient for retrieval task), false = rejected.
     */
    blind_approved: boolean | null;
}

/**
 * Three-level ground truth (Furia round 10 #4) with anti-tests
 * filter mortal applied (Furia round 13 #8).
 */
export interface GroundTruth {
    /**
     * STRICT (HEADLINE): src/ files only, NO tests.
     * Anti-tests filter mortal: *.test.ts, *.spec.ts, test/ excluded.
     * This is the metric reported in paper abstract.
     */
    strict_src: string[];
    /**
     * PERMISSIVE: all non-test files (src + docs + config).
     * Reported in anexo, NOT headline.
     */
    permissive: string[];
    /**
     * MAXIMAL: all patch files including tests.
     * Reported in anexo for completeness, NEVER as headline.
     */
    maximal: string[];
    /** Audit flag confirming anti-tests filter was applied. */
    anti_tests_filter_applied: boolean;
}

/**
 * Repository metadata for stratified analysis (Furia round 11 + 13).
 */
export interface RepoMetadata {
    /** "owner/repo" GitHub coordinate. */
    name: string;
    /** Stratification tier per LOC count. */
    tier: "small" | "medium" | "large";
    /**
     * Claude knowledge cutoff date (ISO format).
     * Per Furia round 13 #7: SHA target POST-cutoff per modelo
     * evaluador, documentado per task.
     */
    cutoff_date: string;
    /** Number of commits POST cutoff (audit metric). */
    commits_post_cutoff: number;
}

/**
 * Final dataset row: candidate + computed ground truth.
 * Persisted in scripts/eval-phase5/data/dataset-final.json.
 */
export interface CuratedTask extends BugCandidate {
    ground_truth: GroundTruth;
}
