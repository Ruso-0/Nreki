import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Parser from "web-tree-sitter";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import {
    classifyAndGenerateShadow,
    scanProject,
    type ClassifyResult,
} from "../src/hologram/shadow-generator.js";
import { ParserPool } from "../src/parser-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(__dirname, "..", "wasm");

let tsLanguage: Parser.Language;
let parser: Parser;

beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    tsLanguage = await Parser.Language.load(
        path.join(wasmDir, "tree-sitter-typescript.wasm"),
    );
});

function classify(content: string): ClassifyResult {
    return classifyAndGenerateShadow("test.ts", content, parser, tsLanguage);
}

// ─── 1. const with number literal -> prunable, literal type ──────────

describe("shadow generator classification", () => {
    it("1. const with number literal -> prunable, shadow has literal type", () => {
        const result = classify(`export const PORT = 3000;`);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("3000");
        expect(result.category).toBe("explicit");
    });

    it("2. const with string literal -> prunable, shadow has literal type", () => {
        const result = classify(`export const NAME = "hello";`);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain('"hello"');
    });

    it("3. const with boolean -> prunable, literal type", () => {
        const result = classify(`export const DEBUG = true;`);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("true");
    });

    it("4. let with number -> prunable, widened type", () => {
        const result = classify(`export let count = 3000;`);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("number");
        // Should NOT contain the literal 3000 (widened to number)
        expect(result.shadow).not.toContain("3000");
    });

    it("5. const with object literal -> unprunable", () => {
        const result = classify(`export const config = { port: 3000, host: "localhost" };`);
        expect(result.prunable).toBe(false);
        expect(result.category).toBe("inferred");
    });

    it("6. const with array -> unprunable", () => {
        const result = classify(`export const items = [1, 2, 3];`);
        expect(result.prunable).toBe(false);
    });

    it("7. const with function call -> unprunable", () => {
        const result = classify(`export const result = createClient();`);
        expect(result.prunable).toBe(false);
    });

    it("8. const with new expression -> unprunable", () => {
        const result = classify(`export const db = new Database();`);
        expect(result.prunable).toBe(false);
    });

    it("9. function with return type -> prunable, signature only", () => {
        const result = classify(
            `export function greet(name: string): string {\n  return "Hello " + name;\n}`,
        );
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("greet");
        expect(result.shadow).toContain("string");
        // Body should be stripped
        expect(result.shadow).not.toContain("Hello");
    });

    it("10. function without return type -> unprunable", () => {
        const result = classify(
            `export function greet(name: string) {\n  return "Hello " + name;\n}`,
        );
        expect(result.prunable).toBe(false);
        expect(result.reasons.some(r => r.includes("without return type"))).toBe(true);
    });

    it("11. overloaded function -> excludes implementation signature", () => {
        const code = [
            `export function parse(input: string): number;`,
            `export function parse(input: number): string;`,
            `export function parse(input: string | number): string | number {`,
            `  return typeof input === "string" ? parseInt(input) : String(input);`,
            `}`,
        ].join("\n");
        const result = classify(code);
        expect(result.prunable).toBe(true);
        // Shadow should contain overload signatures
        expect(result.shadow).toContain("parse(input: string): number");
        expect(result.shadow).toContain("parse(input: number): string");
        // Shadow must NOT contain the implementation signature
        expect(result.shadow).not.toContain("string | number): string | number");
        expect(result.shadow).not.toContain("parseInt");
    });

    it("11b. overloaded function with get() name pattern", () => {
        const code = [
            `export function get(id: string): string;`,
            `export function get(id: number): number;`,
            `export function get(id: any): any {`,
            `  return id;`,
            `}`,
        ].join("\n");
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("get(id: string): string");
        expect(result.shadow).toContain("get(id: number): number");
        // Implementation signature invisible in .d.ts
        expect(result.shadow).not.toContain("get(id: any): any");
        expect(result.shadow).not.toContain("return id");
    });

    it("12. class with private members -> shadow preserves private declarations", () => {
        const code = [
            `export class Service {`,
            `  private db: Database;`,
            `  public name: string;`,
            `  constructor(db: Database) {`,
            `    this.db = db;`,
            `    this.name = "svc";`,
            `  }`,
            `  private helper(): void {`,
            `    console.log("help");`,
            `  }`,
            `  public run(): boolean {`,
            `    this.helper();`,
            `    return true;`,
            `  }`,
            `}`,
        ].join("\n");
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("private db");
        expect(result.shadow).toContain("public name");
        expect(result.shadow).toContain("constructor");
        // Method bodies should be stripped
        expect(result.shadow).not.toContain("console.log");
        expect(result.shadow).not.toContain("this.helper()");
    });

    it("13. interface -> always prunable, verbatim", () => {
        const code = `export interface Config {\n  host: string;\n  port: number;\n}`;
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("interface Config");
        expect(result.shadow).toContain("host: string");
    });

    it("14. type alias -> always prunable, verbatim", () => {
        const code = `export type Status = "active" | "inactive" | "pending";`;
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("type Status");
    });

    it("15. enum -> always prunable, verbatim", () => {
        const code = `export enum Color {\n  Red,\n  Green,\n  Blue,\n}`;
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain("enum Color");
        expect(result.shadow).toContain("Red");
    });

    it("16. export * from -> prunable, verbatim", () => {
        const code = `export * from "./utils";`;
        const result = classify(code);
        expect(result.prunable).toBe(true);
        expect(result.shadow).toContain(`export * from "./utils"`);
    });

    it("17. declare global -> prunable, verbatim", () => {
        const code = [
            `declare global {`,
            `  interface Window {`,
            `    __APP_VERSION__: string;`,
            `  }`,
            `}`,
            `export {};`,
        ].join("\n");
        const result = classify(code);
        expect(result.prunable).toBe(true);
    });

    it("18. mixed file (some explicit, some inferred) -> unprunable", () => {
        const code = [
            `export interface Config { port: number; }`,
            `export function init(): void {}`,
            `export const result = createService();`,
        ].join("\n");
        const result = classify(code);
        expect(result.prunable).toBe(false);
        expect(result.category).toBe("inferred");
        // Should have reasons for both prunable and unprunable
        expect(result.reasons.some(r => r.includes("PRUNABLE"))).toBe(true);
        expect(result.reasons.some(r => r.includes("UNPRUNABLE"))).toBe(true);
    });
});

