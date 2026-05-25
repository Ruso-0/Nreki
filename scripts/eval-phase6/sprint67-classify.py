"""
Sprint 6.7 Phase 1 classifier — tsc-INDEPENDENT bucket assignment.

Reads:
  - results-c4b-full.json (per-task ground_truth, repo, base_commit)
  - .eval-phase5-cache/task-workspaces/task-<repo>-pr<num>/ (per-task source)

For each task, classifies into Bucket A / B / C per the pre-registered
operationalization in sprint67-preregistration.md.

Outputs:
  scripts/eval-phase6/sprint67-buckets.jsonl
  scripts/eval-phase6/sprint67-buckets-summary.md

This module imports NOTHING from src/ or scripts/eval-phase5/runners/.
It is a regex-only TypeScript-aware parser. tsc-independence is enforced
by the import surface (only stdlib + re/os/json/pathlib).
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "results-c4b-full.json"
CACHE = ROOT / ".eval-phase5-cache" / "task-workspaces"
OUT_JSONL = ROOT / "scripts" / "eval-phase6" / "sprint67-buckets.jsonl"
OUT_MD = ROOT / "scripts" / "eval-phase6" / "sprint67-buckets-summary.md"

JACCARD_THRESHOLD = 0.15  # PRE-REGISTERED — DO NOT MODIFY AFTER PHASE 1 RUNS

# Keywords stripped from identifier sets (pre-registered list)
KEYWORDS = frozenset({
    "const", "let", "var", "function", "class", "interface", "type", "enum",
    "import", "export", "from", "as", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "default", "true", "false",
    "null", "undefined", "new", "this", "super", "extends", "implements",
    "typeof", "instanceof", "in", "of", "void", "async", "await", "yield",
    "public", "private", "protected", "static", "readonly", "abstract",
    "declare", "namespace", "module", "any", "unknown", "never", "object",
    "string", "number", "boolean", "bigint", "symbol",
})

# Identifier tokenization regex (Unicode-friendly)
IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# Splits PascalCase: "FooBar" -> ["Foo","Bar"]; snake_case: "foo_bar" -> ["foo","bar"]
PASCAL_SPLIT_RE = re.compile(r"(?=[A-Z])")
TOKEN_LIMIT = 50_000

# Import regex variants
IMPORT_TYPE_BLOCK = re.compile(
    r"""import\s+type\s+(\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE | re.DOTALL,
)
IMPORT_BLOCK = re.compile(
    r"""import\s+(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}\s+|\*\s+as\s+\w+\s+|\w+\s+)from\s+['"]([^'"]+)['"]""",
    re.MULTILINE | re.DOTALL,
)
# Match `import { type Foo, Bar } from '...'` — extracts members that have inline `type` prefix
INLINE_TYPE_MEMBER_RE = re.compile(r"\btype\s+(\w+)")
# Re-export with from-clause
REEXPORT_BLOCK = re.compile(
    r"""export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE | re.DOTALL,
)
REEXPORT_STAR_RE = re.compile(
    r"""export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)

# Top-level type-shape declarations in target file
TOP_DECL_RE = re.compile(
    r"""^\s*(?:export\s+(?:default\s+)?)?(interface|type|enum|class)\s+(\w+)""",
    re.MULTILINE,
)


def slug_to_task_dir(repo: str, pull_number: int) -> Path:
    """
    Mirror the cloner's slug logic:
      microsoft/vscode  + 106767 -> task-microsoft-vscode-pr106767
      mui/material-ui   +  11451 -> task-mui-material-ui-pr11451
    """
    slug = repo.replace("/", "-")
    return CACHE / f"task-{slug}-pr{pull_number}"


def read_file_safe(path: Path) -> str | None:
    """Read TS source. Returns None if missing / unreadable / not text."""
    if not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(2_000_000)  # cap 2 MB
    except OSError:
        return None


