/**
 * file-traits.ts — Preserve what NREKI's text pipeline cannot see.
 *
 * NREKI reads sources BOM-stripped (readSource) and writes through
 * temp+rename, which creates a NEW inode. Without care that silently:
 *   - drops a UTF-8 BOM,
 *   - resets POSIX permissions (0o755 scripts become 0o644),
 *   - corrupts legacy-encoded files (Latin-1 bytes decode to U+FFFD and are
 *     written back as U+FFFD).
 * (NREKI-INT-07)
 */

import fs from "fs";
import { createHash } from "crypto";

export interface FileTraits {
    /** File starts with the UTF-8 BOM (EF BB BF). */
    bom: boolean;
    /** Permission bits (POSIX). Undefined when the file did not exist. */
    mode?: number;
}

/** Inspect an existing file. A missing file yields neutral traits. */
export function captureFileTraits(filePath: string): FileTraits {
    let fd: number | undefined;
    try {
        const st = fs.statSync(filePath);
        fd = fs.openSync(filePath, "r");
        const head = Buffer.alloc(3);
        const n = fs.readSync(fd, head, 0, 3, 0);
        return {
            bom: n === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf,
            mode: st.mode & 0o7777,
        };
    } catch {
        return { bom: false };
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/** Re-attach the BOM if the original had one (idempotent). */
export function withTraits(content: string, traits: FileTraits): string {
    return traits.bom && content.charCodeAt(0) !== 0xfeff ? "﻿" + content : content;
}

/** Copy the original permission bits onto a freshly written temp file. */
export function applyModeTraits(tmpPath: string, traits: FileTraits): void {
    if (traits.mode === undefined || process.platform === "win32") return;
    try { fs.chmodSync(tmpPath, traits.mode); } catch { /* best effort */ }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Read a source file that NREKI is about to REWRITE. Refuses content it
 * cannot round-trip: NUL bytes (binary / UTF-16) or invalid UTF-8 (legacy
 * encodings such as Latin-1 / Windows-1252). Strips a leading BOM exactly
 * like readSource() so AST offsets stay aligned.
 */
export function readSourceForEdit(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) {
        throw new Error(
            `"${filePath}" contains NUL bytes (binary or UTF-16). NREKI only rewrites UTF-8 text files.`,
        );
    }
    let text: string;
    try {
        text = STRICT_UTF8.decode(buf);
    } catch {
        throw new Error(
            `"${filePath}" is not valid UTF-8 (legacy encoding such as Latin-1?). ` +
            `NREKI refuses to rewrite it because non-ASCII characters would be corrupted.`,
        );
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Stable digest of text content (BOM-insensitive callers pass stripped text). */
export function contentDigest(content: string | null): string {
    return content === null ? "<absent>" : createHash("sha256").update(content).digest("hex");
}

/** Dominant end-of-line sequence of a text ("\n" when there is none). */
export function detectEol(content: string): "\n" | "\r\n" {
    let crlf = 0;
    let lf = 0;
    for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
        if (i > 0 && content[i - 1] === "\r") crlf++;
        else lf++;
    }
    return crlf > lf ? "\r\n" : "\n";
}
