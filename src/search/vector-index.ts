/**
 * Pure JavaScript vector similarity and brute-force index.
 * For L2-normalized embeddings (Jina), dot product = cosine similarity.
 * For codebases up to ~50K chunks, brute-force is fast enough (<10ms)
 * and avoids any native dependency.
 */

export function fastSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

// Fallback cosine similarity for non-normalized models:
// function cosineSimilarity(a: Float32Array, aNorm: number, b: Float32Array, bNorm: number): number {
//     let dot = 0;
//     for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
//     return (aNorm > 0 && bNorm > 0) ? dot / (aNorm * bNorm) : 0;
// }

export class VectorIndex {
    private vectors = new Map<number, Float32Array>();
    private _dirty = false;

    get dirty(): boolean { return this._dirty; }

    insert(rowid: number, embedding: Float32Array): void {
        this.vectors.set(rowid, embedding);
        this._dirty = true;
    }

    delete(rowid: number): void {
        this.vectors.delete(rowid);
        this._dirty = true;
    }

    deleteBulk(rowids: number[]): void {
        for (const id of rowids) {
            this.vectors.delete(id);
        }
        if (rowids.length > 0) this._dirty = true;
    }

    search(
        query: Float32Array,
        limit: number
    ): Array<{ rowid: number; distance: number }> {
        const scored: Array<{ rowid: number; distance: number }> = [];

        for (const [rowid, vec] of this.vectors) {
            const sim = fastSimilarity(query, vec);
            scored.push({ rowid, distance: 1 - sim });
        }

        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, limit);
    }

    get size(): number {
        return this.vectors.size;
    }

    /**
     * Serialize the vector index to a binary buffer.
     * Format: [count:u32] + ([rowid:u32][vec:f32×dim])×count
     * Note: rowid uses UInt32 - max 4,294,967,295. Sufficient for practical
     * codebases (would require billions of INSERT/DELETE cycles to overflow).
     */
    serialize(): Buffer {
        const entries = Array.from(this.vectors.entries());
        const header = Buffer.alloc(4);
        header.writeUInt32LE(entries.length);

        const chunks: Buffer[] = [header];
        for (const [rowid, vec] of entries) {
            const idBuf = Buffer.alloc(4);
            idBuf.writeUInt32LE(rowid);
            chunks.push(idBuf);
            // AUDIT FIX: Force deep copy to isolate SQLite writes from WASM memory
            chunks.push(Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)));
        }
        this._dirty = false;
        return Buffer.concat(chunks);
    }

    static deserialize(buf: Buffer, dim: number): VectorIndex {
        const index = new VectorIndex();
        if (buf.length < 4) return index;

        const count = buf.readUInt32LE(0);
        let offset = 4;
        const vecBytes = dim * 4;

        for (let i = 0; i < count; i++) {
            if (offset + 4 + vecBytes > buf.length) break;
            const rowid = buf.readUInt32LE(offset);
            offset += 4;
            // Always deep-copy. Zero-copy via Float32Array(buf.buffer, offset, dim)
            // creates a VIEW that shares memory with the source buffer.
            // If sql.js WASM reuses that memory region, vectors corrupt silently.
            const vec = new Float32Array(dim);
            new Uint8Array(vec.buffer).set(buf.subarray(offset, offset + vecBytes));
            index.vectors.set(rowid, vec);
            offset += vecBytes;
        }
        return index;
    }
}
