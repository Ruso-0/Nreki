/**
 * undo.ts - Auto-rollback and revert for applied edits (nreki_code action:"edit").
 *
 * Before any semantic edit is applied to a file, we save a backup to
 * .nreki/backups/<base64-encoded-filepath>. Only the LAST
 * backup per file is kept (not a full history).
 *
 * Reverts an applied edit afterwards by restoring the file to its state before the last edit.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { captureFileTraits, applyModeTraits } from "./utils/file-traits.js";
import { removeStateFile, unsafeWriteTarget, writeStateFile } from "./utils/path-jail.js";

// ─── Helpers ────────────────────────────────────────────────────────

/** Encode a file path as a safe filename for the backup directory. */
function encodeFilePath(filePath: string): string {
    return Buffer.from(path.resolve(filePath)).toString("base64url");
}

function getBackupsDir(projectRoot: string): string {
    return path.join(projectRoot, ".nreki", "backups");
}

export function getBackupPath(projectRoot: string, filePath: string): string {
    // AUDIT FIX: Always normalize to absolute path relative to projectRoot
    // before encoding, so "src/foo.ts" and "/abs/path/src/foo.ts" produce same key
    const normalized = path.resolve(projectRoot, filePath);
    return path.join(getBackupsDir(projectRoot), encodeFilePath(normalized));
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Save a backup of the current file content before editing.
 * Only keeps the LAST backup per file.
 * Skips binary files (non-UTF-8) to prevent silent corruption.
 */
export function saveBackup(projectRoot: string, filePath: string): void {
    // AUDIT FIX: Always resolve against projectRoot (consistent with getBackupPath)
    const resolved = path.resolve(projectRoot, filePath);

    // Whenever the CURRENT state cannot be captured, a backup left over from an
    // earlier edit must not survive: undo would silently restore a version from
    // two edits ago while claiming "state before the last edit".
    const dropStaleBackup = (): void => {
        removeStateFile(projectRoot, getBackupPath(projectRoot, filePath));
    };

    // AUDIT FIX (Patch 3): Binary check + size cap BEFORE full-file load (OOM guard).
    // Pre-fix: readFileSync(..., "utf-8") of a 2GB misdirected file crashed MCP
    // with OOM before the null-byte check fired.
    let fd: number;
    try {
        fd = fs.openSync(resolved, "r");
    } catch {
        dropStaleBackup();
        return; // File doesn't exist or permission denied
    }

    let capturable = true;
    try {
        const stats = fs.fstatSync(fd);

        // Hard cap: refuse to backup files > 100MB. No code file is ever this big;
        // hitting this means the agent pointed at a log/dump/db by mistake.
        if (stats.size > 100 * 1024 * 1024) capturable = false;

        const probeSize = Math.min(8192, stats.size);
        if (capturable && probeSize > 0) {
            const probe = new Uint8Array(probeSize);
            const bytesRead = fs.readSync(fd, probe, 0, probeSize, 0);
            for (let i = 0; i < bytesRead; i++) {
                if (probe[i] === 0) { capturable = false; break; } // Binary file — skip backup
            }
        }
    } catch {
        capturable = false;
    } finally {
        try { fs.closeSync(fd); } catch { /* already closed or invalid fd */ }
    }
    if (!capturable) {
        dropStaleBackup();
        return;
    }

    // Safe to load: non-binary, under size cap.
    let content: string;
    try {
        content = fs.readFileSync(resolved, "utf-8");
    } catch {
        dropStaleBackup();
        return;
    }

    // Throws, writing nothing, through a `.nreki` link shipped with the repository:
    // a batch then aborts before any rename (writeStateFile).
    writeStateFile(projectRoot, getBackupPath(projectRoot, filePath), content);
}

/**
 * Remember the current backups of `filePaths` so a commit that aborts after
 * saveBackup() (TOCTOU conflict, OS error) can put them back: otherwise undo
 * would point at the state the failed commit captured instead of the state
 * before the last SUCCESSFUL edit (I-03).
 */
export function snapshotBackups(projectRoot: string, filePaths: ReadonlyArray<string>): { restore: () => void } {
    const saved = filePaths.map(fp => {
        const backup = getBackupPath(projectRoot, fp);
        let content: Buffer | null = null;
        try { content = fs.readFileSync(backup); } catch { /* no previous backup */ }
        return { backup, content };
    });
    return {
        restore: () => {
            for (const { backup, content } of saved) {
                try {
                    if (content === null) removeStateFile(projectRoot, backup);
                    else writeStateFile(projectRoot, backup, content);
                } catch { /* best effort: undo then reports the newer backup */ }
            }
        },
    };
}

/**
 * Restore a file from its backup.
 * Throws a clear error if no backup exists.
 * Returns a success message.
 */
export function restoreBackup(projectRoot: string, filePath: string): string {
    return restoreBackupWithContent(projectRoot, filePath).message;
}

/**
 * Restore a file from its backup and return the restored content too.
 * Atomic (temp + rename, original permission bits kept): an interrupted
 * restore can no longer truncate the file, and the backup — the only copy of
 * the previous state — is deleted only AFTER the rename succeeded
 * (NREKI-INT-05).
 */
export function restoreBackupWithContent(projectRoot: string, filePath: string): { message: string; content: string } {
    const backupPath = getBackupPath(projectRoot, filePath);
    const unsafe = unsafeWriteTarget(projectRoot, backupPath);
    if (unsafe) throw new Error(`The backup folder .nreki/backups is ${unsafe}: NREKI does not restore from it.`);

    if (!fs.existsSync(backupPath)) {
        throw new Error(
            `No backup found for "${filePath}". ` +
            `nreki_undo only works after nreki_code action:"edit" has modified a file.`
        );
    }

    const content = fs.readFileSync(backupPath, "utf-8");
    const resolved = path.resolve(projectRoot, filePath);
    const traits = captureFileTraits(resolved);
    const tmpPath = `${resolved}.nreki-undo-${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(tmpPath, content, { encoding: "utf-8", flag: "wx" });
        applyModeTraits(tmpPath, traits);
        fs.renameSync(tmpPath, resolved);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* not created */ }
        throw err;
    }

    // Remove the backup after restore (one-shot undo)
    fs.unlinkSync(backupPath);

    return {
        message: `Restored "${filePath}" to its state before the last nreki_code action:"edit".`,
        content,
    };
}
