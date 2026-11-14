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
    /** The module as written: "./fees.js", "app.billing", "example.com/demo/util". */
    source?: string;
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
 * A name that holds a secret: `apiKey`, `STRIPE_SECRET`, `client_secret`,
 * `dbPassword`, `x-api-key`, `$apiKey`, `accessToken`. `tokens = tokenize("…")`
 * (lexer or model tokens) is not one: its argument was blanked.
 */
const SECRET_NAME = /[\w$-]*(?:passw(?:or)?d|pwd|secret|private.?key|api.?key|credential|master.?key|token(?!i[sz]|s(?![\w$])))[\w$-]*/gi;
/** How far the value of one secret name is read. */
const VALUE_SCAN_LIMIT = 10_000;
/** A line ending in one of these continues the expression on the next line... */
const CONTINUES_AFTER = new Set(["=", "+", "-", "*", "/", "%", "?", ":", "|", "&", ".", "<", ">", "!", "~", "^"]);
/** ...and so does a next line that starts with one of these. */
const CONTINUES_BEFORE = new Set(["+", "-", "*", "/", "%", "?", ":", "|", "&", ".", "=", "<", ">", "^"]);

/** End (exclusive) of the string literal that opens at `start`, or -1. Only a template or triple-quoted literal spans lines. */
function literalEnd(text: string, start: number): number {
    const quote = text[start];
    if (quote !== "\"" && quote !== "'" && quote !== "`") return -1;
    if (quote !== "`" && text.startsWith(quote.repeat(3), start)) {
        const close = text.indexOf(quote.repeat(3), start + 3);
        return close < 0 ? -1 : close + 3;
    }
    for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\\") { i++; continue; }
        if (ch === quote) return i + 1;
        if (ch === "\n" && quote !== "`") return -1;
    }
    return -1;
}

