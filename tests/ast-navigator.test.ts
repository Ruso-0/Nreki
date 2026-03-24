/**
 * ast-navigator.test.ts - Tests for AST-based navigation tools.
 *
 * Covers:
 * - findDefinition: exact match, kind filtering, not found
 * - findReferences: across multiple files
 * - getFileSymbols: file outline
 * - Edge cases: empty files, no matches
 * - Performance: symbol lookup in many files
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ASTParser } from "../src/parser.js";
import {
    findDefinition,
    findReferences,
    getFileSymbols,
} from "../src/ast-navigator.js";

// ─── Test Fixtures ──────────────────────────────────────────────────

const testDir = path.join(os.tmpdir(), `tg-navigator-test-${Date.now()}`);

const TEST_FILES: Record<string, string> = {
    "src/auth.ts": `
import { Request, Response } from "express";
import { Database } from "./database.js";

export interface AuthConfig {
    secret: string;
    expiresIn: number;
}

export class AuthService {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
    }

    async authenticate(req: Request, res: Response): Promise<boolean> {
        const token = req.headers.authorization;
        if (!token) return false;
        return this.db.validateToken(token);
    }

    async logout(userId: string): Promise<void> {
        await this.db.revokeTokens(userId);
    }
}

export function hashPassword(password: string): string {
    return password.split("").reverse().join("");
}

function internalHelper(): void {
    // not exported, but still a definition
}
`,
    "src/database.ts": `
import { AuthConfig } from "./auth.js";

export interface QueryResult {
    rows: unknown[];
    count: number;
}

export class Database {
    private config: AuthConfig;

    constructor(config: AuthConfig) {
        this.config = config;
    }

    async query(sql: string): Promise<QueryResult> {
        return { rows: [], count: 0 };
    }

    validateToken(token: string): boolean {
        return token.length > 0;
    }

    async revokeTokens(userId: string): Promise<void> {
        await this.query("DELETE FROM tokens WHERE user_id = '" + userId + "'");
    }
}

export async function connect(url: string): Promise<Database> {
    const config: AuthConfig = { secret: "test", expiresIn: 3600 };
    return new Database(config);
}
`,
    "src/utils.ts": `
export function formatDate(date: Date): string {
    return date.toISOString();
}

export function formatNumber(n: number): string {
    return n.toFixed(2);
}

export type DateFormat = "iso" | "unix" | "human";
`,
    "src/empty.ts": ``,
    "src/app.ts": `
import { AuthService, AuthConfig } from "./auth.js";
import { Database, connect } from "./database.js";
import { formatDate } from "./utils.js";

async function main(): Promise<void> {
    const db = await connect("localhost:5432");
    const config: AuthConfig = { secret: "s3cret", expiresIn: 7200 };
    const authService = new AuthService(db);
    console.log("Started at:", formatDate(new Date()));
}
`,
};

// ─── Setup & Teardown ───────────────────────────────────────────────

let parser: ASTParser;

beforeAll(async () => {
    for (const [relPath, content] of Object.entries(TEST_FILES)) {
        const fullPath = path.join(testDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }

    parser = new ASTParser();
    await parser.initialize();
});

afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

// ─── findDefinition Tests ───────────────────────────────────────────

describe("findDefinition", () => {
    it("should find a function by name", async () => {
        const results = await findDefinition(testDir, parser, "hashPassword");

        expect(results.length).toBe(1);
        expect(results[0].name).toBe("hashPassword");
        expect(results[0].kind).toBe("function");
        expect(results[0].filePath).toBe("src/auth.ts");
        expect(results[0].body).toContain("reverse");
        expect(results[0].exportedAs).toBe("named");
    });

    it("should find a class with its methods", async () => {
        const results = await findDefinition(testDir, parser, "AuthService");

        expect(results.length).toBe(1);
        expect(results[0].kind).toBe("class");
        expect(results[0].body).toContain("authenticate");
        expect(results[0].body).toContain("logout");
        expect(results[0].exportedAs).toBe("named");
    });

    it("should find an interface", async () => {
        const results = await findDefinition(testDir, parser, "AuthConfig");

        expect(results.length).toBe(1);
        expect(results[0].kind).toBe("interface");
        expect(results[0].body).toContain("secret");
        expect(results[0].body).toContain("expiresIn");
    });

    it("should find a type alias", async () => {
        const results = await findDefinition(testDir, parser, "DateFormat");

        expect(results.length).toBe(1);
        expect(results[0].kind).toBe("type");
        expect(results[0].filePath).toBe("src/utils.ts");
    });

    it("should filter by kind", async () => {
        // "connect" is a function; with kind="class" should find nothing
        const results = await findDefinition(testDir, parser, "connect", "class");
        expect(results.length).toBe(0);

        // With kind="function" should find it
        const funcResults = await findDefinition(testDir, parser, "connect", "function");
        expect(funcResults.length).toBe(1);
        expect(funcResults[0].kind).toBe("function");
    });

    it("should return empty array for unknown symbol", async () => {
        const results = await findDefinition(testDir, parser, "nonExistentSymbol");
        expect(results.length).toBe(0);
    });

    it("should find non-exported functions", async () => {
        const results = await findDefinition(testDir, parser, "internalHelper");

        expect(results.length).toBe(1);
        expect(results[0].exportedAs).toBeNull();
    });

    it("should find symbols across multiple files", async () => {
        // "Database" appears as a class in database.ts
        const results = await findDefinition(testDir, parser, "Database");

        expect(results.length).toBe(1);
        expect(results[0].filePath).toBe("src/database.ts");
        expect(results[0].kind).toBe("class");
    });

    it("should include signature without body", async () => {
        const results = await findDefinition(testDir, parser, "hashPassword");

        expect(results[0].signature).toContain("hashPassword");
        expect(results[0].signature).toContain("password: string");
        // Signature should not contain the body
        expect(results[0].signature).not.toContain("reverse");
    });
});

// ─── findReferences Tests ───────────────────────────────────────────

describe("findReferences", () => {
    it("should find references across multiple files", async () => {
        const results = await findReferences(testDir, parser, "AuthConfig");

        // AuthConfig is defined in auth.ts, imported in database.ts and app.ts, used in database.ts
        expect(results.length).toBeGreaterThanOrEqual(3);

        const files = new Set(results.map(r => r.filePath));
        expect(files.size).toBeGreaterThanOrEqual(2);
    });

    it("should include context lines around each reference", async () => {
        const results = await findReferences(testDir, parser, "formatDate");

        expect(results.length).toBeGreaterThanOrEqual(1);
        for (const ref of results) {
            expect(ref.context.length).toBeGreaterThan(0);
            expect(ref.context).toContain("formatDate");
        }
    });

    it("should return empty array for unknown symbol", async () => {
        const results = await findReferences(testDir, parser, "zzz_not_found_zzz");
        expect(results.length).toBe(0);
    });

    it("should report correct line numbers", async () => {
        const results = await findReferences(testDir, parser, "hashPassword");

        expect(results.length).toBeGreaterThanOrEqual(1);
        for (const ref of results) {
            expect(ref.line).toBeGreaterThan(0);
            expect(ref.column).toBeGreaterThan(0);
        }
    });
});

// ─── getFileSymbols Tests ───────────────────────────────────────────

describe("getFileSymbols", () => {
    it("should list all symbols in a file", async () => {
        const filePath = path.join(testDir, "src/auth.ts");
        const symbols = await getFileSymbols(filePath, parser, testDir);

        expect(symbols.length).toBeGreaterThan(0);

        const names = symbols.map(s => s.name);
        expect(names).toContain("AuthConfig");
        expect(names).toContain("AuthService");
        expect(names).toContain("hashPassword");
        expect(names).toContain("internalHelper");
    });

    it("should return empty for empty files", async () => {
        const filePath = path.join(testDir, "src/empty.ts");
        const symbols = await getFileSymbols(filePath, parser, testDir);
        expect(symbols.length).toBe(0);
    });

    it("should include kind and signature for each symbol", async () => {
        const filePath = path.join(testDir, "src/utils.ts");
        const symbols = await getFileSymbols(filePath, parser, testDir);

        for (const sym of symbols) {
            expect(sym.kind).toBeTruthy();
            expect(sym.signature).toBeTruthy();
            expect(sym.startLine).toBeGreaterThan(0);
            expect(sym.endLine).toBeGreaterThanOrEqual(sym.startLine);
        }
    });

    it("should include export status", async () => {
        const filePath = path.join(testDir, "src/utils.ts");
        const symbols = await getFileSymbols(filePath, parser, testDir);

        // All symbols in utils.ts are exported
        for (const sym of symbols) {
            expect(sym.exportedAs).toBe("named");
        }
    });

    it("should return empty for unsupported file type", async () => {
        const mdPath = path.join(testDir, "README.md");
        fs.writeFileSync(mdPath, "# Hello");
        const symbols = await getFileSymbols(mdPath, parser, testDir);
        expect(symbols.length).toBe(0);
        fs.unlinkSync(mdPath);
    });
});

// ─── Performance ────────────────────────────────────────────────────

describe("Performance", () => {
    it("should find a symbol in many files within 1000ms", async () => {
        // Create 100 small files
        const perfDir = path.join(testDir, "perf");
        fs.mkdirSync(perfDir, { recursive: true });
        for (let i = 0; i < 100; i++) {
            fs.writeFileSync(
                path.join(perfDir, `mod${i}.ts`),
                `export function handler${i}(x: number): number { return x * ${i}; }\n`
            );
        }

        const start = performance.now();
        const results = await findDefinition(testDir, parser, "handler50");
        const elapsed = performance.now() - start;

        expect(results.length).toBe(1);
        expect(results[0].name).toBe("handler50");
        expect(elapsed).toBeLessThan(1000);

        // Cleanup
        fs.rmSync(perfDir, { recursive: true, force: true });
    });
});
