/**
 * External audit of the unreleased 12.5.2 field-report fixes (2026-11-27).
 * Each block reproduces a finding that held after checking it against the code:
 *   F1  "this session" was the whole .nreki.db history (session start never stored);
 *   F2  two installs of the hook kept a big Read blocked forever;
 *   F3  the user-scope migration ignored .claude/settings.local.json and CLAUDE_CONFIG_DIR;
 *   F4  a live case-only rename left two rows, the old one stale;
 *   F5  below a junctioned (or 8.3) root files kept the typed spelling;
 *   F7  quoted data in a bug report was listed as literal text, past token_budget;
 *   F8  project init skipped a tool the user already hooked; project deinit deleted the user's hook;
 *   F9  status/report mixed workspaces of one global server;
 *   F10 `-Raw | Select-Object -First N`, Git Bash /d/… paths, init downgrading a newer hook,
 *       merge-conflict stages counted three times.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { handleGuard } from "../src/router.js";
import type { RouterDependencies } from "../src/router.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { extractLiteralTerms, handleContext } from "../src/handlers/context-pack.js";
import { safePath } from "../src/utils/path-jail.js";
import { onDiskCase, onDiskCaseUnder } from "../src/utils/path-case.js";
import { latencyTracker } from "../src/utils/latency-tracker.js";
import { trackedNrekiState } from "../src/utils/state-hygiene.js";
import { runInit } from "../src/init/init-runner.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_TEMPLATE = path.join(repoRoot, "templates", "hooks", "nreki-enforcer.mjs");
const isWin = process.platform === "win32";
const caseInsensitive = isWin || process.platform === "darwin";

const cleanups: Array<() => void> = [];
const engines: NrekiEngine[] = [];
afterEach(() => {
    while (engines.length > 0) { try { engines.pop()!.shutdown(); } catch { /* closed */ } }
    while (cleanups.length > 0) cleanups.pop()!();
});

function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows lock */ } });
    return dir;
}

function write(root: string, rel: string, text: string): string {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
}

function open(root: string): NrekiEngine {
    const engine = new NrekiEngine({ dbPath: path.join(root, ".nreki.db"), watchPaths: [root] });
    engines.push(engine);
    return engine;
}

const textOf = (res: { content: Array<{ text?: string }> }) => res.content.map(c => c.text ?? "").join("\n");

/** Run `fn` with an environment variable set or removed, then restore it. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
    const before = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(); } finally {
        if (before === undefined) delete process.env[name]; else process.env[name] = before;
    }
}

function junction(target: string, link: string): boolean {
    try { fs.symlinkSync(target, link, isWin ? "junction" : "dir"); return true; } catch { return false; }
}

// ─── F1 ─────────────────────────────────────────────────────────────

describe("F1. 'this session' is this engine's session, buffered calls included", () => {
    it("history of earlier sessions moves neither the pressure valve nor report's Output Avoided", async () => {
        const root = mkTmp("nreki-f1-");
        write(root, "a.ts", "export const a = 1;\n");
        const earlier = open(root);
        await earlier.initialize();
        earlier.logUsage("nreki_context", 200_000, 200_000, 5_000);
        earlier.shutdown(); // flushes the rows to the DB
        await new Promise(r => setTimeout(r, 1_100)); // SQLite timestamps have 1 s resolution

        const engine = open(root);
        await engine.initialize();
        engine.logUsage("nreki_search", 777, 777, 777); // still in the write buffer
        const session = engine.getUsageStats(engine.getSessionStart());
        expect(session.total_output).toBe(777);
        expect(session.tool_calls).toBe(1);

        const deps = {
            engine,
            monitor: new TokenMonitor({ logPath: path.join(root, "no-such-usage.jsonl") }),
            circuitBreaker: new CircuitBreaker(root),
        } as unknown as RouterDependencies;
        const report = textOf(await handleGuard("report", { action: "report" }, deps));
        expect(deps.pressure ?? 0).toBeLessThan(0.1); // 200k of history made it 1.0: heartbeat off for good
        expect(report).toContain("Output Avoided: 777");
    });
});

// ─── F2 ─────────────────────────────────────────────────────────────

function liveProject(prefix: string): string {
    const root = mkTmp(prefix);
    write(root, `.nreki/sessions/${process.pid}`, "");
    write(root, "src/big.ts", Array.from({ length: 900 }, (_, i) =>
        `export function handler${i}(input: number): number { return input * ${i} + ${i}; } // line ${i} with enough text to weigh`).join("\n") + "\n");
    return root;
}

function hookProcess(hookFile: string, root: string, payload: Record<string, unknown>, env: Record<string, string>): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [hookFile], {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "", NREKI_READ_MAX_TOKENS: "", ...env },
            stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", reject);
        child.on("close", code => resolve(code));
        child.stdin.end(JSON.stringify(payload));
    });
}

let callSeq = 0;
/**
 * Claude Code runs every matching hook of a call in parallel, each with the
 * call's tool_use_id; the call is blocked if any of them exits 2.
 */
