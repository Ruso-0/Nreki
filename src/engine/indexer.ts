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
import { shouldProcess } from "../utils/file-filter.js";
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

        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch { return null; }

        if (!shouldProcess(filePath, stat.size).process) {
            this.db.clearChunks(filePath);
            return null;
        }

        let content: string;
        try { content = readSource(filePath); } catch { return null; }

        const ext = path.extname(filePath).toLowerCase();
        if (!this.parser.isSupported(ext)) {
            return this.indexPlaintextFallback(filePath, content, ext);
        }

        if (!this.db.fileNeedsUpdate(filePath, content)) return null;

        return this.indexAstChunks(filePath, content);
    }

    private async indexPlaintextFallback(filePath: string, content: string, ext: string): Promise<ParseResult | null> {
        if (!this.db.fileNeedsUpdate(filePath, content)) return null;

        const lineCount = content.split("\n").length;
        const shorthand = `[file] ${path.basename(filePath)} (${lineCount} lines)\n${content}`;

        this.db.clearChunks(filePath);

        this.db.insertChunk(filePath, shorthand, content, "file", 1, lineCount);
        this.db.upsertFile(filePath, this.db.hashContent(content));

        return {
            filePath,
            chunks: [{ shorthand, rawCode: content, nodeType: "file", startLine: 1, endLine: lineCount, startIndex: 0, endIndex: content.length, symbolName: "" }],
            totalLines: lineCount,
            language: ext.slice(1),
        };
    }

    private async indexAstChunks(filePath: string, content: string): Promise<ParseResult | null> {
        const result = await this.parser.parse(filePath, content);
        if (result.chunks.length === 0) {
            this.db.clearChunks(filePath);
            return result;
        }

        this.db.clearChunks(filePath);

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
        }> = [];

        for (const chunk of result.chunks) {
            chunkData.push({
                path: filePath,
                shorthand: chunk.shorthand,
                rawCode: chunk.rawCode,
                nodeType: chunk.nodeType,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                symbolName: chunk.symbolName,
            });
        }

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

        return result;
    }

    async indexDirectory(dirPath: string): Promise<{ indexed: number; skipped: number; errors: number }> {
        await this.initCore();

        let indexed = 0;
        let skipped = 0;
        let errors = 0;
        let processedCount = 0;

        const files = this.walkDirectory(dirPath);

        for (const file of files) {
            try {
                const result = await this.indexFile(file);
                if (result && result.chunks.length > 0) indexed++;
                else skipped++;
            } catch (err) {
                logger.error(`Error indexing ${file}: ${(err as Error).message}`);
                errors++;
            }
            // FIX 3: Yield event loop every 100 files to avoid blocking
            if (++processedCount % 100 === 0) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        }

        this.db.save();
        return { indexed, skipped, errors };
    }

    private walkDirectory(dirPath: string): string[] {
        const files: string[] = [];
        const isIgnored = picomatch(this.config.ignorePaths);

        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, "/");

                if (entry.isDirectory()) {
                    // v11.2.1: skip dot-prefixed directories (mirrors
                    // BM25Engine.walkSourceFiles policy at bm25-engine.ts:281).
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
                const ext = path.extname(entry.name).toLowerCase();
                if (this.config.extensions.includes(ext)) files.push(fullPath);
            }
        };

        walk(dirPath);
        return files;
    }
}
