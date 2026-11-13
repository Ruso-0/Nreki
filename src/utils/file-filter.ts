/**
 * file-filter.ts - File size and extension filtering for NREKI.
 *
 * Prevents processing of binary files, minified bundles, lock files,
 * and oversized files that would waste resources.
 */

import path from "path";

/** Extensions that should never be processed (binary, minified, data). */
const BLOCKED_EXTENSIONS = new Set([
    ".min.js", ".min.css", ".map", ".wasm", ".bin",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
    ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar",
    ".lock", ".sqlite", ".db",
    ".mp3", ".mp4", ".wav", ".avi", ".mov",
    ".exe", ".dll", ".so", ".dylib",
    ".ttf", ".woff", ".woff2", ".eot",
    ".pyc", ".pyo", ".class",
]);

/** Maximum file size in bytes (500KB). */
const MAX_FILE_SIZE = 500_000;

/**
 * Directory names holding secondary code (tooling, tests, docs). The indexer
 * walks them last and fast_grep lists their hits after production code.
 */
export const SECONDARY_DIRS: ReadonlySet<string> = new Set([
    "scripts", "benchmarks", "bench", "docs", "examples",
    "tests", "test", "__tests__", "fixtures", "eval",
]);

/** True when a project-relative path lies in a secondary dir or is a test file. */
export function isSecondaryPath(relPath: string): boolean {
    const parts = relPath.replace(/\\/g, "/").toLowerCase().split("/");
    const base = parts[parts.length - 1] ?? "";
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /^test_.*\.py$|_test\.(py|go)$/.test(base)) return true;
    return parts.slice(0, -1).some(seg => SECONDARY_DIRS.has(seg));
}

/**
 * Check if a file should be processed based on its extension and size.
 *
 * @param filePath - Path to the file
 * @param size - File size in bytes
 * @returns true if the file should be processed, false to skip
 */
export function shouldProcess(filePath: string, size: number): {
    process: boolean;
    reason?: string;
} {
    // Check multi-part extensions first (e.g., .min.js)
    const basename = path.basename(filePath).toLowerCase();
    for (const blocked of BLOCKED_EXTENSIONS) {
        if (basename.endsWith(blocked)) {
            return { process: false, reason: `Blocked extension: ${blocked}` };
        }
    }

    // Check single extension
    const ext = path.extname(filePath).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
        return { process: false, reason: `Blocked extension: ${ext}` };
    }

    // Check size
    if (size > MAX_FILE_SIZE) {
        return { process: false, reason: `File too large: ${size} bytes (max ${MAX_FILE_SIZE})` };
    }

    return { process: true };
}

export { BLOCKED_EXTENSIONS, MAX_FILE_SIZE };
