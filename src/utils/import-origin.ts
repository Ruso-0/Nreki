/**
 * import-origin.ts — the file that really declares an imported name.
 *
 * `context` shows the short definitions of what the shown code imports. It
 * looked each name up in the whole index, and a single match was accepted
 * whatever its file: `import { calculateFee } from "./public.js"` (a barrel
 * re-exporting `realFee as calculateFee`), or from the package
 * "@vendor/billing", showed an unrelated `calculateFee` that multiplied by
 * 999 as "what that code imports" (audit of 0d48ca4). A helper is now shown
 * only from the file that declares it:
 *   - TS/JS: the specifier resolved as the compiler resolves it (tsconfig
 *     `paths`, `.js` -> `.ts`, index files), re-exports followed;
 *   - Python: the module's file, its package `__init__`, or a module of
 *     that package;
 *   - Go: the package's directory under the go.mod module path.
 * A package, or an alias the project's config does not resolve, gives no
 * helper rather than a homonym.
 */

import fs from "fs";
import path from "path";
import * as ts from "typescript";

/** One name a file imports. */
export interface ImportBinding {
    /** Name used in the importing file. */
    local: string;
    /** Name the module exports ("default" for a default import). */
    imported: string;
    /** The module as written: "./fees.js", "@/lib/money". */
    source: string;
}

/** Where a name is declared: absolute file path, and its name there. */
export interface DeclarationSite {
    file: string;
    /** Differs from the imported name through `export { realFee as calculateFee }`. */
    name: string;
}

const MAX_HOPS = 24;

function scriptKind(file: string): ts.ScriptKind {
    switch (path.extname(file).toLowerCase()) {
        case ".tsx": return ts.ScriptKind.TSX;
        case ".jsx": return ts.ScriptKind.JSX;
        case ".js": case ".mjs": case ".cjs": return ts.ScriptKind.JS;
        default: return ts.ScriptKind.TS;
    }
}

function parse(file: string, text: string): ts.SourceFile {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
}

function bindingsOf(sf: ts.SourceFile): ImportBinding[] {
    const out: ImportBinding[] = [];
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
            const source = st.moduleSpecifier.text;
            const clause = st.importClause;
            if (clause.name) out.push({ local: clause.name.text, imported: "default", source });
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) {
                    out.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, source });
                }
            }
        } else if (ts.isVariableStatement(st)) {
            // const { a, b: c } = require("./x")
            for (const d of st.declarationList.declarations) {
                const init = d.initializer;
                if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== "require") continue;
                const arg = init.arguments[0];
                if (!arg || !ts.isStringLiteral(arg) || !ts.isObjectBindingPattern(d.name)) continue;
                for (const el of d.name.elements) {
                    if (!ts.isIdentifier(el.name)) continue;
                    const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))
                        ? el.propertyName.text
                        : el.name.text;
                    out.push({ local: el.name.text, imported: prop, source: arg.text });
                }
            }
        }
    }
    return out;
}

/** The named, default and `require` destructuring imports of a TS/JS file (namespace imports are not followed). */
export function jsImportBindings(file: string, text: string): ImportBinding[] {
    return bindingsOf(parse(file, text));
}

const optionsCache = new Map<string, { stamp: string; options: ts.CompilerOptions }>();

