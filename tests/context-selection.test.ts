/**
 * Which code `context` picks for a task.
 *
 * In the third Codex holdout (12.1.0) two of three NREKI sessions got 0 of the 3
 * files to fix, then read 5 and 7 files:
 *   - the task's "Station settings …" matched a `Station` type, a capitalized
 *     word counted as a code name, and one code name cancelled the search of
 *     every issue;
 *   - the issues were one sentence each in a paragraph, and the split at a `;`
 *     inside the third cut the task in two;
 *   - `path:"src"` was ignored, and a plain word ("settings") matched a method
 *     of the verifier at the project root.
 * A different project here (a clinic), not that fixture.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { NrekiEngine } from "../src/engine.js";
import { handleContext, extractTaskIdentifiers, splitTaskIssues, expandSpanishContextQuery } from "../src/handlers/context-pack.js";
import type { RouterDependencies } from "../src/router.js";

const require = createRequire(import.meta.url);
const { get_encoding } = require("tiktoken") as typeof import("tiktoken");
const enc = get_encoding("o200k_base");
const tok = (s: string): number => enc.encode(s).length;
const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");

const FILES: Record<string, string> = {
    "package.json": "{\"type\":\"module\"}\n",
    // The decoy: a class whose name opens a sentence of the task.
    "src/patients/patient.ts": "export class Patient {\n    constructor(readonly id: string, readonly name: string) {}\n\n    label(): string {\n        return `${this.name} (${this.id})`;\n    }\n}\n",
    "src/billing/visits.ts": "export interface Visit {\n    patientId: string;\n    feeCents: number;\n}\n\n/** Total a patient owes for their visits, in cents. */\nexport function totalOwed(visits: Visit[]): number {\n    return visits.length > 0 ? visits[0].feeCents : 0;\n}\n",
    "src/schedule/booking.ts": "export interface Booking {\n    startMin: number;\n    endMin: number;\n    cancelled: boolean;\n}\n",
    "src/schedule/slots.ts": "import type { Booking } from \"./booking.js\";\n\n/** Two appointments clash when their times overlap; a new one may start when the previous one ends. */\nexport function overlaps(a: Booking, b: Booking): boolean {\n    return a.startMin <= b.endMin && b.startMin <= a.endMin;\n}\n",
    "src/schedule/calendar.ts": "import type { Booking } from \"./booking.js\";\nimport { overlaps } from \"./slots.js\";\n\nexport class DayCalendar {\n    constructor(private readonly bookings: Booking[]) {}\n\n    isFree(slot: Booking): boolean {\n        return !this.bookings.some(b => overlaps(b, slot));\n    }\n}\n",
    "src/reminders/outbox.ts": "import type { Booking } from \"../schedule/booking.js\";\n\n/** Reminder messages queued for tomorrow's appointments. */\nexport function remindersFor(bookings: Booking[]): string[] {\n    return bookings.map(b => `reminder at ${b.startMin}`);\n}\n",
    "src/reports/summary.ts": "/** The headline of the daily report. */\nexport function dailyHeadline(count: number): string {\n    return `${count} appointments today`;\n}\n",
    "src/billing/rounding.ts": "export function invoiceRounding(amount: number): number {\n    return Math.floor(amount * 100) / 100;\n}\n",
    // A verifier outside src with a function named like a plain word of the task.
    "verify.mjs": "export function reminders() {\n    return [\"queued\", \"cancelled\"];\n}\n",
};

// One sentence per issue in a paragraph; a `;` inside the second; an instruction last.
const PROSE_TASK =
    "Fix the clinic service in src. Bills for a patient with several visits charge only the first visit and must charge every visit. " +
    "Patient appointments that end at 10:00 block a new one starting at 10:00; the end of an appointment must be exclusive. " +
    "Reminders are queued for cancelled appointments and must skip them. " +
    "Do not read verify.mjs, fixtures or external evaluation files.";

