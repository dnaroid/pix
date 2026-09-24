# Sub-agent model pools

Sub-agents primarily reduce the cost of bounded work and keep intermediate
source, searches and logs out of the parent context. The parent owns planning,
integration, decisions and the final answer. Actual savings depend on worker
quality, retries and how much work the parent repeats; the configuration is
not a price oracle.

## Execution modes

- `research`: read-only evidence gathering, searches and focused review questions.
- `implement`: bounded code, documentation, test and frontend changes.
- `verify`: run checks and interpret logs, without fixing source or tests.
- `ui-qa`: isolated real-UI workflow for browsers, terminal/TUI apps, and
  desktop GUIs with deterministic assertions and inspectable evidence.
- `frontier-review`: independent post-implementation code review on a strong
  model; hidden when the current parent model matches the role's availability
  gate.
- `delivery-review`: explicitly requested, read-only delivery readiness and
  evidence review, available to any parent; does not perform real UI QA or
  assume release authority. Available in each bundled pool where a declared
  candidate intersects: GLM-5.3 in `cheap`/`deep`, GPT-6-Sol in `gpt`/`deep`.
- `oracle`: a deliberate strong second opinion, not automatic worker escalation.
- `oracle-openai` / `oracle-zai`: explicitly cross-provider, read-only strong
  second opinions, offered only to Z.ai / OpenAI Codex parents respectively.
  These are not substitutes for routine review or the compatible `oracle` role.

Task-specific discipline belongs in the brief or `promptAppend`. A new project
agent is warranted when it adds a durable contract, capabilities or resources,
not merely a professional title. `verify` has a behavioral no-edit contract;
shell access is not a read-only filesystem sandbox.

### Delivery review contract

`delivery-review` reviews the actual diff, surrounding code, and completed
verification to assess residual delivery risk. Its bundled profile is
self-contained: it does not require project skills or their discovery in the
child. It uses GPT-6-Sol followed by GLM-5.3, `high` thinking, and the inspection
tools `read`, `grep`, and `bash`, subject to normal pool/runtime availability.
It remains available even when the parent is a frontier model.

The role must not edit files, execute tests, perform UI QA, or spawn children.
Missing test/UI evidence is requested through the parent. This is a behavioral
restriction, not a shell sandbox. Concurrency/lifecycle and production-impact
checks apply only when relevant to the changed paths. Reports distinguish
inspection from execution, classify material risks as `covered`, `acceptable`,
or `needs attention`, and end with `High`, `Medium`, or `Low` confidence plus
what would raise lower confidence. The role must not recommend readiness with
unresolved material blockers (which require `Low` readiness confidence),
unresolved high-impact risks or missing essential verification, assume release
authority, or waive a required independent `frontier-review` gate.

## Agent priority, preset availability

Each Markdown profile owns its ordered `models` list. This is one candidate
chain for initial selection and subsequent quota fallbacks:

```yaml
---
description: Make bounded implementation changes.
models:
  - zai/glm-5.3-flash
  - openai-codex/gpt-6-sol
thinking: high
---
```

A preset contains a set of available models, not a per-agent matrix. Project
pools live in `<project>/.pi/agents/presets.jsonc`:

```jsonc
{
  "gpt": {
    "description": "Models available for this project",
    "models": [
      "openai-codex/gpt-6-luna",
      "openai-codex/gpt-6-sol",
      "openai-codex/gpt-6-astra"
    ]
  }
}
```

Workers select candidates in their own declared order. For example,
`implement` has GLM-5.3-Flash followed by GPT-6-Sol, while `research` and
`ui-qa` retain GPT-6-Luna as fallback. The frontier-review can declare Sol in
its chain while oracle can declare Astra. Model references in `models` must be
exact `provider/model` values, not wildcards.