/** The project's compiler options (tsconfig.json/tsconfig.app.json or jsconfig.json at the root), for module resolution only. */
function compilerOptions(root: string): ts.CompilerOptions {
    const config = ["tsconfig.json", "jsconfig.json"].map(n => path.join(root, n)).find(p => fs.existsSync(p));
    const host: ts.ParseConfigHost = { ...ts.sys, readDirectory: () => [] };
    let effective = config;
    let rawConfig: unknown;
    if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (!read.error) {
            rawConfig = read.config;
            const rec = read.config as { files?: unknown; include?: unknown; references?: unknown } | null;
            const delegatesOnly = rec !== null && typeof rec === "object"
                && Array.isArray(rec.files) && rec.files.length === 0
                && rec.include === undefined && Array.isArray(rec.references) && rec.references.length > 0;
            if (delegatesOnly) {
                const rootDir = path.resolve(path.dirname(config));
                const normDir = (d: string): string =>
                    ts.sys.useCaseSensitiveFileNames ? path.resolve(d) : path.resolve(d).toLowerCase();
                const rootKey = normDir(rootDir);
                const parsedRefs = ts.parseJsonConfigFileContent(read.config, host, rootDir, undefined, config).projectReferences ?? [];
                const isAux = (n: string): boolean =>
                    /\.(?:node|test|tests|spec|specs|vitest|jest|cypress|playwright|e2e|storybook|eslint)\./i.test(n);
                const isApp = (n: string): boolean => /\.(?:app|web|client|src|browser|dom)\./i.test(n);
                const candidates: Array<{ file: string; raw: unknown; tier: number }> = [];
                for (const ref of parsedRefs) {
                    const refFile = path.resolve(ts.resolveProjectReferencePath(ref));
                    if (normDir(path.dirname(refFile)) !== rootKey || !fs.existsSync(refFile)) continue;
                    const base = path.basename(refFile);
                    if (isAux(base)) continue;
                    const refRead = ts.readConfigFile(refFile, ts.sys.readFile);
                    if (!refRead.error) candidates.push({ file: refFile, raw: refRead.config, tier: isApp(base) ? 2 : 1 });
                }
                candidates.sort((a, b) => b.tier - a.tier);
                if (candidates.length > 0) {
                    effective = candidates[0].file;
                    rawConfig = candidates[0].raw;
                }
            }
        }
    }
    let stamp = "";
    try {
        const m1 = config ? fs.statSync(config).mtimeMs : 0;
        const m2 = effective && effective !== config ? fs.statSync(effective).mtimeMs : 0;
        stamp = config ? `${config}:${m1}->${effective}:${m2}` : "";
    } catch { /* gone meanwhile */ }
    const cached = optionsCache.get(root);
    if (cached && cached.stamp === stamp) return cached.options;
    let options: ts.CompilerOptions = {};
    if (effective && rawConfig !== undefined) {
        options = ts.parseJsonConfigFileContent(rawConfig, host, path.dirname(effective), undefined, effective).options;
    }
    options = { allowJs: true, ...options };
    optionsCache.set(root, { stamp, options });
    return options;
}

function insideRoot(root: string, file: string): boolean {
    const rel = path.relative(root, file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The project file `source` (imported from `fromFile`) resolves to; null for a package, a .d.ts or nothing. */
export function resolveJsModule(root: string, fromFile: string, source: string): string | null {
    let resolved: ts.ResolvedModuleFull | undefined;
    try {
        resolved = ts.resolveModuleName(source, fromFile, compilerOptions(root), ts.sys).resolvedModule;
    } catch {
        return null;
    }
    if (!resolved || resolved.isExternalLibraryImport) return null;
    const file = path.resolve(resolved.resolvedFileName);
    if (/\.d\.[mc]?ts$/i.test(file) || /[\\/]node_modules[\\/]/i.test(file) || !insideRoot(root, file)) return null;
    return file;
}

function declares(st: ts.Statement, name: string): boolean {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)
        || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
        return st.name !== undefined && ts.isIdentifier(st.name) && st.name.text === name;
    }
    return ts.isVariableStatement(st)
        && st.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name);
}

