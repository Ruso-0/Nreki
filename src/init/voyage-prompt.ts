/**
 * init/voyage-prompt.ts — the box `nreki init` shows to ask for the Voyage
 * API key and whether this project uses Voyage.
 *
 * Windows: a small window with a masked field (templates/voyage-key-dialog.ps1).
 * Elsewhere, or when the window cannot open: a hidden prompt in the terminal.
 * A typed key is checked against Voyage before it is saved (~/.nreki/voyage.key,
 * see utils/voyage-key.ts); a rejected key asks again. The CLI shows the box
 * only in an interactive terminal: an agent running `nreki init` never gets a
 * window it cannot answer.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
    availableVoyageKey,
    checkVoyageKey,
    saveVoyageKey,
    type VoyageKeyCheck,
} from "../utils/voyage-key.js";

export type VoyageChoice =
    | { kind: "key"; key: string }   // a key was typed
    | { kind: "use-saved" }          // accepted with the field empty: use the key already available
    | { kind: "local" }              // "No Voyage": local search only
    | { kind: "skip" };              // closed, or no way to ask: change nothing

export interface DialogTexts {
    title: string;
    message: string;
    primary: string;
    secondary: string;
    emptyField: string;
    terminalPrompt: string;
    hasSavedKey: boolean;
    error?: string;
}

const PRIVACY = {
    es: "El código del proyecto se envía una vez a Voyage AI para indexarlo; las búsquedas solo envían la consulta. Las rutas sensibles (.env, claves) se excluyen.",
    en: "The project's code is sent once to Voyage AI to be indexed; searches send only the query. Sensitive paths (.env, keys) are excluded.",
};

export function isSpanish(locale: string = defaultLocale()): boolean {
    return /^es\b/i.test(locale);
}

/**
 * True when `nreki init` is run by a human in a terminal (including Git Bash
 * / mintty on Windows where `stdin.isTTY` is false), and NEVER when run by CI,
 * Vitest, or an AI coding agent subprocess.
 */
export function isHumanInteractiveSession(
    env: NodeJS.ProcessEnv = process.env,
    stdinIsTty: boolean = Boolean(process.stdin.isTTY),
    stderrIsTty: boolean = Boolean(process.stderr.isTTY),
    explicitPrompt?: boolean,
): boolean {
    if (explicitPrompt === false) return false;
    if (explicitPrompt === true) return true;
    if (
        env.CI ||
        env.VITEST ||
        env.NODE_ENV === "test" ||
        env.CLAUDECODE ||
        env.CLAUDE_CODE_ENTRYPOINT ||
        env.CODEX_SANDBOX ||
        env.ANTIGRAVITY_CLI_ALIAS ||
        env.ANTIGRAVITY_AGENT
    ) {
        return false;
    }
    if (stdinIsTty && stderrIsTty) return true;
    // Git Bash (mintty) on Windows uses pipes so isTTY is false even for humans.
    if (Boolean(env.MSYSTEM) && Boolean(env.TERM) && env.TERM !== "dumb") return true;
    return false;
}

function defaultLocale(): string {
    return process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "en";
}

export function dialogTexts(hasSavedKey: boolean, error?: string, locale?: string): DialogTexts {
    if (isSpanish(locale)) {
        return {
            title: "NREKI - búsqueda semántica con Voyage",
            message: (hasSavedKey
                ? "Ya tienes una API key de Voyage. Deja el campo vacío para usarla en este proyecto, o pega otra para cambiarla."
                : "Pega tu API key de Voyage (dashboard.voyageai.com > API Keys) para activar la búsqueda por conceptos en este proyecto.")
                + "\n\n" + PRIVACY.es,
            primary: "Activar Voyage",
            secondary: "Sin Voyage",
            emptyField: "Pega la API key, o pulsa \"Sin Voyage\".",
            terminalPrompt: hasSavedKey
                ? "API key de Voyage (Enter = usar la que tienes, n = sin Voyage): "
                : "API key de Voyage (Enter = omitir, n = sin Voyage): ",
            hasSavedKey,
            error,
        };
    }
    return {
        title: "NREKI - semantic search with Voyage",
        message: (hasSavedKey
            ? "A Voyage API key is already set. Leave the field empty to use it in this project, or paste another to replace it."
            : "Paste your Voyage API key (dashboard.voyageai.com > API Keys) to turn on concept search in this project.")
            + "\n\n" + PRIVACY.en,
        primary: "Turn on Voyage",
        secondary: "No Voyage",
        emptyField: "Paste the API key, or press \"No Voyage\".",
        terminalPrompt: hasSavedKey
            ? "Voyage API key (Enter = use the one you have, n = no Voyage): "
            : "Voyage API key (Enter = skip, n = no Voyage): ",
        hasSavedKey,
        error,
    };
}