def extract_identifiers(source: str) -> set[str]:
    """Pre-registered identifier extraction."""
    tokens: set[str] = set()
    seen = 0
    for m in IDENT_RE.finditer(source):
        tok = m.group(0)
        if seen >= TOKEN_LIMIT:
            break
        seen += 1
        lo = tok.lower()
        if lo in KEYWORDS or len(lo) < 2:
            continue
        tokens.add(lo)
        # PascalCase split
        if any(c.isupper() for c in tok[1:]):
            parts = [p for p in PASCAL_SPLIT_RE.split(tok) if p]
            for p in parts:
                pl = p.lower()
                if pl not in KEYWORDS and len(pl) >= 2:
                    tokens.add(pl)
        # snake_case split
        if "_" in tok:
            for p in tok.split("_"):
                pl = p.lower()
                if pl and pl not in KEYWORDS and len(pl) >= 2:
                    tokens.add(pl)
    return tokens


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    if union == 0:
        return 0.0
    return inter / union


def resolve_relative_import(
    importer_abs: Path,
    rel: str,
    repo_root: Path,
) -> Path | None:
    """
    Resolve a relative TS import (./foo, ../bar/baz) against the importer.
    Tries: as-is (if has known suffix), then .ts/.tsx/.d.ts/.js/.jsx,
    then /index.ts /index.tsx /index.js.
    Returns absolute path if found, None otherwise. Non-relative imports
    return None (we skip absolute / package imports).
    """
    if not rel.startswith("."):
        return None
    base_dir = importer_abs.parent
    target = (base_dir / rel).resolve()
    try:
        target.relative_to(repo_root.resolve())
    except ValueError:
        return None

    KNOWN_SUFFIXES = (".ts", ".tsx", ".d.ts", ".js", ".jsx", ".css")
    if target.suffix in KNOWN_SUFFIXES and target.is_file():
        return target
    for suf in (".ts", ".tsx", ".d.ts", ".js", ".jsx"):
        cand = target.with_suffix("") if target.suffix in KNOWN_SUFFIXES else target
        cand = Path(str(cand) + suf)
        if cand.is_file():
            return cand
    for idx in ("index.ts", "index.tsx", "index.js"):
        cand = target / idx
        if cand.is_file():
            return cand
    return None


def find_imports(source: str) -> list[tuple[str, str, set[str]]]:
    """
    Returns list of (kind, rel_path, member_names) for each import statement.
    kind in {"type", "value"}.
    """
    out: list[tuple[str, str, set[str]]] = []
    # type-only imports
    for m in IMPORT_TYPE_BLOCK.finditer(source):
        members_raw = m.group(1) or ""
        rel = m.group(2)
        if members_raw.startswith("{"):
            members = {n.strip().split(" as ")[0]
                       for n in members_raw.strip("{}").split(",")
                       if n.strip()}
        else:
            members = {members_raw.strip().split(" as ")[0]}
        out.append(("type", rel, members))
    # value imports (or mixed)
    for m in IMPORT_BLOCK.finditer(source):
        # Skip if this overlapped with type-only (heuristic: re-check it
        # starts with 'import type' — IMPORT_BLOCK wouldn't match that
        # because it requires no 'type' between 'import' and '{')
        default_name = m.group(1)
        block = m.group(2) or ""
        rel = m.group(3)
        members: set[str] = set()
        if default_name:
            members.add(default_name)
        if block:
            for part in block.split(","):
                part = part.strip()
                if not part:
                    continue
                # inline `type Foo` marker → strip and treat as type member
                if part.startswith("type "):
                    members.add(part[5:].split(" as ")[0].strip())
                else:
                    members.add(part.split(" as ")[0].strip())
        out.append(("value", rel, members))
    # re-export blocks
    for m in REEXPORT_BLOCK.finditer(source):
        rel = m.group(2)
        block = m.group(1) or ""
        members = {p.strip().split(" as ")[0] for p in block.split(",") if p.strip()}
        out.append(("reexport", rel, members))
    # export * from
    for m in REEXPORT_STAR_RE.finditer(source):
        out.append(("reexport_star", m.group(1), set()))
    return out


def top_level_type_names(source: str) -> set[str]:
    out: set[str] = set()
    for m in TOP_DECL_RE.finditer(source):
        kind = m.group(1)
        name = m.group(2)
        # Treat interface/type/enum as types unambiguously.
        # class counts too (often used as type via `as ClassName` / typeof).
        if kind in ("interface", "type", "enum", "class"):
            out.add(name)
    return out


def inline_type_members(source: str) -> set[str]:
    """Members declared with inline `type` marker — heuristic for IMPORT_BLOCK content."""
    return {m.group(1) for m in INLINE_TYPE_MEMBER_RE.finditer(source)}


