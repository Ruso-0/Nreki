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

export interface LspHealingContext extends BaseHealingContext {
    readonly languageId: string;
    isDead(): boolean;
    resolvePath(rawPath: string): string | null;
    getLspOffset(content: string, line: number, character: number): number;
    requestCodeActions(file: string, diagnostic: any): Promise<any[]>;
    validateLspEdits(editedFiles: Set<string>): Promise<NrekiStructuredError[]>;
}
