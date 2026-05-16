import fs from "fs";
import path from "path";

// Bounded DFS. Uses stack.pop() which is O(1) in V8.
// Array.shift() is O(N) in V8 because it reindexes the contiguous memory block.
// Do not change pop() to shift().
export function detectMode(dir: string): "syntax" | "file" | "project" | "hologram" {
    // Multi-lang project markers: presence forces kernel ON even when
    // TS/JS file count is 0 (Python-only, Go-only projects).
    const multiLangMarkers = [
        "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
        "go.mod",
    ];
    const hasMultiLangMarker = multiLangMarkers.some(m =>
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

    // With multi-lang marker: never return "syntax" -- force kernel ON
    // in "file" mode so LSP sidecars register and validate per-file.
    if (hasMultiLangMarker) {
        if (count <= 200) return "file";
        return "project";
    }

    // Original behavior for pure TS/JS projects
    if (count < 50) return "syntax";
    if (count <= 200) return "file";
    return "project";
}
