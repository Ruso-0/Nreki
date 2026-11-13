/**
 * suppression-guard.ts — Anti-Sweep Shield (NREKI-GAR-03).
 *
 * Blocks edits that ADD comments silencing the checkers NREKI runs or
 * documents as forbidden:
 *   TS/JS : @ts-ignore, @ts-nocheck, @ts-expect-error,
 *           blanket eslint-disable (no rule list — silences every rule,
 *           including NREKI's React shield), eslint-disable naming one of the
 *           React shield rules.
 *   Python: # type: ignore, # pyright: ignore, # noqa.
 *
 * Differential by design: it compares directive counts BEFORE vs AFTER the
 * edit, so legacy suppressions already in the file (or inside a symbol being
 * replaced) never block an unrelated edit. Only newly introduced ones do.
 * Suppressions of rules NREKI does not enforce (e.g.
 * `// eslint-disable-next-line no-console`) are left to the project's linter.
 */

interface Directive {
    label: string;
    pattern: RegExp; // must be global
}

const REACT_SHIELD_RULES =
    "react-hooks\\/rules-of-hooks|react-hooks\\/exhaustive-deps|react\\/jsx-key|jsx-a11y\\/alt-text";

const TS_JS_DIRECTIVES: Directive[] = [
    { label: "@ts-ignore", pattern: /(?:\/\/|\/\*)[\s*]*@ts-ignore\b/g },
    { label: "@ts-nocheck", pattern: /(?:\/\/|\/\*)[\s*]*@ts-nocheck\b/g },
    { label: "@ts-expect-error", pattern: /(?:\/\/|\/\*)[\s*]*@ts-expect-error\b/g },
    {
        // No rule list: `// eslint-disable-next-line`, `/* eslint-disable */`,
        // `// eslint-disable-line -- reason`.
        label: "blanket eslint-disable",
        pattern: /(?:\/\/|\/\*)[ \t]*eslint-disable(?:-next-line|-line)?(?=[ \t]*(?:\*\/|--|\r?$))/gm,
    },
    {
        label: "eslint-disable of a React shield rule",
        pattern: new RegExp(
            `(?:\\/\\/|\\/\\*)\\s*eslint-disable(?:-next-line|-line)?\\s+[^\\r\\n]*\\b(?:${REACT_SHIELD_RULES})\\b`,
            "gi",
        ),
    },
];

const PYTHON_DIRECTIVES: Directive[] = [
    { label: "# type: ignore", pattern: /#\s*type:\s*ignore\b/g },
    { label: "# pyright: ignore", pattern: /#\s*pyright:\s*ignore\b/g },
    { label: "# noqa", pattern: /#\s*noqa\b/gi },
];

function directivesFor(filePath: string): Directive[] {
    const lower = filePath.toLowerCase();
    if (/\.(?:[cm]?[jt]sx?)$/.test(lower)) return TS_JS_DIRECTIVES;
    if (/\.pyi?$/.test(lower)) return PYTHON_DIRECTIVES;
    return [];
}

function count(text: string, pattern: RegExp): number {
    pattern.lastIndex = 0;
    let n = 0;
    while (pattern.exec(text) !== null) n++;
    pattern.lastIndex = 0;
    return n;
}

/**
 * Return a human-readable list of suppression directives that `after` adds
 * relative to `before` (empty when the edit adds none).
 */
export function findNewSuppressions(filePath: string, before: string, after: string): string[] {
    const added: string[] = [];
    for (const d of directivesFor(filePath)) {
        const delta = count(after, d.pattern) - count(before, d.pattern);
        if (delta > 0) added.push(delta > 1 ? `${d.label} (x${delta})` : d.label);
    }
    return added;
}

export function antiSweepMessage(relPath: string, added: string[]): string {
    return `Blocked by Anti-Sweep Shield in ${relPath}: the edit adds ${added.join(", ")}. ` +
        `Suppression comments are forbidden — fix the underlying error instead. File NOT modified.`;
}
