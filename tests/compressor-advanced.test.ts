/**
 * compressor-advanced.test.ts - Tests for the AST compressor.
 *
 * Tests cover:
 * - Stage 1: Preprocessing (comments, console.log, whitespace)
 * - Stage 3: Structural compression (function body stripping)
 * - All three compression levels (light, medium, aggressive)
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import {
    AdvancedCompressor,
    preprocess,
    findNoiseRanges,
} from "../src/compressor.js";
import { ASTParser } from "../src/parser.js";

// ─── Test Fixtures ───────────────────────────────────────────────────

const SAMPLE_TS_CODE = `
import { Request, Response } from 'express';

/**
 * Handles user authentication.
 * This is a very important service.
 */
export class AuthService {
  private users: Map<string, string> = new Map();

  // Authenticate a user with username and password
  async authenticate(username: string, password: string): Promise<boolean> {
    console.log('Authenticating user:', username);
    const stored = this.users.get(username);
    if (!stored) return false;
    console.debug('Found stored password');
    return stored === password;
  }

  async register(username: string, password: string): Promise<void> {
    if (this.users.has(username)) {
      throw new Error('User already exists');
    }
    console.info('Registering new user:', username);
    this.users.set(username, password);
  }

  // Delete a user from the system
  async deleteUser(username: string): Promise<boolean> {
    debugger;
    console.log('Deleting user:', username);
    return this.users.delete(username);
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

const SAMPLE_PYTHON = `
# This module handles data processing
import os
import json
from typing import List, Dict, Optional

class DataProcessor:
    """
    A comprehensive data processor that handles various data formats.
    Supports JSON, CSV, and custom binary formats.
    """

    def __init__(self, config: Dict):
        self.config = config
        self.data = []
        print("DataProcessor initialized")

    def process(self, items: List[Dict]) -> List[Dict]:
        # Process each item in the list
        results = []
        for item in items:
            print(f"Processing item: {item}")
            result = self._transform(item)
            results.append(result)
        return results

    def _transform(self, item: Dict) -> Dict:
        """Transform a single data item."""
        return {k: str(v) for k, v in item.items()}
`;

// ─── Preprocessing Tests (Stage 1) ──────────────────────────────────
// v12.0.1: noise is located with tree-sitter (findNoiseRanges) and removed by
// preprocess(); preprocess() alone only normalizes whitespace.

let stage1Parser: ASTParser;
beforeAll(async () => {
    stage1Parser = new ASTParser();
    await stage1Parser.initialize();
});
async function clean(code: string, file: string): Promise<{ cleaned: string; removed: number }> {
    return preprocess(code, file, await findNoiseRanges(code, file, stage1Parser));
}

describe("Preprocessing (Stage 1)", () => {
    it("should strip single-line comments", async () => {
        const { cleaned } = await clean(
            "const x = 1; // this is a comment\nconst y = 2;",
            "test.ts"
        );
        expect(cleaned).not.toContain("// this is a comment");
        expect(cleaned).toContain("const x = 1;");
        expect(cleaned).toContain("const y = 2;");
    });

    it("should strip multi-line comments", async () => {
        const { cleaned } = await clean(
            "/* multi\nline\ncomment */\nconst x = 1;",
            "test.ts"
        );
        expect(cleaned).not.toContain("multi");
        expect(cleaned).not.toContain("comment");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should strip JSDoc comments", async () => {
        const { cleaned } = await clean(
            "/** @param {string} name */\nfunction greet(name) {}",
            "test.ts"
        );
        expect(cleaned).not.toContain("@param");
        expect(cleaned).toContain("function greet(name)");
    });

    it("should strip console.log statements", async () => {
        const { cleaned } = await clean(
            "console.log('hello');\nconst x = 1;\nconsole.error('fail');",
            "test.ts"
        );
        expect(cleaned).not.toContain("console.log");
        expect(cleaned).not.toContain("console.error");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should strip debugger statements", async () => {
        const { cleaned } = await clean(
            "debugger;\nconst x = 1;\ndebugger",
            "test.ts"
        );
        expect(cleaned).not.toContain("debugger");
        expect(cleaned).toContain("const x = 1;");
    });

    it("should collapse consecutive empty lines", async () => {
        const { cleaned } = await clean(
            "line1\n\n\n\n\nline2",
            "test.ts"
        );
        // Should have at most one blank line between
        expect(cleaned).not.toMatch(/\n{3,}/);
        expect(cleaned).toContain("line1");
        expect(cleaned).toContain("line2");
    });

    it("should strip Python comments and docstrings", async () => {
        const { cleaned } = await clean(SAMPLE_PYTHON, "script.py");
        expect(cleaned).not.toContain("# This module handles");
        expect(cleaned).not.toContain("# Process each item");
        expect(cleaned).not.toContain('"""');
        expect(cleaned).not.toContain("A comprehensive data processor");
        expect(cleaned).toContain("import os");
        expect(cleaned).toContain("class DataProcessor:");
    });

    it("should strip Python print statements", async () => {
        const { cleaned } = await clean(SAMPLE_PYTHON, "script.py");
        expect(cleaned).not.toContain('print("DataProcessor initialized")');
        expect(cleaned).not.toContain("print(f\"Processing item");
    });

    it("should report characters removed", async () => {
        const content = "/* big comment */\nconst x = 1;";
        const { removed } = await clean(content, "test.ts");
        expect(removed).toBeGreaterThan(0);
    });
});

// ─── Compression Level Tests ────────────────────────────────────────

describe("Compression Levels (static estimates)", () => {
    it("light should estimate ~50% reduction", async () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "light");
        expect(est.estimatedRatio).toBeCloseTo(0.50, 1);
        expect(est.estimatedTokensSaved).toBeGreaterThan(0);
    });

    it("medium should estimate ~75% reduction", async () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "medium");
        expect(est.estimatedRatio).toBeCloseTo(0.75, 1);
    });

    it("aggressive should estimate ~92% reduction", async () => {
        const est = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "aggressive");
        expect(est.estimatedRatio).toBeCloseTo(0.92, 1);
    });

    it("should have increasing savings: light < medium < aggressive", async () => {
        const light = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "light");
        const medium = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "medium");
        const aggressive = AdvancedCompressor.estimateSavings(SAMPLE_TS_CODE, "aggressive");
        expect(light.estimatedTokensSaved).toBeLessThan(medium.estimatedTokensSaved);
        expect(medium.estimatedTokensSaved).toBeLessThan(aggressive.estimatedTokensSaved);
    });
});

