/**
 * init/setup-ui.ts — Zero-dependency local browser Setup Box (`127.0.0.1`)
 * opened by `npx nreki init` / `npx nreki key` so each user gets a clean visual
 * card on Windows, macOS, and Linux to paste and verify their Voyage API key
 * and confirm their AI coding agents.
 *
 * Resilience & security:
 *   - Bound strictly to `127.0.0.1` on an ephemeral OS port with a random
 *     128-bit session token (`x-nreki-token`) and no external network assets.
 *   - The page immediately pings `/api/opened` on load. If the browser fails to
 *     open within `openTimeoutMs` (headless SSH, sandbox, broken file handler),
 *     the server closes cleanly and returns `null` so `voyage-prompt.ts` falls
 *     back to the native Windows dialog or hidden terminal prompt.
 *   - Voyage key validation runs inline via `/api/submit` before closing, so a
 *     typo or expired key shows an inline error inside the card without closing.
 */

import { spawn } from "child_process";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import { checkVoyageKey, type VoyageKeyCheck } from "../utils/voyage-key.js";
import { isSpanish, type DialogTexts, type VoyageChoice } from "./voyage-prompt.js";

export interface SetupUiOptions {
    texts: DialogTexts;
    locale?: string;
    check?: (key: string) => Promise<VoyageKeyCheck>;
    openBrowser?: (url: string) => boolean;
    /** Max wait for the browser tab to load `/api/opened` before falling back. */
    openTimeoutMs?: number;
    /** Max total idle time once the browser tab is open. */
    sessionTimeoutMs?: number;
}

export interface SetupUiOutcome {
    choice: VoyageChoice;
    /** When `choice.kind === "key"`, the check already completed in `/api/submit`. */
    verified?: VoyageKeyCheck;
}

