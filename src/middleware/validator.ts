/**
 * middleware/validator.ts — AST validation middleware for TokenGuard v3.0.
 *
 * Wraps edit operations with automatic pre-write syntax validation.
 * If the edited code has syntax errors, the write is blocked and the
 * caller gets the exact error with line/column and fix suggestions.
 *
 * This is the former tg_validate tool, now running automatically
 * as invisible middleware inside tg_code action:"edit".
 */

import { AstSandbox, type ValidationResult } from "../ast-sandbox.js";

/**
 * Validate code before writing to disk.
 *
 * @param code - The code to validate
 * @param language - Programming language (typescript, javascript, python, go)
 * @param sandbox - AstSandbox instance
 * @param originalCode - Optional original file content for diff context
 * @returns ValidationResult with validity status, errors, and suggestions
 */
export async function validateBeforeWrite(
    code: string,
    language: string,
    sandbox: AstSandbox,
    originalCode?: string,
): Promise<ValidationResult> {
    await sandbox.initialize();

    if (originalCode) {
        return sandbox.validateDiff(originalCode, code, language);
    }

    return sandbox.validateCode(code, language);
}

/**
 * Format validation errors as a human-readable string for MCP responses.
 */
export function formatValidationErrors(result: ValidationResult): string {
    if (result.valid) return "";

    const errorLines = result.errors.map((e, i) =>
        `${i + 1}. **Line ${e.line}, Col ${e.column}** (${e.nodeType}): \`${e.context.split("\n")[0].trim()}\``,
    );

    return (
        `## Validation: FAILED — ${result.errors.length} syntax error(s)\n\n` +
        `### Errors\n${errorLines.join("\n")}\n\n` +
        `### Suggestions\n${result.suggestion}\n\n` +
        `Fix these errors before writing the file.`
    );
}
