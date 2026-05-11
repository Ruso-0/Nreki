/**
 * scripts/eval-phase5/ground-truth.ts
 *
 * Phase 5 SWE-Bench-TS-Lite: Ground truth computation with
 * anti-tests filter mortal, sourced from SWE-PolyBench `patch` field.
 *
 * Furia round 13 #8 (MORTAL): exclude *.test.ts, *.spec.ts, test/
 * folders from Recall validation. Razón:
 *   PRs de fix incluyen tests añadidos para prevenir regresión.
 *   Recuperar test del FUTURO = trampa temporal (agente NO tiene
 *   tests del futuro al resolver el bug original).
 *
 * Furia round 10 #4: report 3-niveles separados (strict / permissive
 * / maximal). Headline metric (paper abstract) = strict_src.
 *
 * Furia round 18: input is PolyBenchTask.patch (unified diff). Files
 * are extracted from `diff --git a/X b/X` headers.
 */

import type { PolyBenchTask, GroundTruth } from "./types.js";

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
 * Extract modified file paths from a unified diff (PolyBench `patch`).
 *
 * Strategy per Furia round 18 spec: regex over `diff --git a/X b/Y`
 * headers, capturing the pre-image path (`a/X`). Deduplicated.
 *
 * Edge cases:
 *   - File renames (a/old.ts b/new.ts) → returns old.ts; the post-image
 *     path is intentionally NOT extracted. Rationale: ground-truth for
 *     bugfix patches almost never contains pure renames, and when it
 *     does, both forms can be present in subsequent hunks. Documented
 *     limitation, accepted.
 *   - Binary patches (e.g. images) → header still parses cleanly.
 *   - Empty patch → returns [].
 */
export function extractModifiedFiles(patch: string): string[] {
    const seen = new Set<string>();
    const re = /^diff --git a\/(.+?) b\//gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(patch)) !== null) {
        seen.add(match[1]);
    }
    return [...seen];
}

/**
 * Compute 3-level ground truth from a PolyBench task's `patch` field.
 *
 *   strict_src  — src/* files only, NO tests (HEADLINE metric per Furia)
 *   permissive  — all non-test files (src + docs + config)
 *   maximal     — all patch files including tests (anexo only, never headline)
 *
 * The anti_tests_filter_applied flag is always true (this function is
 * the canonical implementation of Furia round 13 #8 mortal filter).
 */
export function computeGroundTruth(task: PolyBenchTask): GroundTruth {
    const allFiles = extractModifiedFiles(task.patch);

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
