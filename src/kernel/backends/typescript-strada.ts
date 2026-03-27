/**
 * typescript-strada.ts — TypeScript Backend (Strada API)
 *
 * Wraps the current NrekiKernel's TypeScript Compiler API usage.
 * This is the STUB implementation for Strangler Fig Phase 1.
 *
 * All methods return empty/noop results. The kernel continues using
 * its internal logic directly. This stub exists ONLY to prove that
 * the interface compiles and the 704 tests still pass.
 *
 * In Phase 2+, real logic will be extracted from NrekiKernel into here.
 *
 * Dies with TypeScript 7.0 Strada API. Replaced by TypeScriptLSPBackend.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import type {
    LanguageBackend,
    BackendCapabilities,
    BackendFix,
} from "../language-backend.js";
import type { NrekiStructuredError, PreEditContract } from "../nreki-kernel.js";

export class TypeScriptStradaBackend implements LanguageBackend {
    readonly name = "TypeScript-Strada";

    readonly capabilities: BackendCapabilities = {
        supportsAutoHealing: true,
        supportsTTRD: true,
    };

    async boot(_workspacePath: string, _mode: "file" | "project" | "hologram"): Promise<void> {
        // STUB: Real boot logic lives in NrekiKernel.boot() for now.
        // Phase 2+ will extract CompilerHost creation here.
    }

    async applyVirtualEdits(_edits: Array<{ filePath: string; content: string | null }>): Promise<void> {
        // STUB: Real VFS injection lives in NrekiKernel.interceptAtomicBatch() for now.
        // Phase 2+ will extract vfs.set() + vfsClock.set() here.
    }

    async getDiagnostics(_filesToEvaluate: Set<string>): Promise<NrekiStructuredError[]> {
        // STUB: Real diagnostics live in NrekiKernel.getFatalErrors() for now.
        // Phase 2+ will extract updateProgram() + diagnostic collection here.
        return [];
    }

    async getAutoFixes(_filePath: string, _error: NrekiStructuredError): Promise<BackendFix[]> {
        // STUB: Real healing lives in NrekiKernel.attemptAutoHealing() for now.
        // Phase 2+ will extract getCodeFixesAtPosition() here.
        return [];
    }

    async extractCanonicalTypes(_files: Set<string>): Promise<Map<string, Map<string, PreEditContract>>> {
        // STUB: Real TTRD lives in NrekiKernel.extractCanonicalTypes() for now.
        // Phase 2+ will extract TypeChecker type walking here.
        return new Map();
    }

    async shutdown(): Promise<void> {
        // STUB: TypeScript backend is in-process. Nothing to kill.
        // In LSP backends, this would be kill -9 on the child process.
    }

    isHealthy(): boolean {
        // In-process TypeScript compiler can't crash independently.
        return true;
    }
}
