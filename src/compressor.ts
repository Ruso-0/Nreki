/**
 * compressor.ts - AST-based code compression.
 *
 * Pipeline:
 *   Stage 1: Noise removal, AST-exact (comments, docstrings, console/print,
 *            debugger) + whitespace normalization. Never touches strings.
 *   Stage 2: removed in v12.0.1. Self-information token filtering deleted
 *            words such as "never"/"not"/"before" (inverting the meaning of
 *            prose) and emitted lines that do not exist in the file.
 *            breakdown.tokenFilterReduction stays in the result (always 0).
 *   Stage 3: Structural compression (strip function bodies via AST)
 *
 * Three compression levels:
 *   - light:      Stage 1 only — code verbatim minus noise
 *   - medium:     Stage 1 + signatures + up to 5 key lines per symbol (skeleton)
 *   - aggressive: Stage 1 + signatures with bodies replaced by stubs
 * When Stage 3 cannot apply (no grammar / no symbols) the Stage 1 text is
 * returned: lossless rather than lossy.
 *
 * Pure TypeScript - zero native dependencies, zero Python.
 */

import type Parser from "web-tree-sitter";
import { ASTParser } from "./parser.js";
import { estimateTokens } from "./utils/token-estimator.js";

// ─── Types ───────────────────────────────────────────────────────────

export type CompressionLevel = "light" | "medium" | "aggressive";

export interface AdvancedCompressionResult {
    /** Compressed output text. */
    compressed: string;
    /** Original size in characters. */
    originalSize: number;
    /** Compressed size in characters. */
    compressedSize: number;
    /** Compression ratio (0.0 - 1.0). Higher = more compression. */
    ratio: number;
    /** Estimated tokens saved. */
    tokensSaved: number;
    /** Compression level used. */
    level: CompressionLevel;
    /** Per-stage breakdown of chars removed. */
    breakdown: {
        preprocessingReduction: number;
        tokenFilterReduction: number;
        structuralReduction: number;
    };
}

// ─── Language Detection ──────────────────────────────────────────────

type Lang = "typescript" | "javascript" | "python" | "go" | "kotlin" | "java" | "cpp" | "c" | "unknown";

function detectLang(filePath: string): Lang {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "js" || ext === "jsx") return "javascript";
    if (ext === "py") return "python";
    if (ext === "go") return "go";
    if (ext === "kt" || ext === "kts") return "kotlin";
    if (ext === "java") return "java";
    if (["cpp", "cc", "cxx", "hpp", "hh", "hxx"].includes(ext)) return "cpp";
    if (ext === "c" || ext === "h") return "c";
    return "unknown";
}

// ─── Stage 1: Preprocessing (AST-exact noise removal) ───────────────

/** A [start, end) range of `content` (JS string indices) that is pure noise. */
export interface NoiseRange {
    start: number;
    end: number;
}

const COMMENT_NODE = /^(comment|line_comment|block_comment|multiline_comment)$/;
const CONSOLE_METHODS = new Set([
    "log", "warn", "error", "debug", "info", "assert", "trace", "dir",
    "table", "time", "timeEnd", "group", "groupEnd",
]);

/** `console.<method>(...)` (JS/TS) or `print(...)` (Python) used as a statement. */
function isLoggingCall(expr: Parser.SyntaxNode, lang: Lang): boolean {
    if ((lang === "typescript" || lang === "javascript") && expr.type === "call_expression") {
        const fn = expr.childForFieldName("function");
        if (fn?.type !== "member_expression") return false;
        const obj = fn.childForFieldName("object");
        const prop = fn.childForFieldName("property");
        return obj?.text === "console" && !!prop && CONSOLE_METHODS.has(prop.text);
    }
    if (lang === "python" && expr.type === "call") {
        const fn = expr.childForFieldName("function");
        return fn?.type === "identifier" && fn.text === "print";
    }
    return false;
}

/** A Python statement made of nothing but a string literal (docstring or no-op). */
function isBareStringStatement(stmt: Parser.SyntaxNode): boolean {
    if (stmt.type !== "expression_statement" || stmt.namedChildCount !== 1) return false;
    const t = stmt.namedChild(0)?.type;
    return t === "string" || t === "concatenated_string";
}

/**
 * Python: docstrings and other bare string statements are no-ops and can go.
 * Strings used as VALUES (`SQL = """…"""`, arguments) are never touched — the
 * old regex replaced every triple-quoted string. A block keeps its strings if
 * removing them would leave it empty (misleading, and invalid Python).
 */
