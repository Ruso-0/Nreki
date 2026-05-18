/**
 * Token estimation utility extracted from Embedder
 * during v11.0.0 amputation (Sub-sprint 2.2.2.x).
 *
 * Phase 5.5.1 (Sprint Empirical Verify): replaced heuristic chars/3.5
 * with real BPE tokenizer (tiktoken cl100k_base) for genuine measurement.
 * Falls back to heuristic if WASM init fails.
 *
 * Used cross-codebase for logUsage tokens, compression decisions,
 * tool response sizing.
 */

import { createRequire } from "node:module";

let _encoder: import("tiktoken").Tiktoken | null = null;
let _encoderInitAttempted = false;

function getEncoder(): import("tiktoken").Tiktoken | null {
    if (_encoder) return _encoder;
    if (_encoderInitAttempted) return null;
    _encoderInitAttempted = true;
    try {
        const _require = createRequire(import.meta.url);
        const { get_encoding } = _require("tiktoken") as typeof import("tiktoken");
        _encoder = get_encoding("cl100k_base");
        return _encoder;
    } catch {
        return null;
    }
}

export function estimateTokens(text: string, _isCode: boolean = true): number {
    const enc = getEncoder();
    if (enc) {
        try {
            return enc.encode_ordinary(text).length;
        } catch {
            // fall through to heuristic
        }
    }
    // Heuristic fallback: 3.5 chars/token for code
    return Math.ceil(text.length / 3.5);
}
