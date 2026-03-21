/**
 * Tests for TypeFlags-based toxicity scoring (Bug 3 fix).
 *
 * Validates asymmetric weights (any=10, unknown=2, Function=5)
 * and verifies that property names like { any: boolean } don't
 * trigger false positives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;
let kernel: NrekiKernel;

function writeFile(name: string, content: string) {
    fs.writeFileSync(path.join(tmpDir, name), content, "utf-8");
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ttrd-flags-"));

    // Minimal tsconfig
    writeFile("tsconfig.json", JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            strict: true,
            outDir: "dist",
            declaration: true,
        },
        include: ["*.ts"],
    }));

    // Base module with typed exports
    writeFile("api.ts", [
        `export function getUser(): { name: string; age: number } {`,
        `    return { name: "Alice", age: 30 };`,
        `}`,
        `export type Config = { host: string; port: number };`,
        `export const handler = (config: Config): string => config.host;`,
        `export interface Options { any: boolean; timeout: number; }`,
    ].join("\n"));

    kernel = new NrekiKernel();
    kernel.boot(tmpDir);
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TTRD TypeFlags scoring", () => {
    it("should detect unknown -> any regression (asymmetric weights)", async () => {
        // First: change return type to unknown (tox=2)
        const r1 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: [
                `export function getUser(): unknown {`,
                `    return { name: "Alice", age: 30 };`,
                `}`,
                `export type Config = { host: string; port: number };`,
                `export const handler = (config: Config): string => config.host;`,
                `export interface Options { any: boolean; timeout: number; }`,
            ].join("\n"),
        }]);
        expect(r1.safe).toBe(true);
        await kernel.commitToDisk();

        // Now: change from unknown to any (tox=10) - this IS a regression
        const r2 = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: [
                `export function getUser(): any {`,
                `    return { name: "Alice", age: 30 };`,
                `}`,
                `export type Config = { host: string; port: number };`,
                `export const handler = (config: Config): string => config.host;`,
                `export interface Options { any: boolean; timeout: number; }`,
            ].join("\n"),
        }]);
        expect(r2.safe).toBe(true);
        expect(r2.regressions).toBeDefined();
        expect(r2.regressions!.length).toBeGreaterThan(0);
        expect(r2.regressions![0].symbol).toBe("getUser");

        await kernel.rollbackAll();
    });

    it("should NOT flag property named 'any' as toxic regression", async () => {
        // Restore baseline with Options interface that has property named "any"
        writeFile("api.ts", [
            `export function getUser(): { name: string; age: number } {`,
            `    return { name: "Alice", age: 30 };`,
            `}`,
            `export type Config = { host: string; port: number };`,
            `export const handler = (config: Config): string => config.host;`,
            `export interface Options { any: boolean; timeout: number; }`,
        ].join("\n"));
        await kernel.rollbackAll();

        // Change Options to add a new field - the property "any" should not cause regression
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: [
                `export function getUser(): { name: string; age: number } {`,
                `    return { name: "Alice", age: 30 };`,
                `}`,
                `export type Config = { host: string; port: number };`,
                `export const handler = (config: Config): string => config.host;`,
                `export interface Options { any: boolean; timeout: number; verbose: boolean; }`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        // No regressions - the property "any" is NOT a type regression
        expect(result.regressions ?? []).toEqual([]);
        await kernel.rollbackAll();
    });

    it("should detect number -> any as high-delta regression", async () => {
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: [
                `export function getUser(): any {`,
                `    return { name: "Alice", age: 30 };`,
                `}`,
                `export type Config = { host: string; port: number };`,
                `export const handler = (config: Config): string => config.host;`,
                `export interface Options { any: boolean; timeout: number; }`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.some(r => r.symbol === "getUser")).toBe(true);
        await kernel.rollbackAll();
    });

    it("should detect structural collapse: typed export -> bare any", async () => {
        // Set up a typed export (type alias, not function)
        writeFile("api.ts", [
            `export function getUser(): { name: string; age: number } {`,
            `    return { name: "Alice", age: 30 };`,
            `}`,
            `export type Config = { host: string; port: number };`,
            `export type Result = Promise<string>;`,
            `export const handler = (config: Config): string => config.host;`,
            `export interface Options { any: boolean; timeout: number; }`,
        ].join("\n"));
        await kernel.rollbackAll();

        // Collapse: Promise<string> -> any (typed wrapper destroyed, bare untyped)
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "api.ts",
            proposedContent: [
                `export function getUser(): { name: string; age: number } {`,
                `    return { name: "Alice", age: 30 };`,
                `}`,
                `export type Config = { host: string; port: number };`,
                `export type Result = any;`,
                `export const handler = (config: Config): string => config.host;`,
                `export interface Options { any: boolean; timeout: number; }`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        // Structural collapse: typed wrapper destroyed, result is bare any
        expect(result.regressions).toBeDefined();
        expect(result.regressions!.some(r => r.symbol === "Result")).toBe(true);
        await kernel.rollbackAll();
    });
});
