/**
 * repo-map.ts - Static repository map for Anthropic prompt cache optimization.
 *
 * Generates a deterministic text representation of all file signatures,
 * exports, and imports. Same repo state produces identical text output,
 * enabling Anthropic's prompt caching ($0.30/M vs $3.00/M input tokens).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ASTParser } from "./parser.js";
import { shouldProcess } from "./utils/file-filter.js";
import { readSource } from "./utils/read-source.js";
import { escapeRegExp } from "./utils/imports.js";
import { signState, verifyState } from "./utils/trust.js";
import { isSensitivePath, writeStateFile } from "./utils/path-jail.js";
import { logger } from "./utils/logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface RepoMapEntry {
    filePath: string;
    exports: string[];
    signatures: string[];
    imports: string[];
    lineCount: number;
    purpose?: string;
    /**
     * Extra import candidates read only by the dependency graph (never rendered):
     * Python `from pkg import mod` → "pkg.mod", imports inside functions, and
     * `import a, b` split per module.
     */
    graphImports?: string[];
}

/** A Go module of the project: directory of its go.mod (posix, "" = root) and its module path. */
export interface GoModule {
    dir: string;
    modulePath: string;
}

export interface GraphOptions {
    goModules?: GoModule[];
}

export interface RepoMap {
    version: string;
    generatedAt: string;
    totalFiles: number;
    totalLines: number;
    entries: RepoMapEntry[];
    graph?: DependencyGraph;
}

/** Cache format version. Bump when CachedRepoMap structure changes. */
const CACHE_FORMAT_VERSION = 5; // 5: Go package + Python relative/package edges in the graph

export interface CachedRepoMap {
    formatVersion?: number;
    digest: string;
    map: RepoMap;
    text: string;
    graph?: DependencyGraphData;
}

export interface DependencyGraph {
    /** Files that import this file (reverse edges). */
    importedBy: Map<string, Set<string>>;
    /** Number of files importing each file. */
    inDegree: Map<string, number>;
    /** Tier classification by in-degree percentile. */
    tiers: Map<string, "core" | "logic" | "leaf">;
    clusters?: Map<string, "cluster_a" | "cluster_b" | "bridge" | "orphan">;
    v2Score?: Map<string, number>;
    fiedler?: number;
}

/** JSON-serializable form of DependencyGraph for caching. */
interface DependencyGraphData {
    importedBy: Record<string, string[]>;
    inDegree: Record<string, number>;
    tiers: Record<string, "core" | "logic" | "leaf">;
    clusters?: Record<string, "cluster_a" | "cluster_b" | "bridge" | "orphan">;
    v2Score?: Record<string, number>;
    fiedler?: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([
    ".ts", ".tsx", ".mts", ".cts",
    ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go",
    ".css", ".json", ".html",
    ".kt", ".kts",
    ".java",
    ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
    ".c", ".h",
]);

const IGNORE_DIRS = new Set([
    "node_modules", "dist", "build", ".git", "coverage",
    ".next", "__pycache__", ".nreki",
]);

const STRIP_KEYWORD = /^(?:export|default|declare|abstract|public|private|protected|static|readonly|async|function|class|interface|type|enum|const|let|var|def|func)\s+/;

/** Byte-identical comparator - same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Extraction Helpers ─────────────────────────────────────────────

/** Extract signature from raw AST code (everything before opening `{` or `:` for Python). */
export function extractSignature(rawCode: string): string {
    const lines = rawCode.split("\n");

    let parenDepth = 0;
    let angleDepth = 0;
    let braceDepthInTemplate = 0;
    let inString: string | null = null;
    let inTemplateExpr = false;
    let topLevelAssignmentSeen = false;

    for (let i = 0; i < rawCode.length; i++) {
        const ch = rawCode[i];

        // Track string state - skip everything inside strings
        if (inString) {
            if (ch === "\\" && i + 1 < rawCode.length) {
                i++; // Skip escaped character
            } else if (inString === '`' && ch === '$' && i + 1 < rawCode.length && rawCode[i + 1] === '{') {
                // Enter template expression ${...}
                inTemplateExpr = true;
                braceDepthInTemplate = 1;
                inString = null;
                i++; // skip the {
            } else if (ch === inString) {
                inString = null;
            }
            continue;
        }

        // Track closing of template expressions with proper brace nesting
        if (inTemplateExpr) {
            if (ch === '{') {
                braceDepthInTemplate++;
            } else if (ch === '}') {
                braceDepthInTemplate--;
                if (braceDepthInTemplate === 0) {
                    inTemplateExpr = false;
                    inString = '`'; // Re-enter template literal
                }
            }
            // Track strings inside template expressions too
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch;
            }
            continue;
        }

        // Detect string start
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = ch;
            continue;
        }

        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === "<") angleDepth++;
        else if (ch === ">" && !(i > 0 && rawCode[i - 1] === "=")) angleDepth = Math.max(0, angleDepth - 1);
        else if (ch === "=" && i + 1 < rawCode.length && rawCode[i + 1] === ">" &&
                 parenDepth === 0 && angleDepth === 0 && topLevelAssignmentSeen) {
            return rawCode.slice(0, i + 2).trim();
        } else if (ch === "=" && parenDepth === 0 && angleDepth === 0) {
            topLevelAssignmentSeen = true;
        }
        else if (ch === "{" && parenDepth === 0 && angleDepth === 0) {
            return rawCode.slice(0, i).trim();
        }
        // A-02: Python colon - only match at depth 0 (skip colons inside type hints)
        else if (ch === ":" && parenDepth === 0 && angleDepth === 0) {
            if (/^(?:async\s+)?def\s|^class\s/.test(rawCode)) {
                return rawCode.slice(0, i).trim();
            }
        }
    }

    return lines[0].trim();
}

