/**
 * scripts/eval-phase5/runners/query-construction.ts
 *
 * Phase 5 C.3.B shared keyword extraction for lexical retrievers
 * (fast_grep + ripgrep + BM25 future).
 *
 * Hybrid strategy (Furia round 15 #1 + auditor D1):
 *   identifiers (PascalCase / camelCase / snake_case / dotted)
 *   + file paths mentioned in problem_statement.
 * Stopwords stripped, dedup, capped at maxKeywords.
 */

/** Basic English IR stopwords. ~70 entries — intentionally light, no NLP. */
const STOPWORDS: ReadonlySet<string> = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can",
    "of", "to", "in", "on", "at", "by", "for", "with", "from",
    "this", "that", "these", "those", "it", "its", "as", "if", "then",
    "else", "when", "where", "what", "why", "how", "which", "who", "whom",
    "and", "or", "but", "not", "so", "very", "much", "more", "less",
    "also", "just", "only", "too", "here", "there",
    "my", "our", "your", "their", "his", "her", "no", "yes",
]);

const ID_PATTERNS: RegExp[] = [
    /\b[A-Z][a-zA-Z0-9]+\b/g,                  // PascalCase
    /\b[a-z][a-zA-Z0-9]+\b/g,                  // camelCase / lowercase
    /\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b/g, // snake_case (≥1 underscore)
    /\b[a-zA-Z_][\w]*(?:\.[a-zA-Z_]\w*)+\b/g,  // dotted (foo.bar.baz)
];

const FILE_PATH_PATTERN =
    /(?:[a-zA-Z0-9_\-.]+[/\\])+[a-zA-Z0-9_\-.]+\.(?:ts|tsx|js|jsx|json|md)\b/g;

function isPureDigits(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) return false;
    }
    return true;
}

/**
 * Extract TypeScript-style identifiers from text. Tokens are deduped
 * preserving first-occurrence order. Filters:
 *   - length >= 3
 *   - not a stopword (lowercase compare)
 *   - not pure digits
 */
export function extractIdentifiers(text: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const pat of ID_PATTERNS) {
        // Reset regex state — patterns are module-level + /g flagged.
        pat.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.exec(text)) !== null) {
            const tok = m[0];
            if (tok.length < 3) continue;
            if (isPureDigits(tok)) continue;
            if (STOPWORDS.has(tok.toLowerCase())) continue;
            if (seen.has(tok)) continue;
            seen.add(tok);
            out.push(tok);
        }
    }
    return out;
}

/**
 * Extract file paths mentioned in text. Normalizes backslashes to
 * forward slashes so retrievers don't double-match. Dedup preserves
 * first-occurrence order.
 */
export function extractFilePaths(text: string): string[] {
    FILE_PATH_PATTERN.lastIndex = 0;
    const seen = new Set<string>();
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = FILE_PATH_PATTERN.exec(text)) !== null) {
        const normalized = m[0].replace(/\\/g, "/");
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

/**
 * Hybrid query construction (Furia round 15 #1 + auditor D1).
 *
 * Returns file paths first (higher signal — direct mention by the
 * issue author often points at the bug site), then identifiers in
 * appearance order. Deduped across categories; identifiers that are
 * also part of a file path (e.g. "SuggestModel" when "src/SuggestModel.ts"
 * was extracted) remain in the output — they are still useful
 * substring matches.
 *
 * @param problemStatement  Issue body text.
 * @param maxKeywords       Cap on returned list size. Default 30.
 */
export function constructQuery(
    problemStatement: string,
    maxKeywords: number = 30,
): string[] {
    const paths = extractFilePaths(problemStatement);
    const ids = extractIdentifiers(problemStatement);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        merged.push(p);
    }
    for (const i of ids) {
        if (seen.has(i)) continue;
        seen.add(i);
        merged.push(i);
    }
    return merged.slice(0, maxKeywords);
}
