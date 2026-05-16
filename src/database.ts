/**
 * database.ts - SQLite persistence layer for NREKI.
 *
 * Uses sql.js (SQLite compiled to WASM) for zero-native-dependency
 * operation. Vector search AND keyword search are both implemented
 * in pure JavaScript:
 *
 * - KeywordIndex: inverted index with Porter-inspired BM25 scoring
 *
 * This eliminates the need for FTS5, sqlite-vec, better-sqlite3,
 * node-gyp, and Visual Studio Build Tools - making NREKI
 * portable to any platform without native compilation.
 */

import initSqlJs, { type Database as SqlJsDatabase, type Statement as SqlJsStatement } from "sql.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "./utils/logger.js";
import { escapeRegExp } from "./utils/imports.js";
import { registerTestResource } from "./utils/test-resource-registry.js";

// ─── Motores de Búsqueda (Segregación de Dominio) ───
import { KeywordIndex } from "./search/keyword-index.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface FileRecord {
    path: string;
    hash: string;
}

export interface ChunkRecord {
    id: number;
    path: string;
    shorthand: string;
    raw_code: string;
    node_type: string;
    start_line: number;
    end_line: number;
    start_index: number;
    end_index: number;
    symbol_name: string;
}

/**
 * Shape returned by fastGrep(): the 4 columns handleFastGrep consumes.
 * Avoids sql.js WASM overhead of serializing unused columns per row.
 */
export interface FastGrepHit {
    path: string;
    raw_code: string;
    start_line: number;
    symbol_name: string;
}

export type FastGrepCacheRow = [
    id: number,
    path: string,
    symbolName: string,
    startLine: number,
    rawCode: string,
];

export interface HybridSearchResult {
    id: number;
    path: string;
    shorthand: string;
    raw_code: string;
    node_type: string;
    start_line: number;
    end_line: number;
    start_index: number;
    end_index: number;
    symbol_name: string;
    rrf_score: number;
}

export interface TokenStats {
    total_chunks: number;
    total_files: number;
    total_raw_tokens: number;
    total_shorthand_tokens: number;
    compression_ratio: number;
}


// ─── Database Manager ────────────────────────────────────────────────

export class NrekiDB {
    private db!: SqlJsDatabase;
    private kwIndex = new KeywordIndex();
    /** In-memory identifier index: file path → unique identifiers in that file's raw code. */
    private rawIdentsByFile = new Map<string, Set<string>>();
    private rawIdentsLoaded = false;
    private dbPath: string;
    private initPromise: Promise<void> | null = null;
    private _ready = false;
    private closed = false;
    private _hasIndexedFiles = false;
    private fastGrepStmt: SqlJsStatement | null = null;
    private usageStmt: SqlJsStatement | null = null;
    private fastGrepCacheInvalidationHook: ((filePath?: string) => void) | null = null;

    /**
     * Phase 5 Sprint 4.8 (Furia round 26+ post-INV-6):
     *
     * Hot-path cached prepared statements. The previous `db.run(...)` /
     * `db.exec(...)` shorthands in insertChunk / upsertFile / clearChunks
     * each trigger one sqlite3_prepare_v2 + sqlite3_finalize cycle.
     * sql.js leaks a uint16 schema-ref counter per cycle in our access
     * pattern, overflowing the SQLite cap of 65535 after ~6 engine
     * lifetimes on vscode-scale workspaces ("too many references to
     * \"idx_chunks_symbol_name\": max 65535" → "memory access out of
     * bounds" WASM trap).
     *
     * Caching these statements once per Database instance and re-binding
     * across thousands of inserts collapses the cycle count from
     * ~50 000/engine for insertChunk alone down to 1, plus a single
     * cycle each for upsertFile / clearChunks DELETEs — well below cap.
     *
     * NOTE -- intentionally NOT cached: SELECT statements that alternate
     * between "row present" and "row absent" between calls (the
     * fileNeedsUpdate path + the clearChunks initial SELECT). Bisect on
     * engine-watcher.test.ts showed a sql.js cursor-staleness pattern
     * when those are cached: the watcher's bootstrap-then-re-index
     * flow reads a stale "no rows" result on the second invocation
     * even after reset()+bind(). The cost (~5K prepare/finalize/file)
     * is dominated by chunk-INSERT cycles anyway.
     *
     * All cached handles are freed in close() so the WASM-side struct
     * is released alongside the Database.
     */
    private insertChunkStmt: SqlJsStatement | null = null;
    private lastInsertRowidStmt: SqlJsStatement | null = null;
    private upsertFileStmt: SqlJsStatement | null = null;
    private clearChunksDeleteSymbolIoStmt: SqlJsStatement | null = null;
    private clearChunksDeleteChunksStmt: SqlJsStatement | null = null;
    private clearChunksDeleteFilesStmt: SqlJsStatement | null = null;

    constructor(dbPath: string = ".nreki.db") {
        this.dbPath = dbPath;
        registerTestResource(this);
    }

    /** Async initialization - must be called before any DB operation. */
    async initialize(): Promise<void> {
        if (this._ready) return;
        if (!this.initPromise) {
            this.initPromise = this._init();
        }
        await this.initPromise;
        this.closed = false;
    }

