# Project-local sub-agents from `.pi/agents/*.md` (delta spec)

> Risk classes: **config loading / sub-agent spawn surface**. Extends the
> async-subagents config pipeline, with an opt-in cross-vendor runtime
> model-selection invariant for strict roles.
>
> Status: implemented and current. Re-verify against code before relying on
> line numbers.

## Type

Change

## Lifecycle

Active implemented contract.

## Purpose

Let a project ship its own sub-agent definitions as individual Markdown files
(Claude Code `.claude/agents/*.md` style). Files live in `<project>/.pi/agents/`;
each file becomes a `subagentType` available to the `subagents` tool, the LLM
router, and the parent system-prompt role catalog. Each role owns its ordered
model candidate list; there is no separate project-wide model-pool layer.
Bundled built-in roles use the same Markdown definition format and parser under
`src/async-subagents/agents/*.md`.

## Behavior

### Discovery

1. From the spawn cwd, walk up towards the filesystem root; the **first**
   `.pi/agents` directory found wins (same walk-up semantics as
   `findProjectConfig` for `<project>/.pi/pi-tools-suite.jsonc`).
2. Only top-level `*.md` files (non-recursive) are loaded, dotfiles excluded,
   sorted by filename for deterministic merge order.
3. Type name = filename without the `.md` extension. Valid names:
   `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`; anything else is a load error.
4. Files **without** YAML frontmatter are skipped silently (so a `README.md`
   documenting agents is legal). Files **with** frontmatter that fails to parse
   or validate throw, aborting config load with the file path in the message —
   same loud-failure policy as a malformed `pi-tools-suite.jsonc`.

### File format

```yaml
---
description: Use for X — shown to the LLM router when picking a type.
model: zai/glm-5.3
thinking: medium
tools: read, grep, bash        # comma-separated or block list
fallbackModels:
  - openai-codex/gpt-6-luna
modelByParent:
  zai/*: zai/glm-5.3
  openai-codex/*:
    model: openai-codex/gpt-6.1-sol
    fallbackModels: [zai/glm-5.3]
forParentModels: [zai/*, openai-codex/*]
notForParentModels: [openai-codex/gpt-6.1-sol*]
forParentTier: non-frontier # frontier | non-frontier
requiresIndexedProject: true
parentProviderPolicy: require-other # any | prefer-other | require-other | require-other-if-frontier
---

You are a ... role prompt (markdown body).
```

- Frontmatter keys: `name` (must match the filename if present; mismatch is an
  error), plus every `SubagentTypeConfig` field (`description`, `icon`, `model`,
  `models`, `modelSelection`, legacy `fallbackModels`/`modelByParent`,
  `forParentModels`, `notForParentModels`, `forParentTier`,
  `requiresIndexedProject`,
  `parentProviderPolicy`, deprecated
  `requireDifferentProvider`, `thinking`, `tools`, `extraArgs`,
  `promptAppend`, `promptOverride`, `retry`, `maxResultBytes`, `timeoutMs`).
  Unknown keys are rejected (typo safety; the JSONC config path stays lenient).
- `forParentModels` is an optional parent-model allow-list;
  `notForParentModels` is an optional deny-list and wins on overlap. These gates
  filter the role from the parent catalog and router/explicit-role validation;
  they do not select the child model.
- `modelSelection: frontier` takes candidates from the suite config's
  `frontierModels` list instead of `models` (they are mutually exclusive in one
  file; a project file with `models` replaces an inherited `modelSelection`).
  `forParentTier` exposes a role only to frontier or non-frontier parents.
- `requiresIndexedProject: true` exposes a role only when the project root
  resolved from the current cwd contains `.indexer-cli/`. This is a visibility
  gate only: it does not require `idx` to be executable and does not initialize
  the project. The gate applies to the parent catalog, automatic routing, and
  explicit-role validation. A raw loaded config may still contain the role so an
  explicit request can be reported as unavailable rather than unknown.
- `parentProviderPolicy` defaults to `any` and compares model vendors
  (family owners inferred from the model id, provider id as fallback), not
  provider strings. `prefer-other` stable-partitions other-vendor candidates
  ahead of same-vendor ones and the parent's own model. `require-other` is a
  hard runtime boundary: a known permitted parent must exist and every
  candidate, including explicit task/CLI/forced overrides and quota fallbacks,
  must be another vendor and not the parent's model; `--provider` extra args are
  rejected. An unavailable or empty cross-vendor chain fails before spawn rather
  than falling back to the parent. `require-other-if-frontier` is
  `require-other` for frontier (or unknown) parents and `prefer-other`
  otherwise; the bundled `oracle` uses it with `modelSelection: frontier`.
  `requireDifferentProvider: true` remains a compatibility alias for
  `parentProviderPolicy: require-other`.
