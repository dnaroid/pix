# Evaluation framework

## Purpose

The eval framework answers four different questions that ordinary unit tests do
not answer equally well:

1. Does every extension and model-facing tool still satisfy its deterministic
   contract?
2. Does a live model choose the right tool for the task instead of merely being
   capable of calling it?
3. Does the model follow a good coding workflow from investigation through
   verification, rather than reaching the right answer by a fragile sequence of
   guesses and patches?
4. Does orchestration improve quality or cost without introducing unnecessary
   delegation, retries, context growth, or latency?

The framework deliberately does **not** reduce all of these questions to one LLM
judge score. Correctness and safety invariants are machine-checked wherever
possible. Live-model evals are reserved for choices and workflows that cannot be
proved by deterministic tests alone.

The implementation lives under `test/evals/` and complements the existing unit,
integration, prompt-eval, browser-QA, and locate-benchmark suites.

## Design principles

### Deterministic facts are deterministic tests

Schemas, state transitions, routing precedence, persistence, retries, fallbacks,
security boundaries, parsing, cleanup, and other mechanical behavior should not
depend on a probabilistic judge. Existing focused tests remain the source of
truth for these contracts.

### Live evals test model behavior

Live cases are used for questions such as:

- should the model choose `repo_search` or a direct read?
- should a non-trivial task create a todo plan?
- should an expensive Sol parent delegate substantial implementation work?
- should Terra escalate a high-risk architecture decision?
- should a narrow local failure stay local instead of calling an oracle?
- did a coding agent reproduce the bug before editing and verify behavior after
  editing?

### Outcome beats narration

Coding-quality cases use executable broken repositories and post-run checks.
Passing typecheck, build, or lint alone is insufficient when the requested
behavior is still wrong.

### Negative controls are first-class

The suite checks both when a tool **should** be called and when it **should
not**
be called. This is important for cost control: an agent that delegates every
task can look capable while still being materially worse.

### Cost is measured separately from correctness

Correctness and safety are hard gates. Token usage, model cost, tool calls, and
wall-clock time are comparison metrics. A cheap failure is still a failure, and
a correct solution that becomes dramatically more expensive should be visible
in the report rather than hidden inside one aggregate score.

## Framework layout

```text
test/evals/
  cases.ts
  coverage-manifest.ts
  extension-contracts.test.ts
  harness.test.ts
  live-evals.test.ts
  run-evals.ts
  fixtures/
    coding-hypotheses/
    coding-regression/
    coding-async/
  harness/
    types.ts
    runner.ts
    assertions.ts
    metrics.ts
    report.ts
```

The responsibilities are intentionally separated:

- `cases.ts` contains live behavioral scenarios and their assertions.
- `coverage-manifest.ts` maps every extension and model-facing tool to the tests
  that cover it.
- `extension-contracts.test.ts` enforces coverage completeness and fills a few
  previously missing deterministic registration contracts.
- `harness.test.ts` tests the eval machinery itself.
- `live-evals.test.ts` exposes the live cases through Bun's test runner.
- `run-evals.ts` runs a matrix and writes JSON/Markdown comparison artifacts.
- `runner.ts` creates isolated fixture projects, launches Pi, records events,
  snapshots changed files, and collects metrics.
- `assertions.ts` converts case expectations into machine-checkable results.
- `metrics.ts` derives workflow, token, subagent, mutation, and timing metrics.
- `report.ts` produces the cross-model comparison report.

## Coverage gate

`coverage-manifest.ts` is a registry of deterministic and optional live coverage
for the suite.

Two invariants are enforced by `extension-contracts.test.ts`:

1. every extension registered in `src/index.ts` must have deterministic eval
   coverage;
2. every model-facing tool described by the suite must have deterministic eval
   coverage.

This is intentionally a maintenance gate. Adding a new extension or tool without
assigning it a contract causes the eval contract test to fail.

The current extension registry covers all 19 modules:

