/**
 * vector-index.ts — Whole-repository dense index (opt-in Voyage AI).
 *
 * Every chunk is embedded ONCE (input_type "document") in the background and
 * stored in the DB, keyed by the hash of its embedding text: re-indexing an
 * unchanged chunk costs no API call, and at search time only the query is
 * sent. Retrieval is a brute-force int8 dot product over all chunks (a few ms
 * for thousands of chunks); the searcher fuses it with BM25, so a chunk BM25
 * never retrieved (no shared words with the question) can still be found.
 */

import crypto from "crypto";
import path from "path";
import type { EmbeddingSource, NrekiDB } from "../database.js";
import { isSensitivePath } from "../utils/path-jail.js";
import { logger } from "../utils/logger.js";
import { quantize, voyageEmbed, voyageLogOnce, type VoyageConfig, type RateLimits } from "./voyage.js";

const BODY_CHARS = 6000;          // ≈1.5k tokens per chunk
const CLASS_HEADER_CHARS = 2500;  // a class's methods are embedded as their own chunks
const BATCH_TEXTS = 64;
const BATCH_TOKENS = 60_000;      // well under the documented 120K tokens/request of the code models
const CHARS_PER_TOKEN = 3.5;
const QUERY_TIMEOUT_MS = 2500;
const BATCH_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;
const QUERY_CACHE_MAX = 500;
const DEFAULT_TOKEN_BUDGET = 20_000_000;

export interface DenseHit { id: number; score: number }

export interface VectorIndexOptions {
    /** Called after each stored batch (the engine schedules a DB save). */
    onStored?: () => void;
    /** Base delay for 429/5xx/network retries (doubles each attempt). */
    retryBaseMs?: number;
    /** Length of a rate-limit window (tests shorten the minute). */
    rateWindowMs?: number;
    env?: NodeJS.ProcessEnv;
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const estimateTokens = (texts: string[]): number => Math.ceil(texts.reduce((n, t) => n + t.length, 0) / CHARS_PER_TOKEN);
const sleep = (ms: number) => new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
});

export class VectorIndex {
    private ids: number[] = [];
    private matrix = new Int8Array(0);
    private dim = 0;
    private loadedGeneration = -1;
    private loadedStoreVersion = -1;
    private storeVersion = 0;
    private syncing: Promise<void> | null = null;
    private syncAgain = false;
    private stopped = false;
    private queryCache = new Map<string, Float32Array>();
    private tokenBudget: number;
    private readonly onStored: () => void;
    private readonly retryBaseMs: number;
    private readonly rateWindowMs: number;
    /**
     * Account limits a 429 stated. A Voyage account without a payment method
     * gets 3 requests and 10K tokens per minute: every 60K-token batch was
     * refused, the index gave up after 6 tries and nothing was ever embedded.
     */
    private limits: RateLimits | null = null;
    /** Tokens per request, lowered to fit `limits`. */
    private batchTokens = BATCH_TOKENS;
    /** Requests of the last minute (pacing under `limits`). */
    private sent: Array<{ at: number; tokens: number }> = [];
    /** Tokens still to embed in the running sync (for the time estimate). */
    private pendingTokens = 0;
    private lastFailure = "";

    constructor(
        private readonly db: NrekiDB,
        private readonly cfg: VoyageConfig,
        private readonly projectRoot: string,
        options: VectorIndexOptions = {},
    ) {
        const budget = Number((options.env ?? process.env).NREKI_VOYAGE_MAX_TOKENS);
        this.tokenBudget = budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;
        this.onStored = options.onStored ?? (() => {});
        this.retryBaseMs = options.retryBaseMs ?? 1000;
        this.rateWindowMs = options.rateWindowMs ?? 60_000;
    }

    get model(): string {
        return this.cfg.model;
    }

    /** What represents a chunk: where it lives, its comments, then its code. null = not embedded. */
    embedText(c: EmbeddingSource): string | null {
        if (isSensitivePath(c.path)) return null;
        // Import lines say little about what a file does; gap chunks are mostly imports.
        const code = c.node_type === "top_level" ? c.raw_code.replace(/^\s*import\b[^\n]*$/gm, "").trim() : c.raw_code;
        if (code.replace(/\s+/g, "").length < 40) return null;
        const rel = path.relative(this.projectRoot, c.path).split(path.sep).join("/");
        const limit = c.node_type === "class" ? CLASS_HEADER_CHARS : BODY_CHARS;
        return [rel, (c.context_comment ?? "").trim(), code.slice(0, limit)].filter(Boolean).join("\n");
    }

    /** Chunks with a vector / chunks eligible for one. */
    coverage(): { embedded: number; total: number } {
        this.ensureLoaded();
        let total = 0;
        for (const src of this.db.getEmbeddingSources()) if (this.embedText(src)) total++;
        return { embedded: this.ids.length, total };
    }

    /** Embed every chunk that has no vector yet. Concurrent calls coalesce; never throws. */
    sync(): Promise<void> {
        if (this.syncing) {
            this.syncAgain = true;
            return this.syncing;
        }
        this.syncing = this.runSync()
            .catch(err => logger.warn(`[NREKI] Voyage indexing error: ${(err as Error).message}`))
            .finally(() => { this.syncing = null; });
        return this.syncing;
    }

