/**
 * file-lock.test.ts - Tests for the file-level mutex (Fix 2).
 *
 * Verifies that concurrent edits to the same file are blocked,
 * while edits to different files proceed independently.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    acquireFileLock,
    releaseFileLock,
    resetFileLocks,
} from "../src/middleware/file-lock.js";

describe("File Lock", () => {
    beforeEach(() => {
        resetFileLocks();
    });

    afterEach(() => {
        resetFileLocks();
    });

    it("should acquire a lock on an unlocked file", () => {
        const result = acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        expect(result.acquired).toBe(true);
    });

    it("should fail to acquire a lock on an already-locked file", () => {
        acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        const result = acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        expect(result.acquired).toBe(false);
        if (!result.acquired) {
            expect(result.heldBy).toBe("nreki_code:edit");
            expect(result.heldForMs).toBeGreaterThanOrEqual(0);
        }
    });

    it("should allow re-acquisition after release", () => {
        acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        releaseFileLock("/project/src/utils.ts");
        const result = acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        expect(result.acquired).toBe(true);
    });

    it("should allow concurrent locks on DIFFERENT files", () => {
        const lock1 = acquireFileLock("/project/src/a.ts", "nreki_code:edit");
        const lock2 = acquireFileLock("/project/src/b.ts", "nreki_code:edit");
        expect(lock1.acquired).toBe(true);
        expect(lock2.acquired).toBe(true);
    });

    it("should normalize paths (case-insensitive, forward slashes)", () => {
        if (process.platform !== "win32") {
            // Case-insensitive path normalization only applies on Windows
            acquireFileLock("/project/SRC/utils.ts", "nreki_code:edit");
            const result = acquireFileLock("/project/SRC/utils.ts", "nreki_code:edit");
            expect(result.acquired).toBe(false);
        } else {
            acquireFileLock("D:\\Project\\SRC\\utils.ts", "nreki_code:edit");
            const result = acquireFileLock("d:/project/src/utils.ts", "nreki_code:edit");
            expect(result.acquired).toBe(false);
        }
    });

    it("should auto-expire stale locks after 30 seconds", () => {
        // Acquire a lock
        acquireFileLock("/project/src/stale.ts", "nreki_code:edit");

        // Mock time to 31 seconds later
        const originalNow = Date.now;
        Date.now = () => originalNow() + 31_000;

        try {
            // Should reclaim the stale lock
            const result = acquireFileLock("/project/src/stale.ts", "nreki_code:edit");
            expect(result.acquired).toBe(true);
        } finally {
            Date.now = originalNow;
        }
    });

    it("should not expire locks before 30 seconds", () => {
        acquireFileLock("/project/src/fresh.ts", "nreki_code:edit");

        const originalNow = Date.now;
        Date.now = () => originalNow() + 5_000; // 5 seconds later

        try {
            const result = acquireFileLock("/project/src/fresh.ts", "nreki_code:edit");
            expect(result.acquired).toBe(false);
        } finally {
            Date.now = originalNow;
        }
    });

    it("should clear all locks with resetFileLocks", () => {
        acquireFileLock("/project/src/a.ts", "nreki_code:edit");
        acquireFileLock("/project/src/b.ts", "nreki_code:edit");
        acquireFileLock("/project/src/c.ts", "nreki_code:edit");

        resetFileLocks();

        // All should be acquirable now
        expect(acquireFileLock("/project/src/a.ts", "nreki_code:edit").acquired).toBe(true);
        expect(acquireFileLock("/project/src/b.ts", "nreki_code:edit").acquired).toBe(true);
        expect(acquireFileLock("/project/src/c.ts", "nreki_code:edit").acquired).toBe(true);
    });

    it("releaseFileLock is idempotent (safe to call twice)", () => {
        acquireFileLock("/project/src/utils.ts", "nreki_code:edit");
        releaseFileLock("/project/src/utils.ts");
        releaseFileLock("/project/src/utils.ts"); // should not throw
        expect(acquireFileLock("/project/src/utils.ts", "nreki_code:edit").acquired).toBe(true);
    });
});