/** dist/init → ../../templates (the script ships in the package). */
function dialogScriptPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "..", "templates", "voyage-key-dialog.ps1");
}

/** The Windows window. Null when it cannot open (no desktop, PowerShell blocked…). */
export function askViaWindowsDialog(t: DialogTexts): VoyageChoice | null {
    const script = dialogScriptPath();
    if (!fs.existsSync(script)) return null;
    const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script],
        {
            env: { ...process.env, NREKI_DIALOG: JSON.stringify(t) },
            encoding: "utf8",
            // No windowsHide: Windows applies a launcher's SW_HIDE to the FIRST
            // window the child shows, which here is the box itself (measured: the
            // box opened invisible). Run from a terminal, PowerShell shares the
            // terminal's console, so no extra window appears.
            timeout: 30 * 60_000,
        },
    );
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout ?? "").split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    if (!line) return null;
    try {
        const out = JSON.parse(line) as { action?: string; key?: string };
        if (out.action === "key" && typeof out.key === "string" && out.key.trim()) return { kind: "key", key: out.key.trim() };
        if (out.action === "use-saved") return { kind: "use-saved" };
        if (out.action === "local") return { kind: "local" };
        return { kind: "skip" };
    } catch {
        return null;
    }
}

/** Hidden prompt in the terminal (what is typed is not echoed). */
export async function askViaTerminal(
    t: DialogTexts,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stderr,
): Promise<VoyageChoice> {
    output.write(`\n${t.title}\n${t.message}\n`);
    if (t.error) output.write(`${t.error}\n`);
    const rl = readline.createInterface({ input, output, terminal: true });
    const internals = rl as unknown as { _writeToOutput: (s: string) => void };
    const write = internals._writeToOutput.bind(rl);
    let muted = false;
    internals._writeToOutput = (s: string) => {
        if (!muted) write(s);
        else if (s.includes("\n")) write("\n");
    };
    const answer = await new Promise<string>((resolve) => {
        rl.question(t.terminalPrompt, resolve);
        muted = true;
    });
    rl.close();
    const value = answer.trim();
    if (!value) return t.hasSavedKey ? { kind: "use-saved" } : { kind: "skip" };
    if (/^(n|no|-)$/i.test(value)) return { kind: "local" };
    return { kind: "key", key: value };
}

