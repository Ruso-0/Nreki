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
 * Source-path patterns recognised as canonical "src/" locations across
 * simple projects and TypeScript monorepos.
 *
 * Phase 5 C.4.A.5 widening (Furia auditor D1=a):
 *   The original filter `startsWith("src/")` matched only 49 / 333
 *   modified non-test files across PolyBench Verified TS (14.7%),
 *   leaving 71 / 100 tasks with an empty strict_src (vacuous Recall).
 *   The `packages/<scope>/src/` family alone accounts for 167 files
 *   (mui-material, mui-base, mui-system, mui-joy, mui-lab, mui-core,
 *   angular/core, etc.); `src/vs/` adds 34 more for vscode.
 *
 * Maintained as an explicit whitelist (rather than implicit heuristic)
 * for debuggability and easy extension when new monorepo layouts
 * appear in future PolyBench releases. The `<scope>` placeholder is
 * substituted with `[^/]+` (any single path segment) at match time.
 */
export const SOURCE_PATH_PATTERNS: readonly string[] = [
    "src/",                              // simple projects + vscode (src/vs/...)
    "packages/<scope>/src/",             // mui + sibling packages, angular/core, etc.
];

/**
 * Returns true if `filePath` matches any SOURCE_PATH_PATTERN. Used to
 * compute ground_truth.strict_src in a monorepo-aware way.
 *
 * Match semantics:
 *   - Direct prefix match (e.g. `src/...`)
 *   - `<scope>` placeholder substitutes [^/]+ (exactly one segment)
 *
 * Test files are NOT excluded here; callers should compose with
 * `!isTestFile(p)` per Furia round 13 #8.
 */
export function isSourcePath(filePath: string): boolean {
    for (const pattern of SOURCE_PATH_PATTERNS) {
        if (pattern.includes("<scope>")) {
            // Escape regex metachars in the literal parts, then sub
            // <scope> with [^/]+. Anchored to start (^) only.
            const escaped = pattern
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace("<scope>", "[^/]+");
            if (new RegExp("^" + escaped).test(filePath)) return true;
            continue;
        }
        if (filePath.startsWith(pattern)) return true;
    }
    return false;
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

    // Strict (HEADLINE): source-tree files only, no tests.
    // Monorepo-aware as of Phase 5 C.4.A.5 (auditor D1=a): see
    // SOURCE_PATH_PATTERNS + isSourcePath above for the whitelist.
    const strict_src = allFiles.filter(
        f => isSourcePath(f) && !isTestFile(f),
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
