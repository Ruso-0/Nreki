/**
 * init/global-register.ts — User-scoped (global) installation of NREKI across
 * Claude Code, Antigravity, Cursor, Codex, and VS Code / Copilot.
 *
 * Why user scope matters:
 *   - Claude Code: `~/.claude.json` top-level `mcpServers` loads across EVERY
 *     project with zero `.mcp.json` repo-approval prompts, alongside global
 *     `~/.claude/CLAUDE.md`, skill, and PreToolUse hook.
 *   - Antigravity: `~/.gemini/config/plugins/nreki/` bundles `plugin.json`,
 *     `mcp_config.json`, `rules/AGENTS.md`, `skills/`, and `assets/logo.svg`
 *     into a global plugin that Antigravity discovers enabled by default.
 *   - Cursor: `~/.cursor/mcp.json` + `~/.cursor/rules/nreki.mdc` apply across
 *     all Cursor workspaces.
 *   - Codex: `~/.codex/config.toml` + `~/.codex/AGENTS.md` apply across all
 *     projects without requiring per-folder `.codex` trust first.
 *   - Copilot / VS Code: `Code/User/mcp.json` registers NREKI globally with
 *     `NREKI_PROJECT_ROOT=${workspaceFolder}`.
 *
 * Security invariants:
 *   - Every target path is verified to stay inside `home` without traversing
 *     any symbolic link (`unsafeHomeTarget`).
 *   - Existing user content, sibling MCP servers, extra fields, and CRLF line
 *     endings are preserved.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { DetectedAgent } from "./agent-detect.js";
import { launchCommand, type McpAction, type McpHost } from "./mcp-register.js";
import { hookVersion } from "./hook-upgrade.js";

export type GlobalAgent = McpHost;

export const GLOBAL_AGENTS: readonly GlobalAgent[] = [
    "claude",
    "codex",
    "antigravity",
    "cursor",
    "copilot",
];

export interface GlobalRegisterOptions {
    /** User home directory. Defaults to os.homedir(). */
    home?: string;
    /** Version pinned in MCP launch commands. */
    version: string;
    /** true = set NREKI_SEMANTIC=voyage; false = remove it; undefined = preserve. */
    voyage?: boolean;
    /** Overwrite foreign `nreki` entries and rewrite NREKI blocks. */
    force?: boolean;
    /** Report planned actions without touching disk. */
    dryRun?: boolean;
    /** Target platform (defaults to process.platform). */
    platform?: NodeJS.Platform;
}

/**
 * Tools whose PreToolUse runs NREKI's enforcer hook. Bash and PowerShell (v6):
 * the hook measures only a plain whole-file dump of a code file (`cat big.ts`,
 * `Get-Content big.ts`) and lets every other command pass.
 */
export const CLAUDE_HOOK_TOOLS: readonly string[] = [
    "Read", "ReadFile", "View", "ViewFile", "Write", "WriteFile", "Edit", "EditFile", "MultiEdit", "Replace",
    "Bash", "PowerShell",
];

const BLOCK_BEGIN = "<!-- nreki:begin -->";
const BLOCK_END = "<!-- nreki:end -->";
const NREKI_SPEC = /^nreki(@\S+)?$/;
const CODEX_GLOBAL_MARKER = "# nreki: added globally by `nreki init`";
const CODEX_ANY_MARKER = /^# nreki: added(?: globally)? by `nreki init`/;
const CODEX_MANAGED = new Set(["command", "args", "cwd", "startup_timeout_sec", "tool_timeout_sec", "env_vars"]);
const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

const ANTIGRAVITY_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" fill="none">
  <path d="M64 16L22 34V62C22 88.5 39.9 109.8 64 116C88.1 109.8 106 88.5 106 62V34L64 16Z" fill="#0F172A" stroke="#38BDF8" stroke-width="6" stroke-linejoin="round"/>
  <path d="M46 65L58 77L84 50" stroke="#22C55E" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

function templatesDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "..", "templates");
}

function readTemplate(rel: string): string {
    return fs.readFileSync(path.join(templatesDir(), rel), "utf-8");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function launchesNreki(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") return false;
    const args = (entry as { args?: unknown }).args;
    return Array.isArray(args) && args.some((a) => typeof a === "string" && NREKI_SPEC.test(a));
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Refuse writes that escape `home` or traverse any symbolic link/junction
 * inside `home`. Mirrors `unsafeWriteTarget` for user-scoped paths.
 */
export function unsafeHomeTarget(home: string, targetAbs: string): string | null {
    const root = path.resolve(home);
    const abs = path.resolve(targetAbs);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        return "outside the user home directory";
    }
    let cur = root;
    try {
        if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) return "home directory is a symbolic link";
    } catch { /* ignore */ }
    for (const part of rel.split(path.sep).filter(Boolean)) {
        cur = path.join(cur, part);
        try {
            if (fs.lstatSync(cur).isSymbolicLink()) return "symbolic link";
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
            return "unreadable path";
        }
    }
    return null;
}

