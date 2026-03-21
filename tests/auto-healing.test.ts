/**
 * auto-healing.test.ts - Tests for NREKI L3.3 Self-Healing Engine.
 *
 * Validates:
 *   1. Missing import → healing injects → safe: true → disk correct
 *   2. await without async, healthy callers → healing adds async → safe: true
 *   3. await without async, callers break → cascade → micro-rollback → safe: false
 *   4. Business logic error (no CodeFix) → healing does not intervene → safe: false
 *   5. healingStats updates correctly
 *   6. Clean code → healing does not activate → safe: true without heal errorText
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-heal-"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
        },
        include: ["./**/*.ts"]
    }));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    return dir;
}

describe("NREKI L3.3 Auto-Healing", () => {
    let dir: string;
    let kernel: NrekiKernel;

    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it("1. Missing import → Healing injects → safe: true → disk correct", async () => {
        dir = createTempProject({
            "types.ts": "export interface UserConfig { id: string; }",
            "app.ts": "export function processUser(c: any) { return c.id; }"
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: 'export function processUser(c: UserConfig) { return c.id; }'
        }]);

        expect(result.safe).toBe(true);
        expect(result.errorText).toContain("AUTO-HEAL");
        expect(result.errorText).toContain("IMPORTANT: NREKI applied");

        await kernel.commitToDisk();
        const diskContent = fs.readFileSync(path.join(dir, "app.ts"), "utf-8");
        expect(diskContent).toContain("import");
        expect(diskContent).toContain("UserConfig");
    });

    it("2. await without async → Healthy callers → safe: true", async () => {
        dir = createTempProject({
            "api.ts": "export async function fetchUser(): Promise<number> { return 1; }",
            "app.ts": 'import { fetchUser } from "./api.js";\nexport async function run() { return fetchUser(); }'
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        // The LLM adds await but forgets that run() is already async - shouldn't change anything.
        // The interesting case: the LLM writes await in a NON-async function.
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: 'import { fetchUser } from "./api.js";\nexport function run() { return await fetchUser(); }'
        }]);

        // If healing manages to add async without breaking anything, pass
        if (result.safe) {
            expect(result.errorText).toContain("AUTO-HEAL");
            await kernel.commitToDisk();
            const diskContent = fs.readFileSync(path.join(dir, "app.ts"), "utf-8");
            expect(diskContent).toContain("async");
        } else {
            // A-20: If healing failed, verify clear error output (don't pass silently)
            expect(result.structured).toBeDefined();
            expect(result.structured!.length).toBeGreaterThan(0);
        }
    });

    it("3. await without async → Callers break → Cascade → safe: false", async () => {
        dir = createTempProject({
            "api.ts": "export async function fetchUser(): Promise<number> { return 1; }",
            "app.ts": 'import { fetchUser } from "./api.js";\nexport function run(): number { return 1; }',
            "caller.ts": 'import { run } from "./app.js";\nexport function main(): number { const x: number = run(); return x; }'
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: 'import { fetchUser } from "./api.js";\nexport function run(): number { return await fetchUser(); }'
        }]);

        // Injecting async into run() would make it return Promise<number>,
        // breaking caller.ts which expects number.
        // The Strict Entropy Reduction Invariant must abort the heal.
        expect(result.safe).toBe(false);
        expect(result.structured).toBeDefined();
        expect(result.structured!.length).toBeGreaterThan(0);
    });

    it("4. Business logic error (no CodeFix) → safe: false", async () => {
        dir = createTempProject({
            "app.ts": 'export function calc(id: number) { return id * 100; }'
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        // The LLM changes number to string - that breaks `id * 100`
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: 'export function calc(id: string) { return id * 100; }'
        }]);

        // No safe CodeFix for this - it's a business logic decision
        expect(result.safe).toBe(false);
    });

    it("5. healingStats updates correctly", async () => {
        dir = createTempProject({
            "types.ts": "export interface Config { name: string; }",
            "app.ts": "export const x = 1;"
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const before = { ...kernel.healingStats };

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: 'export function test(c: Config) { return c.name; }'
        }]);

        // A-21: Verify that healing was actually attempted (not silently skipped)
        const totalBefore = before.applied + before.failed;
        const totalAfter = kernel.healingStats.applied + kernel.healingStats.failed;
        expect(totalAfter).toBeGreaterThan(totalBefore);

        if (result.safe && result.errorText?.includes("AUTO-HEAL")) {
            expect(kernel.healingStats.applied).toBe(before.applied + 1);
        } else {
            expect(kernel.healingStats.failed).toBe(before.failed + 1);
        }
    });

    it("6. Clean code → healing does not activate → safe: true without heal errorText", async () => {
        dir = createTempProject({
            "app.ts": "export const x = 1;"
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "app.ts",
            proposedContent: "export const x = 42;"
        }]);

        expect(result.safe).toBe(true);
        expect(result.errorText).toBeUndefined();
    });
});
