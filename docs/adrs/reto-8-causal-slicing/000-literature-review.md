# Reto 8 — Causal Program Slicing: Literature Review

Status: **Phase 0 — Initial (Sprint Initial)**
Date: 2026-05-16
Branch: master (post v11.0.0)
Author: Pipipi Code (autonomous mode) + Claude Auditor

---

## Purpose

Ground Reto 8 architectural decisions in empirical prior art so that
ADR-001 through ADR-005 are choices over the actual SOTA, not over a
naive textbook approach. Identify the TypeScript slicing gap that
justifies the Phase 7.1 scope.

---

## Foundational Era (1981 – 2005)

1. **Weiser 1981 — "Program Slicing"** (ICSE '81 / IEEE TSE '84).
   Defines the canonical backward slice as the smallest executable
   subprogram whose execution at a given point reproduces the values
   of a chosen set of variables. Establishes the slicing criterion
   `<statement, variable>`. All later work descends from this.

2. **Tip 1995 — "A Survey of Program Slicing Techniques"**
   (J. Programming Languages 3, 121-189). Canonical taxonomy: static
   vs dynamic, backward vs forward, executable vs closure slices,
   intra- vs inter-procedural. Introduces the Program Dependence
   Graph (PDG) and the System Dependence Graph (SDG) as the unifying
   representations.

3. **Horwitz, Reps & Binkley 1990 — "Interprocedural slicing using
   dependence graphs"** (TOPLAS 12). Establishes the SDG plus
   two-pass marking algorithm that the entire Java toolchain (WALA,
   Joana, Slicer4J, JavaSlicer) still implements.

4. **Binkley & Gallagher 1996 — "Program slicing"** (Advances in
   Computers 43). Synthesises practical slicing into engineering
   recipes: pointer aliasing, calling-context sensitivity, slice
   size vs precision trade-offs.

5. **Krinke 2003 — "Advanced slicing of sequential and concurrent
   programs"** (PhD, U Passau). Extends SDG to concurrency,
   monitors, threads, message passing. Directly relevant to Reto 8
   because async/await + event loops are a degenerate concurrency
   model.

## Object-Oriented & Dynamic Era (2005 – 2018)

6. **Galindo, Pérez & Silva 2018 — "Dynamic slicing of
   object-oriented programs"** (J. Systems & Software 142). Recent
   formal treatment of dynamic slicing for OO programs, with
   polymorphism and dynamic dispatch resolved at trace time.
   Engineering directly applicable to TypeScript class hierarchies
   and decorator-injected dispatch.

7. **Hammacher et al. 2009 — "Profiling Java programs for
   parallelism"** (ICSE). Demonstrates instrumentation overhead
   profile for dynamic dependence tracking on real Java programs —
   the empirical evidence that dynamic slicing is feasible at
   millions of events per second with selective instrumentation.

## Modern Tooling Era (2015 – 2023)

8. **WALA Slicer** (IBM Research, maintained on GitHub
   `wala/WALA`). The canonical industrial-strength SDG +
   slicer for Java bytecode. **Has a JavaScript frontend
   but the slicer module remains Java/bytecode-targeted**
   — TypeScript/JavaScript slicing in WALA is research-only,
   not a supported product. Confirmed via `wala/WALA/wiki/Slicer`.

9. **Joana** (KIT, IPD Snelting). SDG-based information-flow
   control for Java, built on WALA. Demonstrates that SDG +
   slicing scales to security-grade precision but only for Java.

10. **DG — Charles University, Marek Chalupa** (`mchalupa/dg`).
    LLVM-bitcode static slicer. Has been used to slice C/C++ via
    LLVM IR. Empirical evidence that a single IR layer can
    multiplex many source languages.

11. **Slicer4J** (`resess/Slicer4J`). Dynamic slicer for Java with
    low overhead, 2021. Modern engineering baseline for dynamic
    slicing economics.

12. **JavaSlicer (mistupv)**, **SliceJS (saltlab)** and **JSSlicer**
    (Salt Lake research lab). The JavaScript-side prior art.
    SliceJS uses *selective code instrumentation* + dynamic
    backward slicing — directly informs Reto 8 ADR-001. None of
    these tools target TypeScript types or modern async/promise
    semantics natively.

## Learning-Based / LLM Era (2024 – 2025)

13. **Yadavally et al. 2024 — "A Learning-Based Approach to Static
    Program Slicing" (NS-Slicer, OOPSLA '24,
    dl.acm.org/doi/10.1145/3649814).** Neural-network-based static
    slicing of Java. Reports F1 94.66 % – 96.62 % overall on partial
    code (5/10/15 % omitted), exact-match 73-83 %. *Targets Java
    only; TypeScript not covered.* Empirical gap remains.

