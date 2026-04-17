// src/kernel/types.ts
export interface NrekiStructuredError {
    file: string; line: number; column: number; code: string; message: string;
}

export interface NrekiEdit {
    targetFile: string; proposedContent: string | null;
}

export interface TypeRegression {
    filePath: string;
    symbol: string;
    oldType: string;
    newType: string;
}

export interface NrekiInterceptResult {
    safe: boolean; exitCode: number; latencyMs?: string;
    structured?: NrekiStructuredError[]; errorText?: string;
    healedFiles?: string[];
    regressions?: TypeRegression[];
    postContracts?: Map<string, Map<string, string>>;
    warnings?: string[];
    architectureDiff?: string;
}

export type NrekiMode = "auto" | "syntax" | "file" | "project" | "hologram";

export interface PreEditContract {
    typeStr: string;
    toxicity: number;
    isUntyped: boolean;
}

// ─── Healer IoC Types ─────────────────────────────────────────────

export interface MicroUndoState {
    content: string | null | undefined;
    time: Date | undefined;
    wasInRoot?: boolean;
}

export interface HealingResult {
    healed: boolean;
    appliedFixes: string[];
    newlyTouchedFiles: Set<string>;
    finalErrors: NrekiStructuredError[];
}

export interface BackendFix {
    description: string;
    changes: Array<{
        filePath: string;
        textChanges: Array<{ start: number; length: number; newText: string }>;
    }>;
}

export interface BaseHealingContext {
    readContent(posixPath: string): string;
    createSavepoint(posixPath: string): MicroUndoState;
    applyMicroPatch(posixPath: string, newContent: string): void;
    recordStat(healed: boolean): void;
    executeRollback(undoLog: Map<string, MicroUndoState>, isMacro: boolean): Promise<void> | void;
}

export interface TsHealingContext extends BaseHealingContext {
    readonly mode: string;
    getAutoFixes(file: string, error: NrekiStructuredError): Promise<BackendFix[]>;
    recompileAndEvaluate(evalSet: Set<string>, editSet: Set<string>): Promise<NrekiStructuredError[]>;
}

// ─── LSP Protocol Shapes (Patch 5 / v10.5.9) ──────────────────────
// Canonical LSP types shared by healer.ts, lsp-sidecar-base.ts, and
// nreki-kernel.ts. Equivalent to the legacy local definitions in
// lsp-sidecar-base.ts; centralized here for the grouped-CodeAction contract.

export interface LspPosition {
    line: number;
    character: number;
}

export interface LspRange {
    start: LspPosition;
    end: LspPosition;
}

export interface LspDiagnostic {
    range: LspRange;
    message: string;
    code?: number | string;
    source?: string;
}

export interface LspTextEdit {
    filePath: string;
    range: LspRange;
    newText: string;
}

export interface LspCodeAction {
    title: string;
    edits: LspTextEdit[];
}

export interface LspHealingContext extends BaseHealingContext {
    readonly languageId: string;
    isDead(): boolean;
    resolvePath(rawPath: string): string | null;
    getLspOffset(content: string, line: number, character: number): number;
    // AUDIT FIX (Patch 5 / v10.5.9): returns LspCodeAction[] (title + edits[]) so
    // the healer can apply every TextEdit of a chosen action atomically.
    requestCodeActions(file: string, diagnostic: LspDiagnostic): Promise<LspCodeAction[]>;
    validateLspEdits(editedFiles: Set<string>): Promise<NrekiStructuredError[]>;
}
