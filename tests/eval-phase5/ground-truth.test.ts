/**
 * Phase 5 ground-truth + anti-tests filter mortal tests.
 * Furia round 13 #8: tests del FUTURO = trampa temporal.
 * Furia round 18: schema migrated to PolyBenchTask (patch-derived
 * modified files).
 */

import { describe, it, expect } from "vitest";
import {
    isTestFile,
    computeGroundTruth,
    extractModifiedFiles,
} from "../../scripts/eval-phase5/ground-truth.js";
import type { PolyBenchTask } from "../../scripts/eval-phase5/types.js";

/**
 * Build a minimal unified-diff patch that mentions each file in
 * `files` exactly once. Sufficient for ground-truth extraction tests
 * since `extractModifiedFiles` only inspects `diff --git a/X b/Y`
 * headers.
 */
function buildPatch(files: string[]): string {
    return files
        .map(
            f =>
                `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`,
        )
        .join("");
}

function mkTask(files: string[]): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "a",
        patch: buildPatch(files),
        test_patch: "",
        problem_statement: "fixture",
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
    };
}

describe("Phase 5: isTestFile (anti-tests filter mortal)", () => {
    it("detects *.test.ts", () => {
        expect(isTestFile("src/foo.test.ts")).toBe(true);
        expect(isTestFile("packages/lib/x.test.tsx")).toBe(true);
        expect(isTestFile("y.test.js")).toBe(true);
        expect(isTestFile("z.test.jsx")).toBe(true);
    });

    it("detects *.spec.ts", () => {
        expect(isTestFile("src/parser.spec.ts")).toBe(true);
        expect(isTestFile("a.spec.tsx")).toBe(true);
        expect(isTestFile("b.spec.js")).toBe(true);
    });

    it("detects top-level test/ folder", () => {
        expect(isTestFile("test/integration.ts")).toBe(true);
        expect(isTestFile("tests/e2e.ts")).toBe(true);
    });

    it("detects nested /test/ and /tests/ folders", () => {
        expect(isTestFile("packages/foo/test/x.ts")).toBe(true);
        expect(isTestFile("src/lib/tests/y.ts")).toBe(true);
    });

    it("detects __test__ and __tests__ folders", () => {
        expect(isTestFile("src/__test__/x.ts")).toBe(true);
        expect(isTestFile("src/__tests__/y.ts")).toBe(true);
    });

    it("does NOT match src/ production files", () => {
        expect(isTestFile("src/index.ts")).toBe(false);
        expect(isTestFile("src/handlers/code.ts")).toBe(false);
        expect(isTestFile("src/utils/parser.ts")).toBe(false);
        expect(isTestFile("packages/core/index.ts")).toBe(false);
    });

    it("does NOT match docs/config files", () => {
        expect(isTestFile("README.md")).toBe(false);
        expect(isTestFile("package.json")).toBe(false);
        expect(isTestFile("docs/guide.md")).toBe(false);
    });
});

describe("Phase 5: extractModifiedFiles (patch parser)", () => {
    it("extracts paths from diff --git headers", () => {
        const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-x
+y
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1 +1 @@
-x
+y
`;
        expect(extractModifiedFiles(patch).sort()).toEqual([
            "src/bar.ts",
            "src/foo.ts",
        ]);
    });

    it("returns [] for empty patch", () => {
        expect(extractModifiedFiles("")).toEqual([]);
    });

    it("deduplicates files mentioned in multiple hunks", () => {
        const patch = `diff --git a/src/foo.ts b/src/foo.ts
@@ -1 +1 @@
diff --git a/src/foo.ts b/src/foo.ts
@@ -10 +10 @@
`;
        expect(extractModifiedFiles(patch)).toEqual(["src/foo.ts"]);
    });

    it("captures pre-image path for renames (documented limitation)", () => {
        // Furia round 18 spec: regex minimo extrae a/X (pre-image).
        // For renames the post-image is intentionally NOT captured here.
        const patch = `diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
`;
        expect(extractModifiedFiles(patch)).toEqual(["old.ts"]);
    });
});

describe("Phase 5: computeGroundTruth (3-niveles)", () => {
    it("strict_src includes src/ files, excludes tests + non-src", () => {
        const t = mkTask([
            "src/index.ts",
            "src/handlers/code.ts",
            "src/foo.test.ts",
            "test/integration.ts",
            "docs/README.md",
            "package.json",
        ]);
        const gt = computeGroundTruth(t);
        expect(gt.strict_src.sort()).toEqual([
            "src/handlers/code.ts",
            "src/index.ts",
        ]);
    });

    it("permissive includes non-test files (src + docs + config)", () => {
        const t = mkTask([
            "src/index.ts",
            "src/foo.test.ts",
            "test/integration.ts",
            "docs/README.md",
            "package.json",
        ]);
        const gt = computeGroundTruth(t);
        expect(gt.permissive.sort()).toEqual([
            "docs/README.md",
            "package.json",
            "src/index.ts",
        ]);
    });

    it("maximal includes everything (incl tests)", () => {
        const files = [
            "src/index.ts",
            "src/foo.test.ts",
            "test/integration.ts",
            "docs/README.md",
        ];
        const gt = computeGroundTruth(mkTask(files));
        expect(gt.maximal.sort()).toEqual([...files].sort());
    });

    it("anti_tests_filter_applied flag set true (audit)", () => {
        const gt = computeGroundTruth(mkTask(["src/x.ts"]));
        expect(gt.anti_tests_filter_applied).toBe(true);
    });

    it("empty patch produces all empty arrays", () => {
        const gt = computeGroundTruth(mkTask([]));
        expect(gt.strict_src).toEqual([]);
        expect(gt.permissive).toEqual([]);
        expect(gt.maximal).toEqual([]);
    });

    it("test-only PR produces empty strict_src (anti-tests mortal)", () => {
        const t = mkTask([
            "src/foo.test.ts",
            "src/bar.spec.ts",
            "test/x.ts",
        ]);
        const gt = computeGroundTruth(t);
        expect(gt.strict_src).toEqual([]);
        expect(gt.permissive).toEqual([]);
        expect(gt.maximal).toHaveLength(3);
    });

    it("packages/* monorepo paths NOT counted as src/ unless src/ prefix", () => {
        // Monorepo edge case: "packages/foo/src/x.ts" does NOT start with "src/"
        // strict_src filter is intentionally repo-shape-agnostic per spec.
        const t = mkTask([
            "packages/foo/src/x.ts",
            "src/y.ts",
        ]);
        const gt = computeGroundTruth(t);
        expect(gt.strict_src).toEqual(["src/y.ts"]);
    });
});
