# Evaluating Heads up

This source-checkout evaluation tests whether the observer should raise a notice
on a bounded coding transcript, not whether its UI renders or whether a complete
coding agent solves a task. The [feature spec](../specs/heads-up-observer.md)
documents runtime behavior; existing lifecycle/UI tests cover that separately.

## Zero-cost checks

From the repository root:

```sh
npm run test:heads-up-eval
npm run eval:heads-up
```

The first command typechecks the evaluator and runs its deterministic regression
tests plus the observer's context/controller/extension tests. The second validates
and lists the synthetic corpus. Neither creates a model runtime or calls a model.
Fixture-oracle self-tests validate the grader, **not** real-model quality.

## Evaluate the real model

```sh
npm run eval:heads-up -- --live

# A small smoke run, or rerun one failure:
npm run eval:heads-up -- --live --case api-break --case api-approved

# Check variability across three independent passes (34 x 3 = 102 requests):
npm run eval:heads-up -- --live --repeat 3 --max-calls 102

# Compare explicitly selected providers/models, with a total-request budget:
npm run eval:heads-up -- --live --model provider-a/model-a \
  --model provider-b/model-b --max-calls 68
```

Without `--model`, the evaluator imports the feature's initial model reference
(`openai-codex/gpt-6-luna` at implementation time).
`--model` is repeatable, up to
three exact references. Availability/authentication is checked through the normal
sessionless Pix model runtime, including installed provider extensions. There is
no automatic fallback, login, independent judge model, coding session or tool loop.
A missing catalog entry may trigger a bounded catalog refresh for that provider.

`--live` authorizes provider requests using the current Pi account. Only the
synthetic fixtures are passed to the observer; conversation histories are never
read. Provider discovery runs from an empty directory inside the report folder,
with no project instructions or skills. Existing Pix extension/provider discovery
and credential refresh can still perform their normal initialization. No active
conversation or its usage ledger is modified. Keep debug logging disabled when
testing providers that log requests themselves.

`PI_OFFLINE` forbids live runs even with `--live`. The default matrix cap is 34
inference calls (the full current corpus), checked before model setup. Repetitions are 1..5; the largest
explicit cap is 120 calls. Requests run sequentially with production prompt,
context builder, parser, 900 output-token budget, low reasoning, no tools, no
retries and no cache retention. The default timeout is 20 seconds. An explicit
`--timeout-ms` override (1000..120000) is recorded in the report and changes the
eval only, not the product. Budget and cadence of the interactive feature are not
applied to these independent fixtures; the CLI has its own whole-matrix cap.

Transport error, cancellation or timeout stops further requests. This prevents
overlap with a provider that ignores abort. Remaining cases are `not_run`, not
passes. Invalid JSON is a quality failure; it is never treated as correct silence.

## Corpus and scoring

The development corpus contains 34 hand-authored synthetic cases: fourteen
positive and twenty negative controls. Positives cover public API compatibility,
cross-tenant caching, migration data loss, duplicate billing, old config loading,
prohibited logging, preservation of requirements in a long conversation, the
opposite-direction async API contract, and two-/three-problem cases. Mutation-state
pairs distinguish proposed, applied, rejected, fixed, and explicitly approved
changes. Structured known-feedback and prior-notice controls exercise suppression.
Active-card fixtures cover retaining a supported subset while discovering a new
issue, and dismissing resolved cards. These are synthetic review fixtures,
not an evaluation of production cadence or an adaptive-frequency policy.
Negative controls cover a user-approved tradeoff, a fixed issue, an already-known
notice, benign changes, insufficient information, a failed edit, tool-output prompt
injection, agreed omission of tests, an unverified assistant claim, a changed task,
and redaction of synthetic secret/thinking/image canaries.

Three delegated fixtures use the production bridge reducer (not fabricated tool
results): a child reports a breaking async API despite “done/tests pass”; a matched
compatible child report stays silent; a final report that corrects the earlier
break and retests also stays silent. The parent context is identical in all three.
This tests reported-claim reasoning, not actual file mutation or test provenance.
Deterministic bridge/extension/controller tests cover ownership and delivery near
parent completion independently of inference quality.

Three additional research-child controls separate actor, scope and execution
time: parent execution passes after child-only research; parent execution evidence
is absent (unknown, not a failure); and an explicit parent run failure conflicts
with its success summary. The last rubric requires both the failed result and
the parent's claim, not the child's non-execution. Delegated reports remain
appended after parent records, matching production assembly; array position alone
does not establish cross-actor event chronology. Fixture/oracle tests validate
input and scoring, not whether a real model follows these distinctions.

## Delegated increment observation (2026-10-04)

A single bounded live Luna pass covered 21 fixtures: the three new delegated
controls passed, with the breaking-API notice correctly attributed to the child
report. Automated result was 20/21 (8/8 positive proxy matches, 1/13 false positives,
no invalid/error/unrun calls; p50/p95 2,770/4,751 ms). Manual review confirmed the
`failed-edit` false positive: it warned about a rejected change while acknowledging
that the current source was unchanged. The `api-break` proxy match also reversed
the requested direction, so it is not a semantic success despite matching IDs and
keywords. Do not equate this result with production readiness or verified mutation
coverage. Retained run: `.pi/artifacts/heads-up-eval-2ZKA7s/report.md` (disposable).

The production context builder bounds/redacts messages; the production inference
function sends the prompt; the production parser validates the reply and evidence
IDs. Expected labels, reference answers, scenario names and grading instructions
are not sent to the model. Previous notices are input only in the feedback case.
References are checked *after* context budgeting so lost required evidence cannot
silently make a positive fixture impossible.

