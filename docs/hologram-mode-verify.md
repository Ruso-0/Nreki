# Hologram Mode Differential-Filter Verification

**Sprint:** v11.4.0 Phase 1.5 (post-self-audit finding D)
**Question:** Does the differential pre-existing-error filter hold in **hologram** mode (production MCP runtime), or does the per-transaction `captureBaseline(filesToEvaluate, mode)` scoping introduce a leak that the project-mode tests in v11.4.0 missed?

**Method:** Reproduce the user's *exact* reported TS codes (TS1259 + TS2802) in JIT hologram mode and call `interceptAtomicBatch` directly. No mocks. Empirical PASS/FAIL.

**Result:** **PASS in all 4 cases.** No scoping bug. No kernel change required.

---

## 1. Why this round was needed

`docs/v11.4.0-self-exploration.md` Finding D flagged that:
1. The MCP server's default mode is `hologram` (`detectMode(cwd)` in [src/index.ts:308](../src/index.ts#L308)).
2. The v11.4.0 Phase 1 tests in `tests/kernel-pre-existing-errors.test.ts` use `kernel.boot(dir)` with no explicit mode, defaulting to **project**.
3. In hologram mode, `captureBaseline(filesToEvaluate, mode)` is called **per transaction with a scoped file set** ([src/kernel/nreki-kernel.ts:592](../src/kernel/nreki-kernel.ts#L592)) instead of once at boot ([src/kernel/nreki-kernel.ts:398](../src/kernel/nreki-kernel.ts#L398)).
4. If `filesToEvaluate` excludes a file that the post-edit cascade then visits, its pre-existing errors could leak through as "new."

Finding D also noted the v11.4.0 release notes claim the Phase 1 tests "pin the user's exact scenario" with codes **TS1259/TS2802** — but the actual test only triggers **TS1192** (different code). The differential filter is fingerprint-based and code-agnostic *by design*, but "by design" is not the same as "verified."

This document closes both gaps empirically.

---

## 2. TS code reproduction recipes (empirically verified)

Captured via a one-shot TypeScript Compiler API probe before writing the tests:

| Code   | tsconfig requirements | Source pattern |
|--------|-----------------------|----------------|
| TS1259 | `esModuleInterop: true`, `allowSyntheticDefaultImports: false` | `import lib from "./lib"` where `lib.ts` uses `export = { ... }` |
| TS2802 | `target: "ES5"`, `downlevelIteration: false`, `lib: ["ES2015"]` | `for (const x of new Set([...])) { ... }` (any non-array iterable) |

Both recipes are encoded into [tests/kernel-pre-existing-errors-hologram.test.ts](../tests/kernel-pre-existing-errors-hologram.test.ts).

---

## 3. Test design

Hologram-mode boot follows [src/handlers/code/kernel-bridge.ts:ensureHologramReady](../src/handlers/code/kernel-bridge.ts#L16) JIT path:

```ts
const kernel = new NrekiKernel();
kernel.setJitParser(parser, tsLanguage);
kernel.setJitClassifier(classifyAndGenerateShadow);
kernel.boot(dir, "hologram");
```

Boot log confirms JIT path active: `JIT Holography active. rootNames: 0 (.d.ts only). Shadows on-demand.` and `Baseline: 0 invariants. Boot errors: 0` — i.e. **the baseline is empty at boot**, exactly the scenario Finding D warned about.

Four cases:

1. **Pre-existing TS1259 + unrelated-symbol edit.** The file imports a CommonJS-exporting module without sythetic defaults. We edit `targetForEdit()` (different symbol). Expectation: `safe=true`.
2. **Pre-existing TS2802 + unrelated-symbol edit.** The file iterates a Set with `target: ES5` and `downlevelIteration: false`. We edit `targetForEdit()`. Expectation: `safe=true`.
3. **JIT-specific case.** Target file is not in `rootNames` at boot (JIT mode keeps only `.d.ts`). `interceptAtomicBatch` adds it to `rootNames` at line ~554 *before* `captureBaseline` runs at line ~592. We pin that ordering: a fresh JIT entry with disk-side pre-existing TS1259 must still be filtered. Expectation: `safe=true`.
4. **Counter-test.** Edit introduces a new TS2322 on top of pre-existing TS1259. Expectation: `safe=false`, and the structured error list must contain `TS2322` (not `TS1259`).

---

## 4. Empirical result

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  8.13s
```

- Cases 1, 2, 3 → `result.safe === true` ✓
- Case 4 → `result.safe === false`, `exitCode === 2`, `result.structured` contained `TS2322` ✓
- No `console.error` lines fired (the diagnostic dump branches were never taken).

**Conclusion:** The differential filter in hologram mode correctly suppresses pre-existing TS1259 and TS2802, including the JIT-specific subcase where the target file enters `rootNames` only at edit time. The per-transaction `captureBaseline(filesToEvaluate, mode)` ordering captures pre-existing errors *before* the VFS injection, so they sit in the baseline and `count > baseline` filters them out exactly as in project mode.

---

## 5. What this means for the user's report

The original user report (2026-05-19, `fillTemplate.ts` with TS1259/TS2802 → unrelated edit → kernel rollback) is **not reproducible against v11.4.0 source** in either project or hologram mode. The combined evidence:

- The differential check has been in `src/kernel/backends/ts-compiler-wrapper.ts:611` since at least v11.3.x (confirmed earlier this session).
- The 4 hologram-mode tests here include the *exact* TS codes the user reported.
- The 4 project-mode tests in v11.4.0 cover same-file pre-existing TS2322 + the TS1192-family case.

The most likely explanation remains: the failing MCP call ran against the globally installed `@ruso-0/nreki@10.19.0` (the binary that was active when the report was filed — confirmed earlier in this session from `C:\Users\jhers\AppData\Roaming\npm\node_modules\@ruso-0\nreki\package.json`). The fix shipped in an earlier release; v11.4.0 closes the test-coverage gap.

If the user is still seeing this against v11.4.0, the next step is to capture the actual MCP request + response payload — not to add more speculative kernel changes.

---

## 6. Residual gap (honestly disclosed)

These tests verify the **kernel** path. They do **not** exercise the full MCP-tool path (`batch_edit` → `semantic-edit.ts` → `interceptAtomicBatch`). If there is a regression somewhere between the MCP tool entry point and `interceptAtomicBatch`, these tests will not catch it. That is a candidate for a future iteration — for now, the unit-level coverage in v11.4.0 is sufficient to discharge Finding D from the self-exploration.
