/**
 * Field report of 2026-11-27: a Claude Code session on a real Vite + React
 * project running NREKI 12.3.0 from npx. Each block reproduces one finding and
 * fails without its fix:
 *   1. every file was indexed twice (d:\… from VS Code, D:\… from a terminal)
 *      and the stale twin kept serving a renamed file and replaced text;
 *   2. orphan_oracle called everything App.tsx imports "unreachable";
 *   3. status printed 0 tokens / 0 calls / "No operations recorded" after ~20 calls;
 *   4. fast_grep "LIMPIEZA" found nothing in a site that says "Limpieza";
 *   5. context gave one symbol for "cambiar Limpieza en toda la página";
 *   6. .nreki.db and .nreki/ were committed; a 1.5 MB temporary sat in the root;
 *   7. the project's copy of the hook ran beside the user-level copy, `cat` of a
 *      big file went around the Read budget, and init never refreshed its block;
 *   8. the refusal of .claude/hooks/ read like a bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB, toSqliteUtc } from "../src/database.js";
import { handleFastGrep, handleOrphanOracle } from "../src/handlers/navigate.js";
import { extractLiteralTerms, handleContext } from "../src/handlers/context-pack.js";
import { handleStatus } from "../src/handlers/guard.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { wrapWithCircuitBreaker } from "../src/middleware/circuit-breaker.js";
import { latencyTracker } from "../src/utils/latency-tracker.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { safePath } from "../src/utils/path-jail.js";
import { onDiskCase, onDiskCaseUnder } from "../src/utils/path-case.js";
import { declaredEntries, isConventionalEntry } from "../src/utils/entry-points.js";
import { ensureGitExcludes, removeStaleTemps, trackedNrekiState } from "../src/utils/state-hygiene.js";
import { upgradeEnforcerHook } from "../src/init/hook-upgrade.js";
import { runInit } from "../src/init/init-runner.js";
import { CLAUDE_HOOK_TOOLS } from "../src/init/global-register.js";
import type { RouterDependencies } from "../src/router.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_TEMPLATE = path.join(repoRoot, "templates", "hooks", "nreki-enforcer.mjs");
const isWin = process.platform === "win32";

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

const depsOf = (engine: NrekiEngine) => ({ engine } as unknown as RouterDependencies);
const textOf = (res: { content: Array<{ text?: string }> }) => res.content.map(c => c.text ?? "").join("\n");

/** The same folder spelled another way (on Windows: lower-case drive letter and names, as VS Code passes it). */
function otherSpelling(p: string): string {
    return p.toLowerCase() !== p ? p.toLowerCase() : p.toUpperCase();
}

// ─── 1 ──────────────────────────────────────────────────────────────

