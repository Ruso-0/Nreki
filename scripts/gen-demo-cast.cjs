#!/usr/bin/env node
// v2 — captures the demo output then RE-TIMES it with cinematic pacing.
// Output lines appear as if typed/streamed, with dramatic pauses before
// key reveals (timings, scene headers, result panels).
const { spawn } = require("child_process");
const fs = require("fs");

const COMMAND = "npx tsx scripts/demo-outline.ts";
const WIDTH = 120;
const HEIGHT = 38;
const TYPING_SPEED_MS = 45;
const PROMPT = "$ ";

const outPath = process.argv[2] || "docs/demo.cast";

function linesOf(s) {
  // Keep trailing \n as its own marker so per-line timing is stable.
  return s.split(/(?<=\n)/);
}

function pickDelay(line) {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (plain === "") return 90;
  // Scene / target header
  if (/^#\s/.test(plain)) return 550;
  // Command prompt reveal
  if (/^\$\s/.test(plain)) return 500;
  // Results block header
  if (/^---\s*Results/.test(plain)) return 700;
  // The hero reveal: Fiedler timing row
  if (/Fiedler\s*\(sparse\)/.test(plain)) return 1100;
  // The "Built in Xms" closer
  if (/^#\s*Built in/.test(plain)) return 500;
  // Truncation marker
  if (/\(truncated\)/.test(plain)) return 350;
  // Symbol lines with risk tags (the point of the demo)
  if (/\[HIGH|\[MED|\[LOW|\[any escape|0 ext refs/.test(plain)) return 65;
  // Regular data rows
  return 45;
}

async function main() {
  const events = [];
  const header = {
    version: 2,
    width: WIDTH,
    height: HEIGHT,
    timestamp: Math.floor(Date.now() / 1000),
    env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
  };

  let t = 0;
  const emit = (data) => events.push([+t.toFixed(3), "o", data]);

  emit(PROMPT);
  t += 0.35;
  for (const ch of COMMAND) {
    emit(ch);
    t += TYPING_SPEED_MS / 1000;
  }
  t += 0.35;
  emit("\r\n");
  t += 0.45;

  // Capture full output synchronously (we'll re-time after).
  const rawChunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn("cmd", ["/c", COMMAND], {
      cwd: "D:/Nreki",
      env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c) => rawChunks.push(c.toString()));
    child.stderr.on("data", (c) => rawChunks.push(c.toString()));
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.on("error", reject);
  });

  const raw = rawChunks.join("");
  // Normalize CRLF
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const outputLines = linesOf(normalized);

  // Re-emit each line with a pacing-based delay.
  for (const line of outputLines) {
    if (!line.length) continue;
    // Convert \n back to \r\n for asciinema rendering clarity.
    const data = line.endsWith("\n") ? line.slice(0, -1) + "\r\n" : line;
    emit(data);
    t += pickDelay(line) / 1000;
  }

  // Final settle + prompt reappears so the last frame isn't mid-output.
  t += 1.2;
  emit(`${PROMPT}`);

  const lines = [JSON.stringify(header)];
  for (const ev of events) lines.push(JSON.stringify(ev));
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.error(`wrote ${outPath} · ${events.length} events · total ${t.toFixed(1)}s`);
}

main().catch((err) => { console.error(err); process.exit(1); });
