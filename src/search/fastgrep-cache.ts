import type { FastGrepCacheRow, NrekiDB } from "../database.js";

// Singleton para slots tombstoneados. Cero alocaciones por
// tombstone (el patrón new Uint32Array(0) cada vez sería
// wasteful en sesiones con muchos saves del watcher).
const EMPTY_U32 = new Uint32Array(0);

export class FastGrepRAMCache {
    public chunkIds = new Uint32Array(0);
    public startLines = new Uint32Array(0);
    public rawCodes: string[] = [];
    public paths: string[] = [];
    public symbols: string[] = [];
    public lineMaps: Uint32Array[] = [];

    get size(): number {
        return this.rawCodes.length;
    }

    clear(): void {
        this.chunkIds = new Uint32Array(0);
        this.startLines = new Uint32Array(0);
        this.rawCodes = [];
        this.paths = [];
        this.symbols = [];
        this.lineMaps = [];
    }

    populateFromDatabase(db: NrekiDB): void {
        const rows = db.exportAllChunksForCache();
        const count = rows.length;

        this.chunkIds = new Uint32Array(count);
        this.startLines = new Uint32Array(count);
        this.rawCodes = [];
        this.paths = [];
        this.symbols = [];
        this.lineMaps = [];

        for (let i = 0; i < count; i++) {
            const row = rows[i] as FastGrepCacheRow;
            this.chunkIds[i] = row[0];
            this.startLines[i] = row[3];
            this.paths.push(row[1]);
            this.symbols.push(row[2]);
            this.rawCodes.push(row[4]);
            this.lineMaps.push(this.buildLineMap(row[4]));
        }
    }

    /**
     * Append new chunks to the cache without rebuilding it.
     * Used after incremental indexFile to add freshly-indexed
     * chunks of a single path. The caller is responsible for
     * having tombstoned old slots of that path FIRST (otherwise
     * old + new coexist).
     *
     * Does NOT compact tombstones. Compaction is a separate
     * operation (commit 3).
     */
    appendChunks(rows: FastGrepCacheRow[]): void {
        if (rows.length === 0) return;
        const oldSize = this.size;
        const newSize = oldSize + rows.length;

        const newChunkIds = new Uint32Array(newSize);
        newChunkIds.set(this.chunkIds);
        const newStartLines = new Uint32Array(newSize);
        newStartLines.set(this.startLines);

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const slot = oldSize + i;
            newChunkIds[slot] = row[0];
            newStartLines[slot] = row[3];
            this.paths.push(row[1]);
            this.symbols.push(row[2]);
            this.rawCodes.push(row[4]);
            this.lineMaps.push(this.buildLineMap(row[4]));
        }

        this.chunkIds = newChunkIds;
        this.startLines = newStartLines;
    }

    /**
     * Mark all slots whose path === filePath as tombstones.
     * Slots remain in arrays (no compaction) but are zeroed
     * so they no longer match queries.
     *
     * Idempotent: re-tombstoning the same path is O(N) but
     * touches nothing (paths[i] is already "").
     *
     * Cost: zero allocations. The empty Uint32Array is a module-level
     * singleton; "" is V8's interned EmptyString.
     */
    tombstoneByPath(filePath: string): void {
        if (filePath === "") return;
        for (let i = 0; i < this.size; i++) {
            if (this.paths[i] === filePath) {
                this.rawCodes[i] = "";
                this.paths[i] = "";
                this.symbols[i] = "";
                this.lineMaps[i] = EMPTY_U32;
                this.startLines[i] = 0;
                this.chunkIds[i] = 0;
            }
        }
    }

    private buildLineMap(rawCode: string): Uint32Array {
        const offsets: number[] = [];
        let pos = rawCode.indexOf("\n");
        while (pos !== -1) {
            offsets.push(pos);
            pos = rawCode.indexOf("\n", pos + 1);
        }
        return Uint32Array.from(offsets);
    }

    /**
     * Autotest de integridad. Re-ejecuta el SELECT y compara
     * cada campo del cache contra la fila correspondiente en DB.
     * Lanza Error en cualquier discrepancia.
     *
     * NO usar en hot path. Costoso (full SELECT + N comparaciones
     * de strings). Solo para debugging / autotests post-populate.
     */
    public validateAgainstDatabase(db: NrekiDB): void {
        const rows = db.exportAllChunksForCache();
        if (this.size !== rows.length) {
            throw new Error(`[Validation] Size mismatch: DB=${rows.length}, RAM=${this.size}`);
        }
        for (let i = 0; i < this.size; i++) {
            const r = rows[i];
            if (this.chunkIds[i] !== r[0]) throw new Error(`ID mismatch at index ${i}: DB=${r[0]} RAM=${this.chunkIds[i]}`);
            if (this.paths[i] !== r[1]) throw new Error(`Path mismatch at index ${i}`);
            if (this.symbols[i] !== r[2]) throw new Error(`Symbol mismatch at index ${i}`);
            if (this.startLines[i] !== r[3]) throw new Error(`StartLine mismatch at index ${i}: DB=${r[3]} RAM=${this.startLines[i]}`);
            if (this.rawCodes[i] !== r[4]) throw new Error(`RawCode mismatch at index ${i}`);

            const expectedNl = (r[4].match(/\n/g) || []).length;
            if (this.lineMaps[i].length !== expectedNl) {
                throw new Error(`LineMap length mismatch at index ${i}: expected=${expectedNl} got=${this.lineMaps[i].length}`);
            }
        }
    }
}