describe("1. one index row per file, whatever spelling the server was started with", () => {
    it("a DB keyed under another spelling of the root is reconciled: no twin, no stale text, no renamed file", async () => {
        const root = mkTmp("nreki-dup-Case-");
        write(root, "src/Header.tsx", "export const label = 'Servicios Generales';\n");
        write(root, "src/Footer.tsx", "export const footer = 'UNCHANGED_FOOTER_MARK';\n");

        // What a launch under the other spelling left in the same .nreki.db.
        const twin = otherSpelling(root);
        const legacy = new NrekiDB(path.join(root, ".nreki.db"), twin);
        await legacy.initialize();
        const put = (rel: string, code: string) => {
            const p = path.join(twin, rel);
            legacy.insertChunk(p, `[top_level] ${path.basename(rel)}`, code, "top_level", 1, 1, 0, code.length);
            legacy.upsertFile(p, legacy.hashContent(code));
        };
        put("src/Header.tsx", "export const label = 'Limpieza';\n");
        put("src/Footer.tsx", "export const footer = 'UNCHANGED_FOOTER_MARK';\n");
        put("src/LimpiezaPage.tsx", "export function LimpiezaPage() { return 'Limpieza'; }\n");
        legacy.close();

        const engine = open(root);
        expect(await engine.fastGrep("Limpieza", 20)).toEqual([]);
        expect(await engine.fastGrep("Servicios Generales", 20)).toHaveLength(1);
        expect(await engine.fastGrep("UNCHANGED_FOOTER_MARK", 20)).toHaveLength(1);
        expect(engine.getStats().filesIndexed).toBe(2);
    });

    it.runIf(isWin)("an engine started under another spelling keys and prints the on-disk one", async (ctx) => {
        const root = mkTmp("nreki-dup-Spell-");
        if (fs.realpathSync.native(root) !== root) ctx.skip("temp folder behind a link or an 8.3 name");
        write(root, "App.tsx", "export const app = 'SPELLING_MARK';\n");
        const engine = new NrekiEngine({ dbPath: path.join(root, ".nreki.db"), watchPaths: [otherSpelling(root)] });
        engines.push(engine);
        expect(engine.getProjectRoot()).toBe(root);
        const hits = await engine.fastGrep("SPELLING_MARK", 20);
        expect(hits.map(h => h.path)).toEqual([path.join(root, "App.tsx")]);
    });

    it.runIf(isWin)("safePath spells a file as the disk does (drive letter and names)", (ctx) => {
        const root = mkTmp("nreki-dup-Jail-");
        if (fs.realpathSync.native(root) !== root) ctx.skip("temp folder behind a link or an 8.3 name");
        const file = write(root, "Src/App.tsx", "x");
        expect(safePath(root, "src/app.tsx")).toBe(file);
        expect(safePath(otherSpelling(root), otherSpelling(file))).toBe(file);
        // A new file: its existing folders are fixed, the new name kept.
        expect(safePath(root, "SRC/New.tsx")).toBe(path.join(root, "Src", "New.tsx"));
        expect(onDiskCase(otherSpelling(root))).toBe(root);
    });

    it.runIf(isWin)("a root reached through a junction keeps its own spelling (links are never followed)", (ctx) => {
        const real = mkTmp("nreki-dup-Real-");
        const parent = mkTmp("nreki-dup-Link-");
        const link = path.join(parent, "Proj");
        try { fs.symlinkSync(real, link, "junction"); } catch { ctx.skip("junctions unavailable"); }
        write(real, "Src/A.ts", "x");
        expect(onDiskCase(link)).toBe(link);
        // Re-spelled below the root as the disk spells it (audit F5), never moved to the target.
        const under = onDiskCaseUnder(link, path.join(link, "src", "a.ts"));
        expect(under).toBe(path.join(link, "Src", "A.ts"));
        expect(under.toLowerCase().startsWith(fs.realpathSync.native(real).toLowerCase())).toBe(false);
        expect(safePath(link, "Src/A.ts")).toBe(path.join(link, "Src", "A.ts"));
    });

    it.runIf(isWin || process.platform === "darwin")("a symbol read under one spelling is not a blind edit under another", () => {
        const root = mkTmp("nreki-dup-Pass-");
        const file = write(root, "Big.ts", Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i}; // padding line ${i}`).join("\n"));
        const enforcer = new CognitiveEnforcer(root);
        enforcer.registerFocusedSymbols(otherSpelling(file), ["v1"]);
        expect(enforcer.evaluate("nreki_code", "edit", { path: file, symbol: "v1", mode: "replace" }).blocked).toBe(false);
        expect(enforcer.evaluate("nreki_code", "edit", { path: file, symbol: "v2", mode: "replace" }).blocked).toBe(true);
    });
});

// ─── 2 ──────────────────────────────────────────────────────────────

