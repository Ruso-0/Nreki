#!/usr/bin/env node
// Capture `npx tsx scripts/demo-outline.ts` output and emit an asciinema v2 .cast file.
// Feeds svg-term-cli to produce a crisp animated SVG.
const { spawn } = require("child_process");
const fs = require("fs");

const COMMAND = "npx tsx scripts/demo-outline.ts";
const WIDTH = 120;
const HEIGHT = 38;
const TYPING_SPEED_MS = 40;
const PROMPT = "$ ";

const outPath = process.argv[2] || "docs/demo.cast";

const events = [];
const header = {
  version: 2,
  width: WIDTH,
  height: HEIGHT,
  timestamp: Math.floor(Date.now() / 1000),
  env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
};

let t = 0;
function emit(sec, data) { events.push([+sec.toFixed(3), "o", data]); }
function advance(ms) { t += ms / 1000; }

emit(t, PROMPT);
advance(400);
for (const ch of COMMAND) {
  emit(t, ch);
  advance(TYPING_SPEED_MS);
}
advance(300);
emit(t, "\r\n");
advance(400);

const child = spawn("cmd", ["/c", COMMAND], {
  cwd: "D:/Nreki",
  env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: undefined },
  stdio: ["ignore", "pipe", "pipe"],
});

const startHr = process.hrtime.bigint();
const baseSec = t;

child.stdout.on("data", (chunk) => {
  const elapsedSec = Number(process.hrtime.bigint() - startHr) / 1e9;
  events.push([+(baseSec + elapsedSec).toFixed(3), "o", chunk.toString()]);
});
child.stderr.on("data", (chunk) => {
  const elapsedSec = Number(process.hrtime.bigint() - startHr) / 1e9;
  events.push([+(baseSec + elapsedSec).toFixed(3), "o", chunk.toString()]);
});

child.on("exit", (code) => {
  const elapsedSec = Number(process.hrtime.bigint() - startHr) / 1e9;
  const finalT = baseSec + elapsedSec + 0.8;
  events.push([+finalT.toFixed(3), "o", `\r\n${PROMPT}`]);

  const lines = [JSON.stringify(header)];
  for (const ev of events) lines.push(JSON.stringify(ev));
  fs.writeFileSync(outPath, lines.join("\n") + "\n");
  console.error(`wrote ${outPath} (${events.length} events, exit=${code})`);
});
