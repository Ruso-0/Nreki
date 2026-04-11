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
| Cache speedup (avg) | 34.1x |
| **Best case boundary** | **98.2% (55x)** |

## Per-file results

| File | Raw | Legacy aggr | Legacy t3 | Foci | Avg TFC | Avg Δ aggr |
|------|-----|-------------|-----------|------|---------|-----------|
| `src\kernel\nreki-kernel.ts` | 23656t | 97.9% | 74.7% | 2/3 | 75.8% | -22.1pp |
| `src\hologram\shadow-generator.ts` | 10300t | 78.4% | 73.5% | 3/3 | 84.3% | 5.9pp |
| `src\compressor.ts` | 10145t | 72.2% | 76.9% | 3/3 | 77.7% | 5.5pp |
| `src\repo-map.ts` | 9648t | 83.7% | 77.5% | 3/3 | 84.2% | 0.6pp |
| `src\database.ts` | 8711t | 94.5% | 54.2% | 2/3 | 89.3% | -5.3pp |

## Boundary Analysis — Theoretical Ceiling

TFC compression ratio follows an Amdahl-style law:

```
Ratio ≈ 1 − (Preamble + Fovea + Markov_Mantle_O(1)) / TotalFileSize
```

The **smaller the focus** relative to the file, the closer compression approaches 100%. 
The boundary probes the smallest symbols in each file to document the empirical ceiling.

**Best case observed**: **98.2% compression** (**55x**) 
on focus `isBooted` in `src\kernel\nreki-kernel.ts`.

| File | Focus | Focus lines | TFC ratio | Compression |
|------|-------|-------------|-----------|-------------|
| `src\kernel\nreki-kernel.ts` | `getStagingSize` | 1L | 98.2% | 55x 🎯 |
| `src\kernel\nreki-kernel.ts` | `toPosix` | 1L | 97.8% | 45x 🎯 |
| `src\kernel\nreki-kernel.ts` | `isBooted` | 3L | 98.2% | 55x 🎯 |
| `src\hologram\shadow-generator.ts` | `ExportClassification` | 4L | 97.4% | 39x 🎯 |
| `src\hologram\shadow-generator.ts` | `ScanStats` | 6L | 97.5% | 40x 🎯 |
| `src\hologram\shadow-generator.ts` | `nodeText` | 3L | 97.2% | 36x 🎯 |
| `src\compressor.ts` | `CompressionTier` | 1L | 97.9% | 47x 🎯 |
| `src\compressor.ts` | `CompressionLevel` | 1L | 97.7% | 44x 🎯 |
| `src\compressor.ts` | `Lang` | 1L | 96.9% | 33x 🎯 |
| `src\repo-map.ts` | `stableCompare` | 2L | 97.4% | 38x 🎯 |
| `src\repo-map.ts` | `shortenImport` | 3L | 97.5% | 40x 🎯 |
| `src\repo-map.ts` | `RepoMapEntry` | 7L | 97.1% | 35x 🎯 |
| `src\database.ts` | `ready` | 3L | 96.8% | 31x 🎯 |
| `src\database.ts` | `FileRecord` | 4L | 96.9% | 33x 🎯 |
| `src\database.ts` | `getVectorCount` | 3L | 96.7% | 30x 🎯 |

## Per-focus detail

### `src\kernel\nreki-kernel.ts` (raw 23656 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `NrekiKernel` | 81280c | 23656t | 0.0% | -97.9pp | ✗ fallback |
| `interceptAtomicBatch` | 20521c | 6929t | 70.7% | -27.2pp | ✓ |
| `boot` | 13389c | 4502t | 81.0% | -17.0pp | ✓ |

Cache: 1st parse 1819.4ms → 2nd 13.3ms (137.1x speedup)

### `src\hologram\shadow-generator.ts` (raw 10300 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `classifyNode` | 4380c | 1569t | 84.8% | 6.4pp | ✓ |
| `generateShadow` | 3830c | 1942t | 81.1% | 2.7pp | ✓ |
| `scanProject` | 3408c | 1351t | 86.9% | 8.5pp | ✓ |

Cache: 1st parse 14.3ms → 2nd 1.5ms (9.6x speedup)

### `src\compressor.ts` (raw 10145 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `Compressor` | 7530c | 3736t | 63.2% | -9.0pp | ✓ |
| `structuralCompress` | 4395c | 1545t | 84.8% | 12.6pp | ✓ |
| `AdvancedCompressor` | 3554c | 1514t | 85.1% | 12.9pp | ✓ |

Cache: 1st parse 16.8ms → 2nd 3.0ms (5.6x speedup)

### `src\repo-map.ts` (raw 9648 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `buildDependencyGraph` | 5672c | 1980t | 79.5% | -4.2pp | ✓ |
| `repoMapToText` | 4526c | 1568t | 83.7% | 0.1pp | ✓ |
| `renderGroup` | 2756c | 1011t | 89.5% | 5.9pp | ✓ |

Cache: 1st parse 14.7ms → 2nd 1.6ms (9.1x speedup)

### `src\database.ts` (raw 8711 tokens)

| Focus | Size | TFC tokens | TFC ratio | Δ vs aggressive | Fidelity |
|-------|------|------------|-----------|-----------------|----------|
| `NrekiDB` | 28448c | 8711t | 0.0% | -94.5pp | ✗ fallback |
| `searchHybrid` | 2237c | 992t | 88.6% | -5.9pp | ✓ |
| `setupSchema` | 2140c | 880t | 89.9% | -4.6pp | ✓ |

Cache: 1st parse 19.0ms → 2nd 2.1ms (9.3x speedup)
