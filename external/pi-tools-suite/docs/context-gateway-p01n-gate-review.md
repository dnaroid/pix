# Context Gateway P01-N gate review

<!-- markdownlint-disable MD013 -->

> Decision date: 7 September 2026.
> Baseline: repository `daa1b06`, Pi SDK `0.85.1`.
> Decision: **Do not start P02 immutable-store implementation now. The independent P01-R storeless track in plan 31 was subsequently completed without unlocking P02.**

## Scope of this decision

This is a gate decision, not a claim that a Gateway store will never be useful. The question is narrower: does the current evidence justify paying the P02 storage/security/quota complexity now?

It does not. Native Compact already removes a large fraction of deterministic repo-result delivery, while the remaining large result classes have not yet been shown to require durable artifact semantics rather than existing native paging/temp-output mechanisms. The authorized live paired gate also does not show a consistent total-cost win large enough to justify adding a store.

## Current Native Compact evidence

The existing paired synthetic corpus in `test/context-gateway/benchmark.test.ts` reports:

| Metric | Baseline / Prompt runtime | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Repo prompt guidance chars | 3326 historical | 2294 current | -1032 (-31.0%) |
| Delivered repo-result bytes | 71,025 | 27,519 | -43,506 (-61.25%) |
| Tool calls | 6 | 8 | +2 |
| Continuation calls | 1 | 3 | +2 |
| Policy refusals | 0 | 0 | 0 |
| Full overrides | 0 | 0 | 0 |
| Critical facts recovered | 8 / 8 | 8 / 8 | unchanged |

The byte ratio is `0.3874551214`. The reduction is therefore not free: structure/AST recovery uses additional native cursor calls. Those calls must remain in the total task cost instead of being hidden behind an initial-output-only metric.

The policy function itself is not a material processing bottleneck in the current synthetic microbenchmark. After warm-up, seven runs of 100,000 policy applications measured roughly `0.255–0.338 µs/call`, with six of seven runs around `0.255–0.267 µs/call`. This is only policy CPU overhead, not end-to-end tool, filesystem, provider, or task latency.

## Authorized live paired gate

The live gate was run with the explicitly authorized configured model `zai/glm-5.3`. Every Prompt Compact and Native Compact arm passed its behavioral assertions.

The first run exposed a real Native Compact recovery regression in `tool.architecture-first`: the model requested `repo_structure --max-files 50` twice in compact mode, received two `compact-limit-exceeded` refusals, retried with `20`, and also issued an unrelated `repo_architecture outputMode=full`. That arm used 10 tool calls versus 4 for Prompt Compact and 120,336 versus 64,731 parent tokens. This violated the P01-N acceptance rule against refusal/retry loops.

Native Compact model-facing argument guidance was then tightened without changing policy ceilings or refusal semantics: schema descriptions now publish the compact/full native limits and tell the model to correct the same rejected argument rather than broaden an unrelated tool. Deterministic policy tests remained green.

The authorized re-run removed the loop: all six arms passed with zero Native Compact refusals, zero full overrides, and zero retry-after-refusal events.

| Re-run aggregate | Prompt Compact | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Repo-result bytes | 1,286 | 983 | -303 (-23.6%) |
| Tool calls | 14 | 12 | -2 (-14.3%) |
| Parent tokens | 179,855 | 207,611 | +27,756 (+15.4%) |
| Elapsed time | 88.682 s | 96.219 s | +7.537 s (+8.5%) |
| Passed arms | 3 / 3 | 3 / 3 | unchanged |
| Refusals / full overrides / refusal retries | 0 / 0 / 0 | 0 / 0 / 0 | unchanged |

The per-case result is mixed rather than uniformly negative or positive. `tool.architecture-first` improved repo bytes (903 → 600), calls (8 → 5), and elapsed time (38.9 s → 30.9 s), but parent tokens still rose 67,019 → 86,298. `tool.semantic-repo-search` delivered the same 383 repo bytes while Native Compact used one extra tool call, about 10.2% more parent tokens, and about 22.8% more elapsed time. The known-file negative case preserved the required direct `Read` behavior.

These live numbers are model-run evidence, not a claim of deterministic causality: the same seeded case ordering produced materially different Prompt Compact call counts between runs. The correct conclusion is therefore that Native Compact is now behaviorally safe in this small gate, but not a proven total-cost win.

## Residual result classes after repo Native Compact

P00 capture fixtures prove that native truncation does not make every other result small. Using the same synthetic 2,100-line fixture shape:

