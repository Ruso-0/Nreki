/**
 * qualified-name.ts — `Class.method` as a symbol name.
 *
 * Agents name a method the way they read it: `RecoveryCodes.redeem`,
 * `Store::get`, `Repo#save`. The index and the parser store the bare member
 * name, so every tool answered "not found" (edit, batch_edit, compress focus)
 * or "No references found" — and in the 2026-11-13 A/B two of three NREKI
 * sessions resent their whole batch_edit for it: one more turn, ~20k tokens.
 */

export interface QualifiedName {
    /** The innermost container: `Outer.Inner.method` → `Inner`. */
    container: string;
    member: string;
}

const IDENT = "[A-Za-z_$][\\w$]*";
const SEP = "(?:\\.|::|#|->)";
const QUALIFIED = new RegExp(`^(${IDENT}(?:${SEP}${IDENT})*)${SEP}(${IDENT})$`);

/** `A.b`, `A::b`, `A#b`, `A->b` (also `Outer.Inner.b`); null for a plain name or anything else. */
export function splitQualifiedName(name: string): QualifiedName | null {
    const m = QUALIFIED.exec(name.trim());
    if (!m) return null;
    const containers = m[1].split(/\.|::|#|->/);
    return { container: containers[containers.length - 1], member: m[2] };
}

/** The member part of a qualified name, or the name itself. */
export function memberName(name: string): string {
    return splitQualifiedName(name)?.member ?? name;
}

interface ChunkLike {
    rawCode: string;
    startIndex: number;
    endIndex: number;
}

/**
 * The chunk `qualified` names: a member inside a chunk named like the container
 * (classes, Python classes, Rust impls), or a Go method whose receiver is that
 * type. `ambiguous` > 0 when several match — never guess between them.
 */
export function findQualifiedChunk<T extends ChunkLike>(
    chunks: readonly T[],
    qualified: string,
    nameOf: (c: T) => string,
): { chunk: T | null; ambiguous: number } {
    const q = splitQualifiedName(qualified);
    if (!q) return { chunk: null, ambiguous: 0 };
    const containers = chunks.filter(c => nameOf(c) === q.container);
    const goReceiver = new RegExp(`^\\s*func\\s*\\(\\s*(?:${IDENT}\\s+)?\\*?\\s*${q.container.replace(/\$/g, "\\$")}\\b`);
    const members = chunks.filter(c => nameOf(c) === q.member && (
        containers.some(o => o !== c && o.startIndex <= c.startIndex && c.endIndex <= o.endIndex) ||
        goReceiver.test(c.rawCode)
    ));
    if (members.length === 1) return { chunk: members[0], ambiguous: 0 };
    return { chunk: null, ambiguous: members.length };
}