/** Strip keyword prefixes from a signature, leaving just name + params + return type. */
export function cleanSignature(rawSig: string): string {
    let sig = rawSig.trim();
    let prev = "";
    while (prev !== sig) {
        prev = sig;
        sig = sig.replace(STRIP_KEYWORD, "");
    }
    return sig;
}

/** Extract exported symbol names from file content using regex. */
export function extractExports(content: string, ext: string): string[] {
    const exports = new Set<string>();

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
        // export function/class/interface/type/enum/const name
        const declRe = /export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+(\w+)/g;
        let m;
        while ((m = declRe.exec(content)) !== null) {
            exports.add(m[1]);
        }
        // export { name1, name2 }
        const namedRe = /export\s*\{([^}]+)\}/g;
        while ((m = namedRe.exec(content)) !== null) {
            for (const name of m[1].split(",")) {
                const clean = name.trim().split(/\s+as\s+/).pop()!.trim();
                if (clean && /^\w+$/.test(clean)) exports.add(clean);
            }
        }
    } else if (ext === ".py") {
        // Python: top-level def/class (non-underscore) are public
        const pyRe = /^(?:async\s+)?(?:def|class)\s+(\w+)/gm;
        let m;
        while ((m = pyRe.exec(content)) !== null) {
            if (!m[1].startsWith("_")) exports.add(m[1]);
        }
    } else if (ext === ".go") {
        // Go: capitalized names are exported
        const goRe = /^(?:func|type)\s+(?:\([^)]*\)\s+)?([A-Z]\w*)/gm;
        let m;
        while ((m = goRe.exec(content)) !== null) {
            exports.add(m[1]);
        }
    }

    return [...exports].sort(stableCompare);
}