| Path | Delivered bytes | Truncated | Full-output handle |
| --- | ---: | --- | --- |
| Built-in `read` | 36,053 | yes | no |
| Built-in `bash` | 36,152 | yes | yes, temp |
| `ast_grep` | 36,194 | yes | yes, temp |

These are real residual classes relative to an 8 KiB prospective Gateway inline budget, but size alone is not a P02 requirement.

- Built-in `read` already has exact `offset`/`limit` continuation; the unresolved question is historical/stable recovery, not whether current bytes can be paged.
- Built-in `bash` already preserves a temp full-output path on successful truncation; the unresolved question is whether task quality or resume semantics require a durable permitted snapshot instead.
- `ast_grep` already preserves a complete temp output artifact when truncated and can be captured in its suite-owned wrapper before truncation; a new store must demonstrate incremental value over that path.
- `repo_*` broad output is already the main Native Compact target and should not be counted again as Gateway savings.

## Authorized observe residual gate

The explicitly authorized `zai/glm-5.3` observe run used three newly-created synthetic sessions with `contextGateway.mode=observe`, `repoDiscovery.profile=native-compact`, and an 8 KiB observation budget. The persisted report contains only aggregate Context Gateway telemetry; raw result bodies, tool arguments, project paths, and archive references are not written to the report.

| Observed class | Result content bytes | Details bytes | Upstream-truncated | Over 8 KiB | Potential content bytes over budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Built-in `Read` / `code-read` | 52,153 | 52,280 | 1 | 1 | 43,961 |
| Built-in shell / `shell` | 52,211 | 52,368 | 1 | 1 | 44,019 |
| Real `ast_grep` / `ast-grep` | 52,040 | 52,531 | 1 | 1 | 43,848 |

The `Read` and `ast_grep` task-level assertions passed. The shell task produced the expected single successful, upstream-truncated shell result and then one unrelated small `other` error result, so its strict "one tool call only" task assertion failed. That extra result is kept visible rather than hidden, but it does not invalidate the measured shell residual class. The observe runner now reports `taskPassed` and `observationValid` separately so future evidence cannot confuse prompt compliance with telemetry validity.

The run also exposed a cheaper residual than a new store: current SDK truncation details retain `truncation.content`. Direct SDK contracts confirm that this field contains the large already-delivered prefix/tail again for built-in `read`, built-in `bash`, and the suite `ast_grep` wrapper. In the observe samples this makes `detailsBytes` roughly the same size as the delivered content. The checked OpenAI-completions serializer does not send tool-result details to the provider, but persisted session JSONL and in-memory downstream result metadata still carry that duplication. Current DCP sidecar persistence is explicitly not a decision input here: its serializer already strips output details, and DCP is scheduled for a separate redesign. Before P02, prefer a result-metadata normalization path that removes only redundant `truncation.content` while preserving structural truncation fields and generic downstream-observer behavior.

## Why P02 does not start yet

P02 introduces durable sensitive-data storage, session/workspace authorization, immutable publication, hash validation, cross-process quota reservations, platform-specific atomicity/sync behavior, and later reader lifecycle obligations. The current evidence does not yet show enough residual task-level value to justify those costs.

The observe-residual requirement is satisfied for the measured synthetic `Read`, shell, and `ast_grep` sessions, not for all production workloads. The metadata-normalization follow-up is a separate **opt-in module disabled by default**. It removes `details.truncation.content` for the measured tool names when the SDK-shaped metadata and delivered prefix match. Unknown names and nonmatching shapes are skipped; a matching name/shape is not proof of the provenance of an arbitrary replacement tool, which remains a P01-R compatibility boundary. Existing contracts show more than 20 KiB of JSONL fixture reduction with unchanged visible content, structural truncation fields, and checked OpenAI-completions payload. This is serialized metadata savings, not demonstrated provider-token or heap savings. Gateway off/observe alone remain non-transforming; an explicitly enabled `observe + normalizer` arm intentionally changes details and must be labeled separately.

The saved guarded recovery report has three passing task assertions and sequences `Read → Read → Read`, `Bash → Read`, and `ast_grep → Read`. It predates R-A validator/report v2. Although the Bash/ast-grep harness was configured to delete the producer sources and the old validator had a real `path` versus `file_path` bug, the aggregate report does not retain the transient producer handle, exact Read arguments/result correlation, or native continuation hint required by v2. Therefore **all three historical recovery strategies are unknown under the R-A provenance contract**, including the old Read-offset strategy that v1 labeled PASS. The original report remains unchanged.

This supports investigating native recovery, not a universal conclusion that storage is unnecessary. A correct recovery can still incur expensive repeated delivery; three synthetic successes do not establish temporary-output durability, satisfactory first-result size, or total-cost improvement.