| Extension | Deterministic coverage | Representative live coverage |
| --- | --- | --- |
| `coding-discipline` | coding-discipline tests | coding-quality workflows |
| `ast-grep` | ast-grep tests | structural tool selection |
| `async-subagents` | core/tools/UI tests | Sol/Luna/Terra orchestration |
| `lsp` | LSP tests | deterministic only |
| `comment-checker` | comment-checker tests | deterministic only |
| `session-name` | session-name tests | deterministic only |
| `session-recovery` | recovery tests | overview-first recovery |
| `repo-discovery` | repo-discovery tests | search/architecture selection |
| `antigravity-auth` | provider/auth tests | deterministic only |
| `opencode-import` | import tests | deterministic only |
| `todo` | todo + persistence tests | plan creation / negative control |
| `model-tools` | alias/profile tests | direct small-task selection |
| `usage` | eval extension contracts | deterministic only |
| `web-search` | web-search tests | deterministic only |
| `dcp` | DCP prompt/pruning/state tests | existing prompt evals |
| `prompt-commands` | eval extension contracts | deterministic only |
| `skill-installer` | eval extension contracts | deterministic only |
| `credential-firewall` | firewall tests | deterministic only |
| `codex-reasoning-fix` | reasoning-fix tests | deterministic only |

The tool registry similarly covers `lookup`, `ast_grep`, `ast_apply`, all
subagent actions, all `repo_*` tools, `todo`, session tools, web tools, Claude
aliases, Codex aliases, and `compress`.

## Live case model

Each live case is an `EvalCase` with:

- a stable `id`;
- a category;
- a human description;
- a fixture project;
- a user prompt;
- optional model filters;
- optional fake indexed-repository support;
- optional tools that should be recorded but not executed;
- machine-checkable assertions;
- an optional custom validator for structured tool input.

Conceptually:

```ts
{
  id: "quality.behavior-over-structural-check",
  category: "coding-quality",
  fixture: "coding-regression",
  prompt: "Fix the rounding bug, reproduce it first, then verify behavior...",
  assert: {
    requireReproBeforeMutation: true,
    requireVerificationAfterMutation: true,
    maxMutations: 2,
    maxFilesChanged: 1,
    postRunCommands: [
      { command: "npm test" },
      { command: "node ...hidden-style boundary check..." },
    ],
  },
}
```

The prompt should describe user intent rather than naming the expected tool
unless naming the tool is itself part of the contract. This prevents a case from
passing merely because the answer was embedded in the prompt.

## Initial 20-case corpus

### Tool selection

- `tool.semantic-repo-search`: an unknown behavior owner should select
  `repo_search` before direct discovery.
- `tool.architecture-first`: a broad unfamiliar-repository overview should
  select `repo_architecture`.
- `tool.exact-literal-direct`: an exact literal lookup should avoid semantic
  and architecture-discovery overhead.
- `tool.ast-structural`: a syntax-aware structural query should select
  `ast_grep`.
- `tool.todo-plan`: non-trivial four-stage work should initialize synchronized
  todo state.
- `tool.session-recovery-overview`: lost context with no reliable search phrase
  should begin with `session_overview`.

### Coding quality

- `quality.two-hypotheses-before-fix`: reproduce and distinguish plausible
  causes before mutation.
- `quality.behavior-over-structural-check`: verify the behavioral claim instead
  of stopping at structural validity.
- `quality.async-stale-state`: cover stale async completion behavior, not only
  the success path.
- `quality.investigate-without-edit-probes`: investigate with evidence instead
  of using edits as diagnostic probes.
- `quality.counterexample-preserves-validation`: preserve nearby validation and
  explicitly check a boundary or counterexample.

### Orchestration and escalation

- `orchestration.sol-delegates-substantial` (Sol): the expensive parent should
  delegate substantial multi-file work.
- `orchestration.sol-keeps-tiny-edit` (Sol): a tiny known-file edit should stay
  in the parent.
- `orchestration.luna-delegates-substantial` (Luna): substantial implementation
  or research should use the configured worker tier.
- `orchestration.luna-escalates-high-risk` (Luna): high-risk cross-module or
  security work should trigger stronger review/deep escalation.
- `orchestration.terra-escalates-high-risk` (Terra): high-risk architecture or
  security uncertainty should escalate to stronger roles.

### Negative controls

- `negative.trivial-chat-no-tools`: prevents todo/compress/subagent overhead for
  trivial chat.
- `negative.known-file-read-no-oracle`: prevents planning/search/oracle
  overhead for one known-file fact.
- `negative.routine-local-failure-no-oracle`: prevents escalation for a
  straightforward locally verifiable test failure.
- `negative.small-known-edit-no-plan`: prevents todo/repo-search/subagent
  overhead for a tiny known-file edit.

## Coding-quality fixtures