/** Extract import module names from file content. */
export function extractImports(content: string, ext: string): string[] {
    const imports = new Set<string>();

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
        const fromRe = /from\s+["']([^"']+)["']/g;
        let m;
        while ((m = fromRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
        const reqRe = /require\(["']([^"']+)["']\)/g;
        while ((m = reqRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
        const dynRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
        while ((m = dynRe.exec(content)) !== null) imports.add(m[1]);
        const sideRe = /^\s*import\s+["']([^"']+)["']/gm;
        while ((m = sideRe.exec(content)) !== null) imports.add(m[1]);
    } else if (ext === ".py") {
        const pyFromRe = /^from\s+(\S+)\s+import/gm;
        let m;
        while ((m = pyFromRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
        const pyImportRe = /^import\s+(\S+)/gm;
        while ((m = pyImportRe.exec(content)) !== null) {
            imports.add(m[1]);
        }
    } else if (ext === ".go") {
        const importBlocks = content.match(/import\s*\([\s\S]*?\)|import\s+"[^"]+"/g);
        if (importBlocks) {
            const goRe = /"([^"]+)"/g;
            for (const block of importBlocks) {
                let m;
                while ((m = goRe.exec(block)) !== null) {
                    imports.add(m[1]);
                }
            }
        }
    }

    return [...imports].sort(stableCompare);
}

/**
 * Python import candidates that `extractImports` does not produce (it feeds the
 * rendered map and stays as it is): `from X import a, b` → "X.a", "X.b" (a
 * submodule is imported this way as often as a name), imports nested in a
 * function or class, and every module of `import a, b`.
 */
export function extractPythonGraphImports(content: string): string[] {
    const out = new Set<string>();
    const fromRe = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n#]*))/gm;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(content)) !== null) {
        const mod = m[1];
        if (!mod) continue;
        out.add(mod);
        for (const raw of (m[2] ?? m[3] ?? "").split(",")) {
            const name = raw.replace(/#.*$/gm, "").trim().split(/\s+as\s+/)[0].trim();
            if (/^\w+$/.test(name)) out.add(mod.endsWith(".") ? mod + name : `${mod}.${name}`);
        }
    }
    const importRe = /^[ \t]*import[ \t]+([^\n#]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
        for (const raw of m[1].split(",")) {
            const name = raw.trim().split(/\s+as\s+/)[0].trim();
            if (/^[\w.]+$/.test(name)) out.add(name);
        }
    }
    return [...out].sort(stableCompare);
}

/** go.mod files above the project's Go sources (a Go import is module path + directory). */
export function findGoModules(projectRoot: string, relFiles: string[]): GoModule[] {
    const dirs = new Set<string>();
    for (const f of relFiles) {
        if (!f.endsWith(".go")) continue;
        let d = path.posix.dirname(f.replace(/\\/g, "/"));
        while (!dirs.has(d)) {
            dirs.add(d);
            if (d === ".") break;
            d = path.posix.dirname(d);
        }
    }
    const modules: GoModule[] = [];
    for (const d of [...dirs].sort(stableCompare)) {
        try {
            const text = fs.readFileSync(path.join(projectRoot, d, "go.mod"), "utf8");
            const m = /^[ \t]*module[ \t]+(\S+)/m.exec(text);
            if (m) modules.push({ dir: d === "." ? "" : d, modulePath: m[1].replace(/^"|"$/g, "") });
        } catch { /* no go.mod in this directory */ }
    }
    return modules;
}

/** Shorten an import path for display: strip leading ./ and trailing .js/.ts */
function shortenImport(imp: string): string {
    return imp.replace(/^\.\//, "").replace(/\.js$|\.ts$/, "");
}

// ─── Directory Walking ──────────────────────────────────────────────

function walkFiles(dirPath: string): string[] {
    const files: string[] = [];

    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        // Sort directory entries for deterministic walk order
        entries.sort((a, b) => stableCompare(a.name, b.name));

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // v11.2.1: skip dot-prefixed directories (mirrors indexer.walkDirectory).
                // Pre-v11.2.1 the repo-map walk was synchronous and traversed
                // heavy dot-trees (.venv*, .eval-phase5-cache, .turbo, .cache),
                // blocking the MCP event loop on first search()/map() call.
                if (entry.name.startsWith(".")) continue;
                if (!IGNORE_DIRS.has(entry.name)) walk(fullPath);
                continue;
            }
            // Same jail as the read tools: no symlinks (they can point outside
            // the project), no sensitive files.
            if (entry.isSymbolicLink() || isSensitivePath(fullPath)) continue;

            const ext = path.extname(entry.name).toLowerCase();
            if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

            // Skip .d.ts files (auto-generated type definitions)
            if (entry.name.endsWith(".d.ts")) continue;

            try {
                const stat = fs.statSync(fullPath);
                const filter = shouldProcess(fullPath, stat.size);
                if (filter.process) files.push(fullPath);
            } catch {
                // Skip inaccessible files
            }
        }
    };

    walk(dirPath);
    return files.sort(stableCompare);
}

// ─── PageRank ───────────────────────────────────────────────────────

/**
 * PageRank via Power Iteration on a Markov Chain.
 * PR(A) = (1-d)/N + d * Σ (PR(Ti) / OutDegree(Ti))
 * Convergence for 5,000 files: < 8ms (20 iterations).
 *
 * @param files All file paths in the project
 * @param importedBy Reverse dependency map: file → set of files that import it
 * @returns Map of file → normalized PageRank score (0 to 1)
 */
export function computePageRank(
    files: string[],
    importedBy: Map<string, Set<string>>,
): Map<string, number> {
    const N = files.length;
    let pr = new Map<string, number>();
    if (N === 0) return pr;

    const d = 0.85; // Standard damping factor
    const outDegree = new Map<string, number>();

    // Initialize uniform distribution
    for (const f of files) {
        pr.set(f, 1 / N);
        outDegree.set(f, 0);
    }

    // Compute out-degree (how many things each file imports)
    for (const consumers of importedBy.values()) {
        for (const consumer of consumers) {
            outDegree.set(consumer, (outDegree.get(consumer) || 0) + 1);
        }
    }

    // Power iteration (20 cycles is sufficient for convergence)
    for (let iter = 0; iter < 20; iter++) {
        const nextPr = new Map<string, number>();

        // Sink nodes: files that don't import anything (rank leaks without redistribution)
        let sinkSum = 0;
        for (const f of files) {
            if (outDegree.get(f) === 0) sinkSum += pr.get(f)!;
        }

        for (const target of files) {
            let rankSum = 0;
            const consumers = importedBy.get(target);
            if (consumers) {
                for (const consumer of consumers) {
                    rankSum += pr.get(consumer)! / (outDegree.get(consumer) || 1);
                }
            }
            nextPr.set(target, ((1 - d) / N) + d * (rankSum + sinkSum / N));
        }
        pr = nextPr;
    }

    // Normalize to 0-1 range for percentile calculation
    let maxPr = 0;
    for (const rank of pr.values()) {
        if (rank > maxPr) maxPr = rank;
    }
    if (maxPr > 0) {
        for (const [file, rank] of pr.entries()) {
            pr.set(file, rank / maxPr);
        }
    }

    return pr;
}

// ─── Dependency Graph ───────────────────────────────────────────────

/**
 * Build a fast-lookup index for resolving imports to file paths in O(1).
 * Maps extensionless, with-extension, src/-stripped, and index-collapsed variants.
 */
/**
 * Build a fast-lookup index for resolving imports to file paths in O(1).
 * Maps extensionless, with-extension, src/-stripped, index-collapsed variants,
 * AND Monorepo Workspaces.
 */
export function buildFastLookup(allFiles: string[]): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const file of allFiles) {
        const normalized = file.replace(/\\/g, "/");
        const noExt = normalized.replace(/\.[^/.]+$/, "");
        lookup.set(noExt, normalized);
        lookup.set(normalized, normalized);
        if (noExt.startsWith("src/")) {
            lookup.set(noExt.slice(4), normalized);
        }
        if (noExt.endsWith("/index")) {
            const dir = noExt.slice(0, -6);
            lookup.set(dir, normalized);
            if (dir.startsWith("src/")) {
                lookup.set(dir.slice(4), normalized);
            }
        }
        // Python package: `import pkg` / `from pkg import x` reads pkg/__init__.py
        // (a module file pkg.py, if both exist, keeps the key).
        if (noExt.endsWith("/__init__")) {
            const dir = noExt.slice(0, -9);
            if (!lookup.has(dir)) lookup.set(dir, normalized);
            if (dir.startsWith("src/") && !lookup.has(dir.slice(4))) lookup.set(dir.slice(4), normalized);
        }
        const match = noExt.match(/^(?:packages|workspaces|libs|apps)\/([^/]+)\/(?:src\/|lib\/)?(.*)$/);
        if (match) {
            const pkgName = match[1];
            const internalPath = match[2];
            const aliasKey = internalPath ? `${pkgName}/${internalPath}` : pkgName;
            lookup.set(aliasKey, normalized);
            if (internalPath.endsWith("/index")) {
                const dirAlias = internalPath.slice(0, -6);
                lookup.set(dirAlias ? `${pkgName}/${dirAlias}` : pkgName, normalized);
            }
        }
    }
    return lookup;
}
/**
 * Resolve an import string to an actual project file path.
 * Returns null for external dependencies.
 */