def detect_type_edge(
    x_path: Path,
    y_path: Path,
    repo_root: Path,
    file_source_cache: dict[Path, str | None],
) -> bool:
    """
    Returns True if file X has a type-edge to file Y per the pre-registered
    rules 1-4 (sprint67-preregistration.md). Direction X -> Y only;
    caller checks both directions.
    """
    x_src = file_source_cache.get(x_path)
    if x_src is None:
        x_src = read_file_safe(x_path)
        file_source_cache[x_path] = x_src
    if x_src is None:
        return False
    y_src = file_source_cache.get(y_path)
    if y_src is None:
        y_src = read_file_safe(y_path)
        file_source_cache[y_path] = y_src
    if y_src is None:
        return False

    y_type_decls = top_level_type_names(y_src)
    imports = find_imports(x_src)

    for (kind, rel, members) in imports:
        resolved = resolve_relative_import(x_path, rel, repo_root)
        if resolved is None or resolved != y_path:
            continue
        # Rule 1: explicit type-only import
        if kind == "type":
            return True
        # Rule 2: inline `type Foo` marker inside value import block —
        # IMPORT_BLOCK strips the `type ` prefix and adds the name; we
        # re-detect inline markers by re-scanning the original block.
        # Simpler: search x_src for "import { ... type Foo ... } from '<rel>'"
        # via a targeted regex below.
        if kind == "value":
            pat = re.compile(
                r"import\s+\{[^}]*\btype\s+\w+[^}]*\}\s+from\s+['\"]" + re.escape(rel) + r"['\"]",
                re.MULTILINE | re.DOTALL,
            )
            if pat.search(x_src):
                return True
            # Rule 3: value-import of a name declared as type in Y
            if members & y_type_decls:
                return True
        if kind == "reexport":
            # Rule 4: re-export of a name declared as type in Y
            if members & y_type_decls:
                return True
        # reexport_star — conservative: don't claim a type-edge
    return False


def detect_any_edge(
    x_path: Path,
    y_path: Path,
    repo_root: Path,
    file_source_cache: dict[Path, str | None],
) -> bool:
    """Any import (type or value) from X to Y."""
    x_src = file_source_cache.get(x_path)
    if x_src is None:
        x_src = read_file_safe(x_path)
        file_source_cache[x_path] = x_src
    if x_src is None:
        return False
    for (_, rel, _) in find_imports(x_src):
        resolved = resolve_relative_import(x_path, rel, repo_root)
        if resolved is not None and resolved == y_path:
            return True
    return False


def classify_task(task: dict) -> dict:
    """
    Returns a dict {
        instance_id, repo, gt_size, bucket, reason,
        pairs: [{f1, f2, has_type_edge, has_any_edge, jaccard}, ...]
    }
    """
    instance_id = task["instance_id"]
    repo = task["repo"]
    pull_number_str = instance_id.rsplit("-", 1)[-1]
    try:
        pull_number = int(pull_number_str)
    except ValueError:
        return {"instance_id": instance_id, "repo": repo,
                "gt_size": len(task["ground_truth"]["strict_src"]),
                "bucket": "C", "reason": "unparseable instance_id",
                "pairs": []}
    repo_root = slug_to_task_dir(repo, pull_number)
    if not repo_root.is_dir():
        return {"instance_id": instance_id, "repo": repo,
                "gt_size": len(task["ground_truth"]["strict_src"]),
                "bucket": "C",
                "reason": f"workspace missing at {repo_root}",
                "pairs": []}

    gt_strict_src = task["ground_truth"]["strict_src"]
    if len(gt_strict_src) < 2:
        return {"instance_id": instance_id, "repo": repo,
                "gt_size": len(gt_strict_src),
                "bucket": "C",
                "reason": f"|G|={len(gt_strict_src)} < 2 (single-file)",
                "pairs": []}

    gt_paths = [repo_root / rel for rel in gt_strict_src]
    file_src_cache: dict[Path, str | None] = {}
    id_cache: dict[Path, set[str]] = {}

    for p in gt_paths:
        src = read_file_safe(p)
        file_src_cache[p] = src
        id_cache[p] = extract_identifiers(src) if src is not None else set()

    pair_results = []
    has_A_pair = False
    has_B_pair = False
    for i in range(len(gt_paths)):
        for j in range(i + 1, len(gt_paths)):
            p1, p2 = gt_paths[i], gt_paths[j]
            jac = jaccard(id_cache[p1], id_cache[p2])
            type_edge = (detect_type_edge(p1, p2, repo_root, file_src_cache)
                         or detect_type_edge(p2, p1, repo_root, file_src_cache))
            any_edge = (type_edge
                        or detect_any_edge(p1, p2, repo_root, file_src_cache)
                        or detect_any_edge(p2, p1, repo_root, file_src_cache))
            pair_results.append({
                "f1": gt_strict_src[i], "f2": gt_strict_src[j],
                "has_type_edge": type_edge,
                "has_any_edge": any_edge,
                "jaccard": jac,
                "f1_missing": file_src_cache[p1] is None,
                "f2_missing": file_src_cache[p2] is None,
            })
            if type_edge and jac < JACCARD_THRESHOLD:
                has_A_pair = True
            if any_edge or jac >= JACCARD_THRESHOLD:
                has_B_pair = True

    if has_A_pair:
        bucket, reason = "A", "type-dependent pair with jaccard<0.15"
    elif has_B_pair:
        bucket, reason = "B", "cross-file (lexical or non-type import)"
    else:
        bucket, reason = "C", "no cross-file connection"
    return {"instance_id": instance_id, "repo": repo,
            "gt_size": len(gt_strict_src),
            "bucket": bucket, "reason": reason,
            "pairs": pair_results}