export function launchSystemBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
    try {
        const child = platform === "win32"
            ? spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true })
            : platform === "darwin"
                ? spawn("open", [url], { stdio: "ignore", detached: true })
                : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
        child.on("error", () => { /* handled via /api/opened timeout */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderSetupHtml(texts: DialogTexts, token: string, es: boolean): string {
    const ui = es
        ? {
            badge: "Instalación global sin aprobaciones manuales",
            subtitle: "Quedará activo automáticamente en Claude Code, Antigravity, Cursor y Codex.",
            keyLabel: "Voyage API Key (opcional — búsqueda semántica por conceptos)",
            placeholder: texts.hasSavedKey
                ? "Deja vacío para usar tu clave actual, o pega una nueva (pa-...)"
                : "Pega tu clave aquí (ej. pa-...)",
            getKey: "Obtener API Key gratis en Voyage AI ↗",
            savedBadge: "✓ Ya tienes una API key guardada en ~/.nreki/voyage.key",
            show: "Mostrar",
            hide: "Ocultar",
            checking: "Verificando clave con Voyage AI...",
            doneTitle: "¡NREKI quedó configurado!",
            doneBody: "Ya puedes cerrar esta pestaña y volver a tu terminal o editor.",
            agentsNote: "Se registran las 3 herramientas (nreki_navigate, nreki_code, nreki_guard) a nivel usuario.",
        }
        : {
            badge: "Zero-approval global MCP setup",
            subtitle: "Automatically active across Claude Code, Antigravity, Cursor, and Codex.",
            keyLabel: "Voyage API Key (optional — concept semantic search)",
            placeholder: texts.hasSavedKey
                ? "Leave empty to keep your saved key, or paste a new one (pa-...)"
                : "Paste your key here (e.g. pa-...)",
            getKey: "Get a Voyage AI API key ↗",
            savedBadge: "✓ Existing API key detected in ~/.nreki/voyage.key",
            show: "Show",
            hide: "Hide",
            checking: "Verifying key with Voyage AI...",
            doneTitle: "NREKI is ready!",
            doneBody: "You can close this tab and return to your terminal or IDE.",
            agentsNote: "Registers all 3 tools (nreki_navigate, nreki_code, nreki_guard) at user scope.",
        };

    const cfgJson = JSON.stringify({
        token,
        hasSavedKey: texts.hasSavedKey,
        emptyField: texts.emptyField,
        initialError: texts.error ?? "",
        showText: ui.show,
        hideText: ui.hide,
        checkingText: ui.checking,
        doneTitle: ui.doneTitle,
        doneBody: ui.doneBody,
    }).replace(/</g, "\\u003c");

    return `<!doctype html>
<html lang="${es ? "es" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(texts.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: radial-gradient(circle at top, #172554 0%, #090d16 62%);
    color: #e2e8f0;
  }
  .card {
    width: 100%; max-width: 540px; background: rgba(15, 23, 42, 0.94);
    border: 1px solid rgba(56, 189, 248, 0.28); border-radius: 18px;
    padding: 28px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  }
  .header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .logo {
    width: 46px; height: 46px; flex: 0 0 46px; border-radius: 12px;
    background: rgba(56, 189, 248, 0.12); display: grid; place-items: center;
    border: 1px solid rgba(56, 189, 248, 0.35);
  }
  .badge {
    display: inline-block; font-size: 12px; font-weight: 600; color: #38bdf8;
    background: rgba(56, 189, 248, 0.12); padding: 4px 10px; border-radius: 999px;
    margin-bottom: 6px;
  }
  h1 { margin: 0; font-size: 20px; font-weight: 700; color: #f8fafc; }
  .sub { margin: 4px 0 18px; font-size: 13.5px; color: #94a3b8; line-height: 1.45; }
  .agents {
    display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px;
  }
  .chip {
    font-size: 12px; font-weight: 600; padding: 5px 11px; border-radius: 999px;
    background: rgba(34, 197, 94, 0.12); color: #86efac;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }
  label { display: block; font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 8px; }
  .saved {
    font-size: 12.5px; color: #86efac; background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.25); padding: 8px 12px; border-radius: 10px;
    margin-bottom: 10px;
  }
  .input-row { display: flex; gap: 8px; }
  input[type="password"], input[type="text"] {
    flex: 1; padding: 11px 13px; border-radius: 10px; font-size: 14px;
    background: #090d16; color: #f8fafc; border: 1px solid #334155; outline: none;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  input:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18); }
  .toggle {
    padding: 0 13px; border-radius: 10px; border: 1px solid #334155;
    background: #1e293b; color: #cbd5e1; font-size: 12.5px; cursor: pointer;
  }
  .toggle:hover { background: #334155; }
  .links {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 8px; font-size: 12.5px;
  }
  .links a { color: #38bdf8; text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  .privacy { margin-top: 12px; font-size: 12px; color: #64748b; line-height: 1.45; }
  .status {
    min-height: 22px; margin-top: 12px; font-size: 13px; font-weight: 500; color: #f87171;
  }
  .status.info { color: #38bdf8; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button.primary, button.secondary {
    padding: 11px 18px; border-radius: 10px; font-size: 14px; font-weight: 600;
    cursor: pointer; border: none; transition: transform 0.05s ease, opacity 0.15s ease;
  }
  button:disabled { opacity: 0.55; cursor: wait; }
  button.primary { background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff; }
  button.primary:hover:not(:disabled) { opacity: 0.94; }
  button.secondary { background: transparent; color: #94a3b8; border: 1px solid #334155; }
  button.secondary:hover:not(:disabled) { background: #1e293b; color: #e2e8f0; }
  .done { text-align: center; padding: 18px 6px; display: none; }
  .done h2 { margin: 12px 0 8px; color: #86efac; font-size: 21px; }
  .done p { margin: 0; color: #cbd5e1; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div id="formView">
      <div class="badge">${escapeHtml(ui.badge)}</div>
      <div class="header">
        <div class="logo">
          <svg viewBox="0 0 128 128" width="28" height="28" fill="none">
            <path d="M64 16L22 34V62C22 88.5 39.9 109.8 64 116C88.1 109.8 106 88.5 106 62V34L64 16Z" stroke="#38BDF8" stroke-width="8" stroke-linejoin="round"/>
            <path d="M46 65L58 77L84 50" stroke="#22C55E" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div>
          <h1>${escapeHtml(texts.title)}</h1>
        </div>
      </div>
      <p class="sub">${escapeHtml(ui.subtitle)}<br>${escapeHtml(ui.agentsNote)}</p>
      <div class="agents">
        <span class="chip">✓ Claude Code</span>
        <span class="chip">✓ Antigravity</span>
        <span class="chip">✓ Cursor</span>
        <span class="chip">✓ Codex</span>
      </div>
      ${texts.hasSavedKey ? `<div class="saved">${escapeHtml(ui.savedBadge)}</div>` : ""}
      <label for="keyInput">${escapeHtml(ui.keyLabel)}</label>
      <div class="input-row">
        <input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(ui.placeholder)}" autofocus>
        <button id="toggleBtn" class="toggle" type="button">${escapeHtml(ui.show)}</button>
      </div>
      <div class="links">
        <a href="https://dashboard.voyageai.com/" target="_blank" rel="noopener noreferrer">${escapeHtml(ui.getKey)}</a>
      </div>
      <p class="privacy">${escapeHtml(texts.message)}</p>
      <div id="statusBox" class="status"></div>
      <div class="actions">
        <button id="localBtn" class="secondary" type="button">${escapeHtml(texts.secondary)}</button>
        <button id="saveBtn" class="primary" type="button">${escapeHtml(texts.primary)}</button>
      </div>
    </div>
    <div id="doneView" class="done">
      <div style="font-size:40px">✅</div>
      <h2 id="doneTitle"></h2>
      <p id="doneBody"></p>
    </div>
  </div>
<script>
  const CFG = ${cfgJson};
  const input = document.getElementById("keyInput");
  const toggleBtn = document.getElementById("toggleBtn");
  const saveBtn = document.getElementById("saveBtn");
  const localBtn = document.getElementById("localBtn");
  const statusBox = document.getElementById("statusBox");

  if (CFG.initialError) statusBox.textContent = CFG.initialError;

  fetch("/api/opened", {
    method: "POST",
    headers: { "x-nreki-token": CFG.token }
  }).catch(() => {});

  toggleBtn.addEventListener("click", () => {
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    toggleBtn.textContent = hidden ? CFG.hideText : CFG.showText;
    input.focus();
  });

  function setBusy(busy, infoText) {
    saveBtn.disabled = busy;
    localBtn.disabled = busy;
    input.disabled = busy;
    if (infoText !== undefined) {
      statusBox.className = busy ? "status info" : "status";
      statusBox.textContent = infoText;
    }
  }

  async function submitChoice(payload) {
    setBusy(true, payload.action === "key" ? CFG.checkingText : "");
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nreki-token": CFG.token },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) {
        setBusy(false, data.error || "Error");
        input.focus();
        return;
      }
      document.getElementById("formView").style.display = "none";
      document.getElementById("doneTitle").textContent = CFG.doneTitle;
      document.getElementById("doneBody").textContent = data.message || CFG.doneBody;
      document.getElementById("doneView").style.display = "block";
      setTimeout(() => { try { window.close(); } catch {} }, 1200);
    } catch (err) {
      setBusy(false, String(err));
    }
  }

  saveBtn.addEventListener("click", () => {
    const key = input.value.trim();
    if (key) {
      submitChoice({ action: "key", key });
    } else if (CFG.hasSavedKey) {
      submitChoice({ action: "use-saved" });
    } else {
      statusBox.className = "status";
      statusBox.textContent = CFG.emptyField;
      input.focus();
    }
  });

  localBtn.addEventListener("click", () => {
    submitChoice({ action: "local" });
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
  });
</script>
</body>
</html>`;
}

function readRequestBody(req: http.IncomingMessage, maxBytes = 8192): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
            body += chunk;
            if (body.length > maxBytes) {
                req.destroy();
                reject(new Error("payload too large"));
            }
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
    });
}

