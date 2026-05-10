# NREKI Technical Debt Ledger

Registro formal de deuda técnica conocida y diferida. Cada entrada incluye:
ubicación, descripción, sprint que la registró, sprint donde se planifica
remediar.

---

## Testing / Mocks (Deferred for post-v10.19.0 Corpus)

- **Files**: `tests/router.test.ts`, `tests/backward-compat.test.ts`
- **Issue**: `mockEngine` utiliza escape de tipos (`as any`) para evitar
  implementar la interface completa de `NrekiEngine` (~30 métodos públicos).
- **Cause**: limitación de inferencia de tipos en `vi.fn()` de Vitest cuando
  se mockean interfaces complejas.
- **Risk**: si `NrekiEngine` evoluciona, los mocks no detectan el desfase
  en compile-time.
- **Remediation**: extraer factory type-safe (ej. `tests/helpers/mock-engine.ts`)
  con cobertura completa de la interface, importando tipos auxiliares
  (`RepoMap`, `DependencyGraph`, `ChunkRecord`, `FastGrepHit`, `SessionReport`,
  `IndexStats`, `ParseResult`).
- **Registered**: sprint v10.18.1
- **Planned remediation**: sprint dedicado post-v10.19.0 (Corpus Baseline)
- **Estimated effort**: 5-6 commits

---

## VFS Absolute Path Reliance (Deferred for post-v10.19.0 Corpus)

The kernel, persistence layer, and undo system all rely on strict string
equality of absolute filesystem paths as keys. This design choice manifests
as two related symptoms that share the same architectural root cause and
must be remediated together in a unified VFS canonicalization refactor.

- **Files**: `src/database.ts` (chunks/files/engrams tables), `src/undo.ts`
  (backups directory keys), `src/kernel/nreki-kernel.ts` (VFS keys, ~30 sites),
  `src/utils/to-posix.ts` (path normalization callsite)

### Symptom A: Path Stale γ

- **Issue**: SQLite stores absolute filesystem paths in `chunks`, `files`,
  and `engrams` tables. The `.nreki/backups/` directory uses base64url hashes
  derived from absolute paths. If a user moves the project folder to a
  different directory (or restores it on another machine with a different
  drive layout), all persisted paths become stale references and the index
  is effectively orphaned.
