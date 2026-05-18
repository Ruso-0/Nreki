# ADR-005 — Integration with NREKI Type Ledger and Retrieval Pipeline

Status: **Accepted (Phase 0 — Sprint Initial)**
Date: 2026-05-16
Related: ADR-001 (approach), ADR-002 (granularity), ADR-003
(direction), ADR-004 (scope)

---

## Context

NREKI's existing architecture, empírico verifiable from the v11.0.0
codebase:

- **Type Ledger** ([src/compressor-foveal-cross-file.ts](../../../src/compressor-foveal-cross-file.ts))
  — file-level topological symbol graph. Drives the foveal
  compressor's cross-file parafovea via upstream/downstream symbol
  resolution. Output is a ranked set of `CrossFileChunk` items.
- **Hybrid RRF retrieval** — late fusion of Type Ledger topology
  with BM25 lexical, evaluated empírico in Phase 5 paper draft-v0.4
  arXiv (FHR 0.566 vs NREKI 0.414 vs BM25 0.374).
- **Foveal compressor** — token-budgeted context assembly,
  statement-level for single-file, chunk-level for cross-file.
- **`.nreki.db`** — chunked persistent storage; chunks indexed by
  `chunkId`, `path`, `symbolName`.

Reto 8's *causal slice* is a fundamentally different signal:

- Type Ledger answers: *"which files contain symbols that are
  topologically reachable from the query?"* — file-level, depth-1
  by default.
- Causal slicing answers: *"which statements in which files must
  exist for the queried behaviour to obtain?"* — statement-level,
  unbounded transitive depth.

The two signals are *complementary*, not redundant: Type Ledger
gives breadth-at-low-depth; causal slicing gives depth-at-narrow-
breadth. The literature has no analogue for this combination
empírico verifiable.

Three integration patterns are possible:

- **Standalone module** — `src/causal-slicer/` is a separate
  subsystem with its own CLI / MCP entry point. The retrieval
  pipeline does not call it; the user does.
- **Integrated re-ranker** — the slicer post-processes
  hybrid RRF output to re-rank files by "presence of causally
  relevant statements". Causal weight blends into RRF scores.
- **Integrated parafovea expander** — the slicer expands the
  foveal-compressor cross-file parafovea by adding causally
  reachable statements that Type Ledger would not surface
  (statements reachable via callback, DI, lifecycle hook, etc.).

## Decision

**Reto 8 Phase 7.1 implements the standalone module pattern first,
with the integrated parafovea expander as a Phase 7.1.5 follow-up
behind a feature flag. The integrated re-ranker is deferred to
Phase 7.2 pending Phase 7.1 empirical results.**

Concretely:

1. `src/causal-slicer/` is a self-contained subsystem (ADR §
   module structure below). Exports a programmatic API and an MCP
   tool entry point.
2. No modifications to `compressor-foveal.ts`,
   `compressor-foveal-cross-file.ts`, the search pipeline, or
   `engine.ts` in Phase 7.1.
3. Phase 7.1.5 adds an opt-in path:
   `foveal.crossFileMode = "type-ledger" | "type-ledger+slice"`,
   off by default. When `"type-ledger+slice"` is set, the foveal
   compressor calls into the slicer after Type Ledger has produced
   its parafovea, merges the statements, deduplicates by chunk
   path/line range, and re-applies the token budget.
