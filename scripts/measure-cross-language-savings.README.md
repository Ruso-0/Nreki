# scripts/measure-cross-language-savings.mjs

Measure NREKI's local foveal shorthand compression savings across languages.

## Purpose

Indicative (NOT empirical) measurement of token savings from NREKI's
shorthand-based compression. Measures ONLY the local foveal shorthand
compression — does NOT measure cross-file Type Ledger pruning (TS-only).

Token proxy: `code.length / 4` (canonical "~4 chars per token" rule of thumb).

## Usage

```bash
# Single language
node scripts/measure-cross-language-savings.mjs /path/to/source/dir/

# Windows WSL2 (for Java repos with MAX_PATH issues)
wsl -d Ubuntu -- bash -c 'cd /mnt/d/Nreki && node scripts/measure-cross-language-savings.mjs /tmp/corpus-dir/'
```

## Output

JSON to stdout with:
- `summary`: per-extension aggregate (files, bytes, chunks, raw/compressed tokens, saving %)
- `perFile`: per-file breakdown
- `disclosure`: scope and limitations

## Supported extensions

`.java`, `.kt`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.c`, `.h`

## Limitations

- Token proxy is approximate (char/4). For paper-grade numbers, swap in tiktoken.
- Measures only local foveal compression, not cross-file Type Ledger pruning.
- Corpora must be representative; tiny files inflate savings irrelevantly.
