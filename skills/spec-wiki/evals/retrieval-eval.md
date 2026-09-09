# Retrieval regression protocol

Use `retrieval-evals.json` to check the query router after search/index changes.
The cases are intentionally mixed: direct keywords, natural paraphrases,
Russian requests, synonyms, exact code paths, and symbols.

## Guard against answer leakage

The retrieval agent must receive only each case `id` and `query`. Do not expose
`expectedAny` until after it returns candidate paths.

## Stage 1: deterministic candidate generation

Run `spec_wiki.py search` against the current `.spec-wiki/state.json` and record
top-1/top-3/top-5 plus `confidence` / `catalogFallbackRecommended`. This stage is
expected to be imperfect for semantic paraphrases; its job is cheap candidate
generation and reliable low-confidence detection.

## Stage 2: full skill workflow

Have a fresh agent read only `SKILL.md` and `references/query.md`, then for each
query:

1. create the in-model retrieval bundle;
2. call relation-aware `search` with `--also` aliases;
3. semantically rerank compact result metadata;
4. when fallback is recommended or intent coverage is visibly incomplete, use
   only `.spec-wiki/index.md` as the semantic catalog fallback;
5. return up to three primary spec paths without opening the primary specs.

Compare those paths with `expectedAny` only after the run. A case passes top-k
when any expected path appears in the first k selections.

Current target for this repository: at least 95% top-1 and 100% top-3/recall.
Do not tune expected paths after seeing a run merely to improve the score; change
an expectation only when independent review shows that more than one primary
spec is genuinely defensible.