    private async _init(): Promise<void> {
        const SQL = await initSqlJs();

        // Load existing database if it exists
        if (fs.existsSync(this.dbPath)) {
            try {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new SQL.Database(fileBuffer);
            } catch (err) {
                logger.error(`[NREKI] Database corrupted at ${this.dbPath}. Wiping to recover: ${err}`);
                try { fs.unlinkSync(this.dbPath); } catch {}
                this.db = new SQL.Database();
            }
        } else {
            this.db = new SQL.Database();
        }

        // Setup schema first (creates metadata table needed for dimension lookup)
        this.setupSchema();

        // ─── Schema Version Gate ──────────────────────────────────────
        // Force full reindex when parser/index format changes between
        // versions. Users on older schema get a clean slate without
        // manual .nreki.db deletion. Bumped in v10.18.1.
        // Bumped in v10.20.0 (symbol_io table added).
        // Bumped in v11.0.0 (embeddings amputated, .vec file deprecated).
        const PARSER_SCHEMA_VERSION = 4;
        const storedSchema = parseInt(this.getMetadata("parser_schema_version") ?? "0", 10);
        if (storedSchema < PARSER_SCHEMA_VERSION) {
            if (storedSchema > 0) {
                logger.warn(
                    `[NREKI] Parser schema upgrade (v${storedSchema} -> v${PARSER_SCHEMA_VERSION}). ` +
                    `Forcing full AST reindex.`
                );
            }
            this.wipeAllIndexedData();
            this.setMetadata("parser_schema_version", String(PARSER_SCHEMA_VERSION));
        }

        // Rebuild in-memory indexes from existing data
        this.rebuildKeywordIndex();

        this._ready = true;
        const result = this.db.exec("SELECT 1 FROM files LIMIT 1");
        this._hasIndexedFiles = result.length > 0 && result[0].values.length > 0;
    }

    get ready(): boolean {
        return this._ready;
    }

    setFastGrepCacheInvalidationHook(hook: ((filePath?: string) => void) | null): void {
        this.fastGrepCacheInvalidationHook = hook;
    }

    // ─── Schema ──────────────────────────────────────────────────

    private setupSchema(): void {
        this.db.run(`
      -- Indexed files with content hashes for Merkle-style diffing
      CREATE TABLE IF NOT EXISTS files (
        path      TEXT PRIMARY KEY,
        hash      TEXT NOT NULL,
        indexed_at TEXT DEFAULT (datetime('now'))
      );

      -- AST chunks extracted from source files
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT NOT NULL,
        shorthand   TEXT NOT NULL,
        raw_code    TEXT NOT NULL,
        node_type   TEXT NOT NULL DEFAULT 'unknown',
        start_line  INTEGER NOT NULL DEFAULT 0,
        end_line    INTEGER NOT NULL DEFAULT 0,
        start_index INTEGER NOT NULL DEFAULT 0,
        end_index   INTEGER NOT NULL DEFAULT 0,
        symbol_name TEXT NOT NULL DEFAULT ''
      );

      -- Token usage tracking
      CREATE TABLE IF NOT EXISTS usage_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT DEFAULT (datetime('now')),
        tool_name  TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        saved_tokens  INTEGER NOT NULL DEFAULT 0
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON chunks(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);

      -- Metadata key-value store (embedding dimension, model name, etc.)
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Long-term symbol memories (Exocortex Engrams)
      CREATE TABLE IF NOT EXISTS engrams (
        path        TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        ast_hash    TEXT NOT NULL,
        insight     TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (path, symbol_name)
      );

      CREATE TABLE IF NOT EXISTS symbol_io (
        chunk_id   INTEGER NOT NULL,
        io_type    TEXT NOT NULL CHECK (io_type IN ('consumes', 'produces')),
        type_name  TEXT NOT NULL,
        PRIMARY KEY (chunk_id, io_type, type_name)
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_io_type_name ON symbol_io(type_name);
      CREATE INDEX IF NOT EXISTS idx_symbol_io_chunk     ON symbol_io(chunk_id);
    `);

        // Migration: add columns for existing DBs that lack them
        const migrationColumns = [
            "ALTER TABLE chunks ADD COLUMN start_index INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chunks ADD COLUMN end_index INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chunks ADD COLUMN symbol_name TEXT NOT NULL DEFAULT ''",
        ];
        for (const sql of migrationColumns) {
            try { this.db.run(sql); } catch { /* column already exists */ }
        }

        this.db.run(`
            PRAGMA cache_size = -65536;
            PRAGMA temp_store = MEMORY;
        `);
        if (this.usageStmt) {
            this.usageStmt.free();
            this.usageStmt = null;
        }
    }

