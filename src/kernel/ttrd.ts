// src/kernel/ttrd.ts
export function extractRawSignatures(content: string, ext: string): Map<string, string> {
    const signatures = new Map<string, string>();
    if (ext !== ".py" && ext !== ".go") return signatures;

    const startRegex = ext === ".py"
        ? /^\s*(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(/gm
        : /^func\s+(?:\([^)]*\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;

    let match;
    while ((match = startRegex.exec(content)) !== null) {
        const symbolName = match[1];
        const startIndex = match.index;
        let i = startIndex + match[0].length - 1;

        let parenDepth = 0;
        let inString: string | null = null;
        let foundEnd = false;

        for (; i < content.length; i++) {
            const ch = content[i];
            if (inString) {
                if (ch === '\\') i++;
                else if (ch === inString) inString = null;
                continue;
            }
            if ((ch === '"' || ch === "'") && i + 2 < content.length
                && content[i + 1] === ch && content[i + 2] === ch) {
                const tripleQuote = ch + ch + ch;
                const endTriple = content.indexOf(tripleQuote, i + 3);
                if (endTriple !== -1) { i = endTriple + 2; continue; }
                break;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inString = ch; continue;
            }
            if (ch === '(') parenDepth++;
            else if (ch === ')') {
                parenDepth--;
                if (parenDepth === 0) { foundEnd = true; i++; break; }
            }
        }

        if (foundEnd) {
            let sigEnd = i;
            if (ext === ".py") {
                while (sigEnd < content.length && content[sigEnd] !== ':') sigEnd++;
                if (sigEnd < content.length) sigEnd++;
            } else if (ext === ".go") {
                while (sigEnd < content.length && content[sigEnd] !== '{') sigEnd++;
            }
            const rawSig = content.substring(startIndex, sigEnd).replace(/\s+/g, ' ').trim();
            signatures.set(symbolName, rawSig);
        }
    }
    return signatures;
}

export function detectSignatureRegression(
    oldSig: string,
    newSig: string,
    ext: string
): { isRegression: boolean; reason: string } {
    const toxicRegex = ext === ".py" ? /\b(Any|any)\b/ : /\b(any|interface\{\})\b/;
    if (!toxicRegex.test(oldSig) && toxicRegex.test(newSig)) {
        return { isRegression: true, reason: `Injected toxic untyped '${ext === ".py" ? "Any" : "interface{}"}'` };
    }

    if (ext === ".py") {
        const hadReturn = /->\s*[^:]+/.test(oldSig);
        const hasReturn = /->\s*[^:]+/.test(newSig);
        if (hadReturn && !hasReturn) {
            return { isRegression: true, reason: "Lost return type annotation (->)" };
        }

        const oldParams = oldSig.match(/\((.*)\)/)?.[1] || "";
        const newParams = newSig.match(/\((.*)\)/)?.[1] || "";
        const oldAnnotations = (oldParams.match(/:/g) || []).length;
        const newAnnotations = (newParams.match(/:/g) || []).length;

        if (oldAnnotations > 0 && newAnnotations === 0) {
            return { isRegression: true, reason: "Stripped all parameter type annotations" };
        }
    } else if (ext === ".go") {
        const oldReturn = oldSig.substring(oldSig.lastIndexOf(')') + 1).replace('{', '').trim();
        const newReturn = newSig.substring(newSig.lastIndexOf(')') + 1).replace('{', '').trim();
        if (oldReturn.length > 0 && newReturn.length === 0) {
            return { isRegression: true, reason: "Lost return type annotation" };
        }
    }

    return { isRegression: false, reason: "" };
}

export function isToxicType(typeStr: string): boolean {
    const s = typeStr.trim();
    if (s === "object" || s.replace(/\s/g, "") === "{}") return true;
    if (/\b(any|unknown|Function)\b/.test(s)) return true;
    return false;
}