// ─── scanProject integration ─────────────────────────────────────────

describe("scanProject", () => {
    let dir: string;

    afterAll(() => {
        if (dir) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    it("scans temp project with correct classification counts", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-hologram-"));

        // Create tsconfig.json
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "commonjs", strict: true },
            include: ["./**/*.ts"],
        }));

        // Prunable file: all exports have explicit types
        fs.writeFileSync(path.join(dir, "explicit.ts"), [
            `export interface Config { port: number; }`,
            `export function init(c: Config): void {}`,
            `export const VERSION = 42;`,
        ].join("\n"));

        // Unprunable file: function without return type
        fs.writeFileSync(path.join(dir, "inferred.ts"), [
            `export function compute(x: number) {`,
            `  return x * 2;`,
            `}`,
        ].join("\n"));

        // No exports file
        fs.writeFileSync(path.join(dir, "internal.ts"), `const x = 1;\n`);

        // Ambient file
        fs.writeFileSync(path.join(dir, "globals.ts"), [
            `declare global {`,
            `  interface Window { __version: string; }`,
            `}`,
            `export {};`,
        ].join("\n"));

        // node_modules should be ignored
        const nmDir = path.join(dir, "node_modules", "fake-pkg");
        fs.mkdirSync(nmDir, { recursive: true });
        fs.writeFileSync(path.join(nmDir, "index.ts"), `export const x = 1;`);

        const pool = new ParserPool(2);
        const result = await scanProject(dir, pool);

        expect(result.stats.total).toBe(4); // explicit, inferred, internal, globals
        expect(result.stats.pruned).toBeGreaterThanOrEqual(1); // at least explicit.ts
        expect(result.stats.unpruned).toBeGreaterThanOrEqual(1); // at least inferred.ts
        expect(result.unprunable.size).toBeGreaterThanOrEqual(1);
        expect(result.ambientFiles.length).toBeGreaterThanOrEqual(1);
    }, 30_000);
});
