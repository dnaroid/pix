---
kind: spec
status: active
---

# Wiki contradiction evaluation

This opt-in harness evaluates the production Wiki contradiction checker with an
explicit live model. It complements deterministic tests that inject model
responses into `compareKnowledge`, evidence collection and chunk merging.

[Testing and QA](index.md) · [Evaluation framework](evals.md)

## Two separate stages

**Judge** supplies known document passages, then invokes the unchanged production
prompt, JSON parser, exact-quotation validator and result merger. Gold labels and
claim anchors are authored in the fixtures and never sent to the model. A finding
passes only when both validated quotations include the expected discriminating
claims; a matching document path alone is insufficient. Extra or duplicate
findings fail. Discarded quotations cannot turn a negative control into a clean
success. Genuine material uncertainty has its own expected class.

**Native retrieval** creates isolated synthetic Wiki projects and uses the actual
native Knowledge search and `collectKnowledgeEvidence`. It measures whether the
expected document enters the candidate set, survives final source selection and
contributes the decisive original passage. Required lifecycle context must also
reach the judge. Success requires fresh, complete selection and an explicitly
ready semantic stage; lexical-only output or a pending index cannot pass. The
snapshot is revalidated after the model response. Both the retrieval metrics and
the subsequent judge result must pass for the case to pass.

The default `all` plan contains 16 judge cases and 3 retrieval cases. These require
21 model calls: the long judge fixture uses two chunk checks and one cross-chunk
comparison. Retrieval calls and semantic index status are recorded separately
from model-completion counts. Retrieval fixtures have their own Git roots so the
parent repository's ignored artifact directory does not suppress indexing.

## Fixed synthetic matrix

| Case | Expected behavior |
| --- | --- |
| `exact-number` | Detect incompatible exact values for the same current configuration. |
| `paraphrased` | Detect incompatible rules expressed with different words. |
| `required-forbidden` | Detect an action that is both required and forbidden. |
| `different-mode` | Accept rules explicitly scoped to different modes. |
| `different-version` | Accept rules explicitly scoped to different versions. |
| `explicit-supersession` | Respect a source's explicit historical/superseded status. |
| `proposal` | Distinguish an unaccepted proposal from an active requirement. |
| `compatible-bounds` | Accept jointly satisfiable upper bounds. |
| `equivalent-units` | Accept equivalent quantities in different units. |
| `missing-scope` | Report material uncertainty when the environment is unspecified. |
| `internal` | Detect incompatible claims within the document. |
| `cross-chunk` | Detect incompatible claims in distant chunks of a document over 48,000 characters. |
| `mixed-language` | Preserve English original quotations while requesting Russian explanations. |
| `markdown-crlf` | Preserve Markdown syntax in quotations and normalize CRLF. |
| `repeated-quote` | Include enough original context to disambiguate a repeated sentence. |
| `prompt-injection` | Treat embedded instructions as document content and still find the conflict. |

There are 9 positive, 6 negative and 1 uncertainty case. The default native slice
uses `exact-number`, `paraphrased` and `required-forbidden`, with neutral decoys.
`--cases` selects stable IDs and, for retrieval, excludes chunked fixtures.

## Run

From the repository root:

```bash
# Deterministic controls and focused typecheck; no model calls.
npm run test:knowledge-eval

# List the plan; no network requests.
npm run eval:knowledge -- --mode all --list

# Explicit opt-in live run using the currently configured provider credentials.
npm run eval:knowledge -- --live --model zai/glm-5.3-flash \
  --thinking low --mode all --max-calls 24
```

The model is selected only for this process. The harness does not change Desktop
or suite judge settings, global search settings, the real Wiki or its inline
reports/stamps. It uses the same sessionless SDK runtime as the production judge,
without creating a coding-agent session. Native retrieval uses the already
configured semantic provider; no provider fallback is introduced. It does create
an isolated fixture-local Knowledge search policy and native search state.

`--live` and an explicit `--model provider/model` are required for live requests.
`PI_OFFLINE=1` forbids a live run. Calls are serial, without provider retries.
Defaults are one repetition, 24 model calls maximum, 120 seconds per call and
15 minutes for the whole run. `--repeat` accepts 1–3; `--max-calls` accepts up to
64. Increase the call budget explicitly for repetitions. `--timeout-ms` and
`--budget-ms` control the two deadlines. Provider failure, timeout or cancellation
stops subsequent model calls and leaves unexecuted cases visible as `notRun`.
Semantic/citation failures are retained and do not trigger a hidden retry.

