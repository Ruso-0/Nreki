/**
 * limits.ts — central knobs for NREKI's semantic-edit guardrails.
 *
 * Empirical analysis: docs/threshold-empirical-analysis.md (v11.3.1 sprint).
 * Furia adversarial review: docs/furia-threshold-review.md.
 */

import { logger } from "./utils/logger.js";

const SYMBOL_REPLACE_LIMIT_DEFAULT = 100;
const SYMBOL_REPLACE_LIMIT_MAX = 1000;

function parseLimitEnv(raw: string | undefined, defaultValue: number, maxValue: number, name: string): number {
    if (raw === undefined || raw === "") return defaultValue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        logger.warn(`[limits] ${name}="${raw}" is not a positive integer; falling back to default ${defaultValue}.`);
        return defaultValue;
    }
    if (parsed > maxValue) {
        logger.warn(`[limits] ${name}=${parsed} exceeds sanity ceiling ${maxValue}; clamping to ${maxValue}.`);
        return maxValue;
    }
    return parsed;
}

/**
 * Maximum line count (inclusive) of an existing symbol that `mode:"replace"`
 * will accept. Symbols larger than this must be edited via `mode:"patch"`
 * with `search_text`/`replace_text`, or decomposed via `prepare_refactor`.
 *
 * Default: 100 — empirical p99 of typical TS libraries, p95 of NREKI src/.
 * Override: `NREKI_SYMBOL_LIMIT=<int>` (clamped to 1..1000).
 *
 * Rationale (Phase 1 measurement):
 *   - At 40 L (legacy): blocks 10.45% of real-world functions, 19.06% of NREKI's own src/.
 *   - At 100 L (current): blocks 3.02% — true god-functions only.
 */
export const SYMBOL_REPLACE_LIMIT: number = parseLimitEnv(
    process.env.NREKI_SYMBOL_LIMIT,
    SYMBOL_REPLACE_LIMIT_DEFAULT,
    SYMBOL_REPLACE_LIMIT_MAX,
    "NREKI_SYMBOL_LIMIT",
);
