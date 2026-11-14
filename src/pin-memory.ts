/**
 * pin-memory.ts - Persistent pinned rules that Claude never forgets.
 *
 * Pins are injected into every nreki_map response, keeping important
 * project conventions permanently in Claude's attention window.
 * Deterministic output (sorted by id) for prompt cache compatibility.
 */

import fs from "fs";
import path from "path";
import { logger } from "./utils/logger.js";
import { quarantineFile, signState, verifyState } from "./utils/trust.js";
import { writeStateFile } from "./utils/path-jail.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PinnedRule {
    id: string;
    text: string;
    createdAt: number;
    source: "user" | "claude" | "agent";
}

// ─── Constants ──────────────────────────────────────────────────────

const MAX_PINS = 10;
const MAX_PIN_LENGTH = 200;

/** Byte-identical comparator - same result on every OS (no ICU dependency). */
const stableCompare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;

// ─── Storage ─────────────────────────────────────────────────────────

function getPinsPath(projectRoot: string): string {
    return path.join(projectRoot, ".nreki", "pins.json");
}

/**
 * Pins are injected into every map and into the periodic memory payload as
 * the USER's rules, so a pins.json shipped with a repository would be a
 * prompt-injection channel. The file is signed (utils/trust.ts); an unsigned
 * or foreign one is quarantined and ignored (`nreki trust-db` can adopt it).
 */
function loadPins(projectRoot: string): PinnedRule[] {
    const pinsPath = getPinsPath(projectRoot);
    if (!fs.existsSync(pinsPath)) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(pinsPath, "utf-8"));
    } catch {
        return [];
    }
    const signed = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? raw as { pins?: unknown; tag?: unknown }
        : null;
    if (!signed || !Array.isArray(signed.pins) || !verifyState("pins", JSON.stringify(signed.pins), signed.tag)) {
        const moved = quarantineFile(pinsPath);
        if (moved) fs.rmSync(pinsPath, { force: true });
        logger.warn(
            `[NREKI] ${pinsPath} is not signed by this machine (NREKI <= 12.0.0, another machine, or shipped with ` +
            `the repository); its rules are ignored${moved ? ` (moved to ${moved})` : ""}. ` +
            `If they are yours: npx @ruso-0/nreki trust-db`,
        );
        return [];
    }
    // A9: Prevent prototype pollution
    return (signed.pins as unknown[]).filter((item: unknown): item is PinnedRule =>
        typeof item === "object" && item !== null && !Object.hasOwn(item as object, "__proto__")
    );
}

function savePins(projectRoot: string, pins: PinnedRule[]): void {
    // Never through a `.nreki` link shipped with the repository (writeStateFile).
    writeStateFile(projectRoot, getPinsPath(projectRoot),
        JSON.stringify({ version: 2, pins, tag: signState("pins", JSON.stringify(pins)) }, null, 2));
}

/**
 * Adopt reviewed pins (`nreki trust-db`). Each one passes exactly the checks
 * addPin applies (length, empty, control characters, blocked patterns, NFKC,
 * XML escaping): a quarantined file cannot smuggle in a rule addPin refuses (S-03).
 */
export function adoptPins(projectRoot: string, candidates: ReadonlyArray<{ text: unknown }>): { adopted: number; rejected: string[] } {
    const pins = loadPins(projectRoot);
    const known = new Set(pins.map(p => p.text));
    const rejected: string[] = [];
    let adopted = 0;
    for (const c of candidates) {
        const text = typeof c.text === "string" ? c.text.trim() : "";
        if (text.length === 0 || text.length > MAX_PIN_LENGTH) {
            rejected.push(`length ${text.length} (max ${MAX_PIN_LENGTH})`);
            continue;
        }
        const check = sanitizePin(text);
        if (!check.valid) {
            rejected.push(check.reason);
            continue;
        }
        const finalText = escapePinContent(check.normalized);
        if (known.has(finalText)) continue;
        if (pins.length >= MAX_PINS) {
            rejected.push(`maximum of ${MAX_PINS} pins reached`);
            continue;
        }
        pins.push({ id: nextId(pins), text: finalText, createdAt: Date.now(), source: "user" });
        known.add(finalText);
        adopted++;
    }
    if (adopted > 0) savePins(projectRoot, pins);
    return { adopted, rejected };
}

// ─── Next ID ─────────────────────────────────────────────────────────

function nextId(pins: PinnedRule[]): string {
    let maxNum = 0;
    for (const pin of pins) {
        const match = pin.id.match(/^pin_(\d+)$/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxNum) maxNum = num;
        }
    }
    return `pin_${String(maxNum + 1).padStart(3, "0")}`;
}