    /** Rebuild the in-memory keyword index from all existing chunks. */
    private rebuildKeywordIndex(): void {
        // AUDIT FIX: Use prepared statement + iterator to avoid loading all rows into RAM
        const stmt = this.db.prepare("SELECT id, shorthand FROM chunks");
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as { id: number; shorthand: string };
                this.kwIndex.insert(row.id, row.shorthand);
            }
        } finally {
            stmt.free();
        }
    }

    /** Lazy-build the in-memory raw identifier index on first searchRawCode call. */
    private buildRawIdentsIfNeeded(): void {
        if (this.rawIdentsLoaded) return;
        this.rawIdentsByFile.clear();
        const stmt = this.db.prepare("SELECT path, raw_code FROM chunks");
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as { path: string; raw_code: string };
                let idents = this.rawIdentsByFile.get(row.path);
                if (!idents) { idents = new Set(); this.rawIdentsByFile.set(row.path, idents); }
                const matches = row.raw_code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
                if (matches) for (const m of matches) idents.add(m);
            }
        } finally {
            stmt.free();
        }
        this.rawIdentsLoaded = true;
    }

    /** Extract identifiers from raw code and add to the per-file index. */
    private addRawIdents(filePath: string, rawCode: string): void {
        if (!this.rawIdentsLoaded && this._ready) return; // Skip if lazy cache not yet built
        let idents = this.rawIdentsByFile.get(filePath);
        if (!idents) { idents = new Set(); this.rawIdentsByFile.set(filePath, idents); }
        const matches = rawCode.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
        if (matches) for (const m of matches) idents.add(m);
    }

    // ─── Metadata ────────────────────────────────────────────────

    /** Read a metadata value by key, or null if not set. */
    getMetadata(key: string): string | null {
        const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
        try {
            stmt.bind([key]);
            if (stmt.step()) {
                return (stmt.getAsObject() as { value: string }).value;
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /** Write a metadata key-value pair (upsert). */
    setMetadata(key: string, value: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)",
            [key, value]
        );
    }

    /**
     * Wipes all indexed data from RAM and disk.
     * Prevents ghost vectors and ID drift by cleaning up sequence counters
     * and orphaned .vec files. Used during cache invalidation.
     */
    private wipeAllIndexedData(): void {
        if (this.fastGrepStmt) {
            this.fastGrepStmt.free();
            this.fastGrepStmt = null;
        }
        if (this.usageStmt) {
            this.usageStmt.free();
            this.usageStmt = null;
        }

        // 1. Wipe SQL tables
        this.db.run("DELETE FROM chunks");
        this.db.run("DELETE FROM files");

        // 2. Reset AUTOINCREMENT sequences (ONLY for wiped tables)
        try {
            this.db.run("DELETE FROM sqlite_sequence WHERE name = 'chunks'");
        } catch {
            // Ignored: sqlite_sequence is created automatically by SQLite on first INSERT
        }

        // 3. Reset RAM state
        this.kwIndex = new KeywordIndex();
        this.rawIdentsByFile.clear();
        this.rawIdentsLoaded = false;
        this._hasIndexedFiles = false;
        this.fastGrepCacheInvalidationHook?.();
    }

    // ─── Persistence ─────────────────────────────────────────────

    upsertEngram(filePath: string, symbolName: string, astHash: string, insight: string): void {
        this.db.run(
            "INSERT OR REPLACE INTO engrams (path, symbol_name, ast_hash, insight) VALUES (?, ?, ?, ?)",
            [filePath, symbolName, astHash, insight],
        );
        this.save();
    }

    getEngramsForFile(filePath: string): Map<string, { astHash: string; insight: string }> {
        const stmt = this.db.prepare("SELECT symbol_name, ast_hash, insight FROM engrams WHERE path = ?");
        const result = new Map<string, { astHash: string; insight: string }>();
        try {
            stmt.bind([filePath]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { symbol_name: string; ast_hash: string; insight: string };
                result.set(row.symbol_name, { astHash: row.ast_hash, insight: row.insight });
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    deleteEngram(filePath: string, symbolName: string): void {
        this.db.run(
            "DELETE FROM engrams WHERE path = ? AND symbol_name = ?",
            [filePath, symbolName],
        );
        this.save();
    }

    /** Persist database and vector index to disk. */
    save(): void {
        if (!this.db) return;
        // Phase 5 Sprint 4.8 (Furia round 26+): sql.js's Database.export()
        // calls sqlite3_finalize on every active prepared statement as a
        // side effect. Any cached Statement handle we still hold becomes
        // "Statement closed"; the next .step() throws and silently aborts
        // the surrounding watcher re-index path (engine-watcher.test.ts
        // bisect proved this is the only failure mode of the cached
        // statement refactor).
        //
        // Cheapest correct fix: free + null all of our long-lived
        // statements before export so the lazy "if (!this.X) prepare"
        // guards re-arm them on next use. The save itself runs at most
        // once per debounce window (~1 s of inactivity), so the few
        // prepare/finalize cycles this introduces are negligible vs the
        // ~50 000/engine that the caching avoided.
        this.releaseCachedStatements();
        const data = this.db.export();
        const buffer = Buffer.from(data);
        const dir = path.dirname(this.dbPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Random suffix prevents collision between concurrent
        // MCP processes (Cursor + Claude Code terminal) writing the same DB.
        const tmpDb = `${this.dbPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.writeFileSync(tmpDb, buffer);
        fs.renameSync(tmpDb, this.dbPath);
    }

    /**
     * Free and null every cached prepared statement. Safe to call
     * multiple times. Used by save() (before export, which would
     * invalidate them anyway) and by close() (before db.close()).
     */
    private releaseCachedStatements(): void {
        const freeIfSet = (s: SqlJsStatement | null): null => {
            if (s) { try { s.free(); } catch { /* best-effort on corrupt handle */ } }
            return null;
        };
        this.fastGrepStmt                  = freeIfSet(this.fastGrepStmt);
        this.usageStmt                     = freeIfSet(this.usageStmt);
        this.insertChunkStmt               = freeIfSet(this.insertChunkStmt);
        this.lastInsertRowidStmt           = freeIfSet(this.lastInsertRowidStmt);
        this.upsertFileStmt                = freeIfSet(this.upsertFileStmt);
        this.clearChunksDeleteSymbolIoStmt = freeIfSet(this.clearChunksDeleteSymbolIoStmt);
        this.clearChunksDeleteChunksStmt   = freeIfSet(this.clearChunksDeleteChunksStmt);
        this.clearChunksDeleteFilesStmt    = freeIfSet(this.clearChunksDeleteFilesStmt);
    }

    // ─── File Operations ─────────────────────────────────────────

    fileNeedsUpdate(filePath: string, content: string): boolean {
        // SELECT intentionally NOT cached (see clearChunks comment for
        // the staleness pattern observed under cached SELECTs in the
        // watcher bootstrap-then-re-index flow).
        const newHash = crypto.createHash("sha256").update(content).digest("hex");
        const stmt = this.db.prepare("SELECT hash FROM files WHERE path = ?");
        try {
            stmt.bind([filePath]);
            if (stmt.step()) {
                const row = stmt.getAsObject() as { hash: string };
                return row.hash !== newHash;
            }
            return true;
        } finally {
            stmt.free();
        }
    }

    hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    upsertFile(filePath: string, hash: string): void {
        if (!this.upsertFileStmt) {
            this.upsertFileStmt = this.db.prepare(
                "INSERT OR REPLACE INTO files (path, hash, indexed_at) VALUES (?, ?, datetime('now'))",
            );
        }
        const stmt = this.upsertFileStmt;
        stmt.reset();
        stmt.bind([filePath, hash]);
        stmt.step();
        this._hasIndexedFiles = true;
    }

    clearChunks(filePath: string): void {
        if (this.fastGrepStmt) {
            this.fastGrepStmt.free();
            this.fastGrepStmt = null;
        }

        // SELECT statement intentionally NOT cached: the bisect on
        // engine-watcher.test.ts showed that caching a SELECT that
        // alternates between "row present" and "row absent" between
        // calls exposes a sql.js cursor staleness pattern in the
        // watcher's bootstrap-then-re-index flow. Cost: one
        // prepare/finalize cycle per dirty file -- dominated by the
        // ~5 INSERT cycles per chunk per file anyway.
        const stmt = this.db.prepare("SELECT id FROM chunks WHERE path = ?");
        const ids: number[] = [];
        try {
            stmt.bind([filePath]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { id: number };
                ids.push(row.id);
            }
        } finally {
            stmt.free();
        }

        if (ids.length > 0) {
            this.kwIndex.deleteBulk(ids);
            if (this.rawIdentsLoaded) this.rawIdentsByFile.delete(filePath);

            // DELETE statements safe to cache -- no result-set staleness.
            if (!this.clearChunksDeleteSymbolIoStmt) {
                this.clearChunksDeleteSymbolIoStmt = this.db.prepare(
                    "DELETE FROM symbol_io WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)",
                );
            }
            const delSymbol = this.clearChunksDeleteSymbolIoStmt;
            delSymbol.reset();
            delSymbol.bind([filePath]);
            delSymbol.step();

            if (!this.clearChunksDeleteChunksStmt) {
                this.clearChunksDeleteChunksStmt = this.db.prepare(
                    "DELETE FROM chunks WHERE path = ?",
                );
            }
            const delChunks = this.clearChunksDeleteChunksStmt;
            delChunks.reset();
            delChunks.bind([filePath]);
            delChunks.step();
        }
        // PATCH-6: Also remove from files table so fileNeedsUpdate() doesn't
        // skip re-indexing when the file is recreated with the same content.
        if (!this.clearChunksDeleteFilesStmt) {
            this.clearChunksDeleteFilesStmt = this.db.prepare(
                "DELETE FROM files WHERE path = ?",
            );
        }
        const delFiles = this.clearChunksDeleteFilesStmt;
        delFiles.reset();
        delFiles.bind([filePath]);
        delFiles.step();
        this._hasIndexedFiles = false;
        this.fastGrepCacheInvalidationHook?.(filePath);
    }

    // ─── Chunk Operations ────────────────────────────────────────

    insertChunk(
        filePath: string,
        shorthand: string,
        rawCode: string,
        nodeType: string,
        startLine: number,
        endLine: number,
        startIndex: number = 0,
        endIndex: number = 0,
        symbolName: string = "",
    ): number {
        if (!this.insertChunkStmt) {
            this.insertChunkStmt = this.db.prepare(
                `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
        }
        const insStmt = this.insertChunkStmt;
        insStmt.reset();
        insStmt.bind([filePath, shorthand, rawCode, nodeType, startLine, endLine, startIndex, endIndex, symbolName]);
        insStmt.step();

        if (!this.lastInsertRowidStmt) {
            this.lastInsertRowidStmt = this.db.prepare(
                "SELECT last_insert_rowid() AS id",
            );
        }
        const ridStmt = this.lastInsertRowidStmt;
        ridStmt.reset();
        ridStmt.step();
        const rowid = (ridStmt.getAsObject() as { id: number }).id;

        this.kwIndex.insert(rowid, shorthand);
        this.addRawIdents(filePath, rawCode);
        return rowid;
    }

    insertChunksBatch(
        chunks: Array<{
            path: string;
            shorthand: string;
            rawCode: string;
            nodeType: string;
            startLine: number;
            endLine: number;
            startIndex?: number;
            endIndex?: number;
            symbolName?: string;
        }>
    ): number[] {
        this.db.run("BEGIN TRANSACTION");
        // Track inserted IDs so we can purge RAM indexes on rollback.
        // Without this, SQLite rows are reverted but kwIndex retains
        // phantom entries that crash the result hydrator.
        const insertedIds: number[] = [];
        try {
            for (const chunk of chunks) {
                const id = this.insertChunk(
                    chunk.path,
                    chunk.shorthand,
                    chunk.rawCode,
                    chunk.nodeType,
                    chunk.startLine,
                    chunk.endLine,
                    chunk.startIndex ?? 0,
                    chunk.endIndex ?? 0,
                    chunk.symbolName ?? "",
                );
                insertedIds.push(id);
            }
            this.db.run("COMMIT");
            return insertedIds;
        } catch (err) {
            this.db.run("ROLLBACK");
            // Purge phantom entries from in-memory indexes
            this.kwIndex.deleteBulk(insertedIds);
            throw err;
        }
    }

    // ─── Path Boosting ────────────────────────────────────────────

    /** Apply path-based weighting: boost src/, penalize tests/node_modules/. */
    private getPathBoost(filePath: string): number {
        const normalized = filePath.replace(/\\/g, "/").toLowerCase();
        if (normalized.includes("/node_modules/")) return 0.3;
        if (normalized.includes("/dist/") || normalized.includes("/build/")) return 0.5;
        if (normalized.includes("/test") || normalized.includes("/__test")) return 0.7;
        if (normalized.includes("/src/")) return 1.2;
        if (normalized.includes("/lib/") || normalized.includes("/core/")) return 1.1;
        return 1.0;
    }

    // ─── Batch Helpers ─────────────────────────────────────────────

    /**
     * Batch-fetch full chunk data for an array of chunk IDs. Single SQL query.
     * Used by all search methods to hydrate final results without N+1 queries.
     */
    private fetchChunksBatch(ids: number[]): Map<number, ChunkRecord> {
        const result = new Map<number, ChunkRecord>();
        if (ids.length === 0) return result;
        const placeholders = ids.map(() => "?").join(",");
        const stmt = this.db.prepare(
            `SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name
             FROM chunks WHERE id IN (${placeholders})`,
        );
        try {
            stmt.bind(ids);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, number | string>;
                result.set(row.id as number, {
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    // ─── Search Operations ───────────────────────────────────────

    /**
     * Keyword-only search using BM25 (v11.0.0: only retrieval mode post-amputation).
     * Uses the in-memory KeywordIndex with path boosting.
     */
    searchKeywordOnly(
        queryText: string,
        limit: number = 10,
    ): HybridSearchResult[] {
        const kwResults = this.kwIndex.search(queryText, limit * 2);
        if (kwResults.length === 0) return [];

        const chunkMap = this.fetchChunksBatch(kwResults.map(r => r.rowid));
        const results: HybridSearchResult[] = [];

        for (const { rowid, score } of kwResults) {
            const row = chunkMap.get(rowid);
            if (row) {
                const boostedScore = score * this.getPathBoost(row.path);
                results.push({
                    id: row.id, path: row.path, shorthand: row.shorthand,
                    raw_code: row.raw_code, node_type: row.node_type,
                    start_line: row.start_line, end_line: row.end_line,
                    start_index: row.start_index, end_index: row.end_index,
                    symbol_name: row.symbol_name,
                    rrf_score: boostedScore,
                });
            }
        }

        results.sort((a, b) => b.rrf_score - a.rrf_score);
        return results.slice(0, limit);
    }

    /**
     * BM25-powered fast resolution for import-anchored auto-context.
     * Searches "symbol pathHint" together to defeat homonyms.
     * Enforces a 150ms hard timeout to prevent event loop blocking.
     */
    resolveImportSignatures(
        deps: Array<{ symbol: string; pathHint: string }>,
        maxTimeMs: number = 150,
    ): Array<{ raw: string; path: string }> {
        if (!this._ready || deps.length === 0) return [];

        const start = performance.now();
        const results: Array<{ raw: string; path: string }> = [];
        const seenSymbols = new Set<string>();

        for (const dep of deps) {
            if (seenSymbols.has(dep.symbol)) continue;
            seenSymbols.add(dep.symbol);
            if (performance.now() - start > maxTimeMs) break;

            // BM25 with two terms: symbol + path hint defeats homonyms
            const cleanHint = dep.pathHint.replace(/['"%_]/g, " ").trim();
            const queryText = cleanHint
                ? `${dep.symbol} ${cleanHint}`
                : dep.symbol;

            const hits = this.searchKeywordOnly(queryText, 3);

            if (hits.length > 0) {
                // Final validation: symbol must appear textually in the shorthand
                // Uses safe boundaries (not \b) to handle $store etc.
                const safeSym = escapeRegExp(dep.symbol);
                const exactRegex = new RegExp(
                    `(^|[^a-zA-Z0-9_$])${safeSym}(?=[^a-zA-Z0-9_$]|$)`,
                );

                for (const hit of hits) {
                    if (exactRegex.test(hit.shorthand)) {
                        results.push({ raw: hit.shorthand, path: hit.path });
                        break;
                    }
                }
            }
        }

        return results;
    }

    // ─── Usage Tracking ──────────────────────────────────────────

    /**
     * @deprecated Direct synchronous INSERT. Superseded by
     * NrekiEngine.logUsage which buffers and batch-flushes.
     * Kept for backward compatibility only.
     */
    logUsage(
        toolName: string,
        inputTokens: number,
        outputTokens: number,
        savedTokens: number
    ): void {
        this.db.run(
            `INSERT INTO usage_log (tool_name, input_tokens, output_tokens, saved_tokens)
       VALUES (?, ?, ?, ?)`,
            [toolName, inputTokens, outputTokens, savedTokens]
        );
    }

    batchInsertUsage(batch: ReadonlyArray<[string, number, number, number]>): void {
        if (!this._ready || batch.length === 0) return;
        if (!this.usageStmt) {
            this.usageStmt = this.db.prepare(
                "INSERT INTO usage_log (tool_name, input_tokens, output_tokens, saved_tokens) VALUES (?, ?, ?, ?)"
            );
        }
        const stmt = this.usageStmt;
        this.db.run("BEGIN TRANSACTION");
        try {
            for (const row of batch) {
                stmt.bind(row);
                stmt.step();
                stmt.reset();
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
            throw err;
        }
    }

    getUsageStats(since?: string): {
        total_input: number;
        total_output: number;
        total_saved: number;
        tool_calls: number;
    } {
        const whereClause = since ? "WHERE timestamp >= ?" : "";
        const params = since ? [since] : [];

        const stmt = this.db.prepare(
            `SELECT
        COALESCE(SUM(input_tokens), 0)  AS total_input,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(saved_tokens), 0)  AS total_saved,
        COUNT(*)                         AS tool_calls
      FROM usage_log ${whereClause}`
        );

        try {
            if (params.length > 0) stmt.bind(params);

            let result = { total_input: 0, total_output: 0, total_saved: 0, tool_calls: 0 };
            if (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, number>;
                result = {
                    total_input: row.total_input ?? 0,
                    total_output: row.total_output ?? 0,
                    total_saved: row.total_saved ?? 0,
                    tool_calls: row.tool_calls ?? 0,
                };
            }
            return result;
        } finally {
            stmt.free();
        }
    }

    /**
     * Find the heaviest files by total raw code size.
     * Zero disk I/O - queries indexed data in SQLite.
     */
    getTopHeavyFiles(limit: number = 5): Array<{ path: string; estimated_tokens: number }> {
        if (!this._ready) return [];
        const stmt = this.db.prepare(`
            SELECT path, SUM(LENGTH(raw_code)) as total_chars
            FROM chunks
            GROUP BY path
            ORDER BY total_chars DESC
            LIMIT ?
        `);
        try {
            stmt.bind([limit]);

            const results: Array<{ path: string; estimated_tokens: number }> = [];
            while (stmt.step()) {
                const row = stmt.getAsObject() as { path: string; total_chars: number };
                results.push({
                    path: row.path,
                    estimated_tokens: Math.ceil(row.total_chars / 3.5),
                });
            }
            return results;
        } finally {
            stmt.free();
        }
    }

    // ─── Statistics ──────────────────────────────────────────────

    getStats(): TokenStats {
        const rows = this.db.exec(`
      SELECT
        COUNT(*)                     AS total_chunks,
        COUNT(DISTINCT path)         AS total_files,
        COALESCE(SUM(LENGTH(raw_code)), 0)   AS total_raw_tokens,
        COALESCE(SUM(LENGTH(shorthand)), 0)  AS total_shorthand_tokens
      FROM chunks
    `);

        if (rows.length === 0 || rows[0].values.length === 0) {
            return {
                total_chunks: 0,
                total_files: 0,
                total_raw_tokens: 0,
                total_shorthand_tokens: 0,
                compression_ratio: 0,
            };
        }

        const [total_chunks, total_files, total_raw_tokens, total_shorthand_tokens] =
            rows[0].values[0] as number[];

        return {
            total_chunks,
            total_files,
            total_raw_tokens,
            total_shorthand_tokens,
            compression_ratio:
                total_raw_tokens > 0
                    ? 1 - total_shorthand_tokens / total_raw_tokens
                    : 0,
        };
    }

    getFileCount(): number {
        const rows = this.db.exec("SELECT COUNT(*) AS count FROM files");
        if (rows.length === 0) return 0;
        return rows[0].values[0][0] as number;
    }

    /**
     * Find all files whose raw code contains the given symbol name.
     * Returns distinct file paths. Used by prepare_refactor for 100% coverage.
     *
     * Uses the in-memory rawIdentsByFile index (lazy-built on first call via
     * buildRawIdentsIfNeeded). Substring match on identifiers — same
     * semantics as the previous LIKE %term% scan but O(unique_idents) instead
     * of O(total_raw_code_bytes).
     */
    searchRawCode(symbolName: string): string[] {
        if (!this._ready) return [];
        this.buildRawIdentsIfNeeded();
        const results: string[] = [];
        for (const [filePath, idents] of this.rawIdentsByFile) {
            if (idents.has(symbolName)) { results.push(filePath); }
        }
        return results;
    }

    /**
     * Exact symbol definition lookup. Used by ast-navigator findDefinition fast path.
     * Replaces the O(N) full-disk walk. Requires idx_chunks_symbol_name.
     */
    getChunksBySymbolExact(symbolName: string, exact: boolean = true): ChunkRecord[] {
        if (!this._ready) return [];
        const sql = exact
            ? "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE symbol_name = ?"
            : "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE symbol_name = ? COLLATE NOCASE";
        const stmt = this.db.prepare(sql);
        const results: ChunkRecord[] = [];
        try {
            stmt.bind([symbolName]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                results.push({
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }


    insertSymbolIosBulk(rows: { chunkId: number; ioType: 'consumes' | 'produces'; typeName: string }[]): void {
        if (rows.length === 0) return;
        // Defense-in-depth: drop single-letter UPPERCASE generic params at
        // insert time (T, U, K, V...). Upstream emitOrDiscard already filters
        // these post-2.2.2.2, but old indexed data was poisoned. Sub-sprint
        // 2.4 alignment prod/eval — single source of truth at storage layer.
        const SINGLE_LETTER = /^[A-Z]$/;
        const filtered = rows.filter(r => !SINGLE_LETTER.test(r.typeName));
        if (filtered.length === 0) return;
        this.db.run("BEGIN");
        try {
            const stmt = this.db.prepare(
                "INSERT OR IGNORE INTO symbol_io (chunk_id, io_type, type_name) VALUES (?, ?, ?)"
            );
            try {
                for (const r of filtered) {
                    stmt.run([r.chunkId, r.ioType, r.typeName]);
                }
            } finally {
                stmt.free();
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
            throw err;
        }
    }

    /**
     * Inverse Type Ledger lookup: chunk_id → {consumes, produces}.
     * Used by Phase 3 type_graph walker to expand from a chunk to its
     * neighbors via the types it produces/consumes.
     */
    getSymbolIOByChunkId(chunkId: number): { consumes: string[]; produces: string[] } {
        const consumes: string[] = [];
        const produces: string[] = [];
        const stmt = this.db.prepare(
            "SELECT io_type, type_name FROM symbol_io WHERE chunk_id = ?"
        );
        try {
            stmt.bind([chunkId]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { io_type: string; type_name: string };
                if (row.io_type === "consumes") consumes.push(row.type_name);
                else if (row.io_type === "produces") produces.push(row.type_name);
            }
        } finally {
            stmt.free();
        }
        return { consumes, produces };
    }

    /**
     * Phase 4: O(1) lookup chunk_id by exact (path, symbol_name).
     * Used by compressor-foveal cross-file Type Ledger injection
     * to bridge from in-memory ParsedChunk (no DB id) to symbol_io
     * queries. Defensive fail-open: returns null if no match (e.g.,
     * Type Ledger sync gap during watcher debounce).
     *
     * Index used: idx_chunks_symbol_name (existing).
     */
    getChunkIdByPathAndSymbol(path: string, symbolName: string): number | null {
        const stmt = this.db.prepare(
            "SELECT id FROM chunks WHERE path = ? AND symbol_name = ? LIMIT 1"
        );
        try {
            stmt.bind([path, symbolName]);
            if (stmt.step()) {
                const row = stmt.getAsObject() as { id: number };
                return row.id;
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /**
     * Returns all distinct type names in the symbol_io ledger.
     * Used by Phase 3 type_graph NOCASE fallback for educating
     * agent LLMs about case mismatch in seed_type queries.
     */
    getAllTypeNames(): string[] {
        const stmt = this.db.prepare("SELECT DISTINCT type_name FROM symbol_io");
        const out: string[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as { type_name: string };
                out.push(row.type_name);
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Public batch chunk hydration. Wraps the private fetchChunksBatch.
     * Returns chunks in the order requested (missing ids skipped).
     */
    getChunksByIds(ids: number[]): ChunkRecord[] {
        if (ids.length === 0) return [];
        const map = this.fetchChunksBatch(ids);
        const out: ChunkRecord[] = [];
        for (const id of ids) {
            const row = map.get(id);
            if (row) out.push(row);
        }
        return out;
    }

    getChunksByConsumedType(typeName: string): number[] {
        const stmt = this.db.prepare(
            "SELECT chunk_id FROM symbol_io WHERE type_name = ? AND io_type = 'consumes'"
        );
        const results: number[] = [];
        try {
            stmt.bind([typeName]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { chunk_id: number };
                results.push(row.chunk_id);
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    getChunksByProducedType(typeName: string): number[] {
        const stmt = this.db.prepare(
            "SELECT chunk_id FROM symbol_io WHERE type_name = ? AND io_type = 'produces'"
        );
        const results: number[] = [];
        try {
            stmt.bind([typeName]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { chunk_id: number };
                results.push(row.chunk_id);
            }
        } finally {
            stmt.free();
        }
        return results;
    }


    /**
     * Fast substring search over AST chunks raw code. Used by nreki_navigate fast_grep.
     * Returns chunks whose raw_code contains the query as substring. LIMIT-bounded.
     */
    searchRawCodeLike(queryText: string, limit: number = 50): ChunkRecord[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name FROM chunks WHERE raw_code LIKE ? LIMIT ?"
        );
        const results: ChunkRecord[] = [];
        try {
            stmt.bind(["%" + queryText + "%", limit]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as Record<string, unknown>;
                results.push({
                    id: row.id as number,
                    path: row.path as string,
                    shorthand: row.shorthand as string,
                    raw_code: row.raw_code as string,
                    node_type: row.node_type as string,
                    start_line: row.start_line as number,
                    end_line: row.end_line as number,
                    start_index: (row.start_index as number) ?? 0,
                    end_index: (row.end_index as number) ?? 0,
                    symbol_name: (row.symbol_name as string) ?? "",
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /**
     * @deprecated Tier 2 Paso B: superseded by NrekiEngine.fastGrep
     * which uses RAM-resident fgCache. This SQLite-backed implementation
     * is kept as fallback / debugging tool. Do not call from hot paths.
     *
     * Exact substring search for the nreki_navigate fast_grep action.
     * Uses SQLite INSTR (no wildcard interpretation — safe for arbitrary queries)
     * and SELECTs only the 4 columns handleFastGrep consumes to minimize
     * sql.js WASM row-serialization cost.
     */
    fastGrepSQLite(queryText: string, limit: number = 50): FastGrepHit[] {
        if (!this._ready) return [];
        if (!this.fastGrepStmt) {
            this.fastGrepStmt = this.db.prepare(
                "SELECT path, raw_code, start_line, symbol_name FROM chunks WHERE INSTR(raw_code, ?) > 0 LIMIT ?"
            );
        }
        const stmt = this.fastGrepStmt;
        stmt.reset();
        stmt.bind([queryText, limit]);
        const results: FastGrepHit[] = [];
        while (stmt.step()) {
            const row = stmt.get() as Array<string | number | null>;
            results.push({
                path: row[0] as string,
                raw_code: row[1] as string,
                start_line: row[2] as number,
                symbol_name: (row[3] as string | null) ?? "",
            });
        }
        return results;
    }

    hasIndexedFiles(): boolean {
        if (this._hasIndexedFiles) return true;
        if (!this._ready) return false;
        const result = this.db.exec("SELECT 1 FROM files LIMIT 1");
        if (result.length > 0 && result[0].values.length > 0) {
            this._hasIndexedFiles = true;
            return true;
        }
        return false;
    }

    exportAllChunksForCache(): FastGrepCacheRow[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            "SELECT id, path, symbol_name, start_line, raw_code FROM chunks ORDER BY id ASC"
        );
        const results: FastGrepCacheRow[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.get() as Array<string | number | null>;
                results.push([
                    row[0] as number,
                    row[1] as string,
                    (row[2] as string | null) ?? "",
                    row[3] as number,
                    row[4] as string,
                ]);
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    /**
     * Exports chunks for a specific file path. Used by the
     * incremental fgCache update path (after indexFile).
     * Returns rows in the same FastGrepCacheRow format as
     * exportAllChunksForCache but filtered.
     */
    exportChunksByPath(filePath: string): FastGrepCacheRow[] {
        if (!this._ready) return [];
        const stmt = this.db.prepare(
            "SELECT id, path, symbol_name, start_line, raw_code FROM chunks WHERE path = ? ORDER BY id ASC"
        );
        const results: FastGrepCacheRow[] = [];
        try {
            stmt.bind([filePath]);
            while (stmt.step()) {
                const row = stmt.get() as Array<string | number | null>;
                results.push([
                    row[0] as number,
                    row[1] as string,
                    (row[2] as string | null) ?? "",
                    row[3] as number,
                    row[4] as string,
                ]);
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    close(): void {
        if (this.closed || !this.db) return;
        // save() releases cached statements internally before export.
        // We keep an explicit second release after save() in case future
        // operations between save() and db.close() re-prepare anything.
        this.save();
        this.releaseCachedStatements();
        this.db.close();
        this.closed = true;
        this._ready = false;
        this.initPromise = null;
    }
}


