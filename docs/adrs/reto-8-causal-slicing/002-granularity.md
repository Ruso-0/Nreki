# ADR-002 — Slicing Granularity

Status: **Accepted (Phase 0 — Sprint Initial)**
Date: 2026-05-16
Related: ADR-001 (approach), ADR-005 (NREKI integration)

---

## Context

A slicer can operate at several granularities:

- **Statement-level** — slice nodes are full TypeScript statements
  (`ts.SyntaxKind.VariableStatement`, `IfStatement`,
  `ExpressionStatement`, etc.). Classical Weiser / Horwitz-Reps
  granularity. Output is reconstructable as compilable source via
  the printer.
- **Expression-level** — slice nodes are individual expressions
  (`PropertyAccessExpression`, `CallExpression`, `BinaryExpression`).
  Finer precision; harder to reconstruct as compilable output.
- **Variable-level** — slice nodes are variable definitions and uses
  (def-use pairs). The most precise; the least human-readable.
- **AST-node-level** — slice nodes are arbitrary AST nodes. Most
  flexible; weakest soundness guarantees because the AST node
  boundary does not always align with a dependence boundary.

NREKI's existing infrastructure constrains this choice:

- `.nreki.db` chunked storage is, empírico verifiable, structured
  around symbol-level chunks (`symbolName`, `chunkId`, file:line
  spans). See
  [src/compressor-foveal-cross-file.ts](../../../src/compressor-foveal-cross-file.ts)
  `CrossFileChunk` definition.
- The foveal compressor already operates at *statement-level
  causal refs* via regex (`extractCausalRefs`) for single-file
  parafovea. Statement-level slice output composes naturally.
- The "why this file matters" retrieval thesis (paper Section 7.3)
  argues for evidence that a human reviewer can read. Variable-level
  slices are not human-readable as standalone output.

## Decision

**Statement-level granularity for the Phase 7.1 slice output,
backed internally by an expression-level Program Dependence Graph
(PDG).**

Concretely:

1. The PDG is constructed at expression granularity for soundness
   (def-use accurate at the expression level). This is what the
   SDG-construction phase produces.
2. The slice operator (backward or forward, ADR-003) computes its
   reachable set on the PDG, then projects each reachable
   expression up to its enclosing statement.
3. The exported `Slice` value contains statements, with each
   statement annotated by the expressions that caused its
   inclusion. The consumer (NREKI retrieval pipeline, paper artifact
   renderer, end user) sees statements; the audit log retains the
   expression-level provenance.

## Rationale

**Why statement-level output.** Three reasons.

First, *NREKI integration*. The existing chunk pipeline expects
file/line spans; statements map cleanly onto line ranges, while
expressions often span fractional lines and produce visually broken
output if rendered standalone.

Second, *paper-thesis alignment*. Paper Section 7.3 frames Reto 8
output as "minimal evidence chains from symptom to edit location".
A reviewer wants to read a sequence of statements that explain a
behaviour; they do not want a list of `PropertyAccessExpression`
nodes.

Third, *prior-art alignment*. Weiser's original definition is
statement-level. NS-Slicer, JavaSlicer, Slicer4J, WALA Slicer all
expose statement-level slices. We inherit the comparability
property: a Reto 8 slice can in principle be evaluated against the
NS-Slicer Java benchmark style, if a TS-equivalent benchmark ever
exists.

**Why expression-level internal PDG.** Soundness. Statement-level
PDGs lose precision on expressions like
`f(a, g(b)).h = c.compute(d).e`, where there are multiple
def-use boundaries inside one statement. The literature (Tip 1995
§3) is clear that statement-level PDGs over-approximate aggressively.
We pay the engineering cost once (expression-level PDG construction)
and project to statement granularity at output time.

**Why not variable-level.** Variable-level slices are tighter but
not human-readable as standalone evidence. A variable-level slice
that says "include `result.user.profile.email`" gives no spatial
context. NREKI's retrieval thesis is evidence-delivery to a human or
an LLM reviewer; statement-level is the smallest unit that carries
its own context.

**Why not AST-node-level.** AST-node-level breaks the soundness
guarantee of Tip 1995 because AST node boundaries are syntactic, not
semantic. A `BinaryExpression` and its operands have different
dependence semantics; slicing at AST-node-level conflates them.

## Consequences

Positive:

- Output composes with `.nreki.db` chunk model with minimal glue.
- Slice rendering reuses TypeScript printer (`ts.createPrinter`)
  to produce compilable extracts.
- Provenance retained at expression level for audit purposes.

Negative:

- Statement-level projection inflates slice size slightly relative
  to an expression-level slice on dense expressions (e.g., chained
  method calls in fluent APIs). Acceptable trade.
- A statement containing both a relevant and irrelevant expression
  is *included entirely* — the consumer must accept that the slice
  is a *minimal-statement* slice, not a *minimal-token* slice.

## Verification (Phase 7.1 exit criteria for this ADR)

- [ ] PDG construction internal expression-level, validated by
      unit test on a known-answer triple-expression statement
      empírico verifiable.
- [ ] Output projection statement-level, validated by round-trip
      `ts.printNode` producing syntactically valid TypeScript on a
      micro-benchmark empírico verifiable.
- [ ] Provenance annotation preserves expression-level cause set on
      each output statement, schema-validated empírico verifiable.