function isDefaultExport(st: ts.Statement): boolean {
    return ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function declaredIn(root: string, file: string, name: string, seen: Set<string>): DeclarationSite | null {
    const key = `${file}\u0000${name}`;
    if (seen.has(key) || seen.size >= MAX_HOPS) return null;
    seen.add(key);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
    const sf = parse(file, text);
    const follow = (source: string, imported: string): DeclarationSite | null => {
        const target = resolveJsModule(root, file, source);
        return target ? declaredIn(root, target, imported, seen) : null;
    };
    // A name of this file: declared here, or imported into it.
    const local = (localName: string): DeclarationSite | null => {
        if (sf.statements.some(st => declares(st, localName))) return { file, name: localName };
        const binding = bindingsOf(sf).find(b => b.local === localName);
        return binding ? follow(binding.source, binding.imported) : null;
    };

    if (name === "default") {
        for (const st of sf.statements) {
            if (isDefaultExport(st)) {
                const declName = (st as ts.DeclarationStatement).name;
                return declName && ts.isIdentifier(declName) ? { file, name: declName.text } : null;
            }
            if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) return local(st.expression.text);
        }
    } else if (sf.statements.some(st => declares(st, name))) {
        return { file, name };
    }
    for (const st of sf.statements) {
        if (!ts.isExportDeclaration(st)) continue;
        const source = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
            const el = st.exportClause.elements.find(e => e.name.text === name);
            if (el) {
                const original = (el.propertyName ?? el.name).text;
                return source !== null ? follow(source, original) : local(original);
            }
        } else if (!st.exportClause && source !== null && name !== "default") {
            const hit = follow(source, name); // export * from "./x"
            if (hit) return hit;
        }
    }
    return null;
}

/** Where the name `imported` of the module `source` (imported by `fromFile`) is declared, or null if that cannot be established. */
export function jsDeclarationSite(root: string, fromFile: string, source: string, imported: string): DeclarationSite | null {
    const target = resolveJsModule(root, fromFile, source);
    return target ? declaredIn(root, target, imported, new Set()) : null;
}

const posixDir = (rel: string): string => path.posix.dirname(rel);

/**
 * Python: does `defRel` hold what `module` exports, imported from `fromRel`
 * (both project-relative POSIX)? Its module file, its package `__init__`, or
 * a module inside that package (re-exported by `__init__`).
 */
export function pythonModuleHolds(module: string, fromRel: string, defRel: string): boolean {
    const noExt = defRel.replace(/\.pyi?$/i, "");
    const dots = /^\.+/.exec(module)?.[0].length ?? 0;
    const segs = module.slice(dots).split(".").filter(Boolean);
    if (dots > 0) {
        let base = posixDir(fromRel);
        for (let i = 1; i < dots; i++) base = posixDir(base);
        const modPath = path.posix.normalize(path.posix.join(base, ...segs));
        const prefix = modPath === "." ? "" : `${modPath}/`;
        return (modPath !== "." && noExt === modPath) || noExt === `${prefix}__init__` || posixDir(defRel) === modPath;
    }
    if (segs.length === 0) return false;
    const tail = segs.join("/");
    const endsWith = (p: string, t: string): boolean => p === t || p.endsWith(`/${t}`);
    return endsWith(noExt, tail) || endsWith(noExt, `${tail}/__init__`) || endsWith(posixDir(defRel), tail);
}

const goModules = new Map<string, { stamp: string; module: string | null }>();

function goModulePath(root: string): string | null {
    const mod = path.join(root, "go.mod");
    let stamp = "";
    try { stamp = String(fs.statSync(mod).mtimeMs); } catch { return null; }
    const cached = goModules.get(root);
    if (cached && cached.stamp === stamp) return cached.module;
    let module: string | null = null;
    try { module = /^\s*module\s+(\S+)/m.exec(fs.readFileSync(mod, "utf8"))?.[1] ?? null; } catch { /* unreadable */ }
    goModules.set(root, { stamp, module });
    return module;
}

/** Go: is `defRel` (project-relative POSIX) a file of the package `importPath` of this module? */
export function goPackageHolds(root: string, importPath: string, defRel: string): boolean {
    const module = goModulePath(root);
    if (!module) return false;
    const dir = importPath === module ? "." : importPath.startsWith(`${module}/`) ? importPath.slice(module.length + 1) : null;
    return dir !== null && posixDir(defRel) === dir;
}
