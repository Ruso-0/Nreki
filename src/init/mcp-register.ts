/**
 * init/mcp-register.ts — register NREKI as an MCP server in the project
 * config each agent reads, with the project folder pinned.
 *
 * NREKI indexes the folder it starts in. Where each host starts a project
 * server (measured or documented on 2026-11-26):
 *   - Claude Code (.mcp.json): in the project.
 *   - Antigravity (.agents/mcp_config.json): in the project (measured; a
 *     global plugin's server starts in the plugin folder instead).
 *   - Codex (.codex/config.toml): documented `cwd` field, set here. Codex reads
 *     this file only for trusted projects.
 *   - Cursor (.cursor/mcp.json) and VS Code (.vscode/mcp.json): undocumented, so
 *     the entry passes NREKI_PROJECT_ROOT (see project-root.ts).
 *
 * Every entry pins `nreki@<version>`, the version that wrote the instructions.
 * An entry NREKI wrote (its args launch `nreki` or `nreki@x`) is updated in
 * place, keeping fields the user added; an entry named `nreki` that NREKI did
 * not write is left alone unless --force. Never writes through a link.
 */

import fs from "fs";
import path from "path";
import { unsafeWriteTarget } from "../utils/path-jail.js";

export type McpHost = "claude" | "codex" | "antigravity" | "cursor" | "copilot";

export const MCP_HOSTS: readonly McpHost[] = ["claude", "codex", "antigravity", "cursor", "copilot"];

/** Project-relative config file each host reads. */
export const MCP_CONFIG_PATH: Record<McpHost, string> = {
    claude: ".mcp.json",
    codex: path.join(".codex", "config.toml"),
    antigravity: path.join(".agents", "mcp_config.json"),
    cursor: path.join(".cursor", "mcp.json"),
    copilot: path.join(".vscode", "mcp.json"),
};

export interface McpRegisterOptions {
    /** Project root (absolute). */
    cwd: string;
    /** NREKI version pinned in the launch command. */
    version: string;
    /** true: set NREKI_SEMANTIC=voyage; false: remove it; undefined: keep what is there. */
    voyage?: boolean;
    /** Replace an entry named `nreki` that NREKI did not write. */
    force?: boolean;
    dryRun?: boolean;
    platform?: NodeJS.Platform;
}

export interface McpAction {
    path: string;
    op: "created" | "merged" | "rewritten" | "skipped" | "removed";
    note?: string;
}

/** How a host launches NREKI. On Windows npx is a .cmd shim, so it goes through cmd /c. */
export function launchCommand(version: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
    const spec = `nreki@${version}`;
    return platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", "-y", spec] }
        : { command: "npx", args: ["-y", spec] };
}

const NREKI_SPEC = /^nreki(@\S+)?$/;

/** True when a JSON entry's args launch the published nreki package. */
function launchesNreki(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") return false;
    const args = (entry as { args?: unknown }).args;
    return Array.isArray(args) && args.some((a) => typeof a === "string" && NREKI_SPEC.test(a));
}

/** JSON with sorted keys, for "is this already what we would write" checks. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Remove `dir` and its parents while they are empty, stopping at the project
 * root (never removed) and at the first folder that still holds something.
 */
export function removeEmptyDirs(cwd: string, dir: string): void {
    const root = path.resolve(cwd);
    let current = path.resolve(dir);
    while (current !== root && current.startsWith(root + path.sep)) {
        try {
            if (fs.lstatSync(current).isSymbolicLink() || fs.readdirSync(current).length > 0) return;
            fs.rmdirSync(current);
        } catch {
            return;
        }
        current = path.dirname(current);
    }
}

function writeText(abs: string, text: string): void {
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, text, "utf-8");
}

// ─── JSON hosts (claude, antigravity, cursor, copilot) ─────────────────────

type JsonHost = Exclude<McpHost, "codex">;

