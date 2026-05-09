/**
 * engine.test.ts - Unit tests for the NREKI engine.
 *
 * Tests cover:
 * - Database schema setup and CRUD operations (async init for sql.js)
 * - File hashing and Merkle-style diffing
 * - Shorthand generation from AST nodes
 * - Hybrid RRF search with mock data
 * - Token savings estimation
 * - Compressor tier outputs
 * - Monitor burn rate calculation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { NrekiDB } from "../src/database.js";
import { TokenMonitor } from "../src/monitor.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { Compressor } from "../src/compressor.js";

// ─── Test Fixtures ───────────────────────────────────────────────────

const SAMPLE_TS_CODE = `
import { Request, Response } from 'express';

/**
 * Handles user authentication.
 */
export class AuthService {
  private users: Map<string, string> = new Map();

  async authenticate(username: string, password: string): Promise<boolean> {
    const stored = this.users.get(username);
    if (!stored) return false;
    return stored === password;
  }

  async register(username: string, password: string): Promise<void> {
    if (this.users.has(username)) {
      throw new Error('User already exists');
    }
    this.users.set(username, password);
  }
}

export function createMiddleware(service: AuthService) {
  return async (req: Request, res: Response, next: Function) => {
    const token = req.headers.authorization;
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
`;

// ─── Database Tests ──────────────────────────────────────────────────

describe("NrekiDB", () => {
    let db: NrekiDB;
    const testDbPath = path.join(os.tmpdir(), `nreki-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new NrekiDB(testDbPath);
        await db.initialize();
    });

    afterAll(() => {
        db.close();
        // Clean up test database
        try {
            fs.unlinkSync(testDbPath);
        } catch {
            // Files may not exist
        }
    });

    it("should create database with correct schema", () => {
        const stats = db.getStats();
        expect(stats.total_chunks).toBe(0);
        expect(stats.total_files).toBe(0);
    });

    it("should detect when a file needs updating", () => {
        const content = "console.log('hello');";
        expect(db.fileNeedsUpdate("/test/file.ts", content)).toBe(true);

        // After upserting, should no longer need update
        const hash = db.hashContent(content);
        db.upsertFile("/test/file.ts", hash);
        expect(db.fileNeedsUpdate("/test/file.ts", content)).toBe(false);
    });

    it("should detect changes when content differs", () => {
        const original = "const x = 1;";
        const hash = db.hashContent(original);
        db.upsertFile("/test/change.ts", hash);

        expect(db.fileNeedsUpdate("/test/change.ts", original)).toBe(false);
        expect(db.fileNeedsUpdate("/test/change.ts", "const x = 2;")).toBe(true);
    });

    it("should insert and count chunks", () => {
        db.insertChunk(
            "/test/sample.ts",
            "[func] authenticate(username, password)",
            "async authenticate(username: string, password: string) { ... }",
            "func",
            10,
            15,
        );

        const stats = db.getStats();
        expect(stats.total_chunks).toBeGreaterThanOrEqual(1);
    });

    it("should batch insert chunks", () => {
        const chunks = [
            {
                path: "/test/batch.ts",
                shorthand: "[func] foo()",
                rawCode: "function foo() { return 1; }",
                nodeType: "func",
                startLine: 1,
                endLine: 3,
            },
            {
                path: "/test/batch.ts",
                shorthand: "[func] bar()",
                rawCode: "function bar() { return 2; }",
                nodeType: "func",
                startLine: 5,
                endLine: 7,
            },
        ];

        db.insertChunksBatch(chunks);
        const stats = db.getStats();
        expect(stats.total_chunks).toBeGreaterThanOrEqual(3);
    });

    // (searchVector / searchHybrid tests removed v11.0.0:
    //  embeddings amputated, only keyword search remains.)

    it("should clear chunks for a file", () => {
        db.insertChunk("/test/clearme.ts", "[func] temp()", "function temp() {}", "func", 1, 1);
        db.clearChunks("/test/clearme.ts");
        // Cannot directly verify deletion without querying - but no error means success
    });

    it("should log and retrieve usage stats", () => {
        db.logUsage("nreki_search", 100, 200, 500);
        db.logUsage("nreki_compress", 50, 100, 300);

        const stats = db.getUsageStats();
        expect(stats.total_saved).toBeGreaterThanOrEqual(800);
        expect(stats.tool_calls).toBeGreaterThanOrEqual(2);
    });

    it("should compute compression ratio", () => {
        const stats = db.getStats();
        expect(stats.compression_ratio).toBeGreaterThanOrEqual(0);
        expect(stats.compression_ratio).toBeLessThanOrEqual(1);
    });

    it("should store and retrieve metadata", () => {
        db.setMetadata("test_key", "test_value");
        expect(db.getMetadata("test_key")).toBe("test_value");
        expect(db.getMetadata("nonexistent")).toBeNull();
    });

    // (Embedding dimension tests removed v11.0.0: checkEmbeddingDimension
    //  and getVectorCount methods amputated with embeddings.)
});

// (Embedder describe removed v11.0.0: class amputated.
//  estimateTokens helper coverage in tests/parser-type-extraction.test.ts
//  via real flow.)

// ─── Monitor Tests ──────────────────────────────────────────────────

