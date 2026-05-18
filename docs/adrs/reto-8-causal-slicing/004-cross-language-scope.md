# ADR-004 — Cross-Language Scope

Status: **Accepted (Phase 0 — Sprint Initial)**
Date: 2026-05-16
Related: ADR-001 (approach), Reto 9 (multi-language Type Ledger)

---

## Context

NREKI v11.0.0 ships parser-level activation for 10 languages
(TS/TSX/JS/JSX/Python/Go/CSS/JSON/HTML/Kotlin/Java/C++), verified
empírico in commits `b6ee8fb` and `0fe6dc3`. *However*, the Type
Ledger (the semantic, symbol-graph layer that powers cross-file
parafovea) remains TypeScript-specific empírico verifiable; see
[src/compressor-foveal-cross-file.ts](../../../src/compressor-foveal-cross-file.ts)
which queries a TS-shaped symbol graph.

Reto 9 (paper §7.4) is the multi-language Type Ledger expansion:
JVM family first (Kotlin + Java), then C++. Reto 9 is *gating* for
multi-language slicing because a slicer needs a semantic resolver
(WALA-style, Eclipse JDT for JVM, clangd for C++), not just
parser-level AST access.

The literature (`000-literature-review.md` Finding D) is
unequivocal: production slicers are built on language-specific
semantic frontends. WALA for Java. clangd / DG for C/C++. NS-Slicer
for Java (learned). No tool slices multiple languages with shared
infrastructure today empírico verifiable.

## Decision

**Phase 7.1 of Reto 8 is TypeScript-only (and adjacent JavaScript
where the TS Compiler API admits it natively, i.e., `allowJs`).
Phases 7.2 and 7.3 of Reto 8 are explicitly gated on Reto 9
progress; they will not begin until the corresponding Type Ledger
language support exists.**

Concretely:

- **Phase 7.1 (Reto 8.1):** TypeScript and `allowJs` JavaScript
  slicing. Single TS Compiler API instance. Cross-file via existing
  Type Ledger.
- **Phase 7.2 (Reto 8.2):** JVM family (Kotlin + Java). Blocked on
  Reto 9.1 (Type Ledger JVM expansion) reaching minimum-viable
  state empírico verifiable.
- **Phase 7.3 (Reto 8.3):** C++. Blocked on Reto 9.2 (Type Ledger
  C++ expansion) reaching minimum-viable state empírico verifiable.
- **Cross-language calls in a Phase 7.1 slice are treated as opaque
  sinks/sources** — the slicer records "control flow exits to a
  non-TS file `foo.py:42`" but does not follow it. Provenance is
  preserved; the consumer can decide whether to recursively slice
  the foreign file with a future slicer.

## Rationale

**Why TS-only Phase 7.1.** Three reasons.

First, *NREKI infrastructure alignment*. The Type Ledger is TS-only
today empírico verifiable. A multi-language slicer with no
multi-language symbol resolver underneath would be a slicer-shaped
hole, not a working slicer.

Second, *engineering surface containment*. WALA, Joana, Slicer4J,
NS-Slicer all target a single language family at a time and the
literature shows that cross-language slicing is an open research
problem in its own right (Krinke 2003 limited to concurrent same-
language programs; no production cross-language slicer exists
empírico verifiable). Phase 7.1 attempting cross-language slicing
would compound the already-arduous Reto 8 with an unsolved research
problem from Reto 9.

Third, *"ambos fail" 40-task subset is TypeScript*. The paper's
empirical target (PolyBench-Verified TypeScript N=99, with ~40
tasks where NREKI + BM25 + hybrid all fail) is TypeScript-only.
Phase 7.1 closing a subset of those 40 tasks is the empírico
verifiable success criterion. Adding multi-language scope adds
engineering load without adding addressable benchmark mass.

**Why opaque-sink treatment for cross-language calls.** The
alternative — silently dropping cross-language calls — would
silently under-approximate the slice and violate the soundness
property (ADR-001). Treating them as opaque sinks with provenance
gives the consumer the information needed to know that the slice is
truncated at a language boundary; future work can extend by
following the sink into a foreign-language slicer.

**Why gate Phases 7.2 / 7.3 on Reto 9.** A JVM slicer requires
Eclipse JDT Core or an equivalent semantic frontend. A C++ slicer
requires clangd or LLVM IR + DG. Neither is integrated into NREKI
today empírico verifiable, and Reto 9 is the work that brings them
in. Starting Reto 8.2 before Reto 9.1 would force Reto 8 to
re-derive symbol resolution that Reto 9 is already going to build —
guaranteed duplication.

## Consequences

Positive:

- Phase 7.1 wall-clock estimate is bounded and tractable (TS only).
- Reto 9 progress directly enables Reto 8 progress, creating a
  natural sequencing of research.
- Slicer remains *honest about its scope* — opaque-sink
  annotations make the language boundary visible.

Negative:

- "Ambos fail" 40-task failures that involve cross-language calls
  (e.g., a TS file calling a Python tool) cannot be closed by
  Phase 7.1. We expect this to be a small subset empírico
  verifiable because the benchmark is PolyBench-TS, but we will
  measure and disclose.
- Phase 7.2 and 7.3 wall-clock estimates depend on Reto 9 progress
  — they are deferred, not scheduled.

## Honest Disclosure

- We cannot guarantee Phase 7.1 will close all 40 "ambos fail"
  tasks even within TS scope. Many of those failures are likely
  dispatch-related (decorators, DI containers) where ADR-001's
  static conservative approach will produce a large slice rather
  than a precise one. ADR-005 will address how NREKI uses an
  over-approximated slice.
- If Reto 9 stalls, Phases 7.2 and 7.3 stall with it. This is a
  deliberate dependency, not a hidden risk.

## Verification (Phase 7.1 exit criteria for this ADR)

- [ ] Slicer accepts only `.ts` / `.tsx` / `.js` / `.jsx` inputs
      and refuses other extensions with a structured error empírico
      verifiable.
- [ ] Cross-language call sites (calls into non-TS modules via
      child-process, dynamic import of non-TS, FFI) are emitted as
      `OpaqueSink` provenance nodes in the slice output empírico
      verifiable.
- [ ] Documentation explicitly states the TS-only scope and the
      Phase 7.2/7.3 gating on Reto 9 — visible in README or module
      JSDoc empírico verifiable.
