# Milestone 0 — Proof of Concept Design

Status: **Phase 0 — Sprint Initial output, design only (no implementation)**
Date: 2026-05-16
Derived from: ADR-001..005, `phase-7-1-scope.md`

---

## Purpose

Smallest possible empirical proof that the ADR-001..005 chain is
buildable on the existing NREKI infrastructure. Milestone 0 is
*not* a feature; it is an architectural risk check. If Milestone 0
fails, we revise the ADRs before committing to Phase 7.1 scope.

## Milestone 0 Exit Criterion

A single test file —
`tests/causal-slicer/poc-callback-chain.test.ts` — passes empírico
verifiable. The test exercises the full happy path: parse a
synthetic TypeScript file containing a callback chain, build a PDG
for one function, compute a backward slice, project to statements,
render via `ts.printNode`, and assert that the rendered set matches
the hand-curated expected set.

No SDG, no inter-procedural, no dynamic dispatch, no MCP tool, no
performance gates. Just: *can we close the loop on the absolute
smallest case?*

## Test File Specimen (synthetic input)

```ts
// poc-input.ts
declare const database: {
  query(sql: string, cb: (rows: Row[]) => void): void;
};
declare const logger: { info(msg: string): void };

interface Row { id: string; name: string }
interface User { id: string; name: string }

function transformUser(row: Row): User {
  return { id: row.id, name: row.name.trim() };
}

function fetchUser(id: string, callback: (user: User) => void): void {
  database.query(
    `SELECT * FROM users WHERE id = '${id}'`,
    (rows) => {
      const first = rows[0];
      callback(transformUser(first));
    }
  );
}

fetchUser("123", (user) => {
  logger.info(`Got user: ${user.name}`);  // <-- slicing criterion
});
```

## Slicing Criterion

`<file = "poc-input.ts", line = 22, variable = "user">`

Asking: *backward slice — what statements affect the value of
`user` at the `logger.info` line?*

## Expected Statement Set (hand-curated)

1. The top-level `fetchUser("123", (user) => { ... })` call site
   (the criterion's enclosing call introduces `user`).
2. Inside `fetchUser`, the `database.query(..., (rows) => {...})`
   call (the callback-passing site that eventually invokes the
   user-bound callback).
3. The inner callback body: `const first = rows[0]; callback(transformUser(first));`
   — both statements, because `callback` is the same identity as
   the top-level lambda's `user` parameter.
4. The `transformUser` function body: `return { id: row.id, name: row.name.trim() };`
   — because `transformUser(first)`'s return value flows into
   `callback`, which binds `user`.

*Expected NOT in slice:* the string-literal SQL query construction
(does not affect the returned `user` value; affects only the rows
selected, which Milestone 0 treats as opaque database state).

## Implementation Outline (design only, no code yet)

```text
1. tests/causal-slicer/poc-callback-chain.test.ts
   - imports the PoC slicer (a single-file flat implementation,
     not yet the full ADR-005 module structure).
   - reads `tests/causal-slicer/fixtures/poc-input.ts`.
   - calls `pocBackwardSlice(file, line=22, variable="user")`.
   - asserts the returned statement set equals the expected set
     above, by source-text comparison.

2. src/causal-slicer/poc-prototype.ts  (single file, throwaway,
   replaced by full ADR-005 structure in Phase 7.1 proper)
   - createProgram on the single file
   - getTypeChecker
   - find the criterion statement via ts.getLineAndCharacterOfPosition
   - build a minimal PDG by:
       * walking the AST
       * for each Identifier, recording its definition site via
         checker.getSymbolAtLocation + symbol.declarations
       * recording control-flow dependence via enclosing
         IfStatement / WhileStatement / ForStatement
   - backward marking: BFS from the criterion, following the
     "depends-on" edges
   - project marked expressions to enclosing statements
   - return statements as ts.Node[]

3. Acceptance: test passes empírico verifiable, runs in under 5 s,
   and does not require any production code in src/ outside
   src/causal-slicer/poc-prototype.ts.
```

## What Milestone 0 Specifically Tests

| Architectural claim                                           | Tested? |
|---------------------------------------------------------------|---------|
| TS Compiler API exposes enough semantics for PDG construction | YES     |
| Statement-level projection round-trips via ts.printNode       | YES     |
| Callback parameter binding can be traced via checker symbols  | YES     |
| ADR-005 standalone-module pattern is buildable                | YES     |
| Inter-procedural slicing across function boundaries works     | YES (single hop) |

## What Milestone 0 Does NOT Test

| Capability                                  | Reason for deferral       |
|---------------------------------------------|---------------------------|
| Full SDG (multi-file)                       | Phase 7.1 proper          |
| Decorator / DI dispatch                      | Phase 7.1 proper          |
| Forward slicing                              | Phase 7.1 proper          |
| Evidence-chain composition                   | Phase 7.1 proper          |
| MCP tool registration                        | Phase 7.1 proper          |
| Performance at 10 kLoC                       | Phase 7.1 proper          |
| Cross-language opaque sinks                  | Phase 7.1 proper          |
| Async / Promise chains                       | Phase 7.1 proper          |

## PoC Failure Modes (and what each tells us)

| If this fails…                              | …revise…                            |
|---------------------------------------------|-------------------------------------|
| TS Compiler API cannot resolve callback parameter binding | ADR-001 (need stronger semantic frontend, possibly headless tsserver) |
| ts.printNode output not byte-identical to source | ADR-002 (statement-level rendering needs source-range slicing, not AST printing) |
| BFS over expression-level PDG explodes on 30-LoC PoC | ADR-002 (re-evaluate granularity; PDG construction may need pruning heuristics earlier) |
| Cannot map `fetchUser` callback parameter to the outer lambda's `user` binding via symbol resolution alone | ADR-001 (callback parameter binding requires data-flow analysis beyond what `getSymbolAtLocation` gives; consider hybrid hook earlier) |
| Test takes > 60 s for 30 LoC                | Reto 8 viability question — escalate to Pipipi Furia for re-evaluation |

## Estimated Effort

- **PoC implementation (single-file prototype):** 3-5 days.
- **PoC test + fixtures + hand-curated expected set:** 1-2 days.
- **Total Milestone 0:** 1 week of focused work.

Milestone 0 is the *first* deliverable of Phase 7.1, not Phase 0.
Phase 0 (this sprint) ships only the design.
