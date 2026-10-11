---
kind: spec
status: active
title: Reproducible native and IDX repository-search comparison
---

# Reproducible native and IDX repository-search comparison

## Behavior

- Benchmark the real `project_search` engine's native and installed IDX backends,
  not fake CLI responses, on identical isolated copies of a fixed code/document
  corpus. Preserve original relative paths, content hashes and ancestor `.gitignore`
  files. Record working-tree revision, platform, CLI version, settings and queries.
- Predeclare anchor-based relevance judgments before execution. Report Recall@5/10,
  MRR, precision, snippet-anchor visibility, path/range validity and text fidelity.
  Exact identifiers, document contracts and explicitly validated zero-token-overlap
  natural-language queries are separate cohorts. These are targeted judgments,
  not exhaustive human relevance labels for every possibly useful fragment.
- Separate lexical, hybrid and semantic measurements. Record new-index/first-pass
  and warmed-process-start search latency, CPU time, peak RSS, index storage,
  initial/incremental operations, document/query embedding usage and costs.
- Measure native bounded semantic backfill separately, keeping partial-coverage
  notices/status and refusing to label fallback or partial warmed results semantic.
  Native allows up to 128 new chunks per search; a domain-specific query and the
  subsequent two-domain fill requests may have different budgets.
- Exercise addition, modification, renaming, deletion and nested ignore changes;
  stale-text assertions must not confuse valid fuzzy/prefix matches with stale data.

## Constraints

- Disposable output belongs in a new `.pi/artifacts/` directory. Source indices,
  credentials, provider/model and global IDX registry must not be mutated.
- Default execution is local-only, measuring native lexical. Installed IDX 2.0.16
  initializes embeddings even for lexical retrieval: no-paid default must not
  silently use mock vectors or label absent IDX/semantic data as measured.
- `--paid` requires separate user approval for external transmission and budget.
  This harness supports the saved identical OpenRouter domain configuration
  `perplexity/pplx-embed-v1-0.6b`; other providers/models require adapting and
  reviewing the budget guard, not changing project settings. Bound corpus to 1 MiB,
  total reserved embedding UTF-8 bytes to 8 MB and embedding inputs to 1000.
- Block nonembedding network requests and automatic CLI updates. Meter only
  aggregate sizes/status/usage; never log embedding payloads, keys or headers.
- A same-provider run does not establish semantic parity: chunking, input formatting,
  candidate limits, score thresholds and scope can differ. Cold process/index
  measurements are not OS page-cache-cold measurements; disclose this limitation.
- Reuse accepted decisions [0065](../docs/decisions/0065-native-repository-search.md)
  and [0066](../docs/decisions/0066-native-repository-semantic-search.md); this benchmark
  does not change production search behavior or establish a new architecture decision.

## Implementation

- `external/pi-tools-suite/benchmarks/repository-search/corpus.json`
- `external/pi-tools-suite/benchmarks/repository-search/run.mjs`
- `external/pi-tools-suite/benchmarks/repository-search/analyze.mjs`
- `external/pi-tools-suite/benchmarks/repository-search/worker.mjs`
- `external/pi-tools-suite/benchmarks/repository-search/metrics.mjs`
- `external/pi-tools-suite/benchmarks/repository-search/network-meter.mjs`
- `external/pi-tools-suite/package.json`

## Tests

- `external/pi-tools-suite/benchmarks/repository-search/metrics.test.mjs`

## Verification

- `npm --prefix external/pi-tools-suite run benchmark:search:test`
- Offline re-scoring: `node external/pi-tools-suite/benchmarks/repository-search/analyze.mjs <retained-run-directory>`.
- `node external/pi-tools-suite/benchmarks/repository-search/run.mjs --repeats 1`
- Only with separate embedding consent: `node external/pi-tools-suite/benchmarks/repository-search/run.mjs --paid --repeats 3`
- `npm run check:ci` after the prerequisites in `docs/development.md`.
- Measured outcomes/methodology: `docs/benchmarks/repository-search-comparison.md`.