describe("2. orphan_oracle starts where the project starts", () => {
    it("whatever main.tsx → App.tsx imports is reachable; a file nobody imports is still a candidate", async () => {
        const root = mkTmp("nreki-orphan-");
        write(root, "index.html", '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
        write(root, "package.json", JSON.stringify({ name: "site", private: true, type: "module" }));
        write(root, "src/main.tsx", "import App from './App'\nexport const mount = () => App\n");
        write(root, "src/App.tsx", "import { Header } from './components/corporate/Header'\nimport { CorporateLayout } from './components/layout/CorporateLayout'\nexport default function App() { return [Header, CorporateLayout] }\n");
        write(root, "src/components/corporate/Header.tsx", "export function Header() { return 'header' }\n");
        write(root, "src/components/layout/CorporateLayout.tsx", "import { Footer } from '../corporate/Footer'\nexport function CorporateLayout() { return Footer }\n");
        write(root, "src/components/corporate/Footer.tsx", "export function Footer() { return 'footer' }\n");
        write(root, "src/components/Unused.tsx", "export function NeverImported() { return 1 }\n");
        const engine = open(root);
        const text = textOf(await handleOrphanOracle({ action: "orphan_oracle" }, depsOf(engine)));
        expect(text).toContain("src/components/Unused.tsx");
        for (const used of ["Header.tsx", "Footer.tsx", "CorporateLayout.tsx"]) expect(text).not.toContain(used);
    });

    it("an entry only index.html or package.json names is a root too", async () => {
        const root = mkTmp("nreki-orphan-declared-");
        write(root, "index.html", '<script type="module" src="./src/bootstrap.tsx"></script>\n');
        write(root, "package.json", JSON.stringify({ name: "tool", bin: { tool: "./tools/launch.mjs" } }));
        write(root, "src/bootstrap.tsx", "import { Clock } from './widgets/Clock'\nexport const boot = Clock\n");
        write(root, "src/widgets/Clock.tsx", "export function Clock() { return 'tick' }\n");
        write(root, "tools/launch.mjs", "import { helper } from './helper.mjs'\nexport const run = helper\n");
        write(root, "tools/helper.mjs", "export function helper() { return 1 }\n");
        write(root, "src/widgets/Dead.tsx", "export function Dead() { return 0 }\n");
        const files = ["index.html", "package.json", "src/bootstrap.tsx", "src/widgets/Clock.tsx", "tools/launch.mjs", "tools/helper.mjs", "src/widgets/Dead.tsx"];
        expect([...declaredEntries(root, files)].sort()).toEqual(["src/bootstrap.tsx", "tools/launch.mjs"]);
        const text = textOf(await handleOrphanOracle({ action: "orphan_oracle" }, depsOf(open(root))));
        expect(text).toContain("src/widgets/Dead.tsx");
        for (const used of ["Clock.tsx", "helper.mjs", "bootstrap.tsx"]) expect(text).not.toContain(used);
    });

    it("entry names are matched on the file name, not the whole path", () => {
        expect(isConventionalEntry("src/main.tsx")).toBe(true);
        expect(isConventionalEntry("src/App.tsx")).toBe(true);
        expect(isConventionalEntry("postcss.config.js")).toBe(true);
        expect(isConventionalEntry("src/components/Header.tsx")).toBe(false);
    });
});

// ─── 3 ──────────────────────────────────────────────────────────────

describe("3. status reports what NREKI measured", () => {
    it("usage rows of the session's own UTC day count (ISO session start vs SQLite timestamps)", async () => {
        const root = mkTmp("nreki-usage-");
        const db = new NrekiDB(path.join(root, ".nreki.db"), root);
        await db.initialize();
        db.batchInsertUsage([["nreki_context", 100, 100, 0], ["nreki_search", 50, 50, 0]]);
        expect(db.getUsageStats(new Date(Date.now() - 60_000).toISOString()).tool_calls).toBe(2);
        expect(db.getUsageStats(new Date(Date.now() + 3_600_000).toISOString()).tool_calls).toBe(0);
        db.close();
        expect(toSqliteUtc("2026-11-27T08:15:00.123Z")).toBe("2026-11-27 08:15:00");
        expect(toSqliteUtc("2026-11-27 08:15:00")).toBe("2026-11-27 08:15:00");
    });

    it("every tool call is recorded with its latency and the tokens it returned", async () => {
        const before = latencyTracker.getCallTotals();
        const cb = new CircuitBreaker(mkTmp("nreki-cb-"));
        await wrapWithCircuitBreaker(cb, "nreki_navigate", "fast_grep",
            async () => ({ content: [{ type: "text" as const, text: "src/a.ts :: f (L1): hello world" }] }));
        const after = latencyTracker.getCallTotals();
        expect(after.calls).toBe(before.calls + 1);
        expect(after.tokens).toBeGreaterThan(before.tokens);
        expect(latencyTracker.getSummary()).toContain("nreki_navigate:fast_grep");
    });

    it("status says the agent's own counter is not visible instead of printing zeros", async () => {
        const root = mkTmp("nreki-status-");
        write(root, "a.ts", "export const a = 1;\n");
        const engine = open(root);
        await engine.ensureIndexed();
        const monitor = new TokenMonitor({ logPath: path.join(root, "no-such-usage.jsonl") });
        const text = textOf(await handleStatus({ engine, monitor } as unknown as RouterDependencies));
        expect(text).toContain("This session:");
        expect(text).toContain("not visible to NREKI");
        expect(text).not.toContain("Total Used:");
        expect(text).toContain("Index Status:");
        expect(text).toContain("Files: 1");
    });
});

// ─── 4 ──────────────────────────────────────────────────────────────

describe("4. fast_grep finds other casings", () => {
    it("exact case first; with no exact match it answers ignoring case and says so; ignore_case forces it", async () => {
        const root = mkTmp("nreki-grep-case-");
        write(root, "nav.tsx", "export const items = ['Inicio', 'Limpieza'];\nexport const TITLE = 'LIMPIEZA INDUSTRIAL';\n");
        const deps = depsOf(open(root));
        const exact = textOf(await handleFastGrep({ action: "fast_grep", query: "Limpieza" }, deps));
        expect(exact).toContain("(L1)");
        expect(exact).not.toContain("(L2)");
        expect(exact).not.toContain("any case");

        const lower = textOf(await handleFastGrep({ action: "fast_grep", query: "limpieza" }, deps));
        expect(lower).toContain("No exact-case match");
        expect(lower).toContain("(L1)");
        expect(lower).toContain("(L2)");

        const forced = textOf(await handleFastGrep({ action: "fast_grep", query: "Limpieza", ignore_case: true }, deps));
        expect(forced).toContain("(L2)");

        const none = textOf(await handleFastGrep({ action: "fast_grep", query: "Jardineria" }, deps));
        expect(none).toContain("No matches found");
    });
});

// ─── 5 ──────────────────────────────────────────────────────────────

describe("5. context lists every line of the text a task asks to change", () => {
    it("takes quoted text and the capitalized object of rename/replace/cambiar, not plain words", () => {
        expect(extractLiteralTerms("cambiar Limpieza en toda la página")).toEqual(["Limpieza"]);
        expect(extractLiteralTerms('Reemplaza "Limpieza" por "Servicios Generales" en el sitio')).toEqual(["Limpieza", "Servicios Generales"]);
        expect(extractLiteralTerms("Cambia todas las apariciones de Limpieza")).toEqual(["Limpieza"]);
        expect(extractLiteralTerms("Rename the Settings tab to Preferences")).toEqual(["Settings"]);
        expect(extractLiteralTerms("change the label of the button")).toEqual([]);
        expect(extractLiteralTerms("fix the bug where don't and it's break the parser")).toEqual([]);
    });

    it("context shows where the text appears, in any case, file by file", async () => {
        const root = mkTmp("nreki-literal-");
        write(root, "src/components/Header.tsx", "export function Header() { return ['Inicio', 'Limpieza']; }\n");
        write(root, "src/pages/Contact.tsx", "export const options = ['Seguridad', 'LIMPIEZA'];\n");
        write(root, "src/data/services.ts", "export const slug = 'limpieza';\n");
        const text = textOf(await handleContext({ action: "context", query: "cambiar Limpieza en toda la página" }, depsOf(open(root))));
        expect(text).toContain('"Limpieza" (any case): 3 line(s) in 3 file(s)');
        for (const f of ["src/components/Header.tsx:L1", "src/pages/Contact.tsx:L1", "src/data/services.ts:L1"]) expect(text).toContain(f);
    });
});

// ─── 6 ──────────────────────────────────────────────────────────────

describe("6. NREKI's own files stay out of the project's way", () => {
    it("abandoned temporaries go; fresh ones and other files stay", () => {
        const root = mkTmp("nreki-tmp-");
        const old = write(root, ".nreki.db.674511ac.tmp", "x");
        const fresh = write(root, ".nreki.db.0badc0de.tmp", "x");
        const other = write(root, "notes.tmp", "x");
        const stateTmp = write(root, ".nreki/repo-map.json.deadbeef.tmp", "x");
        const hourAgo = new Date(Date.now() - 3_600_000);
        for (const f of [old, other, stateTmp]) fs.utimesSync(f, hourAgo, hourAgo);
        expect(removeStaleTemps(root)).toBe(2);
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.existsSync(stateTmp)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
    });

    it("a failed save of .nreki.db leaves no temporary behind", async () => {
        const root = mkTmp("nreki-save-");
        const dbPath = path.join(root, "index-dir");
        fs.mkdirSync(dbPath); // a folder where the DB file goes: the rename over it fails
        const db = new NrekiDB(dbPath, root);
        await db.initialize();
        expect(() => db.save()).toThrow();
        expect(fs.readdirSync(root).filter(n => n.endsWith(".tmp"))).toEqual([]);
        fs.rmSync(dbPath, { recursive: true, force: true });
        db.close(); // the folder is gone: this save succeeds
    });

    it("lists .nreki.db and .nreki/ in this clone's .git/info/exclude, once, keeping what was there", () => {
        const root = mkTmp("nreki-excl-");
        write(root, ".git/info/exclude", "# local excludes\n*.log\n");
        fs.mkdirSync(path.join(root, ".nreki"));
        expect(ensureGitExcludes(root)).toBe("added");
        const text = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
        expect(text).toContain("*.log\n");
        expect(text).toContain("/.nreki.db\n");
        expect(text).toContain("/.nreki/\n");
        expect(ensureGitExcludes(root)).toBe("present");
        expect(fs.readFileSync(path.join(root, ".nreki", ".gitignore"), "utf8")).toContain("*");
    });

    it("leaves a worktree's .git file alone", () => {
        const root = mkTmp("nreki-wt-");
        write(root, ".git", "gitdir: ../elsewhere/.git/worktrees/x\n");
        expect(ensureGitExcludes(root)).toBe("no-git");
        expect(fs.readFileSync(path.join(root, ".git"), "utf8")).toBe("gitdir: ../elsewhere/.git/worktrees/x\n");
    });

    it("finds the NREKI state git tracks by reading the index (git itself is never run)", (ctx) => {
        const root = mkTmp("nreki-tracked-");
        const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
        if (git("init", "-q").status !== 0) ctx.skip("git is not installed");
        write(root, ".nreki.db", "x");
        write(root, ".nreki/repo-map.json", "{}");
        write(root, "app.ts", "export {};\n");
        expect(git("add", "-f", ".nreki.db", ".nreki/repo-map.json", "app.ts").status).toBe(0);
        expect(trackedNrekiState(root).sort()).toEqual([".nreki.db", ".nreki/repo-map.json"]);
        expect(trackedNrekiState(mkTmp("nreki-untracked-"))).toEqual([]);
    });
});

// ─── 7 ──────────────────────────────────────────────────────────────

/** A project where a NREKI server is "alive" (session marker of this test process) with one big code file. */
function liveProject(prefix: string): { root: string; big: string } {
    const root = mkTmp(prefix);
    write(root, `.nreki/sessions/${process.pid}`, "");
    const body = Array.from({ length: 900 }, (_, i) =>
        `export function handler${i}(input: number): number { return input * ${i} + ${i}; } // line ${i} with enough text to weigh`).join("\n");
    const big = write(root, "src/big.ts", body + "\n");
    return { root, big };
}

function runHook(hookFile: string, root: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
    const res = spawnSync(process.execPath, [hookFile], {
        input: JSON.stringify(payload),
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "", NREKI_READ_MAX_TOKENS: "", ...env },
        encoding: "utf8",
    });
    return { status: res.status, stderr: res.stderr };
}

