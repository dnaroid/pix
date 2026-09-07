# Context Gateway P01-R / R-G storeless release evidence

<!-- markdownlint-disable MD013 -->

> Scope frozen before the R-G measurement gate on 7 September 2026.
> Repository HEAD: `daa1b06`; tested source tree is dirty and earlier live run identities must not be inferred from HEAD alone.
> This document does not authorise Context Gateway enforce mode or P02 durable storage.

## Scope fixed before measurement

The candidate storeless release is deliberately small:

| Surface | Decision for R-G | Runtime effect |
| --- | --- | --- |
| Context Gateway observe | Keep available, `off` by default | Aggregate measurement/classification only; no result replacement or archive. |
| `repo_*` Native Compact | Accept as explicit opt-in profile | Existing bounded native flags/cursors/validation; no store. |
| `truncation-metadata-normalizer` | Accept as separate explicit opt-in module | Removes only proven duplicate truncation metadata for measured Read/shell/ast_grep shapes. |
| test/build parser | Keep observe-only | Safe classification/metrics only; no result replacement. |
| mutation/LSP | Native passthrough | Existing outcome/diagnostics behavior only. |
| web/document | Native passthrough / limited | No second fetch, no archive. |
| structured JSON | Native passthrough / limited | No generic parse/rewrite. |
| subagent result | Native passthrough / producer-managed lifetime | No parent grant or lifetime extension. |
| images | Native passthrough | No text replacement. |
| direct browser / MCP | Unsupported | Not in the claimed denominator. |

Provider-specific equality claims are limited to the installed OpenAI-completions
serialization path already exercised by the deterministic harness. UI claims are
limited to the current TUI result renderers and the existing ACP/Desktop lazy
persisted-result flow. Native temp-output contents do not get a new UI/ACP reader.

## Metrics and release criteria fixed before measurement

R-G evaluates the following dimensions independently:

- task/fact correctness and execution outcome;
- initial delivered result bytes and all continuation/recovery calls;
- JSONL/details bytes for metadata-only cleanup;
- actual checked provider payload equality/usage rather than converting metadata
  bytes into token estimates;
- tool-call/refusal/retry counts and elapsed time for model-driven evidence that
  already exists;
- parser/capability CPU work through explicit scan/output bounds rather than a
  claim based on one timing sample;
- native temp/current-file/index lifetime limitations and unavailable recovery;
- unsupported paths and failures remain in the report rather than being removed
  from the denominator.

There is no aggregate batch-budget claim. P00 proved stable per-call identity and
source-order delivery, but not a host API that supplies a durable whole-batch
budget before execution. Batch cost is therefore the sum of actual per-result
traffic/calls in measurements.

## Measurement results

The measurements below were run after the scope and criteria above were written.

### Native Compact deterministic paired corpus

`PI_CONTEXT_GATEWAY_BENCHMARK_REPORT=1 bun test test/context-gateway/benchmark.test.ts`
compares the historical baseline behavior with the current Native Compact profile
over search, structure, AST, explain and dependency scenarios. All eight critical
facts are recovered in both arms.

| Metric | Baseline | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Delivered repo bytes including continuations | 71,025 | 27,519 | **-61.25%** |
| Tool calls | 6 | 8 | +2 |
| Continuation calls | 1 | 3 | +2 |
| Refusals | 0 | 0 | 0 |
| Full overrides | 0 | 0 | 0 |
| Critical facts | 8/8 | 8/8 | equal |

This is the expected trade-off for narrow native paging: substantially fewer
delivered bytes, but potentially more calls. It is not evidence of lower total
model cost by itself.

### Historical model-driven paired evidence

The retained `zai/glm-5.3` paired report
`test/evals/artifacts/p01n-2026-09-07T17-30-21-479Z/p01n-paired-report.json`
contains three Prompt Compact / Native Compact pairs; all **6 arm-runs passed**.
It predates R-A v2 source/corpus identity, so R-G uses it only as historical
model-behavior/cost evidence rather than pretending it certifies the current dirty
tree byte-for-byte.

| Aggregate metric | Prompt Compact | Native Compact | Delta |
| --- | ---: | ---: | ---: |
| Repo-result bytes | 1,286 | 983 | **-23.6%** |
| All tool-result bytes | 9,737 | 9,149 | **-6.0%** |
| Tool calls | 14 | 12 | **-14.3%** |
| Parent tokens | 179,855 | 207,611 | **+15.4%** |
| Parent cost | $0.0682 | $0.0923 | **+35.4%** |
| Elapsed | 88.682s | 96.219s | **+8.5%** |
| Native refusals / full overrides / refusal retries | 0 / 0 / 0 | 0 / 0 / 0 | equal |

The live evidence therefore argues **against** making Native Compact the default:
repo traffic improved, but total token/cost/latency did not consistently improve.
It remains a useful explicit opt-in for workloads where repo-result volume is the
binding constraint.

### Metadata normalizer

The normalizer changes only `details.truncation.content` on proven Read/shell/
`ast_grep` SDK shapes. A deterministic 24,007-byte duplicate fixture measured:

| Metric | Raw | Normalized | Delta |
| --- | ---: | ---: | ---: |
| Serialized tool-result JSON | 48,396 B | 24,376 B | **-24,020 B (-49.6%)** |
| Ten identical persisted results | — | — | **240,200 B avoided** |

The actual SDK fixtures in R-B also remove more than 40 KiB of duplicated metadata
from large Read/Bash results while preserving visible content and structural
truncation fields.

This is deliberately reported as JSONL/metadata savings only. The installed
OpenAI-completions serialization contract is byte-equivalent before/after cleanup
because tool-result `details` are not serialized to that provider payload. R-G
therefore claims **no token, cache or model-quality saving** from the normalizer.