async function call(hooks: string[], root: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<"blocked" | "allowed"> {
    const withId = { ...payload, tool_use_id: `toolu_test_${process.pid}_${++callSeq}` };
    const codes = await Promise.all(hooks.map(h => hookProcess(h, root, withId, env)));
    return codes.includes(2) ? "blocked" : "allowed";
}

describe("F2. two installs of the hook block a big Read once, never forever", () => {
    const bigRead = (root: string) => ({ tool_name: "Read", tool_input: { file_path: path.join(root, "src", "big.ts") } });

    it("twin copies that both decide share the cycle: blocked, the repeat allowed, and again (one free repeat per block)", async () => {
        const root = liveProject("nreki-f2-twins-");
        const twin = write(mkTmp("nreki-f2-copy-"), "nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        for (let round = 0; round < 3; round++) {
            expect(await call([HOOK_TEMPLATE, twin], root, bigRead(root)), `round ${round} first call`).toBe("blocked");
            expect(await call([HOOK_TEMPLATE, twin], root, bigRead(root)), `round ${round} repeat`).toBe("allowed");
        }
    });

    it("a v4/v5 user copy and a v6 project copy: the project copy steps aside, so the cycle works", async (ctx) => {
        const legacy = spawnSync("git", ["show", "9a46ac3:templates/hooks/nreki-enforcer.mjs"], { cwd: repoRoot, encoding: "utf8" });
        if (legacy.status !== 0 || !legacy.stdout.includes("nreki-enforcer:v5")) ctx.skip("12.5.1 is not in this clone's history");
        const root = liveProject("nreki-f2-mixed-");
        const projectHook = write(root, ".claude/hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        write(root, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" }] }] } }));
        const config = mkTmp("nreki-f2-config-");
        const userHook = write(config, "hooks/nreki-enforcer.mjs", legacy.stdout);
        write(config, "settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `node "${userHook.replace(/\\/g, "/")}"` }] }] } }));
        const env = { CLAUDE_CONFIG_DIR: config };
        expect(await call([userHook, projectHook], root, bigRead(root), env)).toBe("blocked");
        expect(await call([userHook, projectHook], root, bigRead(root), env)).toBe("allowed");
    });

    it("the user copy steps aside for a legacy project copy registered for the tool, not for others", async () => {
        const root = liveProject("nreki-f2-userside-");
        write(root, ".claude/hooks/nreki-enforcer.mjs", "// nreki-enforcer:v5 — legacy project copy\n");
        write(root, ".claude/settings.local.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" }] }] } }));
        const config = mkTmp("nreki-f2-config-");
        const userHook = write(config, "hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        const env = { CLAUDE_CONFIG_DIR: config };
        expect(await call([userHook], root, bigRead(root), env)).toBe("allowed"); // the v5 project copy decides
        const bash = { tool_name: "Bash", tool_input: { command: "cat src/big.ts" }, cwd: root };
        expect(await call([userHook], root, bash, env)).toBe("blocked"); // the v5 copy is not registered for Bash
    });

    it.runIf(isWin)("a project reached through a junction still knows its own hook copy", async (ctx) => {
        const real = liveProject("nreki-f2-real-");
        const link = path.join(mkTmp("nreki-f2-link-"), "Proj");
        if (!junction(real, link)) ctx.skip("junctions unavailable");
        const projectHook = write(real, ".claude/hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        const config = mkTmp("nreki-f2-config-");
        const userHook = write(config, "hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        write(config, "settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `node "${userHook.replace(/\\/g, "/")}"` }] }] } }));
        const viaLink = path.join(link, ".claude", "hooks", "nreki-enforcer.mjs");
        expect(fs.existsSync(projectHook)).toBe(true);
        const payload = { tool_name: "Read", tool_input: { file_path: path.join(link, "src", "big.ts") } };
        const code = await hookProcess(viaLink, link, payload, { CLAUDE_CONFIG_DIR: config });
        expect(code).toBe(0); // project copy, user copy registered and as new: steps aside
    });
});

