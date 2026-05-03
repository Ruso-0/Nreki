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
