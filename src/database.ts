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
import { quarantineFile, signState, verifyState } from "./utils/trust.js";

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
    /** Class.method (Go: Receiver.method); "" for gap chunks. Engram key (utils/engram-identity.ts). */
    qualified_name?: string;
}

/** Shape returned by NrekiEngine.fastGrep(): the 4 columns handleFastGrep consumes. */
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
    qualified_name?: string;
    rrf_score: number;
}

/** A chunk as the dense index sees it (search/vector-index.ts builds the text from this). */
export interface EmbeddingSource {
    id: number;
    path: string;
    raw_code: string;
    node_type: string;
    symbol_name: string;
    context_comment: string;
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
    /**
     * The BM25 index is built lazily on the first keyword search: tokenizing
     * every chunk body on startup cost ~0.5 s on NREKI's own repo, paid even by
     * sessions that never search. While false, inserts/deletes skip the RAM
     * index; the deferred rebuild reads the final DB state (context_comment is
     * persisted, so the rebuilt index equals the one built during indexing).
     */
    private kwIndexLoaded = false;
    /** Absolute project root; path boosts are computed relative to it. */
    private projectRoot: string | null;
    /** Bumped on every chunk insert/delete: cheap staleness check for RAM caches (vector index). */
    private _chunkGeneration = 0;
    /** In-memory identifier index: file path → unique identifiers in that file's raw code. */
    private rawIdentsByFile = new Map<string, Set<string>>();
    private rawIdentsLoaded = false;
    private dbPath: string;
    private initPromise: Promise<void> | null = null;
    private _ready = false;
    private closed = false;
    private _hasIndexedFiles = false;
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

