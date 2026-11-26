/**
 * voyage-key-prompt.test.ts — v12.4.0: `nreki init` asks for the Voyage key in
 * a box, checks it against Voyage, saves it in ~/.nreki/voyage.key (outside
 * every project) and turns Voyage on for the project. NREKI reads that file
 * when no environment variable holds a key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import {
    availableVoyageKey,
    checkVoyageKey,
    readSavedVoyageKey,
    saveVoyageKey,
    voyageKeyFile,
} from "../src/utils/voyage-key.js";
import { resolveVoyageConfig } from "../src/search/voyage.js";
import { askViaTerminal, dialogTexts, promptForVoyage, type DialogTexts, type VoyageChoice } from "../src/init/voyage-prompt.js";
import { parseInitArgs } from "../src/init/init-runner.js";

const repoRoot = path.resolve(__dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const KEY = "pa-test_key_0123456789abcdefghij";
const KEY2 = "pa-other_key_9876543210zyxwvutsrq";

let trustDir: string;
let previousTrustDir: string | undefined;

beforeEach(() => {
    previousTrustDir = process.env.NREKI_TRUST_DIR;
    trustDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-voyage-key-"));
    process.env.NREKI_TRUST_DIR = trustDir;
});

afterEach(() => {
    process.env.NREKI_TRUST_DIR = previousTrustDir;
    fs.rmSync(trustDir, { recursive: true, force: true });
});

describe("saved Voyage key", () => {
    it("is saved outside the project, read back, and never shared through a project file", () => {
        expect(readSavedVoyageKey()).toBeNull();
        const file = saveVoyageKey(`  ${KEY}\n`);
        expect(file).toBe(path.join(trustDir, "voyage.key"));
        expect(readSavedVoyageKey()).toBe(KEY);
        if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(trustDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    it("refuses something that is not a key, and ignores a file that does not hold one", () => {
        expect(() => saveVoyageKey("two words")).toThrow(/does not look like/);
        fs.writeFileSync(voyageKeyFile(), "not a key at all\n");
        expect(readSavedVoyageKey()).toBeNull();
    });

    it("the environment wins over the saved key", () => {
        saveVoyageKey(KEY);
        expect(availableVoyageKey({})).toEqual({ key: KEY, source: "file" });
        expect(availableVoyageKey({ VOYAGE_API_KEY: KEY2 })).toEqual({ key: KEY2, source: "env" });
        expect(availableVoyageKey({ NREKI_VOYAGE_API_KEY: KEY2, VOYAGE_API_KEY: "x" })).toEqual({ key: KEY2, source: "env" });
    });

    it("a saved key does not turn Voyage on by itself: the project still opts in", () => {
        saveVoyageKey(KEY);
        expect(resolveVoyageConfig({})).toBeNull();
        expect(resolveVoyageConfig({ NREKI_SEMANTIC: "voyage" })).toEqual({ apiKey: KEY, model: "voyage-code-4" });
    });

    it("checkVoyageKey sends one tiny request and tells valid, invalid and unreachable apart", async () => {
        const seen: Array<{ url: string; auth: string; body: string }> = [];
        const fake = (status: number | "throw") => (async (url: string, init: RequestInit) => {
            seen.push({ url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) });
            if (status === "throw") throw new Error("getaddrinfo ENOTFOUND");
            return new Response("{}", { status });
        }) as unknown as typeof fetch;
        expect(await checkVoyageKey(KEY, "voyage-code-4", fake(200))).toEqual({ status: "valid" });
        expect(await checkVoyageKey(KEY, "voyage-code-4", fake(401))).toEqual({ status: "invalid", httpStatus: 401 });
        expect(await checkVoyageKey(KEY, "voyage-code-4", fake(503))).toEqual({ status: "unreachable", reason: "HTTP 503" });
        expect((await checkVoyageKey(KEY, "voyage-code-4", fake("throw"))).status).toBe("unreachable");
        expect(seen[0]).toMatchObject({ url: "https://api.voyageai.com/v1/embeddings", auth: `Bearer ${KEY}` });
        expect(JSON.parse(seen[0].body)).toEqual({ input: ["ping"], model: "voyage-code-4" });
    });
});

describe("the Voyage box", () => {
    const deps = (choices: VoyageChoice[], checks: Array<"valid" | 401 | "offline">, env: NodeJS.ProcessEnv = {}) => {
        const shown: DialogTexts[] = [];
        const saved: string[] = [];
        return {
            shown,
            saved,
            deps: {
                env,
                locale: "en-US",
                ui: async (t: DialogTexts) => { shown.push(t); return choices.shift() ?? { kind: "skip" as const }; },
                check: async () => {
                    const c = checks.shift();
                    return c === "valid" ? { status: "valid" as const }
                        : c === 401 ? { status: "invalid" as const, httpStatus: 401 }
                        : { status: "unreachable" as const, reason: "offline" };
                },
                save: (key: string) => { saved.push(key); return saveVoyageKey(key); },
                syncEnv: () => "absent" as const,
            },
        };
    };

    it("a verified key is saved and turns Voyage on", async () => {
        const d = deps([{ kind: "key", key: KEY }], ["valid"]);
        const r = await promptForVoyage(d.deps);
        expect(r.voyage).toBe(true);
        expect(d.saved).toEqual([KEY]);
        expect(readSavedVoyageKey()).toBe(KEY);
        expect(r.lines.join("\n")).toMatch(/verified and saved/);
    });

    it("a rejected key asks again with the reason, and three rejections save nothing", async () => {
        const d = deps([{ kind: "key", key: "pa-wrong_wrong_wrong" }, { kind: "key", key: KEY }], [401, "valid"]);
        expect((await promptForVoyage(d.deps)).voyage).toBe(true);
        expect(d.shown).toHaveLength(2);
        expect(d.shown[1].error).toMatch(/HTTP 401/);

        fs.rmSync(voyageKeyFile());
        const bad = { kind: "key" as const, key: "pa-wrong_wrong_wrong" };
        const d3 = deps([bad, bad, bad], [401, 401, 401]);
        const r = await promptForVoyage(d3.deps);
        expect(r.voyage).toBeUndefined();
        expect(d3.saved).toEqual([]);
        expect(readSavedVoyageKey()).toBeNull();
    });

    it("an unreachable Voyage still saves the key, and says so", async () => {
        const d = deps([{ kind: "key", key: KEY }], ["offline"]);
        const r = await promptForVoyage(d.deps);
        expect(r.voyage).toBe(true);
        expect(r.lines.join("\n")).toMatch(/could not reach Voyage/);
    });

    it("\"No Voyage\" turns it off; closing the box changes nothing", async () => {
        expect((await promptForVoyage(deps([{ kind: "local" }], []).deps)).voyage).toBe(false);
        expect((await promptForVoyage(deps([{ kind: "skip" }], []).deps)).voyage).toBeUndefined();
    });

    it("with a key already set, an empty field uses it; the box says a key is there", async () => {
        const d = deps([{ kind: "use-saved" }], [], { NREKI_VOYAGE_API_KEY: KEY });
        const r = await promptForVoyage(d.deps);
        expect(r.voyage).toBe(true);
        expect(d.shown[0].hasSavedKey).toBe(true);
        expect(r.lines.join("\n")).toMatch(/your environment/);
        expect((await promptForVoyage(deps([{ kind: "use-saved" }], []).deps)).voyage).toBeUndefined();
    });

    it("warns when an environment variable would shadow the newly saved key", async () => {
        const d = deps([{ kind: "key", key: KEY }], ["valid"], { NREKI_VOYAGE_API_KEY: KEY2 });
        const r = await promptForVoyage(d.deps);
        expect(r.lines.join("\n")).toMatch(/holds a different key and takes precedence/);
    });

    it("speaks Spanish on a Spanish system", () => {
        const t = dialogTexts(false, undefined, "es-ES");
        expect(t.primary).toBe("Activar Voyage");
        expect(t.message).toMatch(/Pega tu API key de Voyage/);
        expect(dialogTexts(false, undefined, "en-US").primary).toBe("Turn on Voyage");
    });

    it("the terminal prompt hides what is typed", async () => {
        const run = async (typed: string, hasSavedKey: boolean): Promise<{ choice: VoyageChoice; shown: string }> => {
            const input = new PassThrough();
            const output = new PassThrough();
            let shown = "";
            output.on("data", (b) => { shown += String(b); });
            const pending = askViaTerminal(dialogTexts(hasSavedKey, undefined, "en-US"), input, output);
            input.write(`${typed}\n`);
            return { choice: await pending, shown };
        };
        const typed = await run(KEY, false);
        expect(typed.choice).toEqual({ kind: "key", key: KEY });
        expect(typed.shown).not.toContain(KEY);
        expect((await run("", true)).choice).toEqual({ kind: "use-saved" });
        expect((await run("", false)).choice).toEqual({ kind: "skip" });
        expect((await run("n", false)).choice).toEqual({ kind: "local" });
    });

    it("init run without a terminal (as an agent runs it) never shows the box", () => {
        const project = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-noprompt-"));
        try {
            const r = spawnSync(process.execPath, [tsxCli, path.join(repoRoot, "src", "index.ts"), "init", "--agent", "codex"], {
                cwd: project, env: { ...process.env, NREKI_VOYAGE_API_KEY: "", VOYAGE_API_KEY: "" },
                encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"],
            });
            expect(r.status, r.stderr).toBe(0);
            expect(r.stderr).not.toMatch(/Voyage:/);
            expect(fs.existsSync(path.join(project, ".codex", "config.toml"))).toBe(true);
            expect(readSavedVoyageKey()).toBeNull();
        } finally {
            fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }, 60_000);

    it("parses --no-prompt", () => {
        expect(parseInitArgs(["--no-prompt"]).opts.prompt).toBe(false);
    });
});
