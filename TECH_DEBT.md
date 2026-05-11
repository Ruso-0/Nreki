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

## Phase 5 SWE-Bench-TS-Lite — Spec firmada UNION rounds 10+11+13

**Status:** Designed, frozen, ready for execution post-Phase 4 sealed
(Phase 4 SEALED commit f6bf2ee).

**Updated:** Round 13 rectificado tras latigazo capa 8 a Furia
(context buffer collapse). Updates clave:

- Multi-turn mode CORRECTED: mock template REJECTED como academic
  fraud, solo Anthropic API real (β) o skip+Limitations (γ)
- Curation REFINED: independent reviewer BLIND, prohibido ver PR
  diff antes de aprobar
- Anti-tests filter MORTAL: edge case #9 NEW, *.test.ts /
  *.spec.ts / test/ excluidos de Recall ground truth
- Ablation EXPANDED: (b') ripgrep alone + (c') compressor-foveal
  cross-file Phase 4
- Pre/Post Phase 4 ablation EXPLICIT como "corazón del paper"
- Dogfooding pre-ejecución NEW: "trinchera fast_grep contra bugs
  reales" antes de codear pipeline
- Latigazos round 13: #56 (mock template fraud) + #58 (anti-tests
  filter blindspot)

### Sequencing

Phase 4 PRIMERO ✓ (SEALED commit f6bf2ee).
Phase 5 ahora unblocked.

### Paradigma Δ — Token Cost to Recall

- **Output Tokens Delivered (HEADLINE)**: Economía del Agente
- **Compute Tokens (SECONDARY)**: Eficiencia Técnica
- Delta entre ambos: prueba física de compresión
- Métricas adicionales: Recall@K + Precision@K + MRR + nDCG@K

### Dataset

Repos vírgenes post-Claude knowledge cutoff, stratified por escala:

- Small library (<5K LOC): date-fns, ts-pattern
- Medium framework (5K-50K): trpc, next-auth
- Large framework (>50K): typescript, nest.js

Verificación obligatoria: SHA target POST-cutoff per modelo
evaluador, documentado per task.

### Task Count

N=100-150 committed upfront. NO MVP-then-expand (early-stopping
bias). Statistical significance ±8-10% CI 95%.

### Curation (round 13 #1 + 11 #6)

Híbrido: scripted candidate generation + INDEPENDENT BLIND review.

**Blind constraint mandatory:** reviewer lee Issue para validar
contexto suficiente, **PROHIBIDO ver PR diff antes de aprobar**.
Anti-confirmation-bias estricto.

Frozen randomness seed + reproducible script + reviewer NO es
auditor mismo (evita confirmation bias auditor self-review).

### Multi-turn Mode (round 13 #2 CORRECTED)

Mock template determinístico REJECTED (academic fraud).

Si budget Anthropic API permite: β agente real con prompt
"given retrieval result, propose next query for missing info".

Si NO budget: γ skip + Limitations section explícita
documentando que evaluamos Retrieval Estático (Single-Turn).

Cero simulaciones de juguete.

### Time-Travel Guard (round 13 #3 + 11)

Per-task individual clone @ base_commit. Fresh npm install per
task. Pureza del entorno NO se negocia (artefactos
.tsbuildinfo, mutación incremental node_modules envenenarían
TsCompilerWrapper).

Paralelizable via CI pipeline.

### Chunk-Level Mapping (round 13 #4 + 11)

Multi-level reporting en anexo: (a) strict containment,
(b) permissive overlap ≥50%, (c) token-weighted.

**Headline metric (abstract): α strict containment.** Si bug
modificado en PR no está 100% contenido en chunk retornado,
fail rotundo. No medallas por "casi".

### Token Cost @ K (round 13 #5 + 10)

γ both reportados:

- **α Output tokens delivered (HEADLINE)** — Economía Agente.
  Tokens en NREKI's MCP response (lo que agente real recibiría).
- **β Compute tokens (SECONDARY)** — Eficiencia Técnica.
  Tokens NREKI procesa internamente para producir output.

Delta entre α y β = prueba física de compresión semántica.

### Anti-Tests Filter Ground Truth (round 13 #8 NEW MORTAL)

Pipeline ground truth EXCLUIR ESTRICTAMENTE:

- `*.test.ts`
- `*.spec.ts`
- `test/` folders

