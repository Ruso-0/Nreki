/**
 * imports.ts - Dependency extraction and security filters for Auto-Context.
 * Anchors searches to explicit import declarations instead of blind regex on code bodies.
 * Supports: ESM named/default, CommonJS require, Python from-import, Go namespace inference.
 */

export interface ImportDependency {
    /** Original exported name - used for BM25 search in SQLite */
    symbol: string;
    /** Name used in THIS file (may differ due to alias) - used for the Gold Filter */
    localName: string;
    /** Last segment of the import path - used for homonym disambiguation */
    pathHint: string;
}

// Security: exact auth-related tokens only. "tokenize", "TokenStream" pass through.
const SENSITIVE_PATTERNS = [
    /password/i, /secret/i, /private.?key/i, /api.?key/i,
    /credential/i, /encrypt/i, /decrypt/i, /master.?key/i,
    /(auth|access|refresh|secret|api|csrf|bearer|session)_?token/i,
];

/** Prevent leakage of credential-related signatures in auto-injected context */
export function isSensitiveSignature(sig: string): boolean {
    return SENSITIVE_PATTERNS.some(p => p.test(sig));
}

/** Well-known token shapes: Stripe, OpenAI-style, GitHub, AWS, Slack, Voyage, Google. */
const TOKEN_SHAPES = /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bpa-[A-Za-z0-9_-]{30,}|\bAIza[0-9A-Za-z_-]{35}/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** Authorization header values written as literals: "Bearer eyJ…", "Basic dXNlcjpwYXNz". */
const AUTH_HEADER_LITERAL = /(["'`])(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{12,}=*\1/g;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
/**
 * A name that holds a secret, then what assigns it: `apiKey:`, `STRIPE_SECRET =`,
 * `"client_secret":`, `apiKey :=` (Go), `setPassword(`. `\s*` crosses line breaks,
 * so a value on the next line is found too.
 */
const SECRET_ASSIGNMENT = /["']?[\w$-]*(?:passw(?:or)?d|pwd|secret|private.?key|api.?key|credential|master.?key|token)[\w$-]*["']?\s*(?::=|:|\?\?=|\|\|=|=(?![=>])|\()\s*/gi;

/** End (exclusive) of the string literal that opens at `start`, or -1. Only a template literal spans lines. */
function literalEnd(text: string, start: number): number {
    const quote = text[start];
    if (quote !== "\"" && quote !== "'" && quote !== "`") return -1;
    for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\") { i++; continue; }
        if (ch === quote) return i + 1;
        if (ch === "\n" && quote !== "`") return -1;
    }
    return -1;
}

/** The literal values assigned to secret names, across line breaks and `"…" + "…"` continuations. */
function redactSecretAssignments(text: string): string {
    const ranges: Array<[number, number]> = [];
    for (const m of text.matchAll(SECRET_ASSIGNMENT)) {
        let at = (m.index ?? 0) + m[0].length;
        for (;;) {
            const end = literalEnd(text, at);
            if (end < 0) break;
            ranges.push([at, end]);
            let next = end;
            while (next < text.length && /\s/.test(text[next])) next++;
            if (text[next] !== "+") break;
            next++;
            while (next < text.length && /\s/.test(text[next])) next++;
            at = next;
        }
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (start < cursor) continue; // inside a range already blanked
        out += `${text.slice(cursor, start)}"<redacted>"`;
        cursor = end;
    }
    return out + text.slice(cursor);
}

/**
 * Secrets written in ordinary code, blanked before the text leaves the machine
 * (the optional Voyage index). Sensitive paths were already skipped, but a
 * `STRIPE_SECRET = "sk_live_…"` in src/config/payments.ts was sent as is.
 * Blanked:
 *   - private key blocks and well-known token shapes, anywhere;
 *   - "Bearer …" / "Basic …" literals;
 *   - the literal assigned to a secret name, even on the next line, as a
 *     multi-line template or a concatenation (line by line, `apiKey:\n "…"`
 *     and a multi-line template password were sent as is);
 *   - the string literals of any line that names a secret.
 */
export function redactSecrets(text: string): string {
    const withoutShapes = text
        .replace(PRIVATE_KEY_BLOCK, "<redacted key>")
        .replace(TOKEN_SHAPES, "<redacted>")
        .replace(AUTH_HEADER_LITERAL, "$1$2 <redacted>$1");
    return redactSecretAssignments(withoutShapes)
        .split("\n")
        .map(line => (isSensitiveSignature(line) ? line.replace(STRING_LITERAL, "\"<redacted>\"") : line))
        .join("\n");
}

/** Escape special regex characters - prevents ReDoS with symbols like $store */
export function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clean a shorthand signature for safe injection.
 * - Strips JS/TS block and line comments
 * - Strips ONLY NREKI-specific Python stubs (not legitimate # comments)
 * - Collapses multiline signatures into one line
 * - Falls back to first line if cleanup produces empty string
 */
export function cleanSignature(shorthand: string): string {
    const sig = shorthand
        .replace(/\/\*[\s\S]*?\*\//g, "")              // JS/TS block comments & /*[nreki:4L]*/ stubs
        .replace(/\/\/.*/g, "")                         // JS/TS line comments
        .replace(/#\s*(?:\[NREKI\]|TG:L\d+).*$/gm, "")   // Strip ONLY NREKI stubs in Python
        .replace(/\{\s*$/, "")                          // Remove trailing open brace
        .replace(/\s+/g, " ")                           // Collapse whitespace
        .trim();

    return sig || shorthand.split("\n")[0].trim();
}

/**
 * Extract EXPLICIT dependencies from file imports.
 * Returns symbol (original name for search), localName (alias for Gold Filter),
 * and pathHint (file hint for homonym disambiguation).
 */
export function extractDependencies(code: string, ext: string): ImportDependency[] {
    // v11.0.x note: Kotlin/Java/C++ import detection is NOT implemented.
    // Files in these languages return [] from extractDependencies, resulting
    // in repo-map cross-file dependency edges being intra-file only for these
    // languages. Cross-file dependency resolution is deferred to the Phase 8.1
    // multi-language imports follow-up sprint.
    const deps: ImportDependency[] = [];

    // Local path heuristic: Node needs ./, ~/, @/; Go needs /
    const isLocalPath = (p: string) =>
        ext === ".go" ? p.includes("/") : /^[./~@]/.test(p);

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
        // ── Named ESM: import { foo, bar as baz } from "./utils/math" ──
        const namedRe =
            /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = namedRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            for (const s of match[1].split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s+as\s+/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }

        // ── Default ESM: import Foo from "..." or import Foo, { bar } from "..." ──
        // A-05: Allow optional ", { ... }" between default identifier and "from"
        const defaultRe =
            /import\s+(?!\s*\{)(?:\*\s+as\s+)?([a-zA-Z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
        while ((match = defaultRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            const symbol = match[1].trim();
            if (symbol !== "type" && symbol.length > 2) {
                deps.push({ symbol, localName: symbol, pathHint });
            }
        }

        // ── CommonJS: const { hash: myHash } = require('./utils') ──
        const reqRe =
            /(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\)/g;
        while ((match = reqRe.exec(code)) !== null) {
            if (!isLocalPath(match[2])) continue;
            const pathHint =
                match[2].split("/").pop()?.replace(/\.(ts|js)x?$/, "") || match[2];
            for (const s of match[1].split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s*:\s*/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }
    } else if (ext === ".py") {
        // ── Python 1: from X.Y import Z as W (single or parenthesized) ──
        const pyFromRe = /^from\s+([a-zA-Z0-9_.]+)\s+import\s+(?:\(([^)]*)\)|([^#\n]+))/gm;
        let match;
        while ((match = pyFromRe.exec(code)) !== null) {
            const pathHint = match[1].split(".").pop() || match[1];
            const importList = (match[2] || match[3] || "").replace(/\\\n/g, " ");
            for (const s of importList.split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s+as\s+/);
                const symbol = parts[0].trim();
                const localName = (parts[1] || parts[0]).trim();
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint });
            }
        }

        // ── Python 2: Namespace Inference (import json, django.db as db_models) ──
        // Flat imports don't map directly to indexable symbols (the DB
        // stores functions/classes, not modules). Register namespace
        // aliases, then scan body for `alias.Symbol` usage — same
        // pattern as the Go branch below.
        const pyImportRe = /^import\s+([^#\n]+)/gm;
        const pyPkgMap = new Map<string, string>(); // localName -> pathHint

        // Token-budget shield: skip Python stdlib — LLMs already know it
        // and auto-context injection wastes tokens.
        const pyStdlib = new Set([
            "os", "sys", "re", "json", "time", "math", "datetime",
            "typing", "collections", "itertools", "pathlib", "functools",
            "abc", "asyncio", "logging", "copy", "enum", "hashlib",
            "random", "string", "threading", "warnings", "io",
        ]);

        while ((match = pyImportRe.exec(code)) !== null) {
            const importList = match[1].replace(/\\\n/g, " ");
            for (const s of importList.split(",")) {
                if (!s.trim()) continue;
                const parts = s.trim().split(/\s+as\s+/);
                const fullModule = parts[0].trim();
                const localName = (parts[1] || fullModule).trim();
                const pathHint = fullModule.split(".").pop() || fullModule;
                if (pyStdlib.has(pathHint)) continue;
                pyPkgMap.set(localName, pathHint);
            }
        }

        // Scan body for Package.Symbol usage
        for (const [localName, pathHint] of pyPkgMap.entries()) {
            const usageRe = new RegExp(
                `\\b${escapeRegExp(localName)}\\.([a-zA-Z_]\\w*)`,
                "g",
            );
            let uMatch;
            while ((uMatch = usageRe.exec(code)) !== null) {
                const symbol = uMatch[1];
                if (symbol.length > 2) {
                    deps.push({
                        symbol,
                        localName: `${localName}.${symbol}`,
                        pathHint,
                    });
                }
            }
        }
    } else if (ext === ".go") {
        // ── Go: Namespace-to-Symbol Inference Engine ──
        // Go imports packages, not symbols. We scan the code for Package.ExportedSymbol usage.
        const pkgMap = new Map<string, string>();
        const importBlocks = code.match(
            /import\s*\([\s\S]*?\)|import\s+(?:[a-zA-Z0-9_.]+\s+)?["'][^"']+["']/g,
        );

        if (importBlocks) {
            const lineRe = /(?:([a-zA-Z0-9_.]+)\s+)?"([^"]+)"/g;
            for (const block of importBlocks) {
                // Strip 'import' keyword and parens so lineRe doesn't capture "import" as alias
                const inner = block.replace(/^import\s*\(?\s*/, "").replace(/\)\s*$/, "");
                lineRe.lastIndex = 0;
                let m;
                while ((m = lineRe.exec(inner)) !== null) {
                    const alias = m[1];
                    const fullPath = m[2];
                    // Go stdlib uses slashes (encoding/json, crypto/sha256).
                    // Third-party packages always have a dot in first segment (github.com).
                    const firstSegment = fullPath.split('/')[0];
                    if (!firstSegment.includes('.')) continue;

                    const pathHint = fullPath.split("/").pop() || fullPath;
                    const localName = alias || pathHint;
                    if (localName !== "_" && localName !== ".") {
                        pkgMap.set(localName, pathHint);
                    }
                }
            }
        }

        // Scan body for Package.ExportedSymbol (Go exports start with uppercase)
        for (const [localName, pathHint] of pkgMap.entries()) {
            const usageRe = new RegExp(
                `\\b${escapeRegExp(localName)}\\.([A-Z]\\w*)`,
                "g",
            );
            let uMatch;
            while ((uMatch = usageRe.exec(code)) !== null) {
                deps.push({
                    symbol: uMatch[1],
                    localName: `${localName}.${uMatch[1]}`,
                    pathHint,
                });
            }
        }
    }

    // Deduplicate
    const unique = new Map<string, ImportDependency>();
    for (const d of deps) unique.set(`${d.symbol}:${d.pathHint}`, d);
    return Array.from(unique.values());
}
