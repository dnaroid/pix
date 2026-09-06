# 28 — Project-local sub-agents from `.pi/agents/*.md` (delta spec)

> Risk classes: **config loading / sub-agent spawn surface**. Extends the
> async-subagents config pipeline only; no spawn/runtime changes.
>
> Status: implemented alongside this spec. Re-verify against code before
> relying on line numbers.

## Purpose

Let a project ship its own sub-agent definitions as individual Markdown files
(Claude Code `.claude/agents/*.md` style). Files live in `<project>/.pi/agents/`;
each file becomes a `subagentType` available to the `subagents` tool, the LLM
router, the parent system-prompt role catalog, `/subagent-preset` presets, and
per-type overrides — identical to types declared in `asyncSubagents.types`
config. Bundled built-in roles use the same Markdown definition format and
parser under `src/async-subagents/agents/*.md`.

## Behavior

### Discovery

1. From the spawn cwd, walk up towards the filesystem root; the **first**
   `.pi/agents` directory found wins (same walk-up semantics as
   `findProjectPiToolsSuiteConfig` for `.pi/pi-tools-suite.jsonc`).
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
  - openai-codex/gpt-5.6-luna
modelByParent:
  zai/*: zai/glm-5.3
  openai-codex/*:
    model: openai-codex/gpt-5.6-sol
    fallbackModels: [zai/glm-5.3]
---

You are a ... role prompt (markdown body).
```

- Frontmatter keys: `name` (must match the filename if present; mismatch is an
  error), plus every `SubagentTypeConfig` field (`description`, `model`,
  `fallbackModels`, `modelByParent`, `thinking`, `tools`, `isolatedSkills`,
  `extraArgs`, `promptAppend`, `promptOverride`, `retry`, `maxResultBytes`,
  `timeoutMs`). Unknown keys are rejected (typo safety; the JSONC config path
  stays lenient).
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

Within `loadSubagentConfig` (no caching — re-read per spawn/命令 call):

1. builtin types
2. user `~/.config/pi/pi-tools-suite.jsonc`
3. `$PI_CONFIG_DIR/pi-tools-suite.jsonc`
4. project `.pi/pi-tools-suite.jsonc` (walk-up)
5. **project `.pi/agents/*.md`** ← new; per-field override of same-named types
   from all above (existing `mergeConfig` shallow per-type merge: agent-file
   fields win, config-only fields are kept)
6. explicit `ASYNC_SUBAGENTS_CONFIG` / `PI_SUBAGENTS_CONFIG` file
7. env model/routing overrides

When an explicit config path env var is set, the `.pi/agents` directory is
**skipped** (same gating as pi-tools-suite config files: explicit = full
control).

### Reload semantics (user requirement: "уважает /reload")

- Config load has **no cache**: `loadSubagentConfig(ctx.cwd)` runs on every
  spawn, every `/subagent-*` command, and every ultrawork input-transform
  decision. Adding/editing `.pi/agents/*.md` therefore takes effect on the next
  spawn **without** any reload.
- `before_agent_start` also rebuilds an `<available_subagent_types>` system
  prompt section from the fully merged config whenever the `subagents` tool is
  available. It contains type names plus bounded `description` text, so the
  parent sees project-local roles without a restart. `/reload` still refreshes
  ordinary extension registration state.

### Built-in definition source

- Built-in role profiles are individual files in
  `src/async-subagents/agents/*.md` and are parsed by the same
  `readAgentDefinitionsFromDir` + `normalizeSubagentTypeProfile` path as project
  agents.
- `defaultType` remains explicitly `quick` while bundled files are loaded in
  deterministic filename order. Spec 29 supersedes silent spawn-error fallback
  with parent-first role selection and recoverable routing errors.
- Runtime-only invariants stay in runtime code. As extended by
  `30-browser-qa-inline-agent.md`, `browser-qa` disables ordinary skill discovery
  and receives launcher-owned runner/workspace paths, while the complete QA
  workflow lives in the body of `agents/browser-qa.md` without a separate skill.

## Non-goals

- User-level (`~/.config/pi/agents/`) directory — project scope only.
- Recursive agent dirs, `.jsonc` agent files, YAML dependency, or per-agent
  preset definitions.
- Changes to spawn behavior, router prompt templates, or tool schemas. The
  parent system prompt gains only the effective role catalog described above.

## Tests

`external/pi-tools-suite/test/async-subagents/core.test.ts`, describe
"project agent definitions (.pi/agents)": load+merge, body→promptAppend, name
mismatch error, no-frontmatter skip, broken YAML error with path, walk-up
discovery, precedence over `.pi/pi-tools-suite.jsonc`, explicit-config gating,
resolveAgentTaskConfig application (model/thinking/tools/modelByParent/retry),
and a fresh-reload test (file mutated between two `loadSubagentConfig` calls).
Additional tests verify that bundled roles are sourced from individual Markdown
files and that `before_agent_start` exposes a project-local role in the effective
system-prompt catalog while omitting that catalog when `subagents` is not an
available tool.