def main():
    with open(RESULTS, encoding="utf-8") as f:
        full = json.load(f)
    tasks = full["per_task"]
    print(f"Classifying {len(tasks)} tasks (Jaccard threshold = {JACCARD_THRESHOLD})...",
          file=sys.stderr)

    out_lines = []
    bucket_counts = Counter()
    repo_bucket = Counter()
    for i, task in enumerate(tasks):
        result = classify_task(task)
        out_lines.append(json.dumps(result, ensure_ascii=False))
        bucket_counts[result["bucket"]] += 1
        repo_bucket[(result["repo"], result["bucket"])] += 1
        if (i + 1) % 20 == 0:
            print(f"  ...{i + 1}/{len(tasks)}", file=sys.stderr)

    OUT_JSONL.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_JSONL}", file=sys.stderr)

    # Summary markdown
    lines = [
        "# Sprint 6.7 — Phase 1 bucket classification",
        "",
        f"Jaccard threshold (pre-registered): {JACCARD_THRESHOLD}",
        f"Total tasks classified: {len(tasks)}",
        "",
        "## Bucket counts",
        "",
        f"- Bucket A (type-dependent-cross-file, low lexical overlap): **{bucket_counts['A']}**",
        f"- Bucket B (cross-file, lexical or non-type): {bucket_counts['B']}",
        f"- Bucket C (single-file / no cross-file): {bucket_counts['C']}",
        "",
        "## Per-repo bucket distribution",
        "",
        "| Repo | A | B | C | Total |",
        "|---|---|---|---|---|",
    ]
    repos_in_order = sorted({t['repo'] for t in tasks},
                            key=lambda r: -sum(1 for t in tasks if t["repo"] == r))
    for repo in repos_in_order:
        a = repo_bucket[(repo, "A")]
        b = repo_bucket[(repo, "B")]
        c = repo_bucket[(repo, "C")]
        lines.append(f"| {repo} | {a} | {b} | {c} | {a + b + c} |")

    # Stopping rule check
    n_A = bucket_counts['A']
    if n_A < 15:
        verdict = (
            f"\n## Stopping rule\n"
            f"**|A| = {n_A} < 15.** Per pre-registration, this is **insufficient sample**. "
            f"Phase 2 will still compute metrics for transparency, but the H0/H1 verdict "
            f"will be reported as 'insufficient sample — cannot reject H0 with available power'."
        )
    elif n_A <= 30:
        verdict = (
            f"\n## Stopping rule\n"
            f"|A| = {n_A} ∈ [15, 30]. Proceed with Phase 2 but report CI width as the limit on certainty."
        )
    else:
        verdict = (
            f"\n## Stopping rule\n"
            f"|A| = {n_A} > 30. Standard Phase 2 reporting."
        )
    lines.append(verdict)

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}", file=sys.stderr)
    print(f"\nBucket counts: A={bucket_counts['A']}, B={bucket_counts['B']}, C={bucket_counts['C']}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
