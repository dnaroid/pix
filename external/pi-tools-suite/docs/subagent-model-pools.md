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
- `frontier-review`: independent post-implementation code review on a frontier
  model; hidden when the current parent model is itself a frontier model.
- `delivery-review`: explicitly requested, read-only delivery readiness and
  evidence review, available to any parent; does not perform real UI QA or
  assume release authority.
- `oracle`: a deliberate cross-vendor frontier second opinion, not automatic
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

Each Markdown profile owns its ordered `models` list, or declares
`modelSelection: frontier` to use the suite-level frontier list described
below. There is no other global sub-agent preset or model-pool layer. The list
is the complete candidate chain for initial selection and subsequent quota
fallbacks:

```yaml
---
description: Make bounded implementation changes.
models:
  - zai/glm-5.3
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

`parentProviderPolicy` controls the relationship between a role's candidates
and the known parent model. It compares *vendors* (model-family owners), not
provider ids: the vendor is taken from a matching `frontierModels` entry's
`vendor`, else inferred from the model id (`gpt-*`/`o<N>`/`codex` → openai,
`glm-*` → zai, `claude-*` → anthropic, `gemini-*`/`gemma-*` → google, `grok-*`
→ xai, ...), else the provider id. So `openai/gpt-6-astra`,
`openai-codex/gpt-6-astra`, `github-copilot/gpt-6-astra` and
`openrouter/~openai/gpt-astra-latest` are all the openai vendor, and the parent's
own model (same normalized id or a shared frontier alias) never counts as "other".

- `any` (default): preserve the role's candidate order unchanged.
- `prefer-other`: stable-partition other-vendor candidates first, then
  same-vendor candidates, then the parent's own model.
- `require-other`: remove every candidate from the parent vendor. A known parent
  is required; same-vendor explicit overrides and `--provider` extra args are
  rejected; an empty remaining chain is a selection error rather than a fallback
  to the parent.
- `require-other-if-frontier`: `require-other` when the parent is a frontier
  model (or unknown), `prefer-other` otherwise.

For example, a chain

```yaml
models: [openai/frontier, anthropic/frontier, zai/frontier]
parentProviderPolicy: require-other
```

automatically excludes OpenAI for an OpenAI parent, Anthropic for an Anthropic
parent, and Z.ai for a Z.ai parent. Runtime availability then chooses the first
usable candidate among the remaining vendors.

## Frontier models and economy mode

`pi-tools-suite.jsonc` names the frontier models once:

```jsonc
"frontierModels": [
  { "model": "openai-codex/gpt-6-astra", "expensive": true, "aliases": ["*gpt*astra*"], "roles": ["oracle"] },
  { "model": "openai-codex/gpt-6-sol", "expensive": true, "aliases": ["*gpt-6-sol*"] },
  { "model": "zai/glm-5.3" }
],
"economy": false
```

The list serves two purposes: it classifies the parent (a parent matching an
entry by exact ref, normalized id, or alias is a frontier parent) and it is the
ordered candidate list of roles with `modelSelection: frontier`. Entries with
`enabled: false` still classify parents but are never selected; `roles`
restricts an entry to the listed roles. A config layer's list replaces the
inherited list, and `null` restores the built-in one.

The bundled roles use it as follows:

| Role | Selection | Result with the default list |
|---|---|---|
| `oracle` | `require-other-if-frontier` | GLM-5.3 parent → Astra, Sol; GPT-6 Sol/Astra parent → GLM-5.3; non-frontier parent → every frontier, other vendors first |
| `frontier-review` | `forParentTier: non-frontier` | Sol, GLM-5.3; hidden for frontier parents |
| `delivery-review` | list order | Sol, GLM-5.3; available to all parents |

`economy: true` (or `PI_TOOLS_SUITE_ECONOMY=1`) excludes `expensive` frontier
models from every role's automatic chain (including roles with their own
`models`, such as `implement`) and rejects explicit task/CLI overrides to them.
Only the forced current parent model is exempt. The config is read on each spawn,
so toggling takes effect without a restart. If nothing qualifies, spawn fails
naming the excluded models, and a cross-vendor role that cannot resolve for the
current parent is hidden from the catalog.

Quota fallback follows the already-resolved candidate chain. The fallback layer
tracks exhausted models/providers but does not independently encode a
different-provider rule; provider diversity belongs to the role policy.

`requireDifferentProvider: true` remains accepted as a compatibility alias for
`parentProviderPolicy: require-other`. New profiles should use the enum directly.

## Role visibility gates

`forParentTier: frontier | non-frontier` exposes a role only to parents in that
tier of the frontier list; an unknown parent keeps the role visible.

Agent frontmatter can independently gate whether a role exists for the current
parent model. `forParentModels` is an optional allow-list and
`notForParentModels` is an optional deny-list; deny wins when both match. These
fields accept model patterns such as `zai/*` and affect the parent catalog,
explicit role validation, and automatic routing. They do not choose the child
model; `models` and the provider policy do that.

`requiresIndexedProject: true` is an independent project-context visibility
gate. It requires `.indexer-cli/` at the project root resolved from the current
cwd and affects the same parent catalog, explicit-role validation, and automatic
routing surfaces. It deliberately checks only the project marker, not whether
`idx` is currently executable, and never initializes the project.

## Project-local customization and compatibility

Projects customize role behavior by adding or replacing
`<project>/.pi/agents/<role>.md`. There is no `.pi/agents/presets.jsonc`, saved
sub-agent preset selection, `AGENTS_PRESET`, or `/subagent-preset` runtime
surface. A project that wants different worker economics changes the ordered
candidate list of the relevant role instead of selecting a global model pool.

A project-local file with the same name as a bundled role replaces that bundled
profile completely. Omitted fields do not fall through to the built-in
definition. The effective parent catalog explicitly reports active same-name
replacements so the parent knows it is seeing project-owned semantics. There
are no role-name aliases or partial-merge exceptions.

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
Markdown is applied, so a same-named project role can intentionally replace a
disabled built-in.

## Compact handoff

Give workers a scope, acceptance criteria and the evidence needed to start.
Read compact results first and inspect raw artifacts selectively. One noisy
sequential investigation can justify a worker; a command whose exit status is
sufficient usually only needs a saved log, not another LLM. Independent review
of substantive code changes uses `frontier-review` when it is present in the
current parent catalog; use `research` for focused evidence/review questions.
