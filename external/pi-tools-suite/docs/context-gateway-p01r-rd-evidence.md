# Context Gateway P01-R / R-D evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06` with a dirty tested tree.
> Scope: pure test/build parsing plus passive observe classification. Production tool-result delivery remains passthrough; no archive, reference, fetch, execution or LLM summary is introduced.

## Supported parser scope

R-D adds `src/context-gateway/test-output-parser.ts` as a pure in-memory parser for a deliberately small format set:

- Bun test terminal summaries (`pass`, `fail`, `Ran ... tests across ... files`) and exact failure/warning lines;
- TAP v13-style terminal plan/count summaries and exact `not ok` / diagnostic lines;
- bounded TypeScript compiler diagnostics plus an explicit terminal `Found N error(s)` summary.

The parser returns `recognised`, `partial`, or `unrecognised`. Host execution outcome remains authoritative; text does not turn an errored shell call into success. A failed test summary without an exact parsed diagnostic is not considered complete.

The parser's ANSI and bare-CR processing creates only an internal parsing view. It does not mutate the original tool result or claim source byte coordinates.

## Conservative failure rules

The parser/delivery planner intentionally falls back to passthrough when any of these conditions holds:

- SDK/upstream truncation is already reported;
- timeout/abort is visible;
- terminal summary conflicts with the host outcome (for example PASS summary followed by command exit 1);
- multiple recognised formats appear in one output;
- TypeScript pretty/source/caret lines remain unparsed;
- a failed summary has no captured exact failure diagnostic;
- the terminal summary is followed by significant unrecognised output;
- parser input exceeds the bounded scan budget (default 1 Mi-character); head/tail resemblance is not promoted to completeness;
- the originating shell command is compound or its scope is unknown;
- a prospective complete compact representation would exceed the configured byte budget.

Compound-command detection is transient and conservative. Observe stores only `simple / compound / unknown`, never the shell command text. False positives merely preserve passthrough; they never rewrite or block execution.

## Prospective compact delivery is all-or-passthrough

`planProspectiveTestOutputDelivery` is a decision helper, not a production shaper. For a complete recognised **simple** command it can build a candidate containing:

1. exact host outcome;
2. recognised format;
3. terminal summary counts;
4. every parsed mandatory error/warning line.

The candidate is accepted only when the entire representation fits the budget. Diagnostics are never sliced merely to hit a target. `partial` and `unrecognised` inputs have no generic head/tail summary path.

No runtime adapter consumes this candidate in R-D. The current Context Gateway `tool_result` handler still returns `undefined`, so delivered content stays byte-equivalent. Connecting a compact delivery requires a later explicit adapter decision with a recovery/lifetime mechanism appropriate to the omitted data. Native truncation alone is not that permission.

## Observe telemetry

Shell output is parsed transiently only while Context Gateway is in `observe` mode. The telemetry snapshot stores:

- parser version;
- classification and format counts;
- scan-limited count;
- terminal-summary / diagnostic / warning counts for the last observation;
- safe command-scope enum;
- prospective `compact-candidate / passthrough` decision and allowlisted reason.

It does **not** store command args, diagnostic strings, filenames from diagnostics, raw body, snippets, or hidden-fact fingerprints. Tests compare the input event before/after telemetry and prove it is not mutated.

## Corpus cases

The deterministic corpus covers:

- complete Bun success;
- a Bun error in the middle of output plus a warning and later passing test;
- PASS summary followed by host exit 1;
- timeout;
- upstream-truncated output;
- ANSI and bare-CR overwrite;
- TAP failure with exact diagnostics;
- compact TypeScript diagnostics and a pretty/unparsed partial case;
- mixed/nested recognised formats;
- unknown custom build output;
- compound and unknown command scope;
- an intentionally huge output exceeding the parser scan bound;
- prospective output that fits the byte budget and the same mandatory diagnostics under a too-small budget.

These are format contracts, not claims that every Bun/TAP/TypeScript version is supported. Unknown variants remain passthrough.

## Deterministic gate

```text
bun test \
  test/context-gateway/test-output-parser.test.ts \
  test/context-gateway/observe.test.ts \
  test/evals/harness.test.ts
```

Result: **28 pass, 0 fail, 152 assertions**.

Additional checks:

- `npm run typecheck` — pass.
- `git diff --check` — pass.

No live model call, manual sync, user config change, result replacement or new full-output archive was performed for R-D.
