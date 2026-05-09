/**
 * src/utils/type-extractor.ts
 *
 * Heuristic regex-based extractor of TypeScript I/O types (consumes
 * = parameter types, produces = return types) from raw source code.
 *
 * Ported from scripts/eval-type-ledger-accuracy.ts where the same
 * heuristic was measured against vanilla ts.createProgram + TypeChecker
 * as ground truth (Phase 1 baseline: 81.1% zod / 92.8% astro accuracy).
 *
 * NOT oracle-grade: regex parses single-token types only and has known
 * gaps on qualified names (core.SomeType), generic bounds with `{`,
 * and deeply nested generics (Promise<Map<K,V>>).
 *
 * Designed for type-directed retrieval seeding (symbol_io ledger).
 * Mutates nothing, deterministic over fixed input.
 */

// ─── Whitelist of generic containers to unwrap ─────────────────
//
// Auditor decision (sub-sprint 2.2): Either is intentionally NOT in the
// unwrap set. Either<L,R> convention is ambiguous — left is typically
// the error type, right the value — and unwrapping arg[0] would risk
// emitting the error type as the symbol's I/O. Either is kept as a
// container name instead.
export const UNWRAP_GENERICS = new Set([
    "Promise", "Awaitable", "Array", "ReadonlyArray",
    "Result", "Option", "Maybe",
]);

export const DISCARD_NAMES = new Set([
    "any", "unknown", "never", "void",
    "string", "number", "boolean", "bigint", "symbol",
    "null", "undefined", "object",
    "__type", "__object",
    "_", "",
    // Reserved words (Sub-sprint 2.2.2.2):
    "typeof", "asserts", "keyof", "infer",
    "extends", "is", "in", "as",
    "satisfies", "readonly",
]);

export function isDiscarded(name: string): boolean {
    return DISCARD_NAMES.has(name) || name.startsWith("(Anonymous");
}

// Sub-sprint 2.2.2.2: identifier purity + single-letter generic gates.
const VALID_IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const SINGLE_LETTER_GENERIC = /^[A-Z]$/;

/**
 * Validate a candidate type name post-unwrap and emit it or null.
 * Single source of truth for emission policy: discards reserved/primitive
 * names, non-identifier strings (inline objects, unions, intersections,
 * arrays leaked through container unwrap), and single-letter generic
 * type parameters.
 */
function emitOrDiscard(s: string): string | null {
    if (s.length === 0) return null;
    if (isDiscarded(s)) return null;
    if (!VALID_IDENTIFIER.test(s)) return null;
    if (SINGLE_LETTER_GENERIC.test(s)) return null;
    return s;
}

/**
 * Unwrap a type expression string applying the conservative whitelist.
 * Operates on a single type token (no unions, no intersections).
 * Returns the canonical name or null if the type should be discarded.
 *
 * Examples:
 *   "Promise<User>"   -> "User"
 *   "User[]"          -> "User"
 *   "readonly User[]" -> "User"
 *   "Promise<User[]>" -> "User"   (recursive)
 *   "Map<K, V>"       -> "Map"    (Map not in whitelist)
 *   "any"             -> null     (discarded)
 */
export function unwrapHeuristic(typeStr: string, depth: number = 0): string | null {
    if (depth > 8) return null; // pathological-loop safety
    let s = typeStr.trim();
    while (s.startsWith("readonly ")) s = s.slice("readonly ".length).trim();
    while (s.endsWith("[]")) s = s.slice(0, -2).trim();

    const ltIdx = s.indexOf("<");
    if (ltIdx === -1) {
        return emitOrDiscard(s);
    }
    const head = s.slice(0, ltIdx).trim();
    const rgIdx = s.lastIndexOf(">");
    if (rgIdx === -1) {
        return emitOrDiscard(head);
    }
    if (UNWRAP_GENERICS.has(head)) {
        const argStr = s.slice(ltIdx + 1, rgIdx).trim();
        const firstArg = argStr.split(",")[0].trim();
        return unwrapHeuristic(firstArg, depth + 1);
    }
    return emitOrDiscard(head);
}

export const TYPE_TOKEN = /(?:readonly\s+)?[a-zA-Z_$][a-zA-Z0-9_$]*(?:\s*<[^>]+>)?(?:\s*\[\])*/;
export const PARAM_TYPE_RX = new RegExp(`:\\s*(${TYPE_TOKEN.source})`, "g");
export const RETURN_TYPE_RX = new RegExp(`\\)\\s*:\\s*(${TYPE_TOKEN.source})`);

