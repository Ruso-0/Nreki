/**
 * ast-sandbox.test.ts - Tests for AST sandbox validator.
 *
 * Covers:
 * - Valid code in multiple languages (TS, JS, Python)
 * - Syntax error detection: unclosed braces, missing commas, invalid syntax
 * - Error reporting: line numbers, columns, context, suggestions
 * - Edge cases: empty string, multiple errors, large files
 * - Diff validation: original vs new code comparison
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AstSandbox } from "../src/ast-sandbox.js";

// ─── Setup ───────────────────────────────────────────────────────────

let sandbox: AstSandbox;

beforeAll(async () => {
    sandbox = new AstSandbox();
    await sandbox.initialize();
});

// ─── Valid Code ──────────────────────────────────────────────────────

describe("Valid code", () => {
    it("should accept valid TypeScript", async () => {
        const code = `
export interface Config {
    host: string;
    port: number;
}

export class Server {
    private config: Config;

    constructor(config: Config) {
        this.config = config;
    }

    start(): void {
        console.log("listening on", this.config.port);
    }
}

export function createServer(host: string, port: number): Server {
    return new Server({ host, port });
}
`;
        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.suggestion).toBe("");
    });

    it("should accept valid JavaScript", async () => {
        const code = `
function fibonacci(n) {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

class Calculator {
    add(a, b) { return a + b; }
    multiply(a, b) { return a * b; }
}

module.exports = { fibonacci, Calculator };
`;
        const result = await sandbox.validateCode(code, "javascript");

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should accept valid Python", async () => {
        const code = `
class DataProcessor:
    def __init__(self, data):
        self.data = data

    def process(self):
        return [x * 2 for x in self.data]

def main():
    processor = DataProcessor([1, 2, 3])
    result = processor.process()
    print(result)
`;
        const result = await sandbox.validateCode(code, "python");

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should accept empty string as valid", async () => {
        const result = await sandbox.validateCode("", "typescript");

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
});

// ─── Syntax Errors ───────────────────────────────────────────────────

describe("Syntax error detection", () => {
    it("should detect unclosed brace", async () => {
        const code = `
function broken() {
    const x = 1;
    if (x > 0) {
        console.log(x);
    // missing closing brace for if
// missing closing brace for function
`;
        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.suggestion).toBeTruthy();
    });

    it("should detect missing comma in object literal", async () => {
        const code = `
const config = {
    host: "localhost"
    port: 3000
    debug: true
};
`;
        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);

        // Should have error context pointing to the broken lines
        const hasContext = result.errors.some(
            (e) => e.context.includes("port") || e.context.includes("debug")
        );
        expect(hasContext).toBe(true);
    });

    it("should detect invalid syntax with line and column", async () => {
        const code = `const = ;`;

        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);

        const error = result.errors[0];
        expect(error.line).toBeGreaterThan(0);
        expect(error.column).toBeGreaterThan(0);
        expect(error.context).toContain("const");
    });

    it("should report multiple errors", async () => {
        const code = `
function a() {
    const x = ;
}

function b() {
    const y = ;
}
`;
        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(false);
        // Should detect errors in both functions
        expect(result.errors.length).toBeGreaterThanOrEqual(2);

        // Suggestion should cover multiple errors
        const lines = result.suggestion.split("\n");
        expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("should show context line in errors", async () => {
        const code = `
function hello(): string {
    return "world"
}

const broken = {
    a: 1
    b: 2
};
`;
        const result = await sandbox.validateCode(code, "typescript");

        expect(result.valid).toBe(false);
        // The error context should contain actual source code
        for (const error of result.errors) {
            expect(error.context.length).toBeGreaterThan(0);
        }

        // The suggestion should be human-readable
        expect(result.suggestion).toContain("Syntax error at line");
    });
});

// ─── Diff Validation ─────────────────────────────────────────────────

describe("Diff validation", () => {
    it("should show what changed when new code has errors", async () => {
        const original = `
function greet(name: string): string {
    return "Hello, " + name;
}
`;
        const broken = `
function greet(name: string): string {
    return "Hello, " + name
}

const config = {
    a: 1
    b: 2
};
`;
        const result = await sandbox.validateDiff(original, broken, "typescript");

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);

        // Diff context should show Was/Now for changed lines
        const hasDiffContext = result.errors.some(
            (e) => e.context.includes("Was:") || e.context.includes("Now:")
        );
        expect(hasDiffContext).toBe(true);
    });

    it("should pass when new code is valid", async () => {
        const original = `const x = 1;`;
        const fixed = `const x = 2;\nconst y = 3;`;

        const result = await sandbox.validateDiff(original, fixed, "typescript");

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
});

// ─── Edge Cases ──────────────────────────────────────────────────────

describe("Edge cases", () => {
    it("should reject unsupported language", async () => {
        const result = await sandbox.validateCode("fn main() {}", "rust" as any);

        expect(result.valid).toBe(false);
        expect(result.errors[0].nodeType).toBe("UNSUPPORTED");
        expect(result.suggestion).toContain("not supported");
    });

    it("should detect language from file path", () => {
        expect(sandbox.detectLanguage("src/app.ts")).toBe("typescript");
        expect(sandbox.detectLanguage("main.py")).toBe("python");
        expect(sandbox.detectLanguage("utils.js")).toBe("javascript");
        expect(sandbox.detectLanguage("server.go")).toBe("go");
        expect(sandbox.detectLanguage("styles.css")).toBeNull();
    });
});

// ─── Performance ─────────────────────────────────────────────────────

describe("Performance", () => {
    it("should validate a 1000-line file with 1 error in under 1000ms", async () => {
        // Generate 1000 lines of valid TypeScript
        const lines: string[] = [];
        for (let i = 0; i < 999; i++) {
            lines.push(
                `export function handler${i}(x: number): number { return x * ${i}; }`
            );
        }
        // Insert one broken line near the end
        lines.push(`const broken = { a: 1 b: 2 };`);

        const code = lines.join("\n");

        const start = performance.now();
        const result = await sandbox.validateCode(code, "typescript");
        const elapsed = performance.now() - start;

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);

        // The error should be near line 1000
        const errorLine = result.errors[0].line;
        expect(errorLine).toBeGreaterThanOrEqual(990);

        expect(elapsed).toBeLessThan(1000);
    });
});
