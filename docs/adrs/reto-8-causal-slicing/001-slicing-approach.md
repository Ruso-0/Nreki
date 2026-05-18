# ADR-001 — Slicing Approach: Static vs Dynamic vs Hybrid

Status: **Accepted (Phase 0 — Sprint Initial)**
Date: 2026-05-16
Supersedes: —
Superseded by: —
Related: ADR-002 (granularity), ADR-003 (direction), ADR-005
(integration), `000-literature-review.md`

---

## Context

Reto 8 must recover *causal evidence chains* from a symptom (a
failing or queried site) back to the edit location that explains it.
Three architectural families exist empírico verifiable in the prior
art (see `000-literature-review.md`):

- **Static slicing** — analyses source code without executing it.
  Conservative, sound, complete (all possible paths). Pays cost in
  precision: includes spurious dependencies the program would never
  exercise at runtime. Empirical instances: WALA Slicer, Joana,
  NS-Slicer, JavaSlicer, JSSlicer.
- **Dynamic slicing** — observes one or many program executions and
  builds the dependence graph from the actual trace. Precise per
  execution, incomplete across executions. Pays cost in
  instrumentation overhead and execution-environment dependence.
  Empirical instances: Slicer4J, SliceJS (selective-instrumentation
  variant).
- **Hybrid** — static skeleton augmented by selective dynamic
  instrumentation in regions where static analysis is provably
  imprecise (heavy use of `eval`, dynamic dispatch through string
  keys, framework-injected callbacks). Empirical instance: SliceJS.

There is now a fourth contender — **learning-based slicing**
(NS-Slicer, SLICET5, LLM-based) — which we treat as an *optional
augmentation*, not a replacement (see Decision §3 below). LLM-only
slicing sits at ~60 % accuracy empírico verifiable today (paper 15
in literature review); it is not a load-bearing primitive.

NREKI's existing infrastructure constrains the choice:

- TypeScript Compiler API is already wired in
  [src/kernel/nreki-kernel.ts](../../../src/kernel/nreki-kernel.ts)
  and
  [src/kernel/spectral-topology.ts](../../../src/kernel/spectral-topology.ts).
  Static analysis primitives are free empírico verifiable.
- NREKI is fundamentally an offline retrieval index — `.nreki.db` +
  `.nreki.vec` are persisted artifacts. Dynamic instrumentation
  would require running the target program, which NREKI does not
  do today and which would violate the "local-first, offline,
  deterministic" property emphasised in the Phase 5 paper.
- The "ambos fail" 40-task subset is a *retrieval* benchmark, not a
  runnable benchmark. We do not have execution traces for those
  tasks empírico verifiable.

## Decision

**Reto 8 Phase 7.1 will use static slicing on a TypeScript
System Dependence Graph (SDG), with two explicit extension hooks
reserved (but not implemented in Phase 7.1) for hybrid dynamic
instrumentation and learning-based augmentation.**

Phase 7.1 commits:

1. Build a TypeScript SDG over the project under analysis, using
   `ts.createProgram` + `ts.TypeChecker` for inter-procedural
   semantics. Use the canonical Horwitz/Reps/Binkley 1990 two-pass
   marking algorithm.
2. Restrict scope to **purely static, intra-procedural and
   inter-procedural slicing** through *statically resolvable*
   control flow.
3. Treat dynamic-dispatch sites (decorators, DI containers,
   event-emitter `.on` strings, framework lifecycle hooks) as
   *witnessed conservatively*: the slice includes every site that
   could possibly bind, with provenance annotations so the consumer
   knows the binding is over-approximated.

Phase 7.1 *does not* commit:

- No runtime instrumentation. No `require-hook`, no `tsx --import`
  loader. NREKI remains an offline retrieval system.
- No learning-based slicing. NS-Slicer-style neural predictors are
  out of scope until a Phase 7.1 symbolic baseline has been
  evaluated.

Phase 7.2 and 7.3 reserve (with no implementation commitment):

- Hybrid hook: a `DynamicTraceProvider` interface allowing an
  external profiler/test-runner to inject *observed* dispatch
  bindings into the SDG, replacing the conservative
  over-approximation. This is how SliceJS gets precision back.
