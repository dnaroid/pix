# async-subagents extension

## Sub-agent type routing

`subagents` is the single tool for async sub-agent orchestration. Set `action` to `spawn`, `status`, `wait`, `result`, `stop`, or `cleanup` and pass the corresponding options.

`subagents({ action: "spawn", ... })` can route each delegated task through a logical `subagentType` so cheap scans, expensive reviews, and vision handoffs can use different models.

Built-in types include `quick`, `scan`, `review`, `deep`, and `vision`. The `vision` type is pinned to `openai-codex/gpt-5.4-mini` and is intended for text-only/blind parent models that need a sub-agent to inspect screenshots or other images and describe what is visible. Pass `imagePaths` to attach local images to the sub-agent prompt, and optionally pass `focus` (or `attention`) to say what the vision model should prioritize.

Running agents can be cancelled with `subagents({ action: "stop", ... })` or `/sub-stop <run-dir> [agent-id ...] [--force]`. Stop sends `SIGTERM` by default, or `SIGKILL` when `force=true`, and records the agent as `stopped`.
Queued `planned` agents and agents waiting for a retry backoff are also marked `stopped`, so they will not launch later after a stop request.

Config files are loaded in this order; later files override earlier ones:

1. `~/.config/pi/async-subagents.jsonc` or `.json`
2. `~/.pi/async-subagents.jsonc` or `.json`
3. `<project>/.pi/async-subagents.jsonc` or `.json`

Set `ASYNC_SUBAGENTS_CONFIG=/path/to/config.jsonc` to use one explicit config file instead.

Example project config:

```jsonc
{
  "defaultType": "quick",
  "maxConcurrent": 5,
  "retry": { "maxRetries": 1, "backoffMs": 2000 },
  "maxResultBytes": 100000,
  "types": {
    "scan": {
      "description": "Fast file scanning/search",
      "model": "zai/glm-5-turbo",
      "thinking": "off",
      "tools": ["read", "grep"],
      "match": ["scan", "search", "grep", "/repo[- ]wide/i"]
    },
    "review": {
      "description": "Careful code review",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high",
      // Optional: append extra instructions after the generated prompt.
      // May be a string, or an array of strings joined with newlines.
      // "promptAppend": [
      //   "Focus on correctness, security, and maintainability.",
      //   "Return concrete file:line evidence."
      // ],
      // Optional: replace the generated prompt entirely.
      // Supports {id}, {task}, {scope}, {parentObjective}, {subagentType}, {model}, {thinking}.
      // "promptOverride": "You are a code-review sub-agent. Parent: {parentObjective}\nTask: {task}\nScope: {scope}",
      "match": ["review", "audit", "security"]
    },
    "deep": {
      "model": "openai/gpt-5.1",
      "thinking": "high"
    },
    "vision": {
      "model": "openai-codex/gpt-5.4-mini",
      "thinking": "off",
      "promptAppend": "Describe attached images for a parent model that cannot see them. Prioritize {focus} when present."
    }
  }
}
```

Top-level config options:

- `maxConcurrent`: project-wide concurrency limit for spawned sub-agent processes. Default is `5`; `0` means unlimited. Excess tasks remain queued as `planned` and are launched when a slot opens.
- `retry`: global retry defaults. `maxRetries` is the number of retry attempts after the initial failure, `backoffMs` is doubled after each failed attempt, omitted `retryableExitCodes` retries any non-zero exit, and an explicit empty `retryableExitCodes: []` disables retry by exit-code filter.
- `maxResultBytes`: maximum bytes copied from raw `result.md` into `result.json`'s `resultText`. The raw `result.md` file remains untruncated.
- `presets`: named model/thinking/extra-arg configurations selected with `/subagent-preset`, `AGENTS_PRESET`, or `/subagent-preset session <name>`. Presets can set global defaults and per-type overrides under `presets.<name>.types.<subagentType>`.
- Each type profile can override `retry` and `maxResultBytes`.

Preset and type configs may also set ordered `fallbackModels`. When a spawned sub-agent fails with quota/rate-limit errors such as `429`, `rate limit`, `quota exceeded`, or `resource exhausted`, async-subagents immediately relaunches that agent with the next fallback model. The exhausted provider is remembered in memory for the current Pi process/session, so future spawns skip that provider and start from the next configured provider until Pi exits. Use provider-level chains such as `antigravity/* → openai-codex/* → zai/*` or `openai-codex/* → zai/*`; omit fallbacks for effectively unlimited providers. Antigravity is special: its provider-level account rotation runs first, and async-subagents only falls back after every configured Antigravity account has hit a limit for that model. Explicit task `model` overrides and `ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` disable preset fallback for that task.

Each completed agent writes both `result.md` and `result.json`. `result.json` includes status, exit code, timestamps, duration, retry count, type/model metadata, optional stderr preview, bounded `resultText`, and best-effort chaining fields such as `summary`, `findings`, `files`, `risks`, `nextActions`, and `confidence` when they can be extracted from the text result. `subagents({ action: "result", agentId: "..." })` defaults to a summary-first response with paths to those artifacts; pass `compact: false` only when the full raw `result.md` and `stderr.log` should be added to the parent context.

The tool prompt asks the parent agent to set `subagentType` (`scan`, `quick`, `review`, `deep`, `vision`). If omitted, the extension infers a type from `match` patterns and built-in defaults.

Precedence for a spawned agent:

- model: task `model` → selected preset type `model` → selected preset `model` → selected type `model` → `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` → pi default
- thinking: top-level spawn `thinking` → task `thinking` → selected type `thinking`
- tools: task `tools` → selected type `tools`
- extra args: selected type `extraArgs` → task `extraArgs` → top-level `extraArgs`
- prompt append: selected type `promptAppend` + task `promptAppend`
- prompt override: task `promptOverride` → selected type `promptOverride`

Vision task fields:

- `imagePaths`: array of local `jpg`, `png`, `gif`, or `webp` files to attach to the RPC prompt; relative paths resolve from the project cwd, and a leading `@` is accepted.
- `focus` / `attention`: optional instruction describing what the vision sub-agent should pay special attention to.

Example:

```jsonc
{
  "action": "spawn",
  "tasks": [{
    "id": "vision-ui",
    "subagentType": "vision",
    "task": "Describe what is visible in this UI screenshot for the parent agent.",
    "imagePaths": ["@screenshots/error.png"],
    "focus": "Check whether there is an error banner, disabled button, or unreadable text."
  }]
}
```

`promptAppend` is appended after the generated prompt (or after `promptOverride` if both are set). `promptOverride` fully replaces the generated prompt, so include `{task}`/`{scope}` placeholders if the replacement still needs task context.

Per-type model env overrides are also supported, e.g. `ASYNC_SUBAGENTS_SCAN_MODEL=...` or `PI_SUBAGENTS_REVIEW_MODEL=...`.

Example preset fallback config:

```jsonc
{
  "presets": {
    "deep": {
      "types": {
        "review": {
          "model": "antigravity/antigravity-claude-sonnet-4-6",
          "fallbackModels": ["openai-codex/gpt-5.5", "zai/glm-5.1"],
          "thinking": "high"
        },
        "implement": {
          "model": "openai-codex/gpt-5.5",
          "fallbackModels": ["zai/glm-5.1"],
          "thinking": "high"
        },
        "quick": {
          "model": "zai/glm-4.5-air",
          "thinking": "off"
        }
      }
    }
  }
}
```
