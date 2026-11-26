/**
 * indexer.ts - Indexing pipeline for NREKI (v8.5+).
 *
 * Write side: file watching, AST parsing, embedding generation, batch storage.
 * Extracted from engine.ts to enforce Single Responsibility.
 */

import fs from "fs";
import path from "path";
import picomatch from "picomatch";
import type { NrekiDB } from "../database.js";
import type { ASTParser, ParseResult } from "../parser.js";
import { shouldProcess, SECONDARY_DIRS } from "../utils/file-filter.js";
import { safePath } from "../utils/path-jail.js";
import { qualifiedNames } from "../utils/engram-identity.js";
import { readSource } from "../utils/read-source.js";
import { logger } from "../utils/logger.js";
import type { EngineConfig } from "../engine-types.js";

export class IndexPipeline {
    constructor(
        private db: NrekiDB,
        private parser: ASTParser,
        private config: Required<EngineConfig>,
        private initCore: () => Promise<void>,
    ) {}

    async indexFile(filePath: string): Promise<ParseResult | null> {
        await this.initCore();
        try {
            if (!this.isIndexable(filePath)) {
                this.db.clearChunks(filePath);
                return null;
            }
            const stat = fs.statSync(filePath);
            if (!shouldProcess(filePath, stat.size).process) {
                this.db.clearChunks(filePath);
                return null;
            }
            const content = readSource(filePath);
            const ext = path.extname(filePath).toLowerCase();
            if (!this.parser.isSupported(ext)) {
                return await this.indexPlaintextFallback(filePath, content, ext);
            }
            if (!this.db.fileNeedsUpdate(filePath, content)) return null;
            return await this.indexAstChunks(filePath, content);
        } catch (error) {
            await this.initCore();
            this.db.clearChunks(filePath);
            throw error;
        }
    }

