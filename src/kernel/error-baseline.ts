/**
 * error-baseline.ts — "only what the edit adds is fatal", for LSP sidecars.
 *
 * gopls/pyright report the errors of every open document. Without a baseline,
 * one error that was already there (in the edited file or in any other open
 * document) rejected every later Go/Python edit. This mirrors the TypeScript
 * backend's fingerprint baseline: an error is new when its fingerprint occurs
 * more often after the edit than before it.
 *
 * Line and column are not part of the fingerprint: the edit itself moves them.
 * Consequence (same as for TypeScript): replacing one error by another with
 * the same file, code and message is not reported.
 */

import type { NrekiStructuredError } from "./types.js";

/** Fingerprint → number of occurrences before the edit. */
export type ErrorBaseline = ReadonlyMap<string, number>;

function fingerprint(e: NrekiStructuredError): string {
    return `${e.file}\u0000${e.code}\u0000${e.message}`;
}

export function countErrors(errors: readonly NrekiStructuredError[]): ErrorBaseline {
    const counts = new Map<string, number>();
    for (const e of errors) {
        const fp = fingerprint(e);
        counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    return counts;
}

/** The errors the baseline does not already account for (all of them without a baseline). */
export function errorsBeyondBaseline(
    errors: readonly NrekiStructuredError[],
    baseline: ErrorBaseline | undefined,
): NrekiStructuredError[] {
    if (!baseline || baseline.size === 0) return [...errors];
    const seen = new Map<string, number>();
    const added: NrekiStructuredError[] = [];
    for (const e of errors) {
        const fp = fingerprint(e);
        const n = (seen.get(fp) ?? 0) + 1;
        seen.set(fp, n);
        if (n > (baseline.get(fp) ?? 0)) added.push(e);
    }
    return added;
}