function rootKeyOf(host: JsonHost): "mcpServers" | "servers" {
    return host === "copilot" ? "servers" : "mcpServers";
}

/** The entry NREKI writes for a JSON host, before merging with an existing one. */
function freshJsonEntry(host: JsonHost, opts: McpRegisterOptions): Record<string, unknown> {
    const { command, args } = launchCommand(opts.version, opts.platform);
    const entry: Record<string, unknown> = host === "claude" || host === "copilot"
        ? { type: "stdio", command, args }
        : { command, args };
    const env: Record<string, string> = {};
    if (host === "cursor") env.NREKI_PROJECT_ROOT = path.resolve(opts.cwd);
    if (host === "copilot") env.NREKI_PROJECT_ROOT = "${workspaceFolder}";
    if (opts.voyage === true) env.NREKI_SEMANTIC = "voyage";
    if (Object.keys(env).length > 0) entry.env = env;
    return entry;
}

/** Overlay NREKI's fields on an entry it wrote before, keeping the user's additions. */
function mergeJsonEntry(existing: Record<string, unknown>, fresh: Record<string, unknown>, voyage: boolean | undefined): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...existing, ...fresh };
    const env: Record<string, unknown> = {
        ...(isPlainObject(existing.env) ? existing.env : {}),
        ...(isPlainObject(fresh.env) ? fresh.env : {}),
    };
    if (voyage === false) delete env.NREKI_SEMANTIC;
    if (Object.keys(env).length > 0) merged.env = env;
    else delete merged.env;
    return merged;
}

function readJson(abs: string): { text: string; doc: Record<string, unknown> } | { text: string; error: string } {
    const text = fs.readFileSync(abs, "utf-8");
    try {
        const parsed = JSON.parse(text.replace(/^﻿/, "")) as unknown;
        if (!isPlainObject(parsed)) return { text, error: "is not a JSON object" };
        return { text, doc: parsed };
    } catch {
        return { text, error: "is not valid JSON (comments are not supported)" };
    }
}

function serializeJson(doc: unknown, previous: string | null): string {
    const eol = previous !== null && previous.includes("\r\n") ? "\r\n" : "\n";
    return JSON.stringify(doc, null, 2).replace(/\n/g, eol) + eol;
}

function registerJson(host: JsonHost, opts: McpRegisterOptions): McpAction {
    const rel = MCP_CONFIG_PATH[host];
    const abs = path.join(opts.cwd, rel);
    const unsafe = unsafeWriteTarget(opts.cwd, rel);
    if (unsafe) return { path: rel, op: "skipped", note: `${unsafe}: not touched` };

    const rootKey = rootKeyOf(host);
    const fresh = freshJsonEntry(host, opts);
    let previous: string | null = null;
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(abs)) {
        const read = readJson(abs);
        if ("error" in read) {
            return {
                path: rel,
                op: "skipped",
                note: `${read.error}; add this by hand: ${JSON.stringify({ [rootKey]: { nreki: fresh } })}`,
            };
        }
        previous = read.text;
        doc = read.doc;
    }

    const servers = doc[rootKey];
    if (servers !== undefined && !isPlainObject(servers)) {
        return { path: rel, op: "skipped", note: `"${rootKey}" is not an object; not touched` };
    }
    const existing = isPlainObject(servers) ? servers.nreki : undefined;

    let next: Record<string, unknown>;
    let op: McpAction["op"];
    if (existing !== undefined) {
        const ours = isPlainObject(existing) && launchesNreki(existing);
        if (!ours && !opts.force) {
            return { path: rel, op: "skipped", note: "a \"nreki\" entry NREKI did not write is present (use --force to replace it)" };
        }
        next = ours ? mergeJsonEntry(existing as Record<string, unknown>, fresh, opts.voyage) : fresh;
        if (canonical(existing) === canonical(next)) {
            return { path: rel, op: "skipped", note: `already registered (nreki@${opts.version})` };
        }
        op = "rewritten";
    } else {
        next = fresh;
        op = previous === null ? "created" : "merged";
    }

    if (!opts.dryRun) {
        const out = { ...doc, [rootKey]: { ...(isPlainObject(servers) ? servers : {}), nreki: next } };
        writeText(abs, serializeJson(out, previous));
    }
    return { path: rel, op, note: op === "rewritten" ? `updated to nreki@${opts.version}` : undefined };
}

