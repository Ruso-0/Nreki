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
    hasProjectMarker,
    inferProjectRootFromPath,
    isNonProjectLaunchDir,
    isSameOrInside,
    pickRootFromMcpRoots,
    pickRootsFromMcpRoots,
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
import { dialogTexts, initTerminalDefaults, isHumanInteractiveSession } from "../src/init/voyage-prompt.js";

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

    // 12.5.1: a project_root is now checked against this list, and "/" or the
    // home folder used to pass (NREKI would have watched the whole disk).
    it("never takes a drive root, a folder above home, or a hidden or system folder for a project", () => {
        expect(isNonProjectLaunchDir(path.parse(projectA).root, home)).toBe(true);
        expect(isNonProjectLaunchDir(path.dirname(home), home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, ".ssh"), home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, ".config", "nvim"), home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, "AppData", "Local", "npm-cache", "_npx", "a1b2"), home)).toBe(true);
        expect(isNonProjectLaunchDir(path.join(home, "code", "app"), home)).toBe(false);
        expect(isNonProjectLaunchDir(projectA, home)).toBe(false);
        if (process.platform === "win32") {
            expect(isNonProjectLaunchDir("C:\\Windows\\System32", home)).toBe(true);
            expect(isNonProjectLaunchDir("C:\\Program Files\\WindowsApps\\Some.App", home)).toBe(true);
        } else {
            expect(isNonProjectLaunchDir("/usr/lib/node_modules/npm", home)).toBe(true);
        }
    });

    // The macOS CI failure of 12.5.0: HOME was /var/… and process.cwd() /private/var/….
    it("recognizes the home folder reached through a link", (ctx) => {
        const link = path.join(projectB, "home-link");
        try {
            fs.symlinkSync(home, link, process.platform === "win32" ? "junction" : "dir");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EPERM") ctx.skip("environment blocks directory junctions");
            throw err;
        }
        expect(isNonProjectLaunchDir(path.join(link, ".gemini", "config", "plugins", "nreki"), home)).toBe(true);
        expect(isNonProjectLaunchDir(link, home)).toBe(true);
        expect(isSameOrInside(path.join(link, "code"), home)).toBe(true);
        expect(isSameOrInside(projectA, home)).toBe(false);
    });

    it("lists every local MCP root once, in order", () => {
        const a = pathToFileURL(projectA).href;
        const b = pathToFileURL(projectB).href;
        expect(pickRootsFromMcpRoots([{ uri: "https://nope" }, { uri: a }, { uri: b }, { uri: a }]))
            .toEqual([path.resolve(projectA), path.resolve(projectB)]);
        expect(pickRootsFromMcpRoots(undefined)).toEqual([]);
    });

    it("counts .git or package.json as a project marker, not the .nreki.db NREKI creates itself", () => {
        fs.writeFileSync(path.join(projectA, ".nreki.db"), "");
        expect(hasProjectMarker(projectA)).toBe(false);
        fs.writeFileSync(path.join(projectA, "package.json"), "{}\n");
        expect(hasProjectMarker(projectA)).toBe(true);
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

    // 12.5.0 dropped the whole matcher entry, and with it the user's own hook.
    it("deinit --global removes only NREKI's command from a matcher the user already had", () => {
        const settingsPath = path.join(home, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const userHook = { type: "command", command: "node /opt/my-guard.mjs" };
        fs.writeFileSync(settingsPath, JSON.stringify({
            model: "opus",
            hooks: { PreToolUse: [{ matcher: "Edit", hooks: [userHook] }] },
        }, null, 2));

        registerGlobalAgent("claude", { home, version: "12.5.1" });
        const wired = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
            hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
        };
        const editEntry = wired.hooks.PreToolUse.find((h) => h.matcher === "Edit");
        expect(editEntry?.hooks.map((h) => h.command.includes("nreki-enforcer.mjs"))).toEqual([false, true]);

        unregisterGlobalAll(home);
        const after = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        expect(after.model).toBe("opus");
        expect(after.hooks).toEqual({ PreToolUse: [{ matcher: "Edit", hooks: [userHook] }] });
    });

    // 12.5.0: --no-prompt also turned the user-scope install into a project install.
    it("--prompt and --no-prompt only decide the Voyage box, never the install scope", () => {
        const person: NodeJS.ProcessEnv = {};
        expect(initTerminalDefaults({}, person, true, true)).toEqual({ global: true, showVoyageBox: true });
        expect(initTerminalDefaults({ prompt: false }, person, true, true)).toEqual({ global: true, showVoyageBox: false });
        expect(initTerminalDefaults({ global: false }, person, true, true)).toEqual({ global: false, showVoyageBox: true });
        expect(initTerminalDefaults({}, { CI: "true" }, true, true)).toEqual({ global: undefined, showVoyageBox: false });
        expect(initTerminalDefaults({ prompt: true }, { CLAUDECODE: "1" }, false, false))
            .toEqual({ global: undefined, showVoyageBox: true });
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
    const ALPHA = "export function alphaCondorBeacon(): number { return 7; }\n";
    const BETA = "export function betaJaguarBeacon(): number { return 9; }\n";

    /** The built server started in `cwd`; `roots` = null for a client without MCP roots. */
    async function startBuiltServer(cwd: string, roots: string[] | null) {
        const builtServer = path.join(repoRoot, "dist", "index.js");
        if (!fs.existsSync(builtServer)) throw new Error("Run npm run build before the built-server test.");
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [builtServer],
            cwd,
            env: {
                ...getDefaultEnvironment(),
                HOME: home,
                USERPROFILE: home,
                NREKI_PROJECT_ROOT: "",
                NREKI_TRUST_DIR: process.env.NREKI_TRUST_DIR ?? "",
            },
            stderr: "ignore",
        });
        const client = new Client(
            { name: "global-roots-test", version: "1.0.0" },
            { capabilities: roots ? { roots: { listChanged: true } } : {} },
        );
        let current = roots ?? [];
        if (roots) {
            client.setRequestHandler(ListRootsRequestSchema, async () => ({
                roots: current.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) })),
            }));
        }
        await client.connect(transport);
        return {
            client,
            pid: transport.pid,
            /** The editor opens other folders: roots/list_changed. */
            setRoots: async (dirs: string[]) => { current = dirs; await client.sendRootsListChanged(); },
            close: async () => { await client.close(); await waitForExit(transport.pid); },
        };
    }

    async function navigate(client: Client, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
        const r = await client.callTool({ name: "nreki_navigate", arguments: args });
        return {
            text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n"),
            isError: r.isError === true,
        };
    }

    async function navigateUntil(client: Client, args: Record<string, unknown>, needle: string): Promise<string> {
        let text = "";
        for (let i = 0; i < 40; i++) {
            text = (await navigate(client, args)).text;
            if (text.includes(needle)) break;
            await new Promise((ok) => setTimeout(ok, 300));
        }
        return text;
    }

    it("binds to the client's MCP root, refuses a project_root outside the roots, and follows roots/list_changed", async () => {
        const pluginFolder = path.join(home, ".gemini", "config", "plugins", "nreki");
        fs.mkdirSync(pluginFolder, { recursive: true });
        fs.writeFileSync(path.join(projectA, "alpha.ts"), ALPHA);
        fs.writeFileSync(path.join(projectB, "beta.ts"), BETA);

        const server = await startBuiltServer(pluginFolder, [projectA]);
        try {
            expect(await navigateUntil(server.client, { action: "fast_grep", query: "alphaCondorBeacon" }, "alpha.ts"))
                .toContain("alpha.ts");

            // A tool argument cannot move NREKI out of the folders the editor shared…
            const refused = await navigate(server.client, { action: "fast_grep", query: "betaJaguarBeacon", project_root: projectB });
            expect(refused.isError).toBe(true);
            expect(refused.text).toContain("outside the workspace folders");

            // …the editor opening another folder does.
            await server.setRoots([projectB]);
            expect(await navigateUntil(server.client, { action: "fast_grep", query: "betaJaguarBeacon" }, "beta.ts"))
                .toContain("beta.ts");
        } finally {
            await server.close();
        }

        // The global plugin folder stayed clean (no .nreki.db or .nreki created there).
        expect(fs.readdirSync(pluginFolder)).toEqual([]);
    }, 120_000);

    it("without MCP roots waits for project_root and refuses the home, hidden and system folders", async () => {
        const pluginFolder = path.join(home, ".gemini", "config", "plugins", "nreki");
        fs.mkdirSync(pluginFolder, { recursive: true });
        fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
        fs.writeFileSync(path.join(projectB, "beta.ts"), BETA);

        const server = await startBuiltServer(pluginFolder, null);
        try {
            const unbound = await navigate(server.client, { action: "fast_grep", query: "betaJaguarBeacon" });
            expect(unbound.isError).toBe(true);
            expect(unbound.text).toContain("project_root");

            for (const forbidden of [home, path.join(home, ".claude"), path.parse(home).root]) {
                const r = await navigate(server.client, { action: "fast_grep", query: "betaJaguarBeacon", project_root: forbidden });
                expect(r.isError, forbidden).toBe(true);
                expect(r.text, forbidden).toContain("not a project");
            }

            expect(await navigateUntil(server.client,
                { action: "fast_grep", query: "betaJaguarBeacon", project_root: projectB }, "beta.ts")).toContain("beta.ts");
        } finally {
            await server.close();
        }

        expect(fs.readdirSync(pluginFolder)).toEqual([]);
        expect(fs.existsSync(path.join(home, ".nreki.db"))).toBe(false);
        expect(fs.readdirSync(path.join(home, ".claude"))).toEqual([]);
    }, 120_000);

    it("started inside a project (Claude Code), a project_root outside it is refused", async () => {
        fs.writeFileSync(path.join(projectA, "package.json"), "{}\n");
        fs.writeFileSync(path.join(projectA, "alpha.ts"), ALPHA);
        fs.writeFileSync(path.join(projectB, "beta.ts"), BETA);

        const server = await startBuiltServer(projectA, null);
        try {
            const refused = await navigate(server.client, { action: "fast_grep", query: "betaJaguarBeacon", project_root: projectB });
            expect(refused.isError).toBe(true);
            expect(refused.text).toContain("the project it was started in");

            // Naming the project it already serves is fine.
            expect(await navigateUntil(server.client,
                { action: "fast_grep", query: "alphaCondorBeacon", project_root: projectA }, "alpha.ts")).toContain("alpha.ts");
        } finally {
            await server.close();
        }

        expect(fs.existsSync(path.join(projectB, ".nreki.db"))).toBe(false);
        expect(fs.existsSync(path.join(projectB, ".nreki"))).toBe(false);
    }, 120_000);
});