function displayHomePath(home: string, abs: string): string {
    const rel = path.relative(path.resolve(home), path.resolve(abs)).replace(/\\/g, "/");
    return `~/${rel}`;
}

/** Resolve VS Code's global User directory inside `home`. */
export function vscodeUserDir(
    home: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string {
    const resolvedHome = path.resolve(home);
    if (platform === "win32") {
        // Only honor %APPDATA% when operating on the real OS home directory and
        // %APPDATA% lives inside it; isolated test homes stay self-contained.
        const realHome = path.resolve(os.homedir());
        const appData = env.APPDATA ? path.resolve(env.APPDATA) : "";
        if (
            resolvedHome.toLowerCase() === realHome.toLowerCase() &&
            appData &&
            appData.toLowerCase().startsWith(realHome.toLowerCase() + path.sep)
        ) {
            return path.join(appData, "Code", "User");
        }
        return path.join(resolvedHome, "AppData", "Roaming", "Code", "User");
    }
    if (platform === "darwin") {
        return path.join(resolvedHome, "Library", "Application Support", "Code", "User");
    }
    return path.join(resolvedHome, ".config", "Code", "User");
}

/**
 * Default global target agents when a person runs `npx nreki init`:
 * Claude Code, Codex, Antigravity, and Cursor are always prepared so opening
 * any of them works immediately; VS Code / Copilot is included when VS Code is
 * present on the machine.
 */
export function defaultGlobalAgents(
    home: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): GlobalAgent[] {
    const agents: GlobalAgent[] = ["claude", "codex", "antigravity", "cursor"];
    const codeDir = path.dirname(vscodeUserDir(home, platform));
    if (fs.existsSync(codeDir) || fs.existsSync(path.join(home, ".vscode"))) {
        agents.push("copilot");
    }
    return agents;
}

function wrapBlock(content: string): string {
    return `${BLOCK_BEGIN}\n${content.replace(/\s+$/, "")}\n${BLOCK_END}\n`;
}

/** The sentinel-delimited NREKI block of `text` (sentinels included), or null. */
export function sentinelBlockOf(text: string): string | null {
    const begin = text.indexOf(BLOCK_BEGIN);
    const endTag = begin === -1 ? -1 : text.indexOf(BLOCK_END, begin);
    return begin === -1 || endTag === -1 ? null : text.slice(begin, endTag + BLOCK_END.length);
}

/** Equal once line endings and trailing blanks are ignored. */
export function sameText(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    return norm(a) === norm(b);
}

function replaceSentinelBlock(current: string, marker: string, replacement: string): string | null {
    const begin = current.indexOf(BLOCK_BEGIN);
    const endTag = begin === -1 ? -1 : current.indexOf(BLOCK_END, begin);
    if (begin !== -1 && endTag !== -1) {
        let end = endTag + BLOCK_END.length;
        if (current[end] === "\r") end++;
        if (current[end] === "\n") end++;
        return current.slice(0, begin) + replacement + current.slice(end);
    }
    const at = current.indexOf(marker);
    if (at === -1) return null;
    const start = current.lastIndexOf("\n", at) + 1;
    let end = current.indexOf("\n", at);
    end = end === -1 ? current.length : end + 1;
    while (end < current.length) {
        let next = current.indexOf("\n", end);
        next = next === -1 ? current.length : next + 1;
        const line = current.slice(end, next).replace(/\r?\n$/, "");
        if (/^#{1,6}\s/.test(line) && !/^##\s+\d+\./.test(line)) break;
        end = next;
    }
    return current.slice(0, start) + replacement + current.slice(end);
}

function upsertMarkdownBlock(
    home: string,
    abs: string,
    content: string,
    marker: string,
    force: boolean,
    dryRun: boolean,
): McpAction {
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    const block = wrapBlock(content);
    if (fs.existsSync(abs)) {
        const current = fs.readFileSync(abs, "utf-8");
        const hasMarker = current.includes(marker);
        if (hasMarker && !force) {
            // Between NREKI's sentinels the text is NREKI's: bring it up to date.
            // Without --force an upgrade used to keep the old instructions forever.
            const existing = sentinelBlockOf(current);
            if (existing === null || sameText(existing, block)) {
                return { path: label, op: "skipped", note: "NREKI block already present" };
            }
            const replaced = replaceSentinelBlock(current, marker, block);
            if (replaced !== null) {
                if (!dryRun) fs.writeFileSync(abs, replaced, "utf-8");
                return { path: label, op: "rewritten", note: "NREKI block updated to this version; your content kept" };
            }
            return { path: label, op: "skipped", note: "NREKI block already present" };
        }
        if (hasMarker) {
            const replaced = replaceSentinelBlock(current, marker, block);
            if (replaced !== null) {
                if (!dryRun) fs.writeFileSync(abs, replaced, "utf-8");
                return { path: label, op: "rewritten", note: "NREKI block updated; your content kept" };
            }
        }
        if (!dryRun) {
            const sep = current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
            fs.appendFileSync(abs, sep + block, "utf-8");
        }
        return { path: label, op: "merged" };
    }

    if (!dryRun) {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, block, "utf-8");
    }
    return { path: label, op: "created" };
}

function removeMarkdownBlock(home: string, abs: string, markers: string[], dryRun: boolean): McpAction | null {
    if (!fs.existsSync(abs)) return null;
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    const current = fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, "");
    let stripped: string | null = null;
    for (const m of markers) {
        stripped = replaceSentinelBlock(current, m, "");
        if (stripped !== null) break;
    }
    if (stripped === null) return null;
    const rest = stripped.replace(/\s+$/, "");
    if (!dryRun) {
        if (rest === "") fs.unlinkSync(abs);
        else fs.writeFileSync(abs, rest + (current.includes("\r\n") ? "\r\n" : "\n"), "utf-8");
    }
    return { path: label, op: "removed", note: rest === "" ? "file deleted (it only held NREKI's block)" : "NREKI block removed" };
}

