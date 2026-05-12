/**
 * Phase 5 C.4.A.5 ground-truth monorepo widening tests.
 *
 * Verifies isSourcePath covers the patterns the PolyBench Verified TS
 * survey surfaced (mui packages, vscode src/vs, angular packages,
 * simple `src/`) and excludes non-source paths (dist, node_modules,
 * docs, root-level configs).
 */

import { describe, it, expect } from "vitest";
import {
    isSourcePath,
    isTestFile,
    computeGroundTruth,
    SOURCE_PATH_PATTERNS,
} from "../../scripts/eval-phase5/ground-truth.js";
import type { PolyBenchTask } from "../../scripts/eval-phase5/types.js";

function mkTask(patch: string, overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "0".repeat(40),
        patch,
        test_patch: "",
        problem_statement: "",
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
        ...overrides,
    };
}

describe("isSourcePath", () => {
    it("matches the simple src/ prefix", () => {
        expect(isSourcePath("src/foo.ts")).toBe(true);
        expect(isSourcePath("src/utils/parse.ts")).toBe(true);
    });

    it("matches vscode src/vs/ (catches as a sub-case of src/)", () => {
        expect(isSourcePath("src/vs/editor/contrib/suggest/completionModel.ts")).toBe(true);
    });

    it("matches mui packages/material-ui/src/", () => {
        expect(isSourcePath("packages/material-ui/src/ListItem/ListItem.js")).toBe(true);
    });

    it("matches mui sibling packages (mui-base, mui-system, mui-joy, ...)", () => {
        expect(isSourcePath("packages/mui-base/src/ListboxUnstyled/useControllableReducer.ts")).toBe(true);
        expect(isSourcePath("packages/mui-system/src/spacing.d.ts")).toBe(true);
        expect(isSourcePath("packages/mui-joy/src/Select/SelectProps.ts")).toBe(true);
        expect(isSourcePath("packages/material-ui-lab/src/SpeedDial/SpeedDial.d.ts")).toBe(true);
    });

    it("matches angular/core packages/core/src/", () => {
        expect(isSourcePath("packages/core/src/render3/di.ts")).toBe(true);
    });

    it("excludes dist/ build output", () => {
        expect(isSourcePath("dist/bundle.js")).toBe(false);
        expect(isSourcePath("packages/material-ui/dist/index.js")).toBe(false);
    });

    it("excludes node_modules/ even when it contains a nested src/", () => {
        expect(isSourcePath("node_modules/some-lib/src/index.ts")).toBe(false);
    });

    it("excludes docs/ regardless of nested layout", () => {
        expect(isSourcePath("docs/src/pages/style/icons/SvgIcons.js")).toBe(false);
        expect(isSourcePath("docs/api.md")).toBe(false);
    });

    it("excludes top-level config files (.size-limit.js, .eslintrc.js, yarn.lock)", () => {
        expect(isSourcePath(".size-limit.js")).toBe(false);
        expect(isSourcePath(".eslintrc.js")).toBe(false);
        expect(isSourcePath("yarn.lock")).toBe(false);
    });

    it("excludes packages/<scope>/package.json (not under src/)", () => {
        expect(isSourcePath("packages/material-ui-styled-engine-sc/package.json")).toBe(false);
    });

    it("requires exactly one segment for <scope> (no packages/src/ shortcut)", () => {
        // 'packages/src/foo.ts' is not a canonical monorepo layout. Reject.
        expect(isSourcePath("packages/src/foo.ts")).toBe(false);
        // Two segments under packages/ before src/ is also not the canonical
        // form (mui never does packages/a/b/src/). Reject.
        expect(isSourcePath("packages/a/b/src/foo.ts")).toBe(false);
    });

    it("SOURCE_PATH_PATTERNS is exported and non-empty", () => {
        expect(SOURCE_PATH_PATTERNS.length).toBeGreaterThan(0);
        expect(SOURCE_PATH_PATTERNS).toContain("src/");
    });
});

describe("computeGroundTruth strict_src under widening", () => {
    function patchFor(...files: string[]): string {
        return files.map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n`).join("");
    }

    it("mui task: strict_src is non-empty after widening", () => {
        const task = mkTask(patchFor(
            "packages/material-ui/src/ListItem/ListItem.js",
            ".size-limit.js",
        ));
        const gt = computeGroundTruth(task);
        expect(gt.strict_src).toEqual(["packages/material-ui/src/ListItem/ListItem.js"]);
        // Permissive still includes the config file (no test filter applies).
        expect(gt.permissive).toContain(".size-limit.js");
    });

    it("vscode task: strict_src is non-empty for src/vs/ files", () => {
        const task = mkTask(patchFor(
            "src/vs/editor/contrib/suggest/completionModel.ts",
            "src/vs/editor/contrib/suggest/suggestModel.ts",
        ));
        const gt = computeGroundTruth(task);
        expect(gt.strict_src.sort()).toEqual([
            "src/vs/editor/contrib/suggest/completionModel.ts",
            "src/vs/editor/contrib/suggest/suggestModel.ts",
        ]);
    });

    it("docs-only task: strict_src is empty (docs are not source)", () => {
        const task = mkTask(patchFor(
            "docs/src/pages/style/icons/SvgIcons.js",
            "docs/api.md",
        ));
        const gt = computeGroundTruth(task);
        expect(gt.strict_src).toEqual([]);
    });

    it("anti-tests filter still mortal: tests under packages/<x>/src/ are excluded from strict_src", () => {
        const task = mkTask(patchFor(
            "packages/material-ui/src/ListItem/ListItem.js",
            "packages/material-ui/src/ListItem/ListItem.test.js",
        ));
        const gt = computeGroundTruth(task);
        expect(gt.strict_src).toEqual(["packages/material-ui/src/ListItem/ListItem.js"]);
        expect(isTestFile("packages/material-ui/src/ListItem/ListItem.test.js")).toBe(true);
    });
});