export interface SetupUiHttpReply {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface SetupUiController {
    token: string;
    opened: boolean;
    outcome: SetupUiOutcome | null;
    dispatch: (req: {
        method: string;
        pathname: string;
        queryToken?: string | null;
        headerToken?: string | null;
        rawBody?: string;
    }) => Promise<SetupUiHttpReply>;
}

/**
 * Pure HTTP state machine backing the `127.0.0.1` setup box, separated from the
 * TCP socket so unit tests can exercise every route even in no-network sandboxes.
 */
export function createSetupUiController(opts: {
    texts: DialogTexts;
    locale?: string;
    check?: (key: string) => Promise<VoyageKeyCheck>;
    token?: string;
    onOpened?: () => void;
    onFinish?: (outcome: SetupUiOutcome) => void;
}): SetupUiController {
    const es = isSpanish(opts.locale);
    const check = opts.check ?? ((k: string) => checkVoyageKey(k));
    const token = opts.token ?? crypto.randomBytes(16).toString("hex");
    const html = renderSetupHtml(opts.texts, token, es);

    const ctrl: SetupUiController = {
        token,
        opened: false,
        outcome: null,
        dispatch: async ({ method, pathname, queryToken, headerToken, rawBody }): Promise<SetupUiHttpReply> => {
            if (method === "GET" && pathname === "/") {
                if (queryToken !== token) {
                    return {
                        status: 403,
                        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
                        body: "Forbidden",
                    };
                }
                return {
                    status: 200,
                    headers: {
                        "Content-Type": "text/html; charset=utf-8",
                        "Cache-Control": "no-store",
                        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:;",
                    },
                    body: html,
                };
            }

            if (method === "POST" && headerToken === token) {
                if (pathname === "/api/opened") {
                    ctrl.opened = true;
                    opts.onOpened?.();
                    return {
                        status: 200,
                        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                        body: JSON.stringify({ ok: true }),
                    };
                }

                if (pathname === "/api/submit") {
                    ctrl.opened = true;
                    opts.onOpened?.();
                    const parsed = JSON.parse(rawBody ?? "{}") as { action?: string; key?: string };

                    if (parsed.action === "local") {
                        const outcome: SetupUiOutcome = { choice: { kind: "local" } };
                        ctrl.outcome = outcome;
                        opts.onFinish?.(outcome);
                        return {
                            status: 200,
                            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                            body: JSON.stringify({
                                ok: true,
                                message: es
                                    ? "Instalando NREKI con búsqueda local (sin Voyage). Ya puedes cerrar esta pestaña."
                                    : "Installing NREKI with local search only. You can close this tab.",
                            }),
                        };
                    }

                    if (parsed.action === "use-saved") {
                        const outcome: SetupUiOutcome = { choice: { kind: "use-saved" } };
                        ctrl.outcome = outcome;
                        opts.onFinish?.(outcome);
                        return {
                            status: 200,
                            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                            body: JSON.stringify({
                                ok: true,
                                message: es
                                    ? "Usando tu API key de Voyage guardada. Ya puedes cerrar esta pestaña."
                                    : "Using your saved Voyage API key. You can close this tab.",
                            }),
                        };
                    }

                    if (parsed.action === "key" && typeof parsed.key === "string") {
                        const key = parsed.key.trim();
                        if (!/^[\x21-\x7e]{8,256}$/.test(key)) {
                            return {
                                status: 200,
                                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                                body: JSON.stringify({
                                    ok: false,
                                    error: es
                                        ? "Esa clave no tiene formato válido (sin espacios, ej. pa-...)."
                                        : "That does not look like a valid Voyage API key (no spaces, e.g. pa-...).",
                                }),
                            };
                        }
                        const checkResult = await check(key);
                        if (checkResult.status === "invalid") {
                            return {
                                status: 200,
                                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                                body: JSON.stringify({
                                    ok: false,
                                    error: es
                                        ? `Voyage rechazó esa clave (HTTP ${checkResult.httpStatus}). Verifica haberla copiado completa.`
                                        : `Voyage rejected that key (HTTP ${checkResult.httpStatus}). Check that you copied the whole key.`,
                                }),
                            };
                        }
                        const outcome: SetupUiOutcome = { choice: { kind: "key", key }, verified: checkResult };
                        ctrl.outcome = outcome;
                        opts.onFinish?.(outcome);
                        return {
                            status: 200,
                            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
                            body: JSON.stringify({
                                ok: true,
                                message: es
                                    ? "API key de Voyage verificada y guardada. Configurando todos tus agentes..."
                                    : "Voyage API key verified and saved. Configuring all your agents...",
                            }),
                        };
                    }
                }
            }

            return {
                status: 404,
                headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
                body: "Not found",
            };
        },
    };
    return ctrl;
}

/**
 * Open the local browser Setup Box on `http://127.0.0.1:<port>/?t=<token>`.
 * Resolves to `null` if the server cannot start or the browser does not load
 * the page within `openTimeoutMs`, allowing automatic fallback to native/TTY UI.
 */
export async function askViaBrowserSetupUi(opts: SetupUiOptions): Promise<SetupUiOutcome | null> {
    const es = isSpanish(opts.locale);
    const openBrowser = opts.openBrowser ?? ((u: string) => launchSystemBrowser(u));
    const openTimeoutMs = opts.openTimeoutMs ?? 3_500;
    const sessionTimeoutMs = opts.sessionTimeoutMs ?? 20 * 60_000;

    return await new Promise<SetupUiOutcome | null>((resolve) => {
        let settled = false;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        let sessionTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: SetupUiOutcome | null) => {
            if (settled) return;
            settled = true;
            if (openTimer) clearTimeout(openTimer);
            if (sessionTimer) clearTimeout(sessionTimer);
            try {
                server.closeAllConnections?.();
                server.close();
            } catch { /* ignore */ }
            resolve(result);
        };

        const controller = createSetupUiController({
            texts: opts.texts,
            locale: opts.locale,
            check: opts.check,
            onOpened: () => {
                if (openTimer) { clearTimeout(openTimer); openTimer = undefined; }
            },
            onFinish: (outcome) => {
                setImmediate(() => finish(outcome));
            },
        });

        const server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url ?? "/", "http://127.0.0.1");
                const rawBody = req.method === "POST" ? await readRequestBody(req) : undefined;
                const reply = await controller.dispatch({
                    method: req.method ?? "GET",
                    pathname: url.pathname,
                    queryToken: url.searchParams.get("t"),
                    headerToken: typeof req.headers["x-nreki-token"] === "string" ? req.headers["x-nreki-token"] : null,
                    rawBody,
                });
                res.writeHead(reply.status, reply.headers);
                res.end(reply.body);
            } catch {
                try {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
                } catch { /* socket closed */ }
            }
        });

        server.on("error", () => finish(null));
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo | null;
            if (!addr || typeof addr.port !== "number") {
                finish(null);
                return;
            }
            const url = `http://127.0.0.1:${addr.port}/?t=${controller.token}`;
            const launched = openBrowser(url);
            if (!launched) {
                finish(null);
                return;
            }
            process.stderr.write(
                es
                    ? `\n[NREKI] Caja de configuración abierta en tu navegador: ${url}\n`
                    : `\n[NREKI] Setup box opened in your browser: ${url}\n`,
            );
            openTimer = setTimeout(() => {
                if (!controller.opened) finish(null);
            }, openTimeoutMs);
            sessionTimer = setTimeout(() => {
                finish({ choice: { kind: "skip" } });
            }, sessionTimeoutMs);
            sessionTimer.unref?.();
        });
    });
}