describe("context: which code it picks", () => {
    let dir: string;
    let engine: NrekiEngine;
    let deps: RouterDependencies;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-clinic-"));
        for (const [rel, content] of Object.entries(FILES)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        await engine.initialize();
        await engine.indexDirectory(dir);
        deps = { engine } as unknown as RouterDependencies;
    });
    afterAll(() => {
        engine.shutdown();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });

    it("a paragraph is split at its sentences, not at a `;` inside one; instructions are not issues", () => {
        expect(splitTaskIssues(PROSE_TASK)).toEqual([
            "Bills for a patient with several visits charge only the first visit and must charge every visit.",
            "Patient appointments that end at 10:00 block a new one starting at 10:00; the end of an appointment must be exclusive.",
            "Reminders are queued for cancelled appointments and must skip them.",
        ]);
        // A Spanish negative imperative is an instruction; "No se puede …" describes a bug.
        expect(splitTaskIssues(
            "No se puede reservar un muelle justo cuando termina otra reserva anterior del mismo muelle. " +
            "Los recordatorios salen para citas canceladas del calendario de mañana. " +
            "No leas el verificador ni sus pruebas externas de evaluación.",
        )).toEqual([
            "No se puede reservar un muelle justo cuando termina otra reserva anterior del mismo muelle.",
            "Los recordatorios salen para citas canceladas del calendario de mañana.",
        ]);
    });

    it("a capitalized word is looked up but is not a code name; backticks, camelCase and Class.method are", () => {
        const ids = extractTaskIdentifiers("Patient bills: fix `Visit` and DayCalendar.isFree, then Station.load() and Reminders");
        expect(ids.capitalized).toEqual(expect.arrayContaining(["Patient", "Reminders"]));
        for (const named of ["Visit", "DayCalendar", "isFree", "Station", "load"]) {
            expect(ids.strong).toContain(named);
            expect(ids.capitalized).not.toContain(named);
        }
    });

    it("expands Spanish domain words without changing English queries or exact code references", () => {
        expect(expandSpanishContextQuery("Redondeo de facturación y facturas"))
            .toBe("Redondeo de facturación y facturas rounding invoice billing");
        for (const query of ["Fix invoice rounding", "Fix `facturas` in src/facturas.ts", "Fix factura_id and invoiceFacturas"]) {
            expect(expandSpanishContextQuery(query)).toBe(query);
        }
        const long = "facturas importes precios descuentos impuestos pagos saldos envios pedidos clientes inventario citas calendario recordatorios";
        expect(expandSpanishContextQuery(long).slice(long.length).trim().split(" ")).toHaveLength(16);
        // English prose with words like "error", "terminal", "resume" must stay untouched
        expect(expandSpanishContextQuery("Resume terminal session on compiler error")).toBe("Resume terminal session on compiler error");
    });

    it("finds English-only invoice rounding from Spanish using local BM25", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        try {
            const query = "Corrige el redondeo de facturas";
            expect(await engine.search(query)).toEqual([]);
            const text = textOf(await handleContext({ action: "context", query, path: "src/billing" }, deps));
            expect(text).toContain("export function invoiceRounding(amount: number): number {");
            expect(text).not.toContain("remindersFor");
        } finally { vi.unstubAllEnvs(); }
    });

    it("keeps the original Spanish query when Voyage is enabled", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "voyage");
        vi.stubEnv("NREKI_VOYAGE_API_KEY", "test-key");
        const search = vi.spyOn(engine, "search").mockResolvedValue([]);
        try {
            const query = "Corrige el redondeo de facturas";
            await handleContext({ action: "context", query }, deps);
            expect(search).toHaveBeenCalledExactlyOnceWith(query, 6);
        } finally { search.mockRestore(); vi.unstubAllEnvs(); }
    });

    it("recalls all three independent Spanish issues in English-only code", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        try {
            const query = [
                "1. El redondeo de facturas devuelve importes incorrectos.",
                "2. Las citas permiten una superposición del calendario.",
                "3. Los recordatorios incluyen citas canceladas del calendario.",
            ].join("\n");
            const text = textOf(await handleContext({ action: "context", query, path: "src" }, deps));
            expect(text).toContain("each of its 3 issues searched");
            for (const symbol of ["invoiceRounding", "overlaps", "remindersFor"]) {
                expect(text).toContain(`export function ${symbol}(`);
            }
        } finally { vi.unstubAllEnvs(); }
    });

    it("a class named at the start of a sentence does not cancel the search of the issues", async () => {
        const r = await handleContext({ action: "context", query: PROSE_TASK, path: "src" }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        expect(text.split("\n")[0]).toContain("each of its 3 issues searched");
        // All three files to fix, in one call.
        expect(text).toContain("export function totalOwed(visits: Visit[]): number {");
        expect(text).toContain("export function overlaps(a: Booking, b: Booking): boolean {");
        expect(text).toContain("export function remindersFor(bookings: Booking[]): string[] {");
        // path:"src" is a scope: the verifier's reminders() at the root is not shown.
        expect(text).not.toContain("// verify.mjs");
        expect(text).not.toContain("\"queued\", \"cancelled\"");
        expect(tok(text)).toBeLessThan(1500);
    });

    it("an issue that names its code gets that code; the issues that do not are still searched", async () => {
        const mixed = [
            "1. `totalOwed` charges only the first visit; it must add every visit.",
            "2. Appointments that end at 10:00 block one starting at 10:00; the end must be exclusive.",
            "3. Reminders are queued for cancelled appointments and must skip them.",
        ].join("\n");
        const text = textOf(await handleContext({ action: "context", query: mixed }, deps));
        expect(text.split("\n")[0]).toContain("the symbols the task names, plus best search hits for the 2 of its 3 issues that name no code");
        expect(text).toContain("export function totalOwed(visits: Visit[]): number {");
        expect(text).toContain("export function overlaps(a: Booking, b: Booking): boolean {");
        expect(text).toContain("export function remindersFor(bookings: Booking[]): string[] {");
    });

    it("a task whose every issue names its code gets exactly that code, without search", async () => {
        const named = "1. `totalOwed` must add every visit.\n2. DayCalendar.isFree must treat the end of a booking as exclusive.";
        const text = textOf(await handleContext({ action: "context", query: named }, deps));
        expect(text.split("\n")[0]).toMatch(/^context: \d+ symbol\(s\) the task names — current and complete code/);
        expect(text).toContain("export function totalOwed(visits: Visit[]): number {");
        expect(text).toContain("isFree(slot: Booking): boolean {");
        expect(text).not.toContain("remindersFor");
        expect(text).not.toContain("dailyHeadline");
    });

    it("an issue with no code in the scope is reported, and an unknown path says it was not used", async () => {
        const task = "1. The daily headline count of the report is wrong.\n2. Bills for a patient charge only the first visit of several visits.";
        const scoped = textOf(await handleContext({ action: "context", query: task, path: "src/reports" }, deps));
        expect(scoped).toContain("export function dailyHeadline(count: number): string {");
        expect(scoped).toContain("no code found for: \"Bills for a patient charge only the first visit of several visits.\"");
        expect(scoped).not.toContain("totalOwed");

        const unknown = textOf(await handleContext({ action: "context", query: task, path: "no/such/dir" }, deps));
        expect(unknown).toContain("path \"no/such/dir\" not found: the whole project was used");
        expect(unknown).toContain("export function totalOwed(visits: Visit[]): number {");
    });
});
