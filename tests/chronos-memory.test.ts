import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ChronosMemory } from "../src/chronos-memory.js";

let tempDir: string;

function createTempDir(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-test-"));
    return tempDir;
}

afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

describe("NREKI Chronos Memory", () => {
    it("1. Constructor creates .nreki/chronos-history.json", () => {
        const dir = createTempDir();
        const _chronos = new ChronosMemory(dir);

        const dbPath = path.join(dir, ".nreki", "chronos-history.json");
        expect(fs.existsSync(dbPath)).toBe(true);

        const state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        expect(state.version).toBe(1);
        expect(state.currentSessionId).toBe(1);
    });

    it("2. recordTrip increases CFI by W_TRIP (10.0)", () => {
        const dir = createTempDir();
        // Create a dummy file so it doesn't get cleaned up
        fs.writeFileSync(path.join(dir, "fragile.ts"), "export const x = 1;");

        const chronos = new ChronosMemory(dir);
        chronos.recordTrip(path.join(dir, "fragile.ts"), "Doom loop detected on fragile.ts");
        chronos.forcePersist();

        const state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        const file = state.files["fragile.ts"];
        expect(file).toBeDefined();
        expect(file.trips).toBe(1);
        expect(file.cfiScore).toBe(10.0);
        expect(file.lastErrorPattern).toContain("Doom loop");
    });

    it("3. recordSemanticError increases CFI by W_ERROR (3.0)", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "broken.ts"), "export const y = 2;");

        const chronos = new ChronosMemory(dir);
        chronos.recordSemanticError(path.join(dir, "broken.ts"), "TS2345: Argument of type 'string' is not assignable");
        chronos.forcePersist();

        const state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        const file = state.files["broken.ts"];
        expect(file.semanticErrors).toBe(1);
        expect(file.cfiScore).toBe(3.0);
    });

    it("4. recordHeal increases CFI by W_HEAL (1.0)", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "healed.ts"), "export const z = 3;");

        const chronos = new ChronosMemory(dir);
        chronos.recordHeal(path.join(dir, "healed.ts"));
        chronos.forcePersist();

        const state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        const file = state.files["healed.ts"];
        expect(file.autoHeals).toBe(1);
        expect(file.cfiScore).toBe(1.0);
    });

    it("5. recordSuccess applies success discount (CFI *= 0.50)", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "toxic.ts"), "export const t = 1;");

        const chronos = new ChronosMemory(dir);
        // Push CFI to 20.0
        chronos.recordTrip(path.join(dir, "toxic.ts"), "loop1");
        chronos.recordTrip(path.join(dir, "toxic.ts"), "loop2");
        chronos.forcePersist();

        let state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        expect(state.files["toxic.ts"].cfiScore).toBe(20.0);

        // Successful edit halves CFI
        chronos.recordSuccess(path.join(dir, "toxic.ts"));
        chronos.forcePersist();

        state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        expect(state.files["toxic.ts"].cfiScore).toBe(10.0);
    });

    it("6. recordSuccess on clean file does not crash or create entry", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "clean.ts"), "export const c = 1;");

        const chronos = new ChronosMemory(dir);
        // Should not throw
        chronos.recordSuccess(path.join(dir, "clean.ts"));
        chronos.forcePersist();

        const state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        expect(state.files["clean.ts"]).toBeUndefined();
    });

    it("7. isHighFriction returns true when CFI >= 15.0, false when < 15.0", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "radio.ts"), "export const r = 1;");

        const chronos = new ChronosMemory(dir);

        // CFI = 3.0, not high-friction
        chronos.recordSemanticError(path.join(dir, "radio.ts"), "err1");
        expect(chronos.isHighFriction(path.join(dir, "radio.ts"))).toBe(false);

        // CFI = 3.0 + 10.0 = 13.0, still not high-friction
        chronos.recordTrip(path.join(dir, "radio.ts"), "trip1");
        expect(chronos.isHighFriction(path.join(dir, "radio.ts"))).toBe(false);

        // CFI = 13.0 + 3.0 = 16.0, now high-friction
        chronos.recordSemanticError(path.join(dir, "radio.ts"), "err2");
        expect(chronos.isHighFriction(path.join(dir, "radio.ts"))).toBe(true);
    });

    it("8. getContextWarnings returns warning when high-friction, empty when not", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "warn.ts"), "export const w = 1;");

        const chronos = new ChronosMemory(dir);

        // Not high-friction yet
        expect(chronos.getContextWarnings(path.join(dir, "warn.ts"))).toBe("");

        // Push above threshold (10 + 10 = 20)
        chronos.recordTrip(path.join(dir, "warn.ts"), "loop1");
        chronos.recordTrip(path.join(dir, "warn.ts"), "loop2");

        const warning = chronos.getContextWarnings(path.join(dir, "warn.ts"));
        expect(warning).toContain("NREKI CHRONOS");
        expect(warning).toContain("high error history");
        expect(warning).toContain("20.0");
    });

    it("9. Hard Block flow: high-friction + no uncompressed read = blocked, after mark = unblocked", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "locked.ts"), "export const l = 1;");

        const chronos = new ChronosMemory(dir);

        // Make high-friction (10 + 10 = 20)
        chronos.recordTrip(path.join(dir, "locked.ts"), "loop1");
        chronos.recordTrip(path.join(dir, "locked.ts"), "loop2");

        expect(chronos.isHighFriction(path.join(dir, "locked.ts"))).toBe(true);
        expect(chronos.hasReadUncompressed(path.join(dir, "locked.ts"))).toBe(false);

        // Mark as read uncompressed
        chronos.markReadUncompressed(path.join(dir, "locked.ts"));

        expect(chronos.hasReadUncompressed(path.join(dir, "locked.ts"))).toBe(true);
    });

    it("10. Passive decay: new session applies lambda^deltaS", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "decay.ts"), "export const d = 1;");

        const c1 = new ChronosMemory(dir);
        // CFI = 20.0
        c1.recordTrip(path.join(dir, "decay.ts"), "loop1");
        c1.recordTrip(path.join(dir, "decay.ts"), "loop2");
        c1.forcePersist();

        // Simulate 5 sessions passing by manipulating the state
        const dbPath = path.join(dir, ".nreki", "chronos-history.json");
        const state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        // Set lastSessionTouched to 5 sessions ago
        state.files["decay.ts"].lastSessionTouched = state.currentSessionId - 4;
        fs.writeFileSync(dbPath, JSON.stringify(state), "utf-8");

        // New session triggers decay: 20 * 0.85^5 ≈ 8.874
        const c2 = new ChronosMemory(dir);
        // Verify by checking isHighFriction (threshold 15.0)
        expect(c2.isHighFriction(path.join(dir, "decay.ts"))).toBe(false);

        // Verify the actual score
        const state2 = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        const expectedScore = 20 * Math.pow(0.85, 5);
        expect(state2.files["decay.ts"].cfiScore).toBeCloseTo(expectedScore, 2);
    });

    it("11. GC: cfiScore < 1.0 after decay removes file from state", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "gc.ts"), "export const g = 1;");

        const c1 = new ChronosMemory(dir);
        // CFI = 1.0
        c1.recordHeal(path.join(dir, "gc.ts"));
        c1.forcePersist();

        // Simulate many sessions so 1.0 * 0.85^n < 1.0 (n >= 1)
        const dbPath = path.join(dir, ".nreki", "chronos-history.json");
        const state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        state.files["gc.ts"].lastSessionTouched = state.currentSessionId - 2;
        fs.writeFileSync(dbPath, JSON.stringify(state), "utf-8");

        // 1.0 * 0.85^2 = 0.7225 < 1.0 → file should be GC'd
        const c2 = new ChronosMemory(dir);
        void c2; // suppress unused

        const state2 = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        expect(state2.files["gc.ts"]).toBeUndefined();
    });

    it("12. Dead file cleanup: deleted file is removed from state on new session", () => {
        const dir = createTempDir();
        const filePath = path.join(dir, "ghost.ts");
        fs.writeFileSync(filePath, "export const ghost = 1;");

        const c1 = new ChronosMemory(dir);
        // Record errors to create a persistent entry
        c1.recordTrip(filePath, "doom");
        c1.recordTrip(filePath, "doom2");
        c1.forcePersist();

        // Verify entry exists
        const dbPath = path.join(dir, ".nreki", "chronos-history.json");
        let state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        expect(state.files["ghost.ts"]).toBeDefined();
        expect(state.files["ghost.ts"].cfiScore).toBe(20.0);

        // Delete the file
        fs.unlinkSync(filePath);

        // New session should clean up the deleted file
        const c2 = new ChronosMemory(dir);
        void c2;

        state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
        expect(state.files["ghost.ts"]).toBeUndefined();
    });

    it("13. syncTechDebt updates globalTechDebt correctly", () => {
        const dir = createTempDir();
        const chronos = new ChronosMemory(dir);

        // Initial: 10 errors. Current: 13 errors. Delta: +3
        chronos.syncTechDebt(10, 13);
        let state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        expect(state.globalTechDebt).toBe(3);

        // Next sync: lastKnownErrors is 13, current: 7. Delta: -6. Cumulative: 3 + (-6) = -3
        chronos.syncTechDebt(10, 7);
        state = JSON.parse(fs.readFileSync(path.join(dir, ".nreki", "chronos-history.json"), "utf-8"));
        expect(state.globalTechDebt).toBe(-3);
    });

    it("14. Persistence: JSON survives reload (new ChronosMemory on same dir)", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "persist.ts"), "export const p = 1;");

        const c1 = new ChronosMemory(dir);
        c1.recordTrip(path.join(dir, "persist.ts"), "trip1");
        c1.recordSemanticError(path.join(dir, "persist.ts"), "err1");
        c1.forcePersist();

        // Reload
        const c2 = new ChronosMemory(dir);
        // File should still be tracked with decayed score
        // Original score: 10 + 3 = 13. After 1 session decay: 13 * 0.85 = 11.05
        const warning = c2.getContextWarnings(path.join(dir, "persist.ts"));
        // Score < 15, so no warning, but file should exist
        expect(warning).toBe("");

        // But the data persists - push it over threshold to verify
        c2.recordTrip(path.join(dir, "persist.ts"), "trip2");
        // Score = 11.05 + 10 = 21.05
        expect(c2.isHighFriction(path.join(dir, "persist.ts"))).toBe(true);
    });

    it("15. getHealthReport formats correctly with positive/negative/zero delta", () => {
        const dir = createTempDir();
        const chronos = new ChronosMemory(dir);

        // Positive delta (degrading)
        let report = chronos.getHealthReport(5, 8);
        expect(report).toContain("DEGRADING");
        expect(report).toContain("+3");

        // Negative delta (improving)
        report = chronos.getHealthReport(10, 7);
        expect(report).toContain("IMPROVING");
        expect(report).toContain("-3");

        // Zero delta (stable)
        report = chronos.getHealthReport(5, 5);
        expect(report).toContain("STABLE");
    });

    it("16. Blast Radius: recordSemanticError tracks victim files, not edited file", () => {
        const dir = createTempDir();
        fs.writeFileSync(path.join(dir, "editor.ts"), "export function edit() {}");
        fs.writeFileSync(path.join(dir, "victim1.ts"), "import { edit } from './editor';");
        fs.writeFileSync(path.join(dir, "victim2.ts"), "import { edit } from './editor';");

        const chronos = new ChronosMemory(dir);

        // Simulate: editing editor.ts caused errors in victim1.ts and victim2.ts
        chronos.recordSemanticError(path.join(dir, "victim1.ts"), "TS2345: type mismatch");
        chronos.recordSemanticError(path.join(dir, "victim2.ts"), "TS2339: property missing");
        chronos.forcePersist();

        const dbPath = path.join(dir, ".nreki", "chronos-history.json");
        const state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));

        // Victims should have CFI, editor should not
        expect(state.files["victim1.ts"]).toBeDefined();
        expect(state.files["victim1.ts"].cfiScore).toBe(3.0);
        expect(state.files["victim2.ts"]).toBeDefined();
        expect(state.files["victim2.ts"].cfiScore).toBe(3.0);
        expect(state.files["editor.ts"]).toBeUndefined();
    });
});