For a narrower run:

```bash
npm run eval:knowledge -- --live --model zai/glm-5.3-flash \
  --thinking low --mode judge --cases repeated-quote,markdown-crlf
```

## Evidence and interpretation

Each run creates a unique directory under `.pi/artifacts/`, or accepts a new
`--output` subdirectory there. Reusing an owned output directory is rejected.
These artifacts are temporary and may be cleaned up; export evidence that must
be retained, following the [artifact policy](../../operations/harness-artifact-storage.md).

- `report.json` retains actual results, stage metrics, source hashes, model and
  generation settings, request usage and diagnostic quotation match counts.
- `report.md` summarizes planned, passed, failed, pending and unexecuted cases.
- `requests/call-0001.json` and subsequent files retain the exact production
  prompt, raw answer, elapsed time and usage for each model call. They do not
  retain reasoning blocks, authentication data or provider headers.
- `fixtures/` retains the native retrieval projects and their search state.

Report checkpoints are replaced atomically. Source identity includes the Git
commit, dirty-worktree flag and hashes of the production checker and the harness.
Raw-response diagnostics distinguish invalid JSON/schema, absent quotations and
ambiguous repeated quotations. Completed empty output is invalid, not omitted
from the denominator. Provider failures are counted separately.

Pair precision/recall are calculated from validated, scored judge responses.
Provider failures and unexecuted cases remain explicit run failures, outside
those conditional pair metrics. A small synthetic sample, especially one run,
does not establish whole-Wiki accuracy or a universal model ranking. These tests
also do not certify Desktop rendering, notification delivery, background queue
recovery or the real project's full source coverage. The requested Russian
explanations and their semantic adequacy remain inspectable in the raw output;
the scorer does not substitute a Cyrillic-character heuristic for language QA.

## Observed baseline: 2026-10-30

One run used `zai/glm-5.3-flash`, `thinking=low`, the unchanged production prompt,
and the default `all` matrix. It completed 21 model calls in approximately
99 seconds, without provider errors or retries.

| Measurement | Observed result |
| --- | --- |
| Judge scenarios | 15/16 passed |
| Expected contradiction pairs | 9/9 found |
| Negative controls | 5/6 passed; one false positive |
| Expected material uncertainty | 1/1 passed |
| Native hybrid retrieval scenarios | 3/3 passed |
| JSON / schema responses | 21/21 valid |
| Grounded proposed findings, including uncertainty | 14/14 valid |
| Absent or ambiguous quotation rejections | 0 |

The failure was `equivalent-units`. The model correctly explained in Russian
that 10 minutes equals 600 seconds and that there is no contradiction, but placed
that pair in `conflicts`. The structured result would therefore produce a false
red status. This is a verdict-placement failure despite valid quotations and a
correct explanation; quote validation alone cannot prevent it. The evaluator
retains the failure and exits nonzero, rather than accepting reassuring prose.

All three retrieval observations reported `backend=native`, `mode=hybrid`, a
ready and complete semantic stage, enabled reranking and a fresh snapshot after
judgment. They used six-file synthetic projects, so these observations do not
measure recall or selection limits on a large Wiki. Russian explanations and
English quotation preservation were inspected in the retained output. No
comparison with another model was performed in this run.

The deterministic evaluator gate passed 38 tests plus its focused typecheck.
These numbers describe this particular run, not required future pass counts or
statistical reliability guarantees. Full artifacts retain exact prompts,
responses, production/harness hashes and the dirty-worktree provenance.

## Implementation

- `scripts/knowledge-check-eval/`: fixed cases, scorer, SDK runtime, native
  retrieval, CLI and reports.
- `tests/knowledge-check-eval*.test.ts`, `tests/knowledge-check-retrieval.test.ts`:
  deterministic evaluator controls.
- `acp/src/knowledge/comparison.ts`, `evidence.ts`, `chunks.ts`: unchanged
  production behavior under evaluation.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"407edce5ac47ed6c3cd4da7440464b0634a830328e5267553b7c3136bc8c27c2","checkedAt":"2026-10-31T00:25:44.793Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":58,"reportLanguage":"ru"} -->
