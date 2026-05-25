/**
 * path-guard.ts — DRY pre-read path validation.
 *
 * Centralizes the stat-based guard that every MCP handler needs before
 * it calls `readSource` / `fs.readFileSync`. Returns a structured result
 * instead of throwing, so handlers can produce a clean MCP `isError` reply
 * with an actionable hint rather than surfacing an opaque OS error
 * (EISDIR, ENOENT, blocking on a FIFO, etc.).
 *
 * History:
 * - v11.4.0 added an inline stat-guard to handleRead/handleCompress only.
 * - v11.4.1 user feedback + audit revealed 4+ other readSource callsites
 *   (set_plan, engram, outline via getFileSymbols, definition auto_context).
 * - v11.4.2 extracts the guard into this single helper so every callsite
 *   has identical behavior and future callsites can't accidentally regress.
 *
 * Furia review (docs/furia-v11.4.0-review.md Q5): FIFO/device-file handling
 * was deferred in v11.4.0 because no user had reported it. v11.4.2 closes
 * that gap too — `validatePath` rejects anything that is not a regular file.
 */

import fs from "fs";
import path from "path";

export type PathGuardKind = "ok" | "missing" | "directory" | "fifo" | "device" | "symlink_loop" | "other";

export interface PathGuardResult {
    /** True iff the path resolves to a regular readable file. */
    ok: boolean;
    /** Classification of why the path was rejected (or "ok"). */
    kind: PathGuardKind;
    /** Short, user-facing one-line summary. Empty when ok. */
    error: string;
    /** Actionable next-step hint pointing at the right tool. Empty when ok. */
    hint: string;
}

export interface ValidatePathOptions {
    /** Absolute path the handler is about to read. */
    absolutePath: string;
    /** Original path string the user supplied (used only for error formatting). */
    userPath?: string;
    /** Project root, for relative-path display. Optional. */
    projectRoot?: string;
    /**
     * Name of the tool/action being called, for the error hint
     * (e.g. "read", "compress", "outline", "set_plan", "engram").
     * Determines which alternative tool is recommended.
     */
    toolName: string;
}

/**
 * Stat the path and classify it. Never throws — every failure produces a
 * structured `{ok: false, ...}` result with a clean hint.
 *
 * Order of checks:
 *   1. fs.statSync. ENOENT → "missing". Other stat errors → "other".
 *   2. isDirectory → "directory".
 *   3. isFIFO / isSocket → "fifo" (would block readFileSync indefinitely).
 *   4. isBlockDevice / isCharacterDevice → "device".
 *   5. !isFile → "other" (catch-all for anything that isn't a normal file).
 *   6. Otherwise → ok.
 */
export function validatePath(opts: ValidatePathOptions): PathGuardResult {
    const { absolutePath, projectRoot, toolName } = opts;
    const userPath = opts.userPath ?? absolutePath;
    const displayPath = projectRoot
        ? (path.relative(projectRoot, absolutePath) || userPath)
        : userPath;

    let stat: fs.Stats;
    try {
        stat = fs.statSync(absolutePath);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return {
                ok: false,
                kind: "missing",
                error: `Path not found: ${displayPath}`,
                hint: `Use nreki_navigate action:"fast_grep" or action:"outline" to locate files first.`,
            };
        }
        if (code === "ELOOP") {
            return {
                ok: false,
                kind: "symlink_loop",
                error: `Symlink loop at: ${displayPath}`,
                hint: `Resolve the symlink or use the real path.`,
            };
        }
        return {
            ok: false,
            kind: "other",
            error: `Cannot read path ${displayPath}: ${(err as Error).message}`,
            hint: `Verify the path exists and is accessible.`,
        };
    }

    if (stat.isDirectory()) {
        return {
            ok: false,
            kind: "directory",
            error: `Path is a directory, not a file: ${displayPath}`,
            hint: directoryHint(toolName),
        };
    }

    if (stat.isFIFO() || stat.isSocket()) {
        return {
            ok: false,
            kind: "fifo",
            error: `Path is a ${stat.isFIFO() ? "named pipe (FIFO)" : "socket"}: ${displayPath}`,
            hint: `${toolName} reads regular files only. Reading a FIFO/socket would block the MCP server indefinitely.`,
        };
    }

    if (stat.isBlockDevice() || stat.isCharacterDevice()) {
        return {
            ok: false,
            kind: "device",
            error: `Path is a device file: ${displayPath}`,
            hint: `${toolName} reads regular files only.`,
        };
    }

    if (!stat.isFile()) {
        return {
            ok: false,
            kind: "other",
            error: `Path is not a regular file: ${displayPath}`,
            hint: `${toolName} reads regular files only.`,
        };
    }

    return { ok: true, kind: "ok", error: "", hint: "" };
}

function directoryHint(toolName: string): string {
    switch (toolName) {
        case "read":
        case "compress":
            return `nreki_code action:"${toolName}" operates on individual files. ` +
                `For a directory overview, use nreki_navigate action:"outline" on a specific file, ` +
                `or nreki_navigate action:"fast_grep" / "search" to locate symbols across the tree.`;
        case "outline":
            return `outline operates on a single file. ` +
                `For directory-wide discovery, use nreki_navigate action:"search" (semantic) ` +
                `or action:"fast_grep" (exact substring).`;
        case "set_plan":
            return `set_plan expects a Markdown plan file, not a directory. ` +
                `Pass the path to your plan file, e.g. set_plan text:"PLAN.md".`;
        case "engram":
            return `engram expects a source file path, not a directory. ` +
                `Anchor the engram to the file that contains the target symbol.`;
        case "prepare_refactor":
            return `prepare_refactor expects a single source file. Pass the file path that defines the symbol you want to rename.`;
        default:
            return `${toolName} operates on a single file path, not a directory.`;
    }
}
