/**
 * Phase 5 C.3.D Aider runner tests.
 *
 * AiderSpawnFn is mocked everywhere -- no real aider binary is
 * touched. The Gate 4 smoke test (gitignored) exercises the real
 * binary.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    runAider,
    parseAiderRepoMap,
    resolveAiderBinary,
    DEFAULT_AIDER_BINARY,
} from "../../../scripts/eval-phase5/runners/aider-runner.js";
import type { AiderSpawnFn } from "../../../scripts/eval-phase5/runners/aider-runner.js";
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

/** Realistic Aider --show-repo-map stdout captured during exploration. */
const REAL_OUTPUT = [
    "Using gpt-4o model with API key from environment.",
    "Aider v0.86.2",
    "Main model: gpt-4o with diff edit format",
    "Git repo: .git with 5 files",
    "Repo-map: using 4096 tokens, auto refresh",
    "Here are summaries of some files present in my git repository.",
    "",
    "src\\SuggestModel.ts:",
    "│export class SuggestModel {",
    "│    triggerWith(ctx: unknown): string[] {",
    "⋮",
    "",
    "src\\CompletionModel.ts:",
    "│export class CompletionModel {",
    "│    _createCachedState(key: string, items: string[]): void {",
    "⋮",
    "",
    "src/utils.ts:",
    "│export function parseTokens(input: string): string[] {",
    "⋮",
    "",
].join("\n");

describe("parseAiderRepoMap", () => {
    it("parses backslash and forward-slash file headers in encounter order", () => {
        const scores = parseAiderRepoMap(REAL_OUTPUT, [], "/tmp/ws");
        const keys = [...scores.keys()];
        expect(keys[0]).toBe("src/SuggestModel.ts");
        expect(keys[1]).toBe("src/CompletionModel.ts");
        expect(keys[2]).toBe("src/utils.ts");
    });

    it("higher rank (earlier in output) maps to a higher base score", () => {
        const scores = parseAiderRepoMap(REAL_OUTPUT, [], "/tmp/ws");
        const a = scores.get("src/SuggestModel.ts")!;
        const b = scores.get("src/CompletionModel.ts")!;
        const c = scores.get("src/utils.ts")!;
        expect(a).toBeGreaterThan(b);
        expect(b).toBeGreaterThan(c);
    });

    it("returns empty map for empty stdout", () => {
        expect(parseAiderRepoMap("", [], "/tmp/ws").size).toBe(0);
    });

    it("returns empty map when stdout has no file headers", () => {
        const noHeaders = "just\nsome\nrandom\nlines\nwithout colons\n";
        expect(parseAiderRepoMap(noHeaders, [], "/tmp/ws").size).toBe(0);
    });

    it("query keyword boost lifts the score when keyword appears in section body", () => {
        const scoresNoBoost = parseAiderRepoMap(REAL_OUTPUT, [], "/tmp/ws");
        const scoresWithBoost = parseAiderRepoMap(REAL_OUTPUT, ["triggerWith"], "/tmp/ws");
        const before = scoresNoBoost.get("src/SuggestModel.ts")!;
        const after = scoresWithBoost.get("src/SuggestModel.ts")!;
        expect(after).toBeGreaterThan(before);
    });

    it("keyword shorter than 3 chars contributes no boost", () => {
        const scores = parseAiderRepoMap(REAL_OUTPUT, ["ab"], "/tmp/ws");
        const base = parseAiderRepoMap(REAL_OUTPUT, [], "/tmp/ws");
        expect(scores.get("src/SuggestModel.ts")).toBe(base.get("src/SuggestModel.ts"));
    });
});