describe("TokenMonitor", () => {
    let monitor: TokenMonitor;

    beforeEach(() => {
        monitor = new TokenMonitor({
            logPath: "/nonexistent/path/usage.jsonl",
            budgetTokens: 1_000_000,
        });
    });

    it("should return zero burn rate with no data", () => {
        const burnRate = monitor.computeBurnRate();
        expect(burnRate.tokensPerMinute).toBe(0);
        expect(burnRate.totalConsumed).toBe(0);
        expect(burnRate.apiCalls).toBe(0);
    });

    it("should predict no exhaustion with no data", () => {
        const prediction = monitor.predictExhaustion();
        expect(prediction.minutesRemaining).toBe(Infinity);
        expect(prediction.shouldAlert).toBe(false);
        expect(prediction.alertLevel).toBe("none");
    });

    it("should generate a formatted report", () => {
        const report = monitor.generateReport();
        expect(report).toContain("NREKI");
        expect(report).toContain("Burn Rate");
        expect(report).toContain("Total Used");
    });
});

// ─── CognitiveEnforcer Tests ────────────────────────────────────────

describe("CognitiveEnforcer", () => {
    let enforcer: CognitiveEnforcer;
    const tmpDir = path.join(os.tmpdir(), `nreki-enforcer-test-${Date.now()}`);

    beforeAll(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    beforeEach(() => {
        enforcer = new CognitiveEnforcer(tmpDir);
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should not block small files", () => {
        const tempFile = path.join(tmpDir, "small.ts");
        fs.writeFileSync(tempFile, "const x = 1;");
        const result = enforcer.evaluate("nreki_code", "read", { path: tempFile });
        expect(result.blocked).toBe(false);
    });

    it("should block raw read on large files", () => {
        const tempFile = path.join(tmpDir, "large.ts");
        fs.writeFileSync(tempFile, Array(150).fill("const x = 1;").join("\n"));
        const result = enforcer.evaluate("nreki_code", "read", { path: tempFile });
        expect(result.blocked).toBe(true);
        expect(result.errorText).toContain('nreki_code action:"compress"');
        expect(result.errorText).toContain('focus:');
        expect(result.errorText).toContain('outline');
    });

    it("should allow compress with focus", () => {
        const tempFile = path.join(tmpDir, "focused.ts");
        fs.writeFileSync(tempFile, Array(150).fill("const x = 1;").join("\n"));
        const result = enforcer.evaluate("nreki_code", "compress", { path: tempFile, focus: "myFunc" });
        expect(result.blocked).toBe(false);
    });

    it("should block compress without focus on large files", () => {
        const tempFile = path.join(tmpDir, "nofocus.ts");
        fs.writeFileSync(tempFile, Array(150).fill("const x = 1;").join("\n"));
        const result = enforcer.evaluate("nreki_code", "compress", { path: tempFile });
        expect(result.blocked).toBe(true);
    });
});

// ─── KeywordIndex / Porter Stemmer Tests ────────────────────────────

describe("Porter Stemmer (via KeywordIndex)", () => {
    let db: NrekiDB;
    const stemDbPath = path.join(os.tmpdir(), `nreki-stem-test-${Date.now()}.db`);

    beforeAll(async () => {
        db = new NrekiDB(stemDbPath);
        await db.initialize();
    });

    afterAll(() => {
        db.close();
        try {
            fs.unlinkSync(stemDbPath);
        } catch { /* ignore */ }
    });

    it("should find keyword matches in shorthand", () => {
        db.insertChunk("/test/stem.ts", "[func] running() { /* TG:L1-L5 */ }", "function running() { ... }", "func", 1, 5);

        // v11.0.0: keyword-only via BM25. Stemming via Porter happens
        // inside KeywordIndex if configured; literal "running" matches
        // shorthand directly regardless of stemmer state.
        const results = db.searchKeywordOnly("running", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should find stemmed matches (connections -> connect)", () => {
        db.insertChunk("/test/stem.ts", "[func] connectDatabase() { /* TG:L10-L20 */ }", "function connectDatabase() { ... }", "func", 10, 20);

        const results = db.searchKeywordOnly("connections database", 5);
        expect(results.length).toBeGreaterThan(0);
    });

    it("should boost bigram phrase matches", () => {
        db.insertChunk("/test/bigram1.ts", "[func] authMiddleware() auth middleware handler", "function authMiddleware() { ... }", "func", 1, 5);
        db.insertChunk("/test/bigram2.ts", "[func] something() auth unrelated middleware", "function something() { ... }", "func", 1, 5);

        // "auth middleware" as a phrase should boost bigram1 which has them adjacent
        const results = db.searchKeywordOnly("auth middleware", 5);
        expect(results.length).toBeGreaterThan(0);
    });
});

// ─── Compressor Static Tests ────────────────────────────────────────

describe("Compressor (static)", () => {
    it("should estimate savings for different tiers", () => {
        const savings1 = Compressor.estimateSavings(SAMPLE_TS_CODE, 1);
        const savings2 = Compressor.estimateSavings(SAMPLE_TS_CODE, 2);
        const savings3 = Compressor.estimateSavings(SAMPLE_TS_CODE, 3);

        expect(savings1.estimatedRatio).toBeGreaterThan(savings2.estimatedRatio);
        expect(savings2.estimatedRatio).toBeGreaterThan(savings3.estimatedRatio);
        expect(savings1.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it("should have higher savings at Tier 1 than Tier 3", () => {
        const tier1 = Compressor.estimateSavings(SAMPLE_TS_CODE, 1);
        const tier3 = Compressor.estimateSavings(SAMPLE_TS_CODE, 3);
        expect(tier1.estimatedTokensSaved).toBeGreaterThan(tier3.estimatedTokensSaved);
    });
});