The quality fixtures are deliberately small enough to understand but broken in
ways that distinguish disciplined debugging from lucky patching.

### `coding-hypotheses`

Symptom: a second checkout for the same user can reuse the first checkout's
idempotency key.

At least two plausible explanations exist from the task description:

- the retry-key cache identity is too broad;
- callers may be passing the wrong checkout identifier.

The baseline test fails. The intended workflow is to inspect/reproduce, gather
evidence that separates the hypotheses, make the smallest fix, and verify both
stable retry behavior and separate checkout identities.

### `coding-regression`

Symptom: percentage discounts can produce a one-cent overcharge because the
fixture rounds where the contract requires flooring.

The function also contains input validation that must not be weakened. This
fixture catches agents that make a superficially plausible arithmetic change
without checking behavioral boundaries or regression safety.

### `coding-async`

Symptom: an older profile request can resolve after a newer request and
overwrite
the latest state.

The public contract still requires each `load(userId)` call to resolve with its
own profile. The fix therefore has to distinguish return-value correctness from
shared-state freshness and verify the stale completion path explicitly.

All three fixture test suites are expected to fail before the agent changes the
repository. A fixture that starts green is not a valid bug-fix eval.

## Isolation and runner lifecycle

For each `(case, model)` pair the runner:

1. copies the selected fixture into a fresh temporary project;
2. snapshots ordinary project files before execution;
3. creates an isolated `.pi` session directory;
4. optionally marks the project as indexed and installs a deterministic fake
   `idx` executable for repository-selection cases;
5. writes a recorder extension that captures tool calls/results and final usage;
6. starts a real `pi` subprocess with the requested model and suite extension;
7. waits for completion or the per-case timeout;
8. snapshots the project again and derives changed files;
9. computes workflow/cost metrics;
10. evaluates assertions and post-run behavioral checks;
11. deletes the temporary project unless retention was requested.

The subprocess disables unrelated extension/skill/template/theme discovery so
the case measures this suite rather than ambient user configuration.

### Recorded-but-blocked tools

Some selection cases need to prove that a model **chose** a tool without paying
for or executing the next layer of work. `blockTools` records the call and then
returns a controlled block result.

Examples:

- `ast_grep` can be blocked after structural selection is observed;
- `subagents` can be blocked after delegation/escalation selection is observed.

This keeps selection evals focused and prevents nested model calls from making a
simple routing case unnecessarily expensive.

## Assertions

The shared assertion layer currently supports:

- required tools;
- forbidden tools;
- exact first tool;
- first tool from an allowed set;
- maximum tool-call count;
- maximum mutation count;
- maximum changed-file count;
- reproduction/verification before the first mutation;
- behavioral verification after the last mutation;
- required/forbidden output text;
- post-run commands with expected exit status;
- required post-run output text;
- custom case-specific validation.

The todo-plan case uses custom validation to check structured todo input: one
`batch_create`, four stages, exactly one `in_progress` item, and an explicit
final
report task.

## Workflow inference

The harness does not inspect private chain-of-thought. It infers observable
workflow from tool events.

Mutation tools currently include:

```text
edit / Edit
write / Write
apply_patch
ast_apply
```

Verification calls are shell-like tool calls whose commands visibly run tests,
checks, lint, typecheck, or similar verification commands.

This makes assertions such as `requireReproBeforeMutation` and
`requireVerificationAfterMutation` auditable without depending on model-written
prose.

The heuristic is intentionally conservative. If a new verification mechanism is
introduced, extend `metrics.ts` and add a harness regression test instead of
silently assuming the metric still means the same thing.

## Metrics

Each result records:

| Metric | Meaning |
| --- | --- |
| `elapsedMs` | wall-clock runtime for the model case |
| `toolCallCount` | total captured tool calls |
| `toolCalls` | ordered tool names |
| `failedToolResults` | tool results marked as errors |
| `mutationCount` | number of recognized mutation tool calls |
| `verificationCount` | number of recognized verification commands |
| `changedFiles` | project files whose content changed |
| `parentUsage` | parent token usage and provider-reported cost |
| `subagentUsage` | aggregate worker/subagent usage |
| `subagentCount` | number of detected subagent workspaces |

Parent usage is captured from the final `agent_end` event when available, with
session artifacts as a fallback. Subagent usage is collected from subagent
session artifacts under `.pi/subagents/`.

