import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB } from "../src/database.js";

describe("Type Ledger end-to-end (sub-sprint 2.3)", () => {
    let tmpDir: string;
    let dbPath: string;
    let srcDir: string;
    let engine: NrekiEngine;
    let shutDown: boolean;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-tl-"));
        srcDir = path.join(tmpDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        dbPath = path.join(tmpDir, ".nreki.db");
        engine = new NrekiEngine({
            dbPath,
            watchPaths: [srcDir],
            enableEmbeddings: false,
        });
        await engine.initialize();
        shutDown = false;
    });

    afterEach(() => {
        if (!shutDown) {
            try { engine.shutdown(); } catch { /* ignore */ }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function reopenDb(): Promise<NrekiDB> {
        engine.shutdown();
        shutDown = true;
        const db = new NrekiDB(dbPath);
        await db.initialize();
        return db;
    }

    it("(a) func consumes/produces are persisted into symbol_io", async () => {
        const file = path.join(srcDir, "orders.ts");
        fs.writeFileSync(file, [
            "export interface Order { id: string }",
            "export interface Invoice { total: number }",
            "type Result<T> = { success: boolean; data: T };",
            "export function processOrder(order: Order): Result<Invoice> {",
            "    return { success: true, data: { total: 0 } };",
            "}",
        ].join("\n"));

        await engine.indexFile(file);
        const db = await reopenDb();

        try {
            const consumed = db.getChunksByConsumedType("Order");
            const produced = db.getChunksByProducedType("Invoice");
            expect(consumed.length).toBeGreaterThan(0);
            expect(produced.length).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it("(b) re-indexing file A leaves file B's symbol_io intact", async () => {
        const fileA = path.join(srcDir, "a.ts");
        const fileB = path.join(srcDir, "b.ts");
        fs.writeFileSync(fileA, [
            "export interface TypeA { v: string }",
            "export function fA(x: TypeA): void { return; }",
        ].join("\n"));
        fs.writeFileSync(fileB, [
            "export interface TypeB { v: number }",
            "export function gB(x: TypeB): void { return; }",
        ].join("\n"));

        await engine.indexFile(fileA);
        await engine.indexFile(fileB);

        fs.writeFileSync(fileA, [
            "export interface TypeA { v: string }",
            "export function fA(x: TypeA): void { /* changed */ return; }",
        ].join("\n"));
        await engine.indexFile(fileA);

        const db = await reopenDb();
        try {
            expect(db.getChunksByConsumedType("TypeB").length).toBeGreaterThan(0);
            expect(db.getChunksByConsumedType("TypeA").length).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });

    it("(c) class-only file does not pollute symbol_io", async () => {
        const file = path.join(srcDir, "container.ts");
        fs.writeFileSync(file, [
            "export class Foo {",
            "    public x = 1;",
            "    public y = 'hello';",
            "}",
        ].join("\n"));

        await engine.indexFile(file);
        const db = await reopenDb();

        try {
            expect(db.getChunksByConsumedType("Foo")).toEqual([]);
            expect(db.getChunksByConsumedType("number")).toEqual([]);
            expect(db.getChunksByConsumedType("string")).toEqual([]);
            expect(db.getChunksByProducedType("Foo")).toEqual([]);
        } finally {
            db.close();
        }
    });
});
