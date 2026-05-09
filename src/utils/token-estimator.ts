/**
 * Token estimation utility extracted from Embedder
 * during v11.0.0 amputation (Sub-sprint 2.2.2.x).
 *
 * Heuristic: chars-per-token ratio differs for code vs prose.
 * - Code: 3.5 chars/token (denser symbols, shorter idents)
 * - Prose: 4.0 chars/token (longer English words avg)
 *
 * Used cross-codebase for logUsage tokens, compression decisions,
 * tool response sizing.
 */
export function estimateTokens(text: string, isCode: boolean = true): number {
    const charsPerToken = isCode ? 3.5 : 4.0;
    return Math.ceil(text.length / charsPerToken);
}
