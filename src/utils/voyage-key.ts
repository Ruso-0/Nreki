/**
 * voyage-key.ts — the user's Voyage API key, saved by `nreki init`.
 *
 * Stored outside every project, next to the trust key (~/.nreki/voyage.key,
 * 0600), so it is never committed and reaches NREKI whatever environment an MCP
 * host passes to its servers (Codex, for one, forwards only listed variables).
 * An environment variable (NREKI_VOYAGE_API_KEY, then VOYAGE_API_KEY) still
 * wins. Having a key does not turn Voyage on: a project opts in with
 * NREKI_SEMANTIC=voyage (see search/voyage.ts).
 */

import fs from "fs";
import path from "path";
import { trustDir } from "./trust.js";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
/** Printable ASCII without spaces: what a Voyage key ("pa-…") looks like. */
const KEY_SHAPE = /^[\x21-\x7e]{8,256}$/;

export function voyageKeyFile(): string {
    return path.join(trustDir(), "voyage.key");
}

/** The saved key, or null (missing, unreadable, linked, or not key-shaped). Never throws. */
export function readSavedVoyageKey(): string | null {
    const file = voyageKeyFile();
    try {
        if (fs.lstatSync(file).isSymbolicLink()) return null;
        const key = fs.readFileSync(file, "utf8").trim();
        return KEY_SHAPE.test(key) ? key : null;
    } catch {
        return null;
    }
}

/** Save the key (0600, written to a fresh temp file then renamed; never through a link). */
export function saveVoyageKey(key: string): string {
    const value = key.trim();
    if (!KEY_SHAPE.test(value)) throw new Error("that does not look like a Voyage API key");
    const dir = trustDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link: not writing a key through it`);
    const file = voyageKeyFile();
    try {
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a link: not writing a key through it`);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, value + "\n", { flag: "wx", mode: 0o600 });
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    return file;
}

/** The key NREKI would use: environment first, then the saved file. */
export function availableVoyageKey(env: NodeJS.ProcessEnv = process.env): { key: string; source: "env" | "file" } | null {
    const fromEnv = (env.NREKI_VOYAGE_API_KEY || env.VOYAGE_API_KEY || "").trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    const saved = readSavedVoyageKey();
    return saved ? { key: saved, source: "file" } : null;
}

export type VoyageKeyCheck = { status: "valid" } | { status: "invalid"; httpStatus: number } | { status: "unreachable"; reason: string };

/** Ask Voyage whether the key works (one tiny embedding request). Never throws. */
export async function checkVoyageKey(
    key: string,
    model: string = (process.env.NREKI_VOYAGE_MODEL || "voyage-code-4").trim(),
    fetchImpl: typeof fetch = fetch,
): Promise<VoyageKeyCheck> {
    try {
        const res = await fetchImpl(VOYAGE_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
            body: JSON.stringify({ input: ["ping"], model }),
            signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { status: "valid" };
        if (res.status === 401 || res.status === 403) return { status: "invalid", httpStatus: res.status };
        return { status: "unreachable", reason: `HTTP ${res.status}` };
    } catch (err) {
        return { status: "unreachable", reason: (err as Error).message };
    }
}