- Supported YAML subset (bounded, dependency-free parser): plain/quoted scalars,
  numbers, booleans, `#` comments (full-line and trailing), inline arrays
  `[a, b]`, block lists `- item`, and exactly one level of nested maps for
  `modelByParent`/`retry` values. Tabs in indentation, block scalars (`|`, `>`),
  anchors/aliases, flow maps, and multi-document markers are hard errors naming
  file + line.
- Markdown body → `promptAppend` (appended after the standard generated prompt
  as "Additional instructions from sub-agent profile"), so the agent still
  receives parent objective + task + output-format sections. Frontmatter
  `promptAppend` is prepended to the body; `promptOverride` in frontmatter
  replaces the whole prompt as usual.

### Merge order and precedence

Within `loadSubagentConfig` (no caching — re-read per spawn/command call):

1. bundled built-in role definitions;
2. top-level pi-tools-suite `disabledBuiltinAgents` removes selected bundled
   roles; `enabledBuiltinAgents` in a later suite config layer can re-enable an
   inherited disable;
3. project `.pi/agents/*.md`; a same-named project role replaces the bundled
   role profile completely rather than inheriting omitted built-in fields, and
   it may recreate a name removed by the bundled-role filter. There are no
   role-name aliases or partial-merge exceptions;
4. environment model, routing, concurrency, result-size, and timeout overrides.

User/global `pi-tools-suite.jsonc`, `$PI_CONFIG_DIR`, project
`<project>/.pi/pi-tools-suite.jsonc` affect only bundled-role visibility through
the two top-level keys above; they do not define or override role profiles. The
former `ASYNC_SUBAGENTS_CONFIG` / `PI_SUBAGENTS_CONFIG` file path is not part of
the current sub-agent profile merge pipeline.

### Reload semantics (original user requirement: "respect `/reload`")

- Config load has **no cache**: `loadSubagentConfig(ctx.cwd)` runs on every
  spawn and every ultrawork input-transform
  decision. Adding/editing `.pi/agents/*.md` therefore takes effect on the next
  spawn **without** any reload.
- `before_agent_start` also rebuilds an `<available_subagent_types>` system
  prompt section from the fully merged config whenever the `subagents` tool is
  available. Parent-model and project-context gates are applied before
  rendering. It contains type names plus bounded `description` text, so the
  parent sees only roles valid for its current model/project without a restart.
  When a project-local definition completely replaces a same-named bundled
  role, the catalog explicitly tells the parent which built-in names were
  replaced so the chat context does not imply inherited built-in behavior.
  `/reload` still refreshes ordinary extension registration state.

### Built-in definition source

- Built-in role profiles are individual files in
  `src/async-subagents/agents/*.md` and are parsed by the same
  `readAgentDefinitionsFromDir` + `normalizeSubagentTypeProfile` path as project
  agents.
- `defaultType` is now `research` while bundled files are loaded in
  deterministic filename order. Spec 29 supersedes silent spawn-error fallback
  with parent-first role selection and recoverable routing errors.
- The bundled `knowledge-auditor` is an economical docs-only finalization role.
  It sets `requiresIndexedProject: true`, so it exists in raw built-in config
  but is effective only for projects with `.indexer-cli/`. It runs the final
  task-scoped audit, fixes only small unambiguous documentation drift, and
  escalates substantial or ambiguous contract drift to the parent.
- Runtime-only invariants stay in runtime code. All async sub-agents disable
  skill discovery and reject skill injection through `extraArgs`; role files are
  therefore self-contained. As extended by `ui-qa-agent.md`, `ui-qa` additionally
  receives launcher-owned runner/workspace paths. Its top-level
  `agents/ui-qa.md` body is a thin common contract plus deterministic guide
  routing; backend-specific browser/TUI/Desktop/auth instructions live in
  non-role assets under `agents/ui-qa/guides/` and are loaded through the
  allowlisted UI-QA runner. `ui-qa` is the only built-in UI-QA role name.

## Non-goals

- User-level (`~/.config/pi/agents/`) directory — project scope only.
- Recursive agent dirs, `.jsonc` agent files, YAML dependency, or per-agent
  preset definitions.
- Changes to spawn behavior, router prompt templates, or tool schemas. The
  parent system prompt gains only the effective role catalog described above.

## Tests

`external/pi-tools-suite/test/async-subagents/core.test.ts`, describe
"project agent definitions (.pi/agents)": load/replacement semantics,
body→promptAppend, name
mismatch error, no-frontmatter skip, broken YAML error with path, walk-up
discovery, project preset/profile precedence, resolved
model/thinking/tools/modelByParent/retry behavior, and a fresh-reload test (file
mutated between two `loadSubagentConfig` calls).
Additional tests verify that bundled roles are sourced from individual Markdown
files and that `before_agent_start` exposes a project-local role in the effective
system-prompt catalog while omitting that catalog when `subagents` is not an
available tool. Config tests also cover layered bundled-role disable/re-enable,
and core tests verify that a same-named project role survives a bundled disable,
fully replaces omitted built-in fields, and is announced as a project
replacement in the parent catalog.
