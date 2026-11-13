/**
 * validation-banner.ts — Honest "[Validated: …]" footer for edit responses.
 *
 * NREKI-GAR-01: the footer used to be the constant
 *   "[Validated: AST + Semantic check passed. Do not run bash verification.]"
 * even when no semantic check ran at all (syntax mode, kernel boot failure,
 * Kotlin/Java/C/CSS/JSON/HTML, .js without checkJs, gopls/pyright offline)
 * or when it only covered the edited file (file/hologram mode). Agents are
 * told to trust that footer and skip tsc/tests, so overclaiming shipped
 * broken code. The footer now states exactly what ran.
 */

import path from "path";

export type CoverageFn = (filePath: string) => {
    backend: "typescript" | "lsp" | null;
    languageId?: string;
    /** TS file not selected by the tsconfig: checked itself, importers NOT in the program. */
    outsideProgram?: boolean;
};

/** What the handler did about importers of the edited files (file/hologram mode). */
export interface DependentsScope {
    /** The dependency graph was queried successfully. */
    lookedUp: boolean;
    /** Importers type-checked together with the edit. */
    checked: number;
    /** Importers known to exist (≥ checked). */
    total: number;
}

export interface ValidationScope {
    /** Layer 2 (kernel) actually validated this edit. */
    kernelRan: boolean;
    /** Why Layer 2 did not run (only when kernelRan is false). */
    reasonNoKernel?: string;
    /** nrekiMode: file | project | hologram. */
    mode?: string;
    /** Files the agent edited (absolute or project-relative). */
    files: string[];
    coverage?: CoverageFn;
    /** LSP languageIds whose sidecar was offline / failed for this edit. */
    degradedLanguages?: string[];
    dependents?: DependentsScope;
    /** Per LSP language: dependents (same package, importers) checked with the edit. */
    lspCoverage?: ReadonlyArray<{ languageId: string; checked: number; skipped: number }>;
    /** The importers of the Go/Python files could not be looked up (dependency graph unavailable). */
    lspImportersUnknown?: boolean;
    /** File mode: the edited files emit the same .d.ts and the program has the same files (NrekiInterceptResult). */
    exportedApiUnchanged?: boolean;
    /** The edit touched global declarations: files that never import the edited ones see it. */
    declaresGlobals?: boolean;
}

/** Reason string when Layer 2 is unavailable. */
export function describeKernelUnavailable(hasKernel: boolean, nrekiMode: string | undefined): string {
    if (!hasKernel || nrekiMode === "syntax") {
        return "kernel disabled (syntax mode: no tsconfig.json/jsconfig.json/pyproject/requirements/go.mod in the project root)";
    }
    return "kernel failed to boot (see NREKI logs)";
}

function names(files: string[]): string {
    const shown = files.slice(0, 4).map(f => path.basename(f));
    return files.length > 4 ? `${shown.join(", ")} +${files.length - 4}` : shown.join(", ");
}

