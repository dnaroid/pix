# Context Gateway P01-N Native Compact measurement

<!-- markdownlint-disable MD013 -->

> Status: P01-N paired/observe evidence is recorded; native-recovery provenance has explicit validation limitations. **P01-R storeless hardening is planned independently; P02 is deferred**, not the entire roadmap. No new implementation or live evaluation is performed by this documentation revision.
> Repository baseline: `daa1b06`, Pi SDK `0.85.1`, 7 September 2026.

## What is measured

P01-N separates three effects that must not be attributed to one another:

1. **Historical Baseline prompt** — the pre-trim repo tool guidance measured before `daa1b06`.
2. **Prompt Compact** — current repo descriptions/snippets/guidelines, with the historical runtime behavior (`repoDiscovery.profile=baseline`).
3. **Native Compact** — the same current prompts plus `repoDiscovery.profile=native-compact`.

The historical pre-trim Baseline prompt is not reconstructed by loading the entire previous extension commit in live evals. The previous commit differs in code outside repo prompt text, so doing that would confound the comparison. Historical prompt size is retained as a separate textual baseline; live paired evaluation compares current Prompt Compact against current Native Compact on the same codebase.

## Deterministic offline paired corpus

Executable evidence: `test/context-gateway/benchmark.test.ts`.

The corpus exercises five repo paths with fixed critical facts:

- semantic search followed by one narrow `--include-content --max-files 1` call;
- structure with a native `--cursor` continuation;
- AST with a native `--cursor` continuation;
- signature-first explain;
- shallow deps.

It is intentionally synthetic. It proves runtime byte/cursor/refusal behavior and deterministic critical-fact recovery, not model judgment or production latency.

| Metric | Historical/Prompt runtime baseline | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Repo prompt guidance chars | 3326 historical | 2294 current | -1032 (-31.0%) |
| Delivered repo-result bytes | 71,025 | 27,519 | -43,506 (-61.25%) |
| Tool calls | 6 | 8 | +2 |
| Continuation calls | 1 | 3 | +2 |
| Native policy refusals | 0 | 0 | 0 |
| Full overrides | 0 | 0 | 0 |
| Critical facts recovered | 8 / 8 | 8 / 8 | unchanged |

The Native Compact byte ratio in this corpus is `0.3874551214` of baseline. The extra calls are the cost of using native continuations instead of receiving the broad structure/AST output in one response.

Prompt Compact is runtime-equivalent to Baseline in this offline corpus by construction: prompt text is not a model and therefore cannot change tool selection in a deterministic wrapper-only test. That distinction is explicit so prompt savings are not misreported as runtime shaping.

## Runtime policy evidence

Executable evidence: `test/repo-native-compact.test.ts`.

- default profile remains `baseline`;
- Native Compact compact delivery is bounded to 400 lines / 12 KiB;
- explicit `outputMode=full` is bounded to 2000 lines / 50 KiB;
- `--flag=value` is normalized before validation;
- duplicate, unknown, malformed, conflicting, and over-limit flags are refused before `idx` executes;
- native result schema uses integer/min/max bounds and does not rely on `execute()` alone for basic type constraints;
- final UTF-8 output is bounded after execution as well as native flags before execution;
- refusal metadata contains only allowlisted policy fields, not query/argv/body.

`test/context-gateway/observe.test.ts` additionally proves that observe telemetry accepts only allowlisted Native Compact policy outcomes and does not copy query/body or forged policy data from unrelated tools.

## Live paired gate

The eval harness now records result byte counts plus Native Compact refusals/full overrides/retry-after-refusal without recording result bodies. `test/evals/run-p01n-paired.ts` runs Prompt Compact and Native Compact in deterministic randomized order for the same model/case and reports:

- existing behavioral/tool-selection assertions;
- repo/tool-result bytes;
- parent/worker tokens;
- tool-call count;
- elapsed time;
- Native Compact refusals, full overrides, and retry-after-refusal count.

Run it only with an explicitly selected already-configured live model, for example:

```sh
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3' npm run evals:p01n
```

The command refuses to run when `PI_TOOLS_SUITE_EVAL_MODELS` is unset. Live model evaluation is intentionally not folded into ordinary deterministic tests.

### Authorized `zai/glm-5.3` result

The first authorized live run found a Native Compact refusal loop in `tool.architecture-first`: two over-limit compact `repo_structure --max-files 50` calls were refused and retried before the model settled on the compact limit. Model-facing schema/recovery guidance was tightened without changing the enforced ceilings, and deterministic policy tests stayed green.

The post-fix paired run passed every arm with zero refusals/full overrides/retry-after-refusal events. Aggregate results across the three paired cases were:

| Metric | Prompt Compact | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Repo-result bytes | 1,286 | 983 | -23.6% |
| Tool calls | 14 | 12 | -14.3% |
| Parent tokens | 179,855 | 207,611 | +15.4% |
| Elapsed time | 88.682 s | 96.219 s | +8.5% |
| Passed pairs | 3 / 3 | 3 / 3 | unchanged |
| Refusals / full / refusal retries | 0 / 0 / 0 | 0 / 0 / 0 | unchanged |

This closes the small live/task comparison gate, but it does not establish a universal token/latency effect: model behavior varied materially between repeated runs even with deterministic arm ordering. The evidence supports keeping Native Compact available and bounded, not claiming that it always lowers total task cost.

