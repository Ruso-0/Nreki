# Sprint 6.8 — Foveal compression: ideal vs effective

Tokenizer: tiktoken cl100k_base (real BPE).

## Method

For each NREKI task that returned retrieved_files:
1. Read the raw content of every top-10 retrieved file from
   `.eval-phase5-cache/task-workspaces/...` at base_commit.
2. Sum raw BPE tokens of those files.
3. The `token_cost.total_tokens` recorded by the runner is the
   foveal-compressed payload across the same top-K.
4. ideal_compression_ratio = compressed / raw, aggregated globally
   AND per-task.
5. effective_savings = (1 - ideal_ratio) × R@5 — only counts when
   the right file was actually found in top-5.

## Results

| Retriever | ideal savings (global) | per-task ratio median | per-task ratio mean | R@5 | effective savings | n_tasks |
|---|---|---|---|---|---|---|
| nreki-mbf-on | 83.5% | 78.5% | 75.7% | 36.00% | 30.1% | 100 |

## Reading

- **ideal savings (global):** what foveal achieves on the files NREKI surfaces,
  regardless of whether the right file was found. This is the headline 78% Sprint
  6.5 number, measured here on PolyBench TS instead of NREKI's own src.
- **effective savings:** ideal × R@5. The honest session-level savings —
  compressing the wrong file is not a real saving.
