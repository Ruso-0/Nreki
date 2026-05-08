import type { FastGrepCacheRow, NrekiDB } from "../database.js";

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

    private buildLineMap(rawCode: string): Uint32Array {
        const newlines: number[] = [];
        for (let i = 0; i < rawCode.length; i++) {
            if (rawCode.charCodeAt(i) === 10) {
                newlines.push(i);
            }
        }
        return Uint32Array.from(newlines);
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