14. **Yadavally et al. 2024 — "Predictive Program Slicing via
    Execution Knowledge-Guided Dynamic Dependence Learning"
    (FSE '24, dl.acm.org/doi/10.1145/3643739).** Uses CodeExecutor
    as the encoder; predicts dynamic slices without running the
    code. Java only.

15. **"Program Slicing in the Era of Large Language Models"**
    (arxiv 2409.12369, 2024). Evaluates GPT-4o on 100 LeetCode
    Java programs. Static slice accuracy 60.84 %, dynamic 59.69 %.
    *Conclusion: LLMs alone are not yet a viable slicer.* Complex
    control flow is the dominant failure mode. Java only.

16. **SLICET5** (arxiv 2509.17338, Sep 2025). T5-based static
    slicing. Java focus. Confirms learning-based slicing is the
    active research frontier in 2025.

## Empirical Findings That Shape Reto 8

**Finding A — TypeScript slicing gap.** No published SOTA slicer
targets TypeScript natively. WALA's JavaScript frontend is the
closest, and it does not ship a slicer. SliceJS targets ES5 JS via
instrumentation. *Reto 8 is therefore a genuine research
contribution candidate, not a re-implementation of prior art.*

**Finding B — Learning-based slicing is rising but unsolved.**
NS-Slicer reaches 94-96 % F1 on Java, but the LLM-only baseline
sits at ~60 %. This means a purely-LLM approach is *empirically
insufficient* (ref. paper 15). NREKI must keep a symbolic spine
and only use LLM signals as an auxiliary, if at all.

**Finding C — Hybrid static + selective dynamic instrumentation is
the empirical sweet spot for dynamic-flow languages.** SliceJS
demonstrates this for JavaScript; Slicer4J demonstrates it for
Java. The "static skeleton + targeted instrumentation" pattern is
the engineering default Reto 8 should inherit.

**Finding D — SDG is still the right intermediate representation.**
Every production-grade slicer since 1990 (WALA, Joana, Slicer4J,
JavaSlicer, DG) builds on or extends an SDG. Reto 8 should build a
TypeScript SDG, not invent a new structure.

**Finding E — Async/event-loop semantics need explicit modeling.**
Krinke (2003) for concurrency and Sotiropoulos et al. (arxiv
1901.03575, "Static Analysis for Asynchronous JavaScript Programs")
both show that callback-graph representations of the event loop are
required to get sound slices through `await`, `.then`, and
event-emitter `.on(...)`.

## Honest Disclosures From Literature Review

1. **No invalidating prior art found.** A native TypeScript SDG +
   slicer at production scale does not appear to exist in
   peer-reviewed literature or in maintained open-source tooling as
   of 2025-09.
2. **Reto 8 is not first-mover on the *idea* of slicing.** The
   field is 45 years old, the theory is mature, and the engineering
   gap is the implementation cost for the TS/async/framework
   combination, not the algorithm.
3. **Learning-based slicing already exists for Java.** If Reto 8
   wants to compete on slice quality (not just feasibility), it
   will eventually have to compare against NS-Slicer-style learning
   approaches on a comparable TS benchmark — none of which exists
   today.
4. **The "ambos fail" 40-task subset is not a slicing benchmark.**
   It is a retrieval benchmark. Reto 8 will need a *separate*
   slice-quality benchmark beyond it; or, alternatively, demonstrate
   that injecting slice evidence into the NREKI hybrid retrieval
   loop reduces "ambos fail" count empírico verifiable. The latter
   is the only metric that aligns Reto 8 with the rest of the
   NREKI thesis.

---

## Recommended Reading Path (Prioritised)

1. Weiser 1981 — read in full (canonical).
2. Tip 1995 — skim taxonomy + PDG/SDG sections.
3. Horwitz, Reps & Binkley 1990 — read SDG construction sections.
4. WALA Slicer wiki — read in full (engineering reality check).
5. SliceJS paper + repo — empirical TS/JS adjacent baseline.
6. NS-Slicer paper — modern learning-based comparison point.
7. Krinke 2003 chapter on concurrency — for async modeling.

---

## Sources Catalogued

| # | Citation                                              | Year |
|---|-------------------------------------------------------|------|
| 1 | Weiser, "Program Slicing"                             | 1981 |
| 2 | Tip, "Survey of Program Slicing Techniques"           | 1995 |
| 3 | Horwitz/Reps/Binkley, "Interprocedural slicing"       | 1990 |
| 4 | Binkley/Gallagher, "Program slicing"                  | 1996 |
| 5 | Krinke, "Advanced slicing of sequential and concurrent programs" | 2003 |
| 6 | Galindo/Pérez/Silva, "Dynamic slicing of OO programs" | 2018 |
| 7 | Hammacher et al., "Profiling Java for parallelism"    | 2009 |
| 8 | WALA Slicer (wiki + javadoc)                          | 2024 |
| 9 | Joana (KIT Snelting)                                  | 2024 |
| 10| DG (Chalupa, LLVM)                                    | 2024 |
| 11| Slicer4J                                              | 2021 |
| 12| SliceJS / JSSlicer / JavaSlicer                       | 2013-2024 |
| 13| NS-Slicer (Yadavally, OOPSLA)                         | 2024 |
| 14| Predictive Slicing (Yadavally, FSE)                   | 2024 |
| 15| "Program Slicing in the Era of LLMs" (arxiv 2409.12369) | 2024 |
| 16| SLICET5 (arxiv 2509.17338)                            | 2025 |