    constructor(dbPath: string = ".nreki.db", projectRoot?: string) {
        this.dbPath = dbPath;
        this.projectRoot = projectRoot ? path.resolve(projectRoot) : null;
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
        this.sqlModule = SQL;

        // Load existing database if it exists
        let loadedFromDisk = false;
        if (fs.existsSync(this.dbPath)) {
            try {
                const fileBuffer = fs.readFileSync(this.dbPath);
                this.db = new SQL.Database(fileBuffer);
                loadedFromDisk = true;
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

        // ─── Trust gate (NREKI-SEC-06) ─────────────────────────────────
        // Engrams, memorize notes and the plan pointer stored here are shown
        // to the agent as its OWN memory. A DB this user did not create on
        // this machine (shipped with a cloned repo, copied, or written by
        // NREKI <= 12.0.0) is quarantined, never read. See utils/trust.ts.
        if (!this.ownerVerified() || !this.memoryVerified()) {
            if (loadedFromDisk) this.quarantineUntrusted(SQL);
            this.signOwner();
        }

        // ─── Schema Version Gate ──────────────────────────────────────
        // Force full reindex when parser/index format changes between
        // versions. Users on older schema get a clean slate without
        // manual .nreki.db deletion. Bumped in v10.18.1.
        // Bumped in v10.20.0 (symbol_io table added).
        // Bumped in v11.0.0 (embeddings amputated, .vec file deprecated).
        // Bumped in v12.1.0 (top_level gap chunks + persisted context_comment:
        // without the bump, DBs indexed by 12.0.0 keep their old chunk set
        // forever because unchanged files never re-index).
        // Bumped again for qualified_name (engram matching in search, C-02).
        const PARSER_SCHEMA_VERSION = 6;
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

        try { this.migrateEngramKeys(); } catch (err) { logger.warn(`[NREKI] Engram key migration skipped: ${err}`); }

        // In-memory BM25 index: an empty DB is trivially "loaded" (inserts go
        // straight in); otherwise it is rebuilt on the first keyword search.
        const anyChunk = this.db.exec("SELECT 1 FROM chunks LIMIT 1");
        this.kwIndexLoaded = !(anyChunk.length > 0 && anyChunk[0].values.length > 0);

        this.diskStamp = this.stampOnDisk();
        this._ready = true;
        const result = this.db.exec("SELECT 1 FROM files LIMIT 1");
        this._hasIndexedFiles = result.length > 0 && result[0].values.length > 0;
    }

    get ready(): boolean {
        return this._ready;
    }

    private ownerVerified(db: SqlJsDatabase = this.db): boolean {
        const meta = (key: string) => {
            const v = db.exec("SELECT value FROM metadata WHERE key = ?", [key])[0]?.values[0]?.[0];
            return v === undefined ? null : String(v);
        };
        const id = meta("owner_db_id");
        return id !== null && verifyState("db", id, meta("owner_tag"));
    }

    private signOwner(): void {
        const id = crypto.randomUUID();
        this.setMetadata("owner_db_id", id);
        this.setMetadata("owner_tag", signState("db", id));
        this.resignMemory();
    }

    /** Metadata values the agent receives as its own memory (plus every engram). */
    private static readonly MEMORY_META_KEYS: ReadonlyArray<string> = ["nreki_scratchpad", "nreki_master_plan"];

    /**
     * Digest of everything this DB feeds back to the agent as memory. The owner
     * tag alone signs a random id: copied into another DB next to planted rows it
     * still verified (S-02). Not bound to the project path on purpose: moving a
     * project must keep its engrams, and planted rows already break the digest.
     */
    private memoryDigest(db: SqlJsDatabase = this.db): string {
        const h = crypto.createHash("sha256");
        const rows = db.exec("SELECT path, symbol_name, ast_hash, insight FROM engrams ORDER BY path, symbol_name");
        for (const r of rows[0]?.values ?? []) h.update(`E\u0000${r.map(String).join("\u0000")}\n`);
        for (const key of NrekiDB.MEMORY_META_KEYS) {
            const r = db.exec("SELECT value FROM metadata WHERE key = ?", [key]);
            const v = r[0]?.values[0]?.[0];
            h.update(`M\u0000${key}\u0000${v === undefined ? "\u0001absent" : String(v)}\n`);
        }
        return h.digest("hex");
    }

    private memoryVerified(db: SqlJsDatabase = this.db): boolean {
        const r = db.exec("SELECT value FROM metadata WHERE key = 'memory_tag'");
        return verifyState("memory", this.memoryDigest(db), r[0]?.values[0]?.[0]);
    }

    // ─── Two NREKI servers on one project (I-02) ───────────────────
    // sql.js keeps the whole DB in RAM and save() writes it back whole, so
    // with Cursor + Claude Code both running, the last writer used to erase
    // the other's engrams, memorize notes and plan. save() now merges that
    // memory from disk first whenever another process wrote the file.

    private sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;
    /** Identity of the DB file as this process last read or wrote it (see stampOnDisk). */
    private diskStamp: string | null = null;
    /**
     * Engram keys this process changed since its last save, the last operation
     * per key winning. A single "dirty" flag made the merge keep EVERY local row:
     * it resurrected engrams deleted here and overwrote another server's newer
     * update of keys this process never touched.
     */
    private dirtyEngrams = new Map<string, { path: string; symbol: string; deleted: boolean }>();
    private memoryKeysDirty = new Set<string>();

    private markEngram(engramPath: string, symbol: string, deleted: boolean): void {
        this.dirtyEngrams.set(`${engramPath}\u0000${symbol}`, { path: engramPath, symbol, deleted });
    }

    /**
     * Every save() renames a NEW temp file onto the DB path, so the file id
     * (`ino`, also on NTFS) changes on each write. mtime + size alone collide:
     * sql.js pages keep the size, and quick writes can share one mtime tick.
     */
    private stampOnDisk(): string | null {
        try {
            const st = fs.statSync(this.dbPath);
            return `${st.ino}:${st.mtimeMs}:${st.size}`;
        } catch {
            return null;
        }
    }

    private mergeMemoryFromDisk(): void {
        if (!this.sqlModule) return;
        const other = new this.sqlModule.Database(fs.readFileSync(this.dbPath));
        try {
            // Never import memory we cannot verify (e.g. a file planted while we ran).
            if (!this.ownerVerified(other) || !this.memoryVerified(other)) return;

            const cols = "path, symbol_name, ast_hash, insight, created_at";
            const insert = `INSERT OR REPLACE INTO engrams (${cols}) VALUES (?, ?, ?, ?, ?)`;
            const theirs = other.exec(`SELECT ${cols} FROM engrams`)[0]?.values ?? [];
            // Our version of each key upserted here, read before the table is replaced.
            const ours: Array<Array<string | number | null>> = [];
            for (const k of this.dirtyEngrams.values()) {
                if (k.deleted) continue;
                const row = this.db.exec(
                    `SELECT ${cols} FROM engrams WHERE path = ? AND symbol_name = ?`, [k.path, k.symbol],
                )[0]?.values[0];
                if (row) ours.push(row as Array<string | number | null>);
            }
            // Atomic: save() logs a merge failure and still writes, so a half-applied
            // merge (table emptied, rows not re-inserted) would reach disk.
            this.db.run("SAVEPOINT nreki_merge");
            try {
                // The disk copy already holds every other save (each save merges
                // first): adopt it, then replay only the keys changed here.
                this.db.run("DELETE FROM engrams");
                for (const row of theirs) this.db.run(insert, row as Array<string | number | null>);
                for (const k of this.dirtyEngrams.values()) {
                    if (k.deleted) this.db.run("DELETE FROM engrams WHERE path = ? AND symbol_name = ?", [k.path, k.symbol]);
                }
                for (const row of ours) this.db.run(insert, row);
                for (const key of NrekiDB.MEMORY_META_KEYS) {
                    if (this.memoryKeysDirty.has(key)) continue;
                    const v = other.exec("SELECT value FROM metadata WHERE key = ?", [key])[0]?.values[0]?.[0];
                    if (v === undefined) this.db.run("DELETE FROM metadata WHERE key = ?", [key]);
                    else this.db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", [key, String(v)]);
                }
                // Vectors are content-addressed (hash of the embedded text): a union is always safe.
                const read = other.prepare("SELECT text_hash, model, dim, vec FROM embeddings");
                const write = this.db.prepare("INSERT OR IGNORE INTO embeddings (text_hash, model, dim, vec) VALUES (?, ?, ?, ?)");
                try {
                    while (read.step()) {
                        write.reset();
                        write.bind(read.get());
                        write.step();
                    }
                } finally {
                    read.free();
                    write.free();
                }
                this.db.run("RELEASE nreki_merge");
            } catch (err) {
                this.db.run("ROLLBACK TO nreki_merge");
                this.db.run("RELEASE nreki_merge");
                throw err;
            }
            this.resignMemory();
        } finally {
            other.close();
        }
    }

    /** Re-sign after every change NREKI itself makes to engrams / memory metadata. */
    private resignMemory(): void {
        this.db.run("INSERT OR REPLACE INTO metadata (key, value) VALUES ('memory_tag', ?)", [signState("memory", this.memoryDigest())]);
    }

    private quarantineUntrusted(SQL: Awaited<ReturnType<typeof initSqlJs>>): void {
        const count = (table: string) => {
            try {
                const r = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
                return Number(r[0]?.values[0]?.[0] ?? 0);
            } catch { return 0; }
        };
        const engrams = count("engrams");
        const hasNotes = this.getMetadata("nreki_scratchpad") !== null;
        this.db.close();
        const moved = quarantineFile(this.dbPath);
        this.db = new SQL.Database();
        this.setupSchema();
        logger.warn(
            `[NREKI] ${this.dbPath} has no valid owner signature (written by NREKI <= 12.0.0, on another machine, ` +
            `or shipped with the repository). ` +
            (moved ? `Moved to ${moved}. ` : `It could not be moved and will be overwritten. `) +
            `Nothing from it is loaded (${engrams} engram(s)${hasNotes ? ", memorize notes" : ""}, plan, index); ` +
            `the index is rebuilt. If it is yours, restore its engrams and notes from an interactive terminal: ` +
            `npx nreki trust-db`,
        );
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
        symbol_name TEXT NOT NULL DEFAULT '',
        context_comment TEXT NOT NULL DEFAULT '',
        qualified_name TEXT NOT NULL DEFAULT ''
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

      -- Dense vectors (opt-in Voyage), int8. Keyed by the hash of the embedded
      -- text, so re-indexing an unchanged chunk reuses its vector (no API
      -- call) and a schema-upgrade wipe of chunks keeps them.
      CREATE TABLE IF NOT EXISTS embeddings (
        text_hash TEXT NOT NULL,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL,
        vec       BLOB NOT NULL,
        PRIMARY KEY (text_hash, model)
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
            "ALTER TABLE chunks ADD COLUMN context_comment TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE chunks ADD COLUMN qualified_name TEXT NOT NULL DEFAULT ''",
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

    /** Build the in-memory keyword index from the DB on first use (see kwIndexLoaded). */
    private ensureKeywordIndex(): void {
        if (this.kwIndexLoaded) return;
        this.kwIndex = new KeywordIndex();
        // AUDIT FIX: Use prepared statement + iterator to avoid loading all rows into RAM
        const stmt = this.db.prepare(
            "SELECT id, path, shorthand, raw_code, node_type, symbol_name, context_comment FROM chunks",
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as {
                    id: number;
                    path: string;
                    shorthand: string;
                    raw_code: string;
                    node_type: string;
                    symbol_name: string;
                    context_comment: string;
                };
                this.kwIndex.insert(
                    row.id,
                    this.buildKeywordIndexText(
                        row.path, row.shorthand, row.raw_code, row.node_type, row.symbol_name, row.context_comment ?? "",
                    ),
                );
            }
        } finally {
            stmt.free();
        }
        this.kwIndexLoaded = true;
    }

    /**
     * Build rich lexical + conceptual text for BM25 indexing.
     * Combines file path segments, symbol name, signature shorthand, JSDoc/header
     * comments, and body tokens (excluding noisy import lines and avoiding full-body
     * duplication on large class containers whose methods are indexed separately).
     */
    private buildKeywordIndexText(
        filePath: string,
        shorthand: string,
        rawCode: string,
        nodeType: string = "",
        symbolName: string = "",
        contextComment: string = "",
    ): string {
        const posixPath = filePath.replace(/\\/g, "/");
        const segments = posixPath.split("/").filter(Boolean).slice(-3);
        const baseStem = path.basename(posixPath, path.extname(posixPath));
        const pathTokens = `${segments.join(" ")} ${baseStem} ${baseStem}`;

        const cleanShort = shorthand.replace(/\/\*\s*TG:L\d+-L\d+\s*\*\//g, "");
        const symTokens = symbolName ? `${symbolName} ${symbolName}` : "";
        const commentTokens = contextComment ? `${contextComment} ${contextComment}` : "";

        // Strip import statements from rawCode so imported symbols don't pollute this file's BM25
        const bodyWithoutImports = rawCode.replace(/^\s*import\b[^\n]*$/gm, "");
        const bodySlice =
            nodeType === "class" && bodyWithoutImports.length > 1500
                ? bodyWithoutImports.split("\n").slice(0, 35).join("\n")
                : bodyWithoutImports.slice(0, 4000);

        return `${pathTokens}\n${symTokens}\n${cleanShort}\n${cleanShort}\n${commentTokens}\n${bodySlice}`;
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
        if (NrekiDB.MEMORY_META_KEYS.includes(key)) {
            this.memoryKeysDirty.add(key);
            this.resignMemory();
        }
    }

    /**
     * Wipes all indexed data from RAM and disk.
     * Prevents ghost vectors and ID drift by cleaning up sequence counters
     * and orphaned .vec files. Used during cache invalidation.
     */
    private wipeAllIndexedData(): void {
        if (this.usageStmt) {
            this.usageStmt.free();
            this.usageStmt = null;
        }

        // 1. Wipe SQL tables. symbol_io MUST go too: the chunks sequence is
        // reset below, so surviving rows would attach old type relations to
        // the unrelated chunks that reuse their ids.
        this.db.run("DELETE FROM symbol_io");
        this.db.run("DELETE FROM chunks");
        this.db.run("DELETE FROM files");

        // 2. Reset AUTOINCREMENT sequences (ONLY for wiped tables)
        try {
            this.db.run("DELETE FROM sqlite_sequence WHERE name = 'chunks'");
        } catch {
            // Ignored: sqlite_sequence is created automatically by SQLite on first INSERT
        }

        // 3. Reset RAM state (an empty DB needs no deferred rebuild)
        this._chunkGeneration++;
        this.kwIndex = new KeywordIndex();
        this.kwIndexLoaded = true;
        this.rawIdentsByFile.clear();
        this.rawIdentsLoaded = false;
        this._hasIndexedFiles = false;
        this.fastGrepCacheInvalidationHook?.();
    }

    // ─── Persistence ─────────────────────────────────────────────

    private canonicalRoot: string | null = null;

    /**
     * Engram rows are keyed by the project-relative CANONICAL path (on-disk
     * case), so a file reached as D:\x\a.ts or d:\X\A.ts, or a project folder
     * that moved, keeps its notes. Older versions stored the absolute path as
     * typed; those rows are migrated in initialize() and still matched on read.
     */
    private engramKey(filePath: string): string {
        const canon = (p: string) => {
            try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
        };
        if (!this.projectRoot) return path.resolve(filePath);
        this.canonicalRoot ??= canon(this.projectRoot);
        const abs = canon(filePath);
        const rel = path.relative(this.canonicalRoot, abs);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
        return rel.split(path.sep).join("/");
    }

    private migrateEngramKeys(): void {
        if (!this.projectRoot) return;
        const rows = this.db.exec("SELECT path, symbol_name FROM engrams");
        if (rows.length === 0) return;
        let moved = 0;
        for (const [p, sym] of rows[0].values as Array<[string, string]>) {
            if (!path.isAbsolute(p)) continue;
            const key = this.engramKey(p);
            if (key === p) continue;
            // OR IGNORE: if a row already exists under the new key, it wins.
            this.db.run("UPDATE OR IGNORE engrams SET path = ? WHERE path = ? AND symbol_name = ?", [key, p, sym]);
            this.db.run("DELETE FROM engrams WHERE path = ? AND symbol_name = ?", [p, sym]);
            this.markEngram(p, sym, true);
            this.markEngram(key, sym, false);
            moved++;
        }
        if (moved > 0) {
            this.resignMemory(); // NREKI's own rewrite of already-verified rows
            logger.info(`[NREKI] Migrated ${moved} engram(s) to project-relative keys.`);
        }
    }

    upsertEngram(filePath: string, symbolName: string, astHash: string, insight: string): void {
        const key = this.engramKey(filePath);
        this.db.run(
            "INSERT OR REPLACE INTO engrams (path, symbol_name, ast_hash, insight) VALUES (?, ?, ?, ?)",
            [key, symbolName, astHash, insight],
        );
        this.markEngram(key, symbolName, false);
        this.resignMemory();
        this.save();
    }

    getEngramsForFile(filePath: string): Map<string, { astHash: string; insight: string }> {
        const key = this.engramKey(filePath);
        const legacy = path.resolve(filePath);
        const stmt = this.db.prepare("SELECT path, symbol_name, ast_hash, insight FROM engrams WHERE path = ? OR path = ?");
        const result = new Map<string, { astHash: string; insight: string }>();
        try {
            stmt.bind([key, legacy]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { path: string; symbol_name: string; ast_hash: string; insight: string };
                // A row under the current key wins over a leftover legacy row.
                if (row.path !== key && result.has(row.symbol_name)) continue;
                result.set(row.symbol_name, { astHash: row.ast_hash, insight: row.insight });
            }
        } finally {
            stmt.free();
        }
        return result;
    }

    /** Re-store an engram saved under a bare name ("run") under its qualified name ("Beta.run"). */
    renameEngram(filePath: string, fromSymbol: string, toSymbol: string): void {
        const key = this.engramKey(filePath);
        // OR IGNORE: if the qualified key already exists, keep both rows rather than lose one.
        this.db.run(
            "UPDATE OR IGNORE engrams SET symbol_name = ? WHERE path = ? AND symbol_name = ?",
            [toSymbol, key, fromSymbol],
        );
        if (this.db.getRowsModified() > 0) {
            this.markEngram(key, fromSymbol, true);
            this.markEngram(key, toSymbol, false);
        }
        this.resignMemory();
        this.save();
    }

    deleteEngram(filePath: string, symbolName: string): void {
        const key = this.engramKey(filePath);
        const legacy = path.resolve(filePath);
        this.db.run(
            "DELETE FROM engrams WHERE (path = ? OR path = ?) AND symbol_name = ?",
            [key, legacy, symbolName],
        );
        this.markEngram(key, symbolName, true);
        if (legacy !== key) this.markEngram(legacy, symbolName, true);
        this.resignMemory();
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
        const onDisk = this.stampOnDisk();
        if (onDisk !== null && onDisk !== this.diskStamp) {
            try { this.mergeMemoryFromDisk(); }
            catch (err) { logger.warn(`[NREKI] Could not merge memory written by another NREKI process: ${err}`); }
        }
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
        // `wx`: never through a link planted at the temporary's name. The rename
        // replaces a link at .nreki.db itself; it does not follow it.
        fs.writeFileSync(tmpDb, buffer, { flag: "wx" });
        fs.renameSync(tmpDb, this.dbPath);
        this.diskStamp = this.stampOnDisk();
        this.dirtyEngrams.clear();
        this.memoryKeysDirty.clear();
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
        this.usageStmt                     = freeIfSet(this.usageStmt);
        this.insertChunkStmt               = freeIfSet(this.insertChunkStmt);
        this.lastInsertRowidStmt           = freeIfSet(this.lastInsertRowidStmt);
        this.upsertFileStmt                = freeIfSet(this.upsertFileStmt);
        this.clearChunksDeleteSymbolIoStmt = freeIfSet(this.clearChunksDeleteSymbolIoStmt);
        this.clearChunksDeleteChunksStmt   = freeIfSet(this.clearChunksDeleteChunksStmt);
        this.clearChunksDeleteFilesStmt    = freeIfSet(this.clearChunksDeleteFilesStmt);
    }

    // ─── File Operations ─────────────────────────────────────────

    /** Enumerate persisted file records, including files without chunks. */
    getIndexedPaths(): string[] {
        const stmt = this.db.prepare("SELECT path FROM files");
        const paths: string[] = [];
        try {
            while (stmt.step()) paths.push(String(stmt.get()[0]));
        } finally {
            stmt.free();
        }
        return paths;
    }

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
            this._chunkGeneration++;
            if (this.kwIndexLoaded) this.kwIndex.deleteBulk(ids);
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
        contextComment: string = "",
        qualifiedName: string = "",
    ): number {
        if (!this.insertChunkStmt) {
            this.insertChunkStmt = this.db.prepare(
                `INSERT INTO chunks (path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name, context_comment, qualified_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
        }
        const insStmt = this.insertChunkStmt;
        insStmt.reset();
        insStmt.bind([filePath, shorthand, rawCode, nodeType, startLine, endLine, startIndex, endIndex, symbolName, contextComment, qualifiedName]);
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
        this._chunkGeneration++;

        if (this.kwIndexLoaded) {
            this.kwIndex.insert(
                rowid,
                this.buildKeywordIndexText(filePath, shorthand, rawCode, nodeType, symbolName, contextComment),
            );
        }
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
            contextComment?: string;
            qualifiedName?: string;
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
                    chunk.contextComment ?? "",
                    chunk.qualifiedName ?? "",
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

    // ─── Dense vectors (opt-in Voyage; see search/vector-index.ts) ───

    get chunkGeneration(): number {
        return this._chunkGeneration;
    }

    /** Every chunk with the fields its embedding text is built from. */
    getEmbeddingSources(): EmbeddingSource[] {
        const out: EmbeddingSource[] = [];
        const stmt = this.db.prepare(
            "SELECT id, path, raw_code, node_type, symbol_name, context_comment FROM chunks ORDER BY id",
        );
        try {
            while (stmt.step()) out.push(stmt.getAsObject() as unknown as EmbeddingSource);
        } finally {
            stmt.free();
        }
        return out;
    }

    getEmbeddingHashes(model: string): Set<string> {
        const out = new Set<string>();
        const stmt = this.db.prepare("SELECT text_hash FROM embeddings WHERE model = ?");
        try {
            stmt.bind([model]);
            while (stmt.step()) out.add((stmt.getAsObject() as { text_hash: string }).text_hash);
        } finally {
            stmt.free();
        }
        return out;
    }

    getEmbeddings(model: string): Map<string, Int8Array> {
        const out = new Map<string, Int8Array>();
        const stmt = this.db.prepare("SELECT text_hash, vec FROM embeddings WHERE model = ?");
        try {
            stmt.bind([model]);
            while (stmt.step()) {
                const row = stmt.getAsObject() as { text_hash: string; vec: Uint8Array };
                out.set(row.text_hash, new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength));
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    putEmbeddings(model: string, rows: ReadonlyArray<{ hash: string; vec: Int8Array }>): void {
        if (rows.length === 0) return;
        this.db.run("BEGIN TRANSACTION");
        const stmt = this.db.prepare("INSERT OR REPLACE INTO embeddings (text_hash, model, dim, vec) VALUES (?, ?, ?, ?)");
        try {
            for (const { hash, vec } of rows) {
                stmt.reset();
                stmt.bind([hash, model, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)]);
                stmt.step();
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
            throw err;
        } finally {
            stmt.free();
        }
    }

    /** Drop vectors no current chunk uses. Returns how many were removed. */
    pruneEmbeddings(model: string, keep: ReadonlySet<string>): number {
        const stale = [...this.getEmbeddingHashes(model)].filter(h => !keep.has(h));
        if (stale.length === 0) return 0;
        this.db.run("BEGIN TRANSACTION");
        const stmt = this.db.prepare("DELETE FROM embeddings WHERE text_hash = ? AND model = ?");
        try {
            for (const h of stale) {
                stmt.reset();
                stmt.bind([h, model]);
                stmt.step();
            }
            this.db.run("COMMIT");
        } catch (err) {
            this.db.run("ROLLBACK");
            throw err;
        } finally {
            stmt.free();
        }
        return stale.length;
    }

    /** Candidate names whose two or more distinct BM25 terms all occur in the query. */
    matchingSymbolIds(query: string, candidates: ReadonlyArray<Pick<HybridSearchResult, "id" | "symbol_name">>): Set<number> {
        const queryTerms = new Set(this.kwIndex.tokenize(query, true));
        const matches = new Set<number>();
        for (const candidate of candidates) {
            const name = candidate.symbol_name;
            if (new Set(this.kwIndex.tokenize(name)).size < 2) continue;
            // Words ignored by BM25 can distinguish names such as creditsBeforeTax and creditsAfterTax.
            if (this.kwIndex.tokenize(name, true).every(term => queryTerms.has(term))) matches.add(candidate.id);
        }
        return matches;
    }

    /** Path prior (src/ up, tests/scripts/docs down) for rankings built outside BM25. */
    pathBoost(filePath: string, nodeType: string = ""): number {
        return this.getPathBoost(filePath, nodeType);
    }

    /**
     * Apply path-based weighting: boost src/, penalize scripts/tests/docs/node_modules/.
     * Matched against the path RELATIVE to the project root: on the absolute path a
     * root such as ~/test/app or D:/docs/app put every file in the same bucket.
     */
    private getPathBoost(filePath: string, nodeType: string = ""): number {
        let p = filePath;
        if (this.projectRoot) {
            const rel = path.relative(this.projectRoot, filePath);
            if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) p = rel;
        }
        const normalized = "/" + p.replace(/\\/g, "/").toLowerCase();
        let boost = 1.0;
        if (normalized.includes("/node_modules/")) boost = 0.2;
        else if (normalized.includes("/dist/") || normalized.includes("/build/")) boost = 0.35;
        else if (
            normalized.includes("/scripts/") ||
            normalized.includes("/benchmarks/") ||
            normalized.includes("/bench/") ||
            normalized.includes("/docs/") ||
            normalized.includes("/examples/")
        ) boost = 0.4;
        else if (
            normalized.includes("/test") ||
            normalized.includes("/__test") ||
            /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
            /\/(?:verify|check|eval|benchmark)\.[cm]?[jt]sx?$/.test(normalized)
        ) boost = 0.5;
        else if (normalized.includes("/src/")) boost = 1.35;
        else if (normalized.includes("/lib/") || normalized.includes("/core/")) boost = 1.2;

        if (nodeType === "top_level") boost *= 0.85;
        else if (nodeType === "class") boost *= 0.9;
        return boost;
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
            `SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name, qualified_name
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
                    qualified_name: (row.qualified_name as string) ?? "",
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
        this.ensureKeywordIndex();
        const kwResults = this.kwIndex.search(queryText, Math.max(limit * 4, 40));
        if (kwResults.length === 0) return [];

        const chunkMap = this.fetchChunksBatch(kwResults.map(r => r.rowid));
        const results: HybridSearchResult[] = [];

        for (const { rowid, score } of kwResults) {
            const row = chunkMap.get(rowid);
            if (row) {
                const boostedScore = score * this.getPathBoost(row.path, row.node_type);
                results.push({
                    id: row.id, path: row.path, shorthand: row.shorthand,
                    raw_code: row.raw_code, node_type: row.node_type,
                    start_line: row.start_line, end_line: row.end_line,
                    start_index: row.start_index, end_index: row.end_index,
                    symbol_name: row.symbol_name,
                    qualified_name: row.qualified_name ?? "",
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

    /** Rows buffered by NrekiEngine.logUsage: [tool, input, output, saved]. */
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
            ? "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name, qualified_name FROM chunks WHERE symbol_name = ?"
            : "SELECT id, path, shorthand, raw_code, node_type, start_line, end_line, start_index, end_index, symbol_name, qualified_name FROM chunks WHERE symbol_name = ? COLLATE NOCASE";
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
                    qualified_name: (row.qualified_name as string) ?? "",
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