Provider cost fields are reported when the provider supplies them. A zero cost
does not necessarily mean a request was free; it may mean that the active
provider does not populate monetary cost metadata.

## Reports

`npm run evals:report` writes:

```text
test/evals/artifacts/<timestamp>/eval-report.json
test/evals/artifacts/<timestamp>/eval-report.md
```

The default artifact directory is ignored by Git.

The Markdown report contains a model summary table with:

- passed cases / total cases;
- parent tokens;
- worker tokens;
- provider-reported cost;
- tool calls;
- elapsed time.

It also lists every case with its tool sequence, changed files, token split, and
runtime. Failed assertions are expanded in a dedicated failure section.

The JSON report preserves the structured results for later statistical or CI
analysis.

## Running evals

### Deterministic coverage and harness tests

Run these on normal development changes:

```bash
npm run test:evals:contracts
```

This runs both the extension/tool coverage gate and tests for the harness
itself.
It does not call a live model.

The same tests are also included in the normal `npm test` traversal because they
live under `test/`.

### Live matrix through Bun tests

Set one or more models:

```bash
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3' \
  npm run test:evals:live
```

Multiple models are comma-, semicolon-, or newline-separated:

```bash
MODELS='zai/glm-5.3,'\
'openai-codex/gpt-5.6-luna,'\
'openai-codex/gpt-5.6-terra,'\
'openai-codex/gpt-5.6-sol'
PI_TOOLS_SUITE_EVAL_MODELS="$MODELS" \
  npm run test:evals:live
```

Cases with model filters only run for matching models. For example, Sol-specific
orchestration cases do not run against GLM.

### Comparative report runner

For model comparison, prefer the report runner:

```bash
MODELS='zai/glm-5.3,'\
'openai-codex/gpt-5.6-terra,'\
'openai-codex/gpt-5.6-sol'
PI_TOOLS_SUITE_EVAL_MODELS="$MODELS" \
  npm run evals:report
```

The process exits non-zero if any selected case fails.

### Run only one category

```bash
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3' \
PI_TOOLS_SUITE_EVAL_CATEGORIES='coding-quality,negative' \
  npm run evals:report
```

Valid current categories are:

```text
tool-selection
coding-quality
orchestration
negative
```

### Run named cases

```bash
PI_TOOLS_SUITE_EVAL_MODELS='openai-codex/gpt-5.6-sol' \
CASES='orchestration.sol-delegates-substantial,'\
'orchestration.sol-keeps-tiny-edit'
PI_TOOLS_SUITE_EVAL_CASES="$CASES" \
  npm run evals:report
```

### Other runner controls

| Variable | Purpose |
| --- | --- |
| `PI_TOOLS_SUITE_EVAL_TIMEOUT_MS` | per-case timeout; default 240 seconds |
| `PI_TOOLS_SUITE_EVAL_STREAM_IO=1` | stream child stdout/stderr while running |
| `PI_TOOLS_SUITE_EVAL_KEEP=1` | retain temporary projects for debugging |
| `PI_TOOLS_SUITE_EVAL_OUTPUT_DIR=/path` | choose report output directory |

## Existing prompt evals and benchmarks

The unified harness does not replace the older focused suites.

Use the existing prompt evals when changing the behavior they specifically
cover:

```bash
npm run test:prompt-evals
npm run test:prompt-evals:tool-selection
npm run test:prompt-evals:async
npm run test:prompt-evals:dcp
```

Use the locate benchmark for deeper repository-discovery efficiency comparisons:

```bash
npm run bench:locate
npm run bench:locate:analyze
```

The long-term direction is to share infrastructure where useful, but not to
discard specialized tests that measure a distinct contract well.

## Recommended model matrix

For changes to model discipline or orchestration, the useful comparison set is:

```text
zai/glm-5.3
openai-codex/gpt-5.6-luna
openai-codex/gpt-5.6-terra
openai-codex/gpt-5.6-sol
```

This matrix exposes several important regressions:

- a prompt improves GLM but makes Terra overthink simple tasks;
- Luna stops delegating substantial work;
- Terra escalates routine failures unnecessarily;
- Sol stops delegating expensive implementation work;
- Sol delegates tiny tasks and increases total cost;
- a cheaper route saves parent tokens but increases total worker tokens or
  wall-clock time enough to erase the benefit.

Model availability and authentication are environment-dependent. Live evals are
therefore opt-in rather than part of the normal deterministic gate.

