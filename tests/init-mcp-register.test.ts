/**
 * init-mcp-register.test.ts — v12.3.0 `nreki init` registers NREKI as an MCP
 * server for each agent, with the project folder pinned, and NREKI_PROJECT_ROOT
 * moves the server into that folder.
 *
 * Measured on 2026-11-26 before writing this: Antigravity starts a global
 * plugin's MCP server in the plugin folder (so NREKI indexed the wrong folder)
 * and a workspace `.agents/mcp_config.json` server in the project; Codex
 * documents a `cwd` field; Cursor and VS Code document neither.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decideProjectRoot, applyProjectRoot } from "../src/project-root.js";
import { detectAgent } from "../src/init/agent-detect.js";
import { MCP_CONFIG_PATH, registerMcp, unregisterMcp, launchCommand } from "../src/init/mcp-register.js";
import { parseInitArgs, runInit } from "../src/init/init-runner.js";

const repoRoot = path.resolve(__dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

let project: string;
let home: string;
let scratch: string;

beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-mcp-proj-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-mcp-home-"));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-mcp-other-"));
});

afterEach(() => {
    // The server test leaves a process exiting inside `project` for a moment (Windows locks its cwd).
    for (const dir of [project, home, scratch]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

const read = (rel: string): string => fs.readFileSync(path.join(project, rel), "utf-8");
const readJson = (rel: string): Record<string, any> => JSON.parse(read(rel));
const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), text);
};
const base = { version: "12.3.0", platform: "linux" as NodeJS.Platform };

// ─── NREKI_PROJECT_ROOT ─────────────────────────────────────────────────────

describe("NREKI_PROJECT_ROOT", () => {
    it("is applied only when it names an existing absolute folder", () => {
        expect(decideProjectRoot(undefined)).toEqual({ kind: "unset" });
        expect(decideProjectRoot("   ")).toEqual({ kind: "unset" });
        expect(decideProjectRoot("${workspaceFolder}").kind).toBe("ignore");
        expect(decideProjectRoot("relative/dir").kind).toBe("ignore");
        expect(decideProjectRoot(path.join(project, "missing")).kind).toBe("ignore");
        expect(decideProjectRoot(project)).toEqual({ kind: "apply", dir: path.resolve(project) });
    });

    it("applyProjectRoot moves the process into the folder", () => {
        const before = process.cwd();
        try {
            process.chdir(scratch);
            applyProjectRoot({ NREKI_PROJECT_ROOT: project });
            expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(project));
        } finally {
            process.chdir(before);
        }
    });

    it("index.ts imports bootstrap-root first, before any module can read process.cwd()", () => {
        const src = fs.readFileSync(path.join(repoRoot, "src", "index.ts"), "utf-8");
        const firstImport = /^import\s.*$/m.exec(src)?.[0];
        expect(firstImport).toBe(`import "./bootstrap-root.js";`);
    });

    it("bootstrap-root switches folder in a fresh process", () => {
        const script = path.join(scratch, "print-cwd.mts");
        fs.writeFileSync(script,
            `import ${JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "bootstrap-root.ts")).href)};\n` +
            "console.log(process.cwd());\n");
        const r = spawnSync(process.execPath, [tsxCli, script], {
            cwd: scratch, env: { ...process.env, NREKI_PROJECT_ROOT: project }, encoding: "utf-8",
        });
        expect(r.status, r.stderr).toBe(0);
        expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(project));
    });

    it("the real server started in another folder indexes NREKI_PROJECT_ROOT", async () => {
        fs.writeFileSync(path.join(project, "zebra.ts"), "export function zebraQuokkaMarker(): number { return 42; }\n");
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [tsxCli, path.join(repoRoot, "src", "index.ts")],
            cwd: scratch,
            env: { ...getDefaultEnvironment(), NREKI_PROJECT_ROOT: project },
            stderr: "ignore",
        });
        const client = new Client({ name: "project-root-test", version: "1" });
        await client.connect(transport);
        try {
            let text = "";
            for (let i = 0; i < 40; i++) {
                const r = await client.callTool({ name: "nreki_navigate", arguments: { action: "fast_grep", query: "zebraQuokkaMarker" } });
                text = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
                if (text.includes("zebra.ts")) break;
                await new Promise((ok) => setTimeout(ok, 500));
            }
            expect(text).toContain("zebra.ts");
        } finally {
            await client.close();
        }
        expect(fs.existsSync(path.join(project, ".nreki.db")) || fs.existsSync(path.join(project, ".nreki"))).toBe(true);
        expect(fs.readdirSync(scratch)).toEqual([]);
    }, 120_000);
});

// ─── JSON hosts ─────────────────────────────────────────────────────────────

describe("registerMcp — JSON hosts", () => {
    it("launches through cmd /c on Windows and npx elsewhere, pinned to the version", () => {
        expect(launchCommand("12.3.0", "win32")).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "nreki@12.3.0"] });
        expect(launchCommand("12.3.0", "linux")).toEqual({ command: "npx", args: ["-y", "nreki@12.3.0"] });
    });

    it("claude: creates .mcp.json", () => {
        const r = registerMcp("claude", { cwd: project, ...base });
        expect(r).toMatchObject({ path: ".mcp.json", op: "created" });
        expect(readJson(".mcp.json")).toEqual({
            mcpServers: { nreki: { type: "stdio", command: "npx", args: ["-y", "nreki@12.3.0"] } },
        });
    });

    it("claude: merges next to the user's servers and keeps CRLF line endings", () => {
        const original = { mcpServers: { supabase: { type: "http", url: "https://mcp.supabase.com/mcp" } } };
        write(".mcp.json", JSON.stringify(original, null, 2).replace(/\n/g, "\r\n") + "\r\n");
        const r = registerMcp("claude", { cwd: project, ...base });
        expect(r.op).toBe("merged");
        const text = read(".mcp.json");
        expect(text.includes("\r\n")).toBe(true);
        expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
        const doc = JSON.parse(text);
        expect(doc.mcpServers.supabase).toEqual(original.mcpServers.supabase);
        expect(doc.mcpServers.nreki.args).toEqual(["-y", "nreki@12.3.0"]);
    });

    it("is idempotent, and updates its own entry to a new version keeping the user's fields", () => {
        registerMcp("claude", { cwd: project, ...base });
        expect(registerMcp("claude", { cwd: project, ...base })).toMatchObject({ op: "skipped", note: expect.stringMatching(/already registered/) });

        const doc = readJson(".mcp.json");
        doc.mcpServers.nreki.env = { MY_FLAG: "1" };
        doc.mcpServers.nreki.timeout = 30_000;
        write(".mcp.json", JSON.stringify(doc, null, 2));
        const r = registerMcp("claude", { cwd: project, ...base, version: "12.4.0" });
        expect(r).toMatchObject({ op: "rewritten", note: "updated to nreki@12.4.0" });
        const entry = readJson(".mcp.json").mcpServers.nreki;
        expect(entry.args).toEqual(["-y", "nreki@12.4.0"]);
        expect(entry.env).toEqual({ MY_FLAG: "1" });
        expect(entry.timeout).toBe(30_000);
    });

    it("leaves a \"nreki\" entry NREKI did not write alone unless --force", () => {
        const dev = { command: "node", args: ["d:/dev/nreki/dist/index.js"] };
        write(".mcp.json", JSON.stringify({ mcpServers: { nreki: dev } }));
        expect(registerMcp("claude", { cwd: project, ...base })).toMatchObject({ op: "skipped" });
        expect(readJson(".mcp.json").mcpServers.nreki).toEqual(dev);
        expect(registerMcp("claude", { cwd: project, ...base, force: true }).op).toBe("rewritten");
        expect(readJson(".mcp.json").mcpServers.nreki.args).toEqual(["-y", "nreki@12.3.0"]);
    });

    it("never rewrites a file it cannot parse", () => {
        write(".cursor/mcp.json", "{ // my servers\n  \"mcpServers\": {}\n}\n");
        const r = registerMcp("cursor", { cwd: project, ...base });
        expect(r.op).toBe("skipped");
        expect(r.note).toMatch(/not valid JSON/);
        expect(r.note).toContain("nreki@12.3.0");
        expect(read(".cursor/mcp.json")).toBe("{ // my servers\n  \"mcpServers\": {}\n}\n");
    });

    it("--voyage sets NREKI_SEMANTIC, --no-voyage removes it, no flag keeps it", () => {
        registerMcp("antigravity", { cwd: project, ...base, voyage: true });
        expect(readJson(MCP_CONFIG_PATH.antigravity).mcpServers.nreki.env).toEqual({ NREKI_SEMANTIC: "voyage" });
        expect(registerMcp("antigravity", { cwd: project, ...base }).op).toBe("skipped");
        expect(readJson(MCP_CONFIG_PATH.antigravity).mcpServers.nreki.env).toEqual({ NREKI_SEMANTIC: "voyage" });
        registerMcp("antigravity", { cwd: project, ...base, voyage: false });
        expect(readJson(MCP_CONFIG_PATH.antigravity).mcpServers.nreki.env).toBeUndefined();
    });

    it("antigravity: .agents/mcp_config.json with the documented fields only", () => {
        registerMcp("antigravity", { cwd: project, ...base, platform: "win32" });
        expect(readJson(path.join(".agents", "mcp_config.json"))).toEqual({
            mcpServers: { nreki: { command: "cmd", args: ["/c", "npx", "-y", "nreki@12.3.0"] } },
        });
    });

    it("cursor pins the project with an absolute NREKI_PROJECT_ROOT", () => {
        registerMcp("cursor", { cwd: project, ...base });
        expect(readJson(path.join(".cursor", "mcp.json")).mcpServers.nreki.env).toEqual({ NREKI_PROJECT_ROOT: path.resolve(project) });
    });

    it("copilot: .vscode/mcp.json uses \"servers\" and ${workspaceFolder}", () => {
        registerMcp("copilot", { cwd: project, ...base });
        expect(readJson(path.join(".vscode", "mcp.json"))).toEqual({
            servers: { nreki: { type: "stdio", command: "npx", args: ["-y", "nreki@12.3.0"], env: { NREKI_PROJECT_ROOT: "${workspaceFolder}" } } },
        });
    });

    it("--dry-run writes nothing", () => {
        for (const host of ["claude", "codex", "antigravity", "cursor", "copilot"] as const) {
            expect(registerMcp(host, { cwd: project, ...base, dryRun: true }).op).toBe("created");
        }
        expect(fs.readdirSync(project)).toEqual([]);
    });

    it("never writes through a linked config folder", () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-mcp-outside-"));
        try {
            fs.symlinkSync(outside, path.join(project, ".cursor"), "junction");
            const r = registerMcp("cursor", { cwd: project, ...base });
            expect(r.op).toBe("skipped");
            expect(fs.readdirSync(outside)).toEqual([]);
        } finally {
            fs.rmSync(path.join(project, ".cursor"), { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("unregister removes only NREKI's entry, and the file when it held nothing else", () => {
        write(".mcp.json", JSON.stringify({ mcpServers: { supabase: { type: "http", url: "u" } } }));
        registerMcp("claude", { cwd: project, ...base });
        expect(unregisterMcp("claude", project)).toMatchObject({ op: "removed" });
        expect(readJson(".mcp.json")).toEqual({ mcpServers: { supabase: { type: "http", url: "u" } } });

        registerMcp("antigravity", { cwd: project, ...base });
        expect(unregisterMcp("antigravity", project)?.note).toMatch(/file deleted/);
        expect(fs.existsSync(path.join(project, MCP_CONFIG_PATH.antigravity))).toBe(false);

        write(".vscode/mcp.json", JSON.stringify({ servers: { nreki: { command: "node", args: ["x.js"] } } }));
        expect(unregisterMcp("copilot", project)).toBeNull();
    });
});

// ─── Codex (TOML) ───────────────────────────────────────────────────────────

describe("registerMcp — codex", () => {
    const toml = () => read(MCP_CONFIG_PATH.codex);

    it("creates .codex/config.toml with cwd, a long startup timeout and the Voyage key forwarded", () => {
        registerMcp("codex", { cwd: project, ...base, platform: "win32" });
        const text = toml();
        expect(text).toContain("[mcp_servers.nreki]");
        expect(text).toContain(`command = "cmd"`);
        expect(text).toContain(`args = ["/c", "npx", "-y", "nreki@12.3.0"]`);
        expect(text).toContain(`cwd = ${JSON.stringify(path.resolve(project))}`);
        expect(text).toContain("startup_timeout_sec = 120");
        expect(text).toContain(`env_vars = ["NREKI_VOYAGE_API_KEY", "VOYAGE_API_KEY"]`);
        expect(text).not.toContain("[mcp_servers.nreki.env]");
    });

    it("appends after the user's tables, is idempotent, and keeps CRLF", () => {
        const user = ["model = \"gpt-5\"", "", "[mcp_servers.other]", "command = \"other\"", ""].join("\r\n");
        write(MCP_CONFIG_PATH.codex, user);
        expect(registerMcp("codex", { cwd: project, ...base }).op).toBe("merged");
        const text = toml();
        expect(text.startsWith(user)).toBe(true);
        expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
        expect(registerMcp("codex", { cwd: project, ...base }).op).toBe("skipped");
        expect(toml()).toBe(text);
    });

    it("updates its own table in place, keeping the user's keys, env and subtables", () => {
        write(MCP_CONFIG_PATH.codex, [
            "[mcp_servers.nreki]",
            "command = \"npx\"",
            "args = [",
            "  \"-y\",",
            "  \"nreki@12.2.0\",",
            "]",
            "enabled_tools = [\"nreki_navigate\"]",
            "",
            "[mcp_servers.nreki.env]",
            "MY_FLAG = \"1\"",
            "",
            "[mcp_servers.nreki.tools.nreki_code]",
            "approval_mode = \"approve\"",
            "",
            "[mcp_servers.after]",
            "command = \"after\"",
            "",
        ].join("\n"));
        const r = registerMcp("codex", { cwd: project, ...base, voyage: true });
        expect(r).toMatchObject({ op: "rewritten", note: "updated to nreki@12.3.0" });
        const text = toml();
        expect(text).toContain(`args = ["-y", "nreki@12.3.0"]`);
        expect(text).not.toContain("nreki@12.2.0");
        expect(text).not.toMatch(/^\s*"-y",\s*$/m);
        expect(text).toContain(`enabled_tools = ["nreki_navigate"]`);
        expect(text).toMatch(/\[mcp_servers\.nreki\.env\]\nNREKI_SEMANTIC = "voyage"\nMY_FLAG = "1"/);
        expect(text).toContain("[mcp_servers.nreki.tools.nreki_code]\napproval_mode = \"approve\"");
        expect(text).toContain("[mcp_servers.after]\ncommand = \"after\"");
        expect(text.match(/\[mcp_servers\.nreki\]/g)).toHaveLength(1);
        expect(registerMcp("codex", { cwd: project, ...base }).op).toBe("skipped");
    });

    it("leaves a table NREKI did not write alone unless --force, and refuses inline definitions", () => {
        const dev = "[mcp_servers.nreki]\ncommand = \"node\"\nargs = [\"d:/dev/nreki/dist/index.js\"]\n";
        write(MCP_CONFIG_PATH.codex, dev);
        expect(registerMcp("codex", { cwd: project, ...base }).op).toBe("skipped");
        expect(toml()).toBe(dev);
        expect(registerMcp("codex", { cwd: project, ...base, force: true }).op).toBe("rewritten");
        expect(toml()).toContain("nreki@12.3.0");
        expect(toml()).not.toContain("d:/dev/nreki");

        write(MCP_CONFIG_PATH.codex, "[mcp_servers]\nnreki = { command = \"x\" }\n");
        expect(registerMcp("codex", { cwd: project, ...base }).note).toMatch(/inline table/);
    });

    it("escapes a project path with a quote, spaces and backslashes", () => {
        const odd = path.join(project, "it's odd");
        fs.mkdirSync(odd);
        registerMcp("codex", { cwd: odd, ...base });
        expect(fs.readFileSync(path.join(odd, MCP_CONFIG_PATH.codex), "utf-8")).toContain(`cwd = ${JSON.stringify(path.resolve(odd))}`);
    });

    it("unregister removes NREKI's tables and keeps the rest", () => {
        write(MCP_CONFIG_PATH.codex, "model = \"gpt-5\"\n");
        registerMcp("codex", { cwd: project, ...base, voyage: true });
        expect(unregisterMcp("codex", project)).toMatchObject({ op: "removed" });
        expect(toml()).toBe("model = \"gpt-5\"\n");

        registerMcp("codex", { cwd: project, ...base });
        fs.rmSync(path.join(project, MCP_CONFIG_PATH.codex));
        registerMcp("codex", { cwd: project, ...base });
        expect(unregisterMcp("codex", project)?.note).toMatch(/file deleted/);
    });
});

// ─── Detection and runInit ──────────────────────────────────────────────────

describe("init — agents and registration", () => {
    it("installs for every agent configured in the project", () => {
        fs.mkdirSync(path.join(project, ".claude"));
        fs.mkdirSync(path.join(project, ".codex"));
        fs.mkdirSync(path.join(project, ".agents", "rules"), { recursive: true });
        expect(detectAgent(project, home).agents).toEqual(["claude", "codex", "antigravity"]);
    });

    it("without project signals, installs for the agents found in the home folder", () => {
        fs.mkdirSync(path.join(home, ".codex"));
        fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
        const d = detectAgent(project, home);
        expect(d.agents).toEqual(["codex", "antigravity"]);
        expect(d.reason).toMatch(/found on this computer/);
    });

    it("one command: AGENTS.md once, plus the Codex and Antigravity registrations and next steps", () => {
        fs.mkdirSync(path.join(home, ".codex"));
        fs.mkdirSync(path.join(home, ".gemini", "antigravity"), { recursive: true });
        const result = runInit({ cwd: project, home, version: "12.3.0" });
        expect(result.agents).toEqual(["codex", "antigravity"]);
        expect(result.actions.filter((a) => a.path === "AGENTS.md")).toHaveLength(1);
        expect(read("AGENTS.md")).toContain("NREKI MCP instructions");
        expect(read(MCP_CONFIG_PATH.codex)).toContain("[mcp_servers.nreki]");
        expect(readJson(MCP_CONFIG_PATH.antigravity).mcpServers.nreki.args).toContain("nreki@12.3.0");
        expect(result.notes.some((n) => n.startsWith("Codex:"))).toBe(true);
        expect(result.notes.some((n) => n.startsWith("Antigravity:"))).toBe(true);
    });

    it("--no-mcp writes the instructions only", () => {
        const parsed = parseInitArgs(["--agent", "codex,antigravity", "--no-mcp"]);
        expect(parsed.error).toBeUndefined();
        runInit({ ...parsed.opts, cwd: project, home });
        expect(fs.existsSync(path.join(project, "AGENTS.md"))).toBe(true);
        expect(fs.existsSync(path.join(project, ".codex"))).toBe(false);
        expect(fs.existsSync(path.join(project, ".agents"))).toBe(false);
    });

    it("parses agent lists and the Voyage flags", () => {
        expect(parseInitArgs(["--agent=claude,codex"]).opts.agents).toEqual(["claude", "codex"]);
        expect(parseInitArgs(["--agent", "codex", "--agent", "cursor"]).opts.agents).toEqual(["codex", "cursor"]);
        expect(parseInitArgs(["--voyage"]).opts.voyage).toBe(true);
        expect(parseInitArgs(["--no-voyage"]).opts.voyage).toBe(false);
        expect(parseInitArgs(["--agent", "codex,vim"]).error).toMatch(/unknown agent "vim"/);
    });

    it("cline and generic get the manual registration in the next steps", () => {
        const result = runInit({ cwd: project, home, agents: ["cline"], version: "12.3.0" });
        expect(result.notes.join("\n")).toMatch(/cline: register the MCP server by hand/);
    });
});

// ─── deinit ─────────────────────────────────────────────────────────────────

describe("deinit — undoes init", () => {
    it("removes only NREKI's block from CLAUDE.md, keeping the user's text before and after it", async () => {
        const { removeInstructions } = await import("../src/init/init-runner.js");
        write("CLAUDE.md", "# My rules\n- be brief\n");
        runInit({ cwd: project, home, agents: ["claude"], mcp: false });
        fs.appendFileSync(path.join(project, "CLAUDE.md"), "\n## Added after NREKI\n- keep me\n");
        const actions = removeInstructions(project);
        expect(actions.find((a) => a.path === "CLAUDE.md")).toMatchObject({ op: "removed" });
        const text = read("CLAUDE.md");
        expect(text).toContain("# My rules\n- be brief");
        expect(text).toContain("## Added after NREKI\n- keep me");
        expect(text).not.toContain("nreki:begin");
        expect(text).not.toContain("NREKI ACTIVE");
    });

    it("recognizes the pre-v12.1 AGENTS.md header", async () => {
        const { removeInstructions } = await import("../src/init/init-runner.js");
        write("AGENTS.md", "# Instructions for AI coding agents consuming NREKI via MCP\n\n## 1. Navigate\n- use nreki\n");
        expect(removeInstructions(project)).toEqual([{ path: "AGENTS.md", op: "removed", note: "file deleted (it only held NREKI's block)" }]);
        expect(fs.existsSync(path.join(project, "AGENTS.md"))).toBe(false);
    });

    it("init then deinit through the CLI leaves the project as it was", () => {
        write("src/a.ts", "export const a = 1;\n");
        write(".claude/settings.local.json", "{}\n");
        runInit({ cwd: project, home, agents: ["claude", "codex", "antigravity", "cursor", "copilot"], version: "12.3.0" });
        expect(fs.existsSync(path.join(project, ".codex", "config.toml"))).toBe(true);
        const r = spawnSync(process.execPath, [tsxCli, path.join(repoRoot, "src", "index.ts"), "deinit"], {
            cwd: project, env: { ...process.env, NREKI_PROJECT_ROOT: "" }, encoding: "utf-8",
        });
        expect(r.status, r.stderr).toBe(0);
        const left = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
            .flatMap((e) => e.isDirectory() ? left(path.join(dir, e.name)) : [path.relative(project, path.join(dir, e.name))])
            .filter((p) => !p.startsWith(".nreki"));
        expect(left(project).sort()).toEqual([path.join(".claude", "settings.local.json"), path.join("src", "a.ts")]);
        expect(fs.existsSync(path.join(project, ".codex"))).toBe(false);
        expect(fs.existsSync(path.join(project, ".agents"))).toBe(false);
    }, 60_000);
});