    stop(): void {
        this.stopped = true;
    }

    private async runSync(): Promise<void> {
        do {
            this.syncAgain = false;
            const todo = this.missing();
            if (todo.length > 0) {
                const estTokens = Math.ceil(todo.reduce((n, t) => n + t.text.length, 0) / CHARS_PER_TOKEN);
                if (estTokens > this.tokenBudget) {
                    voyageLogOnce("budget", "warn",
                        `[NREKI] Voyage indexing skipped: ~${estTokens.toLocaleString("en-US")} tokens left to embed exceeds ` +
                        `the budget (NREKI_VOYAGE_MAX_TOKENS, default ${DEFAULT_TOKEN_BUDGET.toLocaleString("en-US")}).`);
                    return;
                }
                voyageLogOnce("privacy", "info",
                    `[NREKI] Voyage semantic index ON (${this.cfg.model}): every code chunk (path, comments, up to ` +
                    `${BODY_CHARS} chars) is sent once to api.voyageai.com; searches send only the query. Sensitive paths are excluded.`);
                logger.info(`[NREKI] Voyage: embedding ${todo.length} chunk(s), ~${estTokens.toLocaleString("en-US")} tokens.`);

                let done = 0;
                this.pendingTokens = estTokens;
                for (const batch of this.batches(todo)) {
                    if (this.stopped) return;
                    const vectors = await this.embedWithRetry(batch.map(t => t.text));
                    if (!vectors || this.stopped) return;
                    this.db.putEmbeddings(this.cfg.model, batch.map((t, i) => ({ hash: t.hash, vec: quantize(vectors[i]) })));
                    this.storeVersion++;
                    const spent = estimateTokens(batch.map(t => t.text));
                    this.tokenBudget -= spent;
                    this.pendingTokens = Math.max(0, this.pendingTokens - spent);
                    done += batch.length;
                    this.onStored();
                }
                logger.info(`[NREKI] Voyage: embedded ${done} chunk(s).`);
            }
        } while (this.syncAgain && !this.stopped);

        if (this.stopped) return;
        const removed = this.db.pruneEmbeddings(this.cfg.model, this.liveHashes());
        if (removed > 0) {
            this.storeVersion++;
            this.onStored();
        }
    }

    private liveHashes(): Set<string> {
        const live = new Set<string>();
        for (const src of this.db.getEmbeddingSources()) {
            const text = this.embedText(src);
            if (text) live.add(sha(text));
        }
        return live;
    }

    private missing(): Array<{ hash: string; text: string }> {
        const have = this.db.getEmbeddingHashes(this.cfg.model);
        const seen = new Set<string>();
        const out: Array<{ hash: string; text: string }> = [];
        for (const src of this.db.getEmbeddingSources()) {
            const text = this.embedText(src);
            if (!text) continue;
            const hash = sha(text);
            if (have.has(hash) || seen.has(hash)) continue;
            seen.add(hash);
            out.push({ hash, text });
        }
        return out;
    }

    private *batches<T extends { text: string }>(items: T[]): Generator<T[]> {
        let batch: T[] = [];
        let tokens = 0;
        for (const item of items) {
            const t = Math.ceil(item.text.length / CHARS_PER_TOKEN);
            // batchTokens is read on every item: a limit learned mid-sync applies at once.
            if (batch.length > 0 && (batch.length >= BATCH_TEXTS || tokens + t > this.batchTokens)) {
                yield batch;
                batch = [];
                tokens = 0;
            }
            batch.push(item);
            tokens += t;
        }
        if (batch.length > 0) yield batch;
    }

