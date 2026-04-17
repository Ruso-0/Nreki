/**
 * Patch 2 (v10.5.8) — router.normalizeEditModes auto-infers `mode` before the
 * Cognitive Enforcer runs. Prevents spurious blocks when the agent sends a
 * well-formed {search_text, replace_text} payload but forgets the `mode` field.
 *
 * The function is file-private to router.ts; we verify its effect end-to-end
 * through handleCode by observing that the enforcer sees the inferred mode
 * (patch mode bypasses the passport check, so a "blind" patch-shaped payload
 * now passes instead of being blocked).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleCode, type CodeParams, type RouterDependencies } from "../src/router.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Minimal stub kernel matching only the methods router touches on the hot path.
function makeStubDeps(projectRoot: string): RouterDependencies {
    const metadata = new Map<string, string>();
    const engine = {
        initialize: async () => { /* no-op */ },
        getMetadata: (k: string) => metadata.get(k) || "",
        setMetadata: (k: string, v: string) => { metadata.set(k, v); },
        getUsageStats: () => ({ total_output: 0 }),
        getProjectRoot: () => projectRoot,
    };
    return {
        engine: engine as unknown as RouterDependencies["engine"],
        enforcer: new CognitiveEnforcer(projectRoot),
        pressure: 0,
    } as unknown as RouterDependencies;
}

describe("normalizeEditModes (Patch 2 / v10.5.8)", () => {
    let tmpDir: string;
    let deps: RouterDependencies;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-normalize-"));
        // Large file (>50KB) so the enforcer engages — patch mode must be recognized
        // to avoid the "blind edit" block.
        fs.writeFileSync(path.join(tmpDir, "big.ts"), "// noop\n".repeat(30_000), "utf-8");
        deps = makeStubDeps(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("edit with {search_text, replace_text} and no mode → inferred as patch", async () => {
        const params: CodeParams = {
            action: "edit",
            path: "big.ts",
            symbol: "doesNotExist",
            search_text: "foo",
            replace_text: "bar",
        };
        // Mutation happens in normalizeEditModes before the handler runs.
        // Downstream may throw because the stub engine is minimal; we only care
        // that params.mode got set.
        try { await handleCode("edit", params, deps); } catch { /* stub engine */ }
        expect(params.mode).toBe("patch");
    });

    it("edit with only new_code and no mode → inferred as replace", async () => {
        const params: CodeParams = {
            action: "edit",
            path: "big.ts",
            symbol: "doesNotExist",
            new_code: "function f() {}",
        };
        await handleCode("edit", params, deps);
        expect(params.mode).toBe("replace");
    });

    it("edit with explicit mode is not overwritten", async () => {
        const params: CodeParams = {
            action: "edit",
            path: "big.ts",
            symbol: "doesNotExist",
            mode: "insert_after",
            new_code: "// added",
        };
        await handleCode("edit", params, deps);
        expect(params.mode).toBe("insert_after");
    });

    it("batch_edit normalizes each edit independently", async () => {
        const params: CodeParams = {
            action: "batch_edit",
            edits: [
                { path: "big.ts", symbol: "a", search_text: "x", replace_text: "y" },
                { path: "big.ts", symbol: "b", new_code: "function b() {}" },
                { path: "big.ts", symbol: "c", mode: "insert_before", new_code: "// c" },
            ],
        };
        await handleCode("batch_edit", params, deps);
        expect(params.edits![0].mode).toBe("patch");
        expect(params.edits![1].mode).toBe("replace");
        expect(params.edits![2].mode).toBe("insert_before"); // preserved
    });

    it("edit with no fields at all gets no mode (no spurious inference)", async () => {
        const params: CodeParams = {
            action: "edit",
            path: "big.ts",
            symbol: "doesNotExist",
        };
        await handleCode("edit", params, deps);
        expect(params.mode).toBeUndefined();
    });
});