// ─── F3 ─────────────────────────────────────────────────────────────

describe("F3. the user-scope migration leaves no dangling hook and respects CLAUDE_CONFIG_DIR", () => {
    it("NREKI's command is removed from settings.local.json too before the hook file goes", () => {
        const project = mkTmp("nreki-f3-");
        const home = mkTmp("nreki-f3-home-");
        write(project, "package.json", "{}");
        write(project, ".claude/hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        write(project, ".claude/settings.local.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [
            { type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" },
            { type: "command", command: "node my-local-guard.mjs" },
        ] }] } }));
        withEnv("CLAUDE_CONFIG_DIR", undefined, () => runInit({ cwd: project, home, global: true, agent: "claude", mcp: true }));
        const local = fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8");
        expect(local).not.toContain("nreki-enforcer.mjs");
        expect(local).toContain("my-local-guard.mjs");
        expect(fs.existsSync(path.join(project, ".claude", "hooks", "nreki-enforcer.mjs"))).toBe(false);
    });

    it("B4: when git tracks the removed project install, init says so", (ctx) => {
        const project = mkTmp("nreki-b4-");
        const home = mkTmp("nreki-b4-home-");
        write(project, "package.json", "{}");
        runInit({ cwd: project, home, agent: "claude", mcp: false });
        const git = (...args: string[]) => spawnSync("git", args, { cwd: project, encoding: "utf8" });
        if (git("init", "-q").status !== 0) ctx.skip("git is not installed");
        expect(git("add", "-f", "CLAUDE.md", ".claude").status).toBe(0);
        const result = withEnv("CLAUDE_CONFIG_DIR", undefined, () => runInit({ cwd: project, home, global: true, agent: "claude", mcp: true }));
        const note = result.notes.find(n => n.includes("tracked by git")) ?? "";
        expect(note).toContain("CLAUDE.md");
        expect(note).toContain(".claude/settings.json");
    });

    it("with CLAUDE_CONFIG_DIR pointing elsewhere the project install is kept", () => {
        const project = mkTmp("nreki-f3-cfg-");
        const home = mkTmp("nreki-f3-cfg-home-");
        write(project, "package.json", "{}");
        runInit({ cwd: project, home, agent: "claude", mcp: false });
        const result = withEnv("CLAUDE_CONFIG_DIR", mkTmp("nreki-f3-profile-"),
            () => runInit({ cwd: project, home, global: true, agent: "claude", mcp: true }));
        expect(result.actions.some(a => a.note?.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
        expect(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8")).toContain("nreki-enforcer.mjs");
        expect(fs.existsSync(path.join(project, ".claude", "hooks", "nreki-enforcer.mjs"))).toBe(true);
        expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toContain("# NREKI ACTIVE");
    });
});

// ─── F4 ─────────────────────────────────────────────────────────────

describe("F4. a live case-only rename stays one row", () => {
    it.runIf(caseInsensitive)("both spellings reported by the watcher index one file, with its new text", async () => {
        const root = mkTmp("nreki-f4-");
        write(root, "src/limpieza.ts", "export const v = 'OLD_RENAME_MARK';\n");
        const engine = open(root);
        await engine.ensureIndexed();
        fs.renameSync(path.join(root, "src", "limpieza.ts"), path.join(root, "src", "Limpieza.ts"));
        fs.writeFileSync(path.join(root, "src", "Limpieza.ts"), "export const v = 'NEW_RENAME_MARK';\n");
        // What chokidar reports on NTFS for a case-only rename: events under both spellings.
        await engine.indexFile(path.join(root, "src", "limpieza.ts"));
        await engine.indexFile(path.join(root, "src", "Limpieza.ts"));
        expect(engine.getStats().filesIndexed).toBe(1);
        expect(await engine.fastGrep("OLD_RENAME_MARK", 10)).toEqual([]);
        const hits = await engine.fastGrep("NEW_RENAME_MARK", 10);
        expect(hits.map(h => path.basename(h.path))).toEqual(["Limpieza.ts"]);
    });
});

// ─── F5 ─────────────────────────────────────────────────────────────

describe("F5. below a root reached through a junction, files are spelled as on disk", () => {
    it.runIf(isWin)("existing files and the folders of new ones; the junction's own name as its folder lists it", (ctx) => {
        const real = mkTmp("nreki-f5-real-");
        const parent = mkTmp("nreki-f5-link-");
        const link = path.join(parent, "Proj");
        if (!junction(real, link)) ctx.skip("junctions unavailable");
        write(real, "Src/App.tsx", "x");
        expect(safePath(link, "src/app.tsx")).toBe(path.join(link, "Src", "App.tsx"));
        expect(safePath(link, "src/New.tsx")).toBe(path.join(link, "Src", "New.tsx"));
        expect(onDiskCase(path.join(parent, "proj", "src"))).toBe(path.join(link, "Src"));
    });
});

describe("F5b. a spelling the disk cannot confirm is never re-spelled into the root", () => {
    it("a typed root part that differs in case and does not exist keeps its spelling (macOS CI, /home/X vs /home/x)", () => {
        const tmp = mkTmp("nreki-f5b-");
        const root = path.join(tmp, "missing-Root");
        const typed = path.join(tmp, "MISSING-root", "y.ts");
        for (const platform of ["darwin", "win32"] as const) {
            expect(onDiskCaseUnder(root, typed, platform)).toBe(path.resolve(typed));
        }
    });

    it.runIf(isWin)("where the disk answers to the typed name it still takes the disk's spelling", () => {
        const tmp = mkTmp("nreki-f5b-sib-");
        fs.mkdirSync(path.join(tmp, "Data"));
        expect(onDiskCase(path.join(tmp, "data", "new.ts"))).toBe(path.join(onDiskCase(tmp), "Data", "new.ts"));
    });
});

// ─── F7 ─────────────────────────────────────────────────────────────

describe("F7. literal mentions: only text to change, within token_budget", () => {
    it("quoted data in a bug report is not a literal; a quoted label with a text change is", () => {
        expect(extractLiteralTerms('Fix bug where "status" is "pending" instead of "paid"')).toEqual([]);
        expect(extractLiteralTerms('The button says "Guardar" but should say "Enviar"')).toEqual(["Guardar", "Enviar"]);
        expect(extractLiteralTerms("change 'limpieza' to 'servicios' in the menu")).toEqual(["limpieza", "servicios"]);
    });

    it("over token_budget the list becomes one line pointing at fast_grep", async () => {
        const root = mkTmp("nreki-f7-");
        for (let i = 0; i < 30; i++) {
            write(root, `src/page${i}.ts`, `export function page${i}() { return ['Inicio', 'Limpieza']; }\nexport const title${i} = 'Limpieza ${i}';\n`);
        }
        const text = textOf(await handleContext(
            { action: "context", query: "cambiar Limpieza en toda la página", token_budget: 300 },
            { engine: open(root) } as unknown as RouterDependencies,
        ));
        expect(text).toContain('"Limpieza" (any case): 60 line(s) in 30 file(s)');
        expect(text).toContain('fast_grep query:"Limpieza" ignore_case:true lists them');
        expect(text).not.toMatch(/src\/page\d+\.ts:L1,L2; src\/page/);
    });
});

// ─── F8 ─────────────────────────────────────────────────────────────

describe("F8. project install and removal keep the user's own hooks", () => {
    it("init adds NREKI beside the user's own Bash hook; deinit removes only NREKI's command", () => {
        const project = mkTmp("nreki-f8-");
        write(project, "package.json", "{}");
        write(project, ".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node my-own-guard.mjs" }] }] } }, null, 2));
        runInit({ cwd: project, home: mkTmp("nreki-f8-home-"), agent: "claude", mcp: false });
        type Entry = { matcher: string; hooks: Array<{ command: string }> };
        const read = () => JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8")).hooks.PreToolUse as Entry[];
        const bash = read().filter(e => e.matcher === "Bash").flatMap(e => e.hooks.map(h => h.command));
        expect(bash).toContain("node my-own-guard.mjs");
        expect(bash.some(c => c.includes("nreki-enforcer.mjs"))).toBe(true);

        const builtServer = path.join(repoRoot, "dist", "index.js");
        if (!fs.existsSync(builtServer)) throw new Error("Run npm run build before this test.");
        const r = spawnSync(process.execPath, [builtServer, "deinit"], { cwd: project, env: { ...process.env, NREKI_PROJECT_ROOT: "" }, encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const left = read();
        expect(JSON.stringify(left)).not.toContain("nreki-enforcer.mjs");
        expect(left.flatMap(e => e.hooks.map(h => h.command))).toEqual(["node my-own-guard.mjs"]);
    }, 60_000);
});

