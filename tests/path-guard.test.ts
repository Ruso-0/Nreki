/**
 * path-guard.test.ts — unit coverage for src/utils/path-guard.ts.
 *
 * Pins the behavior contract that every handler can rely on:
 *   - regular file → ok
 *   - directory → {ok:false, kind:"directory"} + tool-appropriate hint
 *   - missing → {ok:false, kind:"missing"}
 *   - non-file types (FIFO etc.) → ok=false with the matching kind
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { validatePath } from "../src/utils/path-guard.js";

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-pathguard-"));
});

afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("validatePath", () => {
    it("regular file → ok", () => {
        const file = path.join(tmpDir, "real.ts");
        fs.writeFileSync(file, "export const x = 1;");

        const r = validatePath({ absolutePath: file, toolName: "read" });
        expect(r.ok).toBe(true);
        expect(r.kind).toBe("ok");
        expect(r.error).toBe("");
        expect(r.hint).toBe("");
    });

    it("directory → kind:directory with tool-specific hint", () => {
        const dir = path.join(tmpDir, "sub");
        fs.mkdirSync(dir, { recursive: true });

        const r = validatePath({ absolutePath: dir, toolName: "read", projectRoot: tmpDir });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe("directory");
        expect(r.error).toMatch(/Path is a directory/i);
        expect(r.hint).toMatch(/nreki_navigate/);
        expect(r.hint).toMatch(/outline|fast_grep|search/);
    });

    it("missing path → kind:missing with locate hint", () => {
        const missing = path.join(tmpDir, "does", "not", "exist.ts");

        const r = validatePath({ absolutePath: missing, toolName: "compress", projectRoot: tmpDir });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe("missing");
        expect(r.error).toMatch(/Path not found/i);
        expect(r.hint).toMatch(/fast_grep|outline/);
    });

    it("hint differs by toolName (read vs outline vs set_plan vs engram)", () => {
        const dir = path.join(tmpDir, "anotherSub");
        fs.mkdirSync(dir, { recursive: true });

        const r1 = validatePath({ absolutePath: dir, toolName: "read", projectRoot: tmpDir });
        const r2 = validatePath({ absolutePath: dir, toolName: "outline", projectRoot: tmpDir });
        const r3 = validatePath({ absolutePath: dir, toolName: "set_plan", projectRoot: tmpDir });
        const r4 = validatePath({ absolutePath: dir, toolName: "engram", projectRoot: tmpDir });

        expect(r1.hint).toMatch(/nreki_code action:"read"/);
        expect(r2.hint).toMatch(/outline operates on a single file/i);
        expect(r3.hint).toMatch(/Markdown plan file/i);
        expect(r4.hint).toMatch(/source file path/i);
    });

    it("does not throw on any input (structured-only contract)", () => {
        const candidates = [
            "",
            "/nonexistent/way/deep/file.ts",
            "/",
            tmpDir, // directory
        ];

        for (const p of candidates) {
            expect(() => validatePath({ absolutePath: p, toolName: "read" })).not.toThrow();
        }
    });

    it("relative display path falls back to userPath when projectRoot omitted", () => {
        const dir = path.join(tmpDir, "fallback-display");
        fs.mkdirSync(dir, { recursive: true });

        const r = validatePath({ absolutePath: dir, userPath: "given/path", toolName: "read" });
        expect(r.error).toContain("given/path");
    });
});

describe("validatePath — non-file types (best-effort coverage)", () => {
    // FIFO creation requires mkfifo (POSIX). On Windows it's not available,
    // so skip gracefully — the unit-level contract is exercised by the other
    // tests, and the type-routing is covered by inspection.
    it.skipIf(process.platform === "win32")("FIFO → kind:fifo", async () => {
        const fifoPath = path.join(tmpDir, "test.fifo");
        const { execSync } = await import("child_process");
        try {
            execSync(`mkfifo "${fifoPath}"`);
        } catch {
            return; // mkfifo missing on this POSIX too — best-effort skip
        }
        const r = validatePath({ absolutePath: fifoPath, toolName: "read" });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe("fifo");
        expect(r.hint).toMatch(/block the MCP server/i);
    });
});
