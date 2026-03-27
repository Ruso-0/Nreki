/**
 * language-backend.ts — The Immortality Interface
 *
 * Universal contract that any language must fulfill to be a NREKI validation engine.
 * Separates the Orchestrator (NrekiKernel — owns VFS, ACID, commit) from the
 * Compiler Slave (LanguageBackend — computes diagnostics and dies).
 *
 * The LSP server is cattle, not pets. The VFS is the source of truth.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import type { NrekiStructuredError, PreEditContract } from "./nreki-kernel.js";

// ─── Capabilities ───────────────────────────────────────────────────

export interface BackendCapabilities {
    /** Can the backend suggest auto-fixes for errors? (TS: CodeFix, LSP: CodeAction) */
    supportsAutoHealing: boolean;
    /** Can the backend extract type contracts for regression detection? */
    supportsTTRD: boolean;
}

// ─── Code Fix ───────────────────────────────────────────────────────

export interface BackendFix {
    description: string;
    changes: Array<{
        filePath: string;
        textChanges: Array<{ start: number; length: number; newText: string }>;
    }>;
}

// ─── VFS Adapter (Kernel → Backend Bridge) ──────────────────────────

/**
 * The Orchestrator's eyes, lent to the Slave.
 *
 * The kernel creates these callbacks from its own VFS, hologram,
 * and JIT state. The backend uses them to create the CompilerHost.
 * The backend can READ through these callbacks but never WRITE.
 * The VFS stays in the kernel. Always.
 */
export interface VfsAdapter {
    /** Read file content — VFS first, hologram shadows, then disk fallback */
    readFile(fileName: string): string | undefined;
    /** Check if file exists — VFS, hologram, then disk fallback */
    fileExists(fileName: string): boolean;
    /** Get monotonic clock time for cache invalidation */
    getModifiedTime(fileName: string): Date;
    /** Check if directory exists — real + virtual directories */
    directoryExists(dirName: string): boolean;
    /** Get script version string for LanguageService cache */
    getScriptVersion(fileName: string): string;
    /** Get script snapshot for LanguageService */
    getScriptSnapshot(fileName: string): any; // ts.IScriptSnapshot — use any to avoid ts import in interface
}

// ─── The Contract ───────────────────────────────────────────────────

/**
 * The universal contract that any language must fulfill to be a NREKI engine.
 *
 * The Orchestrator (NrekiKernel) calls these methods. The Backend has no opinion,
 * no state worth preserving, and no authority over the VFS or disk.
 *
 * 8 Steps:
 *   1. boot()                    → BACKEND: Start compiler or child process
 *   2. applyVirtualEdits()       → BACKEND: Sync VFS state to compiler memory
 *   3. getDiagnostics()          → BACKEND: Return current errors
 *   4. (compile — ELIMINATED)    → LSP compiles automatically, no method needed
 *   5. (compare — ORCHESTRATOR)  → Δ(P,E) math lives in NrekiKernel
 *   6. getAutoFixes()            → BACKEND (optional): Suggest fixes
 *   7. extractCanonicalTypes()   → BACKEND (optional): TTRD type contracts
 *   8. shutdown()                → BACKEND: Kill process, clean up
 */
export interface LanguageBackend {
    /** Human-readable name: "TypeScript-Strada", "LSP-gopls", "LSP-pylsp" */
    readonly name: string;

    /** Feature flags — what this backend can and cannot do */
    readonly capabilities: BackendCapabilities;

    /**
     * Step 1: BOOT
     * Start the compiler or spawn the LSP child process.
     * Hides infrastructure setup (tsconfig, go.mod virtual, venv detection).
     * The Orchestrator doesn't care how you boot — just boot.
     */
    boot(workspacePath: string, mode: "file" | "project" | "hologram", vfsAdapter?: VfsAdapter): Promise<void>;

    /**
     * Steps 2 & 3 & 7: INJECT / BASELINE / ROLLBACK (VFS Sync)
     * Synchronize the Orchestrator's Master VFS with the Slave's memory.
     *
     * In TypeScript: Updates the CompilerHost's readFile/fileExists overrides.
     * In LSP: Fires textDocument/didOpen (new file) or textDocument/didChange (edit/rollback).
     *
     * The backend doesn't know if this is a baseline, an edit, or a rollback.
     * It doesn't need to know. It just receives file contents.
     *
     * @param edits - Files to sync. content=null means file deleted (tombstone).
     */
    applyVirtualEdits(edits: Array<{ filePath: string; content: string | null }>): Promise<void>;

    /**
     * Step 4: DIAGNOSTICS (Baseline & Post-Edit)
     * Get the current semantic truth from the backend's RAM.
     *
     * In TypeScript: Calls getSemanticDiagnostics() + getSyntacticDiagnostics().
     * In LSP: Waits for textDocument/publishDiagnostics to settle (debounce).
     *
     * Returns standardized errors regardless of language.
     *
     * @param filesToEvaluate - Which files to collect diagnostics for.
     */
    getDiagnostics(filesToEvaluate: Set<string>): Promise<NrekiStructuredError[]>;

    /**
     * Step 6: HEAL (Optional)
     * Request code fixes for a specific error.
     *
     * In TypeScript: LanguageService.getCodeFixesAtPosition().
     * In LSP: textDocument/codeAction with kind "quickfix".
     *
     * Only called if capabilities.supportsAutoHealing === true.
     * Returns empty array if no fixes available.
     */
    getAutoFixes?(filePath: string, error: NrekiStructuredError): Promise<BackendFix[]>;

    /**
     * Step 7: TTRD — Temporal Type Regression Detection (Optional)
     * Extract canonical type contracts for exports.
     *
     * In TypeScript: TypeChecker.getTypeOfSymbolAtLocation() with TypeFlags scoring.
     * In LSP: textDocument/hover or textDocument/signatureHelp (less precise).
     *
     * Only called if capabilities.supportsTTRD === true.
     */
    extractCanonicalTypes?(files: Set<string>): Promise<Map<string, Map<string, PreEditContract>>>;

    /**
     * Step 8: CRASH-ONLY LIFECYCLE
     * Kill the underlying process, clean temp dirs, free memory.
     *
     * In TypeScript: Noop (in-process).
     * In LSP: kill -9 the child process.
     *
     * CRUCIAL for Crash-Only Recovery when an LSP deadlocks.
     */
    shutdown(): Promise<void>;

    /**
     * Health check: Is the underlying process alive and responding?
     *
     * If false, the Orchestrator will call shutdown() then boot().
     *
     * In TypeScript: Always true (in-process, can't crash independently).
     * In LSP: Check if child process exitCode === null.
     */
    isHealthy(): boolean;
}
