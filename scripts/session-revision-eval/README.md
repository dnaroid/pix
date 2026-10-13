# Session revision discovery: experimental eval

**No working search, index, session or production configuration is changed.**
This opt-in research harness tests automatic relation discovery, not production
integration. Its contract is documented here; it adds no product spec or ADR.

## Commands

```sh
npm run test:session-revisions
npm run eval:session-revisions                     # validates fixtures; no quality score/network
npm run eval:session-revisions -- --live --max-calls 350
# Use the cache directory printed by the live run:
PI_OFFLINE=1 npm run eval:session-revisions -- --replay --cache .pi/artifacts/<run>/cache
```

`--live` explicitly authorizes transmitting the selected corpus to configured
OpenRouter embeddings and Jev. The default corpus contains synthetic text only.
Real session data must be supplied explicitly with `--corpus path/to/corpus.json`;
the harness does not enumerate or open saved sessions. Only the already authorized
session was used in the initial real-data experiment. Do not copy real session
text into tracked fixtures. `PI_OFFLINE=1` prohibits live requests.

Options: `--corpus`, `--cache`, `--live` or `--replay`, `--max-calls`, and
`--top-k` (1–10, default 3). Live requires a positive call budget; no retries or
fallback models. A request-count budget is **not** a dollar ceiling. Calls are
serial; SIGINT/SIGTERM abort transport; the request timeout is bounded. A failed,
invalid or missing response is incomplete, not `unchanged`.

Exit codes: **0** all annotated relations and query expectations match;
**1** completed quality eval has misses; **2** setup/transport/budget/cache failure.
Fixture validation also exits 0, but is explicitly not a model-quality score.
Unannotated accepted edges are listed for review and are not counted as correct.
The harness is not added to default CI; live checks must remain opt-in.

## What is automatic

1. All supplied messages are split into lines and language-neutral ICU sentences,
   with long pieces bounded to 600 UTF-16 units. Every fragment has exact original
   `entryId/start/end` provenance. This is **structural source-span extraction**,
   not semantic atomic-assertion extraction. Questions, headings, proposals and
   automated text can remain in the corpus.
2. For each later message, retrieve its three most similar **earlier spans across
   the whole supplied branch**, plus the highest-scoring immediately preceding
   message span if absent. Discovery never sees expected labels or search queries.
   Short messages include two preceding messages for reference resolution.
   Context can dominate similarity; this is an evaluated weakness, not a solved filter.
3. Jev classifies `requested/reported/unchanged/uncertain`. Positive replacements
   require a second same-model `changed` check. The second check is not independent
   confirmation. Model inputs include source context, but only the selected span
   may be superseded. `reported` means claimed in the transcript, not verified.
4. Query vectors rank source spans. A small assertion-local overlay attaches later
   decisions/reports to each of the top three spans without deleting history or
   suppressing the whole source message. As-of queries exclude later spans and
   edges; historical mode suppresses overlays. This is **not a general relation
   graph**: reversals through intermediate nodes, reaffirmed latest reports and
   non-assertion anchors remain unresolved. Raw rankings are retained for comparison.

## Corpus and scoring

The JSON corpus is an array of cases, each with `id`, `split`, ordered
`messages: [{id, role, text}]`, `expected`, and optional `queries`.

- Relations: `{earlierId, laterId, relation, evidence}`. `evidence` is an exact
  substring of the earlier message and must occur **inside the candidate span**,
  not just context or another fact in the same message. Sparse gold annotations
  measure recall of those particular spans; other semantically equivalent spans
  are not automatically credited or deemed wrong.
- Queries: `{text, decisionId, reportedId, asOfId?, historical?}`. Expected IDs
  identify the user decision and most recent reported state, separately. Historical
  IDs identify the state at that point. The overlay only approximates this contract;
  failures are retained, including its inability to treat factual user assertions
  as baseline reports or follow reversals transitively.
- Report candidate recall on positive labels separately from classification on
  retrieved annotations, false replacements on retrieved negatives, and unseen
  negatives. Missing candidates never become classification successes.
- Report raw/overlay top-1 decision and reported-state hits separately. This is a
  small within-conversation retrieval eval, **not global session-search quality**.
- `unannotatedAccepted` is mandatory review material, not precision evidence.

`fixtures.json` contains 12 separately authored synthetic challenge cases (English
and French). The research author did not inspect implementation or prior pilot
artifacts. The parent checked the labels **before the first run**, correcting eight
contract mismatches (assistant promises, unchanged requested-value implementation,
unmet conditions and failed attempts), preserving `originalRelation`; six explicit
user-change edges were added. Therefore this is an **independently authored,
parent-adjudicated control set**, not a blind or statistically representative test.
Synthetic controls and the real regression session are scored separately. Once
observed, these controls become development data for any subsequent tuning.

## Reproducibility and storage

Each run writes a unique `.pi/artifacts/session-revision-eval-*` directory:
`plan.json` freezes corpus, prompts, hashes, parameters and Node/ICU versions;
`results.json` records candidates, choices and source spans; `summary.json` separates
metrics by split; `requests.json` records new-call usage/cost, not credentials.
Replay imports no provider/auth module and sends no network requests. Missing cache
data exits 2. Provider failures are sanitized; partial completed cases remain visible.

Successful embeddings are cached by config identity and exact prefixed input;
choices by classifier version, model, prompt, state and full supplied branch hash.
Branch edits/forks invalidate classification reuse. Changed vectors/prompts never
silently reuse incompatible entries. Cache writes use temporary files and rename.
The CLI is serial; shared-cache concurrent writers are not a supported use case.
Jev's `latest` alias is mutable: replay reproduces saved answers, not future live
outputs. Use a fresh cache directory to sample a new model run.

Artifacts have cleanup TTL; export evidence/cache before cleanup if needed.
Tracked harness/fixtures remain durable. Private real corpora and responses stay
in scratch storage. No minimum source-message length or keyword language filter
is used; upstream role/provenance filtering is not implemented here.

## Initial outcome and remaining gates

The initial frozen live run **failed**: the synthetic set had 12/12 positive
candidate recall, 26/29 correct annotated relations and 2/17 false replacements;
the real regression retrieved only 1/4 positive evidence spans. The small overlay
also failed retrieval expectations. A canonical-tasks preservation span received a
false positive during real-data manual review (not included in the frozen negative
denominator). Replay reproduced the same predictions without paid calls.

Before any integration: improve source/provenance filtering and candidate recall,
extract genuinely scoped assertions, distinguish lifecycle confirmation from changed
values, resolve chains/reversals/conflicts, re-evaluate on a **new** independent
control set, and test global ranking with distractor sessions. This baseline is not
an accepted solution to stale search results. Full CI and real UI QA are not claimed.

## Implementation and tests

- `scripts/session-revision-eval/core.mjs`: extraction, candidate selection, scoring, overlay.
- `scripts/session-revision-eval/prompts.mjs`: frozen classifier and gate contract.
- `scripts/session-revision-eval/runtime.mjs`: opt-in provider, accounting and replay cache.
- `scripts/session-revision-eval/run.mjs`: CLI, pre-run plan and reports.
- `scripts/session-revision-eval/fixtures.json`: durable control set and provenance.
- `scripts/session-revision-eval/test.mjs`: deterministic extraction, scoring, temporal,
  scope-isolation, gate, query-overlay and cache/error invariants.