## Interpreting results

Do not rank models by one scalar score alone. Read the report in this order:

1. **Hard correctness:** did the required behavioral/post-run checks pass?
2. **Safety and discipline:** were forbidden tools absent and file/mutation
   budgets respected?
3. **Workflow:** did the agent reproduce before editing and verify after editing
   where the case requires it?
4. **Delegation quality:** did orchestration occur only at the intended
   boundary?
5. **Cost:** how many parent and worker tokens were consumed?
6. **Latency:** did extra workers or retries materially increase wall-clock
   time?

A useful before/after comparison looks like:

```text
success rate        85% -> 95%
parent tokens       -38%
worker tokens       +19%
total tokens        -11%
tool calls          -14%
wall time           +6%
unwanted escalation 3 -> 0 cases
```

The framework currently reports the raw ingredients rather than inventing a
single weighted score. If an aggregate score is added later, hard correctness
and security failures should remain non-negotiable gates outside that score.

## Adding a new live case

1. Decide whether the behavior actually requires a live model. If a
   deterministic test can prove it, prefer the deterministic test.
2. Add or reuse a small fixture. A bug-fix fixture should fail before the agent
   acts.
3. Add a stable case to `test/evals/cases.ts`.
4. Express as much of the expected behavior as possible using shared assertions.
5. Use `postRunCommands` for executable correctness and hidden-style regression
   checks.
6. Add a custom validator only when structured tool arguments need inspection.
7. Add the live case ID to the relevant extension/tool entries in
   `coverage-manifest.ts`.
8. Run the deterministic harness tests before spending model tokens.
9. Run the smallest relevant model/category subset first.
10. Run the broader matrix before merging a prompt/routing change.

Good cases have one clear behavioral question. Avoid giant prompts that test
five unrelated policies at once because failures become hard to diagnose.

## Adding a new extension or tool

For a new extension:

1. add focused deterministic tests;
2. add the extension to `EXTENSION_EVAL_COVERAGE`;
3. add live cases only if model choice/workflow matters.

For a new model-facing tool:

1. add deterministic registration/execution tests;
2. add the tool to `TOOL_EVAL_COVERAGE`;
3. add positive and negative tool-selection cases when selection is non-obvious.

The coverage contract test intentionally fails until these steps are complete.

## CI strategy

A practical split is:

### Every change / pull request

```bash
npm run typecheck
npm test
npm run test:evals:contracts
```

The last command is redundant with the broad `npm test` traversal but useful as
a fast explicit gate in targeted jobs.

### Changes to tool descriptions, prompts, routing, or discipline

Run the relevant live category/model subset in addition to deterministic tests.

### Nightly or manual comparison

Run the full available GLM/Luna/Terra/Sol matrix and persist the JSON/Markdown
report as a CI artifact. This is the right place to watch token/cost/latency
drift because live-model variance and expense make it a poor default PR gate.

## Known limitations

- Live model behavior is probabilistic; one run is useful for regression
  detection but not a statistically strong benchmark by itself.
- The current runner records one execution per case/model. Repetition and
  confidence intervals are natural future additions.
- Verification detection is heuristic and based on observable shell commands.
- Provider-reported monetary cost may be absent even when tokens are present.
- Selection cases that block `subagents` measure the delegation decision, not
  nested worker outcome quality.
- The current orchestration cases validate whether delegation/escalation was
  selected. Deeper end-to-end worker-quality cases should remain separate so
  routing failures and worker failures are diagnosable independently.
- No LLM judge currently grades prose quality. This is intentional: the initial
  suite prioritizes objective behavior, tool discipline, executable outcomes,
  and cost.

## Future extensions

Useful next additions include:

- repeated runs with pass-rate confidence intervals;
- baseline report comparison with explicit regression thresholds;
- richer parent-versus-worker token attribution by role/model;
- per-case normalized cost budgets;
- automatic detection of equivalent repeated patch attempts;
- DCP continuation evals that continue work after forced compaction;
- comment-checker precision/recall corpora;
- larger AST transformation fixtures with semantic hidden tests;
- end-to-end orchestration cases that allow real workers to complete and compare
  `Sol direct` vs `Sol + Terra` vs `Terra + Sol escalation`;
- machine-readable CI summary output for trend dashboards.

The important constraint is to keep correctness evidence objective whenever it
can be objective, and use live models only for the decisions that genuinely
depend on model behavior.