The resolver intersects the agent chain with the selected pool. Runtime
selection then skips unregistered, unauthenticated or session-exhausted models.
Tasks with images and UI QA require confirmed image support. The first
eligible candidate runs; only the remaining eligible candidates are passed to
quota fallback. An empty intersection or unavailable chain rejects the batch
before any children or run state are created. Model selection makes no LLM
completion request; the optional role router is a separate operation.

Oracle prefers another provider when possible, but still respects the pool.
It never substitutes an ordinary cheap candidate merely to avoid a selection
error. A single-provider pool cannot promise cross-provider independence.

For a guaranteed different provider, use `oracle-openai` from a Z.ai parent or
`oracle-zai` from an OpenAI Codex parent. They declare only Astra and GLM-5.3
respectively. Their `requireDifferentProvider: true` profile contract rejects
unknown/unsupported parent gates and same-provider explicit task/CLI/forced
overrides; it removes same-provider candidates from the initial and fallback
chain (including legacy candidates). If the pool intersection is empty or no
candidate is available/authenticated, selection errors before launch. The
read-only tool list and prompt are behavioral restrictions, not a filesystem
sandbox. The original `oracle` remains best-effort for saved callers.

Explicit task `model`, CLI `--model`, and `FORCE_CURRENT_MODEL` remain deliberate
overrides: they bypass the pool and do not add automatic fallback candidates,
but cannot bypass `requireDifferentProvider` on strict profiles.
The parent should not use these to evade the configured budget. The pool is
a selection policy, not a security boundary against explicit overrides.

## Selection and compatibility

Use `/subagent-preset <name>`, `AGENTS_PRESET=<name>` or
`/subagent-preset session <name>`. Clearing the preset uses agent priorities
without a pool filter. The shipped names remain compatible with saved choices:
`cheap` is the GLM pool, `gpt` the GPT pool, and `deep` the mixed pool. The last
name no longer means that ordinary workers should escalate to flagship models.
Bundled definitions live beside the built-in agents in
`src/async-subagents/agents/presets.jsonc`; a project file with the same preset
name overrides that pool.

Old role names are not implicit aliases. `quick`, `scan`, `review`, `deep`,
`docs`, `frontend`, and `tests` work only when explicitly defined as ordinary
custom/project types. This keeps the effective catalog and accepted names exact.

Agent frontmatter can gate whether a role exists for the current parent model:
`forParentModels` is an optional allow-list and `notForParentModels` is an
optional deny-list; deny wins when both match. These fields accept model
patterns such as `zai/*` and affect the parent catalog, explicit role
validation, and automatic routing. They do not change which model the child
runs on; `models` / legacy model selectors still own child model selection.
`requireDifferentProvider` is a separate opt-in runtime invariant: a known
parent `provider/model` is mandatory, and every selectable child must have a
different provider, even under explicit model overrides.

Legacy `model` plus `fallbackModels` and `modelByParent` still load when they are
declared in an agent Markdown file. New profile `models` replaces inherited
legacy selection fields. Empty `models` means no candidates, not permission to
inherit the parent model. Model-less project specialists must declare candidates
or receive an explicit model override.

Legacy singular selectors are normalized with an explicit fallback array:
`model` without `fallbackModels` resolves to `fallbackModels: []`, and every
normalized `modelByParent` entry carries its own `fallbackModels` array. Modern
`models` profiles already encode the complete ordered candidate/fallback chain
in one array and are not wrapped in an additional fallback field.

The removed `asyncSubagents` section is no longer part of the public config
schema and is not read at runtime. Existing legacy files are left untouched but
have no effect. Migrate role definitions to `<project>/.pi/agents/*.md` and
custom pools to `<project>/.pi/agents/presets.jsonc`.

## Compact handoff

Give workers a scope, acceptance criteria and the evidence needed to start.
Read compact results first and inspect raw artifacts selectively. One noisy
sequential investigation can justify a worker; a command whose exit status is
sufficient usually only needs a saved log, not another LLM. Independent review
of substantive code changes uses `frontier-review` when it is present in the
current parent catalog; use `research` for focused evidence/review questions.