function writeOwnedFile(
    home: string,
    abs: string,
    content: string,
    force: boolean,
    dryRun: boolean,
    executable = false,
): McpAction {
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    if (fs.existsSync(abs)) {
        const existing = fs.readFileSync(abs, "utf-8");
        if (existing === content && !force) {
            return { path: label, op: "skipped", note: "up to date" };
        }
        // A hook written by a newer NREKI is never downgraded by an older `init`.
        const mine = hookVersion(existing);
        const theirs = hookVersion(content);
        if (!force && mine !== null && theirs !== null && mine > theirs) {
            return { path: label, op: "skipped", note: `a newer NREKI hook (v${mine}) is installed` };
        }
        if (!dryRun) {
            ensureDir(path.dirname(abs));
            fs.writeFileSync(abs, content, "utf-8");
            if (executable && process.platform !== "win32") {
                try { fs.chmodSync(abs, 0o755); } catch { /* best effort */ }
            }
        }
        return { path: label, op: "rewritten" };
    }

    if (!dryRun) {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, content, "utf-8");
        if (executable && process.platform !== "win32") {
            try { fs.chmodSync(abs, 0o755); } catch { /* best effort */ }
        }
    }
    return { path: label, op: "created" };
}

function serializeJson(doc: unknown, previous: string | null): string {
    const eol = previous !== null && previous.includes("\r\n") ? "\r\n" : "\n";
    return JSON.stringify(doc, null, 2).replace(/\n/g, eol) + eol;
}

function upsertGlobalJsonMcp(
    home: string,
    abs: string,
    rootKey: "mcpServers" | "servers",
    freshEntry: Record<string, unknown>,
    opts: GlobalRegisterOptions,
): McpAction {
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    let previous: string | null = null;
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(abs)) {
        previous = fs.readFileSync(abs, "utf-8");
        try {
            const parsed = JSON.parse(previous.replace(/^\uFEFF/, "")) as unknown;
            if (!isPlainObject(parsed)) {
                return { path: label, op: "skipped", note: "is not a JSON object; not touched" };
            }
            doc = parsed;
        } catch {
            return { path: label, op: "skipped", note: "is not valid JSON; not touched" };
        }
    }

    const servers = doc[rootKey];
    if (servers !== undefined && !isPlainObject(servers)) {
        return { path: label, op: "skipped", note: `"${rootKey}" is not an object; not touched` };
    }
    const existing = isPlainObject(servers) ? servers.nreki : undefined;

    let next: Record<string, unknown>;
    let op: McpAction["op"];
    if (existing !== undefined) {
        const ours = isPlainObject(existing) && launchesNreki(existing);
        if (!ours && !opts.force) {
            return { path: label, op: "skipped", note: "a custom \"nreki\" entry is present (use --force to replace)" };
        }
        if (ours) {
            const existingObj = existing as Record<string, unknown>;
            const merged: Record<string, unknown> = { ...existingObj, ...freshEntry };
            const env: Record<string, unknown> = {
                ...(isPlainObject(existingObj.env) ? existingObj.env : {}),
                ...(isPlainObject(freshEntry.env) ? freshEntry.env : {}),
            };
            if (opts.voyage === false) delete env.NREKI_SEMANTIC;
            if (Object.keys(env).length > 0) merged.env = env;
            else delete merged.env;
            next = merged;
        } else {
            next = freshEntry;
        }
        if (canonical(existing) === canonical(next)) {
            return { path: label, op: "skipped", note: `already registered (nreki@${opts.version})` };
        }
        op = "rewritten";
    } else {
        next = freshEntry;
        op = previous === null ? "created" : "merged";
    }

    if (!opts.dryRun) {
        ensureDir(path.dirname(abs));
        const out = { ...doc, [rootKey]: { ...(isPlainObject(servers) ? servers : {}), nreki: next } };
        fs.writeFileSync(abs, serializeJson(out, previous), "utf-8");
    }
    return { path: label, op, note: op === "rewritten" ? `updated to nreki@${opts.version}` : undefined };
}

