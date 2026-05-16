/**
 * download-wasm.js — Postinstall script to fetch Tree-sitter WASM grammars.
 * Copies grammars from the tree-sitter-wasms npm package into the wasm/ directory.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = join(__dirname, "..", "wasm");
const WASMS_PKG = join(__dirname, "..", "node_modules", "tree-sitter-wasms", "out");

const NEEDED = [
    "tree-sitter-typescript.wasm",
    "tree-sitter-tsx.wasm",
    "tree-sitter-javascript.wasm",
    "tree-sitter-python.wasm",
    "tree-sitter-go.wasm",
    "tree-sitter-css.wasm",   // v10.11.1
    "tree-sitter-html.wasm",  // v10.11.1
    "tree-sitter-json.wasm",  // v10.11.1
    // v11.0.x multi-language activation - bundled in tree-sitter-wasms@0.1.13
    // Kotlin: Android primary (fwcd/tree-sitter-kotlin@0.3.1)
    // Java: JVM ecosystem (tree-sitter-java@0.20.2, record_declaration supported)
    // C++: Android NDK + cross-platform native (tree-sitter-cpp@0.20.4)
    "tree-sitter-kotlin.wasm",
    "tree-sitter-java.wasm",
    "tree-sitter-cpp.wasm",
];

if (!existsSync(WASM_DIR)) {
    mkdirSync(WASM_DIR, { recursive: true });
}

if (existsSync(WASMS_PKG)) {
    // Copy from tree-sitter-wasms npm package
    // TODO: Add SHA-256 checksum verification after copy to detect supply chain tampering.
    for (const name of NEEDED) {
        const src = join(WASMS_PKG, name);
        const dest = join(WASM_DIR, name);
        if (existsSync(dest)) {
            console.log(`  ✓ ${name} already exists, skipping.`);
            continue;
        }
        if (existsSync(src)) {
            copyFileSync(src, dest);
            console.log(`  ✓ ${name} copied from tree-sitter-wasms.`);
        } else {
            console.warn(`  ⚠ ${name} not found in tree-sitter-wasms package.`);
            console.warn(`     File extension(s) for this grammar will silently fall back to "unsupported".`);
            console.warn(`     If you need this language, upgrade: npm install tree-sitter-wasms@latest`);
        }
    }
} else {
    console.warn("  ⚠ tree-sitter-wasms package not found. Run: npm install tree-sitter-wasms");
    console.warn("  Then re-run this script: node scripts/download-wasm.js");
}

console.log("\n✅ WASM grammars ready.\n");
