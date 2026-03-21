/**
 * parser-pool.ts - Thread-safe parser pool for web-tree-sitter.
 *
 * Solves the race condition where a single Parser instance shared across
 * concurrent calls can have setLanguage() interleaved with parse().
 * Each acquire() returns a Parser with the language already set.
 * Backpressure: if all parsers are in use, callers wait until one is released.
 */

import Parser from "web-tree-sitter";

export class ParserPool {
    private pools = new Map<string, Parser[]>();
    private counts = new Map<string, number>();
    private waiters = new Map<string, Array<(p: Parser) => void>>();
    private readonly maxPerLang: number;
    private initialized = false;

    constructor(maxPerLang: number = 4) {
        this.maxPerLang = maxPerLang;
    }

    /** Initialize the WASM runtime. Idempotent. */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await Parser.init();
        this.initialized = true;
    }

    /**
     * Acquire a parser with the given language already set.
     * Returns an idle parser from the pool, creates a new one (up to max),
     * or waits for a release if at capacity.
     */
    async acquire(lang: Parser.Language, langKey: string): Promise<Parser> {
        await this.initialize();

        const pool = this.pools.get(langKey) ?? [];
        this.pools.set(langKey, pool);

        if (pool.length > 0) {
            const parser = pool.pop()!;
            parser.setLanguage(lang);
            return parser;
        }

        const count = this.counts.get(langKey) ?? 0;
        if (count < this.maxPerLang) {
            this.counts.set(langKey, count + 1);
            const parser = new Parser();
            parser.setLanguage(lang);
            return parser;
        }

        // Backpressure: wait for a parser to be released (with timeout)
        return new Promise<Parser>((resolve, reject) => {
            const timer = setTimeout(() => {
                const q = this.waiters.get(langKey);
                if (q) {
                    const idx = q.indexOf(cb);
                    if (idx >= 0) q.splice(idx, 1);
                }
                reject(new Error(`[NREKI] ParserPool.acquire("${langKey}") timed out after 30000ms`));
            }, 30_000);

            const cb = (p: Parser) => {
                clearTimeout(timer);
                p.setLanguage(lang);
                resolve(p);
            };

            const q = this.waiters.get(langKey) ?? [];
            this.waiters.set(langKey, q);
            q.push(cb);
        });
    }

    /** Return a parser to the pool or hand it to a waiting caller. */
    release(langKey: string, parser: Parser): void {
        const q = this.waiters.get(langKey);
        if (q && q.length > 0) {
            const next = q.shift()!;
            next(parser);
            return;
        }

        const pool = this.pools.get(langKey) ?? [];
        this.pools.set(langKey, pool);
        pool.push(parser);
    }
}
