/**
 * scripts/eval-phase5/utils/chunks.ts
 *
 * Shared helpers for retrofitting Phase 5 retrievers with the
 * universal ChunkResult shape (Furia round 20 Sub-2). File-level
 * retrievers (BM25, ripgrep, fast_grep file-mode) all need the same
 * "read file -> emit one ChunkResult covering the whole file" path;
 * sub-file retrievers (Voyage, Aider, NREKI) implement their own.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChunkResult } from "../types-runners.js";

export interface FileChunkPayload {
    chunk: ChunkResult;
    text: string;
}

/**
 * Count 1-indexed lines in a text buffer. A trailing newline is NOT
 * an additional line. Empty string returns 0.
 */
export function countLines(text: string): number {
    if (text.length === 0) return 0;
    let n = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) n++;
    }
    // If the last character is a newline, the "next line" is empty
    // and not counted as content.
    if (text.charCodeAt(text.length - 1) === 10) n--;
    return Math.max(n, 1);
}

/**
 * Compute the 1-indexed line number that contains the character at
 * `charOffset` in `text`. Used to map Voyage sliding-window chunk
 * offsets back to source line ranges.
 */
export function lineAtOffset(text: string, charOffset: number): number {
    if (charOffset <= 0) return 1;
    let line = 1;
    const limit = Math.min(charOffset, text.length);
    for (let i = 0; i < limit; i++) {
        if (text.charCodeAt(i) === 10) line++;
    }
    return line;
}

/**
 * Read a workspace file and return both the file-level ChunkResult
 * (covering the whole file) and the raw text for downstream
 * tokenisation. Errors (missing file, non-UTF8) yield an empty
 * chunk + empty text so the caller can degrade gracefully.
 */
export async function readFileChunk(
    workspaceRoot: string,
    relPath: string,
    score?: number,
): Promise<FileChunkPayload> {
    const abs = path.join(workspaceRoot, relPath);
    let text = "";
    try {
        text = await fs.readFile(abs, "utf-8");
    } catch {
        return {
            chunk: { file_path: relPath, start_line: 1, end_line: 1, score },
            text: "",
        };
    }
    const lines = countLines(text);
    return {
        chunk: {
            file_path: relPath,
            start_line: 1,
            end_line: Math.max(lines, 1),
            score,
        },
        text,
    };
}
