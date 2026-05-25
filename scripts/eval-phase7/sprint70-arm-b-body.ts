#!/usr/bin/env tsx
/**
 * Sprint 7.0 Arm B — Claude + NREKI Edit-Safety subprocess body.
 *
 * Forked by sprint70-driver.ts. Receives {task, rep} via IPC, runs the
 * Claude+NREKI agent loop, captures CellResult, posts to parent.
 *
 * SCAFFOLD ONLY for Sprint 7.0. Production wiring needs:
 *   - Anthropic SDK or @anthropic-ai/sdk
 *   - MCP stdio bridge to the local nreki server (mcp__nreki__nreki_code,
 *     mcp__nreki__nreki_guard, mcp__nreki__nreki_navigate)
 *   - Tool-loop runner mirroring Claude Code's agent harness
 *
 * Sprint 7.0 returns a structured "not-executable" CellResult until
 * ANTHROPIC_API_KEY + Docker land. Implementation deferred to 7.0.1.
 */

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
        arm: "B",
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

async function runArmB(task: PolyBenchTask, rep: number): Promise<CellResult> {
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length < 30) {
        return fail("ANTHROPIC_API_KEY missing/short", task, rep);
    }
    return fail(
        "Arm B body scaffold: Claude tool-loop + NREKI MCP bridge NOT "
        + "implemented in Sprint 7.0 scaffold (deferred to Sprint 7.0.1).",
        task, rep,
    );

    /*
     * Production sketch (uncomment + finish in Sprint 7.0.1):
     *
     * 1. workspace = `.eval-phase5-cache/task-workspaces/task-${repo}-pr${pull}`
     * 2. git -C workspace checkout base_commit; git -C workspace clean -fdx
     * 3. Spawn local NREKI MCP server via stdio (npx nreki@latest serve)
     * 4. Open Anthropic SDK client; system prompt = pre-reg §"LLM agent"
     * 5. Loop:
     *      - send messages[] to claude-sonnet-4-6 temp=0
     *      - if response contains tool_use:
     *          - if mcp__nreki__nreki_code (batch_edit, edit, ...): forward
     *          - track edits_attempted, edits_rejected_by_shield (when the
     *            tool result error includes "ast-sandbox" or "TTRD" markers),
     *            edits_rejected_then_corrected (rejected → next edit on same
     *            symbol succeeds)
     *      - else if no tool_use: agent declared done, break
     *      - timeout: 600s wall-clock
     * 6. After loop:
     *      a. git -C workspace diff > captured.patch
     *      b. tsc --noEmit + delta-zero check
     *      c. Run PolyBench test_command (Docker on Linux); parse F2P + P2P
     * 7. pass = same definition as Arm A (consistency hierro)
     */
}

process.on("message", async (msg: { task: PolyBenchTask; rep: number }) => {
    const result = await runArmB(msg.task, msg.rep);
    if (process.send) process.send(result);
    process.exit(0);
});