// ─── Pin Sanitization ────────────────────────────────────────────

/** Patterns that should never appear in pinned rules (anti-poisoning). */
const BLOCKED_PIN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /https?:\/\/[^\s]+/i, label: "URLs" },
    { pattern: /\bsudo\b/i, label: "sudo commands" },
    { pattern: /\brm\s+-rf\b/i, label: "destructive commands" },
    { pattern: /\b(?:curl|wget)\b/i, label: "download commands" },
    { pattern: /\.\.\//,            label: "path traversal" },
    { pattern: /\$\(/,              label: "command substitution" },
    { pattern: /`[^`]*\$[({][^`]*`/, label: "backtick command substitution" },
    { pattern: /<script\b/i,        label: "script injection" },
    { pattern: /\beval\s*\(/i,      label: "eval calls" },
    { pattern: /\bexec\s*\(/i,      label: "exec calls" },
];

/**
 * Validate pin text against poisoning patterns.
 * Blocks URLs, shell commands, path traversal, and injection attempts.
 */
export function sanitizePin(text: string): { valid: true; normalized: string } | { valid: false; reason: string } {
    // A8: Reject null bytes
    if (text.includes("\0")) {
        return { valid: false, reason: "Pin text contains null bytes." };
    }
    // A pin is one line inside a "=== PINNED RULES ===" block: a newline could
    // fake the end of the block, and ESC/CR sequences rewrite terminal output.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
        return { valid: false, reason: "Pin text contains control characters or line breaks." };
    }
    // A8: Normalize Unicode to prevent homoglyph bypass
    const normalized = text.normalize("NFKC");
    for (const { pattern, label } of BLOCKED_PIN_PATTERNS) {
        if (pattern.test(normalized)) {
            return { valid: false, reason: `Pin text contains blocked pattern (${label}).` };
        }
    }
    // A-08: Return normalized text so callers store the canonical form
    return { valid: true, normalized };
}

// ─── Tag Escaping ────────────────────────────────────────────────

/**
 * Escape only angle brackets to prevent XML-like prompt injection.
 * A-06: Do NOT escape &, ", ' - these corrupt plain-text pins for the LLM.
 * The MCP SDK handles JSON-RPC string encoding at the transport layer.
 */
function escapePinContent(text: string): string {
    return text
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// ─── Public API ──────────────────────────────────────────────────────

export function addPin(
    projectRoot: string,
    text: string,
    source: "user" | "claude" | "agent"
): { success: true; pin: PinnedRule } | { success: false; error: string } {
    if (text.length > MAX_PIN_LENGTH) {
        return {
            success: false,
            error: `Pin text exceeds maximum length of ${MAX_PIN_LENGTH} characters (got ${text.length}).`,
        };
    }

    if (text.trim().length === 0) {
        return { success: false, error: "Pin text cannot be empty." };
    }

    const sanitizeResult = sanitizePin(text.trim());
    if (!sanitizeResult.valid) {
        return { success: false, error: sanitizeResult.reason };
    }

    const pins = loadPins(projectRoot);

    if (pins.length >= MAX_PINS) {
        return {
            success: false,
            error: `Maximum of ${MAX_PINS} pins reached. Remove a pin before adding a new one.`,
        };
    }

    const pin: PinnedRule = {
        id: nextId(pins),
        // A-08: Use normalized text from sanitizePin
        text: escapePinContent(sanitizeResult.normalized),
        createdAt: Date.now(),
        source,
    };

    pins.push(pin);
    savePins(projectRoot, pins);
    return { success: true, pin };
}

export function removePin(
    projectRoot: string,
    id: string
): boolean {
    const pins = loadPins(projectRoot);
    const idx = pins.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    pins.splice(idx, 1);
    savePins(projectRoot, pins);
    return true;
}

export function listPins(projectRoot: string): PinnedRule[] {
    return loadPins(projectRoot);
}

export function getPinnedText(projectRoot: string): string {
    const pins = loadPins(projectRoot);
    if (pins.length === 0) return "";

    // Sort by id for deterministic output
    const sorted = [...pins].sort((a, b) => stableCompare(a.id, b.id));

    const lines: string[] = [];
    lines.push("=== PINNED RULES (do not violate) ===");
    for (let i = 0; i < sorted.length; i++) {
        lines.push(`[${i + 1}] ${sorted[i].text}`);
    }
    lines.push("=====================================");
    lines.push("");

    return lines.join("\n");
}
