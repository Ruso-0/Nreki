/**
 * voyage.ts — Minimal Voyage AI embeddings client (BYOK, opt-in).
 *
 * OFF unless the user opts in explicitly with NREKI_SEMANTIC=voyage plus a key
 * (NREKI_VOYAGE_API_KEY, else VOYAGE_API_KEY, else the key `nreki init` saved in
 * ~/.nreki/voyage.key): a VOYAGE_API_KEY exported for
 * another tool must not silently start sending this repository's code to a
 * third party. Only `float` output is requested (the one dtype the docs
 * guarantee for every model); vectors are normalized and quantized locally.
 */

import { logger } from "../utils/logger.js";
import { availableVoyageKey } from "../utils/voyage-key.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export interface VoyageConfig { apiKey: string; model: string }

export function resolveVoyageConfig(env: NodeJS.ProcessEnv = process.env): VoyageConfig | null {
    if ((env.NREKI_SEMANTIC ?? "").trim().toLowerCase() !== "voyage") return null;
    // Environment first, then the key `nreki init` saved in ~/.nreki/voyage.key.
    const apiKey = availableVoyageKey(env)?.key ?? "";
    if (!apiKey) return null;
    return { apiKey, model: (env.NREKI_VOYAGE_MODEL || "voyage-code-4").trim() };
}

export type EmbedResult =
    | { ok: true; vectors: Float32Array[] }
    /** retryable: 429 / 5xx / network; otherwise (401, 403, 400, malformed) retrying is pointless */
    | { ok: false; retryable: boolean; retryAfterMs?: number; reason: string; limits?: RateLimits };

/** Account limits a 429 states (an account without a payment method: "3 RPM and 10K TPM"). */
export interface RateLimits { rpm: number; tpm: number }

/** Read "N RPM and MK TPM" from an error detail; null when absent. */
export function parseRateLimits(detail: string): RateLimits | null {
    const m = /(\d+(?:\.\d+)?)\s*RPM\s+and\s+(\d+(?:\.\d+)?)\s*([KkMm]?)\s*TPM/.exec(detail);
    if (!m) return null;
    const scale = m[3].toLowerCase() === "k" ? 1_000 : m[3].toLowerCase() === "m" ? 1_000_000 : 1;
    const rpm = Number(m[1]);
    const tpm = Number(m[2]) * scale;
    return rpm > 0 && tpm > 0 ? { rpm, tpm } : null;
}

const logged = new Set<string>();

/** Log a Voyage condition once per process (a dead key must not log on every search). */
export function voyageLogOnce(key: string, level: "info" | "warn", msg: string): void {
    if (logged.has(key)) return;
    logged.add(key);
    logger[level](msg);
}

/** Test hook: forget which messages were already logged. */
export function resetVoyageLogs(): void {
    logged.clear();
}

/** One embeddings request. Never throws. */
export async function voyageEmbed(
    cfg: VoyageConfig,
    texts: string[],
    inputType: "query" | "document",
    timeoutMs: number,
): Promise<EmbedResult> {
    let res: Response;
    try {
        res = await fetch(VOYAGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ input: texts, model: cfg.model, input_type: inputType }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return { ok: false, retryable: true, reason };
    }
    if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const after = Number(res.headers?.get?.("retry-after"));
        const hint = res.status === 401 || res.status === 403 ? " (check the API key)"
            : res.status === 429 ? " (rate limited)" : "";
        // The body says WHY (e.g. "no payment method: reduced rate limits of 3 RPM
        // and 10K TPM"). It never contains the key.
        let detail = "";
        try { detail = (await res.text?.())?.slice(0, 400) ?? ""; } catch { /* no body */ }
        const limits = res.status === 429 ? parseRateLimits(detail) : null;
        return {
            ok: false, retryable, reason: `HTTP ${res.status}${hint}`,
            ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}),
            ...(limits ? { limits } : {}),
        };
    }
    let json: { data?: Array<{ embedding?: number[]; index?: number }> };
    try {
        json = (await res.json()) as typeof json;
    } catch {
        return { ok: false, retryable: true, reason: "malformed JSON response" };
    }
    const vectors: Float32Array[] = new Array(texts.length);
    for (const [i, d] of (json.data ?? []).entries()) {
        const at = typeof d.index === "number" ? d.index : i;
        if (at >= 0 && at < texts.length && Array.isArray(d.embedding)) vectors[at] = new Float32Array(d.embedding);
    }
    for (let i = 0; i < texts.length; i++) {
        if (!vectors[i] || vectors[i].length === 0) return { ok: false, retryable: false, reason: "response did not match the request" };
    }
    return { ok: true, vectors };
}

/** Unit-normalize, then map each component to int8 (dot product ≈ 127² · cosine). */
export function quantize(vec: Float32Array): Int8Array {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Int8Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round((vec[i] / norm) * 127)));
    return out;
}