describe("7a. hook v6: a whole-file dump through the shell gets the Read budget", () => {
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    const ps = (command: string) => ({ tool_name: "PowerShell", tool_input: { command } });

    it("blocks `cat` of a big code file once, with the symbol list; the same command again passes", () => {
        const { root } = liveProject("nreki-shell-");
        const first = runHook(HOOK_TEMPLATE, root, { ...bash("cat src/big.ts"), cwd: root });
        expect(first.status).toBe(2);
        expect(first.stderr).toContain("blocked to save context");
        expect(first.stderr).toContain("handler0");
        expect(runHook(HOOK_TEMPLATE, root, { ...bash("cat src/big.ts"), cwd: root }).status).toBe(0);
    });

    it("measures the printed range and leaves every other command alone", () => {
        const { root } = liveProject("nreki-shell-range-");
        const pass = [
            bash("head -n 40 src/big.ts"), bash("sed -n '1,60p' src/big.ts"), bash("cat src/big.ts | grep handler1"),
            bash("cat src/big.ts > copy.ts"), bash("grep -n handler src/big.ts"), bash("git status"), bash("cat README.md"),
            ps("Get-Content src/big.ts | Select-Object -First 50"), ps("Get-Content src/big.ts -Tail 20"), ps("npm test"),
        ];
        for (const p of pass) expect(runHook(HOOK_TEMPLATE, root, { ...p, cwd: root }).status, JSON.stringify(p)).toBe(0);
        expect(runHook(HOOK_TEMPLATE, root, { ...bash("sed -n '1,2000p' src/big.ts"), cwd: root }).status).toBe(2);
        // One block per file: a fresh project for the PowerShell spelling.
        const other = liveProject("nreki-shell-ps-").root;
        const pw = runHook(HOOK_TEMPLATE, other, { ...ps("Get-Content -Path 'src/big.ts' -Encoding utf8"), cwd: other });
        expect(pw.status).toBe(2);
        expect(pw.stderr).toContain("Select-Object");
    });

    it("does nothing when no NREKI server runs for the project", () => {
        const { root } = liveProject("nreki-shell-off-");
        fs.rmSync(path.join(root, ".nreki", "sessions"), { recursive: true, force: true });
        expect(runHook(HOOK_TEMPLATE, root, { ...bash("cat src/big.ts"), cwd: root }).status).toBe(0);
    });
});