export function resolveImportFast(
    importStr: string,
    currentFile: string,
    lookup: Map<string, string>,
): string | null {
    // Python relative import: ".mod", "..pkg.mod", "." — dots then a dotted name,
    // never a "/". It used to be joined as a path ("pkg/.mod") and never resolved.
    if (currentFile.endsWith(".py") && /^\.+[\w.]*$/.test(importStr)) {
        const rest = importStr.replace(/^\.+/, "");
        const dots = importStr.length - rest.length;
        let dir = path.posix.dirname(currentFile.replace(/\\/g, "/"));
        for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
        const joined = path.posix.join(dir, rest.split(".").filter(Boolean).join("/"));
        const key = joined === "." ? "" : joined;
        return lookup.get(key) ?? lookup.get(key ? `${key}/__init__` : "__init__") ?? null;
    }
    if (!importStr.startsWith(".") && !importStr.startsWith("/") && !importStr.startsWith("@/")) {
        let resolved = lookup.get(importStr);
        if (resolved) return resolved;
        if (importStr.startsWith("@")) {
            const parts = importStr.split("/");
            if (parts.length > 1) {
                const withoutOrg = parts.slice(1).join("/");
                resolved = lookup.get(withoutOrg);
                if (resolved) return resolved;
            }
        }
        // Python dot-notation: "app.core.auth" → "app/core/auth"
        if (importStr.includes(".") && !importStr.includes("/")) {
            const asPath = importStr.replace(/\./g, "/");
            const resolved = lookup.get(asPath);
            if (resolved) return resolved;
            // Try without top-level package: "app.core.auth" → "core/auth"
            const parts = asPath.split("/");
            for (let i = 1; i < parts.length; i++) {
                const sub = parts.slice(i).join("/");
                const r = lookup.get(sub);
                if (r) return r;
            }
        }
        // Go package resolution: "github.com/org/project/utils" → match by suffix
        if (importStr.includes("/") && !importStr.startsWith(".")) {
            const segments = importStr.split("/");
            // Try progressively shorter suffixes: utils, project/utils, org/project/utils
            // Longest suffix first — "org/project/utils" before "utils".
            // Prevents local folder collision with Go module paths.
            for (let i = 0; i < segments.length; i++) {
                const suffix = segments.slice(i).join("/");
                const resolved = lookup.get(suffix);
                if (resolved) return resolved;
            }
        }
        return null;
    }
    let target = importStr.replace(/^@\//, "src/");
    if (target.startsWith(".")) {
        target = path.posix.join(
            path.posix.dirname(currentFile.replace(/\\/g, "/")),
            target,
        );
    }
    target = target.replace(/\.(ts|tsx|js|jsx)$/, "");
    return lookup.get(target) || null;
}
/**
 * Go: resolve an import path to the files of the package it names.
 *
 * The file-suffix lookup used for other languages never matched a Go import
 * (it names a directory), so no Go file had importers: blast radius was empty
 * and an edit that broke another package was never checked against it.
 * With a go.mod the path is module path + directory; without one, the longest
 * directory suffix. Test files are not importable.
 */
function goImportResolver(allFiles: string[], goModules: GoModule[]): (importPath: string) => string[] {
    const byDir = new Map<string, string[]>();
    for (const f of allFiles) {
        if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
        const dir = path.posix.dirname(f);
        const list = byDir.get(dir);
        if (list) list.push(f); else byDir.set(dir, [f]);
    }
    const modules = [...goModules].sort((a, b) => b.modulePath.length - a.modulePath.length);
    const none: string[] = [];

    return (importPath: string): string[] => {
        if (byDir.size === 0) return none;
        for (const mod of modules) {
            if (importPath !== mod.modulePath && !importPath.startsWith(mod.modulePath + "/")) continue;
            const rel = importPath.slice(mod.modulePath.length + 1);
            return byDir.get(path.posix.join(mod.dir || ".", rel)) ?? none;
        }
        if (modules.length > 0) return none; // standard library or another module
        const segments = importPath.split("/");
        for (let i = 0; i < segments.length; i++) {
            const files = byDir.get(segments.slice(i).join("/"));
            if (files) return files;
        }
        return none;
    };
}

/**
 * Python: resolve an absolute import whose root is a SUBDIRECTORY of the
 * project ("app.core.auth" for backend/app/core/auth.py). resolveImportFast
 * only strips leading components of the import; this strips them from the
 * file path. Among several candidates the one nearest to the importer wins.
 */
function pythonSuffixResolver(allFiles: string[]): (importStr: string, importer: string) => string | null {
    let bySuffix: Map<string, string[]> | null = null;
    const build = (): Map<string, string[]> => {
        const map = new Map<string, string[]>();
        for (const f of allFiles) {
            if (!f.endsWith(".py")) continue;
            const noExt = f.slice(0, -3);
            const segments = (noExt.endsWith("/__init__") ? noExt.slice(0, -9) : noExt).split("/");
            for (let i = 0; i < segments.length; i++) {
                const key = segments.slice(i).join("/");
                if (key === "__init__") continue;
                const list = map.get(key);
                if (list) list.push(f); else map.set(key, [f]);
            }
        }
        return map;
    };
    const sharedPrefix = (a: string, b: string): number => {
        const as = a.split("/"), bs = b.split("/");
        let n = 0;
        while (n < as.length - 1 && n < bs.length - 1 && as[n] === bs[n]) n++;
        return n;
    };

    return (importStr: string, importer: string): string | null => {
        if (importStr.startsWith(".") || !/^[\w.]+$/.test(importStr)) return null;
        bySuffix ??= build();
        const candidates = bySuffix.get(importStr.replace(/\./g, "/"));
        if (!candidates || candidates.length === 0) return null;
        let best = candidates[0];
        let bestShared = sharedPrefix(best, importer);
        for (let i = 1; i < candidates.length; i++) {
            const shared = sharedPrefix(candidates[i], importer);
            if (shared > bestShared) { best = candidates[i]; bestShared = shared; }
        }
        return best;
    };
}

/**
 * Build a dependency graph from repo map entries.
 * Computes in-degree (how many files import each file) and classifies by percentile.
 */
export async function buildDependencyGraph(
    entries: RepoMapEntry[],
    allFiles: string[],
    options: GraphOptions = {},
): Promise<DependencyGraph> {
    const lookup = buildFastLookup(allFiles);
    const importedBy = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Initialize all files with 0
    for (const file of allFiles) {
        inDegree.set(file, 0);
        importedBy.set(file, new Set());
    }

    const addEdge = (target: string, importer: string): void => {
        if (target === importer) return;
        const consumers = importedBy.get(target) || new Set();
        if (consumers.has(importer)) return; // one edge per (importer, target)
        consumers.add(importer);
        importedBy.set(target, consumers);
        inDegree.set(target, (inDegree.get(target) || 0) + 1);
    };

    const resolveGo = goImportResolver(allFiles, options.goModules ?? []);
    const resolvePython = pythonSuffixResolver(allFiles);

    // Build reverse graph
    for (const entry of entries) {
        if (entry.filePath.endsWith(".go")) {
            // A Go import names a PACKAGE: every file of that directory is a target.
            for (const imp of entry.imports) {
                for (const target of resolveGo(imp)) addEdge(target, entry.filePath);
            }
            continue;
        }
        const isPython = entry.filePath.endsWith(".py");
        const imports = isPython && entry.graphImports
            ? [...new Set([...entry.imports, ...entry.graphImports])]
            : entry.imports;
        for (const imp of imports) {
            const resolved = resolveImportFast(imp, entry.filePath, lookup)
                ?? (isPython ? resolvePython(imp, entry.filePath) : null);
            if (resolved) addEdge(resolved, entry.filePath);
        }
    }

    // PageRank classification (recursive importance, not naive inDegree)
    const prScores = computePageRank(allFiles, importedBy);
    const prScoresArray = Array.from(prScores.values()).sort((a, b) => a - b);

    // B.3 Fix: Symmetric Ecosystem Percentile.
    // Scale percentile logarithmically with repo size so core tier
    // represents comparable architectural importance across scales.
    // Formula from chronos-miner v15.4 empirical calibration.
    const safe_N = Math.max(10, allFiles.length);
    const scale_factor = Math.log10(safe_N / 300.0);
    const target_core = Math.max(0.85, Math.min(0.995, 0.91 + 0.05 * scale_factor));
    const target_logic = Math.max(0.50, Math.min(0.80, 0.60 + 0.10 * scale_factor));

    const p85 = prScoresArray[Math.floor(allFiles.length * target_core)] || 0;
    const p50 = prScoresArray[Math.floor(allFiles.length * target_logic)] || 0;

    const tiers = new Map<string, "core" | "logic" | "leaf">();
    for (const [file, score] of prScores.entries()) {
        // Only CORE/LOGIC if someone actually imports it (prevents orphan anomalies)
        if (score >= p85 && (inDegree.get(file) || 0) > 0) tiers.set(file, "core");
        else if (score >= p50 && (inDegree.get(file) || 0) > 0) tiers.set(file, "logic");
        else tiers.set(file, "leaf");
    }

    // ─── MACRO-TOPOLOGY SPECTRAL CLUSTERING (Combinatorial Laplacian) ───
    const clusters = new Map<string, "cluster_a" | "cluster_b" | "bridge" | "orphan">();
    const v2Score = new Map<string, number>();
    let fiedler = 0;

    const nodeIndex = new Map<string, number>();
    allFiles.forEach((f, i) => nodeIndex.set(f, i));
    const sparseEdges: import("./kernel/spectral-topology.js").SparseEdge[] = [];

    for (const [target, consumers] of importedBy.entries()) {
        const v = nodeIndex.get(target);
        if (v === undefined) continue;
        for (const consumer of consumers) {
            const u = nodeIndex.get(consumer);
            if (u !== undefined && u !== v) {
                sparseEdges.push({ u, v, weight: 1.0 });
            }
        }
    }

    if (allFiles.length > 2 && sparseEdges.length > 0) {
        try {
            const { SpectralMath } = await import("./kernel/spectral-topology.js");

            // normalized=false: Combinatorial Laplacian.
            // Prevents D^{-1/2} from crushing hub v₂ components into false bridges.
            const spectral = SpectralMath.analyzeTopology(allFiles.length, sparseEdges, false);
            fiedler = spectral.fiedler ?? 0;

            if (spectral.v2 && spectral.lambda3 !== undefined && spectral.v3) {
                // σ(v₂): mean ≈ 0 by Gram-Schmidt deflation
                let sumSq = 0;
                for (let i = 0; i < allFiles.length; i++) {
                    sumSq += spectral.v2[i] * spectral.v2[i];
                }
                const sigma = Math.sqrt(sumSq / allFiles.length);

                // γ = λ₃/λ₂: spectral gap ratio (bipartition confidence).
                // The discriminated union on analyzeTopology guarantees that
                // narrowing on `spectral.v2` (line 538 above) gives us
                // `lambda3: number` — no more `!== undefined` paranoia.
                // We still trap NaN explicitly: power iteration on hub-heavy
                // graphs can overflow (c·v - L·v → Infinity - Infinity → NaN),
                // and `NaN > 1e-9` is `false` AND `NaN <= 1e-9` is `false`,
                // so the previous fallback silently degraded to gamma=1.0
                // (a fictitious "λ₃ = λ₂") and produced phantom bridges.
                // Fail-closed: NaN or near-zero fiedler → γ=∞ → 0 bridges.
                const gamma = (Number.isNaN(spectral.fiedler) || spectral.fiedler <= 1e-9)
                    ? Infinity
                    : (spectral.lambda3 / spectral.fiedler);

                // ε = σ/γ with hard bounds [0.01, 0.15]
                const bridgeThreshold = gamma === Infinity
                    ? 0
                    : Math.max(0.01, Math.min(0.15, sigma / gamma));

                for (let i = 0; i < allFiles.length; i++) {
                    const file = allFiles[i];
                    const val = spectral.v2[i];
                    v2Score.set(file, val);
                    const inDeg = inDegree.get(file) || 0;
                    const fanOut = importedBy.get(file)?.size || 0;

                    if (inDeg === 0 && fanOut === 0) {
                        clusters.set(file, "orphan");
                    } else if (Math.abs(val) < bridgeThreshold && (inDeg > 0 || fanOut > 0)) {
                        clusters.set(file, "bridge");
                    } else if (val > 0) {
                        clusters.set(file, "cluster_a");
                    } else {
                        clusters.set(file, "cluster_b");
                    }
                }
            }
        } catch { /* Kernel no activo, fallback silencioso */ }
    }

    if (clusters.size === 0) {
        for (const file of allFiles) {
            clusters.set(file, "orphan");
            v2Score.set(file, 0);
        }
    }

    return { importedBy, inDegree, tiers, clusters, v2Score, fiedler };
}

/** Serialize DependencyGraph to JSON-safe format. */
function serializeGraph(graph: DependencyGraph): DependencyGraphData {
    const importedBy: Record<string, string[]> = {};
    for (const [k, v] of graph.importedBy) {
        if (v.size > 0) importedBy[k] = [...v];
    }
    const inDegree: Record<string, number> = {};
    for (const [k, v] of graph.inDegree) {
        if (v > 0) inDegree[k] = v;
    }
    const tiers: Record<string, "core" | "logic" | "leaf"> = {};
    for (const [k, v] of graph.tiers) {
        tiers[k] = v;
    }

    let clusters: Record<string, "cluster_a" | "cluster_b" | "bridge" | "orphan"> | undefined;
    if (graph.clusters) {
        clusters = {};
        for (const [k, v] of graph.clusters) clusters[k] = v;
    }

    let v2Score: Record<string, number> | undefined;
    if (graph.v2Score) {
        v2Score = {};
        for (const [k, v] of graph.v2Score) v2Score[k] = v;
    }

    return { importedBy, inDegree, tiers, clusters, v2Score, fiedler: graph.fiedler };
}

/** Deserialize DependencyGraphData back to DependencyGraph. */
function deserializeGraph(data: DependencyGraphData): DependencyGraph {
    const importedBy = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(data.importedBy)) {
        importedBy.set(k, new Set(v));
    }
    const inDegree = new Map<string, number>(Object.entries(data.inDegree));
    const tiers = new Map<string, "core" | "logic" | "leaf">(
        Object.entries(data.tiers) as [string, "core" | "logic" | "leaf"][],
    );

    let clusters: Map<string, "cluster_a" | "cluster_b" | "bridge" | "orphan"> | undefined;
    if (data.clusters) {
        clusters = new Map(Object.entries(data.clusters)) as Map<string, "cluster_a" | "cluster_b" | "bridge" | "orphan">;
    }

    let v2Score: Map<string, number> | undefined;
    if (data.v2Score) {
        v2Score = new Map(Object.entries(data.v2Score).map(([k, v]) => [k, Number(v)]));
    }

    return { importedBy, inDegree, tiers, clusters, v2Score, fiedler: data.fiedler };
}

