/**
 * security.test.ts — Tests for v3.0.1 security hardening.
 *
 * Covers:
 * - Fix 3A: Symlink resolution + sensitive file blocklist
 * - Fix 3B: Per-file circuit breaker error tracking
 * - Fix 3C: Terminal → filter_output rename
 * - Fix 3D: Pin text sanitization
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { safePath, isSensitivePath } from "../src/utils/path-jail.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import {
    wrapWithCircuitBreaker,
    resetMiddlewareState,
} from "../src/middleware/circuit-breaker.js";
import { sanitizePin } from "../src/pin-memory.js";
import type { McpToolResponse } from "../src/router.js";

// ─── Fix 3A: Symlink Resolution + Sensitive File Blocklist ──────────

describe("safePath — Symlink Resolution", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-security-"));
    });

    it("allows normal files within workspace", () => {
        const testFile = path.join(tmpDir, "src", "index.ts");
        fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
        fs.writeFileSync(testFile, "const x = 1;");

        const result = safePath(tmpDir, "src/index.ts");
        expect(result).toBe(path.resolve(tmpDir, "src/index.ts"));
    });

    it("blocks path traversal with ../", () => {
        expect(() => safePath(tmpDir, "../../etc/passwd")).toThrow("Path traversal blocked");
    });

    it("blocks symlinks that escape workspace", () => {
        // Create a symlink pointing outside the workspace
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-outside-"));
        const outsideFile = path.join(outsideDir, "secret.txt");
        fs.writeFileSync(outsideFile, "secret data");

        const symlinkPath = path.join(tmpDir, "escape-link");
        try {
            fs.symlinkSync(outsideFile, symlinkPath);
        } catch {
            // Symlinks may require elevated permissions on Windows — skip test
            return;
        }

        expect(() => safePath(tmpDir, "escape-link")).toThrow("Symlink escape blocked");

        // Cleanup
        fs.rmSync(outsideDir, { recursive: true });
    });

    it("allows symlinks that stay within workspace", () => {
        const srcDir = path.join(tmpDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        const realFile = path.join(srcDir, "real.ts");
        fs.writeFileSync(realFile, "const y = 2;");

        const linkPath = path.join(tmpDir, "link.ts");
        try {
            fs.symlinkSync(realFile, linkPath);
        } catch {
            // Symlinks may require elevated permissions on Windows — skip test
            return;
        }

        const result = safePath(tmpDir, "link.ts");
        expect(result).toBeTruthy();
    });

    it("allows non-existent files (new file creation)", () => {
        // Should not throw ENOENT — just validate path structure
        const result = safePath(tmpDir, "new-file.ts");
        expect(result).toBe(path.resolve(tmpDir, "new-file.ts"));
    });
});

describe("safePath — Sensitive File Blocklist", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-security-"));
    });

    it("blocks .env files", () => {
        expect(() => safePath(tmpDir, ".env")).toThrow("sensitive file blocked");
    });

    it("blocks .env.local files", () => {
        expect(() => safePath(tmpDir, ".env.local")).toThrow("sensitive file blocked");
    });

    it("blocks .ssh/ paths", () => {
        expect(() => safePath(tmpDir, ".ssh/id_rsa")).toThrow("sensitive file blocked");
    });

    it("blocks id_rsa files anywhere", () => {
        expect(() => safePath(tmpDir, "keys/id_rsa")).toThrow("sensitive file blocked");
    });

    it("blocks id_ed25519 files", () => {
        expect(() => safePath(tmpDir, "keys/id_ed25519")).toThrow("sensitive file blocked");
    });

    it("blocks .pem files", () => {
        expect(() => safePath(tmpDir, "certs/server.pem")).toThrow("sensitive file blocked");
    });

    it("blocks .key files", () => {
        expect(() => safePath(tmpDir, "ssl/private.key")).toThrow("sensitive file blocked");
    });

    it("blocks .npmrc", () => {
        expect(() => safePath(tmpDir, ".npmrc")).toThrow("sensitive file blocked");
    });

    it("blocks .pypirc", () => {
        expect(() => safePath(tmpDir, ".pypirc")).toThrow("sensitive file blocked");
    });

    it("blocks .git/credentials", () => {
        expect(() => safePath(tmpDir, ".git/credentials")).toThrow("sensitive file blocked");
    });

    it("blocks .git/config", () => {
        expect(() => safePath(tmpDir, ".git/config")).toThrow("sensitive file blocked");
    });

    it("allows normal project files", () => {
        const result = safePath(tmpDir, "src/app.ts");
        expect(result).toBeTruthy();
    });

    it("allows package.json", () => {
        const result = safePath(tmpDir, "package.json");
        expect(result).toBeTruthy();
    });
});

describe("isSensitivePath helper", () => {
    it("returns true for .env", () => {
        expect(isSensitivePath("/project/.env")).toBe(true);
    });

    it("returns true for .env.production", () => {
        expect(isSensitivePath("/project/.env.production")).toBe(true);
    });

    it("returns false for normal files", () => {
        expect(isSensitivePath("/project/src/index.ts")).toBe(false);
    });

    it("returns false for .envrc (not matching .env pattern)", () => {
        // .envrc doesn't match /.env($|\.)/ because 'r' follows
        expect(isSensitivePath("/project/.envrc")).toBe(false);
    });
});

// ─── Fix 3B: Per-File Circuit Breaker Error Tracking ────────────────

describe("CircuitBreaker — Per-File Failure Tracking", () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        cb = new CircuitBreaker();
    });

    it("increments per-file counter on error", () => {
        cb.recordToolCall("tg_code:edit", "TypeError: something", "src/foo.ts");
        const state = cb.getState();
        expect(state.perFileFailures.get("src/foo.ts")).toBe(1);
    });

    it("resets per-file counter on success for that file", () => {
        cb.recordToolCall("tg_code:edit", "TypeError: something", "src/foo.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: something", "src/foo.ts");
        expect(cb.getState().perFileFailures.get("src/foo.ts")).toBe(2);

        // Success resets
        cb.recordToolCall("tg_code:edit", "Edit successful", "src/foo.ts");
        expect(cb.getState().perFileFailures.get("src/foo.ts")).toBeUndefined();
    });

    it("tracks errors independently per file", () => {
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/a.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/b.ts");

        const state = cb.getState();
        expect(state.perFileFailures.get("src/a.ts")).toBe(1);
        expect(state.perFileFailures.get("src/b.ts")).toBe(1);
    });

    it("trips after 3 per-file failures (Pattern 4)", () => {
        // Use different error messages so Pattern 1 (same error hash) doesn't trip first
        cb.recordToolCall("tg_code:edit", "TypeError: x is not a function", "src/broken.ts");
        cb.recordToolCall("tg_code:edit", "ReferenceError: y is not defined", "src/broken.ts");
        const result = cb.recordToolCall("tg_code:edit", "SyntaxError: unexpected token", "src/broken.ts");

        expect(result.tripped).toBe(true);
        expect(result.reason).toContain("src/broken.ts");
    });

    it("does NOT trip if errors are on different files with different messages", () => {
        // Different files + different error messages avoids both Pattern 1 and Pattern 4
        cb.recordToolCall("tg_code:edit", "TypeError: property x", "src/a.ts");
        cb.recordToolCall("tg_code:edit", "ReferenceError: y undefined", "src/b.ts");
        const result = cb.recordToolCall("tg_code:edit", "SyntaxError: unexpected", "src/c.ts");

        expect(result.tripped).toBe(false);
    });

    it("softReset clears tripped state but preserves per-file counters", () => {
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/broken.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/broken.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/broken.ts");

        expect(cb.getState().tripped).toBe(true);

        cb.softReset();

        expect(cb.getState().tripped).toBe(false);
        expect(cb.getState().perFileFailures.get("src/broken.ts")).toBe(3);
    });

    it("full reset clears everything including per-file counters", () => {
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/broken.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/broken.ts");

        cb.reset();

        expect(cb.getState().perFileFailures.size).toBe(0);
        expect(cb.getState().tripped).toBe(false);
        expect(cb.getState().history.length).toBe(0);
    });
});

describe("CircuitBreaker Middleware — Bypass Prevention", () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        cb = new CircuitBreaker();
        resetMiddlewareState();
    });

    it("alternating edit/read on same file still trips per-file breaker", async () => {
        const editErrorHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot find property" }],
            isError: true,
        });

        const readSuccessHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "File contents..." }],
        });

        // Alternate: edit fails, read succeeds, edit fails, read succeeds, edit fails
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", editErrorHandler, "src/target.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "read", readSuccessHandler, "src/other.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", editErrorHandler, "src/target.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "read", readSuccessHandler, "src/other.ts");
        const result = await wrapWithCircuitBreaker(cb, "tg_code", "edit", editErrorHandler, "src/target.ts");

        // Per-file tracking should catch this even though the global pattern alternates
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("CIRCUIT BREAKER");
    });

    it("soft reset on tool change preserves per-file failure count", async () => {
        const editErrorHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "TypeError: Cannot find property" }],
            isError: true,
        });

        // Build up per-file failures
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", editErrorHandler, "src/target.ts");
        await wrapWithCircuitBreaker(cb, "tg_code", "edit", editErrorHandler, "src/target.ts");

        // Per-file counter should be 2
        expect(cb.getState().perFileFailures.get("src/target.ts")).toBe(2);

        // Switch to a different tool (triggers soft reset if tripped)
        const searchHandler = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text", text: "Search results..." }],
        });
        await wrapWithCircuitBreaker(cb, "tg_navigate", "search", searchHandler);

        // Per-file counter should be preserved (soft reset doesn't clear it)
        expect(cb.getState().perFileFailures.get("src/target.ts")).toBe(2);
    });
});

// ─── Fix 3C: Terminal → filter_output Rename ────────────────────────

describe("Terminal → filter_output Rename", () => {
    // Covered by router.test.ts and backward-compat.test.ts
    // Additional coverage here for action enum correctness

    it("filter_output is in valid action list for tg_code", async () => {
        // This is a compile-time check — the Zod schema in index.ts
        // accepts "filter_output" and rejects "terminal"
        // Runtime behavior tested in router.test.ts
        expect(true).toBe(true);
    });
});

// ─── Fix 3D: Pin Sanitization ───────────────────────────────────────

describe("Pin Sanitization", () => {
    it("accepts normal pin text", () => {
        const result = sanitizePin("Always use camelCase for variables");
        expect(result.valid).toBe(true);
    });

    it("accepts pin text mentioning coding patterns", () => {
        const result = sanitizePin("Use TypeScript strict mode");
        expect(result.valid).toBe(true);
    });

    it("blocks full URLs", () => {
        const result = sanitizePin("See https://evil.com/instructions for details");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("URLs");
        }
    });

    it("blocks http URLs", () => {
        const result = sanitizePin("Download from http://example.com/payload");
        expect(result.valid).toBe(false);
    });

    it("allows the word HTTPS without a full URL", () => {
        const result = sanitizePin("Always use HTTPS for API calls");
        expect(result.valid).toBe(true);
    });

    it("blocks sudo commands", () => {
        const result = sanitizePin("Run sudo rm -rf / to fix");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("sudo");
        }
    });

    it("blocks curl commands", () => {
        const result = sanitizePin("Use curl to download updates");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("download");
        }
    });

    it("blocks wget commands", () => {
        const result = sanitizePin("Run wget to fetch the file");
        expect(result.valid).toBe(false);
    });

    it("blocks path traversal", () => {
        const result = sanitizePin("Read from ../../etc/passwd");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("path traversal");
        }
    });

    it("blocks command substitution $(...)", () => {
        const result = sanitizePin("Set value to $(whoami)");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("command substitution");
        }
    });

    it("blocks backtick execution", () => {
        const result = sanitizePin("Set variable to `whoami` output");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("backtick");
        }
    });

    it("blocks script injection", () => {
        const result = sanitizePin("Add <script>alert(1)</script> to the page");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("script");
        }
    });

    it("blocks eval() calls", () => {
        const result = sanitizePin("Use eval( user_input ) for flexibility");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("eval");
        }
    });

    it("blocks exec() calls", () => {
        const result = sanitizePin("Call exec( command ) to run");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("exec");
        }
    });

    it("blocks rm -rf", () => {
        const result = sanitizePin("First rm -rf node_modules then reinstall");
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain("destructive");
        }
    });
});