function removeGlobalJsonMcp(
    home: string,
    abs: string,
    rootKey: "mcpServers" | "servers",
    deleteWhenEmpty: boolean,
    dryRun: boolean,
): McpAction | null {
    if (!fs.existsSync(abs)) return null;
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    const previous = fs.readFileSync(abs, "utf-8");
    let doc: Record<string, unknown>;
    try {
        const parsed = JSON.parse(previous.replace(/^\uFEFF/, "")) as unknown;
        if (!isPlainObject(parsed)) return null;
        doc = parsed;
    } catch {
        return null;
    }
    const servers = doc[rootKey];
    if (!isPlainObject(servers) || !launchesNreki(servers.nreki)) return null;

    const rest = { ...servers };
    delete rest.nreki;
    const nextDoc: Record<string, unknown> = { ...doc, [rootKey]: rest };
    if (Object.keys(rest).length === 0 && !deleteWhenEmpty) {
        delete nextDoc[rootKey];
    }
    const onlyOurs = deleteWhenEmpty && Object.keys(rest).length === 0 && Object.keys(doc).length === 1;
    if (!dryRun) {
        if (onlyOurs) fs.unlinkSync(abs);
        else fs.writeFileSync(abs, serializeJson(nextDoc, previous), "utf-8");
    }
    return { path: label, op: "removed", note: onlyOurs ? "file deleted (it only held nreki)" : "nreki entry removed" };
}

function mergeGlobalClaudeHooks(home: string, hookAbs: string, dryRun: boolean): McpAction {
    const settingsAbs = path.join(home, ".claude", "settings.json");
    const label = displayHomePath(home, settingsAbs);
    const unsafe = unsafeHomeTarget(home, settingsAbs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    interface ClaudeSettings {
        hooks?: {
            PreToolUse?: Array<{
                matcher: string;
                hooks: Array<{ type: string; command: string }>;
            }>;
        };
        [key: string]: unknown;
    }

    let previous: string | null = null;
    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsAbs)) {
        previous = fs.readFileSync(settingsAbs, "utf-8");
        try {
            const parsed = JSON.parse(previous.replace(/^\uFEFF/, "")) as unknown;
            if (!isPlainObject(parsed)) return { path: label, op: "skipped", note: "settings.json is not a JSON object" };
            settings = parsed as ClaudeSettings;
        } catch {
            return { path: label, op: "skipped", note: "settings.json is not valid JSON; refusing to overwrite" };
        }
    }

    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    const hookCommand = `node ${JSON.stringify(hookAbs.replace(/\\/g, "/"))}`;
    const tools = CLAUDE_HOOK_TOOLS;
    let changed = 0;
    for (const tool of tools) {
        const entry = settings.hooks.PreToolUse.find((h) => h.matcher === tool);
        if (!entry) {
            settings.hooks.PreToolUse.push({
                matcher: tool,
                hooks: [{ type: "command", command: hookCommand }],
            });
            changed++;
            continue;
        }
        const existingHook = entry.hooks?.find((c) => typeof c.command === "string" && c.command.includes("nreki-enforcer.mjs"));
        if (existingHook && existingHook.command !== hookCommand) {
            existingHook.command = hookCommand;
            changed++;
        } else if (!existingHook && Array.isArray(entry.hooks)) {
            entry.hooks.push({ type: "command", command: hookCommand });
            changed++;
        }
    }

    if (changed === 0) return { path: label, op: "skipped", note: "PreToolUse hooks already wired" };
    if (!dryRun) {
        ensureDir(path.dirname(settingsAbs));
        fs.writeFileSync(settingsAbs, serializeJson(settings, previous), "utf-8");
    }
    return { path: label, op: previous === null ? "created" : "merged", note: `wired ${changed} PreToolUse matcher(s)` };
}