// ─── F9 ─────────────────────────────────────────────────────────────

describe("F9. a new workspace is a new session for status", () => {
    it("reset forgets the previous workspace's calls", () => {
        latencyTracker.record("nreki_navigate:fast_grep", 5, 100);
        latencyTracker.reset();
        expect(latencyTracker.getCallTotals().calls).toBe(0);
        expect(latencyTracker.getSummary()).toContain("No operations recorded yet.");
    });
});

// ─── F10 ────────────────────────────────────────────────────────────

describe("F10. smaller holes", () => {
    const shell = (tool: string, command: string, root: string) => ({ tool_name: tool, tool_input: { command }, cwd: root });

    it("Get-Content -Raw | Select-Object -First N prints the whole file: measured as such", async () => {
        const root = liveProject("nreki-f10-raw-");
        expect(await call([HOOK_TEMPLATE], root, shell("PowerShell", "Get-Content -Raw src/big.ts | Select-Object -First 5", root))).toBe("blocked");
        const other = liveProject("nreki-f10-skip-");
        expect(await call([HOOK_TEMPLATE], other, shell("PowerShell", "Get-Content -Raw src/big.ts | Select-Object -Skip 1 -First 5", other))).toBe("allowed");
    });

    it.runIf(isWin)("a Git Bash /d/… path is the same file", async () => {
        const root = liveProject("nreki-f10-msys-");
        const msys = path.join(root, "src", "big.ts").replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
        expect(await call([HOOK_TEMPLATE], root, shell("Bash", `cat ${msys}`, root))).toBe("blocked");
    });

    it("an older init never downgrades a newer hook", () => {
        const project = mkTmp("nreki-f10-down-");
        write(project, "package.json", "{}");
        const hook = write(project, ".claude/hooks/nreki-enforcer.mjs", "#!/usr/bin/env node\n// nreki-enforcer:v9 — from a newer NREKI\n");
        const result = runInit({ cwd: project, home: mkTmp("nreki-f10-home-"), agent: "claude", mcp: false });
        expect(result.actions.find(a => a.path.endsWith("nreki-enforcer.mjs"))?.note).toContain("newer NREKI hook");
        expect(fs.readFileSync(hook, "utf8")).toContain("v9");
    });

    it("a file in a merge conflict (three index stages) is named once", () => {
        const root = mkTmp("nreki-f10-stages-");
        const entry = (name: string): Buffer => {
            const header = Buffer.alloc(62);
            header.writeUInt16BE(name.length, 60);
            const len = 62 + name.length;
            return Buffer.concat([header, Buffer.from(name), Buffer.alloc(((len + 8) & ~7) - len)]);
        };
        const count = Buffer.alloc(4);
        count.writeUInt32BE(4);
        const version = Buffer.alloc(4);
        version.writeUInt32BE(2);
        const index = Buffer.concat([Buffer.from("DIRC"), version, count, entry(".nreki.db"), entry(".nreki.db"), entry(".nreki.db"), entry("app.ts")]);
        write(root, ".git/index", "");
        fs.writeFileSync(path.join(root, ".git", "index"), index);
        expect(trackedNrekiState(root)).toEqual([".nreki.db"]);
    });
});
