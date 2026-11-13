/**
 * detect-mode.ts - Chooses validation depth mode depending on project size.
 *
 * Selects between "syntax", "file", "project", and "hologram" validation depth
 * based on repository file count and language markers.
 */
import fs from "fs";
import path from "path";

/**
 * A project marker switches the kernel ON whatever the TS/JS file count:
 * Python-only and Go-only projects have zero TS files, and a TypeScript project
 * with fewer than 50 files used to get no type check at all — an edit that
 * broke its importer was written to disk with a "syntax only" footer. The
 * threshold dated from when a file-mode check cost seconds; with the parsed-file
 * cache it is ~180 ms on 48 files.
 */
const PROJECT_MARKERS = [
    "tsconfig.json", "jsconfig.json",
    "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
    "go.mod",
];

// Bounded DFS. Uses stack.pop() which is O(1) in V8.
// Array.shift() is O(N) in V8 because it reindexes the contiguous memory block.
// Do not change pop() to shift().
export function detectMode(dir: string): "syntax" | "file" | "project" | "hologram" {
    const hasProjectMarker = PROJECT_MARKERS.some(m =>
        fs.existsSync(path.join(dir, m))
    );

    let count = 0;
    const stack = [dir];
    const ignore = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage"]);

    while (stack.length > 0) {
        if (count > 1000) return "hologram";

        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); }
        catch { continue; }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!ignore.has(entry.name) && !entry.name.startsWith(".")) {
                    stack.push(path.join(current, entry.name));
                }
            } else if (
                /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(entry.name) &&
                !/\.d\.[mc]?ts$/i.test(entry.name)
            ) {
                count++;
            }
        }
    }

    // With a marker: never "syntax". "file" mode type-checks the edited files
    // plus their direct importers, and registers the LSP sidecars.
    if (hasProjectMarker) {
        if (count <= 200) return "file";
        return "project";
    }

    // No marker at all (the server only asks when one exists; kept for callers
    // that probe a bare folder): nothing to configure a checker from below 50 files.
    if (count < 50) return "syntax";
    if (count <= 200) return "file";
    return "project";
}