- Learning hook: a `SlicePredictor` interface that can re-rank or
  prune the conservative slice using a NS-Slicer-style model. The
  symbolic slice remains the source of truth; the predictor is a
  rank/prune layer.

## Rationale

**Why not pure dynamic.** NREKI is offline-by-design. Dynamic
slicing requires running the target program with instrumentation,
which (a) breaks the local-first property, (b) requires a working
test or driver for every project, (c) creates non-determinism that
would invalidate the NREKI retrieval benchmark methodology, and (d)
adds an unbounded engineering surface (browser bundling, Node loader
hooks, ESM/CJS interop, transpilation, source-map alignment) that
would dominate the Phase 7.1 timeline.

**Why not pure learning-based.** Empírico verifiable HOY: LLM-only
slicing sits at ~60 % accuracy on Java (paper 15). NS-Slicer reaches
94-96 % F1 on Java but (i) targets Java, not TypeScript, (ii) has no
published TS training corpus, and (iii) cannot be load-bearing for
"why this file matters" claims because its predictions lack
provenance to a source statement. Learning-based slicing is a Phase
8 candidate, not a Phase 7.1 spine.

**Why static + reserved hybrid hooks.** This matches the empirical
sweet spot identified by SliceJS for JavaScript and Slicer4J for
Java: a static SDG gives a sound over-approximation suitable for
"why this file matters" claims; selective dynamic instrumentation
later refines precision *only where the static analysis is provably
imprecise*. Reserving the hook now without implementing it keeps the
Phase 7.1 surface small and the Phase 7.2/7.3 path open.

**Why conservative over-approximation for dynamic dispatch.** The
NREKI retrieval thesis is *evidence-delivery*, not autonomous
decision-making. An over-approximated slice with explicit
provenance annotations ("included via dynamic dispatch site, may be
spurious") is consistent with the paper's Section 9.3 stance that
NREKI is an evidence-delivery component, not an autonomous
permission system. Under-approximation would silently drop relevant
files; over-approximation is the safe default.

## Consequences

Positive:

- Bounded Phase 7.1 engineering surface (static SDG only).
- Composes with NREKI's existing TS Compiler API integration.
- Preserves local-first, offline, deterministic property.
- Honest precision/recall trade-off (we will publish conservative
  slice sizes; precision improvements deferred to Phase 7.2/7.3).
- Forward-compatible with hybrid + learning extensions.

Negative:

- Slice size will be larger than dynamic or learning-based slicers
  on the same code. We will need to publish slice-size statistics
  empírico verifiable and acknowledge that NS-Slicer would likely
  produce tighter slices on Java-equivalent code.
- Dynamic dispatch through decorators, DI containers, and event
  emitters will be over-approximated. Some "ambos fail" 40-task
  failures may not be closed by a purely static slicer.
- We cannot publish a head-to-head NS-Slicer comparison in the
  Phase 7.1 paper because the languages differ.

## Verification (Phase 7.1 exit criteria for this ADR)

- [ ] Static SDG constructed for ≥ 1 representative TypeScript
      project from the "ambos fail" 40-task subset, empírico
      verifiable.
- [ ] Backward slice from a chosen criterion is computed and
      reproduces the canonical Weiser definition on a known-answer
      micro-benchmark, empírico verifiable.
- [ ] Conservative annotations on dynamic-dispatch sites are
      machine-readable (JSON / typed) and human-inspectable.
- [ ] No runtime instrumentation in the implementation; verified by
      `grep -r "require\\(.*hook\\|--import" src/causal-slicer/`
      empty empírico verifiable.

## Open Questions Deferred

- Q: Will the conservative slice on a 2 000-LoC TypeScript file fit
  inside the NREKI token budget? Empirical measurement deferred to
  Milestone 0 PoC.
- Q: Does NREKI's existing chunked storage model (`.nreki.db`
  chunk granularity) align with statement-level slice output?
  Deferred to ADR-005 (integration) + Milestone 0 measurement.
- Q: Should the slicer reuse the `parser-pool` Tree-sitter
  infrastructure for non-TS files at SDG boundaries, or treat
  cross-language calls as opaque sinks? Deferred to ADR-004
  (cross-language scope).