function isRemovableBareString(stmt: Parser.SyntaxNode): boolean {
    const parent = stmt.parent;
    if (!parent) return false;
    if (parent.type === "module") return true;
    if (parent.type !== "block") return false;
    return parent.namedChildren.some(c => !COMMENT_NODE.test(c.type) && !isBareStringStatement(c));
}

/**
 * Locate removable noise with tree-sitter: comments, Python docstrings,
 * `debugger` statements and statement-level console.* / print(...) calls.
 *
 * AST-exact on purpose (NREKI v12.0.1): the previous regex stripping
 * (`/\/\/[^\n]*\/g`, `/\/\*[\s\S]*?\*\/\/g`) did not know about strings, so
 * it cut `"https://…"`, turned `startsWith("//")` into `startsWith("")`,
 * emptied template literals and deleted whole lines of code between the
 * `/*` of one glob string (`"**\/*.js"`) and the `*\/` of another. It also
 * removed every Python triple-quoted string, docstring or not.
 *
 * Languages without a grammar (Markdown, plain text, …) yield no ranges:
 * nothing is stripped from them.
 */
export async function findNoiseRanges(content: string, filePath: string, parser: ASTParser): Promise<NoiseRange[]> {
    const lang = detectLang(filePath);
    try {
        const found = await parser.parseRaw(filePath, content, (tree) => {
            const out: NoiseRange[] = [];
            const stack: Parser.SyntaxNode[] = [tree.rootNode];
            while (stack.length > 0) {
                const node = stack.pop()!;
                if (COMMENT_NODE.test(node.type) || node.type === "debugger_statement") {
                    out.push({ start: node.startIndex, end: node.endIndex });
                    continue;
                }
                if (node.type === "expression_statement") {
                    const expr = node.namedChild(0);
                    if (expr && (isLoggingCall(expr, lang) ||
                        (lang === "python" && isBareStringStatement(node) && isRemovableBareString(node)))) {
                        out.push({ start: node.startIndex, end: node.endIndex });
                        continue;
                    }
                }
                for (let i = node.childCount - 1; i >= 0; i--) {
                    const child = node.child(i);
                    if (child) stack.push(child);
                }
            }
            return out;
        });
        return found ?? [];
    } catch {
        return []; // Parse failure: strip nothing rather than guess.
    }
}

/** Widen a range to its whole line(s) when nothing else lives on them. */
function widenToLines(content: string, r: NoiseRange): NoiseRange {
    let lineStart = r.start;
    while (lineStart > 0 && content[lineStart - 1] !== "\n") lineStart--;
    let lineEnd = r.end;
    while (lineEnd < content.length && content[lineEnd] !== "\n") lineEnd++;
    const before = content.slice(lineStart, r.start);
    const after = content.slice(r.end, lineEnd);
    if (/^[ \t]*$/.test(before) && /^[ \t;]*\r?$/.test(after)) {
        return { start: lineStart, end: lineEnd < content.length ? lineEnd + 1 : lineEnd };
    }
    return r;
}

/** Remove noise ranges (merged, widened to whole lines when possible). */
function removeNoise(content: string, noise: NoiseRange[]): string {
    if (noise.length === 0) return content;
    const ranges = noise
        .map(r => widenToLines(content, r))
        .sort((a, b) => a.start - b.start);
    const merged: NoiseRange[] = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
        else merged.push({ ...r });
    }
    let out = "";
    let cursor = 0;
    for (const r of merged) {
        out += content.slice(cursor, r.start);
        cursor = r.end;
    }
    return out + content.slice(cursor);
}

/**
 * Stage 1: remove the given noise ranges (see findNoiseRanges) and normalize
 * whitespace. Without ranges only whitespace is normalized — it never guesses
 * where comments are, so it cannot corrupt code or prose.
 * Returns cleaned text and number of characters removed.
 */
export function preprocess(
    content: string,
    _filePath: string,
    noise: NoiseRange[] = [],
): { cleaned: string; removed: number } {
    let text = removeNoise(content, noise);

    // Collapse consecutive empty lines to single blank line
    text = text.replace(/\n{3,}/g, "\n\n");

    // Remove trailing whitespace per line
    text = text.replace(/[ \t]+$/gm, "");

    // Remove leading blank lines
    text = text.replace(/^\n+/, "");

    // Remove trailing blank lines
    text = text.replace(/\n+$/, "\n");

    const removed = content.length - text.length;
    return { cleaned: text, removed: Math.max(0, removed) };
}

