/**
 * v10.7.0 — Unit tests for the Parasitic Defect Radar.
 *
 * Covers the 4 built-in detectors and the shared preprocessing:
 *   - stripForRadar removes comments + empties string bodies
 *   - swallowed-error, type-escape-any, ts-suppress, non-null-assert
 *   - false-positive guards (JSX "anyProp", `!==`, plain prose with "any")
 *   - `// nreki-hunt: disable` escape hatch
 */
import { describe, it, expect } from "vitest";
import { runDefectRadar, stripForRadar } from "../src/utils/defect-radar.js";

describe("Defect Radar (Parasitic)", () => {
    it("stripForRadar removes comments and empties strings", () => {
        const raw = `const a = "hello"; // comment\n/* block */ const b = 1;`;
        const stripped = stripForRadar(raw);
        expect(stripped).not.toContain("hello");
        expect(stripped).not.toContain("comment");
        expect(stripped).not.toContain("block");
        expect(stripped).toContain('""');
    });

    it("detects swallowed-error", () => {
        expect(runDefectRadar(`try { doMath(); } catch (e) { }`).some(d => d.id === 'swallowed-error')).toBe(true);
    });

    it("detects type-escape-any including positional generics", () => {
        expect(runDefectRadar(`const x = y as any;`).some(d => d.id === 'type-escape-any')).toBe(true);
        expect(runDefectRadar(`function foo(x: any) {}`).some(d => d.id === 'type-escape-any')).toBe(true);
        expect(runDefectRadar(`const m = new Map<string, any>();`).some(d => d.id === 'type-escape-any')).toBe(true);
        expect(runDefectRadar(`const m = new Map<any, string>();`).some(d => d.id === 'type-escape-any')).toBe(true);
    });

    it("does NOT detect type-escape-any in JSX attributes or plain text", () => {
        expect(runDefectRadar(`<Comp anyProp={1}>foo</Comp>`).some(d => d.id === 'type-escape-any')).toBe(false);
        expect(runDefectRadar(`const company = "acme";`).some(d => d.id === 'type-escape-any')).toBe(false);
    });

    it("detects non-null-assert safely, not on !==", () => {
        expect(runDefectRadar(`value!.method()`).some(d => d.id === 'non-null-assert')).toBe(true);
        expect(runDefectRadar(`array![0]`).some(d => d.id === 'non-null-assert')).toBe(true);
        expect(runDefectRadar(`if (a !== b) {}`).some(d => d.id === 'non-null-assert')).toBe(false);
    });

    it("detects ts-suppress", () => {
        expect(runDefectRadar(`// @ts-ignore\nconst x = 1;`).some(d => d.id === 'ts-suppress')).toBe(true);
    });

    it("respects nreki-hunt: disable global flag", () => {
        expect(runDefectRadar(`// nreki-hunt: disable\ncatch (e) {}\n// @ts-ignore`).length).toBe(0);
    });
});
