/**
 * scripts/eval-phase5/ground-truth.ts
 *
 * Phase 5 SWE-Bench-TS-Lite C.1: Ground truth computation with
 * anti-tests filter mortal.
 *
 * Furia round 13 #8 (MORTAL): exclude *.test.ts, *.spec.ts, test/
 * folders from Recall validation. Razón:
 *   PRs de fix incluyen tests añadidos para prevenir regresión.
 *   Recuperar test del FUTURO = trampa temporal (agente NO tiene
 *   tests del futuro al resolver el bug original).
 *
 * Furia round 10 #4: report 3-niveles separados (strict / permissive
 * / maximal). Headline metric (paper abstract) = strict_src.
 */

import type { BugCandidate, GroundTruth } from "./types.js";

/**
 * Patterns identifying test files. Anti-tests filter mortal.
 *
 * Catches:
 *   - foo.test.ts, foo.test.tsx, foo.test.js, foo.test.jsx
 *   - foo.spec.ts/tsx/js/jsx
 *   - top-level test/ or tests/ directory
 *   - any nested /test/, /tests/, /__test__/, /__tests__/ folder
 */
const TEST_PATTERNS: RegExp[] = [
    /\.test\.[tj]sx?$/,
    /\.spec\.[tj]sx?$/,
    /^tests?\//,
    /\/tests?\//,
    /\/__tests?__\//,
];

/**
 * True if filepath matches any test pattern.
 * Pure predicate, deterministic.
 */
export function isTestFile(filepath: string): boolean {
    return TEST_PATTERNS.some(p => p.test(filepath));
}

/**
 * Compute 3-level ground truth from a curated candidate's modified_files.
 *
 *   strict_src  — src/* files only, NO tests (HEADLINE metric per Furia)
 *   permissive  — all non-test files (src + docs + config)
 *   maximal     — all patch files including tests (anexo only, never headline)
 *
 * The anti_tests_filter_applied flag is always true (this function is
 * the canonical implementation of Furia round 13 #8 mortal filter).
 */
export function computeGroundTruth(candidate: BugCandidate): GroundTruth {
    const allFiles = candidate.modified_files;

    // Strict (HEADLINE): src/ ONLY, no tests.
    const strict_src = allFiles.filter(
        f => f.startsWith("src/") && !isTestFile(f),
    );

    // Permissive: any non-test file (src + docs + config).
    const permissive = allFiles.filter(f => !isTestFile(f));

    // Maximal: full patch including tests (audit only, NOT for Recall).
    const maximal = [...allFiles];

    return {
        strict_src,
        permissive,
        maximal,
        anti_tests_filter_applied: true,
    };
}