describe("runAider", () => {
    const okSpawn: AiderSpawnFn = async () => ({
        stdout: REAL_OUTPUT,
        stderr: "",
        code: 0,
    });

    it("happy path: returns top-K with SuggestModel.ts first", async () => {
        const task = mkTask(
            "SuggestModel.triggerWith returns wrong completions when context is null. See src/SuggestModel.ts.",
        );
        const res = await runAider(task, "/tmp/ws", 3, okSpawn);
        expect(res.error).toBeUndefined();
        expect(res.retriever).toBe("aider");
        expect(res.retrieved_files[0]).toBe("src/SuggestModel.ts");
        expect(res.retrieved_files.length).toBeLessThanOrEqual(3);
    });

    it("applies anti-tests filter post-parse", async () => {
        const outputWithTest =
            REAL_OUTPUT + "\ntests/foo.test.ts:\n│it(\"x\", () => {});\n⋮\n";
        const spawn: AiderSpawnFn = async () => ({
            stdout: outputWithTest,
            stderr: "",
            code: 0,
        });
        const task = mkTask("triggerWith");
        const res = await runAider(task, "/tmp/ws", 5, spawn);
        expect(res.retrieved_files).not.toContain("tests/foo.test.ts");
        expect(res.retrieved_files).toContain("src/SuggestModel.ts");
    });

    it("respects top-K cap", async () => {
        const task = mkTask("triggerWith");
        const res = await runAider(task, "/tmp/ws", 2, okSpawn);
        expect(res.retrieved_files).toHaveLength(2);
    });

    it("returns clear error when aider binary is missing", async () => {
        const spawnNoBinary: AiderSpawnFn = async () => ({
            stdout: "",
            stderr: "spawn error: ENOENT",
            code: null,
        });
        const res = await runAider(mkTask("anything"), "/tmp/ws", 3, spawnNoBinary);
        expect(res.error).toMatch(/Aider binary not found/);
        expect(res.retrieved_files).toEqual([]);
    });

    it("returns error when aider exits non-zero", async () => {
        const spawnCrash: AiderSpawnFn = async () => ({
            stdout: "",
            stderr: "Traceback ...\nError: invalid model\n",
            code: 1,
        });
        const res = await runAider(mkTask("anything"), "/tmp/ws", 3, spawnCrash);
        expect(res.error).toMatch(/Aider exited 1/);
        expect(res.retrieved_files).toEqual([]);
    });

    it("empty stdout returns empty retrieved_files (no throw)", async () => {
        const spawnEmpty: AiderSpawnFn = async () => ({ stdout: "", stderr: "", code: 0 });
        const res = await runAider(mkTask("anything"), "/tmp/ws", 3, spawnEmpty);
        expect(res.error).toBeUndefined();
        expect(res.retrieved_files).toEqual([]);
    });

    it("propagates env to spawn function (OPENAI_API_KEY, PYTHONIOENCODING, etc.)", async () => {
        let capturedEnv: Record<string, string> = {};
        const spy: AiderSpawnFn = async (_args, _cwd, env) => {
            capturedEnv = env;
            return { stdout: REAL_OUTPUT, stderr: "", code: 0 };
        };
        await runAider(mkTask("foo"), "/tmp/ws", 3, spy);
        expect(capturedEnv.OPENAI_API_KEY).toBeTruthy();
        expect(capturedEnv.PYTHONIOENCODING).toBe("utf-8");
        expect(capturedEnv.AIDER_ANALYTICS).toBe("false");
    });
});

describe("resolveAiderBinary", () => {
    const originalEnv = process.env.AIDER_BINARY;
    beforeEach(() => {
        delete process.env.AIDER_BINARY;
    });
    afterEach(() => {
        if (originalEnv !== undefined) process.env.AIDER_BINARY = originalEnv;
        else delete process.env.AIDER_BINARY;
    });

    it("returns an absolute path derived from the default venv path when AIDER_BINARY is unset", () => {
        const resolved = resolveAiderBinary();
        // Default lives under .venv-aider/Scripts/aider.exe relative
        // to project root; the absolutised form must still end in it.
        expect(resolved.endsWith(DEFAULT_AIDER_BINARY)).toBe(true);
        // And it must be absolute so spawn(cwd=workspace) finds it.
        expect(require("node:path").isAbsolute(resolved)).toBe(true);
    });

    it("honours AIDER_BINARY env override (kept absolute when already absolute)", () => {
        const abs = process.platform === "win32" ? "C:\\custom\\aider.exe" : "/custom/path/aider";
        process.env.AIDER_BINARY = abs;
        expect(resolveAiderBinary()).toBe(abs);
    });
});