4. Phase 7.2 evaluates whether causal weight should *also* feed
   back into RRF score, gated on Phase 7.1.5 empirical results
   ("does slice expansion improve FHR on the 'ambos fail' 40-task
   subset?").

## Rationale

**Why standalone module first.** Three reasons.

First, *empirical risk isolation*. The Phase 5 paper has just been
drafted and the hybrid RRF result is the empirical centrepiece. If
Phase 7.1 introduces causal slice signals directly into the
retrieval pipeline, any change in the hybrid result becomes
attributable to *either* the slicer or to incidental refactoring.
Keeping the slicer external preserves the ability to A/B compare
"slicer-on vs slicer-off" while holding all other retrieval
machinery fixed.

Second, *test surface containment*. The Phase 5 test suite is 1313+
tests green. Adding slicer dependencies inside the retrieval
pipeline would force re-validation of the entire retrieval surface.
Standalone module lets the slicer ship with its own test surface
without touching the retrieval test suite.

Third, *MCP user value first*. Users may want to run the slicer
ad-hoc ("explain why this function is reachable from this
endpoint") without invoking retrieval. The MCP entry point provides
this regardless of whether retrieval ever calls into the slicer.

**Why Phase 7.1.5 expander, not re-ranker.** The expander is a pure
union operation: slice ∪ Type Ledger parafovea, then dedupe and
budget. It cannot reduce recall; it can only add statements that
Type Ledger missed. Re-ranking, in contrast, can *reduce* recall if
the causal weight pushes a relevant file below the top-K cutoff;
that risks regressing the empirical Phase 5 result. The expander is
strictly additive; the re-ranker is potentially subtractive.

**Why off-by-default for Phase 7.1.5.** The empirical question
"does causal slicing improve hybrid RRF on the 'ambos fail' 40-task
subset?" is unanswered. Default-on would make the answer
contaminated by selection bias (whoever runs NREKI is running with
the slicer enabled by default). Default-off forces explicit opt-in
during evaluation, gives a clean A/B, and preserves the Phase 5
empirical baseline as the comparison anchor.

## Module Structure

```text
src/causal-slicer/
  index.ts                  # public API + MCP entry
  types.ts                  # Statement, Variable, DependenceEdge,
                            # PDG, SDG, Slice, OpaqueSink, etc.
  sdg/
    builder.ts              # ts.createProgram + ts.TypeChecker
                            # → SDG construction
    pdg.ts                  # per-function PDG (expression-level)
    inter-procedural.ts     # call edges, return edges
    dynamic-dispatch.ts     # conservative over-approximation of
                            # callback, DI, decorator, lifecycle
    cross-language.ts       # opaque-sink emission for non-TS calls
  slicer/
    backward.ts             # backward marking
    forward.ts              # forward marking
    evidence-chain.ts       # backward ∩ forward composition
  output/
    projection.ts           # expression-level slice → statement
                            # projection
    renderer.ts             # ts.printNode statement rendering
    provenance.ts           # expression-level cause set
                            # annotation schema
  mcp/
    tool.ts                 # MCP tool registration
                            # (slice_backward, slice_forward,
                            # evidence_chain)
```

Tests under `tests/causal-slicer/` mirror this layout, one test
file per source file plus the Milestone 0 PoC suite (see Phase 2
design doc, separate artifact).

## Consequences

Positive:

- Phase 7.1 empirical results are uncontaminated by integration
  changes to the retrieval pipeline.
- Phase 5 baseline preserved as the immovable comparison anchor.
- Slicer ships as a usable MCP tool independent of retrieval.
- Phase 7.1.5 expander is a 50-line plumbing change once Phase 7.1
  is empirically validated.

Negative:

- Two release cycles to ship the integrated value (7.1 standalone,
  7.1.5 expander). Acceptable given Reto 8 wall-clock estimate of
  6-12 months.
- Code duplication risk: the slicer must independently maintain
  its own TS Compiler API instance lifecycle; cannot reuse the
  retrieval pipeline's program/typechecker without refactoring
  ownership. Acceptable in Phase 7.1; a shared `TypeCheckerHost`
  is a Phase 7.2 candidate refactor.

## Verification (Phase 7.1 exit criteria for this ADR)

- [ ] `src/causal-slicer/` builds independently; removing it does
      not break the rest of the test suite empírico verifiable.
- [ ] No imports from `src/causal-slicer/*` into `src/engine*`,
      `src/compressor*`, `src/search/*` in Phase 7.1 empírico
      verifiable.
- [ ] MCP tool entry point registers and is callable via NREKI's
      existing MCP server empírico verifiable.
- [ ] Phase 7.1.5 feature flag exists in
      `src/compressor-foveal.ts` only as an `import.meta.env` /
      configuration switch; the default mode preserves the Phase 5
      baseline behaviour empírico verifiable.
