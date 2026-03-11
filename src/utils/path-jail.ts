/**
 * path-jail.ts — Path traversal protection for TokenGuard.
 *
 * Ensures all file paths resolve within the workspace root,
 * preventing directory traversal attacks (e.g., ../../etc/passwd),
 * symlink escapes, and access to sensitive files.
 */

import fs from "fs";
import path from "path";

// ─── Sensitive File Blocklist ───────────────────────────────────────

const SENSITIVE_PATTERNS: RegExp[] = [
    /\.env($|\.)/i,                     // .env, .env.local, .env.production
    /[/\\]\.ssh[/\\]/i,                 // .ssh/*
    /[/\\]\.gnupg[/\\]/i,              // .gnupg/*
    /[/\\]\.aws[/\\]/i,                // .aws/*
    /id_rsa/i,                          // SSH RSA keys
    /id_ed25519/i,                      // SSH Ed25519 keys
    /\.pem$/i,                          // PEM certificates/keys
    /\.key$/i,                          // Private key files
    /[/\\]\.npmrc$/i,                   // npm auth tokens
    /[/\\]\.pypirc$/i,                  // PyPI auth tokens
    /[/\\]\.git[/\\]credentials$/i,     // Git credential store
    /[/\\]\.git[/\\]config$/i,          // Git config (may contain tokens)
];

/**
 * Check if a file path matches known sensitive file patterns.
 * These files should never be read/written by an LLM tool.
 */
export function isSensitivePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return SENSITIVE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Resolve and validate a file path, ensuring it stays within the workspace root.
 *
 * Security layers:
 *   1. Path traversal check (../ sequences)
 *   2. Symlink resolution (prevents symlink escapes)
 *   3. Sensitive file blocklist (.env, .ssh, .pem, etc.)
 *
 * @param workspaceRoot - The allowed root directory
 * @param inputPath - User-supplied file path (relative or absolute)
 * @returns The resolved absolute path within the workspace
 * @throws Error if the path resolves outside the workspace root or is sensitive
 */
export function safePath(workspaceRoot: string, inputPath: string): string {
    // Normalize backslashes to forward slashes so traversal detection works on Linux/macOS
    const normalized = inputPath.replace(/\\/g, "/");
    const resolved = path.resolve(workspaceRoot, normalized);
    const resolvedRoot = path.resolve(workspaceRoot);

    if (!resolved.startsWith(resolvedRoot)) {
        throw new Error(`Path traversal blocked: ${inputPath}`);
    }

    // Resolve symlinks to detect symlink escapes
    try {
        const realPath = fs.realpathSync(resolved);
        if (!realPath.startsWith(resolvedRoot)) {
            throw new Error(`Symlink escape blocked: ${inputPath} resolves outside workspace`);
        }
    } catch (err) {
        // File doesn't exist yet (e.g., new file creation) — skip symlink check
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }

    // Block access to sensitive files
    if (isSensitivePath(resolved)) {
        throw new Error(`Access to sensitive file blocked: ${inputPath}`);
    }

    return resolved;
}