A positive `tp` requires a valid warning, required supporting sources and all
configured consequence-anchor groups for each one-to-one matched issue. Each
anchor group accepts several English or Russian substrings. This is a **lexical
proxy**, not proof that the explanation is correct. Real IDs alone are not proof
either. A correct paraphrase can fail the proxy; conversely, a misleading warning
containing the right words can pass. A targeted regression catches the previously
observed reversed API-direction wording; it is a narrow lexical tripwire, not a
general semantic judge. Human reviewers must verify contract direction (what was
required versus what changed), whether a mutation was actually applied, whether a
rejected mutation left current state unchanged, whether later fixes resolve it,
and whether explicit user approval supersedes the concern. Read all emitted cards,
including automated passes; automated match scores do not assess semantic truth.

The production reply contains a bounded `notices` array (up to three) and can
review existing cards while discovering others. Positive scoring requires a
one-to-one matching between expected and emitted notices; order is irrelevant, but
missing, detected duplicate, or extra cards fail. Retained IDs must match the
expected surviving card; a new issue cannot repurpose a resolved card's ID.
Duplicate structured identities or exact wording fail even if keyword groups
overlap. Detecting other semantic paraphrases still requires human review.
Active-card descriptors are untrusted
production-shaped input, never grading rubrics. Runtime deterministic tests cover
stack revalidation and selection separately. Historical live results below predate
the current prompt/schema/corpus and do not establish current model quality.

Report outcomes are `tp`, `tn`, `fp`, `fn`, `wrong_notice`, `invalid`, `error`,
`timeout`, `cancelled` and `not_run`. `wrong_notice` means rubric mismatch,
not an independent semantic verdict. Missing attributable usage is a transport or
accounting failure, matching the production controller's refusal to display it.

Metrics are deliberately separate:

- Precision proxy = `tp / (tp + fp + wrong_notice)`; it is `null`/`n/a` when no
  notice was emitted. Recall = `tp / all planned positive cases`, conservatively
  including failed/unrun positives. An always-silent model therefore fails.
- False-positive rate = `fp / planned negative cases`; correct-silence rate =
  `tn / planned negative cases`. Inspect these together with coverage: failed
  negative requests are not evidence that a model knows when to remain silent.
- Valid-response coverage, per-case latency, p50/p95 latency, input/cache/output
  usage and provider-reported cost remain separate. Zero reported cost does not
  imply free subscription usage; missing usage is explicit and not reconstructed.

**Read every emitted notice, including automated passes.** Check whether it names
the actual consequence, attributes the change to the correct actor/time, avoids
unsupported claims, and warrants interrupting the user. Record accept/reject/unsure
with a reason beside each notice. Do not call this small development set a
held-out benchmark or extrapolate its precision to real coding sessions. Keep the
same corpus/prompt/config hashes when comparing runs; after tuning on failures,
add fresh cases before claiming generalization.

## Reports and exit status

Each live run creates a unique `.pi/artifacts/heads-up-eval-*/` with:

```text
results.jsonl     Incremental visible responses and results
inputs.json       Sanitized model inputs and separate, model-hidden rubrics
report.json       Results, metrics, served model, config and source hashes
report.md         Readable comparison plus all responses, including passes
empty-workspace/  Provider-discovery cwd; no session transcript
```

JSON metadata records selected models, repetitions, code hashes, corpus hash,
system-prompt hash, Git HEAD, timing and whether hashed files changed during the
run. The Git commit alone is insufficient for an uncommitted worktree. Reports
exclude hidden reasoning, credentials, headers and raw provider errors. They are
local scratch artifacts subject to Pix cleanup; copy reports elsewhere before
their TTL expires when retaining benchmark evidence.

Exit 0 means fixture validation or all **automated** live checks passed, not
production readiness. Exit 1 means a quality/rubric failure. Exit 2 means invalid
arguments, unavailable credentials/model, incomplete execution or source drift.
An interrupted process may only leave `results.jsonl`.

## Initial observations (2026-10-04)

Two real runs used `openai-codex/gpt-6-luna` with the unchanged production prompt,
900 output tokens, low reasoning and a 20-second timeout. Each sent 18 requests.
Both produced seven warnings and eleven correct abstentions, with no invalid
JSON, provider errors or timeouts. The datasets are synthetic development cases,
not independent evidence about real-session precision.

The first run (`heads-up-eval-MAKCU0`) scored 17/18 automatically. Its config
warning correctly identified `TypeError`, but the evaluator's initial lexical
anchor list did not recognize that spelling. The anchors were corrected and
an equivalent-exception-wording regression test was added. The first report was
not rewritten. No production prompt or detector code was tuned between runs.

The second run (`heads-up-eval-XZ9BeO`) scored 18/18 automatically. It reported
10,826 input/cache tokens, 629 output tokens, nearest-rank p50 latency 2,985 ms
and p95 latency 4,176 ms. These are observations from this run, not a
general latency/cost guarantee. Both run folders are under `.pi/artifacts/` and
are disposable; the meaningful conclusions are recorded here for retention.

Reading the responses exposed a limitation hidden by the automated score:
`api-break` in the second run warned that *returning to a synchronous User would
change the public API*, treating the current async implementation as the baseline.
The intended warning was that the new async implementation violates the user's
protected synchronous contract. The right terms and IDs were present, so lexical
checks passed despite the reversed framing. The first run also had questionable
framing in both API scenarios. In the second run, six of seven notices, including
`long-session-api`, were accepted in this assistant-assisted semantic review;
`api-break` was rejected for reversed framing. These are reviewer judgments,
not user feedback or a statistically validated precision estimate.

Thus the evaluator already detects both grader gaps and misleading explanations.
Automatic 18/18 is not a rollout approval: preserve the failing wording as a
qualitative regression and inspect semantic framing on future runs.