/** Index after the comment that starts at `i` (`//`, `/* … *\/`, `#` after a space or `(`, `,`, `=`), or -1 if none does. */
function commentEnd(text: string, i: number, limit: number): number {
    const ch = text[i];
    const line = ch === "/" && text[i + 1] === "/" || ch === "#" && (i === 0 || /[\s(,=]/.test(text[i - 1]));
    if (line) {
        const nl = text.indexOf("\n", i);
        return nl < 0 || nl > limit ? limit : nl;
    }
    if (ch === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        return close < 0 || close + 2 > limit ? limit : close + 2;
    }
    return -1;
}

/** The first character at or after `i` that is not white space or a comment ("" at the end). */
function nextSignificant(text: string, i: number, limit: number): string {
    while (i < limit) {
        if (/\s/.test(text[i])) { i++; continue; }
        const end = commentEnd(text, i, limit);
        if (end < 0) return text[i];
        i = end;
    }
    return "";
}

/**
 * Where the value of the secret name that ends at `i` starts, or -1. After
 * `=`, `:`, `:=`, `??=`, `||=`, `=>` or `(`: a type annotation (`apiKey: string =`)
 * is part of the value expression read next, as is Go's `var apiKey string =`.
 */
function valueStart(text: string, i: number): number {
    if (text[i] === "\"" || text[i] === "'") i++;            // a quoted key: "client_secret": …
    if (text[i] === "]") i++;                               // headers["x-api-key"] = …
    const typed = /^[ \t]+[\w.*[\]]+[ \t]*(?::=|=(?![=>]))/.exec(text.slice(i, i + 120));
    if (typed && !/^[ \t]+(?:in|of|instanceof|as|is|and|or|not)\b/.test(typed[0])) return i + typed[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if ((text[i] === "?" || text[i] === "!") && text[i + 1] === ":") i++; // apiKey?: string
    if (text.startsWith(":=", i)) return i + 2;
    if (text.startsWith("??=", i) || text.startsWith("||=", i) || text.startsWith("&&=", i)) return i + 3;
    if (text.startsWith("=>", i)) return i + 2;
    if (text[i] === "=" && text[i + 1] !== "=") return i + 1;
    if (text[i] === ":" || text[i] === "(") return i + 1;
    return -1;
}

/**
 * The string literals of the value expression that starts at `start`, comments
 * skipped: up to a `;` or `,` outside brackets, a bracket it did not open, or
 * the end of a line once a value was read, unless an operator carries the
 * expression on (`"a" +⏎ "b"`, `vault⏎ .get("k")`, `prod⏎ ? "a"⏎ : "b"`).
 * Reading only the literal right after the operator, `apiKey: string =⏎ "…"`,
 * `= // note⏎ "…"` and `"a" + // note⏎ "b"` were sent as is.
 */
function valueLiterals(text: string, start: number, ranges: Array<[number, number]>): void {
    const limit = Math.min(text.length, start + VALUE_SCAN_LIMIT);
    let depth = 0;
    let last = ""; // last significant character; "" until the value starts
    for (let i = start; i < limit;) {
        const ch = text[i];
        if (ch === "\n") {
            if (depth === 0 && last !== "" && !CONTINUES_AFTER.has(last)
                && !CONTINUES_BEFORE.has(nextSignificant(text, i + 1, limit))) return;
            i++;
            continue;
        }
        if (/\s/.test(ch)) { i++; continue; }
        const comment = commentEnd(text, i, limit);
        if (comment >= 0) { i = comment; continue; }
        if (ch === "\"" || ch === "'" || ch === "`") {
            const end = literalEnd(text, i);
            if (end < 0) return;
            ranges.push([i, end]);
            last = ch;
            i = end;
            continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) return;
            depth--;
        } else if ((ch === ";" || ch === ",") && depth === 0) return;
        last = ch;
        i++;
    }
}

/** The literals in the value of every secret name: initializer, type annotation and comments included. */
function redactSecretAssignments(text: string): string {
    const ranges: Array<[number, number]> = [];
    for (const m of text.matchAll(SECRET_NAME)) {
        const at = valueStart(text, (m.index ?? 0) + m[0].length);
        if (at >= 0) valueLiterals(text, at, ranges);
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    let out = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (end <= cursor) continue;                      // inside a range already blanked
        if (start < cursor) { cursor = end; continue; }   // overlaps it: blank up to the later end
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
 *   - every literal in the value of a secret name: on the next line, after a
 *     type annotation or a comment, as a multi-line template, a concatenation
 *     or a ternary (line by line, `apiKey:\n "…"` and a multi-line template
 *     password were sent as is; then `apiKey: string =\n "…"`);
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
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint, source: match[2] });
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
                deps.push({ symbol, localName: symbol, pathHint, source: match[2] });
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
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint, source: match[2] });
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
                if (symbol.length > 2) deps.push({ symbol, localName, pathHint, source: match[1] });
            }
        }

        // ── Python 2: Namespace Inference (import json, django.db as db_models) ──
        // Flat imports don't map directly to indexable symbols (the DB
        // stores functions/classes, not modules). Register namespace
        // aliases, then scan body for `alias.Symbol` usage — same
        // pattern as the Go branch below.
        const pyImportRe = /^import\s+([^#\n]+)/gm;
        const pyPkgMap = new Map<string, { pathHint: string; source: string }>(); // localName -> module

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
                pyPkgMap.set(localName, { pathHint, source: fullModule });
            }
        }

        // Scan body for Package.Symbol usage
        for (const [localName, { pathHint, source }] of pyPkgMap.entries()) {
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
                        source,
                    });
                }
            }
        }
    } else if (ext === ".go") {
        // ── Go: Namespace-to-Symbol Inference Engine ──
        // Go imports packages, not symbols. We scan the code for Package.ExportedSymbol usage.
        const pkgMap = new Map<string, { pathHint: string; source: string }>();
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
                        pkgMap.set(localName, { pathHint, source: fullPath });
                    }
                }
            }
        }

        // Scan body for Package.ExportedSymbol (Go exports start with uppercase)
        for (const [localName, { pathHint, source }] of pkgMap.entries()) {
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
                    source,
                });
            }
        }
    }

    // Deduplicate
    const unique = new Map<string, ImportDependency>();
    for (const d of deps) unique.set(`${d.symbol}:${d.pathHint}`, d);
    return Array.from(unique.values());
}
