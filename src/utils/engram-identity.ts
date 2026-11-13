/**
 * engram-identity.ts — Which symbol an engram belongs to, and when it is stale.
 *
 * Engrams used to be keyed by the bare symbol name. In a file with two `run`
 * methods the note landed on the first one, and the next outline DELETED it
 * because the second `run` did not match its hash ("code mutated"), with no
 * code change at all. Identity is now the qualified name (Class.method; for
 * Go, Receiver.method) plus the body hash, and an engram is only invalidated
 * when no symbol with its name still has the saved body.
 */

import crypto from "crypto";
import type { ParsedChunk } from "../parser.js";

/** An engram is printed in every outline of its file: keep it to an invariant. */
export const ENGRAM_MAX_CHARS = 500;

export function engramHash(body: string): string {
    return crypto.createHash("sha256").update(body).digest("hex");
}

/** "ASSERT…" engrams survive body changes (they pin the symbol's role, not its code). */
export function isImmortalEngram(insight: string): boolean {
    return insight.trimStart().toUpperCase().startsWith("ASSERT");
}

const GO_RECEIVER = /^func\s*\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)/;

/**
 * Qualified name per chunk (same order and length as `chunks`; "" when the
 * chunk has no name): innermost enclosing named chunk + "." + name.
 */
export function qualifiedNames(chunks: ReadonlyArray<ParsedChunk>): string[] {
    const span = (c: ParsedChunk) => c.endIndex - c.startIndex;
    const named = chunks.filter(c => c.symbolName && c.nodeType !== "top_level" && c.nodeType !== "file");
    return chunks.map(c => {
        if (!c.symbolName) return "";
        let parent: ParsedChunk | undefined;
        for (const p of named) {
            if (p === c || span(p) <= span(c)) continue;
            if (p.startIndex <= c.startIndex && p.endIndex >= c.endIndex && (!parent || span(p) < span(parent))) parent = p;
        }
        if (parent) return `${parent.symbolName}.${c.symbolName}`;
        const recv = GO_RECEIVER.exec(c.rawCode);
        return recv ? `${recv[1]}.${c.symbolName}` : c.symbolName;
    });
}

export interface EngramSymbol {
    /** Qualified name (Class.method) — the storage key. */
    qualified: string;
    /** Bare name — matches engrams saved before qualified keys existed. */
    bare: string;
    body: string;
    startLine: number;
}

export type EngramTarget = { ok: true; symbol: EngramSymbol } | { ok: false; error: string };

/** Resolve the symbol an agent asked to anchor an engram to ("Beta.run" or "run"). */
export function resolveEngramTarget(symbols: ReadonlyArray<EngramSymbol>, requested: string): EngramTarget {
    const want = requested.trim();
    let hits = symbols.filter(s => s.qualified === want);
    if (hits.length === 0) hits = symbols.filter(s => s.bare === want);
    if (hits.length === 0) {
        const lower = want.toLowerCase();
        const near = [...new Set(symbols.filter(s => s.qualified.toLowerCase().includes(lower)).map(s => s.qualified))].slice(0, 5);
        return {
            ok: false,
            error: `symbol "${want}" not found.` + (near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : " Run outline first."),
        };
    }
    const distinct = [...new Set(hits.map(h => h.qualified))];
    if (distinct.length > 1) {
        return {
            ok: false,
            error: `"${want}" is ambiguous in this file: ${hits.map(h => `${h.qualified} (L${h.startLine})`).join(", ")}. ` +
                `Use the qualified name.`,
        };
    }
    // Same qualified name several times (e.g. TS overload signatures): anchor to the implementation.
    const symbol = hits.reduce((a, b) => (b.body.length > a.body.length ? b : a));
    return { ok: true, symbol };
}

export interface StoredEngram { astHash: string; insight: string }

export interface EngramPlacement {
    /** symbol index → insights to print under it */
    shown: Map<number, string[]>;
    /** symbol index → an engram anchored there was just invalidated */
    invalidatedAt: Set<number>;
    /** stored keys whose code changed (delete them) */
    invalidated: string[];
    /** legacy bare-name keys to re-store under the qualified name */
    rekeyed: Array<{ from: string; to: string }>;
}

/**
 * Decide where each stored engram of a file is shown. An engram whose
 * symbol is absent from the parse (renamed, or a transient syntax error) is
 * left untouched: deleting it there would lose notes on a half-typed edit.
 */
export function placeEngrams(symbols: ReadonlyArray<EngramSymbol>, stored: ReadonlyMap<string, StoredEngram>): EngramPlacement {
    const placement: EngramPlacement = { shown: new Map(), invalidatedAt: new Set(), invalidated: [], rekeyed: [] };
    const hashes = symbols.map(s => engramHash(s.body));
    const indexesWhere = (pred: (s: EngramSymbol) => boolean) =>
        symbols.map((s, i) => (pred(s) ? i : -1)).filter(i => i >= 0);

    for (const [key, memory] of stored) {
        let candidates = indexesWhere(s => s.qualified === key);
        const legacy = candidates.length === 0;
        if (legacy) candidates = indexesWhere(s => s.bare === key);
        if (candidates.length === 0) continue;

        const exact = candidates.find(i => hashes[i] === memory.astHash);
        const owner = exact ?? (isImmortalEngram(memory.insight) ? candidates[0] : undefined);
        if (owner === undefined) {
            placement.invalidated.push(key);
            placement.invalidatedAt.add(candidates[0]);
            continue;
        }
        const list = placement.shown.get(owner) ?? [];
        list.push(memory.insight);
        placement.shown.set(owner, list);
        if (legacy && symbols[owner].qualified !== key) placement.rekeyed.push({ from: key, to: symbols[owner].qualified });
    }
    return placement;
}