## Authorized observe residual evidence

Three newly-created synthetic `zai/glm-5.3` sessions ran with `contextGateway.mode=observe`, Native Compact enabled for `repo_*`, and `maxResultBytes=8192`. The test-only recorder uses the same `ContextGatewayTelemetry` implementation as the extension and persists only its aggregate snapshot.

The expected residual classes were all observed as upstream-truncated and over budget: built-in `Read` delivered 52,153 content bytes, shell 52,211, and real `ast_grep` 52,040. Potential content bytes above the 8 KiB observation budget were 43,961, 44,019, and 43,848 respectively. No tool arguments or result bodies are stored in the observe report.

Metadata is also material: the corresponding `detailsBytes` were 52,280, 52,368, and 52,531. Direct installed-SDK contracts show why: truncation details include a `truncation.content` string duplicating the already-delivered truncated text. This duplication is now handled by a cheaper optional result-metadata normalizer before any durable store work; the module is disabled by default and activates only through the existing suite `modules` opt-in surface.

The current DCP sidecar is not used as evidence for this optimization. Its persistence format already compacts away tool output/details, and DCP is expected to be redesigned separately. The relevant surfaces here are Pi session JSONL, in-memory tool-result metadata, checked provider serialization, renderers, and generic downstream result observers.

The Read and ast-grep task assertions passed. The shell session made one extra unrelated tool call after the valid shell observation, so task compliance failed while the shell observation itself remained valid. The observe runner now keeps those statuses separate.

The follow-up `truncation-metadata-normalizer` is separate and disabled by default. It removes `details.truncation.content` only for the measured tool names when the SDK-shaped fields and delivered prefix match; unknown names and nonmatching metadata are skipped. Arbitrary tool overrides matching those names are not independently certified. In a persisted fixture the duplicate sentinel falls from two copies to one and JSONL shrinks by more than 20 KiB, preserving structural fields and visible content. The checked OpenAI-completions payload is exactly equal. These are serialized metadata savings, not measured provider-token or heap savings. Gateway off/observe alone remain byte-preserving; an explicitly enabled normalizer is a separate transforming arm. Renderer/final-pipeline/security/lifecycle checks were subsequently completed in P01-R R-B/R-F; the final storeless release scope and rollback are recorded in `context-gateway-p01r-rg-evidence.md`.

## Guarded native recovery evidence

The next synthetic gate asked whether a fact hidden by a large first result can be recovered without a new durable Gateway source. The saved guarded report `test/evals/artifacts/context-gateway-recovery-2026-09-07T18-32-36-215Z/context-gateway-recovery-report.json` records:

| Case | Task assertion | Saved strategy assertion | Tool sequence | Aggregate parent tokens |
| --- | --- | --- | --- | ---: |
| Read offset | PASS | PASS (v1 validator) | Read → Read → Read | 213,135 |
| Bash temp output | PASS | FAIL | Bash → Read | 75,253 |
| ast_grep temp output | PASS | FAIL | ast_grep → Read | 81,861 |

The producer source fixtures were configured for deletion after the initial Bash/ast-grep result, and the v1 evaluator had a real `Read.file_path` versus `path` bug. R-A now replaces that logic with validator/report v2: exact producer call/result correlation, exact issued native handle, result-before-Read order, successful producer/Read outcomes, fact-bearing native source/read result, exact native offset hint for Read continuation, verified synthetic cleanup, and explicit task/observation/availability/strategy statuses. However, the saved v1 aggregate lacks the transient handle/Read args/probes needed by v2, so it cannot be replayed into a corrected live result. All three saved recovery strategies are therefore **unknown under v2 provenance**. The old report is not rewritten; a new v2 live run would require separate authorization.

R-A deterministic evidence is recorded in `docs/context-gateway-p01r-ra-evidence.md`. Focused offline validation passes 17 tests / 105 assertions and records source/harness/corpus/validator identities without raw paths/body in final reports.

The evidence is consistent with useful native recovery but does not prove universal storage redundancy, cheap recovery, or durable temporary files. The token figures include aggregate parent usage, not a direct measure of recovery-only input or money. First-result size, repeated delivery, metadata/JSONL size, provider traffic, and historical availability remain separate questions.

## P02 decision status

**P02 remains deferred.** Existing evidence does not justify the new durable-store complexity. The independent P01-R storeless branch was subsequently completed: Native Compact and the metadata normalizer remain explicit opt-in features, test/build parsing remains observe-only, and the other measured surfaces remain passthrough/limited. Completion of P01-R does not unlock P02.

Likely residual classes remain only candidates, not proven P02 requirements: generic built-in `read` after its own truncation boundary, shell output where the native temp handle is insufficient for desired history semantics, arbitrary custom tools, and child browser/subagent artifacts. MCP remains unsupported in the current Pix adapter and therefore cannot be used as evidence for a Gateway adapter.

Revisit P02 only for a concrete task demonstrating incremental value from new snapshot/lifetime semantics over the checked storeless alternatives. Native recovery may be correct but still too costly; failure is not the sole qualifying condition, and high cost alone does not prove a durable store will help. Record the narrower scope, comparison, uncertainty, and separate implementation authorization. Plan 32 owns the new DCP/session-recovery implementation without sidecar or legacy; P07 is only a future Hybrid integration gate.