// ─── Preprocessing on Full Samples ──────────────────────────────────

describe("Full Sample Preprocessing", () => {
    it("should achieve significant reduction on commented TS code", async () => {
        const { cleaned, removed } = await clean(SAMPLE_TS_CODE, "auth.ts");
        // Should remove comments, console.log, debugger
        expect(cleaned).not.toContain("console.log");
        expect(cleaned).not.toContain("console.debug");
        expect(cleaned).not.toContain("console.info");
        expect(cleaned).not.toContain("debugger");
        expect(cleaned).not.toContain("Handles user authentication");
        expect(removed).toBeGreaterThan(100);
        // Should keep important code
        expect(cleaned).toContain("import");
        expect(cleaned).toContain("AuthService");
        expect(cleaned).toContain("authenticate");
    });

    it("should handle empty input gracefully", async () => {
        const { cleaned, removed } = await clean("", "empty.ts");
        expect(cleaned).toBe("");
        expect(removed).toBe(0);
    });

    it("should handle code with no comments", async () => {
        const code = "const x = 1;\nconst y = 2;\n";
        const { cleaned } = await clean(code, "clean.ts");
        expect(cleaned).toContain("const x = 1;");
        expect(cleaned).toContain("const y = 2;");
    });
});

// ─── Stub Bloat Guard Tests ─────────────────────────────────────────

describe("Stub Bloat Guard", () => {
    let compressor: AdvancedCompressor;

    beforeAll(async () => {
        const parser = new ASTParser();
        await parser.initialize();
        compressor = new AdvancedCompressor(parser);
    });

    it("aggressive always compresses more than medium", async () => {
        const code = fs.readFileSync(
            path.join(process.cwd(), "src/engine.ts"),
            "utf-8"
        );
        const light = await compressor.compress("engine.ts", code, "light");
        const medium = await compressor.compress("engine.ts", code, "medium");
        const aggressive = await compressor.compress("engine.ts", code, "aggressive");

        expect(light.compressedSize).toBeGreaterThan(medium.compressedSize);
        expect(medium.compressedSize).toBeGreaterThan(aggressive.compressedSize);
    });

    it("never produces negative compression on small functions", async () => {
        const small = `export const add = (a: number, b: number): number => a + b;

export function greet(name: string): string {
    return "Hello, " + name;
}
`;
        const result = await compressor.compress("small.ts", small, "aggressive");
        expect(result.compressedSize).toBeLessThanOrEqual(small.length);
    });
});