describe("7b. hook v6: the project's copy steps aside for the user-level copy", () => {
    function setup(userHookText: string | null, matchers: string[]) {
        const { root } = liveProject("nreki-dedupe-");
        const projectHook = write(root, ".claude/hooks/nreki-enforcer.mjs", fs.readFileSync(HOOK_TEMPLATE, "utf8"));
        const config = mkTmp("nreki-config-");
        const userHook = path.join(config, "hooks", "nreki-enforcer.mjs");
        if (userHookText !== null) write(config, "hooks/nreki-enforcer.mjs", userHookText);
        write(config, "settings.json", JSON.stringify({
            hooks: { PreToolUse: matchers.map(m => ({ matcher: m, hooks: [{ type: "command", command: `node "${userHook.replace(/\\/g, "/")}"` }] })) },
        }));
        return { root, projectHook, env: { CLAUDE_CONFIG_DIR: config } };
    }
    const bigRead = (root: string) => ({ tool_name: "Read", tool_input: { file_path: path.join(root, "src", "big.ts") } });

    it("defers when the user-level hook is registered for the tool and is as new", () => {
        const { root, projectHook, env } = setup(fs.readFileSync(HOOK_TEMPLATE, "utf8"), ["Read"]);
        expect(runHook(projectHook, root, bigRead(root), env).status).toBe(0);
        // The user-level copy itself still decides.
        expect(runHook(HOOK_TEMPLATE, root, bigRead(root), env).status).toBe(2);
    });

    it("keeps working when the user-level copy is absent, pre-v4, or not registered for that tool", () => {
        // A v4/v5 user copy cannot step aside, so the project's v6 yields to it (audit of 12.5.2, F2).
        const legacy = setup("// nreki-enforcer:v5 — older build\n", ["Read"]);
        expect(runHook(legacy.projectHook, legacy.root, bigRead(legacy.root), legacy.env).status).toBe(0);
        const ancient = setup("// nreki-enforcer:v3 — older build\n", ["Read"]);
        expect(runHook(ancient.projectHook, ancient.root, bigRead(ancient.root), ancient.env).status).toBe(2);
        const absent = setup(null, ["Read"]);
        expect(runHook(absent.projectHook, absent.root, bigRead(absent.root), absent.env).status).toBe(2);
        const other = setup(fs.readFileSync(HOOK_TEMPLATE, "utf8"), ["Edit"]);
        expect(runHook(other.projectHook, other.root, bigRead(other.root), other.env).status).toBe(2);
    });
});

