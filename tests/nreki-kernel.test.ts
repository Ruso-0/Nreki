import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-test-"));

    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            strict: true,
            esModuleInterop: true,
            outDir: "dist",
            rootDir: ".",
            skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));

    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    return dir;
}

function cleanupTempProject(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
}

// ─── Standard fixture files ──────────────────────────────────────────

const AUTH_TS = `
export function getUserId(): number {
    return 42;
}
`;

const BILLING_TS = `
import { getUserId } from "./auth";

export function getBill(): number {
    const id: number = getUserId();
    return id * 10;
}
`;

// ─── Tests ───────────────────────────────────────────────────────────

describe("NREKI Kernel - Boot", () => {
    let dir: string;

    afterEach(() => {
        if (dir) cleanupTempProject(dir);
    });

    it("should boot successfully with a valid tsconfig.json project", () => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        expect(kernel.isBooted()).toBe(true);
        expect(kernel.getTrackedFiles()).toBeGreaterThan(0);
    });

    it("should throw if tsconfig.json is missing", () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-test-"));

        const kernel = new NrekiKernel();
        expect(() => kernel.boot(dir)).toThrow("tsconfig.json not found");
    });

    it("should track pre-existing errors in baseline", () => {
        dir = createTempProject({
            "bad.ts": `const x: number = "hello";`,
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        expect(kernel.isBooted()).toBe(true);
        expect(kernel.getBaselineErrorCount()).toBeGreaterThan(0);
    });
});