// ─── Repo Map Generation ────────────────────────────────────────────

export async function generateRepoMap(
    projectRoot: string,
    parser: ASTParser
): Promise<RepoMap> {
    await parser.initialize();

    const files = walkFiles(projectRoot);
    const entries: RepoMapEntry[] = [];
    let totalLines = 0;

    for (const filePath of files) {
        let content: string;
        try {
            content = readSource(filePath);
        } catch {
            continue;
        }

        const ext = path.extname(filePath).toLowerCase();
        const lineCount = content.split("\n").length;
        totalLines += lineCount;

        const imports = extractImports(content, ext);
        const exports = extractExports(content, ext);
        const graphImports = ext === ".py"
            ? extractPythonGraphImports(content).filter(i => !imports.includes(i))
            : [];

        // Parse with tree-sitter for signatures
        const signatures: string[] = [];
        if (parser.isSupported(ext)) {
            const result = await parser.parse(filePath, content);
            for (const chunk of result.chunks) {
                const rawSig = extractSignature(chunk.rawCode);
                const cleaned = cleanSignature(rawSig);
                const prefix =
                    chunk.nodeType === "class" ? "class" :
                    chunk.nodeType === "interface" ? "iface" :
                    chunk.nodeType === "type" ? "type" :
                    chunk.nodeType === "method" ? "method" : "fn";
                signatures.push(`${prefix}: ${cleaned}`);
            }
        }

        // Sort signatures alphabetically for deterministic output
        signatures.sort(stableCompare);

        const purpose = extractFilePurpose(content, path.basename(filePath));
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        entries.push({
            filePath: relPath,
            exports,
            signatures,
            imports,
            lineCount,
            ...(purpose ? { purpose } : {}),
            ...(graphImports.length > 0 ? { graphImports } : {}),
        });
    }

    // Sort by file path for deterministic output (locale-independent)
    entries.sort((a, b) => stableCompare(a.filePath, b.filePath));

    const allRelPaths = entries.map(e => e.filePath);
    const graph = await buildDependencyGraph(entries, allRelPaths, {
        goModules: findGoModules(projectRoot, allRelPaths),
    });

    return {
        version: "1.0.0",
        generatedAt: new Date().toISOString(),
        totalFiles: entries.length,
        totalLines,
        entries,
        graph,
    };
}

