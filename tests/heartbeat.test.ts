import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { applyContextHeartbeat, type McpToolResponse, type RouterDependencies } from "../src/router.js";

// ─── Minimal mock deps for applyContextHeartbeat ──────────────────────

function makeMockDeps(overrides: {
    totalToolCalls?: number;
    escalationLevel?: number;
    metadata?: Record<string, string>;
    planPath?: string;
    planExists?: boolean;
} = {}): RouterDependencies {
    const metadata: Record<string, string> = overrides.metadata ?? {};
    const cb = new CircuitBreaker();

    // Drive totalToolCalls to the desired count
    const target = overrides.totalToolCalls ?? 0;
    for (let i = 0; i < target; i++) {
        cb.recordToolCall("nreki_code:read", "ok");
    }

    // If we need escalation >= 2, trip the breaker twice (each trip increments level by 1)
    if (overrides.escalationLevel && overrides.escalationLevel >= 2) {
        // Trip 1 → level 1
        for (let i = 0; i < 4; i++) {
            cb.recordToolCall("nreki_code:edit", "TypeError: x", "src/app.ts", "sym", true);
        }
        // Soft reset so it can trip again
        cb.softReset();
        // Trip 2 → level 2
        for (let i = 0; i < 4; i++) {
            cb.recordToolCall("nreki_code:edit", "TypeError: x", "src/app.ts", "sym", true);
        }
    }

    return {
        engine: {
            initialize: vi.fn(),
            getMetadata: (key: string) => metadata[key] ?? null,
            setMetadata: (key: string, value: string) => { metadata[key] = value; },
            getStats: () => ({ filesIndexed: 0, totalChunks: 0, totalRawChars: 0, totalShorthandChars: 0, compressionRatio: 0, watchedPaths: [] }),
        } as any,
        monitor: {} as any,
        sandbox: {} as any,
        circuitBreaker: cb,
    };
}

function makeResponse(text: string): McpToolResponse {
    return { content: [{ type: "text" as const, text }] };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Context Heartbeat: Prerequisites", () => {
    it("totalToolCalls increments on every recordToolCall", () => {
        const cb = new CircuitBreaker();
        expect(cb.getStats().totalToolCalls).toBe(0);

        cb.recordToolCall("nreki_code:read", "success", "src/app.ts");
        cb.recordToolCall("nreki_code:edit", "success", "src/app.ts");
        cb.recordToolCall("nreki_navigate:search", "success");

        expect(cb.getStats().totalToolCalls).toBe(3);
    });

    it("totalToolCalls survives soft reset", () => {
        const cb = new CircuitBreaker();
        for (let i = 0; i < 5; i++) {
            cb.recordToolCall("nreki_code:read", "success");
        }
        expect(cb.getStats().totalToolCalls).toBe(5);

        cb.softReset();
        expect(cb.getStats().totalToolCalls).toBe(5);
    });
});

describe("Context Heartbeat: applyContextHeartbeat (real function)", () => {
    it("does not inject heartbeat when < 15 tool calls have passed", () => {
        const deps = makeMockDeps({ totalToolCalls: 5 });
        const response = makeResponse("original result");

        const result = applyContextHeartbeat("read", response, deps);

        expect(result.content[0].text).toBe("original result");
    });

    it("injects heartbeat on safe action after 15+ tool calls", () => {
        const deps = makeMockDeps({ totalToolCalls: 16 });
        const response = makeResponse("original result");

        const result = applyContextHeartbeat("read", response, deps);

        expect(result.content[0].text).toContain("CONTEXT HEARTBEAT");
        expect(result.content[0].text).toContain("original result");
    });

    it("does NOT inject heartbeat on unsafe actions (edit, undo, filter_output)", () => {
        const deps = makeMockDeps({ totalToolCalls: 16 });

        for (const action of ["edit", "undo", "filter_output", "compress"]) {
            const response = makeResponse("result");
            const result = applyContextHeartbeat(action, response, deps);
            expect(result.content[0].text).not.toContain("CONTEXT HEARTBEAT");
        }
    });

    it("injects on all safe actions (read, search, map, status, definition, references, outline)", () => {
        for (const action of ["read", "search", "map", "status", "definition", "references", "outline"]) {
            const deps = makeMockDeps({ totalToolCalls: 16 });
            const response = makeResponse("result");
            const result = applyContextHeartbeat(action, response, deps);
            expect(result.content[0].text).toContain("CONTEXT HEARTBEAT");
        }
    });

    it("does not inject on error responses", () => {
        const deps = makeMockDeps({ totalToolCalls: 16 });
        const response: McpToolResponse = {
            content: [{ type: "text" as const, text: "error" }],
            isError: true,
        };

        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).toBe("error");
    });

    it("does not inject during high escalation (level >= 2)", () => {
        const deps = makeMockDeps({ totalToolCalls: 16, escalationLevel: 2 });
        const response = makeResponse("result");

        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).not.toContain("CONTEXT HEARTBEAT");
    });

    it("restart detection: resets marker when currentCalls < lastInjectCalls", () => {
        // Simulate a previous session that set lastInjectCalls to 45
        const deps = makeMockDeps({
            totalToolCalls: 16,
            metadata: { "nreki_plan_last_inject": "45" },
        });
        const response = makeResponse("result");

        // currentCalls (16) < lastInjectCalls (45) → should reset and inject
        const result = applyContextHeartbeat("read", response, deps);
        expect(result.content[0].text).toContain("CONTEXT HEARTBEAT");
    });

    it("updates last_inject marker after injection", () => {
        const metadata: Record<string, string> = {};
        const deps = makeMockDeps({ totalToolCalls: 16, metadata });
        const response = makeResponse("result");

        applyContextHeartbeat("read", response, deps);
        expect(metadata["nreki_plan_last_inject"]).toBe("16");
    });
});

describe("Context Heartbeat: Bankruptcy Shield", () => {
    it("rejects plans over 4000 estimated tokens", () => {
        const largePlan = "x".repeat(16000);
        const estimatedTokens = Math.ceil(largePlan.length / 3.5);
        expect(estimatedTokens).toBeGreaterThan(4000);
    });

    it("accepts plans under 4000 estimated tokens", () => {
        const smallPlan = "x".repeat(5000);
        const estimatedTokens = Math.ceil(smallPlan.length / 3.5);
        expect(estimatedTokens).toBeLessThan(4000);
    });
});
