# Sub-agent model pools

Sub-agents primarily reduce the cost of bounded work and keep intermediate
source, searches and logs out of the parent context. The parent owns planning,
integration, decisions and the final answer. Actual savings depend on worker
quality, retries and how much work the parent repeats; the configuration is
not a price oracle.

## Five execution modes

- `research`: read-only evidence gathering, searches and independent diff review.
- `implement`: bounded code, documentation, test and frontend changes.
- `verify`: run checks and interpret logs, without fixing source or tests.
- `browser-qa`: isolated browser workflow with assertions and visual artifacts.
- `oracle`: a deliberate strong second opinion, not automatic worker escalation.

Task-specific discipline belongs in the brief or `promptAppend`. A new project
agent is warranted when it adds a durable contract, capabilities or resources,
not merely a professional title. `verify` has a behavioral no-edit contract;
shell access is not a read-only filesystem sandbox.

## Agent priority, preset availability

Each Markdown profile owns its ordered `models` list. This is one candidate
chain for initial selection and subsequent quota fallbacks:

```yaml
---
description: Make bounded implementation changes.
models:
  - zai/glm-5.3-flash
  - openai-codex/gpt-5.6-terra
  - openai-codex/gpt-5.6-luna
thinking: medium
---
```

A preset contains a set of available models, not a per-agent matrix. Project
pools live in `.pi/agents/presets.jsonc`:

```jsonc
{
  "gpt": {
    "description": "Models available for this project",
    "models": [
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol"
    ]
  }
}
```

The example agent selects Terra, not Luna: the agent's order wins. Sol is
available in the pool but absent from this worker's chain, so it cannot become
an automatic implementation fallback. The oracle can declare Sol in its own
chain. Model references must be exact `provider/model` values, not wildcards.

The resolver intersects the agent chain with the selected pool. Runtime
selection then skips unregistered, unauthenticated or session-exhausted models.
Tasks with images and browser QA require confirmed image support. The first
eligible candidate runs; only the remaining eligible candidates are passed to
quota fallback. An empty intersection or unavailable chain rejects the batch
before any children or run state are created. Model selection makes no LLM
completion request; the optional role router is a separate operation.

Oracle prefers another provider when possible, but still respects the pool.
It never substitutes an ordinary cheap candidate merely to avoid a selection
error. A single-provider pool cannot promise cross-provider independence.

Explicit task `model`, CLI `--model`, and `FORCE_CURRENT_MODEL` remain deliberate
overrides: they bypass the pool and do not add automatic fallback candidates.
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

Legacy `model` plus `fallbackModels` and `modelByParent` still load when they are
declared in an agent Markdown file. New profile `models` replaces inherited
legacy selection fields. Empty `models` means no candidates, not permission to
inherit the parent model. Model-less project specialists must declare candidates
or receive an explicit model override.

The removed `asyncSubagents` section is no longer part of the public config
schema and is not read at runtime. Existing legacy files are left untouched but
have no effect. Migrate role definitions to `.pi/agents/*.md` and custom pools to
`.pi/agents/presets.jsonc`.

## Compact handoff

Give workers a scope, acceptance criteria and the evidence needed to start.
Read compact results first and inspect raw artifacts selectively. One noisy
sequential investigation can justify a worker; a command whose exit status is
sufficient usually only needs a saved log, not another LLM. Independent review
uses a fresh `research` invocation, not a separate built-in persona.
