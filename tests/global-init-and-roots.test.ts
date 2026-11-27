/**
 * global-init-and-roots.test.ts — v12.5.0:
 *   1. User-scoped (`npx nreki init --global`) zero-approval installation across
 *      Claude Code (`~/.claude.json`), Antigravity (`~/.gemini/config/plugins/nreki/`),
 *      Cursor (`~/.cursor/mcp.json`), Codex (`~/.codex/config.toml`), and VS Code
 *      (`Code/User/mcp.json`), plus migrating stale repo `.mcp.json` entries and
 *      clean `unregisterGlobalAll`.
 *   2. Local browser Setup Box (`askViaBrowserSetupUi` on `127.0.0.1`) with CSRF
 *      token protection, inline Voyage API key verification, and automatic
 *      timeout fallback when no browser opens.
 *   3. Dynamic workspace resolution on the real built MCP server when started
 *      inside a global plugin folder (`~/.gemini/config/plugins/nreki`) via MCP
 *      `roots/list` and `project_root` without polluting the plugin folder.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
    inferProjectRootFromPath,
    isNonProjectLaunchDir,
    pickRootFromMcpRoots,
    rootUriToDir,
} from "../src/project-root.js";
import {
    registerGlobalAgent,
    unregisterGlobalAll,
    unsafeHomeTarget,
    vscodeUserDir,
} from "../src/init/global-register.js";
import { parseInitArgs, runInit } from "../src/init/init-runner.js";
import { askViaBrowserSetupUi, createSetupUiController } from "../src/init/setup-ui.js";
import { dialogTexts, isHumanInteractiveSession } from "../src/init/voyage-prompt.js";

const repoRoot = path.resolve(__dirname, "..");

let home: string;
let projectA: string;
let projectB: string;

async function removeDir(dir: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code ?? "";
            if (attempt >= 60 || !["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(code)) throw err;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}

async function waitForExit(pid: number | null | undefined, timeoutMs = 15_000): Promise<void> {
    if (!pid) return;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try { process.kill(pid, 0); } catch { return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-global-home-"));
    projectA = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-global-projA-"));
    projectB = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-global-projB-"));
});

afterEach(async () => {
    for (const dir of [home, projectA, projectB]) await removeDir(dir);
});

describe("project-root helpers for global MCP", () => {
    it("parses file:// URIs from MCP roots/list", () => {
        const uri = pathToFileURL(projectA).href;
        expect(rootUriToDir(uri)).toBe(path.resolve(projectA));
        expect(rootUriToDir("https://example.com/repo")).toBeNull();
        expect(pickRootFromMcpRoots([{ uri: "https://nope" }, { uri }])).toBe(path.resolve(projectA));
    });

    it("identifies host config directories as non-project launch dirs", () => {
        expect(isNonProjectLaunchDir(home, home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, ".gemini", "config", "plugins", "nreki"), home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, ".claude"), home)).toBe(true);
        expect(isNonProjectLaunchDir(projectA, home)).toBe(false);
    });

    it("walks up from an absolute file path to find the enclosing project root", () => {
        fs.writeFileSync(path.join(projectA, "tsconfig.json"), "{}\n");
        const nestedFile = path.join(projectA, "src", "deep", "item.ts");
        fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
        fs.writeFileSync(nestedFile, "export const x = 1;\n");
        expect(inferProjectRootFromPath(nestedFile, home)).toBe(path.resolve(projectA));
    });
});

describe("global user-scope registration (zero per-project approval)", () => {
    it("installs Claude Code, Antigravity plugin, Cursor, Codex, and VS Code globally", () => {
        // Seed existing user state to verify preservation
        fs.writeFileSync(
            path.join(home, ".claude.json"),
            JSON.stringify({ numStartups: 7, projects: { "/x": {} } }, null, 2),
        );
        // Seed VS Code directory so defaultGlobalAgents includes copilot
        fs.mkdirSync(vscodeUserDir(home), { recursive: true });
        // Seed stale project .mcp.json with both nreki and supabase
        fs.writeFileSync(
            path.join(projectA, ".mcp.json"),
            JSON.stringify({
                mcpServers: {
                    nreki: { type: "stdio", command: "npx", args: ["-y", "nreki@12.4.1"] },
                    supabase: { type: "http", url: "https://mcp.supabase.com/mcp" },
                },
            }, null, 2),
        );

        const res = runInit({
            cwd: projectA,
            home,
            global: true,
            voyage: true,
            version: "12.5.0",
        });

        expect(res.agents).toEqual(["claude", "codex", "antigravity", "cursor", "copilot"]);

        // 1. Claude Code: ~/.claude.json user scope + global CLAUDE.md + skill + hook
        const claudeJson = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
        expect(claudeJson.numStartups).toBe(7);
        expect(claudeJson.mcpServers.nreki.env).toEqual({ NREKI_SEMANTIC: "voyage" });
        expect(fs.existsSync(path.join(home, ".claude", "CLAUDE.md"))).toBe(true);
        expect(fs.existsSync(path.join(home, ".claude", "skills", "nreki-optimizer", "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(home, ".claude", "hooks", "nreki-enforcer.mjs"))).toBe(true);

        // Stale repo .mcp.json nreki entry migrated away; supabase preserved!
        const repoMcp = JSON.parse(fs.readFileSync(path.join(projectA, ".mcp.json"), "utf-8"));
        expect(repoMcp.mcpServers.nreki).toBeUndefined();
        expect(repoMcp.mcpServers.supabase).toEqual({ type: "http", url: "https://mcp.supabase.com/mcp" });

        // 2. Antigravity: global plugin bundle at ~/.gemini/config/plugins/nreki/
        const agyDir = path.join(home, ".gemini", "config", "plugins", "nreki");
        const pluginManifest = JSON.parse(fs.readFileSync(path.join(agyDir, "plugin.json"), "utf-8"));
        expect(pluginManifest.name).toBe("nreki");
        const agyMcp = JSON.parse(fs.readFileSync(path.join(agyDir, "mcp_config.json"), "utf-8"));
        expect(agyMcp.mcpServers.nreki.env).toEqual({ NREKI_SEMANTIC: "voyage" });
        expect(fs.readFileSync(path.join(agyDir, "rules", "AGENTS.md"), "utf-8")).toContain("project_root");
        expect(fs.existsSync(path.join(agyDir, "skills", "nreki-optimizer", "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(agyDir, "assets", "logo.svg"))).toBe(true);

        // 3. Cursor: ~/.cursor/mcp.json + ~/.cursor/rules/nreki.mdc
        const cursorMcp = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf-8"));
        expect(cursorMcp.mcpServers.nreki.env).toEqual({ NREKI_SEMANTIC: "voyage" });
        expect(fs.existsSync(path.join(home, ".cursor", "rules", "nreki.mdc"))).toBe(true);

        // 4. Codex: ~/.codex/config.toml (no hardcoded cwd) + ~/.codex/AGENTS.md
        const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf-8");
        expect(codexToml).toContain("[mcp_servers.nreki]");
        expect(codexToml).not.toContain("cwd =");
        expect(codexToml).toContain(`NREKI_SEMANTIC = "voyage"`);
        expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(true);

        // 5. VS Code Copilot: Code/User/mcp.json
        const vscodeMcp = JSON.parse(fs.readFileSync(path.join(vscodeUserDir(home), "mcp.json"), "utf-8"));
        expect(vscodeMcp.servers.nreki.env).toEqual({
            NREKI_PROJECT_ROOT: "${workspaceFolder}",
            NREKI_SEMANTIC: "voyage",
        });

        // Clean global uninstall preserves user data in ~/.claude.json
        const removed = unregisterGlobalAll(home);
        expect(removed.some((r) => r.op === "removed")).toBe(true);
        const cleanedClaudeJson = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
        expect(cleanedClaudeJson.numStartups).toBe(7);
        expect(cleanedClaudeJson.mcpServers).toBeUndefined();
        expect(fs.existsSync(agyDir)).toBe(false);
    });

    it("refuses paths outside home and symbolic links inside home", (ctx) => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-outside-home-"));
        try {
            expect(unsafeHomeTarget(home, path.join(outside, "mcp.json"))).toMatch(/outside/);
            try {
                fs.symlinkSync(outside, path.join(home, ".cursor"), process.platform === "win32" ? "junction" : "dir");
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "EPERM") {
                    ctx.skip("environment blocks directory junctions");
                }
                throw err;
            }
            const actions = registerGlobalAgent("cursor", { home, version: "12.5.0" });
            expect(actions.every((a) => a.op === "skipped")).toBe(true);
            expect(fs.readdirSync(outside)).toEqual([]);
        } finally {
            fs.rmSync(path.join(home, ".cursor"), { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    it("parses --global, -g, --project, and --prompt flags", () => {
        expect(parseInitArgs(["--global"]).opts.global).toBe(true);
        expect(parseInitArgs(["-g"]).opts.global).toBe(true);
        expect(parseInitArgs(["--project"]).opts.global).toBe(false);
        expect(parseInitArgs(["--prompt"]).opts.prompt).toBe(true);
    });
});

describe("local browser Voyage API Key setup box", () => {
    it("serves the protected setup card, rejects invalid keys inline, and accepts valid keys", async () => {
        const ctrl = createSetupUiController({
            texts: dialogTexts(false, undefined, "es-PE"),
            locale: "es-PE",
            check: async (key) => key === "pa-valid_voyage_key_12345"
                ? { status: "valid" }
                : { status: "invalid", httpStatus: 401 },
        });

        // Without token -> 403
        const forbidden = await ctrl.dispatch({ method: "GET", pathname: "/", queryToken: null });
        expect(forbidden.status).toBe(403);

        // With token -> 200 HTML
        const page = await ctrl.dispatch({ method: "GET", pathname: "/", queryToken: ctrl.token });
        expect(page.status).toBe(200);
        expect(page.body).toContain("Voyage API Key");

        // Ping opened
        const opened = await ctrl.dispatch({
            method: "POST",
            pathname: "/api/opened",
            headerToken: ctrl.token,
        });
        expect(opened.status).toBe(200);
        expect(ctrl.opened).toBe(true);

        // Bad key -> inline error, outcome remains unset
        const badRes = await ctrl.dispatch({
            method: "POST",
            pathname: "/api/submit",
            headerToken: ctrl.token,
            rawBody: JSON.stringify({ action: "key", key: "pa-bad_key_0000" }),
        });
        const badJson = JSON.parse(badRes.body) as { ok: boolean; error?: string };
        expect(badJson.ok).toBe(false);
        expect(badJson.error).toContain("401");
        expect(ctrl.outcome).toBeNull();

        // Good key -> succeeds and sets verified outcome
        const okRes = await ctrl.dispatch({
            method: "POST",
            pathname: "/api/submit",
            headerToken: ctrl.token,
            rawBody: JSON.stringify({ action: "key", key: "pa-valid_voyage_key_12345" }),
        });
        expect((JSON.parse(okRes.body) as { ok: boolean }).ok).toBe(true);
        expect(ctrl.outcome).toEqual({
            choice: { kind: "key", key: "pa-valid_voyage_key_12345" },
            verified: { status: "valid" },
        });
    });

    it("falls back cleanly (returns null) when no browser loads the page", async () => {
        const outcome = await askViaBrowserSetupUi({
            texts: dialogTexts(false, undefined, "en-US"),
            openBrowser: () => true,
            openTimeoutMs: 80,
        });
        expect(outcome).toBeNull();
    });

    it("detects human interactive sessions (including Git Bash) and excludes CI / agents", () => {
        expect(isHumanInteractiveSession({}, true, true)).toBe(true);
        expect(isHumanInteractiveSession({ MSYSTEM: "MINGW64", TERM: "xterm-256color" }, false, false)).toBe(true);
        expect(isHumanInteractiveSession({ CI: "true" }, true, true)).toBe(false);
        expect(isHumanInteractiveSession({ CLAUDECODE: "1" }, true, true)).toBe(false);
        expect(isHumanInteractiveSession({ VITEST: "true" }, true, true)).toBe(false);
        expect(isHumanInteractiveSession({ CI: "true" }, false, false, true)).toBe(true);
    });
});

describe("built MCP server — global launch folder + MCP roots/list", () => {
    it("binds to the client's MCP root without polluting the global plugin folder", async () => {
        const builtServer = path.join(repoRoot, "dist", "index.js");
        if (!fs.existsSync(builtServer)) throw new Error("Run npm run build before the built-server test.");

        const pluginFolder = path.join(home, ".gemini", "config", "plugins", "nreki");
        fs.mkdirSync(pluginFolder, { recursive: true });
        fs.writeFileSync(path.join(projectA, "alpha.ts"), "export function alphaCondorBeacon(): number { return 7; }\n");
        fs.writeFileSync(path.join(projectB, "beta.ts"), "export function betaJaguarBeacon(): number { return 9; }\n");

        const env = {
            ...getDefaultEnvironment(),
            HOME: home,
            USERPROFILE: home,
            NREKI_PROJECT_ROOT: "",
            NREKI_TRUST_DIR: process.env.NREKI_TRUST_DIR ?? "",
        };

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [builtServer],
            cwd: pluginFolder,
            env,
            stderr: "ignore",
        });

        const client = new Client(
            { name: "global-roots-test", version: "1.0.0" },
            { capabilities: { roots: { listChanged: true } } },
        );
        let activeRootUri = pathToFileURL(projectA).href;
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
            roots: [{ uri: activeRootUri, name: "workspace" }],
        }));

        await client.connect(transport);
        const serverPid = transport.pid;
        try {
            let textA = "";
            for (let i = 0; i < 40; i++) {
                const r = await client.callTool({
                    name: "nreki_navigate",
                    arguments: { action: "fast_grep", query: "alphaCondorBeacon" },
                });
                textA = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
                if (textA.includes("alpha.ts")) break;
                await new Promise((ok) => setTimeout(ok, 300));
            }
            expect(textA).toContain("alpha.ts");

            // Also supports switching via explicit project_root parameter
            let textB = "";
            for (let i = 0; i < 40; i++) {
                const r = await client.callTool({
                    name: "nreki_navigate",
                    arguments: { action: "fast_grep", query: "betaJaguarBeacon", project_root: projectB },
                });
                textB = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
                if (textB.includes("beta.ts")) break;
                await new Promise((ok) => setTimeout(ok, 300));
            }
            expect(textB).toContain("beta.ts");
        } finally {
            await client.close();
            await waitForExit(serverPid);
        }

        // Global plugin folder stayed 100% clean (no .nreki.db or .nreki created there!)
        expect(fs.readdirSync(pluginFolder)).toEqual([]);
    }, 120_000);
});
