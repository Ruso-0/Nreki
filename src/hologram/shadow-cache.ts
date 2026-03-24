/**
 * shadow-cache.ts - Disk persistence for holographic shadows.
 *
 * Persists generated .d.ts shadows between sessions so project re-scans
 * are incremental. Uses a manifest file for mtime/hash-based staleness
 * detection and a version guard to invalidate the entire cache when
 * nrekiVersion or tsVersion changes.
 *
 * Cache directory: .nreki/shadows/
 * Manifest file:   .nreki/shadows/manifest.json
 */
// NOTE: This module is the eager-scan fallback for JIT Holography (v6.1+).
// Only executes when JIT parser initialization fails. See router.ts ensureHologramReady().

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface ShadowManifest {
    nrekiVersion: string;
    tsVersion: string;
    files: Record<string, {
        mtime: number;
        hash: string;
        status: "pruned" | "unprunable" | "unprunable-forever" | "harvested";
    }>;
}

// ─── Shadow Cache ────────────────────────────────────────────────────

export class ShadowCache {
    private cacheDir: string;
    private manifestPath: string;
    private manifest: ShadowManifest;
    private shadows = new Map<string, string>();

    constructor(projectRoot: string) {
        this.cacheDir = path.join(projectRoot, ".nreki", "shadows");
        this.manifestPath = path.join(this.cacheDir, "manifest.json");
        this.manifest = { nrekiVersion: "", tsVersion: "", files: {} };
    }

    /** Load manifest from disk. Returns the in-memory shadow content map. */
    load(): Map<string, string> {
        this.shadows.clear();
        if (!fs.existsSync(this.manifestPath)) return this.shadows;

        try {
            const raw = fs.readFileSync(this.manifestPath, "utf-8");
            this.manifest = JSON.parse(raw) as ShadowManifest;
        } catch {
            this.manifest = { nrekiVersion: "", tsVersion: "", files: {} };
            return this.shadows;
        }

        // Load individual shadow files
        for (const [tsPath, entry] of Object.entries(this.manifest.files)) {
            if (entry.status === "pruned" || entry.status === "harvested") {
                const shadowPath = this.getShadowFilePath(tsPath);
                if (fs.existsSync(shadowPath)) {
                    try {
                        this.shadows.set(tsPath, fs.readFileSync(shadowPath, "utf-8"));
                    } catch { /* skip corrupted shadow */ }
                }
            }
        }

        return this.shadows;
    }

    /** Persist manifest and all shadow content to disk. */
    save(shadows: Map<string, string>): void {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        // Write individual shadow files
        for (const [tsPath, content] of shadows) {
            const shadowPath = this.getShadowFilePath(tsPath);
            const dir = path.dirname(shadowPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(shadowPath, content, "utf-8");
        }

        // Write manifest
        fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), "utf-8");
    }

    /** Set or update a shadow entry. */
    setShadow(
        tsPath: string,
        content: string,
        status: "pruned" | "unprunable" | "unprunable-forever" | "harvested",
    ): void {
        const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        let mtime = 0;
        try {
            mtime = fs.statSync(path.normalize(tsPath)).mtimeMs;
        } catch { /* file may not exist */ }

        this.manifest.files[tsPath] = { mtime, hash, status };
        this.shadows.set(tsPath, content);
    }

    /** Get cached shadow content from the in-memory map. */
    getShadow(tsPath: string): string | undefined {
        const entry = this.manifest.files[tsPath];
        if (!entry || (entry.status !== "pruned" && entry.status !== "harvested")) {
            return undefined;
        }
        return this.shadows.get(tsPath);
    }

    /** Get files whose mtime has changed since last scan. */
    getStaleFiles(currentMtimes: Map<string, number>): string[] {
        const stale: string[] = [];
        for (const [tsPath, entry] of Object.entries(this.manifest.files)) {
            const currentMtime = currentMtimes.get(tsPath);
            if (currentMtime === undefined) {
                // File was deleted
                stale.push(tsPath);
            } else if (Math.abs(currentMtime - entry.mtime) > 1) {
                // mtime changed (1ms tolerance for filesystem precision)
                stale.push(tsPath);
            }
        }
        // Also add files not in manifest (new files)
        for (const tsPath of currentMtimes.keys()) {
            if (!(tsPath in this.manifest.files)) {
                stale.push(tsPath);
            }
        }
        return stale;
    }

    /** Mark a file as permanently unprunable (e.g., TS4023 errors). */
    markAsUnprunableForever(tsPath: string): void {
        const existing = this.manifest.files[tsPath];
        if (existing) {
            existing.status = "unprunable-forever";
        } else {
            this.manifest.files[tsPath] = { mtime: 0, hash: "", status: "unprunable-forever" };
        }
    }

    /** Check if a file is marked as permanently unprunable. */
    isUnprunableForever(tsPath: string): boolean {
        return this.manifest.files[tsPath]?.status === "unprunable-forever";
    }

    /** Get the current manifest. */
    getManifest(): ShadowManifest {
        return this.manifest;
    }

    /** Set version info. Clears cache if versions don't match. */
    setVersions(nrekiVersion: string, tsVersion: string): boolean {
        if (
            this.manifest.nrekiVersion &&
            (this.manifest.nrekiVersion !== nrekiVersion || this.manifest.tsVersion !== tsVersion)
        ) {
            this.clear();
            this.manifest.nrekiVersion = nrekiVersion;
            this.manifest.tsVersion = tsVersion;
            return true; // Cache was invalidated
        }
        this.manifest.nrekiVersion = nrekiVersion;
        this.manifest.tsVersion = tsVersion;
        return false;
    }

    /** Clear entire cache (version guard triggered). */
    clear(): void {
        this.manifest = {
            nrekiVersion: this.manifest.nrekiVersion,
            tsVersion: this.manifest.tsVersion,
            files: {},
        };
        this.shadows.clear();
        // Remove shadow files from disk
        if (fs.existsSync(this.cacheDir)) {
            try {
                fs.rmSync(this.cacheDir, { recursive: true, force: true });
                fs.mkdirSync(this.cacheDir, { recursive: true });
            } catch { /* best effort */ }
        }
    }

    // ─── Private ─────────────────────────────────────────────────────

    private getShadowFilePath(tsPath: string): string {
        // Use hash of tsPath for flat storage to avoid deep directory trees
        const hash = crypto.createHash("sha256").update(tsPath).digest("hex").slice(0, 16);
        return path.join(this.cacheDir, `${hash}.d.ts`);
    }
}