// ─── Stage 3: Structural Compression ────────────────────────────────

/**
 * Extract key references from function body code.
 * Identifies imports, function calls, and important variables.
 */
function extractKeyReferences(code: string): string[] {
    const refs = new Set<string>();

    // Find function/method calls: word(
    const callMatches = code.matchAll(/\b([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/g);
    for (const m of callMatches) {
        const name = m[1];
        // Skip common keywords
        if (!["if", "for", "while", "switch", "catch", "return", "throw", "new", "await", "function", "class"].includes(name)) {
            refs.add(name);
        }
    }

    // Find imports: from "..."
    const importMatches = code.matchAll(/from\s+["']([^"']+)["']/g);
    for (const m of importMatches) {
        refs.add(m[1]);
    }

    // Limit to 5 most useful refs
    return Array.from(refs).slice(0, 5);
}

/**
 * For code files, strip function bodies using AST.
 * - aggressive: replace bodies with /* TG compressed *​/
 * - medium: keep only key body lines (return, throw, await, assignments)
 */
async function structuralCompress(
    text: string,
    filePath: string,
    parser: ASTParser,
    level: CompressionLevel,
    originalContent: string
): Promise<string> {
    const lang = detectLang(filePath);
    if (lang === "unknown") return text;

    // Parse the ORIGINAL content to get accurate AST positions
    let parseResult;
    try {
        parseResult = await parser.parse(filePath, originalContent);
    } catch {
        return text; // If parsing fails, return text as-is
    }

    if (parseResult.chunks.length === 0) return text;

    // For aggressive: rebuild from AST chunks (signatures + imports)
    if (level === "aggressive") {
        // STRATEGY: Splice approach. Start from the ORIGINAL content and
        // replace function/method BODIES with compact stubs, preserving all
        // module-level code (app.use(), Router(), dotenv.config(), etc.).
        // Previous approach rebuilt from chunks, silently deleting everything
        // between functions.

        // Sort chunks by startIndex descending (bottom-up) to preserve byte offsets
        const sortedChunks = [...parseResult.chunks].sort(
            (a, b) => b.startIndex - a.startIndex
        );

        let result = originalContent;

        for (const chunk of sortedChunks) {
            const bodyLineCount = chunk.rawCode.split("\n").length;
            const refs = extractKeyReferences(chunk.rawCode);
            const refsStr = refs.length > 0 ? ` refs:${refs.join(",")}` : "";
            const compactStub = `/*[nreki:${bodyLineCount}L${refsStr}]*/`;

            // Conservation law: replacement must be strictly smaller than original
            const replacement = `${chunk.shorthand}\n${compactStub}`;
            if (replacement.length < chunk.rawCode.length) {
                result = result.substring(0, chunk.startIndex) +
                         replacement +
                         result.substring(chunk.endIndex);
            }
            // If stub would bloat, leave the original code untouched
        }

        return `// [NREKI] ${filePath} | aggressive | ${parseResult.chunks.length} chunks\n${result}`;
    }

    // For medium: keep signatures + key body lines
    if (level === "medium") {
        const parts: string[] = [];
        const lines = originalContent.split("\n");

        parts.push(`// [NREKI] ${filePath} | medium | ${parseResult.chunks.length} chunks`);

        // Keep imports
        const firstChunkLine = Math.min(...parseResult.chunks.map(c => c.startLine));
        for (let i = 0; i < Math.min(firstChunkLine - 1, lines.length); i++) {
            const trimmed = lines[i].trim();
            if (
                trimmed.startsWith("import") ||
                trimmed.startsWith("export") ||
                trimmed.startsWith("type ") ||
                trimmed.startsWith("interface ") ||
                trimmed.startsWith("from ") ||
                trimmed.startsWith("package ") ||
                trimmed.startsWith("require")
            ) {
                parts.push(lines[i]);
            }
        }

        for (const chunk of parseResult.chunks) {
            // Signature
            parts.push(chunk.shorthand);

            // Key body lines
            const bodyLines = chunk.rawCode.split("\n");
            const keyLines = bodyLines.filter(line => {
                const trimmed = line.trim();
                return (
                    trimmed.startsWith("return ") ||
                    trimmed.startsWith("throw ") ||
                    trimmed.startsWith("await ") ||
                    trimmed.startsWith("yield ") ||
                    trimmed.includes("= new ") ||
                    trimmed.startsWith("if (") ||
                    trimmed.startsWith("for (") ||
                    trimmed.startsWith("while (") ||
                    trimmed.includes("this.") ||
                    (trimmed.startsWith("const ") && trimmed.includes("="))
                );
            });

            if (keyLines.length > 0) {
                parts.push("  // Key lines:");
                for (const kl of keyLines.slice(0, 5)) {
                    parts.push(`  ${kl.trim()}`);
                }
            }
        }

        return parts.join("\n");
    }

    return text;
}

// ─── AdvancedCompressor Class ────────────────────────────────────────

export class AdvancedCompressor {
    private parser: ASTParser;

    constructor(parser: ASTParser) {
        this.parser = parser;
    }

    /**
     * Compress content: Stage 1 noise removal, then Stage 3 structure (medium/aggressive).
     */
    async compress(
        filePath: string,
        content: string,
        level: CompressionLevel = "medium"
    ): Promise<AdvancedCompressionResult> {
        const originalSize = content.length;

        // ─── Stage 1: Preprocessing (AST-exact) ──────────────
        const noise = await findNoiseRanges(content, filePath, this.parser);
        const { cleaned, removed: preprocessingReduction } = preprocess(content, filePath, noise);
        const afterPreprocess = cleaned;

        // ─── Stage 2: removed (see header) ──────────────────────
        const tokenFilterReduction = 0;

        // ─── Stage 3: Structural Compression ─────────────────
        let afterStructural = afterPreprocess;
        let structuralReduction = 0;

        if (level === "medium" || level === "aggressive") {
            try {
                const structResult = await structuralCompress(
                    afterPreprocess,
                    filePath,
                    this.parser,
                    level,
                    content // pass original for AST parsing
                );
                // Guard: only use structural result if it's actually smaller
                if (structResult.length < afterPreprocess.length) {
                    afterStructural = structResult;
                    structuralReduction = afterPreprocess.length - structResult.length;
                }
                // Otherwise keep the lossless Stage 1 text (structuralReduction stays 0)
            } catch {
                afterStructural = afterPreprocess;
            }
        }

        const compressed = afterStructural;
        const compressedSize = compressed.length;
        const ratio = originalSize > 0 ? 1 - compressedSize / originalSize : 0;
        const tokensSaved = estimateTokens(content) - estimateTokens(compressed);

        return {
            compressed,
            originalSize,
            compressedSize,
            ratio: Math.max(0, ratio),
            tokensSaved: Math.max(0, tokensSaved),
            level,
            breakdown: {
                preprocessingReduction,
                tokenFilterReduction,
                structuralReduction,
            },
        };
    }

    /**
     * Quick estimate of advanced compression savings.
     */
    static estimateSavings(
        fileContent: string,
        level: CompressionLevel = "medium"
    ): { estimatedRatio: number; estimatedTokensSaved: number } {
        const tokens = estimateTokens(fileContent);
        const ratioByLevel: Record<CompressionLevel, number> = {
            light: 0.50,
            medium: 0.75,
            aggressive: 0.92,
        };
        const ratio = ratioByLevel[level];
        return {
            estimatedRatio: ratio,
            estimatedTokensSaved: Math.round(tokens * ratio),
        };
    }
}

// ─── Legacy Compressor (Tier-based, backward compat) ──────────────────

export type CompressionTier = 1 | 2 | 3;

export interface CompressionResult {
    compressed: string;
    originalSize: number;
    compressedSize: number;
    ratio: number;
    tokensSaved: number;
    tier: CompressionTier;
    chunksFound: number;
}

interface CompressorOptions {
    tier?: CompressionTier;
    maxBodyLines?: number;
    includeHeader?: boolean;
    focusQuery?: string;
}

/**
 * Legacy tier-based compressor. Kept for backward compatibility.
 * New code should use AdvancedCompressor (3-stage pipeline).
 */
export class Compressor {
    private parser: ASTParser;

    constructor(parser: ASTParser) {
        this.parser = parser;
    }

    async compress(
        filePath: string,
        content: string,
        options: CompressorOptions = {}
    ): Promise<CompressionResult> {
        const {
            tier = 1,
            maxBodyLines = 5,
            includeHeader = true,
            focusQuery: _focusQuery, // v11.0.0: ranking removed with embeddings amputation
        } = options;

        const parseResult = await this.parser.parse(filePath, content);
        const lines = content.split("\n");

        if (parseResult.chunks.length === 0) {
            return {
                compressed: `// [NREKI] No parseable AST nodes found\n${content}`,
                originalSize: content.length,
                compressedSize: content.length,
                ratio: 0,
                tokensSaved: 0,
                tier,
                chunksFound: 0,
            };
        }

        const parts: string[] = [];
        parts.push(
            `// [NREKI] Compressed: ${filePath} | Tier ${tier} | ${parseResult.chunks.length} chunks`
        );

        if (includeHeader) {
            const firstChunkLine = Math.min(
                ...parseResult.chunks.map((c) => c.startLine)
            );
            const headerLines = lines.slice(0, firstChunkLine - 1);
            const header = headerLines
                .filter(
                    (l) =>
                        l.trim().startsWith("import") ||
                        l.trim().startsWith("export") ||
                        l.trim().startsWith("//") ||
                        l.trim().startsWith("const") ||
                        l.trim().startsWith("type") ||
                        l.trim().startsWith("interface") ||
                        l.trim().length === 0
                )
                .join("\n");
            if (header.trim()) {
                parts.push(header);
            }
        }

        // v11.0.0: focusQuery semantic ranking removed with embeddings
        // amputation. Chunks emitted in original AST order.
        const rankedChunks = parseResult.chunks;

        for (const chunk of rankedChunks) {
            const compressed = this.compressChunk(chunk, tier, maxBodyLines);
            parts.push(compressed);
        }

        const compressed = parts.join("\n\n");
        const originalSize = content.length;
        const compressedSize = compressed.length;
        const ratio = 1 - compressedSize / originalSize;
        const tokensSaved = estimateTokens(content) -
            estimateTokens(compressed);

        return {
            compressed,
            originalSize,
            compressedSize,
            ratio: Math.max(0, ratio),
            tokensSaved: Math.max(0, tokensSaved),
            tier,
            chunksFound: parseResult.chunks.length,
        };
    }

    private compressChunk(
        chunk: import("./parser.js").ParsedChunk,
        tier: CompressionTier,
        maxBodyLines: number
    ): string {
        if (tier === 1) return chunk.shorthand;
        if (tier === 2) return this.compressTier2(chunk, maxBodyLines);
        if (tier === 3) return this.compressTier3(chunk, maxBodyLines);
        return chunk.shorthand;
    }

    private compressTier2(chunk: import("./parser.js").ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");
        if (lines.length <= maxBodyLines + 2) {
            return `[${chunk.nodeType}] ${chunk.rawCode.trim()}`;
        }
        const keyLines = lines.filter((line) => {
            const trimmed = line.trim();
            return (
                trimmed.startsWith("return ") ||
                trimmed.startsWith("throw ") ||
                trimmed.startsWith("await ") ||
                trimmed.startsWith("yield ") ||
                trimmed.includes("= new ") ||
                trimmed.includes("this.") ||
                trimmed.startsWith("if (") ||
                trimmed.startsWith("for (") ||
                trimmed.startsWith("while (")
            );
        });
        const signature = chunk.shorthand;
        const body = keyLines.slice(0, maxBodyLines).join("\n    ");
        return body ? `${signature}\n  // Key lines:\n    ${body}` : signature;
    }

    private compressTier3(chunk: import("./parser.js").ParsedChunk, maxBodyLines: number): string {
        const lines = chunk.rawCode.split("\n");
        const docLines: string[] = [];
        let inDoc = false;
        let pastHeader = false;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("/**") || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
                inDoc = true;
            }
            if (inDoc) {
                docLines.push(line);
                if (
                    trimmed.endsWith("*/") ||
                    (trimmed.endsWith('"""') && docLines.length > 1) ||
                    (trimmed.endsWith("'''") && docLines.length > 1)
                ) {
                    inDoc = false;
                }
                continue;
            }
            if (!pastHeader && (trimmed.startsWith("//") || trimmed.startsWith("#"))) {
                docLines.push(line);
                continue;
            }
            if (trimmed.length > 0) {
                pastHeader = true;
            }
        }
        const tier2 = this.compressTier2(chunk, maxBodyLines);
        if (docLines.length > 0) {
            return `${docLines.join("\n")}\n${tier2}`;
        }
        return tier2;
    }

    static estimateSavings(
        fileContent: string,
        tier: CompressionTier = 1
    ): { estimatedRatio: number; estimatedTokensSaved: number } {
        const tokens = estimateTokens(fileContent);
        const ratioByTier: Record<CompressionTier, number> = { 1: 0.75, 2: 0.5, 3: 0.3 };
        const ratio = ratioByTier[tier];
        return {
            estimatedRatio: ratio,
            estimatedTokensSaved: Math.round(tokens * ratio),
        };
    }
}