// ─── Global Codex TOML (~/.codex/config.toml, no fixed cwd) ─────────────────

function tableName(line: string): string | null {
    const m = TABLE_HEADER.exec(line);
    if (!m) return null;
    return m[1].replace(/\s+/g, "").replace(/(^|\.)(["'])([^"']*)\2(?=\.|$)/g, "$1$3");
}

function isNrekiTable(name: string): boolean {
    return name === "mcp_servers.nreki" || name.startsWith("mcp_servers.nreki.");
}

function bracketDelta(line: string): number {
    const code = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "").replace(/#.*$/, "");
    let d = 0;
    for (const ch of code) {
        if (ch === "[" || ch === "{") d++;
        else if (ch === "]" || ch === "}") d--;
    }
    return d;
}

function parseEntries(body: string[]): Array<{ key: string; lines: string[] }> {
    const entries: Array<{ key: string; lines: string[] }> = [];
    let depth = 0;
    for (const line of body) {
        if (depth > 0) {
            entries[entries.length - 1].lines.push(line);
            depth += bracketDelta(line);
            continue;
        }
        const m = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
        if (!m) {
            if (line.trim()) entries.push({ key: "", lines: [line] });
            continue;
        }
        entries.push({ key: m[1].replace(/^["']|["']$/g, ""), lines: [line] });
        depth = bracketDelta(line);
    }
    return entries;
}

function scanGlobalCodex(text: string): {
    lines: string[];
    eol: string;
    ranges: Array<{ start: number; end: number; name: string }>;
    foreign: boolean;
} {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const ranges: Array<{ start: number; end: number; name: string }> = [];
    let foreign = false;
    let current = "";
    for (let i = 0; i < lines.length; i++) {
        const name = tableName(lines[i]);
        if (name !== null) {
            current = name;
            if (isNrekiTable(name)) {
                let start = i;
                if (ranges.length === 0 && i > 0 && CODEX_ANY_MARKER.test(lines[i - 1])) start = i - 1;
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

function registerGlobalCodexToml(home: string, opts: GlobalRegisterOptions): McpAction {
    const abs = path.join(home, ".codex", "config.toml");
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    const previous = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, "") : null;
    const scan = scanGlobalCodex(previous ?? "");
    if (scan.foreign) {
        return { path: label, op: "skipped", note: "nreki is defined as an inline table or dotted key; edit it by hand" };
    }

    const keptMain: string[] = [];
    const envLines: string[] = [];
    const subtables: string[][] = [];
    if (scan.ranges.length > 0) {
        const sectionText = scan.ranges.map((r) => scan.lines.slice(r.start, r.end).join("\n")).join("\n");
        const ours = /["']nreki(@[^"'\s]*)?["']/.test(sectionText);
        if (!ours && !opts.force) {
            return { path: label, op: "skipped", note: "a custom [mcp_servers.nreki] table is present (use --force to replace)" };
        }
        if (ours) {
            for (const r of scan.ranges) {
                const headerAt = scan.lines.slice(r.start, r.end).findIndex((l) => tableName(l) !== null) + r.start;
                const body = scan.lines.slice(headerAt + 1, r.end).filter((l, idx, arr) => !(l.trim() === "" && idx === arr.length - 1));
                if (r.name === "mcp_servers.nreki") {
                    for (const e of parseEntries(body)) {
                        if (e.key && CODEX_MANAGED.has(e.key)) continue;
                        keptMain.push(...e.lines);
                    }
                } else if (r.name === "mcp_servers.nreki.env") {
                    for (const e of parseEntries(body)) {
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

    const { command, args } = launchCommand(opts.version, opts.platform);
    const section: string[] = [
        `${CODEX_GLOBAL_MARKER}. Runs automatically in whichever project folder Codex opens.`,
        "[mcp_servers.nreki]",
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
        "startup_timeout_sec = 120",
        "tool_timeout_sec = 120",
        `env_vars = ["NREKI_VOYAGE_API_KEY", "VOYAGE_API_KEY"]`,
        ...keptMain.filter((l) => l.trim() !== ""),
    ];
    if (envLines.length > 0) section.push("", "[mcp_servers.nreki.env]", ...envLines);
    for (const t of subtables) section.push("", ...t);

    let outLines: string[];
    if (scan.ranges.length > 0) {
        const first = scan.ranges[0].start;
        const removed = new Set<number>();
        for (const r of scan.ranges) for (let i = r.start; i < r.end; i++) removed.add(i);
        outLines = [];
        for (let i = 0; i < scan.lines.length; i++) {
            if (i === first) {
                outLines.push(...section);
                if (scan.ranges[scan.ranges.length - 1].end < scan.lines.length) outLines.push("");
            }
            if (!removed.has(i)) outLines.push(scan.lines[i]);
        }
        outLines = outLines.filter((l, i, arr) => !(l === "" && arr[i - 1] === ""));
    } else {
        outLines = [...scan.lines];
        while (outLines.length > 0 && outLines[outLines.length - 1].trim() === "") outLines.pop();
        if (outLines.length > 0) outLines.push("");
        outLines.push(...section);
    }
    const next = outLines.join(scan.eol) + scan.eol;

    if (previous !== null && next === (previous.endsWith("\n") ? previous : previous + scan.eol)) {
        return { path: label, op: "skipped", note: `already registered (nreki@${opts.version})` };
    }
    if (!opts.dryRun) {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, next, "utf-8");
    }
    const op: McpAction["op"] = previous === null ? "created" : scan.ranges.length > 0 ? "rewritten" : "merged";
    return { path: label, op, note: op === "rewritten" ? `updated to nreki@${opts.version}` : undefined };
}

function unregisterGlobalCodexToml(home: string, dryRun: boolean): McpAction | null {
    const abs = path.join(home, ".codex", "config.toml");
    if (!fs.existsSync(abs)) return null;
    const label = displayHomePath(home, abs);
    const unsafe = unsafeHomeTarget(home, abs);
    if (unsafe) return { path: label, op: "skipped", note: `${unsafe}: not touched` };

    const text = fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, "");
    const scan = scanGlobalCodex(text);
    if (scan.ranges.length === 0) return null;
    const sectionText = scan.ranges.map((r) => scan.lines.slice(r.start, r.end).join("\n")).join("\n");
    if (!/["']nreki(@[^"'\s]*)?["']/.test(sectionText)) return null;

    const removed = new Set<number>();
    for (const r of scan.ranges) for (let i = r.start; i < r.end; i++) removed.add(i);
    const rest = scan.lines.filter((_, i) => !removed.has(i));
    while (rest.length > 0 && rest[rest.length - 1].trim() === "") rest.pop();
    const empty = rest.every((l) => l.trim() === "");
    if (!dryRun) {
        if (empty) fs.unlinkSync(abs);
        else fs.writeFileSync(abs, rest.join(scan.eol) + scan.eol, "utf-8");
    }
    return { path: label, op: "removed", note: empty ? "file deleted (it only held nreki)" : "[mcp_servers.nreki] removed" };
}

// ─── Per-agent global installers ────────────────────────────────────────────

function buildGlobalAgentsRule(): string {
    const base = readTemplate("AGENTS.md").replace(/\s+$/, "");
    return `${base}\n- Global MCP: on your first \`nreki_navigate\`, \`nreki_code\`, or \`nreki_guard\` call in a session, include \`project_root:"<absolute workspace path>"\` so NREKI binds to the active workspace.\n`;
}

function buildGlobalCursorRule(): string {
    const body = readTemplate("CLAUDE.md").replace(/\s+$/, "");
    return `---
description: NREKI MCP — surgical AST-validated editing, semantic search, token-savings (auto-installed globally by \`nreki init\`)
alwaysApply: true
---

${body}
- Workspace binding: on your first \`nreki_navigate\` call in a session, pass \`project_root:"<absolute workspace path>"\` if needed.
`;
}

export function registerGlobalAgent(agent: GlobalAgent, opts: GlobalRegisterOptions): McpAction[] {
    const home = path.resolve(opts.home ?? os.homedir());
    const force = opts.force === true;
    const dryRun = opts.dryRun === true;
    const { command, args } = launchCommand(opts.version, opts.platform);
    const actions: McpAction[] = [];

    switch (agent) {
        case "claude": {
            const entry: Record<string, unknown> = { type: "stdio", command, args };
            if (opts.voyage === true) entry.env = { NREKI_SEMANTIC: "voyage" };
            actions.push(upsertGlobalJsonMcp(home, path.join(home, ".claude.json"), "mcpServers", entry, opts));
            actions.push(upsertMarkdownBlock(home, path.join(home, ".claude", "CLAUDE.md"), readTemplate("CLAUDE.md"), "# NREKI ACTIVE", force, dryRun));
            actions.push(writeOwnedFile(home, path.join(home, ".claude", "skills", "nreki-optimizer", "SKILL.md"), readTemplate("SKILL.md"), force, dryRun));
            const hookAbs = path.join(home, ".claude", "hooks", "nreki-enforcer.mjs");
            actions.push(writeOwnedFile(home, hookAbs, readTemplate(path.join("hooks", "nreki-enforcer.mjs")), force, dryRun, true));
            actions.push(mergeGlobalClaudeHooks(home, hookAbs, dryRun));
            return actions;
        }
        case "antigravity": {
            const pluginDir = path.join(home, ".gemini", "config", "plugins", "nreki");
            const manifest = JSON.stringify({
                name: "nreki",
                displayName: "NREKI",
                version: opts.version,
                description: "Edit-safety MCP server: validates AI edits in RAM (AST + compiler/LSP) before writing, with context search, fast_grep, and session memory.",
                logo: "assets/logo.svg",
                repository: {
                    type: "git",
                    url: "https://github.com/Ruso-0/nreki",
                },
                suggestedPrompts: [
                    "Find the code relevant to my task with nreki_navigate context",
                    "Check architecture and unreachable files with orphan_oracle",
                    "Refactor a function signature safely across callers with batch_edit",
                ],
            }, null, 2) + "\n";

            const entry: Record<string, unknown> = { command, args };
            if (opts.voyage === true) entry.env = { NREKI_SEMANTIC: "voyage" };

            actions.push(writeOwnedFile(home, path.join(pluginDir, "plugin.json"), manifest, force, dryRun));
            actions.push(upsertGlobalJsonMcp(home, path.join(pluginDir, "mcp_config.json"), "mcpServers", entry, opts));
            actions.push(writeOwnedFile(home, path.join(pluginDir, "rules", "AGENTS.md"), buildGlobalAgentsRule(), force, dryRun));
            actions.push(writeOwnedFile(home, path.join(pluginDir, "skills", "nreki-optimizer", "SKILL.md"), readTemplate("SKILL.md"), force, dryRun));
            actions.push(writeOwnedFile(home, path.join(pluginDir, "assets", "logo.svg"), ANTIGRAVITY_LOGO_SVG, force, dryRun));
            return actions;
        }
        case "cursor": {
            const entry: Record<string, unknown> = { command, args };
            if (opts.voyage === true) entry.env = { NREKI_SEMANTIC: "voyage" };
            actions.push(upsertGlobalJsonMcp(home, path.join(home, ".cursor", "mcp.json"), "mcpServers", entry, opts));
            actions.push(writeOwnedFile(home, path.join(home, ".cursor", "rules", "nreki.mdc"), buildGlobalCursorRule(), force, dryRun));
            return actions;
        }
        case "codex": {
            actions.push(registerGlobalCodexToml(home, opts));
            actions.push(upsertMarkdownBlock(home, path.join(home, ".codex", "AGENTS.md"), readTemplate("AGENTS.md"), "NREKI MCP instructions", force, dryRun));
            return actions;
        }
        case "copilot": {
            const entry: Record<string, unknown> = {
                type: "stdio",
                command,
                args,
                env: {
                    NREKI_PROJECT_ROOT: "${workspaceFolder}",
                    ...(opts.voyage === true ? { NREKI_SEMANTIC: "voyage" } : {}),
                },
            };
            const mcpJsonAbs = path.join(vscodeUserDir(home, opts.platform), "mcp.json");
            actions.push(upsertGlobalJsonMcp(home, mcpJsonAbs, "servers", entry, opts));
            return actions;
        }
    }
}

export function isGlobalAgent(agent: DetectedAgent): agent is GlobalAgent {
    return (GLOBAL_AGENTS as readonly string[]).includes(agent);
}

/** Remove all NREKI global registrations from `home`, preserving user content. */
export function unregisterGlobalAll(
    home: string = os.homedir(),
    dryRun = false,
    platform: NodeJS.Platform = process.platform,
): McpAction[] {
    const resolvedHome = path.resolve(home);
    const out: McpAction[] = [];
    const push = (a: McpAction | null) => { if (a) out.push(a); };

    // 1. Claude Code (~/.claude.json + ~/.claude/*)
    push(removeGlobalJsonMcp(resolvedHome, path.join(resolvedHome, ".claude.json"), "mcpServers", false, dryRun));
    push(removeMarkdownBlock(resolvedHome, path.join(resolvedHome, ".claude", "CLAUDE.md"), ["# NREKI ACTIVE"], dryRun));
    for (const rel of [
        path.join(".claude", "skills", "nreki-optimizer", "SKILL.md"),
        path.join(".claude", "hooks", "nreki-enforcer.mjs"),
    ]) {
        const abs = path.join(resolvedHome, rel);
        if (!fs.existsSync(abs)) continue;
        const unsafe = unsafeHomeTarget(resolvedHome, abs);
        if (unsafe) { out.push({ path: displayHomePath(resolvedHome, abs), op: "skipped", note: `${unsafe}: not touched` }); continue; }
        if (!dryRun) fs.unlinkSync(abs);
        out.push({ path: displayHomePath(resolvedHome, abs), op: "removed", note: "file deleted" });
    }
    const claudeSettings = path.join(resolvedHome, ".claude", "settings.json");
    if (fs.existsSync(claudeSettings) && !unsafeHomeTarget(resolvedHome, claudeSettings)) {
        try {
            const raw = fs.readFileSync(claudeSettings, "utf-8");
            const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, any>;
            if (Array.isArray(parsed?.hooks?.PreToolUse)) {
                // mergeGlobalClaudeHooks adds NREKI's command to a matcher the user
                // already had: remove that command only, and the matcher only when
                // nothing of the user's is left in it.
                const isNrekiHook = (c: any) => typeof c?.command === "string" && c.command.includes("nreki-enforcer.mjs");
                let removedHooks = 0;
                const kept: any[] = [];
                for (const h of parsed.hooks.PreToolUse) {
                    if (!Array.isArray(h?.hooks) || !h.hooks.some(isNrekiHook)) {
                        kept.push(h);
                        continue;
                    }
                    const rest = h.hooks.filter((c: any) => !isNrekiHook(c));
                    removedHooks += h.hooks.length - rest.length;
                    if (rest.length > 0) kept.push({ ...h, hooks: rest });
                }
                if (removedHooks > 0) {
                    parsed.hooks.PreToolUse = kept;
                    if (parsed.hooks.PreToolUse.length === 0) delete parsed.hooks.PreToolUse;
                    if (parsed.hooks && Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
                    if (!dryRun) {
                        if (Object.keys(parsed).length === 0) fs.unlinkSync(claudeSettings);
                        else fs.writeFileSync(claudeSettings, serializeJson(parsed, raw), "utf-8");
                    }
                    out.push({ path: displayHomePath(resolvedHome, claudeSettings), op: "removed", note: "NREKI hooks removed" });
                }
            }
        } catch { /* leave malformed user file untouched */ }
    }

    // 2. Antigravity global plugin (~/.gemini/config/plugins/nreki/)
    const agyPluginDir = path.join(resolvedHome, ".gemini", "config", "plugins", "nreki");
    if (fs.existsSync(agyPluginDir)) {
        const unsafe = unsafeHomeTarget(resolvedHome, path.join(agyPluginDir, "plugin.json"));
        if (unsafe) {
            out.push({ path: displayHomePath(resolvedHome, agyPluginDir), op: "skipped", note: `${unsafe}: not touched` });
        } else {
            if (!dryRun) fs.rmSync(agyPluginDir, { recursive: true, force: true });
            out.push({ path: displayHomePath(resolvedHome, agyPluginDir), op: "removed", note: "Antigravity plugin removed" });
        }
    }

    // 3. Cursor (~/.cursor/mcp.json + ~/.cursor/rules/nreki.mdc)
    push(removeGlobalJsonMcp(resolvedHome, path.join(resolvedHome, ".cursor", "mcp.json"), "mcpServers", true, dryRun));
    const cursorRule = path.join(resolvedHome, ".cursor", "rules", "nreki.mdc");
    if (fs.existsSync(cursorRule) && !unsafeHomeTarget(resolvedHome, cursorRule)) {
        if (fs.readFileSync(cursorRule, "utf-8").includes("# NREKI ACTIVE")) {
            if (!dryRun) fs.unlinkSync(cursorRule);
            out.push({ path: displayHomePath(resolvedHome, cursorRule), op: "removed", note: "file deleted" });
        }
    }

    // 4. Codex (~/.codex/config.toml + ~/.codex/AGENTS.md)
    push(unregisterGlobalCodexToml(resolvedHome, dryRun));
    push(removeMarkdownBlock(resolvedHome, path.join(resolvedHome, ".codex", "AGENTS.md"), ["NREKI MCP instructions"], dryRun));

    // 5. VS Code / Copilot (Code/User/mcp.json)
    push(removeGlobalJsonMcp(resolvedHome, path.join(vscodeUserDir(resolvedHome, platform), "mcp.json"), "servers", true, dryRun));

    return out;
}
