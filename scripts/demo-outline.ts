/**
 * scripts/demo-outline.ts — live demo of NREKI parasitic signals in outline.
 *
 * Creates a throwaway project in $TMP with a file that has three smells
 * (swallowed catch, `as any`, an unused exported function), boots a real
 * NrekiEngine, calls handleOutline, and prints the result. Exactly the
 * output a Claude Code / Cursor agent sees when it asks for an outline.
 *
 * Used by scripts/demo.tape to record the landing-page GIF.
 *   1. npm install
 *   2. vhs scripts/demo.tape        # produces docs/demo.gif
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleOutline } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-demo-"));
    try {
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                target: "ES2022", module: "Node16", moduleResolution: "Node16",
                strict: true, esModuleInterop: true, rootDir: ".", skipLibCheck: true,
            },
            include: ["./**/*.ts"], exclude: ["node_modules", "dist"],
        }));

        // A file with three LLM-rush smells — real things NREKI flags.
        fs.writeFileSync(path.join(dir, "auth.ts"), [
            "export function parseToken(raw: string): unknown {",
            "    try {",
            "        return JSON.parse(raw);",
            "    } catch (e) { }",            // swallowed-error
            "    return raw as any;",          // type-escape-any
            "}",
            "",
            "// No file imports this function anywhere.",
            "export function unusedHelper(): number {",
            "    return 42;",
            "}",
            "",
        ].join("\n"));

        // A second file that imports nothing from auth.ts — guarantees
        // unusedHelper stays un-referenced and gets the ghost tag.
        fs.writeFileSync(path.join(dir, "billing.ts"), [
            "export function charge(amount: number): number {",
            "    return amount * 1.2;",
            "}",
            "",
        ].join("\n"));

        process.stdout.write(`${DIM}# Demo project in ${dir}${RESET}\n\n`);
        process.stdout.write(`${BOLD}$ nreki_navigate action:"outline" path:"auth.ts"${RESET}\n\n`);

        const engine = new NrekiEngine({
            dbPath: path.join(dir, ".nreki-demo.db"),
            watchPaths: [dir],
        });
        await engine.initialize();
        await engine.indexDirectory(dir);

        const deps = { engine } as unknown as RouterDependencies;
        const t0 = Date.now();
        const response = await handleOutline({ action: "outline", path: "auth.ts" }, deps);
        const ms = Date.now() - t0;

        const text = (response.content[0] as { text?: string }).text ?? "";
        // Tint the tags so they pop on the recording.
        const colored = text
            .replace(/⚠️ \[[^\]]+\]/g, (m) => `${YELLOW}${m}${RESET}`)
            .replace(/👻 \[0 ext refs\]/g, (m) => `${CYAN}${m}${RESET}`);
        process.stdout.write(colored);
        process.stdout.write(`\n${DIM}# Outline built in ${ms}ms — all signals are in the header the agent already reads.${RESET}\n`);

        await engine.shutdown();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

main().catch((err) => {
    process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