    /** Regular file whose real location is inside the project and not sensitive (.env, keys…). */
    private isIndexable(filePath: string): boolean {
        try {
            if (fs.lstatSync(filePath).isSymbolicLink()) return false;
            safePath(this.config.watchPaths[0] ?? process.cwd(), filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async indexPlaintextFallback(filePath: string, content: string, ext: string): Promise<ParseResult | null> {
        if (!this.db.fileNeedsUpdate(filePath, content)) return null;

        const lines = content.split("\n");
        const lineCount = lines.length;
        const preview = lines
            .map(l => l.trim())
            .filter(l => l.length > 0)
            .slice(0, 3)
            .join(" ")
            .slice(0, 200);
        const shorthand = preview
            ? `[file] ${path.basename(filePath)} (${lineCount} lines) — ${preview}`
            : `[file] ${path.basename(filePath)} (${lineCount} lines)`;

        this.db.clearChunks(filePath);

        this.db.insertChunk(filePath, shorthand, content, "file", 1, lineCount, 0, content.length);
        this.db.upsertFile(filePath, this.db.hashContent(content));

        return {
            filePath,
            chunks: [{ shorthand, rawCode: content, nodeType: "file", startLine: 1, endLine: lineCount, startIndex: 0, endIndex: content.length, symbolName: "" }],
            totalLines: lineCount,
            language: ext.slice(1),
        };
    }

    /** Extract top-of-file header comments (up to first 25 lines). */
    private extractFileHeaderComment(lines: string[]): string {
        const collected: string[] = [];
        let inBlock = false;
        const maxScan = Math.min(lines.length, 25);
        for (let i = 0; i < maxScan; i++) {
            const trimmed = lines[i].trim();
            if (!inBlock) {
                if (trimmed === "" || trimmed.startsWith("#!")) continue;
                if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
                    collected.push(trimmed.replace(/^(?:\/\/|#)+\s*/, ""));
                    continue;
                }
                if (trimmed.startsWith("/*")) {
                    inBlock = true;
                    const cleaned = trimmed.replace(/^\/\*+\s*/, "").replace(/\*+\/\s*$/, "").trim();
                    if (cleaned) collected.push(cleaned);
                    if (trimmed.includes("*/")) inBlock = false;
                    continue;
                }
                break;
            } else {
                const cleaned = trimmed.replace(/^\*+\/?\s*/, "").replace(/\*+\/\s*$/, "").trim();
                if (cleaned) collected.push(cleaned);
                if (trimmed.includes("*/")) inBlock = false;
            }
        }
        return collected.join(" ").slice(0, 600);
    }

    /** Extract contiguous comment block immediately preceding a 1-based startLine. */
    private extractPrecedingComment(lines: string[], startLine: number): string {
        const collected: string[] = [];
        let idx = startLine - 2; // 0-based line immediately above startLine
        // Allow skipping decorator lines (@...) right above declaration
        while (idx >= 0 && lines[idx].trim().startsWith("@")) {
            idx--;
        }
        if (idx < 0) return "";

        // Bounded walk: a code line that merely ENDS with "*/" (e.g. inside a
        // string) must not make every chunk rescan the file up to line 1.
        const floor = Math.max(0, idx - 80);
        const firstAbove = lines[idx].trim();
        if (firstAbove.endsWith("*/")) {
            while (idx >= floor) {
                const t = lines[idx].trim();
                const cleaned = t
                    .replace(/^\/\*+\s*/, "")
                    .replace(/\*+\/\s*$/, "")
                    .replace(/^\*+\s?/, "")
                    .trim();
                if (cleaned) collected.unshift(cleaned);
                if (t.startsWith("/*")) break;
                idx--;
            }
        } else if (firstAbove.startsWith("//") || firstAbove.startsWith("#")) {
            while (idx >= floor) {
                const t = lines[idx].trim();
                if (t.startsWith("//") || t.startsWith("#")) {
                    const cleaned = t.replace(/^(?:\/\/|#)+\s*/, "").trim();
                    if (cleaned) collected.unshift(cleaned);
                    idx--;
                } else {
                    break;
                }
            }
        }
        return collected.join(" ").slice(0, 600);
    }

    private async indexAstChunks(filePath: string, content: string): Promise<ParseResult | null> {
        const result = await this.parser.parse(filePath, content);
        await this.initCore();
        const lines = content.split("\n");
        const totalLines = lines.length;
        const fileHeader = this.extractFileHeaderComment(lines);

        // Track lines covered by AST chunks (1-based)
        const covered = new Uint8Array(totalLines + 1);
        for (const chunk of result.chunks) {
            const s = Math.max(1, chunk.startLine);
            const e = Math.min(totalLines, chunk.endLine);
            for (let ln = s; ln <= e; ln++) covered[ln] = 1;
        }

        const chunkData: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            startIndex: number;
            endIndex: number;
            symbolName: string;
            contextComment?: string;
            qualifiedName?: string;
        }> = [];

        const qualified = qualifiedNames(result.chunks);
        for (const [i, chunk] of result.chunks.entries()) {
            const preceding = this.extractPrecedingComment(lines, chunk.startLine);
            const contextComment = [fileHeader, preceding].filter(Boolean).join("\n");
            chunkData.push({
                qualifiedName: qualified[i],
                path: filePath,
                shorthand: chunk.shorthand,
                rawCode: chunk.rawCode,
                nodeType: chunk.nodeType,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                symbolName: chunk.symbolName,
                contextComment,
            });
        }

        // Capture uncovered top-level line ranges (imports, headers, JSDoc blocks,
        // module-level calls like server.tool(...) / describe(...)) so fast_grep
        // and searchRawCode achieve 100% lexical coverage of the file.
        // lineStart[i] = UTF-16 offset of 0-based line i in `content` (same unit
        // as the parser's startIndex/endIndex).
        const lineStart = new Array<number>(totalLines);
        for (let i = 0, off = 0; i < totalLines; i++) {
            lineStart[i] = off;
            off += lines[i].length + 1;
        }
        let gapStart = 0;
        for (let ln = 1; ln <= totalLines + 1; ln++) {
            const isUncovered = ln <= totalLines && covered[ln] === 0;
            if (isUncovered) {
                if (gapStart === 0) gapStart = ln;
            } else if (gapStart > 0) {
                const gapEnd = ln - 1;
                const gapLines = lines.slice(gapStart - 1, gapEnd);
                const gapRaw = gapLines.join("\n");
                if (gapRaw.trim().length > 0) {
                    const preview = gapLines
                        .map(l => l.trim())
                        .filter(l => l.length > 0 && !l.startsWith("import "))
                        .slice(0, 2)
                        .join(" ")
                        .slice(0, 140);
                    const shorthand = preview
                        ? `[top_level] ${path.basename(filePath)}:L${gapStart}-L${gapEnd} — ${preview}`
                        : `[top_level] ${path.basename(filePath)}:L${gapStart}-L${gapEnd}`;
                    chunkData.push({
                        path: filePath,
                        shorthand,
                        rawCode: gapRaw,
                        nodeType: "top_level",
                        startLine: gapStart,
                        endLine: gapEnd,
                        startIndex: lineStart[gapStart - 1],
                        endIndex: lineStart[gapStart - 1] + gapRaw.length,
                        symbolName: "",
                        contextComment: gapStart === 1 ? fileHeader : "",
                    });
                }
                gapStart = 0;
            }
        }

        if (chunkData.length === 0) {
            this.db.clearChunks(filePath);
            return result;
        }

        this.db.clearChunks(filePath);

        const chunkIds = this.db.insertChunksBatch(chunkData);

        // Type Ledger: persist consumes/produces relations from parser.
        const ioRows: Array<{ chunkId: number; ioType: "consumes" | "produces"; typeName: string }> = [];
        for (let i = 0; i < result.chunks.length; i++) {
            const chunk = result.chunks[i];
            const chunkId = chunkIds[i];
            if (chunk.consumes !== undefined && chunk.consumes.length > 0) {
                for (const typeName of chunk.consumes) {
                    ioRows.push({ chunkId, ioType: "consumes", typeName });
                }
            }
            if (chunk.produces !== undefined && chunk.produces.length > 0) {
                for (const typeName of chunk.produces) {
                    ioRows.push({ chunkId, ioType: "produces", typeName });
                }
            }
        }
        if (ioRows.length > 0) {
            this.db.insertSymbolIosBulk(ioRows);
        }

        this.db.upsertFile(filePath, this.db.hashContent(content));

        if (result.chunks.length === 0 && chunkData.length > 0) {
            return {
                ...result,
                chunks: chunkData.map(c => ({
                    shorthand: c.shorthand,
                    rawCode: c.rawCode,
                    nodeType: c.nodeType,
                    startLine: c.startLine,
                    endLine: c.endLine,
                    startIndex: c.startIndex,
                    endIndex: c.endIndex,
                    symbolName: c.symbolName,
                })),
            };
        }

        return result;
    }

    async indexDirectory(dirPath: string): Promise<{ indexed: number; skipped: number; errors: number }> {
        await this.initCore();

        let indexed = 0;
        let skipped = 0;
        let errors = 0;
        let processedCount = 0;

        const files = this.walkDirectory(dirPath);
        const root = path.resolve(dirPath);
        const watchRoots = this.config.watchPaths.map(w => path.resolve(w));
        const isInsideDir = (parent: string, candidate: string): boolean => {
            const rel = path.relative(parent, path.resolve(candidate));
            return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
        };
        const key = (file: string) => {
            const absolute = path.resolve(file);
            return process.platform === "win32" ? absolute.toLowerCase() : absolute;
        };
        const current = new Set(files.map(key));
        for (const previous of this.db.getIndexedPaths()) {
            const insideTarget = isInsideDir(root, previous);
            const insideWatched = insideTarget || watchRoots.some(w => isInsideDir(w, previous));
            if (!insideWatched || (insideTarget && !current.has(key(previous)))) {
                this.db.clearChunks(previous);
            }
        }

        for (const file of files) {
            try {
                const result = await this.indexFile(file);
                if (result && result.chunks.length > 0) indexed++;
                else skipped++;
            } catch (err) {
                await this.initCore();
                logger.error(`Error indexing ${file}: ${(err as Error).message}`);
                errors++;
            }
            // FIX 3: Yield event loop every 100 files to avoid blocking
            if (++processedCount % 100 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        }

        await this.initCore();
        this.db.save();
        return { indexed, skipped, errors };
    }

    private walkDirectory(dirPath: string): string[] {
        const files: string[] = [];
        const isIgnored = picomatch(this.config.ignorePaths);
        // Explicitly indexed fallback languages remain managed across refreshes.
        const known = new Set(this.db.getIndexedPaths().map(file => path.resolve(file)));

        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

            // Prioritize production source directories (src, lib, core, etc.) over
            // scripts/tests/benchmarks so fgCache slots start with primary code.
            // Key = (secondary dir?, name): a total order. Ranking only dir-vs-dir
            // pairs was intransitive once files sat between them, which leaves
            // the result up to the sort implementation.
            const rank = (e: fs.Dirent) => (e.isDirectory() && SECONDARY_DIRS.has(e.name.toLowerCase()) ? 1 : 0);
            entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, "/");

                if (entry.isDirectory()) {
                    // v11.2.1: skip dot-prefixed directories.
                    // Covers .git, .next, .venv*, .eval-phase5-cache, .turbo,
                    // .cache, .parcel-cache, .pytest_cache, .mypy_cache,
                    // .ruff_cache, .idea, .vscode, .ipynb_checkpoints, .nreki,
                    // .nreki-runtime without enumeration. Pre-v11.2.1 these
                    // were walked synchronously by fs.readdirSync, blocking the
                    // MCP event loop for tens of seconds on heavy dot-dirs and
                    // surfacing to Claude Code as a tools/call EOF.
                    if (entry.name.startsWith(".")) continue;
                    if (!isIgnored(entry.name) && !isIgnored(relativePath) && !isIgnored(relativePath + "/")) {
                        walk(fullPath);
                    }
                    continue;
                }

                if (isIgnored(relativePath) || isIgnored(entry.name)) continue;
                // Symlinks are skipped: a planted `src/x.ts -> ~/.ssh/id_ed25519` would
                // otherwise be read, indexed and served by fast_grep/search (and sent to
                // Voyage when enabled), bypassing the jail every read tool applies.
                if (entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()) continue;
                const ext = path.extname(entry.name).toLowerCase();
                if (this.config.extensions.includes(ext) || known.has(path.resolve(fullPath))) files.push(fullPath);
            }
        };

        walk(dirPath);
        return files;
    }
}