Razón: PRs de fix incluyen tests añadidos para prevenir
regresión. Recuperar test del FUTURO = trampa temporal
(agente NO tiene tests del futuro al resolver bug original).

Solo código fuente de producción donde residía defecto cuenta
para Recall.

### Baselines

Internal validation (consistency v11.0.0 sin vectors):

- ripgrep
- BM25

Pre-paper submission obligatorio:

- Dense retrieval (voyage-code-3 o BGE-large API, $50-150 budget)
- Aider repo-map (open-source comparable)
- Cursor/Copilot/Cody en Limitations section explicit
  (closed-source, no fair benchmark possible)

### Ablation Study Completa (round 11 + Phase 4 awareness)

- (a) NREKI search alone
- (b) NREKI fast_grep alone (DOMINATING latency 5.5x-13.5x
  vs ripgrep per benchmark-fastgrep-vs-rg)
- (b') ripgrep alone (validates fast_grep optimization claim)
- (c) NREKI type_graph alone (Phase 3 SEALED commit 436a1e1)
- (c') NREKI compressor-foveal cross-file (Phase 4 SEALED
  commit f6bf2ee)
- (d) NREKI search + type_graph combined
- (e) NREKI all-in (Phase 3 + Phase 4 productive)
- (f) BM25 alone
- (g) Dense retrieval (pre-paper)
- (h) Aider repo-map (pre-paper)

### Pre/Post Phase 4 Ablation OBLIGATORIO (round 13 #7)

Corazón del paper. Mide delta empírico Phase 4 contribution:

- Corrida A: `git checkout f6bf2ee~1` (pre-Phase 4)
  NREKI con regex single-file parafovea
- Corrida B: `git checkout HEAD` (post-Phase 4)
  NREKI con cross-file Type Ledger injection

Si Phase 4 NO levanta Recall NI mejora token efficiency,
fracasamos en diseño (honest disclosure obligatoria).

### Edge Cases Obligatorios (UNION rounds 10+11+13)

**Round 11 (rigor experimental):**

1. **Time-Travel Data Leakage Guard:** git checkout HEAD~1
   antes de indexar (per-task per round 13 #3)

2. **Chunk-Level Mapping vs File-Level:** multi-level reporting
   + headline α strict

3. **TokenCost@K:** γ both reportados (α headline + β secondary)

**Round 10 (rigor metodológico):**

4. Ground truth 3-niveles separados (CON anti-tests filter
   mortal del round 13)

5. Issue text quality stratification:
   - High (10%): stack trace + repro
   - Medium (40%): narrative
   - Low (50%): "fix #1234"

6. Static + Multi-turn modes ambos (Multi-turn = β real o γ skip)

7. Training data leakage check post-cutoff per modelo evaluador

8. Missing baselines disclosure: Cursor/Copilot/Cody en
   Limitations section

**Round 13 (NEW MORTAL):**

9. **Anti-tests filter ground truth.** *.test.ts / *.spec.ts /
   test/ excluidos de Recall validation. Solo src/ producción.

### Fail-mode (round 10 + 13)

- Strict binary Recall@K + MRR + Precision@K + nDCG@K paralelos
- Stratified per issue quality (high/medium/low)
- Stratified per repo size (small/medium/large)
- Modes: static + multi-turn (si API budget)
- Headline metric chunk-level α strict containment

### Dogfooding Pre-Execution (round 13 final note)

Mandatory ANTES de codear pipeline:

- Probar fast_grep contra bugs reales de NREKI codebase
- Usar herramienta en crudo
- Validar empíricamente intuición fast_grep latency-fast vs
  recall-quality en bug-localization
- Confirma o refuta hipótesis "léxico falla donde topología
  sobrevive"

### Framing

Section 4 Empirical Evaluation de paper larger
("NREKI: Topology-Aware Context Delivery for Coding Agents").
NO standalone paper.

### Estimación scope

- Dataset curation: 4-8h manual + ~400 LOC scripts (round 13 expanded)
- Eval pipeline: ~580 LOC + 12-15 unit tests
- Baselines: ~450 LOC
- Analysis + report: ~150 LOC + manual write-up
- **Total**: ~1580 LOC + 100-150 tasks, 6-10 sesiones (~14-25h)

### Furia Track Record en Phase 5 Design

- **Round 10**: Paradigma Δ + dataset bias warning + 5 edge cases
  metodológicos
- **Round 11**: Spec consolidation + 3 edge cases experimentales
  (Time-Travel + Chunk-Level + TokenCost@K)
- **Round 13**: Mock template fraud rejection + anti-tests filter
  mortal + dogfooding pre-ejecución mandate

Latigazos auditor producidos rounds 10+11+13:

- #45 sequencing Phase 4/5 interchangeability
- #46 dense retrieval baseline exclusion = fraude metodológico
- #47 Paradigma A vs B framing missear USP real
- #54 spec consolidation rounds 10+11 incompleta (5 gaps)
- #56 mock template determinístico academic fraud
- #58 anti-tests filter mortal blindspot

Pipipi Code latigazos:

- #47 round 11 corpus overfitting Opción I

Furia 13/13 rounds adversariales ratificados (PERFECT RECORD).

- **Registered**: Phase 5 spec UPDATED rounds 10+11+13 (this commit,
  replaces previous spec rounds 10+11 in commit 3f41d80)
- **Planned execution**: post-Phase 4 sealed (UNBLOCKED) +
  pre-execution dogfooding mandatory
- **Estimated effort**: ~1580 LOC + 100-150 tasks, 6-10 sesiones
  (~14-25h)

---

## Phase 4 Markov Blanket Foveal — Spec firmada (Furia round 12)

**Status:** Designed, frozen, ready for FASE C execution.

### Scope re-estimated

Surgical upgrade `compressor-foveal.ts` (303 LOC TFC-Ultra
EXISTS) con Type Ledger cross-file parafovea injection.

- ~300-410 LOC (DB method + helper + integration + tests)
- 4-7h ejecución FASE C
- 1-2 sesiones distribuidas
- 50% reduction vs FASE A original estimate (600-1000 LOC)

### Architecture decisions firmed Furia round 12

**Tool surface:** Extension of existing `nreki_code action="compress"`
(NO new tool, NO new MCP registration).

**NEW params:**

- `walk_depth`: 1 (default, K=1 ESTRICTO, K=2 RECHAZADO)
- `max_cross_file`: 10 (default, hard cap pre-truncate)

**Pipeline 5 pasos NEW + integration con existing TFC-Ultra:**

1. **Database lookup (NEW METHOD):**
   - `getChunkIdByPathAndSymbol(path, symbol_name)` → chunkId | null
   - O(1) via existing `idx_chunks_symbol_name`
   - Fail-open: si null, defensive ignore (no error)

2. **Cross-file extraction (NEW HELPER):**
   - `extractTypeLedgerParafovea(foveas, engine)`:
     * For each fovea: `getSymbolIOByChunkId(chunkId)` →
       `{consumes[], produces[]}`
     * For each produced type: `getChunksByConsumedType(t)` →
       upstream chunks
     * For each consumed type: `getChunksByProducedType(t)` →
       downstream chunks
   - Filter SAME-FILE chunks (single-file ya cubierto regex)
   - Anti-hub: `rankByInDegree(crossFileChunks)`
   - Truncate: `max_cross_file=10` hard cap
   - Truncated count tracked para advisory

3. **Deduplication (FURIA #51 INNEGOCIABLE):**
   - Símbolos resueltos por Type Ledger se RESTAN de `usedImports`
   - BM25 `resolveImportSignatures` opera SOLO sobre residual
   - Topological graph PRECEDE lexical (Layer 2 over Layer 3)
   - Razón: External Parafovea YA OCUPADA por BM25 (L143-L162),
     sumar Type Ledger sin dedup = double injection garantizado

4. **Render cleanSignature (FURIA #3):**
   - Consumers (Upstream): `// [UPSTREAM]: path::symbol`
   - Producers (Downstream): `cleanSignature(shorthand)` inyectado
     en EXTERNAL PARAFOVEA section
   - Cero `AdvancedCompressor.compress()` recursive call (latigazo
     #40 vigente)
   - Cero AST parsing hot path
   - cleanSignature como FUNCIÓN PURA

5. **Density Shield exemption (FURIA #50 INNEGOCIABLE):**
   - Cálculo ratio: `compressedSize/originalSize < 0.85`
   - EXCLUIR cross-file bytes del compressedSize calculation
   - Razón: shield evalúa el archivo principal, NO contexto externo
   - Inversión semántica si sumamos: shield penaliza al TFC-Pro
     por inyectar contexto útil
   - La fovea es sagrada, jamás se sacrifica por cross-file

### Output structure

Existing TFC-Ultra layout preserved + NUEVA sección entre
upstream y downstream existing:

```
// ─── UPSTREAM CROSS-FILE (Type Ledger consumers) ───
[cleanSignature lines for chunks consuming fovea-produced types]

// ─── DOWNSTREAM CROSS-FILE (Type Ledger producers) ───
[cleanSignature lines for chunks producing fovea-consumed types]

// ... and N more cross-file relations omitted (if truncated)
```

### Defensive policies firmed Furia round 12

**#7 Type Ledger sync gap:** DEFENSIVE IGNORE (FAIL-OPEN).
Si DB lookup fail (debounce watcher lag), degradar silenciosamente
a regex local, agente sigue viendo código actual. Jamás romper
operación de lectura por cache miss topológico.

**#8 Backwards compat:** ROMPER tests + actualizar snapshots.
Output mejora cualitativamente con cross-file injection. Tests
estáticos en `bench-tfc.ts` + `compressor-advanced.test.ts` se
ajustan a la nueva realidad estructural. Sin feature flags
cobardes.

### Tests obligatorios

- Update existing `tfcCompress` assertions (snapshot updates)
- 12-15 NEW dedicated tests:
  * Cross-file upstream extraction
  * Cross-file downstream extraction
  * Same-file filter (no double regex+ledger)
  * Anti-hub ranking pre-truncate
  * `max_cross_file=10` hard cap + advisory message
  * Deduplication BM25 ↔ Type Ledger NO duplicates
  * Density Shield exemption (no false trigger en archivos
    medianos por cross-file injection)
  * Defensive ignore on DB lookup fail
  * cleanSignature rendering Upstream + Downstream
  * `walk_depth=1` enforcement (K=2 rechazado o ignored)
  * Integration test full `nreki_code action="compress"` flow
  * Backwards compat snapshots actualizados

### Edge cases identificados Furia round 12

**#50 Density Shield miopía matemática (latigazo a auditor):**
Sumar cross-file bytes al `compressedSize` invierte semántica
del shield. Shield evalúa archivo principal compresión, NO
contexto externo injection.

**#51 Edge Case Mortal (latigazo a auditor + Pipipi Code):**
External Parafovea YA OCUPADA por BM25 `resolveImportSignatures`
(compressor-foveal.ts:143-162). Sin deduplicación, double
injection garantizado.

### Latigazos Furia round 12

- Auditor #50: Density Shield miopía matemática
- Auditor #51: Edge Case Mortal (BM25 ↔ Type Ledger collision)
- Pipipi Code #48 retroactivo: missear compressor-foveal en
  FASE A original (estaba en `enforcer-state.json` mencionado)

Furia 12/12 rounds adversariales ratificados.

### Decisión Furia round 12 (5 architectural)

| # | Decisión | Veredicto Furia |
|---|----------|-----------------|
| #1 | Replace vs augment regex causal | AUGMENT (B) — dimensiones ortogonales |
| #2 | Default K-hop | K=1 ESTRICTO, K=2 RECHAZADO |
| #3 | Render granularity | cleanSignature (β) — estándar oro |
| #4 | Density Shield interaction | EXEMPTION explícita cross-file bytes |
| #5 | chunkId lookup method | NEW `getChunkIdByPathAndSymbol` O(1) |

### Riesgos identificados (preserved post-design)

1. Cross-file explosion en hub types (mitigated: anti-hub
   `rankByInDegree` + `max_cross_file=10` hard cap)

2. Latigazo #40 reedición risk (NO TFC-Pro caja negra: cleanSignature
   es función pura, NO recursive call al AdvancedCompressor)

3. Type Ledger sync gap (mitigated: defensive ignore fail-open)

4. Density Shield false positives (mitigated: exemption explícita
   Furia #50)

5. Backwards compat tests (mitigated: ROMPE + update snapshots,
   no feature flags cobardes Furia #8)

- **Registered**: Phase 4 spec persistence (this commit)
- **Planned execution**: FASE C (β prompt firmable post-α confirm)
- **Estimated effort**: ~300-410 LOC, 4-7h, 1-2 sesiones

---

═══════════════════════════════════════════════════════════════════
PHASE 5 SEALED — SWE-PolyBench Verified TS (post Furia round 17)
═══════════════════════════════════════════════════════════════════

**Status:** SEALED 2026-05-10
**Decisión auditoría adversarial:** Furia rounds 13+15+16+17
**Audit trail Path E/F:** scripts/eval-phase5/data/*-probe/ (borrables)

## Dataset primary

SWE-PolyBench Verified TS (n=100, license MIT)
- Citation: arXiv:2504.08703 (Amazon Science, 2025)
- HuggingFace: AmazonScience/SWE-PolyBench_Verified
- Distribución por repo:
  - mui/material-ui:           70 instances  (Large ~500k LOC)
  - microsoft/vscode:           23 instances  (Huge  ~2M LOC)
  - tailwindlabs/tailwindcss:    3 instances  (Medium ~50k LOC)
  - coder/code-server:           3 instances  (Medium fork-vscode)
  - angular/angular:             1 instance   (Large ~600k LOC)

## Claim del paper

**"Topological Retrieval in Massive-Scale TypeScript Codebases"**

Hipótesis Furia round 14: NREKI v11 mantiene Fix Accuracy y
First-Hit Recall en monolitos 50k–2M LOC donde BM25 y Dense
Retrieval degradan por ruido combinatorio.

## Limitación reportada (Furia round 17 #2)

> La evaluación rigurosa de agentes en repositorios puros de
> Backend TS está bloqueada por la intratabilidad del sandboxing
> en la literatura académica actual, sesgando el estado del arte
> hacia frameworks UI/IDE. Hallazgo empírico: ningún dataset TS
> académico public-grade (Multi-SWE-bench, SWE-PolyBench,
> SWE-bench Multilingual) incluye repos Backend/ORM/Compiler/
> Linter/Library — 0 de 7 repos TS totales en el universo
> probado.

## Métricas reportadas (7 totales)

### Component-level (fast_grep vs ripgrep)

1. **Recall paridad funcional** — fast_grep vs ripgrep encuentran
   los mismos modified_nodes. Target: ≥99% paridad sin regresión.
2. **Latency p50/p95/p99** — speedup verificado en repos del
   subset (mui 500k, vscode 2M). Baseline: fast_grep p50 1.7ms,
   ripgrep p50 22-24ms (NREKI scale). Hipótesis paper-scale:
   speedup ~5-8x mantenido.
3. **Memory footprint** — fast_grep SQLite indexed vs ripgrep
   streaming.

### System-level (NREKI completo vs baselines)

4. **First-Hit Recall** (retrieval-only, NREKI ZERO leakage)
5. **Strict Chunk-Level Containment** vía AST modified_nodes
   match (campo PolyBench)
6. **Fix Accuracy E2E Dual:**
   - Headline: Claude Opus 4.7 (moderno, leakage aceptado)
   - Robustness: modelo pre-2024 (GPT-4 original o Claude 2.1)
7. **TokenCost@K** (Output α HEADLINE + Compute β SECONDARY)

## Stratification revisada (Furia round 17 #5)

**Por tamaño real:**
- Medium (50–100k LOC): tailwindcss + code-server = 6 instances
- Large (500–600k LOC): mui + angular = 71 instances
- Huge (~2M LOC): vscode = 23 instances

**Cruzada con task_category (PolyBench campo nativo):**
- Bug Fix (77%)
- Feature (22%)
- Refactoring (1%)

Matriz 3×3 (tier × category) reportada en paper.

## Baselines firmados (round 13 #5 + extensión fast_grep)

- fast_grep (componente propio)
- ripgrep (sanity check + paridad con fast_grep)
- BM25 standalone
- Voyage-3 dense retrieval (budget $50-150 pendiente firma)
- Aider repo-map (LLM-backed)

## Pre/Post Phase 4 ablation (corazón del paper)

git checkout f6bf2ee~1 (pre-Markov Blanket Foveal) vs HEAD
post-Phase 4. Demuestra contribución arquitectónica específica.

## Schema de ground truth (Furia round 17 #3)

Campo PolyBench `modified_nodes` con paths AST tree-sitter:
  "src/vs/editor/contrib/suggest/suggestModel.ts->...->trigger"

Match arquitectónico AST↔AST con NREKI. Cero adivinanza léxica.

## Decisiones diferidas (no bloquean C.2)

- Voyage-3 budget ($50-150): firma Jherson en C.3
- Pre-2024 evaluator concreto (GPT-4 vs Claude 2.1): firma en C.3
- Push 33 commits ahead a origin: sesión separada
- AGENTS.md retrieval decision tree update: post-C.4 sealed
- Symbol Cohesion Graph paper material: post-Phase 5

═══════════════════════════════════════════════════════════════════
