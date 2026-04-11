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
import type { Embedder } from "../embedder.js";
import { shouldProcess } from "../utils/file-filter.js";
import { readSource } from "../utils/read-source.js";
import { logger } from "../utils/logger.js";
import type { EngineConfig } from "../engine-types.js";

export class IndexPipeline {
    constructor(
        private db: NrekiDB,
        private parser: ASTParser,
        private embedder: Embedder,
        private config: Required<EngineConfig>,
        private initCore: () => Promise<void>,
        private initEmbedder: () => Promise<void>,
    ) {}

    async indexFile(filePath: string): Promise<ParseResult | null> {
        if (this.config.enableEmbeddings) await this.initEmbedder();
        else await this.initCore();

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

        let embedding: Float32Array = new Float32Array(0);
        if (this.config.enableEmbeddings) {
            await this.initEmbedder();
            ({ embedding } = await this.embedder.embed(content.slice(0, 1000)));
        }

        this.db.insertChunk(filePath, shorthand, content, "file", 1, lineCount, embedding);
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
            embedding: Float32Array;
            startIndex: number;
            endIndex: number;
            symbolName: string;
        }> = [];

        for (const chunk of result.chunks) {
            let embedding: Float32Array = new Float32Array(0);
            if (this.config.enableEmbeddings) {
                ({ embedding } = await this.embedder.embed(chunk.shorthand));
            }
            chunkData.push({
                path: filePath,
                shorthand: chunk.shorthand,
                rawCode: chunk.rawCode,
                nodeType: chunk.nodeType,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                embedding,
                startIndex: chunk.startIndex,
                endIndex: chunk.endIndex,
                symbolName: chunk.symbolName,
            });
        }

        this.db.insertChunksBatch(chunkData);
        this.db.upsertFile(filePath, this.db.hashContent(content));

        return result;
    }

    async indexDirectory(dirPath: string): Promise<{ indexed: number; skipped: number; errors: number }> {
        if (this.config.enableEmbeddings) await this.initEmbedder();
        else await this.initCore();

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
