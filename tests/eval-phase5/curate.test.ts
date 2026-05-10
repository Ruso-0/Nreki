/**
 * Phase 5 C.1.1: parseArgs unit coverage for curate orchestrator
 * split-mode flags. Pure function — no fs / network mocks.
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "../../scripts/eval-phase5/curate.js";

describe("Phase 5 C.1.1: parseArgs (curate.ts split-mode flags)", () => {
    it("returns full mode when no flags are passed", () => {
        expect(parseArgs([])).toEqual({ kind: "full" });
    });

    it("returns fetch-only mode for --fetch-only", () => {
        expect(parseArgs(["--fetch-only"])).toEqual({ kind: "fetch-only" });
    });

    it("returns force-fetch mode for --force-fetch", () => {
        expect(parseArgs(["--force-fetch"])).toEqual({ kind: "force-fetch" });
    });

    it("returns error when --fetch-only and --force-fetch are combined", () => {
        const m = parseArgs(["--fetch-only", "--force-fetch"]);
        expect(m.kind).toBe("error");
        if (m.kind === "error") {
            expect(m.message).toMatch(/conflicting/i);
        }
    });

    it("returns error for unknown flag", () => {
        const m = parseArgs(["--bogus"]);
        expect(m.kind).toBe("error");
        if (m.kind === "error") {
            expect(m.message).toMatch(/unknown/i);
            expect(m.message).toContain("--bogus");
        }
    });

    it("returns help mode for --help and -h", () => {
        expect(parseArgs(["--help"])).toEqual({ kind: "help" });
        expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    });
});