- **Risk**: cache miss + full reindex on project move. Backup recovery
  fails silently for renamed directories. Critical only if v10.19.x corpus
  begins using variable clone paths (current v10.19.0 plan uses fixed paths
  under `D:\Nreki\corpus\<repo>\`, mitigating immediate exposure).

### Symptom B: Drive Letter Asymmetry (Windows)

- **Issue**: On Windows, `path.resolve()` and related Node APIs may return
  drive letters in either case (`C:\` vs `c:\`) depending on how paths
  enter the system (terminal CWD, IDE plugin args, MCP client URIs).
  Because the kernel uses raw POSIX path strings as Set keys
  (`currentEditTargets`, `prunedTsLookup`, `jitClassifiedCache`), inputs
  that differ only in drive letter casing are treated as distinct entries,
  duplicating chunks and breaking VFS lookups.
- **Discovery**: empirically confirmed during sprint v10.18.1 / Commit #4.
  An attempt to canonicalize drive letters in `toPosix()` at the utility
  layer caused `tests/jit-holography.test.ts` Tests 9 and 15 to fail
  (regression confirmed via stash + isolated test run on clean HEAD).
  The fix was reverted in the same commit (signed Furia: retirada táctica).
  A characterization test in `tests/to-posix.test.ts` documents the current
  preserved-casing behavior and will fail intentionally when canonicalization
  lands.
- **Risk**: SQLite primary key duplication if two NREKI processes write
  paths with different drive letter casing concurrently. JIT cache misses
  when agents pass paths with different casing than the kernel produced.

### Shared Root Cause

Design choice that prioritized POSIX absolute paths as VFS keys for the
kernel and LSP sidecar communication (which require `file:///` URIs).
The persistence layer inherited this assumption. Canonicalization at the
utility boundary (`toPosix`) is insufficient because it desynchronizes
producer and consumer code paths in the kernel; the fix must be applied
uniformly across all VFS entry points.

### Remediation Plan (Unified)

- Refactor persistence layer to store paths relative to `projectRoot` in
  SQLite. Engine reconstructs absolutes at runtime via
  `path.join(projectRoot, path_relative)`. Add `path_relative` column to
  `chunks` table via ALTER TABLE migration.
- Update `undo.ts` to hash relative paths (eliminates Path Stale γ).
- Introduce a canonical path canonicalizer used by ALL VFS entry points
  in `nreki-kernel.ts` (~30 sites). The canonicalizer enforces lowercase
  drive letter on Windows and consistent slash direction (eliminates
  Drive Letter Asymmetry).
- Translate paths at I/O boundaries (kernel VFS, LSP URIs) rather than
  in storage.
- Replace `tests/to-posix.test.ts` characterization tests with assertions
  on the new canonical contract.

- **Registered**: sprint v10.18.1 (Commit #4)
- **Planned remediation**: sprint dedicado post-v10.19.0 (Corpus Baseline)
- **Estimated effort**: 8-12 turnos (blast radius incluye 30+ sitios en
  `nreki-kernel.ts`, 7+ queries SQL en `database.ts`, sistema de undo,
  utility canonicalizer, y suite de tests específica para transición
  de paths absolutos/relativos y casing)

---

## Char-walker State Machine Duplication (Sub-sprint 2.3 audit)

- **Files**: `src/utils/type-extractor.ts:120-252` (`splitSignatureIO`),
  `src/repo-map.ts:86-161` (`extractSignature`)
- **Issue**: dos walkers character-by-character con tracking similar
  (`parenDepth`, `angleDepth`, `inString`, escape handling). Overlap
  estimado ~50 LOC de "skip strings, count depth" duplicado entre
  ambos. Cada uno tiene una vuelta extra propia (`splitSignatureIO`
  trackea modes before/params/return; `extractSignature` trackea
  template-literal expressions con `braceDepthInTemplate`).
- **Cause**: ambos resolvieron problemas similares (leer hasta cierto
  marcador respetando string/depth state) en sprints distintos sin
  un módulo compartido de "source-aware char walker".
- **Risk**: bajo. Ambos walkers funcionan correctamente. Drift futuro:
  si uno corrige un edge case (ej. soporte JSX, BigInt literals),
  el otro queda atrás silenciosamente. Sin reproducer empírico de bug
  actual.
- **Remediation**: extraer helper `walkSourceAwareChars(text, options)`
  en `src/utils/source-walker.ts` con state delegado. Migrar ambos
  callsites. Mantener tests existentes verdes (regression safety).
- **Registered**: Sub-sprint 2.3 (Sub-sprint 2.3 audit, this commit)
- **Planned remediation**: P2 sprint dedicado post-Phase 4 (Markov
  Blanket compression) o post-Phase 5 (SWE-bench TS). NO bloquea
  Phase 3+.
- **Estimated effort**: 3-5 turnos (helper + 2 callsite migrations +
  edge case tests)

---

## Sub-sprint 2.3 — Evidence-based ACID + carry-forward audit (RESOLVED)

Sub-sprint 2.3 sanó el ledger de carry-forwards míticos propagados
en commit messages durante v10.20.0 + v11.0.0 sin verificación
empírica. Auditor terminal aceptó latigazo #43 por carry-forward sin
reproducer documentado.

### Evidence ACID end-to-end (PASO 1)

`tests/acid-end-to-end.test.ts` (7 tests, 100% verde):
- Happy path: backup creado + atomic POSIX rename + tmp cleanup
- Multi-file batch: ambos commits atómicos, ambos backups creados
- Symbol-not-found rollback: file_a y file_b unchanged (transaction abort)
- Invalid-syntax rollback: idem
- Cross-patch corruption pre-check (ACID violation detection)
- Cross-patch valid (acepta cuando search_text en ORIGINAL)
- dryRun bypass (no disk write, no backup creation)

ACID PHASE 1 PREPARE + PHASE 2 COMMIT + PHASE 3 ROLLBACK
empíricamente verificado en `src/semantic-edit.ts:713-774`.

### Audit carry-forwards (PASO 2)

| Carry-forward | Status | Evidence |
|---|---|---|
| toxin-1 batch_edit write-shadow | **MÍTICO — REMOVED** | `tests/acid-end-to-end.test.ts` 7/7 verde. Sin reproducer en sprint history. Commit-message-only debt. |
| cross-sprint coordination protocol | **MÍTICO — REMOVED** | `grep cross-sprint\|coordination` en src/, .nreki/, TECH_DEBT.md, README.md, AGENTS.md → 0 matches. |
| daemon shutdown leak (toxin-3) | **RESOLVED — REMOVED** | v11.0.0 ONNX amputation (commit `9e5d9de`) eliminó el bottleneck. Commit `32b4fc3 fix(shutdown): close zombie via parent watchdog + signal handlers` cubrió el caso restante. `src/index.ts:735-810` documenta SIGINT/SIGTERM/SIGHUP + stdin close + parent watchdog con EPERM/EACCES non-letal handling. |
| Unify type-extractor.ts ↔ repo-map.ts state machines | **REAL EVIDENCE → MIGRATED** | Ver sección "Char-walker State Machine Duplication" arriba. Migrado a P2 deferred refactor con scope documentado. |

### Lecciones metodológicas

- Carry-forward de TECH_DEBT en commit messages SIN migración al
  ledger canónico (`TECH_DEBT.md`) genera deuda "viva" no auditable.
- Política recalibrada Sub-sprint 2.3: cualquier P0 nuevo debe
  registrarse en `TECH_DEBT.md` con file:line + reproducer en el
  commit que lo introduce. Si no hay reproducer, no es P0.
- Latigazo #43 ratificado: carry-forward sin verification empírica
  durante 7 commits del sprint (ea7a7ce → 75781f1 → C.1/C.2/C.3)
  inflaba la sensación de tech debt sin evidence.

- **Registered**: Sub-sprint 2.3 (this commit)
- **Resolution**: Audit + cleanup empírico aplicado. Carry-forwards
  míticos eliminados, carry-forward real migrado a P2 deferred
  refactor con scope.

---

## Phase 5 SWE-bench TS Validation — Spec firmada (Furia rounds 10+11)

**Status:** Designed, frozen, deferred to post-Phase 4 sealed.

### Sequencing

Phase 4 (Markov Blanket Compression) PRIMERO. Phase 5 después.
Razón: Phase 5 mide producto, NREKI sin Phase 4 mide producto
incompleto. Resultados pre-Phase 4 obsoletos al sealing Phase 4.

### Paradigma

Δ — Token Cost to Recall (Furia round 10 dominant metric).

- Métrica primaria: median tokens_to_recall@K per task
- Métricas secundarias: Recall@K + Precision@K + MRR + nDCG@K
- USP defendido: "less tokens to reach correct context"

### Dataset

Repos vírgenes post-training-cutoff, stratified por escala:

- Small library (<5K LOC): date-fns, ts-pattern
- Medium framework (5K-50K): trpc, next-auth
- Large framework (>50K): typescript, nest.js

Verificación obligatoria: repos POST-Claude knowledge cutoff
documentado per modelo evaluador.

### Task Count

N=100-150 committed upfront. NO MVP-then-expand (early-stopping
bias / p-hacking proxy). Statistical significance ±8-10% CI 95%.

### Baselines

Internal validation:

- ripgrep
- BM25

Pre-paper submission obligatorio:

- Dense retrieval (voyage-code-3 o BGE-large via API, $10-50 budget)
- Aider repo-map (open-source comparable)
- Cursor/Copilot/Cody como Limitations section explícito
  (closed-source, no fair benchmark possible)

### Ablation Study Completa

- (a) NREKI search alone
- (b) NREKI fast_grep alone
- (c) NREKI type_graph alone (post-Phase 4)
- (d) NREKI search + type_graph combined
- (e) NREKI all-in
- (f) ripgrep
- (g) BM25
- (h) Dense retrieval (pre-paper)

### Curation

Scripted (filter PRs by labels: bug, regression, fix) +
INDEPENDENT reviewer (NO auditor self-review). Criteria
declarados upfront en commit + frozen randomness seed +
reproducible script.

### Edge Cases Obligatorios (UNION rounds 10+11)

**Round 11 (rigor experimental):**

1. **Time-Travel Data Leakage Guard:** Eval script DEBE hacer
   `git checkout HEAD~1` (commit anterior al fix del PR) ANTES
   de indexar el Type Ledger. Si indexa en master, grafo ya
   tiene la solución inyectada → resultados inválidos.

2. **Chunk-Level Mapping vs File-Level:** SWE-bench tradicional
   mide file-level. NREKI es chunk-level (start_line/end_line).
   Reportar AMBOS niveles separados. Si NREKI devuelve archivo
   correcto pero apunta función equivocada, file-level=match
   pero NREKI-level=fail.

3. **TokenCost@K obligatorio:** Recall sin cost es inútil. Si
   BM25 logra 80% Recall con 60K tokens y NREKI 85% con 4K
   tokens, esa compresión 93% es el descubrimiento real.

**Round 10 (rigor metodológico):**

4. **Ground truth 3-niveles reportados separadamente:**
   - (a) src-only strict
   - (b) src + tests permissive
   - (c) all-patch maximal

   Reportar los TRES — no esconder elección en footnote.

5. **Issue text quality stratification:**
   - High (10%): stack trace + repro code + expected/actual
   - Medium (40%): narrative + reference
   - Low (50%): "fix #1234" oneliner

   Reportar stratified per quality tier.

6. **Static + Multi-turn modes ambos:**
   - Static: single query → single response
   - Multi-turn: 3 queries permitidas (representativo de
     deployment real Cursor/Copilot)

   Reportar ambos modos.

7. **Training data leakage check:** Repos POST knowledge cutoff
   del modelo evaluador. Documentación obligatoria del cutoff.

8. **Missing baselines disclosure:** Cursor/Copilot/Cody en
   Limitations section explícito + Aider repo-map incluido
   (open-source). Sin esto, paper sufre "missing baseline"
   critical objection.

### Fail-mode

Strict binary Recall@K + MRR + Precision@K + nDCG@K reportados
paralelos para triangulación honesta del lector.

### Framing

Section 4 Empirical Evaluation de paper larger
("NREKI: Topology-Aware Context Delivery for Coding Agents"
o similar). NO standalone paper.

### Estimación scope

- Dataset curation: 4-8h manual + ~150 LOC scripts
- Eval pipeline: ~900-1100 LOC + 12-15 unit tests
- Baselines: ~200-400 LOC
- Analysis + report: ~100 LOC + manual write-up
- **Total**: 1300-1700 LOC + 100-150 tasks, 4-8 sesiones (~12-25h)

### Decisión Furia rounds 10+11

Latigazos producidos:

- Auditor #45: aceptar Phase 4/5 como intercambiables sin
  precedence arquitectónica
- Auditor #46: dense retrieval baseline exclusion = fraude
  metodológico (engineering decision interna ≠ scientific
  decision evaluativa)
- Auditor #47 (round 10): Paradigma A vs B framing missear USP
  real (token cost)
- Pipipi Code #47 (round 11): proponer Opción I (corpus/zod,
  astro, prisma) = data leakage / overfitting con Sub-sprint
  2.2.2.x tuning data

Furia 11/11 rounds adversariales ratificados.

- **Registered**: Sub-sprint 2.3 follow-up (Phase 5 spec persistence,
  this commit)
- **Planned execution**: post-Phase 4 sealed
- **Estimated effort**: 12-25h ejecución en 4-8 sesiones

---