/**
 * O(N) state machine that splits a callable's raw source into the params
 * region and the return region without using fragile regex anchors.
 *
 * - Tracks parenDepth to find the matching closer of the symbol's first `(`.
 * - Tracks angleDepth to avoid premature termination on `{` / `;` that
 *   appear inside generic type bounds (e.g. `Promise<{ id: string }>`).
 * - Skips `//`, line and block comments entirely.
 * - Replaces string-literal contents with whitespace of equal length so
 *   downstream regex can never match `:` inside `"... : Foo "` etc.
 *
 * Termination of returnStr: first `{` (body) or `;` (declaration without
 * body) at angleDepth === 0, or end of input.
 */
export function splitSignatureIO(rawCode: string): {
    paramsStr: string;
    returnStr: string;
} {
    const len = rawCode.length;
    let mode: "before" | "params" | "return" = "before";
    let parenDepth = 0;
    let angleDepth = 0;
    let paramsRaw = "";
    let returnRaw = "";

    let inString: false | '"' | "'" | "`" = false;
    let inLineComment = false;
    let inBlockComment = false;

    const append = (ch: string): void => {
        if (mode === "params") paramsRaw += ch;
        else if (mode === "return") returnRaw += ch;
    };

    let i = 0;
    while (i < len) {
        const ch = rawCode[i];
        const next = i + 1 < len ? rawCode[i + 1] : "";
        const prev = i > 0 ? rawCode[i - 1] : "";

        if (inLineComment) {
            if (ch === "\n") inLineComment = false;
            i++;
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }
        if (inString) {
            if (ch === "\\") {
                append(" ");
                if (i + 1 < len) append(" ");
                i += 2;
                continue;
            }
            if (ch === inString) {
                append(ch);
                inString = false;
                i++;
                continue;
            }
            append(" ");
            i++;
            continue;
        }

        if (ch === "/" && next === "/") {
            inLineComment = true;
            i += 2;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            append(ch);
            inString = ch as ('"' | "'" | "`");
            i++;
            continue;
        }

        if (mode === "before") {
            if (ch === "(") {
                parenDepth = 1;
                mode = "params";
            }
            i++;
            continue;
        }

        if (mode === "params") {
            if (ch === "<") angleDepth++;
            else if (ch === ">" && prev !== "=") angleDepth--;

            if (ch === "(") {
                parenDepth++;
                append(ch);
            } else if (ch === ")") {
                parenDepth--;
                if (parenDepth === 0) {
                    mode = "return";
                    angleDepth = 0;
                } else {
                    append(ch);
                }
            } else {
                append(ch);
            }
            i++;
            continue;
        }

        // mode === "return"
        if (ch === "<") angleDepth++;
        else if (ch === ">" && prev !== "=") angleDepth--;

        if ((ch === "{" || ch === ";") && angleDepth === 0) break;
        append(ch);
        i++;
    }

    return { paramsStr: paramsRaw, returnStr: returnRaw };
}

export function extractParamTypes(code: string): string[] {
    const { paramsStr } = splitSignatureIO(code);
    const result: string[] = [];
    const rx = new RegExp(PARAM_TYPE_RX.source, "g");
    let match: RegExpExecArray | null;
    while ((match = rx.exec(paramsStr)) !== null) {
        const unwrapped = unwrapHeuristic(match[1]);
        if (unwrapped) result.push(unwrapped);
    }
    return result;
}

export function extractReturnType(code: string): string[] {
    const { returnStr } = splitSignatureIO(code);
    const RETURN_RX = new RegExp(`:\\s*(${TYPE_TOKEN.source})`, "g");
    const result: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = RETURN_RX.exec(returnStr)) !== null) {
        const unwrapped = unwrapHeuristic(match[1]);
        if (unwrapped) result.push(unwrapped);
    }
    return result;
}

/**
 * Heuristic regex-based extractor. NOT oracle-grade. Designed for
 * type-directed retrieval seeding. Mutates nothing, deterministic
 * over fixed input.
 */
export function extractTypeIO(rawCode: string): {
    consumes: string[];
    produces: string[];
} {
    return {
        consumes: extractParamTypes(rawCode),
        produces: extractReturnType(rawCode),
    };
}
