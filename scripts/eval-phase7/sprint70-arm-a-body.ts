#!/usr/bin/env tsx
/**
 * Sprint 7.0 Arm A — Claude + Aider (raw edit baseline) subprocess body.
 *
 * Forked by sprint70-driver.ts. Receives {task, rep} via IPC, runs the
 * Aider agent loop over the task workspace at base_commit, captures a
 * CellResult, and posts it back to the parent.
 *
 * This file is the SCAFFOLD for Sprint 7.0. Real execution requires
 * the sanity-gate to pass (ANTHROPIC_API_KEY, OPENAI_API_KEY, Docker).
 * Until then, this body returns a structured "not-executable" CellResult.
 *
 * Pre-registered (sprint70-prereg.md §"Arm A"):
 *   aider --model claude-sonnet-4-6 --architect false --no-stream --yes
 *         --auto-commits false
 *   Timeout: 600s per attempt.
 *
 * Test execution (post-patch):
 *   1. git apply the captured diff
 *   2. tsc --noEmit baseline + delta check (only NEW type errors fail the cell)
 *   3. Run PolyBench test_command (Docker on Linux per pre-reg)
 *   4. Parse junit / mocha output for F2P + P2P pass status
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as path from "node:path";

interface PolyBenchTask {
    instance_id: string;
    repo: string;
    base_commit: string;
    task_category: string;
    patch: string;
    test_patch: string;
    F2P: string;
    P2P: string;
    test_command: string;
    Dockerfile: string;
    problem_statement: string;
}

interface CellResult {
    instance_id: string;
    arm: "A" | "B" | "C";
    rep: number;
    pass: 0 | 1;
    timeout: boolean;
    edits_attempted: number;
    edits_rejected_by_shield: number;
    edits_rejected_then_corrected: number;
    doom_loop: boolean;
    llm_tokens: number;
    wall_clock_ms: number;
    error?: string;
}

function fail(reason: string, task: PolyBenchTask, rep: number): CellResult {
    return {
        instance_id: task.instance_id,
        arm: "A",
        rep,
        pass: 0,
        timeout: false,
        edits_attempted: 0,
        edits_rejected_by_shield: 0,
        edits_rejected_then_corrected: 0,
        doom_loop: false,
        llm_tokens: 0,
        wall_clock_ms: 0,
        error: reason,
    };
}

async function runArmA(task: PolyBenchTask, rep: number): Promise<CellResult> {
    // Pre-flight: env check (mirrors sanity-gate; defensive)
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length < 30) {
        return fail("ANTHROPIC_API_KEY missing/short", task, rep);
    }
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 30) {
        return fail("OPENAI_API_KEY missing/short", task, rep);
    }
    return fail(
        "Arm A body scaffold: agent loop + test execution NOT implemented "
        + "in Sprint 7.0 scaffold (deferred to Sprint 7.0.1).",
        task, rep,
    );

    /*
     * Production sketch (uncomment + finish in Sprint 7.0.1):
     *
     * 1. workspace = `.eval-phase5-cache/task-workspaces/task-${repo}-pr${pull}`
     * 2. git -C workspace checkout base_commit; git -C workspace clean -fdx
     * 3. Build aider command line:
     *      aider --model claude-sonnet-4-6 --architect false
     *            --no-stream --yes --auto-commits false
     *            --message problem_statement
     *            <files to read>
     * 4. spawn aider with timeout 600s, capture stdout/stderr
     * 5. Detect aider's "edit applied" markers; count edits_attempted
     * 6. After aider exit:
     *      a. git -C workspace diff > captured.patch
     *      b. tsc --noEmit (in Docker if Linux-only); record new errors
     *      c. Run PolyBench test_command (Docker); parse F2P + P2P pass
     * 7. pass = 1 iff diff applied clean AND F2P passes AND P2P preserves AND tsc delta 0
     */
}

process.on("message", async (msg: { task: PolyBenchTask; rep: number }) => {
    const result = await runArmA(msg.task, msg.rep);
    if (process.send) process.send(result);
    process.exit(0);
});

// Standalone invocation (debugging)
if (process.send === undefined && process.argv[2]) {
    const dummy: PolyBenchTask = {
        instance_id: process.argv[2],
        repo: "test/test",
        base_commit: "HEAD",
        task_category: "Bug Fix",
        patch: "", test_patch: "", F2P: "", P2P: "",
        test_command: "", Dockerfile: "", problem_statement: "test",
    };
    runArmA(dummy, 1).then((r) => {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    });
}