// ─── Text Rendering (Deterministic) ─────────────────────────────────

/**
 * Extract a concise 1-line purpose description from a file's leading comment block.
 */
function extractFilePurpose(content: string, baseName: string): string | undefined {
    const lines = content.split("\n").slice(0, 20);
    const commentLines: string[] = [];
    let inBlock = false;

    for (const raw of lines) {
        const t = raw.trim();
        if (!inBlock) {
            if (t === "" || t.startsWith("#!")) continue;
            if (t.startsWith("//") || t.startsWith("#")) {
                const c = t.replace(/^(?:\/\/|#)+\s*/, "").trim();
                if (c) commentLines.push(c);
                continue;
            }
            if (t.startsWith("/*")) {
                inBlock = true;
                const c = t.replace(/^\/\*+\s*/, "").replace(/\*+\/\s*$/, "").trim();
                if (c) commentLines.push(c);
                if (t.includes("*/")) inBlock = false;
                continue;
            }
            break;
        } else {
            const c = t.replace(/^\*+\/?\s*/, "").replace(/\*+\/\s*$/, "").trim();
            if (c) commentLines.push(c);
            if (t.includes("*/")) break;
        }
    }

    if (commentLines.length === 0) return undefined;

    const stem = baseName.replace(/\.[^.]+$/, "");
    for (const line of commentLines) {
        if (line.startsWith("@")) continue;
        // Strip leading "filename.ts - " or "dir/filename.ts — " prefix
        const stripped = line
            // stem escaped: "[id].tsx", "a(b.ts" are legal file names, and an
            // unbalanced bracket made this RegExp throw, aborting the whole map.
            .replace(new RegExp(`^(?:[\\w./-]+\\/)?${escapeRegExp(stem)}(?:\\.[a-z0-9]+)?\\s*[-—:]\\s*`, "i"), "")
            .trim();
        if (stripped.length >= 8 && stripped.toLowerCase() !== baseName.toLowerCase()) {
            return stripped.length > 90 ? stripped.slice(0, 87) + "..." : stripped;
        }
    }
    return undefined;
}

/** Signature lines per file in depth:"full" (the rest: names only, then `outline`). */
const FULL_MAP_SIGNATURE_CAP = 15;
const FULL_MAP_HIDDEN_NAME_CAP = 40;
/** Data/markup files: their parser chunks are keys and selectors, not signatures. */
const MAP_NO_SIGNATURES = new Set([".json", ".css", ".html"]);

export function repoMapToText(map: RepoMap, depth: "skeleton" | "full" = "skeleton", pressure: number = 0): string {
    const lines: string[] = [];
    const isSkeleton = depth === "skeleton";

    // Static header (prefix cache safe — no volatile data)
    lines.push(`=== NREKI STATIC REPO MAP ===\n`);

    if (!map.graph || !map.graph.clusters) {
        // Fallback for pre-v7.5 caches — render flat list
        for (const entry of map.entries) {
            const purposeSuffix = entry.purpose ? ` — ${entry.purpose}` : "";
            lines.push(`${entry.filePath} (${entry.lineCount} lines)${purposeSuffix}`);
            if (entry.exports.length > 0) lines.push(`  exports: ${entry.exports.join(", ")}`);
            for (const sig of entry.signatures) lines.push(`  ${sig}`);
            if (entry.imports.length > 0) {
                const shortened = entry.imports.map(shortenImport);
                lines.push(`  imports: ${shortened.join(", ")}`);
            }
            lines.push("");
        }
        return lines.join("\n");
    }

    // Group entries by directory
    const dirs = new Map<string, { leafs: number; cores: RepoMapEntry[] }>();
    for (const entry of map.entries) {
        const dir = path.dirname(entry.filePath);
        if (!dirs.has(dir)) dirs.set(dir, { leafs: 0, cores: [] });

        const tier = map.graph.tiers.get(entry.filePath);
        const cluster = map.graph.clusters.get(entry.filePath);
        const isCritical = tier === "core" || cluster === "bridge";

        if (isSkeleton && !isCritical) {
            dirs.get(dir)!.leafs++;
        } else {
            dirs.get(dir)!.cores.push(entry);
        }
    }

    for (const [dir, data] of Array.from(dirs.entries()).sort((a, b) => stableCompare(a[0], b[0]))) {
        const cleanDir = dir === "." ? "(root)" : dir;

        // Skeleton = CORE/BRIDGE only (documented contract). Listing every leaf
        // with its purpose line tripled the default map (2.6k -> 8.1k tokens on
        // NREKI itself); leaf purposes are shown by depth:"full".
        if (data.cores.length === 0 && isSkeleton) {
            lines.push(`${cleanDir}/ [${data.leafs} peripheral files]`);
            continue;
        }

        const hiddenMsg = data.leafs > 0 ? ` [${data.leafs} hidden]` : "";
        lines.push(`${cleanDir}/${hiddenMsg}`);

        // Sort cores deterministically for cache stability
        data.cores.sort((a, b) => stableCompare(a.filePath, b.filePath));

        for (const core of data.cores) {
            const tier = map.graph!.tiers.get(core.filePath) || "leaf";
            const relPath = path.relative(dir, core.filePath).replace(/\\/g, "/");
            const cleanName = relPath.startsWith("../") ? path.basename(core.filePath) : relPath;

            if (isSkeleton) {
                // SKELETON: Zero volatile metrics. Cache safe.
                let exportStr = "";
                const isCrit = tier === "core" || map.graph!.clusters?.get(core.filePath) === "bridge";
                if (isCrit && core.exports.length > 0 && pressure <= 0.7) {
                    const topExports = core.exports.slice(0, 3).join(", ");
                    const more = core.exports.length > 3 ? ", ..." : "";
                    exportStr = ` exports: ${topExports}${more}`;
                }
                const purposeStr = core.purpose && pressure <= 0.7 ? ` — ${core.purpose}` : "";
                lines.push(`  [${tier.toUpperCase()}] ${cleanName} (${core.lineCount}L)${exportStr}${purposeStr}`);
            } else {
                // FULL: All topology metadata
                const inDeg = map.graph!.inDegree.get(core.filePath) || 0;
                const v2 = map.graph!.v2Score?.get(core.filePath)?.toFixed(3) || "0";
                const cluster = map.graph!.clusters?.get(core.filePath) || "orphan";
                const purposeStr = core.purpose ? ` — ${core.purpose}` : "";
                lines.push(`  [${tier.toUpperCase()}] ${cleanName} (${core.lineCount}L) (In:${inDeg}, v2:${v2}, ${cluster})${purposeStr}`);
                // Token cost: a JSON/CSS/HTML file has no signatures (its keys were
                // printed as `class: "type":"module"`), an export named by a
                // signature line was listed twice, and a file of 40 helpers printed
                // 40 lines. `outline` gives the rest on demand.
                const sigs = MAP_NO_SIGNATURES.has(path.extname(core.filePath).toLowerCase()) ? [] : core.signatures;
                const named = new Set(sigs.map(s => /^\w+:\s*([A-Za-z_$][\w$]*)/.exec(s)?.[1]).filter(Boolean));
                const exportsLeft = core.exports.filter(e => !named.has(e));
                if (exportsLeft.length > 0) {
                    lines.push(`    exports: ${exportsLeft.join(", ")}`);
                }
                for (const sig of sigs.slice(0, FULL_MAP_SIGNATURE_CAP)) lines.push(`    ${sig}`);
                if (sigs.length > FULL_MAP_SIGNATURE_CAP) {
                    // The hidden ones keep their NAME (the list is alphabetical: a cut
                    // without names hid `invoiceTotal` behind 24 `consumerValueNN`).
                    const hidden = sigs.slice(FULL_MAP_SIGNATURE_CAP)
                        .map(s => /^\w+:\s*([A-Za-z_$][\w$]*)/.exec(s)?.[1] ?? s);
                    const names = hidden.slice(0, FULL_MAP_HIDDEN_NAME_CAP).join(", ");
                    const rest = hidden.length > FULL_MAP_HIDDEN_NAME_CAP ? `, +${hidden.length - FULL_MAP_HIDDEN_NAME_CAP}` : "";
                    lines.push(`    … +${hidden.length} more: ${names}${rest} (outline ${core.filePath})`);
                }
                if (core.imports.length > 0) {
                    lines.push(`    imports: ${core.imports.map(shortenImport).join(", ")}`);
                }
            }
        }
        lines.push("");
    }

    // Volatile metadata at bottom (prefix cache preserver)
    if (!isSkeleton) {
        const fiedlerStr = map.graph?.fiedler !== undefined ? map.graph.fiedler.toFixed(4) : "0.0000";
        lines.push(`=== TOPOLOGY METADATA ===`);
        lines.push(`Files: ${map.totalFiles} | Lines: ${map.totalLines} | lambda2: ${fiedlerStr}`);
    }

    return lines.join("\n");
}

// ─── Caching ─────────────────────────────────────────────────────────

function computeFileDigest(projectRoot: string): string {
    const files = walkFiles(projectRoot);
    const hash = crypto.createHash("sha256");

    for (const file of files) {
        try {
            const stat = fs.statSync(file);
            const rel = path.relative(projectRoot, file).replace(/\\/g, "/");
            hash.update(`${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
        } catch {
            // Skip
        }
    }

    return hash.digest("hex");
}

export async function getOrGenerateRepoMap(
    projectRoot: string,
    parser: ASTParser,
    forceRefresh: boolean = false
): Promise<{ map: RepoMap; text: string; fromCache: boolean }> {
    const cachePath = path.join(projectRoot, ".nreki", "repo-map.json");

    const currentDigest = computeFileDigest(projectRoot);

    // Check cache
    if (!forceRefresh && fs.existsSync(cachePath)) {
        try {
            const { tag, ...cached } = JSON.parse(
                fs.readFileSync(cachePath, "utf-8"),
                (k, v) => (k === "__proto__" || k === "constructor" || k === "prototype" ? undefined : v),
            ) as CachedRepoMap & { tag?: unknown };
            // Its text goes straight into `map` output: a cache shipped with the
            // project (archives keep mtimes, so the digest can match) must not be
            // served. Only a cache signed on this machine is (NREKI-SEC-06).
            if (verifyState("repo-map", JSON.stringify(cached), tag) &&
                cached.digest === currentDigest && (cached.formatVersion ?? 0) === CACHE_FORMAT_VERSION) {
                // Restore graph from cached serialized form
                if (cached.graph) {
                    cached.map.graph = deserializeGraph(cached.graph);
                }
                return { map: cached.map, text: cached.text, fromCache: true };
            }
        } catch {
            // Cache corrupted, regenerate
        }
    }

    // Generate fresh map (includes graph)
    const map = await generateRepoMap(projectRoot, parser);
    const text = repoMapToText(map);

    // Save to cache (serialize graph for JSON storage)
    const graphData = map.graph ? serializeGraph(map.graph) : undefined;
    // Strip non-serializable graph from the map for JSON storage
    const mapForCache = { ...map, graph: undefined };
    const cacheData: CachedRepoMap = { formatVersion: CACHE_FORMAT_VERSION, digest: currentDigest, map: mapForCache, text, graph: graphData };
    try {
        // Never through a `.nreki` link shipped with the repository (writeStateFile).
        writeStateFile(projectRoot, cachePath, JSON.stringify({ ...cacheData, tag: signState("repo-map", JSON.stringify(cacheData)) }));
    } catch (err) {
        logger.warn(`[NREKI] repo map not cached: ${(err as Error).message}`);
    }

    return { map, text, fromCache: false };
}
