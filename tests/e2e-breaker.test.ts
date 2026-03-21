import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { TokenGuardEngine } from "../src/engine.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import { handleCode } from "../src/router.js";
import { wrapWithCircuitBreaker } from "../src/middleware/circuit-breaker.js";
import type { RouterDependencies } from "../src/router.js";

describe("E2E: Creative Circuit Breaker Flow", () => {
    let tmpDir: string;
    let deps: RouterDependencies;
    let testFile: string;

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tg-e2e-"));
        testFile = path.join(tmpDir, "app.ts");
        fs.writeFileSync(testFile, "export function target() { return 1; }");

        const engine = new TokenGuardEngine({
            dbPath: path.join(tmpDir, "test.db"),
            watchPaths: [tmpDir],
        });
        await engine.initialize();
        await engine.indexFile(testFile);
        const sandbox = new AstSandbox();
        await sandbox.initialize();

        deps = {
            engine,
            sandbox,
            circuitBreaker: new CircuitBreaker(),
            monitor: new TokenMonitor(),
        };
    });

    afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("simulates 3 failures → Level 1 redirect → grace period → recovery", async () => {
        // Broken code: missing closing brace
        const badCall = async () => handleCode("edit", {
            action: "edit", path: testFile, symbol: "target",
            new_code: "export function target() { broken",
        }, deps);

        // 1. Fail 3 times - triggers Pattern 1
        await wrapWithCircuitBreaker(deps.circuitBreaker, "nreki_code", "edit", badCall, testFile, "target");
        await wrapWithCircuitBreaker(deps.circuitBreaker, "nreki_code", "edit", badCall, testFile, "target");
        const tripRes = await wrapWithCircuitBreaker(deps.circuitBreaker, "nreki_code", "edit", badCall, testFile, "target");

        // Should get Level 1 redirect
        expect(tripRes.isError).toBe(true);
        expect(tripRes.content[0].text).toContain("LEVEL 1");
        expect(tripRes.content[0].text).toContain("compress:false");

        // 2. One more failure with new strategy - should NOT escalate to Level 2
        // (amnesia total cleared the history for this file)
        const badInsertCall = async () => handleCode("edit", {
            action: "edit", path: testFile, symbol: "target",
            new_code: "export function target_v2() {",
            mode: "insert_after",
        }, deps);
        const graceRes = await wrapWithCircuitBreaker(
            deps.circuitBreaker, "nreki_code", "edit", badInsertCall, testFile, "target"
        );

        // Should be a syntax error, NOT a Level 2 trip
        expect(graceRes.content[0].text).not.toContain("LEVEL 2");

        // 3. Success with valid code
        const goodInsertCall = async () => handleCode("edit", {
            action: "edit", path: testFile, symbol: "target",
            new_code: "export function target_v2() {\n    return 2;\n}",
            mode: "insert_after",
        }, deps);
        const successRes = await wrapWithCircuitBreaker(
            deps.circuitBreaker, "nreki_code", "edit", goodInsertCall, testFile, "target"
        );

        expect(successRes.isError).toBeFalsy();
        const finalContent = fs.readFileSync(testFile, "utf-8");
        expect(finalContent).toContain("target_v2");
        expect(finalContent).toContain("function target()"); // Original preserved
    });
});
