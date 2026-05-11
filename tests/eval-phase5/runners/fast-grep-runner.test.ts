/**
 * Phase 5 C.3.B fast-grep-runner tests.
 *
 * Uses an in-memory FastGrepDriver stub so the test never touches
 * SQLite, Tree-sitter, or the filesystem. The driver is the only
 * seam between the runner and NREKI internals.
 */

import { describe, it, expect } from "vitest";
import { runFastGrep } from "../../../scripts/eval-phase5/runners/fast-grep-runner.js";
import type { FastGrepDriver } from "../../../scripts/eval-phase5/runners/fast-grep-runner.js";
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

class StubDriver implements FastGrepDriver {
    public prepared: string | null = null;
    public queries: string[] = [];
    public disposed = false;
    constructor(
        private readonly hitsByKeyword: Map<string, { path: string }[]>,
    ) {}
    async prepare(workspaceRoot: string): Promise<void> {
        this.prepared = workspaceRoot;
    }
    async query(keyword: string, _limit: number): Promise<{ path: string }[]> {
        this.queries.push(keyword);
        return this.hitsByKeyword.get(keyword) ?? [];
    }
    async dispose(): Promise<void> {
        this.disposed = true;
    }
}

describe("runFastGrep", () => {
    it("happy path: aggregates hits across keywords and returns top-K", async () => {
        const stub = new StubDriver(
            new Map([
                ["SuggestModel", [{ path: "src/SuggestModel.ts" }, { path: "src/util.ts" }]],
                ["triggerWith", [{ path: "src/SuggestModel.ts" }]],
                ["src/SuggestModel.ts", [{ path: "src/SuggestModel.ts" }]],
            ]),
        );
        const task = mkTask("SuggestModel.triggerWith breaks in src/SuggestModel.ts");
        const result = await runFastGrep(task, "/tmp/ws", 3, stub);
        expect(result.error).toBeUndefined();
        expect(result.retriever).toBe("fast_grep");
        expect(result.retrieved_files[0]).toBe("src/SuggestModel.ts");
        expect(result.retrieved_files).toContain("src/util.ts");
        expect(stub.prepared).toBe("/tmp/ws");
        expect(stub.disposed).toBe(true);
    });

    it("applies anti-tests filter (tests/foo.test.ts excluded even when hit)", async () => {
        const stub = new StubDriver(
            new Map([
                ["Foo", [{ path: "src/foo.ts" }, { path: "tests/foo.test.ts" }]],
                ["Bar", [{ path: "tests/foo.test.ts" }, { path: "tests/foo.test.ts" }]],
            ]),
        );
        const task = mkTask("Foo and Bar collide");
        const result = await runFastGrep(task, "/tmp/ws", 5, stub);
        expect(result.retrieved_files).toContain("src/foo.ts");
        expect(result.retrieved_files).not.toContain("tests/foo.test.ts");
    });

    it("score aggregation: file hit by 3 keywords beats file hit by 1", async () => {
        const stub = new StubDriver(
            new Map([
                ["Alpha", [{ path: "src/winner.ts" }, { path: "src/loser.ts" }]],
                ["Beta", [{ path: "src/winner.ts" }]],
                ["Gamma", [{ path: "src/winner.ts" }]],
            ]),
        );
        const task = mkTask("Alpha Beta Gamma");
        const result = await runFastGrep(task, "/tmp/ws", 2, stub);
        expect(result.retrieved_files[0]).toBe("src/winner.ts");
        expect(result.retrieved_files[1]).toBe("src/loser.ts");
    });

    it("respects top-K cap", async () => {
        const stub = new StubDriver(
            new Map([
                ["Identifier", Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts` }))],
            ]),
        );
        const task = mkTask("Identifier");
        const result = await runFastGrep(task, "/tmp/ws", 3, stub);
        expect(result.retrieved_files).toHaveLength(3);
    });

    it("returns error in RetrievalResult when driver.prepare throws", async () => {
        const failing: FastGrepDriver = {
            async prepare() {
                throw new Error("workspace not found");
            },
            async query() {
                return [];
            },
        };
        const task = mkTask("anything");
        const result = await runFastGrep(task, "/does/not/exist", 3, failing);
        expect(result.error).toContain("workspace not found");
        expect(result.retrieved_files).toEqual([]);
    });
});
