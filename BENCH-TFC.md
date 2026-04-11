# NREKI TFC-Pro Benchmark (v8.5)

Dogfooding benchmark against the NREKI codebase itself.

## Summary

| Metric | Value |
|--------|-------|
| Files benchmarked | 5 |
| Total focus probes | 15 |
| Successful (found symbol) | 13 |
| Fallback rate | 13.3% |
| Fovea fidelity rate | 100.0% |
| **TFC-Pro avg compression** | **82.2%** |
| Legacy aggressive avg | 85.3% |
| Legacy tier-3 avg | 71.4% |
| **TFC advantage (vs aggressive)** | **-1.5pp** |
| **TFC advantage (vs tier-3)** | **9.8pp** |
| TFC p50 / p95 | 84.8% / 89.9% |
| TFC min / max | 63.2% / 89.9% |
| Cache speedup (avg) | 29.9x |

## Per-file results

| File | Raw | Legacy aggr | Legacy t3 | Foci | Avg TFC | Avg Δ aggr |
|------|-----|-------------|-----------|------|---------|-----------|
| `src\kernel\nreki-kernel.ts` | 23656t | 97.9% | 74.7% | 2/3 | 75.8% | -22.1pp |
| `src\hologram\shadow-generator.ts` | 10300t | 78.4% | 73.5% | 3/3 | 84.3% | 5.9pp |
| `src\compressor.ts` | 10145t | 72.2% | 76.9% | 3/3 | 77.7% | 5.5pp |
| `src\repo-map.ts` | 9648t | 83.7% | 77.5% | 3/3 | 84.2% | 0.6pp |
| `src\database.ts` | 8711t | 94.5% | 54.2% | 2/3 | 89.3% | -5.3pp |

## Per-focus detail

### `src\kernel\nreki-kernel.ts` (raw 23656 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `NrekiKernel` | 81280c | 23656t | 0.0% | -97.9pp | ✗ fallback |
| `interceptAtomicBatch` | 20521c | 6929t | 70.7% | -27.2pp | ✓ |
| `boot` | 13389c | 4502t | 81.0% | -17.0pp | ✓ |

Cache: 1st parse 1754.9ms → 2nd 14.8ms (118.5x speedup)

### `src\hologram\shadow-generator.ts` (raw 10300 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `classifyNode` | 4380c | 1569t | 84.8% | 6.4pp | ✓ |
| `generateShadow` | 3830c | 1942t | 81.1% | 2.7pp | ✓ |
| `scanProject` | 3408c | 1351t | 86.9% | 8.5pp | ✓ |

Cache: 1st parse 14.1ms → 2nd 3.3ms (4.3x speedup)

### `src\compressor.ts` (raw 10145 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `Compressor` | 7530c | 3736t | 63.2% | -9.0pp | ✓ |
| `structuralCompress` | 4395c | 1545t | 84.8% | 12.6pp | ✓ |
| `AdvancedCompressor` | 3554c | 1514t | 85.1% | 12.9pp | ✓ |

Cache: 1st parse 21.8ms → 2nd 2.6ms (8.5x speedup)

### `src\repo-map.ts` (raw 9648 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `buildDependencyGraph` | 5672c | 1980t | 79.5% | -4.2pp | ✓ |
| `repoMapToText` | 4526c | 1568t | 83.7% | 0.1pp | ✓ |
| `renderGroup` | 2756c | 1011t | 89.5% | 5.9pp | ✓ |

Cache: 1st parse 17.6ms → 2nd 1.5ms (11.4x speedup)

### `src\database.ts` (raw 8711 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `NrekiDB` | 28448c | 8711t | 0.0% | -94.5pp | ✗ fallback |
| `searchHybrid` | 2237c | 992t | 88.6% | -5.9pp | ✓ |
| `setupSchema` | 2140c | 880t | 89.9% | -4.6pp | ✓ |

Cache: 1st parse 15.9ms → 2nd 2.2ms (7.1x speedup)