function unregisterJson(host: JsonHost, cwd: string, dryRun: boolean): McpAction | null {
    const rel = MCP_CONFIG_PATH[host];
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) return null;
    const unsafe = unsafeWriteTarget(cwd, rel);
    if (unsafe) return { path: rel, op: "skipped", note: `${unsafe}: not touched` };
    const read = readJson(abs);
    if ("error" in read) return null;
    const rootKey = rootKeyOf(host);
    const servers = read.doc[rootKey];
    if (!isPlainObject(servers) || !launchesNreki(servers.nreki)) return null;

    const rest = { ...servers };
    delete rest.nreki;
    const doc = { ...read.doc, [rootKey]: rest };
    // The file only held NREKI's entry: it was written by `nreki init`, remove it.
    const onlyOurs = Object.keys(rest).length === 0 && Object.keys(read.doc).length === 1;
    if (!dryRun) {
        if (onlyOurs) {
            fs.unlinkSync(abs);
            removeEmptyDirs(cwd, path.dirname(abs));
        } else {
            fs.writeFileSync(abs, serializeJson(doc, read.text), "utf-8");
        }
    }
    return { path: rel, op: "removed", note: onlyOurs ? "file deleted (it only held nreki)" : "nreki entry removed" };
}

// ─── TOML host (codex) ─────────────────────────────────────────────────────

const CODEX_MARKER = "# nreki: added by `nreki init`";
const CODEX_MANAGED = new Set(["command", "args", "cwd", "startup_timeout_sec", "tool_timeout_sec", "env_vars"]);
const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** TOML basic string: JSON string escapes are valid TOML. */
function tomlString(s: string): string {
    return JSON.stringify(s);
}

