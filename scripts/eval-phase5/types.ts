/**
 * scripts/eval-phase5/types.ts
 *
 * Phase 5 SWE-Bench-TS-Lite shared interfaces.
 *
 * Source-of-truth schema aligned with SWE-PolyBench Verified TS
 * (AmazonScience/SWE-PolyBench_Verified, arXiv:2504.08703, MIT).
 *
 * Spec firmada: TECH_DEBT.md — section "PHASE 5 SEALED — SWE-PolyBench
 * Verified TS (post Furia round 17)" (commit 46bfb52).
 * Schema migration: Furia round 18 (PolyBenchTask sovereign).
 */

/**
 * Parsed AST node from PolyBench `modified_nodes` column.
 *
 * Raw format example:
 *   "src/vs/editor/contrib/suggest/suggestModel.ts->program->
 *    class_declaration:SuggestModel->method_definition:trigger"
 *
 * Parsing strategy: fail-fast at load time with a warning if a segment
 * is malformed, then fall back to `terminal_kind: "unknown"` /
 * `terminal_name: ""` rather than throw — preserves strict typing
 * downstream and lets evaluation continue on best-effort retrieval.
 */
export interface ModifiedNode {
    /** Original PolyBench string, kept verbatim for audit trail. */
    raw_path: string;
    /** First segment before "->" (always a relative file path). */
    file_path: string;
    /** Intermediate segments (zero or more), e.g. ["program", "class_declaration:X"]. */
    ast_path: string[];
    /** Last-segment node kind before ":" (or "unknown" if unparseable). */
    terminal_kind: string;
    /** Last-segment node name after ":" (or "" if absent). */
    terminal_name: string;
}

/**
 * SWE-PolyBench Verified TS task instance.
 * Schema matches the columns of PolyBench `test.csv` that NREKI
 * evaluation consumes. Fields are normalized at load time:
 *   - JSON-encoded arrays (F2P, P2P, issue_numbers) parsed
 *   - `modified_nodes` raw strings parsed into ModifiedNode objects
 */
export interface PolyBenchTask {
    /** "owner/repo" coordinate (e.g. "mui/material-ui"). */
    repo: string;
    /** GitHub PR number (== pull_number in PolyBench). */
    pr_number: number;
    /** Formatted identifier "<owner>__<repo>-<pr_number>". */
    instance_id: string;
    /** 40-char SHA of base commit (PRE-fix). Time-Travel guard target. */
    base_commit: string;
    /** Gold fix patch (unified diff). Ground truth source for modified files. */
    patch: string;
    /** Test-only diff (separate from fix patch). NOT used for Recall. */
    test_patch: string;
    /** Issue title + body — the query the agent sees. */
    problem_statement: string;
    /** AST nodes modified by the patch (tree-sitter resolved at curation). */
    modified_nodes: ModifiedNode[];
    /** Classification assigned by PolyBench annotators. */
    task_category: "Bug Fix" | "Feature" | "Refactoring";
    /** Tests resolved by the PR (fail-before, pass-after). */
    F2P: string[];
    /** Tests that pass before and after PR application. */
    P2P: string[];
    /** Per-instance Dockerfile content for reproducible execution. */
    dockerfile: string;
    /** Shell command to run F2P/P2P inside the Docker container. */
    test_command: string;
    /** Always "TypeScript" for the TS subset; kept explicit for filtering. */
    language: "TypeScript";
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