describe("NREKI Kernel - Semantic Validation", () => {
    let dir: string;
    let kernel: NrekiKernel;

    beforeEach(() => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);
    });

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should PASS a valid edit that preserves types", async () => {
        const authPath = path.resolve(dir, "auth.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `
export function getUserId(): number {
    return 99;
}
`,
        }]);

        expect(result.safe).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.latencyMs).toBeDefined();
    });

    it("should BLOCK an edit that breaks cross-file types", async () => {
        const authPath = path.resolve(dir, "auth.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `
export function getUserId(): string {
    return "not-a-number";
}
`,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
        expect(result.structured).toBeDefined();
        expect(result.structured!.length).toBeGreaterThan(0);

        // Should mention a type error
        const codes = result.structured!.map(e => e.code);
        expect(codes.some(c => c.startsWith("TS"))).toBe(true);
    });

    it("should PASS a batch edit that changes signature AND updates callers", async () => {
        const authPath = path.resolve(dir, "auth.ts");
        const billingPath = path.resolve(dir, "billing.ts");

        const result = await kernel.interceptAtomicBatch([
            {
                targetFile: authPath,
                proposedContent: `
export function getUserId(): string {
    return "user-42";
}
`,
            },
            {
                targetFile: billingPath,
                proposedContent: `
import { getUserId } from "./auth";

export function getBill(): string {
    const id: string = getUserId();
    return id + "-billed";
}
`,
            },
        ]);

        expect(result.safe).toBe(true);
        expect(result.exitCode).toBe(0);
    });

    it("should BLOCK if batch edit changes signature but NOT callers", async () => {
        const authPath = path.resolve(dir, "auth.ts");

        // Change auth to return string, but billing still expects number
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `
export function getUserId(): string {
    return "user-42";
}
`,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });
});

describe("NREKI Kernel - Syntactic Shield", () => {
    let dir: string;
    let kernel: NrekiKernel;

    beforeEach(() => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);
    });

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should BLOCK broken syntax even if semantics would pass", async () => {
        const authPath = path.resolve(dir, "auth.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `export function getUserId(): number { return const let; }`,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });

    it("should BLOCK totally invalid TypeScript", async () => {
        const authPath = path.resolve(dir, "auth.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `asdfjkl;asdfjkl; }{}{}{`,
        }]);

        expect(result.safe).toBe(false);
    });
});

describe("NREKI Kernel - Baseline Tolerance", () => {
    let dir: string;
    let kernel: NrekiKernel;

    beforeEach(() => {
        dir = createTempProject({
            "bad.ts": `const x: number = "hello";`,
            "good.ts": `export const y: number = 42;`,
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);
    });

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should NOT block edits when project has pre-existing errors", async () => {
        const goodPath = path.resolve(dir, "good.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: goodPath,
            proposedContent: `
export const y: number = 42;
export function helper(): boolean { return true; }
`,
        }]);

        expect(result.safe).toBe(true);
    });

    it("should BLOCK if a NEW error is introduced on top of pre-existing ones", async () => {
        const goodPath = path.resolve(dir, "good.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: goodPath,
            proposedContent: `export const y: number = "also bad";`,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });
});

describe("NREKI Kernel - File Operations", () => {
    let dir: string;
    let kernel: NrekiKernel;

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should handle file deletion (tombstone) without panic", async () => {
        dir = createTempProject({
            "auth.ts": AUTH_TS,
            "standalone.ts": `export const MAGIC = 42;`,
        });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        // Delete standalone.ts - nothing imports it
        const standalonePath = path.resolve(dir, "standalone.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: standalonePath,
            proposedContent: null,
        }]);

        expect(result.safe).toBe(true);
    });

    it("should BLOCK deletion of a file that others depend on", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        // Delete auth.ts - billing.ts imports from it
        const authPath = path.resolve(dir, "auth.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: null,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });

    it("should ignore non-TypeScript files (no rootNames pollution)", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const readmePath = path.resolve(dir, "README.md");
        const trackedBefore = kernel.getTrackedFiles();

        const result = await kernel.interceptAtomicBatch([{
            targetFile: readmePath,
            proposedContent: "# Hello World",
        }]);

        expect(result.safe).toBe(true);
        // README.md should NOT increase tracked TS files
        expect(kernel.getTrackedFiles()).toBe(trackedBefore);
    });

    it("should handle new TypeScript files in new directories", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const newFilePath = path.resolve(dir, "src", "features", "newFile.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: newFilePath,
            proposedContent: `export function newFeature(): boolean { return true; }`,
        }]);

        expect(result.safe).toBe(true);
    });
});

describe("NREKI Kernel - ACID Operations", () => {
    let dir: string;
    let kernel: NrekiKernel;

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should commit staged changes to disk", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const authPath = path.resolve(dir, "auth.ts");
        const newContent = `
export function getUserId(): number {
    return 999;
}
`;

        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: newContent,
        }]);
        expect(result.safe).toBe(true);

        await kernel.commitToDisk();

        const diskContent = fs.readFileSync(authPath, "utf-8");
        expect(diskContent).toBe(newContent);
        expect(kernel.getStagingSize()).toBe(0);
    });

    it("should rollback all staged changes", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const authPath = path.resolve(dir, "auth.ts");
        const originalContent = fs.readFileSync(authPath, "utf-8");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `
export function getUserId(): number {
    return 999;
}
`,
        }]);
        expect(result.safe).toBe(true);
        expect(kernel.getStagingSize()).toBeGreaterThan(0);

        await kernel.rollbackAll();

        expect(kernel.getStagingSize()).toBe(0);
        // Disk should still have original content
        const diskContent = fs.readFileSync(authPath, "utf-8");
        expect(diskContent).toBe(originalContent);
    });

    it("should revert VFS on failed intercept (no staging leak)", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        kernel = new NrekiKernel();
        kernel.boot(dir);

        const stagingBefore = kernel.getStagingSize();
        const authPath = path.resolve(dir, "auth.ts");

        // This breaks billing.ts → should fail
        const result = await kernel.interceptAtomicBatch([{
            targetFile: authPath,
            proposedContent: `
export function getUserId(): string {
    return "not-a-number";
}
`,
        }]);

        expect(result.safe).toBe(false);
        // VFS should be reverted - same staging size as before
        expect(kernel.getStagingSize()).toBe(stagingBefore);
    });
});

describe("NREKI Kernel - Concurrency", () => {
    let dir: string;

    afterEach(() => {
        cleanupTempProject(dir);
    });

    it("should serialize concurrent intercepts via mutex", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const authPath = path.resolve(dir, "auth.ts");

        // Fire 3 concurrent valid edits
        const results = await Promise.all([
            kernel.interceptAtomicBatch([{
                targetFile: authPath,
                proposedContent: `export function getUserId(): number { return 1; }`,
            }]),
            kernel.interceptAtomicBatch([{
                targetFile: authPath,
                proposedContent: `export function getUserId(): number { return 2; }`,
            }]),
            kernel.interceptAtomicBatch([{
                targetFile: authPath,
                proposedContent: `export function getUserId(): number { return 3; }`,
            }]),
        ]);

        // All should complete without throwing
        for (const r of results) {
            expect(r.safe).toBe(true);
            expect(r.exitCode).toBe(0);
        }
    });
});

describe("NREKI Kernel - Edge Cases", () => {
    let dir: string;

    afterEach(() => {
        if (dir) cleanupTempProject(dir);
    });

    it("should handle empty batch gracefully", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const result = await kernel.interceptAtomicBatch([]);
        expect(result.safe).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.latencyMs).toBe("0.00");
    });

    it("should handle duplicate files in batch (P25 - idempotent undo-log)", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const authPath = path.resolve(dir, "auth.ts");

        // Two edits to the same file - last one wins
        // Final state returns string, which breaks billing.ts
        const result = await kernel.interceptAtomicBatch([
            {
                targetFile: authPath,
                proposedContent: `export function getUserId(): number { return 100; }`,
            },
            {
                targetFile: authPath,
                proposedContent: `export function getUserId(): string { return "bad"; }`,
            },
        ]);

        // Last edit wins - returns string, breaks billing → should fail
        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
    });

    it("should handle duplicate files where final state is valid", async () => {
        dir = createTempProject({ "auth.ts": AUTH_TS, "billing.ts": BILLING_TS });
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const authPath = path.resolve(dir, "auth.ts");

        // Two edits - first breaks it, second fixes it
        const result = await kernel.interceptAtomicBatch([
            {
                targetFile: authPath,
                proposedContent: `export function getUserId(): string { return "bad"; }`,
            },
            {
                targetFile: authPath,
                proposedContent: `export function getUserId(): number { return 100; }`,
            },
        ]);

        // Last edit wins - returns number, billing happy → should pass
        expect(result.safe).toBe(true);
    });
});

// ─── LT-1: VFS Staging Leak Test ─────────────────────────────────────

describe("NREKI Precision - VFS Staging Leak (LT-1)", () => {
    it("should not leak VFS state between consecutive intercepts", async () => {
        const dir = createTempProject({
            "auth.ts": 'export function getUserId(): number { return 1; }',
            "billing.ts": 'import { getUserId } from "./auth";\nconst id: number = getUserId();',
        });

        const kernel = new NrekiKernel();
        kernel.boot(dir);

        // First intercept: valid edit (change body, keep type)
        const result1 = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "auth.ts"),
            proposedContent: 'export function getUserId(): number { return 42; }',
        }]);
        expect(result1.safe).toBe(true);

        // Clear VFS (simulates what the router should do after LT-1 fix)
        await kernel.rollbackAll();

        // Second intercept: DIFFERENT valid edit
        const result2 = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "auth.ts"),
            proposedContent: 'export function getUserId(): number { return 99; }',
        }]);
        expect(result2.safe).toBe(true);

        // Third intercept: BREAKING edit - must still be caught
        const result3 = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "auth.ts"),
            proposedContent: 'export function getUserId(): string { return "bad"; }',
        }]);
        expect(result3.safe).toBe(false);

        cleanupTempProject(dir);
    });
});

// ─── FP-2: node_modules Error Filter Test ────────────────────────────
// NOTE (A-17): This tests inline JS logic, not NREKI kernel behavior.
// A proper test would inject an edit triggering node_modules errors and verify interceptAtomicBatch passes.

describe("NREKI Precision - node_modules Filter (FP-2)", () => {
    it("should not count node_modules errors as agent-caused", () => {
        const mockStructured = [
            { file: "/project/node_modules/@types/express/index.d.ts", line: 1, column: 1, code: "TS2345", message: "Type error in express" },
            { file: "/project/src/auth.ts", line: 10, column: 5, code: "TS2322", message: "Agent broke this" },
        ];

        const agentErrors = mockStructured.filter(e => !e.file.includes("node_modules"));
        expect(agentErrors.length).toBe(1);
        expect(agentErrors[0].file).toContain("auth.ts");
    });

    it("should pass if ALL errors are from node_modules", () => {
        const mockStructured = [
            { file: "/project/node_modules/@types/node/index.d.ts", line: 1, column: 1, code: "TS2300", message: "Duplicate identifier" },
            { file: "/project/node_modules/some-lib/dist/types.d.ts", line: 5, column: 1, code: "TS2345", message: "Type mismatch" },
        ];

        const agentErrors = mockStructured.filter(e => !e.file.includes("node_modules"));
        expect(agentErrors.length).toBe(0);
    });
});

// ─── FP-3: Restore Failure Handling Test ─────────────────────────────
// NOTE (A-18): This tests inline string formatting, not NREKI commitToDisk rollback behavior.

describe("NREKI Precision - Restore Failure Handling (FP-3)", () => {
    it("should warn when backup restoration fails", () => {
        const restoreFailures: string[] = ["src/auth.ts"];

        const diskStatus = restoreFailures.length > 0
            ? `WARNING: Backup restoration FAILED for: ${restoreFailures.join(", ")}.`
            : `All files have been reverted - disk is clean.`;

        expect(diskStatus).toContain("FAILED");
        expect(diskStatus).toContain("auth.ts");
    });

    it("should report clean disk when restoration succeeds", () => {
        const restoreFailures: string[] = [];

        const diskStatus = restoreFailures.length > 0
            ? `WARNING: Backup restoration FAILED`
            : `All files have been reverted - disk is clean.`;

        expect(diskStatus).toContain("clean");
    });
});

// ─── LT-3: Timeout Test ─────────────────────────────────────────────
// NOTE (A-19): This tests Promise.race semantics, not NREKI's AsyncMutex timeout.

describe("NREKI Precision - Timeout (LT-3)", () => {
    it("should resolve with fallback on timeout", async () => {
        const slowPromise = new Promise<{ safe: boolean }>((resolve) => {
            setTimeout(() => resolve({ safe: false }), 60_000);
        });

        const result = await Promise.race([
            slowPromise,
            new Promise<{ safe: boolean; timedOut: boolean }>((resolve) =>
                setTimeout(() => resolve({ safe: true, timedOut: true }), 100)
            ),
        ]);

        expect(result.safe).toBe(true);
    });
});