    private async embedWithRetry(texts: string[]): Promise<Float32Array[] | null> {
        const tokens = estimateTokens(texts);
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (this.stopped) return null;
            // A batch larger than the account's per-minute tokens can never pass: halve it.
            if (this.limits && tokens > this.batchTokens && texts.length > 1) return this.embedHalves(texts);
            await this.pace(tokens);
            if (this.stopped) return null;
            this.sent.push({ at: Date.now(), tokens });
            const res = await voyageEmbed(this.cfg, texts, "document", BATCH_TIMEOUT_MS);
            if (res.ok) return res.vectors;
            this.lastFailure = res.reason;
            if (!res.retryable) {
                voyageLogOnce(`index-fatal-${res.reason}`, "warn",
                    `[NREKI] Voyage indexing stopped: ${res.reason}. Search keeps working with BM25.`);
                return null;
            }
            if (res.limits) {
                this.adoptLimits(res.limits);
                continue; // pace() waits for room; a limited account is slow, not failing
            }
            await sleep(res.retryAfterMs ?? Math.min(60_000, this.retryBaseMs * 2 ** attempt));
        }
        voyageLogOnce("index-gave-up", "warn",
            `[NREKI] Voyage indexing paused after repeated errors (last: ${this.lastFailure}); ` +
            "it resumes on the next index update. Search keeps working with BM25.");
        return null;
    }

    private async embedHalves(texts: string[]): Promise<Float32Array[] | null> {
        const mid = Math.ceil(texts.length / 2);
        const first = await this.embedWithRetry(texts.slice(0, mid));
        if (!first) return null;
        const second = await this.embedWithRetry(texts.slice(mid));
        return second ? [...first, ...second] : null;
    }

    private adoptLimits(limits: RateLimits): void {
        const changed = !this.limits || this.limits.rpm !== limits.rpm || this.limits.tpm !== limits.tpm;
        this.limits = limits;
        this.batchTokens = Math.max(500, Math.min(BATCH_TOKENS, Math.floor(limits.tpm * 0.8)));
        if (!changed) return;
        const minutes = Math.ceil(this.pendingTokens / (limits.tpm * 0.8));
        voyageLogOnce(`limits-${limits.rpm}-${limits.tpm}`, "warn",
            `[NREKI] This Voyage account is limited to ${limits.rpm} requests and ${limits.tpm.toLocaleString("en-US")} tokens ` +
            `per minute (Voyage applies it to accounts without a payment method): embedding ` +
            `~${this.pendingTokens.toLocaleString("en-US")} tokens takes ~${minutes} min. Search uses BM25 until then. ` +
            "Adding a payment method in the Voyage dashboard lifts the limit.");
    }

    /** Requests and tokens of the last minute, after dropping older entries. */
    private window(): { requests: number; tokens: number } {
        const now = Date.now();
        this.sent = this.sent.filter(s => now - s.at < this.rateWindowMs);
        return { requests: this.sent.length, tokens: this.sent.reduce((n, s) => n + s.tokens, 0) };
    }

    /** True if a request of `tokens` fits the known per-minute limits now. */
    private hasRoom(tokens: number): boolean {
        if (!this.limits) return true;
        const w = this.window();
        return w.requests === 0 || (w.requests < this.limits.rpm && w.tokens + tokens <= this.limits.tpm);
    }

    /** Wait until a request of `tokens` fits the account's per-minute limits. */
    private async pace(tokens: number): Promise<void> {
        while (!this.stopped && !this.hasRoom(tokens)) {
            const oldest = this.sent[0]?.at ?? Date.now();
            await sleep(Math.max(Math.min(250, this.rateWindowMs), this.rateWindowMs - (Date.now() - oldest) + 5));
        }
    }

    /** Build the RAM matrix from the DB when chunks or vectors changed. */
    private ensureLoaded(): void {
        if (this.db.chunkGeneration === this.loadedGeneration && this.storeVersion === this.loadedStoreVersion) return;
        const stored = this.db.getEmbeddings(this.cfg.model);
        const ids: number[] = [];
        const rows: Int8Array[] = [];
        let dim = 0;
        for (const src of this.db.getEmbeddingSources()) {
            const text = this.embedText(src);
            if (!text) continue;
            const vec = stored.get(sha(text));
            if (!vec) continue;
            if (dim === 0) dim = vec.length;
            if (vec.length !== dim) continue;
            ids.push(src.id);
            rows.push(vec);
        }
        const matrix = new Int8Array(ids.length * dim);
        rows.forEach((r, i) => matrix.set(r, i * dim));
        this.ids = ids;
        this.matrix = matrix;
        this.dim = dim;
        this.loadedGeneration = this.db.chunkGeneration;
        this.loadedStoreVersion = this.storeVersion;
    }

    /** Dense top-k for a query, or null when unavailable (no vectors yet, offline, timeout). */
    async searchQuery(query: string, k: number): Promise<DenseHit[] | null> {
        this.ensureLoaded();
        if (this.ids.length === 0) return null;
        let q = this.queryCache.get(query);
        if (!q) {
            // A limited account has no request to spare this minute: answer with
            // BM25 now instead of spending one on a 429.
            const qTokens = estimateTokens([query]);
            if (!this.hasRoom(qTokens)) return null;
            this.sent.push({ at: Date.now(), tokens: qTokens });
            const res = await voyageEmbed(this.cfg, [query], "query", QUERY_TIMEOUT_MS);
            if (!res.ok) {
                if (res.limits) this.adoptLimits(res.limits);
                voyageLogOnce(`query-${res.reason}`, "warn", `[NREKI] Voyage query failed (${res.reason}); using BM25 only.`);
                return null;
            }
            const raw = res.vectors[0];
            let norm = 0;
            for (let i = 0; i < raw.length; i++) norm += raw[i] * raw[i];
            norm = Math.sqrt(norm) || 1;
            q = raw.map(x => x / norm);
            this.queryCache.set(query, q);
            if (this.queryCache.size > QUERY_CACHE_MAX) {
                const oldest = this.queryCache.keys().next().value;
                if (oldest !== undefined) this.queryCache.delete(oldest);
            }
        }
        if (q.length !== this.dim) return null;

        const n = this.ids.length;
        const dim = this.dim;
        const m = this.matrix;
        const scores = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0;
            const off = i * dim;
            for (let j = 0; j < dim; j++) s += q[j] * m[off + j];
            scores[i] = s / 127;
        }
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k);
        return order.map(i => ({ id: this.ids[i], score: scores[i] }));
    }
}
