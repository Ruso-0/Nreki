/**
 * Phase 5 C.1 ground-truth + anti-tests filter mortal tests.
 * Furia round 13 #8: tests del FUTURO = trampa temporal.
 */

import { describe, it, expect } from "vitest";
import { isTestFile, computeGroundTruth } from "../../scripts/eval-phase5/ground-truth.js";
import type { BugCandidate } from "../../scripts/eval-phase5/types.js";

function mkCandidate(modified_files: string[]): BugCandidate {
    return {
        repo: "owner/repo",
        pr_number: 1,
        pr_title: "Test fixture",
        issue_url: null,
        issue_text: null,
        base_commit: "a",
        merge_commit: "b",
        modified_files,
        pr_labels: ["bug"],
        curated_at: new Date().toISOString(),
        blind_approved: null,
    };
}

describe("Phase 5 C.1: isTestFile (anti-tests filter mortal)", () => {
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

describe("Phase 5 C.1: computeGroundTruth (3-niveles)", () => {
    it("strict_src includes src/ files, excludes tests + non-src", () => {
        const c = mkCandidate([
            "src/index.ts",
            "src/handlers/code.ts",
            "src/foo.test.ts",
            "test/integration.ts",
            "docs/README.md",
            "package.json",
        ]);
        const gt = computeGroundTruth(c);
        expect(gt.strict_src.sort()).toEqual([
            "src/handlers/code.ts",
            "src/index.ts",
        ]);
    });

    it("permissive includes non-test files (src + docs + config)", () => {
        const c = mkCandidate([
            "src/index.ts",
            "src/foo.test.ts",
            "test/integration.ts",
            "docs/README.md",
            "package.json",
        ]);
        const gt = computeGroundTruth(c);
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
        const gt = computeGroundTruth(mkCandidate(files));
        expect(gt.maximal.sort()).toEqual([...files].sort());
    });

    it("anti_tests_filter_applied flag set true (audit)", () => {
        const gt = computeGroundTruth(mkCandidate(["src/x.ts"]));
        expect(gt.anti_tests_filter_applied).toBe(true);
    });

    it("empty modified_files produces all empty arrays", () => {
        const gt = computeGroundTruth(mkCandidate([]));
        expect(gt.strict_src).toEqual([]);
        expect(gt.permissive).toEqual([]);
        expect(gt.maximal).toEqual([]);
    });

    it("test-only PR produces empty strict_src (anti-tests mortal)", () => {
        const c = mkCandidate([
            "src/foo.test.ts",
            "src/bar.spec.ts",
            "test/x.ts",
        ]);
        const gt = computeGroundTruth(c);
        expect(gt.strict_src).toEqual([]);
        expect(gt.permissive).toEqual([]);
        expect(gt.maximal).toHaveLength(3);
    });

    it("packages/* monorepo paths NOT counted as src/ unless src/ prefix", () => {
        // Monorepo edge case: "packages/foo/src/x.ts" does NOT start with "src/"
        // strict_src filter is intentionally repo-shape-agnostic per spec.
        const c = mkCandidate([
            "packages/foo/src/x.ts",
            "src/y.ts",
        ]);
        const gt = computeGroundTruth(c);
        expect(gt.strict_src).toEqual(["src/y.ts"]);
    });
});
