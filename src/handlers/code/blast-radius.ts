/**
 * blast-radius.ts — the "[BLAST RADIUS]" note after an edit that changed a signature.
 *
 * It used to list every importer and say "Fix dependents via batch_edit", also
 * when the kernel had just type-checked those importers together with the
 * edit and accepted it: 56 lines pushing the agent to "fix" files that
 * compile. Importers the kernel verified are now counted, not listed; only the
 * ones nobody checked are named, up to a cap.
 */

import type { NrekiKernel } from "../../kernel/nreki-kernel.js";

/** Unverified importers named before the rest is counted. */
export const BLAST_RADIUS_LIST_CAP = 15;

export interface VerifiedScope {
    /** Layer 2 validated the edit. */
    kernelRan: boolean;
    kernel?: NrekiKernel;
    /** nrekiMode: file | project | hologram. */
    mode?: string;
    /** Importers handed to the kernel with the edit (project-relative, POSIX). */
    injected: readonly string[];
    /** LSP languages whose sidecar was offline or failed for this edit. */
    degradedLanguages?: readonly string[];
    /** Per LSP language: dependents checked / left out by the cap. */
    lspCoverage?: ReadonlyArray<{ languageId: string; checked: number; skipped: number }>;
}

/**
 * Which of `dependents` (project-relative, POSIX) were checked together with
 * the edit: TypeScript importers in the program (all of them in project mode,
 * the injected ones in file/hologram mode) and Go/Python importers their
 * sidecar opened — none when its per-edit cap left some out, since the kernel
 * does not say which.
 */
export function verifiedImporters(dependents: readonly string[], scope: VerifiedScope): Set<string> {
    const verified = new Set<string>();
    const kernel = scope.kernel;
    if (!scope.kernelRan || !kernel) return verified;
    const injected = new Set(scope.injected);
    const degraded = new Set(scope.degradedLanguages ?? []);
    for (const dep of dependents) {
        let cov: ReturnType<NrekiKernel["getSemanticCoverage"]>;
        try { cov = kernel.getSemanticCoverage(dep); } catch { continue; }
        if (cov.backend === "typescript" && !cov.outsideProgram) {
            if (scope.mode === "project" || injected.has(dep)) verified.add(dep);
        } else if (cov.backend === "lsp" && cov.languageId && !degraded.has(cov.languageId) && injected.has(dep)) {
            const lsp = scope.lspCoverage?.find(c => c.languageId === cov.languageId);
            if (lsp && lsp.skipped === 0) verified.add(dep);
        }
    }
    return verified;
}

/**
 * @param what       e.g. `Signature of "add" changed`
 * @param dependents importers of the edited file(s), project-relative
 * @param verified   the subset checked with the edit (see verifiedImporters)
 */
export function formatBlastRadius(what: string, dependents: readonly string[], verified: ReadonlySet<string>): string {
    if (dependents.length === 0) return `\n[BLAST RADIUS] ${what}.`;
    const unverified = dependents.filter(d => !verified.has(d));
    const ok = dependents.length - unverified.length;
    const okNote = ok > 0 ? ` ${ok} importer(s) were checked with this edit and still compile.` : "";
    if (unverified.length === 0) return `\n[BLAST RADIUS] ${what}.${okNote}`;

    const shown = unverified.slice(0, BLAST_RADIUS_LIST_CAP).map(d => `  - ${d}`).join("\n");
    const more = unverified.length > BLAST_RADIUS_LIST_CAP
        ? `\n  … +${unverified.length - BLAST_RADIUS_LIST_CAP} more (nreki_navigate action:"references" lists every caller)`
        : "";
    return `\n[BLAST RADIUS] ${what}.${okNote} NOT checked (${unverified.length} importer(s)):\n${shown}${more}\n` +
        `Verify them (compiler/tests) or update them via batch_edit.`;
}