/** Normalized table name, or null when the line is not a table header. */
function tableName(line: string): string | null {
    const m = TABLE_HEADER.exec(line);
    if (!m) return null;
    return m[1].replace(/\s+/g, "").replace(/(^|\.)(["'])([^"']*)\2(?=\.|$)/g, "$1$3");
}

function isNrekiTable(name: string): boolean {
    return name === "mcp_servers.nreki" || name.startsWith("mcp_servers.nreki.");
}

/** Net bracket depth of a TOML line, ignoring brackets inside strings and comments. */
function bracketDelta(line: string): number {
    const code = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/#.*$/, "");
    let d = 0;
    for (const ch of code) {
        if (ch === "[" || ch === "{") d++;
        else if (ch === "]" || ch === "}") d--;
    }
    return d;
}

interface ParsedEntries { entries: Array<{ key: string; lines: string[] }>; }

/** Split a table body into key = value entries (values may span lines). */
function parseEntries(body: string[]): ParsedEntries {
    const entries: ParsedEntries["entries"] = [];
    let depth = 0;
    for (const line of body) {
        if (depth > 0) {
            entries[entries.length - 1].lines.push(line);
            depth += bracketDelta(line);
            continue;
        }
        const m = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
        if (!m) {
            if (line.trim()) entries.push({ key: "", lines: [line] }); // comment: kept as is
            continue;
        }
        entries.push({ key: m[1].replace(/^["']|["']$/g, ""), lines: [line] });
        depth = bracketDelta(line);
    }
    return { entries };
}

interface CodexScan {
    lines: string[];
    eol: string;
    /** Index range of every nreki table (header included), plus our marker line. */
    ranges: Array<{ start: number; end: number; name: string }>;
    /** nreki defined as a dotted key or inline table: not editable here. */
    foreign: boolean;
}

function scanCodex(text: string): CodexScan {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const ranges: CodexScan["ranges"] = [];
    let foreign = false;
    let current: string | null = "";
    for (let i = 0; i < lines.length; i++) {
        const name = tableName(lines[i]);
        if (name !== null) {
            current = name;
            if (isNrekiTable(name)) {
                let start = i;
                if (ranges.length === 0 && i > 0 && lines[i - 1].startsWith(CODEX_MARKER)) start = i - 1;
                let end = i + 1;
                while (end < lines.length && tableName(lines[end]) === null) end++;
                ranges.push({ start, end, name });
                i = end - 1;
            }
            continue;
        }
        const keyLine = lines[i].trim();
        if (current === "" && /^mcp_servers\s*\.\s*["']?nreki["']?\s*[.=]/.test(keyLine)) foreign = true;
        if (current === "mcp_servers" && /^["']?nreki["']?\s*[.=]/.test(keyLine)) foreign = true;
    }
    return { lines, eol, ranges, foreign };
}

function codexSection(opts: McpRegisterOptions, keptMain: string[], envLines: string[], subtables: string[][]): string[] {
    const { command, args } = launchCommand(opts.version, opts.platform);
    const out = [
        `${CODEX_MARKER}. cwd pins the project NREKI indexes; Codex reads this file only for trusted projects.`,
        "[mcp_servers.nreki]",
        `command = ${tomlString(command)}`,
        `args = [${args.map(tomlString).join(", ")}]`,
        `cwd = ${tomlString(path.resolve(opts.cwd))}`,
        "startup_timeout_sec = 120",
        "tool_timeout_sec = 120",
        `env_vars = ["NREKI_VOYAGE_API_KEY", "VOYAGE_API_KEY"]`,
        ...keptMain,
    ];
    if (envLines.length > 0) out.push("", "[mcp_servers.nreki.env]", ...envLines);
    for (const table of subtables) out.push("", ...table);
    return out;
}

function registerCodex(opts: McpRegisterOptions): McpAction {
    const rel = MCP_CONFIG_PATH.codex;
    const abs = path.join(opts.cwd, rel);
    const unsafe = unsafeWriteTarget(opts.cwd, rel);
    if (unsafe) return { path: rel, op: "skipped", note: `${unsafe}: not touched` };

    const previous = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8").replace(/^﻿/, "") : null;
    const scan = scanCodex(previous ?? "");
    if (scan.foreign) {
        return { path: rel, op: "skipped", note: "nreki is defined as an inline table or dotted key; edit it by hand" };
    }

    const keptMain: string[] = [];
    const envLines: string[] = [];
    const subtables: string[][] = [];
    if (scan.ranges.length > 0) {
        const sectionText = scan.ranges.map((r) => scan.lines.slice(r.start, r.end).join("\n")).join("\n");
        const ours = /["']nreki(@[^"'\s]*)?["']/.test(sectionText);
        if (!ours && !opts.force) {
            return { path: rel, op: "skipped", note: "a [mcp_servers.nreki] table NREKI did not write is present (use --force to replace it)" };
        }
        if (ours) {
            for (const r of scan.ranges) {
                const headerAt = scan.lines.slice(r.start, r.end).findIndex((l) => tableName(l) !== null) + r.start;
                const body = scan.lines.slice(headerAt + 1, r.end).filter((l, idx, arr) => !(l.trim() === "" && idx === arr.length - 1));
                if (r.name === "mcp_servers.nreki") {
                    for (const e of parseEntries(body).entries) {
                        if (e.key && CODEX_MANAGED.has(e.key)) continue;
                        keptMain.push(...e.lines);
                    }
                } else if (r.name === "mcp_servers.nreki.env") {
                    for (const e of parseEntries(body).entries) {
                        if (e.key === "NREKI_SEMANTIC" && opts.voyage !== undefined) continue;
                        envLines.push(...e.lines);
                    }
                } else {
                    subtables.push(scan.lines.slice(headerAt, r.end).filter((l, idx, arr) => !(l.trim() === "" && idx === arr.length - 1)));
                }
            }
        }
    }
    if (opts.voyage === true) envLines.unshift(`NREKI_SEMANTIC = "voyage"`);

    const section = codexSection(opts, keptMain.filter((l) => l.trim() !== ""), envLines, subtables);
    let outLines: string[];
    if (scan.ranges.length > 0) {
        const first = scan.ranges[0].start;
        const removed = new Set<number>();
        for (const r of scan.ranges) for (let i = r.start; i < r.end; i++) removed.add(i);
        outLines = [];
        for (let i = 0; i < scan.lines.length; i++) {
            if (i === first) {
                outLines.push(...section);
                // keep one blank line between our section and the next table
                if (i < scan.lines.length && scan.ranges[scan.ranges.length - 1].end < scan.lines.length) outLines.push("");
            }
            if (!removed.has(i)) outLines.push(scan.lines[i]);
        }
        // collapse a blank line we might have doubled
        outLines = outLines.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
    } else {
        outLines = [...scan.lines];
        while (outLines.length > 0 && outLines[outLines.length - 1].trim() === "") outLines.pop();
        if (outLines.length > 0) outLines.push("");
        outLines.push(...section);
    }
    const next = outLines.join(scan.eol) + scan.eol;

    if (previous !== null && next === (previous.endsWith("\n") ? previous : previous + scan.eol)) {
        return { path: rel, op: "skipped", note: `already registered (nreki@${opts.version})` };
    }
    if (!opts.dryRun) writeText(abs, next);
    const op: McpAction["op"] = previous === null ? "created" : scan.ranges.length > 0 ? "rewritten" : "merged";
    return { path: rel, op, note: op === "rewritten" ? `updated to nreki@${opts.version}` : undefined };
}

function unregisterCodex(cwd: string, dryRun: boolean): McpAction | null {
    const rel = MCP_CONFIG_PATH.codex;
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) return null;
    const unsafe = unsafeWriteTarget(cwd, rel);
    if (unsafe) return { path: rel, op: "skipped", note: `${unsafe}: not touched` };
    const text = fs.readFileSync(abs, "utf-8").replace(/^﻿/, "");
    const scan = scanCodex(text);
    if (scan.ranges.length === 0) return null;
    const sectionText = scan.ranges.map((r) => scan.lines.slice(r.start, r.end).join("\n")).join("\n");
    if (!/["']nreki(@[^"'\s]*)?["']/.test(sectionText)) return null;
    const removed = new Set<number>();
    for (const r of scan.ranges) for (let i = r.start; i < r.end; i++) removed.add(i);
    const rest = scan.lines.filter((_, i) => !removed.has(i));
    while (rest.length > 0 && rest[rest.length - 1].trim() === "") rest.pop();
    const empty = rest.every((l) => l.trim() === "");
    if (!dryRun) {
        if (empty) {
            fs.unlinkSync(abs);
            removeEmptyDirs(cwd, path.dirname(abs));
        } else {
            fs.writeFileSync(abs, rest.join(scan.eol) + scan.eol, "utf-8");
        }
    }
    return { path: rel, op: "removed", note: empty ? "file deleted (it only held nreki)" : "[mcp_servers.nreki] removed" };
}

// ─── Public API ────────────────────────────────────────────────────────────

export function registerMcp(host: McpHost, opts: McpRegisterOptions): McpAction {
    return host === "codex" ? registerCodex(opts) : registerJson(host, opts);
}

/** Remove the entry NREKI wrote for `host`. Null when there is none. */
export function unregisterMcp(host: McpHost, cwd: string, dryRun = false): McpAction | null {
    return host === "codex" ? unregisterCodex(cwd, dryRun) : unregisterJson(host, cwd, dryRun);
}

export function isMcpHost(agent: string): agent is McpHost {
    return (MCP_HOSTS as readonly string[]).includes(agent);
}