An additional 52,000-byte duplicate sample, matching the approximate size of the
live observe residual details, measured `104,408 → 52,395 B` for the serialized
tool-result object and `52,279 → 266 B` for `details`: **52,013 B** removed while
visible content remained `52,035 B`. Seven reference-machine rounds of 10,000
normalizer calls on that sample measured approximately `3.5–4.3 µs/call`. These
timings are diagnostics, not a portable release threshold.

### Residual and negative corpus

The live observe-only residual run shows the measured large classes remain real:
Read/Bash/ast_grep each delivered roughly 52 KiB of result content and roughly
another 52 KiB of details at the checked boundary. The Bash task assertion failed
because the model made an extra call; the large Bash observation itself remained
valid. That failure stays visible rather than being removed from the denominator.

R-A–R-F deterministic contracts cover the rest of the offline release corpus:

- small/exact/control results and current-file Read continuation;
- Unicode/CRLF/long-line and changed file/index behavior;
- successful Bash/ast_grep native recovery plus missing/replaced temp output;
- timeout/abort/nonzero and unavailable structured recovery handles;
- parser middle failures, PASS→exit-1 conflict, ANSI/CR, mixed/compound commands,
  unknown formats and a bounded 1 Mi-character parser scan;
- mutation/LSP outcomes, web errors/cancellation, opaque large-integer JSON,
  subagent producer-managed artifacts, image passthrough and unsupported browser/MCP;
- late/reloaded/session-switched results, parallel calls and UI/history replay.

The test/build parser is bounded but remains observe-only. Its prospective compact
candidate is all-or-passthrough and must fit the configured result budget; no
runtime result delivery, provider traffic, calls or token usage are changed by it.
On a 4,550,063-character synthetic input the 1 Mi-character scan bound produced
`scan-limited / partial`; seven rounds of 100 parses measured about
`16.2–16.9 ms/call` on the reference machine. This is CPU/telemetry evidence only,
not a shaping or provider-saving claim.

## Live-run decision

R-G does **not** request another live model run for the selected release scope:

- the metadata normalizer is provider-invisible on the checked serializer and has
  deterministic JSONL/provider equality contracts;
- the test/build parser does not replace results;
- mutation/LSP, web/JSON/subagent/image surfaces remain native passthrough;
- Native Compact already has retained paired model-driven evidence, while all
  post-run changes relevant to this scope are deterministic policy/validation
  hardening rather than a new model-visible adapter.

The R-A v2 recovery runner remains available for a future claim that specifically
depends on exact model-driven native-handle recovery. Such a run still requires
separate authorization and must create a new v2-identity report. R-G does not
reinterpret the old v1 recovery reports as v2 passes.

## Release decision

Accept the verified storeless scope with conservative defaults:

1. **Context Gateway stays `off` by default.** Observe remains an explicit passive
   measurement mode; `enforce` remains unavailable.
2. **Native Compact is accepted only as explicit opt-in.** Default
   `repoDiscovery.profile` remains `baseline` because live total-cost evidence is
   mixed despite lower repo-result traffic.
3. **`truncation-metadata-normalizer` is accepted as a separate explicit opt-in.**
   It remains disabled by default and claims JSONL/metadata reduction, not token
   savings.
4. **Test/build parsing stays observe-only.** No production compact-result adapter
   is enabled without a proven recovery/lifetime contract for omitted data.
5. **Mutation/LSP, web/document, JSON, subagent and visual paths remain their R-E
   passthrough/limited decisions.** Browser/MCP direct adapters remain unsupported.
6. **P02 durable store remains deferred.** R-G found no task requiring new durable
   snapshot identity strongly enough to justify store/readers/quotas now.

Rollback is configuration-only for future calls: disable the normalizer module,
return `repoDiscovery.profile` to `baseline`, and/or set Context Gateway mode to
`off`. Rollback does not delete session history, native temp files, user data or
DCP state and does not require a manual sync operation.

## Deterministic R-G gate

The final gate reuses the independently proven R-A–R-F contracts rather than one
monolithic test process where unrelated LSP/AgentSession suites can interfere with
shared process/temp state. The required groups are:

- Context Gateway/storeless contracts, Native Compact, recovery validator/corpus,
  eval harness and coverage registry;
- ACP lazy history/replay and typecheck;
- root tab ownership/session UI contracts;
- suite/root `git diff --check` and source typechecks.

No new live model call, manual suite sync, durable store, reader tool or DCP change
is part of the R-G release gate.

The final external-suite P01-R gate is:

```text
bun test \
  test/context-gateway \
  test/repo-native-compact.test.ts \
  test/repo-discovery.test.ts \
  test/config.test.ts \
  test/evals/extension-contracts.test.ts \
  test/evals/harness.test.ts \
  test/evals/recovery-corpus.test.ts \
  test/evals/recovery-run-identity.test.ts \
  test/evals/recovery-report.test.ts \
  test/evals/recovery-validation.test.ts
```

Result: **144 pass, 0 fail, 1011 assertions**; suite typecheck and
`git diff --check` pass. Root SDK pin remains `0.85.1`; generated schemas are
unchanged when checked through `node --import tsx` (the sandbox blocks the normal
`tsx` CLI IPC socket), and root `tsc --noEmit` passes.

R-F's separate host/UI gates remain green: root TUI/session **98/98**, ACP lazy
current-result **4/4** plus an additional **6/6** persisted-history/request-boundary
suite and typecheck, and Desktop transcript/client **28/28** with Desktop check at
zero errors (two pre-existing accessibility warnings).
