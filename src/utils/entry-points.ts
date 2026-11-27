/**
 * entry-points.ts — the files a project starts from: orphan_oracle's roots.
 *
 * A file is reachable when an import chain leads to it from one of these. The
 * 12.x oracle tested its name patterns (`main.*`, `index.*`, `app.*`…) against
 * the whole project-relative path, so `src/main.tsx` and `src/App.tsx` were
 * never roots: in a Vite + React project every component imported only from
 * App.tsx (header, footer, layouts, error boundary, auth guard) was reported as
 * unreachable dead code (measured on a real project, 2026-11-27). Names are
 * matched on the file name now, and the entries a project declares count too:
 * `<script src>` in its HTML pages and package.json `main`/`module`/`bin`/`exports`.
 * Every rule errs towards "reachable": a missed orphan costs nothing, a used
 * file reported as dead invites a deletion that breaks the build.
 */

import fs from "fs";
import path from "path";
import { safePath } from "./path-jail.js";

/** File names that frameworks, bundlers, test runners and CLIs start from. */
const ENTRY_NAMES: ReadonlyArray<RegExp> = [
    /^(?:index|main|app|setup|server|cli|vite-env)\./i,
    /^(?:__main__|__init__|manage|wsgi|asgi|conftest)\.py$/i,
    /\.config\.[cm]?[jt]sx?$/i,                // vite / next / tailwind / postcss … configs
    /^(?:middleware|instrumentation)\./i,
    /^(?:sw|service-worker)\./i,
    /\.(?:test|spec|cy|e2e|stories|story)\./i,
];

/** Folders whose files are started by a framework or a runner, not imported. */
const ENTRY_DIRS = /(?:^|\/)(?:pages|app|api|routes|bin|scripts|cmd|test|tests|__tests__|e2e|migrations?|seeds?|fixtures)\//i;

const SCRIPT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** True when the name or folder of `relPosix` (project-relative, `/`) makes it an entry point. */
export function isConventionalEntry(relPosix: string): boolean {
    const base = path.posix.basename(relPosix);
    return base.endsWith(".d.ts") || ENTRY_NAMES.some(re => re.test(base)) || ENTRY_DIRS.test(relPosix);
}

/** The project file `spec` names, written in `fromDir` (project-relative), or null. */
function resolveLocal(spec: string, fromDir: string, known: ReadonlySet<string>): string | null {
    const clean = spec.trim().replace(/[?#].*$/, "");
    if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null; // http:, data:, //cdn…
    const joined = clean.startsWith("/") ? clean.slice(1) : path.posix.join(fromDir, clean);
    const rel = path.posix.normalize(joined).replace(/^\.\//, "");
    if (rel.startsWith("..")) return null;
    const candidates = [rel, ...SCRIPT_EXTS.map(e => rel + e), ...SCRIPT_EXTS.map(e => `${rel}/index${e}`)];
    // `"main": "dist/index.js"` names a build output: its source keeps the same path under src/.
    if (/^(?:dist|build|lib|out)\//.test(rel)) {
        const src = rel.replace(/^[^/]+\//, "src/").replace(/\.[cm]?js$/, "");
        candidates.push(...SCRIPT_EXTS.map(e => src + e));
    }
    return candidates.find(c => known.has(c)) ?? null;
}

function readSmall(root: string, rel: string): string | null {
    try {
        const abs = safePath(root, rel);
        if (fs.statSync(abs).size > MAX_MANIFEST_BYTES) return null;
        return fs.readFileSync(abs, "utf8");
    } catch {
        return null;
    }
}

/** Every string inside a package.json `exports`/`bin` value (conditions and subpaths included). */
function stringsIn(value: unknown, out: string[]): void {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
    else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
}

/**
 * Files the project declares as entry points: scripts its HTML pages load
 * (`<script src>`, `<link rel="modulepreload" href>`, Vite's `/src/main.tsx`)
 * and the `main`, `module`, `browser`, `types`, `bin` and `exports` of each
 * package.json. `files` are project-relative POSIX paths; so is the result.
 */
export function declaredEntries(root: string, files: ReadonlyArray<string>): Set<string> {
    const known = new Set(files);
    const entries = new Set<string>();
    for (const rel of files) {
        const base = path.posix.basename(rel).toLowerCase();
        const dir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
        if (base.endsWith(".html") || base.endsWith(".htm")) {
            const html = readSmall(root, rel);
            if (html === null) continue;
            const specs = [
                ...html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi),
                ...html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+\.[cm]?[jt]sx?)["']/gi),
            ].map(m => m[1]);
            for (const spec of specs) {
                const hit = resolveLocal(spec, dir, known);
                if (hit) entries.add(hit);
            }
        } else if (base === "package.json") {
            const text = readSmall(root, rel);
            if (text === null) continue;
            let pkg: Record<string, unknown>;
            try { pkg = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
            if (!pkg || typeof pkg !== "object") continue;
            const specs: string[] = [];
            for (const field of ["main", "module", "browser", "types", "typings"]) {
                if (typeof pkg[field] === "string") specs.push(pkg[field] as string);
            }
            stringsIn(pkg.bin, specs);
            stringsIn(pkg.exports, specs);
            for (const spec of specs) {
                const hit = resolveLocal(spec.startsWith(".") || spec.startsWith("/") ? spec : `./${spec}`, dir, known);
                if (hit) entries.add(hit);
            }
        }
    }
    return entries;
}
