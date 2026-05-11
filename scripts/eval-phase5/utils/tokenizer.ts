/**
 * scripts/eval-phase5/utils/tokenizer.ts
 *
 * Furia round 20 Sub-1 firmado: single source of truth for
 * token_cost across all 6 Phase 5 retrievers. tiktoken
 * cl100k_base (GPT-4/3.5-turbo standard encoding) is the
 * industry "metro patron" used by SWE-bench and RAG literature
 * so cross-paper comparisons line up.
 *
 * Claude / Anthropic uses a different BPE so absolute counts
 * differ ~3-5%, but the DELTA between runners is preserved --
 * what matters for paper-grade benchmarks.
 *
 * Singleton: the encoder is lazily loaded ONCE and reused
 * across all calls. Reloading the BPE binary per task would
 * stall the Event Loop (Furia round 20).
 */

import { get_encoding, type Tiktoken } from "tiktoken";
import type { TokenCost } from "../types-runners.js";

let _encoder: Tiktoken | null = null;
let _callCount = 0;

function getEncoder(): Tiktoken {
    if (_encoder === null) {
        _encoder = get_encoding("cl100k_base");
    }
    return _encoder;
}

/**
 * Tokenize text and return the token count. Empty input returns 0
 * without allocating an encoder.
 */
export function computeTokenCost(text: string): number {
    if (text.length === 0) return 0;
    _callCount++;
    return getEncoder().encode(text).length;
}

/**
 * Aggregate token cost across an arbitrary number of payload chunks.
 * Returns a fully-populated TokenCost with input_tokens covering the
 * retriever's payload and output_tokens at 0 (retrievers do not emit
 * generated text -- only the embedding endpoint did, but that already
 * sets input_tokens to the API-reported value).
 */
export function payloadTokens(parts: string[]): TokenCost {
    let total = 0;
    for (const p of parts) total += computeTokenCost(p);
    return {
        input_tokens: total,
        output_tokens: 0,
        total_tokens: total,
    };
}

/**
 * Free the underlying WASM resources. Optional -- safe to call at
 * the end of a long-running process or test suite. Subsequent
 * computeTokenCost calls will lazily re-init.
 */
export function disposeTokenizer(): void {
    if (_encoder !== null) {
        _encoder.free();
        _encoder = null;
    }
}

/**
 * Test-only observability: number of computeTokenCost invocations
 * since process start (or last reset). Used by the foundation smoke
 * to assert the singleton was reused rather than re-instantiated.
 */
export function getTokenizerCallCount(): number {
    return _callCount;
}

/** Test-only: reset the call counter without disposing the encoder. */
export function _resetTokenizerCallCount(): void {
    _callCount = 0;
}
