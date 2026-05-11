/**
 * Phase 5 C.3.B ripgrep-runner tests.
 *
 * Injects a fake RgSpawnFn so tests never invoke the real `rg`
 * binary. parseRgCountOutput is also exercised in isolation.
 */

import { describe, it, expect } from "vitest";
import {
    runRipgrep,
    parseRgCountOutput,
} from "../../../scripts/eval-phase5/runners/ripgrep-runner.js";
import type { RgSpawnFn } from "../../../scripts/eval-phase5/runners/ripgrep-runner.js";
import type { PolyBenchTask } from "../../../scripts/eval-phase5/types.js";

function mkTask(problem: string, overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "abc",
        patch: "",
        test_patch: "",
        problem_statement: problem,
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

function makeSpawn(perKeyword: Record<string, string>): RgSpawnFn {
    return async (args, _cwd) => {
        // The keyword is the last positional arg before ".".
        const dotIdx = args.lastIndexOf(".");
        const keyword = dotIdx > 0 ? args[dotIdx - 1] : "";
        const stdout = perKeyword[keyword] ?? "";
        return {
            stdout,
            stderr: "",
            code: stdout.length > 0 ? 0 : 1,
        };
    };
}

describe("parseRgCountOutput", () => {
    it("parses --count-matches output into a file -> count map", () => {
        const out = parseRgCountOutput("src/foo.ts:7\nsrc/bar.ts:3\n");
        expect(out.get("src/foo.ts")).toBe(7);
        expect(out.get("src/bar.ts")).toBe(3);
    });

    it("skips malformed lines", () => {
        const out = parseRgCountOutput("src/foo.ts:7\ngarbage line\nsrc/bar.ts:abc\n");
        expect(out.get("src/foo.ts")).toBe(7);
        expect(out.size).toBe(1);
    });

    it("normalizes backslashes to forward slashes", () => {
        const out = parseRgCountOutput("src\\foo.ts:4\n");
        expect(out.get("src/foo.ts")).toBe(4);
    });

    it("returns empty map for empty stdout", () => {
        expect(parseRgCountOutput("").size).toBe(0);
    });
});

describe("runRipgrep", () => {
    it("happy path: parses output across keywords and returns top-K", async () => {
        const spawn = makeSpawn({
            SuggestModel: "src/SuggestModel.ts:5\nsrc/util.ts:1\n",
            triggerWith: "src/SuggestModel.ts:2\n",
            "src/SuggestModel.ts": "src/SuggestModel.ts:1\n",
        });
        const task = mkTask("SuggestModel.triggerWith breaks in src/SuggestModel.ts");
        const result = await runRipgrep(task, "/tmp/ws", 3, spawn);
        expect(result.error).toBeUndefined();
        expect(result.retriever).toBe("ripgrep");
        expect(result.retrieved_files[0]).toBe("src/SuggestModel.ts");
        expect(result.retrieved_files).toContain("src/util.ts");
    });

    it("aggregates counts across multiple keywords", async () => {
        const spawn = makeSpawn({
            Alpha: "src/winner.ts:3\nsrc/loser.ts:1\n",
            Beta: "src/winner.ts:5\n",
            Gamma: "src/winner.ts:2\n",
        });
        const task = mkTask("Alpha Beta Gamma");
        const result = await runRipgrep(task, "/tmp/ws", 2, spawn);
        expect(result.retrieved_files[0]).toBe("src/winner.ts");
        expect(result.retrieved_files[1]).toBe("src/loser.ts");
    });

    it("produces a clear error when rg is not on PATH", async () => {
        const spawnNoBinary: RgSpawnFn = async () => ({
            stdout: "",
            stderr: "spawn error: ENOENT",
            code: null,
        });
        const task = mkTask("anything");
        const result = await runRipgrep(task, "/tmp/ws", 3, spawnNoBinary);
        expect(result.error).toMatch(/ripgrep binary not available/);
        expect(result.retrieved_files).toEqual([]);
    });

    it("applies anti-tests filter", async () => {
        const spawn = makeSpawn({
            Foo: "src/foo.ts:2\ntests/foo.test.ts:10\n",
            Bar: "tests/foo.test.ts:5\n",
        });
        const task = mkTask("Foo and Bar");
        const result = await runRipgrep(task, "/tmp/ws", 5, spawn);
        expect(result.retrieved_files).toContain("src/foo.ts");
        expect(result.retrieved_files).not.toContain("tests/foo.test.ts");
    });

    it("respects top-K cap", async () => {
        const lines = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts:1`).join("\n");
        const spawn = makeSpawn({ Identifier: lines });
        const task = mkTask("Identifier");
        const result = await runRipgrep(task, "/tmp/ws", 3, spawn);
        expect(result.retrieved_files).toHaveLength(3);
    });
});