The following evidence is still required before reversing this No-Go:

1. Establish a reproducible task and reliable provenance/oracle where the checked storeless path is insufficient: correctness, required historical lifetime, or unacceptable total delivery/cost despite successful recovery. A recovery failure is not a mandatory prerequisite, and a large first result alone is not sufficient evidence.
2. Explain why cheaper native scope/range controls, metadata cleanup, existing permitted outputs, and retrieval of actually persisted session text do not satisfy that task. Do not assume the future plan-32 runtime already exists or that JSONL recovers bytes never persisted there.
3. Propose a limited P02 adapter/lifetime scope and evidence that new snapshot semantics add value. Compare against the checked storeless control, count all recovery/latency, and report model variance. Unsupported paths are listed explicitly, not claimed as protected or used as measured savings.
4. Record the decision and obtain separate implementation authorization. Only relevant R-A/R-B/R-C/R-G contracts are prerequisites; P02 does not require completing every optional storeless investigation or the DCP rewrite.

## Decision

**P02 remains deferred; the P01-R storeless branch is complete.** Keep store-backed enforce disabled. Do not create the immutable store, artifact readers, quotas, catalogs, or retention machinery under a different name merely to advance the roadmap. The final P01-R release decision keeps Native Compact and the metadata normalizer explicit opt-in, test/build parsing observe-only, and the other measured surfaces passthrough/limited; see `context-gateway-p01r-rg-evidence.md`. None of that is a Go for P02.

Plan 32 owns the new DCP journal, session-recovery pagination, and removal of the sidecar/legacy machinery. It is independent of the completed P01-R branch. P07 remains only a conditional integration gate for a future claimed Hybrid profile. No new validator-v2 live recovery run, user-config change, or manual synchronization was required for the P01-R release scope.

## Verification used for this review

- `PI_CONTEXT_GATEWAY_BENCHMARK_REPORT=1 bun test test/context-gateway/benchmark.test.ts` — 2 pass, 0 fail; report values above.
- `bun test test/repo-native-compact.test.ts test/context-gateway/benchmark.test.ts` after the refusal-loop guidance fix — 12 pass, 0 fail, 108 assertions.
- `npm run typecheck` in `external/pi-tools-suite` — pass.
- Policy-only synthetic microbenchmark: seven rounds × 100,000 calls after warm-up; results stated above.
- Authorized live reports: `test/evals/artifacts/p01n-2026-09-07T17-23-48-741Z/p01n-paired-report.json` (regression discovery) and `test/evals/artifacts/p01n-2026-09-07T17-30-21-479Z/p01n-paired-report.json` (post-fix gate).
- Authorized observe report: `test/evals/artifacts/context-gateway-observe-2026-09-07T18-00-44-288Z/context-gateway-observe-report.json`; three expected residual classes were observed without persisted raw bodies.
- Optional non-store normalizer: `src/truncation-metadata-normalizer/index.ts`, disabled by default. `test/context-gateway/metadata-normalization.test.ts` plus the SDK pipeline contract prove conservative matching, JSONL reduction, unchanged visible content, generic downstream-observer compatibility, and a byte-equivalent checked provider payload.
- Guarded native-recovery report: `test/evals/artifacts/context-gateway-recovery-2026-09-07T18-32-36-215Z/context-gateway-recovery-report.json`; preserved unchanged and treated as v2-provenance `unknown` for all three recovery strategies.
- R-A deterministic evidence: `docs/context-gateway-p01r-ra-evidence.md`; corpus/validator/report v2, transient exact-handle probe, source/run SHA-256 identity, negative fixtures and safe-report contract. Focused gate: 17 pass, 0 fail, 105 assertions; suite typecheck/diff-check pass; live runner remains fail-closed without an explicitly selected model.
- R-F lifecycle/UI evidence: `docs/context-gateway-p01r-rf-evidence.md`; Context Gateway lifecycle/result gate 49 pass, 0 fail, 337 assertions; root TUI/session 98/98; ACP lazy current-result 4/4 plus persisted-history/request-boundary 6/6 and typecheck; Desktop transcript/client 28/28 with zero check errors (two pre-existing accessibility warnings). No native-temp reader endpoint was added.
- R-G final storeless release evidence: `docs/context-gateway-p01r-rg-evidence.md`; external deterministic P01-R gate 144 pass, 0 fail, 1011 assertions, plus root schema/typecheck/diff hygiene. Storeless defaults remain conservative and no additional live model call was required for the accepted scope.
