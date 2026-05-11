/**
 * Phase 5 C.3.E.1 chunks utility tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    countLines,
    lineAtOffset,
    readFileChunk,
} from "../../../scripts/eval-phase5/utils/chunks.js";

describe("countLines", () => {
    it("returns 0 for empty string", () => {
        expect(countLines("")).toBe(0);
    });

    it("counts a single line without trailing newline", () => {
        expect(countLines("hello")).toBe(1);
    });

    it("counts two lines separated by a newline", () => {
        expect(countLines("a\nb")).toBe(2);
    });

    it("trailing newline does not add a phantom blank line", () => {
        expect(countLines("a\nb\n")).toBe(2);
    });

    it("counts five lines", () => {
        expect(countLines("a\nb\nc\nd\ne")).toBe(5);
    });
});

describe("lineAtOffset", () => {
    it("returns 1 for offset 0", () => {
        expect(lineAtOffset("hello\nworld", 0)).toBe(1);
    });

    it("returns 1 for offset inside the first line", () => {
        expect(lineAtOffset("hello\nworld", 3)).toBe(1);
    });

    it("returns 2 for offset after the first newline", () => {
        expect(lineAtOffset("hello\nworld", 6)).toBe(2);
    });

    it("clamps offsets beyond the text length to the last line", () => {
        const text = "a\nb\nc";
        expect(lineAtOffset(text, 1000)).toBe(3);
    });

    it("returns 1 for negative offset", () => {
        expect(lineAtOffset("a\nb", -5)).toBe(1);
    });
});

describe("readFileChunk", () => {
    let ws: string;
    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), "chunks-test-"));
    });
    afterEach(async () => {
        await fs.rm(ws, { recursive: true, force: true });
    });

    it("emits a file-level chunk covering the whole file", async () => {
        await fs.writeFile(path.join(ws, "a.ts"), "line1\nline2\nline3\n", "utf-8");
        const { chunk, text } = await readFileChunk(ws, "a.ts", 0.5);
        expect(chunk.file_path).toBe("a.ts");
        expect(chunk.start_line).toBe(1);
        expect(chunk.end_line).toBe(3);
        expect(chunk.score).toBe(0.5);
        expect(text).toBe("line1\nline2\nline3\n");
    });

    it("returns empty chunk + empty text when the file is missing", async () => {
        const { chunk, text } = await readFileChunk(ws, "does/not/exist.ts");
        expect(chunk.file_path).toBe("does/not/exist.ts");
        expect(chunk.start_line).toBe(1);
        expect(chunk.end_line).toBe(1);
        expect(text).toBe("");
    });
});