/** Keep the Windows user variable NREKI_VOYAGE_API_KEY in step with a newly saved key. */
export function syncWindowsUserVariable(key: string): "updated" | "absent" | "failed" {
    if (process.platform !== "win32") return "absent";
    const r = spawnSync(
        "powershell.exe",
        [
            "-NoProfile", "-NonInteractive", "-Command",
            "if ([Environment]::GetEnvironmentVariable('NREKI_VOYAGE_API_KEY','User')) " +
            "{ [Environment]::SetEnvironmentVariable('NREKI_VOYAGE_API_KEY', $env:NREKI_NEW_VOYAGE_KEY, 'User'); 'updated' } else { 'absent' }",
        ],
        { env: { ...process.env, NREKI_NEW_VOYAGE_KEY: key }, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    if (r.error || r.status !== 0) return "failed";
    return /updated/.test(r.stdout ?? "") ? "updated" : "absent";
}

export interface VoyagePromptDeps {
    ui?: (t: DialogTexts) => Promise<VoyageChoice>;
    check?: (key: string) => Promise<VoyageKeyCheck>;
    save?: (key: string) => string;
    syncEnv?: (key: string) => "updated" | "absent" | "failed";
    env?: NodeJS.ProcessEnv;
    locale?: string;
}

export interface VoyagePromptResult {
    /** What to put in the registrations: true = NREKI_SEMANTIC=voyage, false = remove it, undefined = no change. */
    voyage: boolean | undefined;
    /** Lines for the CLI to print. */
    lines: string[];
}

/**
 * Ask for the key (up to three tries when Voyage rejects it), save it, and
 * say whether this project's registrations should turn Voyage on.
 *
 * Default UI priority:
 *   1. Local browser Setup Box (`127.0.0.1` card — cross-platform Win/Mac/Linux,
 *      verifies the key inline before closing)
 *   2. Windows native WinForms dialog (`templates/voyage-key-dialog.ps1`)
 *   3. Hidden terminal prompt (`readline`)
 */
export async function promptForVoyage(deps: VoyagePromptDeps = {}): Promise<VoyagePromptResult> {
    const env = deps.env ?? process.env;
    const check = deps.check ?? ((key: string) => checkVoyageKey(key));
    const save = deps.save ?? saveVoyageKey;
    const syncEnv = deps.syncEnv ?? syncWindowsUserVariable;
    const es = isSpanish(deps.locale);
    const lines: string[] = [];

    const verifiedCache = new Map<string, VoyageKeyCheck>();
    const defaultUi = async (t: DialogTexts): Promise<VoyageChoice> => {
        try {
            const { askViaBrowserSetupUi } = await import("./setup-ui.js");
            const browserOutcome = await askViaBrowserSetupUi({
                texts: t,
                locale: deps.locale,
                check,
            });
            if (browserOutcome) {
                if (browserOutcome.choice.kind === "key" && browserOutcome.verified) {
                    verifiedCache.set(browserOutcome.choice.key, browserOutcome.verified);
                }
                return browserOutcome.choice;
            }
        } catch {
            // Fall through to native Windows dialog / terminal prompt
        }
        if (process.platform === "win32") {
            const choice = askViaWindowsDialog(t);
            if (choice) return choice;
        }
        return askViaTerminal(t);
    };
    const ui = deps.ui ?? defaultUi;

    let error: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        const available = availableVoyageKey(env);
        const choice = await ui(dialogTexts(available !== null, error, deps.locale));
        if (choice.kind === "skip") return { voyage: undefined, lines };
        if (choice.kind === "local") {
            lines.push("Voyage: off (local search only).");
            return { voyage: false, lines };
        }
        if (choice.kind === "use-saved") {
            if (!available) return { voyage: undefined, lines };
            lines.push(`Voyage: on, with the key from ${available.source === "env" ? "your environment" : "~/.nreki/voyage.key"}.`);
            return { voyage: true, lines };
        }

        const result = verifiedCache.get(choice.key) ?? await check(choice.key);
        if (result.status === "invalid") {
            error = es
                ? `Voyage rechazó esa clave (HTTP ${result.httpStatus}). Crea una nueva y cópiala completa.`
                : `Voyage rejected that key (HTTP ${result.httpStatus}). Create a new one and copy it whole.`;
            continue;
        }
        const file = save(choice.key);
        lines.push(result.status === "valid"
            ? `Voyage: key verified and saved to ${file}; semantic search enabled.`
            : `Voyage: could not reach Voyage to check the key (${result.reason}); saved to ${file} anyway; semantic search enabled.`);
        const synced = syncEnv(choice.key);
        if (synced === "updated") {
            lines.push("Voyage: your Windows variable NREKI_VOYAGE_API_KEY was updated too. Restart your agents (Codex, Antigravity…) so they pick it up.");
        } else if ((env.NREKI_VOYAGE_API_KEY || env.VOYAGE_API_KEY || "").trim() && (env.NREKI_VOYAGE_API_KEY || env.VOYAGE_API_KEY || "").trim() !== choice.key) {
            lines.push("Voyage: an environment variable (NREKI_VOYAGE_API_KEY or VOYAGE_API_KEY) holds a different key and takes precedence: update or remove it.");
        }
        return { voyage: true, lines };
    }
    lines.push("Voyage: the key was rejected three times; nothing was saved. Run `npx nreki init` again with a new key.");
    return { voyage: undefined, lines };
}
