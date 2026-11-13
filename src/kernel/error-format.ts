/**
 * error-format.ts — bounded rendering of a rejection's error list.
 *
 * A rejected edit used to print one line per error with no limit: changing a
 * signature with 56 callers answered 56 near-identical lines (~1,300 tokens),
 * again on every retry. The agent needs the distinct problems and where they
 * are, not every repetition: the first errors are listed in full (those in the
 * edited files first), the rest is summarised by code and file.
 */

import type { NrekiStructuredError } from "./types.js";

/** Errors listed one per line before the rest is summarised. */
export const ERROR_LIST_CAP = 12;
/** File names given for the summarised remainder. */
const REST_FILE_CAP = 12;
/** A single diagnostic can carry a whole type printout: keep its head. */
const MESSAGE_CHAR_CAP = 600;

export interface ErrorListOptions {
    /** How a file is shown (e.g. relative to the project root). */
    displayPath?: (file: string) => string;
    /** Errors for which this is true are listed first (the files the agent edited). */
    isPrimary?: (error: NrekiStructuredError) => boolean;
}

function clip(message: string): string {
    return message.length > MESSAGE_CHAR_CAP
        ? `${message.slice(0, MESSAGE_CHAR_CAP)}… [+${message.length - MESSAGE_CHAR_CAP} chars]`
        : message;
}

export function formatErrorList(errors: readonly NrekiStructuredError[], options: ErrorListOptions = {}): string {
    const show = options.displayPath ?? ((file: string) => file);
    const line = (e: NrekiStructuredError): string =>
        `  → ${show(e.file)} (${e.line},${e.column}): ${e.code} - ${clip(e.message)}`;

    const isPrimary = options.isPrimary;
    const ordered = isPrimary
        ? [...errors.filter(e => isPrimary(e)), ...errors.filter(e => !isPrimary(e))]
        : errors;
    if (ordered.length <= ERROR_LIST_CAP) return ordered.map(line).join("\n");

    const rest = ordered.slice(ERROR_LIST_CAP);
    const byCode = new Map<string, number>();
    for (const e of rest) byCode.set(e.code, (byCode.get(e.code) ?? 0) + 1);
    const codes = [...byCode].map(([code, n]) => `${code} ×${n}`).join(", ");
    const files = [...new Set(rest.map(e => show(e.file)))];
    const fileList = files.slice(0, REST_FILE_CAP).join(", ") +
        (files.length > REST_FILE_CAP ? `, +${files.length - REST_FILE_CAP} more file(s)` : "");

    return ordered.slice(0, ERROR_LIST_CAP).map(line).join("\n") +
        `\n  … +${rest.length} more not listed (${codes}) in: ${fileList}`;
}
