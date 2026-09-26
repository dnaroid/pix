# Sub-agent model candidates and provider policy

Sub-agents primarily reduce the cost of bounded work and keep intermediate
source, searches and logs out of the parent context. The parent owns planning,
integration, decisions and the final answer. Actual savings depend on worker
quality, retries and how much work the parent repeats; model order is a role
policy, not a price oracle.

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
  assume release authority.
- `oracle`: a deliberate cross-provider strong second opinion, not automatic
  worker escalation.

Task-specific discipline belongs in the brief or `promptAppend`. A new project
agent is warranted when it adds a durable contract, capabilities or resources,
not merely a professional title. `verify` has a behavioral no-edit contract;
shell access is not a read-only filesystem sandbox.

### Delivery review contract

`delivery-review` reviews the actual diff, surrounding code, and completed
verification to assess residual delivery risk. Its bundled profile is
self-contained: it does not require project skills or their discovery in the
child. It uses GPT-6-Sol followed by GLM-5.3, `high` thinking, and the inspection
tools `read`, `grep`, and `bash`, subject to runtime availability. It remains
available even when the parent is a frontier model.

The role must not edit files, execute tests, perform UI QA, or spawn children.
Missing test/UI evidence is requested through the parent. This is a behavioral
restriction, not a shell sandbox. Concurrency/lifecycle and production-impact
checks apply only when relevant to the changed paths. Reports distinguish
inspection from execution, classify material risks as `covered`, `acceptable`,
or `needs attention`, and end with `High`, `Medium`, or `Low` confidence plus
what would raise lower confidence. The role must not recommend readiness with
unresolved material blockers, unresolved high-impact risks, or missing essential
verification, assume release authority, or waive a required independent
`frontier-review` gate.

## Role-owned model candidates

Each Markdown profile owns its ordered `models` list. There is no global
sub-agent preset or model-pool layer. The list is the complete candidate chain
for initial selection and subsequent quota fallbacks:

```yaml
---
description: Make bounded implementation changes.
models:
  - zai/glm-5.3-flash
  - openai-codex/gpt-6-sol
thinking: high
---
```

Model references in `models` are exact `provider/model` values, not wildcards.
The resolver preserves that configured order unless the role declares a parent
provider policy. Runtime selection then removes candidates that are unregistered,
unauthenticated, session-exhausted, or incompatible with required capabilities.
Tasks with images and `ui-qa` require confirmed image support. The first usable
candidate runs; remaining usable candidates form the quota fallback chain. An
empty or unavailable chain rejects the batch before any child is launched.
Model selection itself makes no LLM completion request; the optional role router
is a separate operation.

Explicit task `model`, CLI `--model`, and `FORCE_CURRENT_MODEL` remain deliberate
overrides and do not add automatic fallback candidates. Capability checks and a
strict parent-provider boundary still apply to those overrides.

## Parent-provider policy

`parentProviderPolicy` controls the relationship between a role's candidate
providers and the known parent provider:

- `any` (default): preserve the role's candidate order unchanged.
- `prefer-other`: stable-partition other-provider candidates before same-provider
  candidates, preserving relative order inside both groups.
- `require-other`: remove every candidate from the parent provider. A known parent
  provider is required; same-provider explicit overrides are rejected; an empty
  remaining chain is a selection error rather than a fallback to the parent.

The bundled `oracle` uses `require-other`. Its strong-model list can contain
OpenAI, Z.ai, Anthropic, or any future provider without adding provider-specific
oracle roles. For example, a chain

```yaml
models: [openai/frontier, anthropic/frontier, zai/frontier]
parentProviderPolicy: require-other
```

automatically excludes OpenAI for an OpenAI parent, Anthropic for an Anthropic
parent, and Z.ai for a Z.ai parent. Runtime availability then chooses the first
usable candidate among the remaining providers. Adding another provider is just
another candidate in the role profile; it does not require a new routing matrix.

Quota fallback follows the already-resolved candidate chain. The fallback layer
tracks exhausted models/providers but does not independently encode a
different-provider rule; provider diversity belongs to the role policy.

`requireDifferentProvider: true` remains accepted as a compatibility alias for
`parentProviderPolicy: require-other`. New profiles should use the enum directly.

## Parent-model visibility gates

Agent frontmatter can independently gate whether a role exists for the current
parent model. `forParentModels` is an optional allow-list and
`notForParentModels` is an optional deny-list; deny wins when both match. These
fields accept model patterns such as `zai/*` and affect the parent catalog,
explicit role validation, and automatic routing. They do not choose the child
model; `models` and the provider policy do that.

## Project-local customization and compatibility

Projects customize role behavior by adding or replacing
`<project>/.pi/agents/<role>.md`. There is no `.pi/agents/presets.jsonc`, saved
sub-agent preset selection, `AGENTS_PRESET`, or `/subagent-preset` runtime
surface. A project that wants different worker economics changes the ordered
candidate list of the relevant role instead of selecting a global model pool.

Old role names are not implicit aliases. `quick`, `scan`, `review`, `deep`,
`docs`, `frontend`, and `tests` work only when explicitly defined as ordinary
project types. This keeps the effective catalog and accepted names exact.

Legacy `model` plus `fallbackModels` and `modelByParent` still load when declared
in an agent Markdown file. A modern `models` profile is the complete ordered
candidate chain. Empty `models` means no candidates, not permission to inherit
the parent model. Legacy singular selectors normalize with an explicit fallback
array, including `[]`.

The removed `asyncSubagents` section is no longer part of the public config
schema and is not read at runtime. Existing legacy files are left untouched but
have no effect. Migrate role definitions and model candidate choices to
`<project>/.pi/agents/*.md`. To hide only selected bundled roles, use top-level
`disabledBuiltinAgents` in `pi-tools-suite.jsonc`; later config layers may
re-enable names with `enabledBuiltinAgents`. The filter runs before project-local
Markdown is merged, so a same-named project role can intentionally replace a
disabled built-in.

## Compact handoff

Give workers a scope, acceptance criteria and the evidence needed to start.
Read compact results first and inspect raw artifacts selectively. One noisy
sequential investigation can justify a worker; a command whose exit status is
sufficient usually only needs a saved log, not another LLM. Independent review
of substantive code changes uses `frontier-review` when it is present in the
current parent catalog; use `research` for focused evidence/review questions.
