# Context Gateway P01-R / R-A evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06`.
> Installed Pi SDK: `@earendil-works/pi-coding-agent` `0.85.1`.
> Scope: deterministic recovery provenance, run identity and native capability accounting only. No new live model run was performed for R-A.

## Result

R-A's deterministic infrastructure is complete. Future recovery runs use corpus v2,
validator v2 and report v2. Exact producer-native-handle provenance exists only in
a disposable per-run probe file inside the synthetic fixture project. The final
report contains only status enums/booleans/counts, tool names and source-code/runtime
identity; it does not retain tool inputs, native paths, result bodies, artifact
contents or hidden-fact fingerprints.

This closes the validation flaw in the old runner, but it does **not** turn the
existing live report into a new successful run.

## Deterministic gate

```text
bun test test/evals/recovery-corpus.test.ts \
  test/evals/recovery-run-identity.test.ts \
  test/evals/recovery-validation.test.ts \
  test/evals/recovery-report.test.ts \
  test/evals/harness.test.ts
```

Result: **17 pass, 0 fail, 105 assertions**.

Additional checks:

- `npm run typecheck` — pass.
- `git diff --check` — pass.
- `npm run evals:context-gateway-recovery` without `PI_TOOLS_SUITE_EVAL_MODELS` — fail-closed with exit `2`.

## What validator v2 proves

For native temp-output recovery it requires one concrete producer call and matching
successful result, a producer-details `fullOutputPath`, a fact-bearing readable
native file, verified deletion of the synthetic source fixture, a later `Read`,
exact equality between that Read path (`path` or `file_path`) and the issued handle,
a successful Read result and the expected opaque fact in that Read result.

For native Read continuation it requires the same source path and the exact numeric
`Use offset=N to continue` hint from the preceding successful result. `offset > 1`
alone is no longer sufficient.

Negative fixtures reject:

- Read before the producer result;
- failed producer or failed recovery Read;
- unrelated temp paths;
- repeated producers;
- direct reads of the original producer source;
- full-output-looking text without a producer `details.fullOutputPath`;
- direct answer/guess without a recovery Read;
- unverified synthetic cleanup;
- wrong Read source or wrong continuation offset;
- unknown recovery case IDs.

## Corpus and run identity

The opaque expected values live in `recovery-corpus.ts`, not in prompts. Tests prove
that each value exists in its intended synthetic source and does not appear in the
case prompt or generated suite config.

Future report identity records:

- report/harness/validator/corpus versions;
- Git HEAD plus dirty/not-dirty state;
- SHA-256 of `index.ts`, the tested package source tree (`src/`, `index.ts`, `package.json`), harness runner, recovery runner, validator and corpus;
- installed Pi SDK version;
- Node/Bun/platform/architecture;
- effective storeless config and non-interactive Pi flags;
- model/provider and deterministic arm order.

The identity uses relative logical names plus code hashes, not host absolute paths.
This means a dirty source tree is identified by its tested bytes rather than by HEAD
alone, and the user's watcher is not evidence of which source revision a run used.

## Historical live report status

The saved guarded report at
`test/evals/artifacts/context-gateway-recovery-2026-09-07T18-32-36-215Z/context-gateway-recovery-report.json`
is retained verbatim. It predates the v2 transient provenance probe and safe identity.

Its task assertions/tool-name sequences remain historical observations, but exact
native recovery provenance is **unknown under v2** for all three cases:

| Case | Saved v1 task/strategy | R-A v2 interpretation |
| --- | --- | --- |
| `recovery.read-offset` | task PASS / strategy PASS | Unknown: saved report lacks the exact native offset hint and Read args/result chain needed by v2. |
| `recovery.bash-temp-output` | task PASS / strategy FAIL | Unknown: saved report lacks producer `fullOutputPath` and exact Read-handle correlation. |
| `recovery.ast-grep-temp-output` | task PASS / strategy FAIL | Unknown for the same reason. |

The earlier `path` versus `file_path` unit fix explains one validator bug, but is not
evidence that the old live Read used the exact producer-issued native handle. A new
v2 live run, if needed later, requires separate authorization and creates a new
timestamped report rather than rewriting the old one.

## Capability boundary

The current native recovery/lifetime matrix is recorded in
`test/context-gateway/p00-capabilities.md`. It explicitly distinguishes current-file
Read continuation, native index cursor, temporary full-output handle, persisted
session text and a future durable snapshot. Error/timeout/abort and expiry edge cases
that R-A does not certify remain R-C work.