describe("7c. installs", () => {
    it("the server upgrades a v5 project hook to v6 and never downgrades a newer one", () => {
        const root = mkTmp("nreki-upgrade-");
        const hook = write(root, ".claude/hooks/nreki-enforcer.mjs", "#!/usr/bin/env node\n// nreki-enforcer:v5 — older build\n");
        const template = fs.readFileSync(HOOK_TEMPLATE, "utf8");
        expect(upgradeEnforcerHook(root, () => template)).toBe("upgraded");
        expect(fs.readFileSync(hook, "utf8")).toContain("nreki-enforcer:v6");
        fs.writeFileSync(hook, "// nreki-enforcer:v7 — from a newer init\n");
        expect(upgradeEnforcerHook(root, () => template)).toBe("current");
        expect(fs.readFileSync(hook, "utf8")).toContain("v7");
    });

    it("the user-scope install takes over this folder's Claude install, keeping the user's own hooks and text", () => {
        const project = mkTmp("nreki-migrate-");
        const home = mkTmp("nreki-home-");
        write(project, "package.json", "{}");
        runInit({ cwd: project, home, agent: "claude", mcp: false });
        // The user's own text and hook next to NREKI's.
        const claudeMd = path.join(project, "CLAUDE.md");
        fs.writeFileSync(claudeMd, `# My project\nUse pnpm.\n\n${fs.readFileSync(claudeMd, "utf8")}`);
        const settingsPath = path.join(project, ".claude", "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "node my-own-guard.mjs" }] });
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        // CLAUDE_CONFIG_DIR elsewhere keeps the project install on purpose (audit F3): not this test.
        const saved = process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CLAUDE_CONFIG_DIR;
        let result: ReturnType<typeof runInit>;
        try { result = runInit({ cwd: project, home, global: true, agent: "claude", mcp: true }); } finally {
            if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
        }
        expect(result.actions.some(a => a.op === "removed" && a.path.replace(/\\/g, "/") === ".claude/settings.json")).toBe(true);

        const after = fs.readFileSync(settingsPath, "utf8");
        expect(after).not.toContain("nreki-enforcer.mjs");
        expect(after).toContain("my-own-guard.mjs");
        expect(fs.existsSync(path.join(project, ".claude", "hooks", "nreki-enforcer.mjs"))).toBe(false);
        expect(fs.existsSync(path.join(project, ".claude", "skills", "nreki-optimizer", "SKILL.md"))).toBe(false);
        const md = fs.readFileSync(claudeMd, "utf8");
        expect(md).toContain("Use pnpm.");
        expect(md).not.toContain("# NREKI ACTIVE");

        const userSettings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
        const covered = (tool: string) => userSettings.hooks.PreToolUse.some((e: { matcher: string; hooks: Array<{ command: string }> }) =>
            e.matcher === tool && e.hooks.some(h => h.command.includes("nreki-enforcer.mjs")));
        for (const tool of CLAUDE_HOOK_TOOLS) expect(covered(tool), tool).toBe(true);
        expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("# NREKI ACTIVE");
    });

    it("init brings NREKI's own block up to date without --force, and leaves the user's text alone", () => {
        const project = mkTmp("nreki-refresh-");
        const home = mkTmp("nreki-refresh-home-");
        write(project, "package.json", "{}");
        write(project, "CLAUDE.md", "# Mine\nKeep this.\n\n<!-- nreki:begin -->\n# NREKI ACTIVE\nold instructions\n<!-- nreki:end -->\n\nAlso this.\n");
        const result = runInit({ cwd: project, home, agent: "claude", mcp: false });
        expect(result.actions.find(a => a.path === "CLAUDE.md")?.op).toBe("rewritten");
        const md = fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8");
        expect(md).not.toContain("old instructions");
        expect(md).toContain("ToolSearch");
        expect(md).toContain("Keep this.");
        expect(md).toContain("Also this.");
        expect(runInit({ cwd: project, home, agent: "claude", mcp: false }).actions.find(a => a.path === "CLAUDE.md")?.op).toBe("skipped");
    });
});

// ─── 8 ──────────────────────────────────────────────────────────────

describe("8. refusals say why", () => {
    it("agent and editor config that runs code is refused with the reason; secrets keep the plain refusal", () => {
        const root = mkTmp("nreki-sensitive-");
        expect(() => safePath(root, ".claude/hooks/nreki-enforcer.mjs")).toThrow(/runs code/);
        expect(() => safePath(root, ".mcp.json")).toThrow(/runs code/);
        let message = "";
        try { safePath(root, ".env"); } catch (err) { message = (err as Error).message; }
        expect(message).toContain("Access to sensitive file blocked");
        expect(message).not.toContain("runs code");
    });
});
