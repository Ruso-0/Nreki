#!/usr/bin/env node
/**
 * scripts/compile-paper-pdf.mjs
 *
 * Compile the Phase 5 paper markdown to PDF via Chrome/Chromium headless.
 *
 * Pipeline (matches v11.0.0/v11.0.1 PDF metadata: HeadlessChrome + Skia/PDF):
 *   markdown → HTML (marked) → Chrome --headless --print-to-pdf → PDF
 *
 * Requirements:
 *   - Node 18+ (uses ESM, child_process, fs/promises)
 *   - marked package (run `npm install --no-save marked` if not present)
 *   - Chrome or Chromium accessible via CHROME_BIN env or default install
 *
 * Usage:
 *   node scripts/compile-paper-pdf.mjs [source.md] [output.pdf]
 *
 * Defaults:
 *   source = docs/paper-phase5/draft-v0.4-arxiv-restored.md
 *   output = docs/paper-phase5/draft-v0.4-arxiv.pdf
 *
 * Optional env:
 *   CHROME_BIN — explicit Chrome/Chromium binary path
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE = process.argv[2] || "docs/paper-phase5/draft-v0.4-arxiv-restored.md";
const OUTPUT = process.argv[3] || "docs/paper-phase5/draft-v0.4-arxiv.pdf";
const CSS = "docs/paper-phase5/paper-style.css";

function fail(msg) {
    console.error(`compile-paper-pdf: ${msg}`);
    process.exit(1);
}

if (!existsSync(SOURCE)) fail(`source markdown not found: ${SOURCE}`);
if (!existsSync(CSS)) fail(`stylesheet not found: ${CSS}`);

let marked;
try {
    ({ marked } = await import("marked"));
} catch {
    fail("'marked' package not installed. Run: npm install --no-save marked");
}

const md = readFileSync(SOURCE, "utf-8");
const cssText = readFileSync(CSS, "utf-8");
const htmlBody = marked.parse(md, { gfm: true, breaks: false });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>NREKI Phase 5 Paper Draft v0.4</title>
<style>${cssText}</style>
</head>
<body>
${htmlBody}
</body>
</html>`;

const tmp = mkdtempSync(join(tmpdir(), "paper-pdf-"));
const htmlPath = join(tmp, "paper.html");
writeFileSync(htmlPath, html, "utf-8");

function findChrome() {
    if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
        return process.env.CHROME_BIN;
    }
    const candidates = process.platform === "win32"
        ? [
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ];
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
}

const chrome = findChrome();
if (!chrome) fail("Chrome/Chromium not found. Set CHROME_BIN env to the binary path.");

const outAbs = resolve(OUTPUT);
const htmlUrl = pathToFileURL(htmlPath).href;

const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--print-to-pdf=${outAbs}`,
    "--print-to-pdf-no-header",
    "--no-pdf-header-footer",
    htmlUrl,
];

const r = spawnSync(chrome, args, { stdio: "inherit" });
if (r.status !== 0) fail(`chrome exit ${r.status}`);

if (!existsSync(OUTPUT)) fail("PDF not produced");
const size = statSync(OUTPUT).size;
console.log(`✓ PDF generated: ${OUTPUT} (${size} bytes)`);