export function buildValidationBanner(scope: ValidationScope): string {
    if (!scope.kernelRan) {
        return `[Validated: syntax only (tree-sitter AST) — NO type/semantic check ran: ${scope.reasonNoKernel ?? "kernel unavailable"}. ` +
            `Run the compiler/tests before relying on this edit.]`;
    }

    const degraded = new Set(scope.degradedLanguages ?? []);
    let tsCount = 0;
    const lspLangs = new Set<string>();
    const syntaxOnly: string[] = [];
    const offline: string[] = [];
    const outsideProgram: string[] = [];

    for (const f of scope.files) {
        // The edit is already on disk when the banner is built: a failing lookup
        // must never turn success into an error. Unknown coverage = syntax only.
        let cov: ReturnType<CoverageFn> = { backend: null };
        try { if (scope.coverage) cov = scope.coverage(f); } catch { /* conservative default */ }
        if (cov.backend === "typescript") {
            tsCount++;
            if (cov.outsideProgram) outsideProgram.push(f);
        }
        else if (cov.backend === "lsp" && cov.languageId && !degraded.has(cov.languageId)) lspLangs.add(cov.languageId);
        else if (cov.backend === "lsp") offline.push(f);
        else syntaxOnly.push(f);
    }

    const checked: string[] = [];
    let complete = false;
    let caveat = "";
    if (tsCount > 0) {
        if (scope.mode === "project" && outsideProgram.length > 0) {
            checked.push(
                `TypeScript types on ${names(outsideProgram)} in isolation (not selected by tsconfig.json: ` +
                `excluded, or a root config that only lists project references)`,
            );
            caveat = " Importers NOT checked — run your build (e.g. tsc -b) before finishing.";
        } else if (scope.mode === "project") {
            checked.push("TypeScript types, cross-file (project mode)");
            complete = true;
        } else {
            const mode = scope.mode ?? "file";
            const d = scope.dependents;
            const importers = d?.lookedUp && d.checked > 0
                ? ` + ${d.checked < d.total ? `${d.checked} of ${d.total}` : d.checked} direct importer(s)`
                : "";
            if (scope.exportedApiUnchanged === true) {
                // Same .d.ts, same program files: no other file can type-check differently.
                checked.push(`TypeScript types on edited file(s)${importers} (${mode} mode; exported API unchanged, no other file affected)`);
                complete = true;
            } else if (scope.declaresGlobals) {
                // Files that use a global never import it: no importer count covers them.
                checked.push(`TypeScript types on edited file(s)${importers} (${mode} mode)`);
                caveat = " It changes global declarations: files using them were NOT checked — run tsc before finishing.";
            } else if (!d || !d.lookedUp) {
                checked.push(`TypeScript types on edited file(s) only (${mode} mode; dependency graph unavailable)`);
                caveat = " Importers NOT checked — run tsc before finishing.";
            } else if (d.total === 0) {
                checked.push(`TypeScript types on edited file(s) (${mode} mode; no importers)`);
                complete = true;
            } else if (d.checked === 0) {
                checked.push(`TypeScript types on edited file(s) only (${mode} mode)`);
                caveat = ` ${d.total} importer(s) NOT checked — run tsc before finishing.`;
            } else {
                const reach = d.checked < d.total ? `${d.checked} of ${d.total}` : `${d.checked}`;
                checked.push(`TypeScript types on edited file(s) + ${reach} direct importer(s) (${mode} mode)`);
                caveat = d.checked < d.total
                    ? ` ${d.total - d.checked} importer(s) and transitive importers NOT checked — run tsc before finishing.`
                    : scope.exportedApiUnchanged === false
                        ? " Exported API changed: transitive importers (e.g. via re-exports) NOT checked — run tsc before finishing."
                        : " Transitive importers (e.g. via re-exports) not checked — run tsc if the exported API changed.";
            }
        }
    }
    // "new errors only": errors that were there before the edit are not reported.
    // The server reports open documents only: say which ones were open — the
    // edited files plus the dependents NREKI opened — instead of "open files",
    // which the agent has no way to enumerate.
    for (const lang of lspLangs) {
        const cov = scope.lspCoverage?.find(c => c.languageId === lang);
        const dependents = cov && cov.checked > 0
            ? ` + ${cov.checked} dependent file(s) (same package / importers)`
            : "";
        checked.push(`${lang} LSP diagnostics on the edited file(s)${dependents} (new errors only)`);
        if (cov && cov.skipped > 0) {
            caveat += ` ${cov.skipped} more ${lang} dependent(s) NOT checked (per-edit cap) — run the compiler/tests before finishing.`;
        } else if (scope.lspImportersUnknown) {
            caveat += ` ${lang} importers NOT looked up (dependency graph unavailable) — run the compiler/tests before finishing.`;
        }
    }

    if (checked.length === 0) {
        const why = offline.length > 0 && syntaxOnly.length === 0
            ? "the LSP checker was offline"
            : "no semantic checker exists for this file type";
        return `[Validated: syntax only (tree-sitter AST) for ${names(scope.files)} — ${why}. ` +
            `Run the compiler/tests before relying on this edit.]`;
    }

    let banner = `[Validated: syntax + ${checked.join("; ")}.`;
    if (offline.length > 0) banner += ` Semantic check did NOT run for ${names(offline)} (LSP offline).`;
    if (syntaxOnly.length > 0) banner += ` Syntax only for ${names(syntaxOnly)}.`;
    banner += caveat;

    const fullyCovered = complete && offline.length === 0 && syntaxOnly.length === 0 && lspLangs.size === 0;
    banner += fullyCovered
        ? " Re-running tsc is redundant; run tests for runtime behavior.]"
        : (caveat ? "]" : " Run the compiler/tests for anything not listed.]");
    return banner;
}
