# pi-tools-suite

Local all-in-one Pi extension package.

This package keeps shared Pi tools as ordinary source folders under `src/` and registers them through one entrypoint.

- `src/coding-discipline` — injects a deduplicated silent-mode and quality-discipline block at the very top of the main-session per-turn system prompt for GLM main-session models only (`isGlmModel`) immediately before the LLM request; non-GLM models are left untouched; disabled for async sub-agents
- `src/ast-grep` — `ast_grep` / `ast_apply`
- `src/async-subagents` — `subagents` tool and sub-agent slash commands, including oh-my-openagent-style `/ultrawork` (`/ulw`) and `/hyperplan` orchestration prompts, plus config-defined sub-agent model/thinking/args presets selected via `/subagent-preset` from `asyncSubagents` in `~/.config/pi/pi-tools-suite.jsonc`; includes the `frontend` profile for Gemini-friendly UI/UX and visual frontend work and the `oracle` profile for cross-provider second opinions; enforces a 30-minute per-agent execution timeout, project-wide `maxConcurrent` queueing, optional retry/backoff, and `result.json` structured metadata/chaining fields next to raw `result.md`; stores project-local run files and a registry under `.pi/subagents/` so result/status collection can recover after compaction or reload while the main session remains alive
- `src/lsp` — shared LSP diagnostics hook/library that enriches mutating tool results with diagnostics and shuts down language servers on session shutdown
- `src/comment-checker` — AI-slop comment guard that listens to the `tool_result` event for `write` / `edit` / `apply_patch` mutations, extracts net-new code comment lines, classifies them (filler phrasing, restating code, decorative separators, generic paraphrasing, or — under aggressive strictness — any non-valuable comment), and appends a short nudge to the tool result so the agent removes unnecessary comments on its next turn; TODO/FIXME, license headers, docstrings, pragmas, linter directives, shebangs, and decorators are never flagged; language-agnostic across `//` / `/* */` / `#` / `--` / `<!-- -->` / triple-quote comment styles; per-session deduplication (at most one nudge per 30 s) prevents fix/remark loops; configured via the `commentChecker` section (`enabled`, `strictness`: `conservative` | `balanced` | `aggressive`, default `balanced`) or `PI_COMMENT_CHECKER_ENABLED` / `PI_COMMENT_CHECKER_STRICTNESS`
- `src/session-name` — `session_name` tool for reading or setting the current session title directly from tool calls, without relying on slash-command parsing
- `src/repo-discovery` — `/idx-init`, `/idx-update`, and indexed-only `repo_architecture` / `repo_structure` / `repo_ast` / `repo_search` / `repo_explain` / `repo_deps`; tools register only when the launch project has `.indexer-cli`
- `src/antigravity-auth` — `antigravity` custom provider with Google Antigravity OAuth login, startup account list, auth.json-only runtime account loading, `/antigravity-add-account` OAuth append into rotation, `/antigravity-account` status display, account rotation/failover, Antigravity plus Gemini CLI model registration, and streaming through the Cloud Code Assist unified gateway
- `src/todo` — `todo` tool, `/todos`, `/todos-persist`, and `/todos-scope`; supports parent/subtask hierarchy, blockers, ready-task filtering, deferred out-of-scope items, batch operations, JSON/Markdown import/export, automatic clearing when all visible todos are completed, and optional project persistence via `/todos persist on` or `/todos-persist on`; localization/i18n has been removed
- `src/model-tools` — model-specific tool aliases such as Claude/GLM-style `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `LS`, GPT/Codex-style `shell`, and model-gated `apply_patch`
- `src/usage` — `/usage` command and startup hint for read-only AI quota checks across OpenAI, Zhipu AI, Z.ai, and Google Antigravity, including Antigravity quota by model
- `src/web-search` — `web_search` and `web_fetch` tools migrated from `@ollama/pi-web-search`; calls the local Ollama experimental web search/fetch APIs, honors `OLLAMA_HOST`, supports request timeouts via `timeout_ms` / `PI_WEB_SEARCH_TIMEOUT_MS`, and reports targeted `ollama signin`, unsupported-endpoint, invalid-response, timeout, DNS, and Ollama-not-running errors
- `src/dcp` — headless Dynamic Context Pruning ported from `opencode-dynamic-context-pruning` for the Pi SDK: explicit `compress` tool with range and message modes, `/dcp` commands (context, stats, sweep, manual, decompress, recompress, compress), same-call overlap validation, recoverable compressed-block rollups, grouped message-mode skip diagnostics, stable raw-message anchors when available, protected user/tool preservation, deduplication, error purging, and context nudges; visualization is left to `compress` tool responses and the renderer-owned context-percent click dialog
- `src/prompt-commands` — user slash-command builder: `/prompt-commands` opens a CRUD menu for saved prompt-backed slash commands, stores them under `promptCommands` in `~/.config/pi/pi-tools-suite.jsonc`, reloads after edits, and runs each saved prompt as a normal user message
- `src/skill-installer` — `/install-skill [name]` installs a personal skill folder from `~/.agents/local_skills` into the current project's `.pi/skills/` so it activates as a project-local skill, then automatically runs `/reload` so the new skill is picked up without a manual step; `/export-skill [name]` does the reverse, copying a project-local skill back to `~/.agents/local_skills/` for reuse in other projects (no reload, since the library lives outside the project); with no argument either command shows an interactive menu of available skills (folders containing `SKILL.md`), and the `<name>` form installs/exports it directly (headless-safe); existing destinations prompt to overwrite in the UI and are refused in headless mode; `.DS_Store` files are skipped

`index.ts` is intentionally only a thin auto-discovery shim that re-exports `src/index.ts`. There is no `pi.extensions` manifest here, so local Pi auto-discovery loads the suite once via `~/.pi/agent/extensions/pi-tools-suite/index.ts` and does not double-register tools.

Registration order is preserved in `src/index.ts`: coding-discipline, ast-grep, async-subagents, lsp, comment-checker, session-name, repo-discovery command/tool gate, antigravity-auth provider, todo, model-tools, usage, web-search, dcp, prompt-commands, then skill-installer. Tool metadata and active model-specific tool sets have two modes: standard and repo-aware. When `.indexer-cli` enables `repo_*`, those tools stay active ahead of overlapping lower-level aliases so the indexed discovery surface has priority.

## Disabling modules

Disable suite modules without editing `src/index.ts` via config or environment variables. On startup, `~/.config/pi/pi-tools-suite.jsonc` is created if it is missing with a commented `disabledModules` template. Config is loaded from that file, then `$PI_CONFIG_DIR/pi-tools-suite.jsonc`, then the nearest project `.pi/pi-tools-suite.jsonc`; later layers win.

```jsonc
{
  "disabledModules": ["web-search"]
}
```

Environment overrides are applied last:

```bash
PI_TOOLS_SUITE_DISABLED_MODULES=web-search pi ...
PI_TOOLS_SUITE_DISABLED=1 pi ...   # disables all pi-tools-suite modules
```

`disabledExtensions`, `enabledModules`, `enabledExtensions`, and an `extensions` map are accepted as aliases for the same module names. Use `*` or `all` in `PI_TOOLS_SUITE_DISABLED_MODULES` to skip every registered module.

Saved prompt slash commands are stored under `promptCommands`. Use `/prompt-commands` to create, edit, rename, delete, list, show the config path, or run them from an interactive menu. After a CRUD edit the module reloads Pi resources so the slash-command list reflects the config. Each saved command sends its saved prompt as a user message.

```jsonc
{
  "promptCommands": {
    "commands": {
      "review": {
        "description": "Run a focused code review prompt",
        "prompt": "Review the current change. Focus on correctness and risks."
      }
    }
  }
}
```

DCP settings are stored only under `dcp` in the user shared config file `~/.config/pi/pi-tools-suite.jsonc`. Legacy standalone `dcp.jsonc`, `$PI_CONFIG_DIR`, and project-local `.pi/pi-tools-suite.jsonc` DCP settings are intentionally ignored by the ported headless DCP module.

```jsonc
{
  "dcp": {
    "enabled": true,
    "compress": {
      "minContextPercent": "20%",
      "maxContextPercent": "55%",
      "maxContextLimit": 160000,
      "nudgeFrequency": 1,
      "iterationNudgeThreshold": 6,
      "nudgeForce": "strong",
      "protectedTools": ["compress", "write", "edit", "subagents"]
    },
    "modelOverrides": {
      "openai-codex/gpt-5*": {
        "compress": {
          "minContextPercent": "26%",
          "maxContextPercent": "46%"
        }
      },
      "openai-codex/gpt-5.4-mini": {
        "compress": {
          "minContextPercent": "20%",
          "maxContextPercent": "38%"
        }
      },
      "zai/*": {
        "compress": {
          "minContextPercent": "16%",
          "maxContextPercent": "30%"
        }
      },
      "antigravity/*sonnet*": {
        "compress": {
          "minContextPercent": "22%",
          "maxContextPercent": "40%"
        }
      },
      "antigravity/gemini-3.1-pro*": {
        "compress": {
          "minContextPercent": "24%",
          "maxContextPercent": "42%"
        }
      },
      "antigravity/gemini-3-flash*": {
        "compress": {
          "minContextPercent": "18%",
          "maxContextPercent": "34%"
        }
      },
      "antigravity/gemini-2.5-flash*": {
        "compress": {
          "minContextPercent": "18%",
          "maxContextPercent": "32%"
        }
      },
      "antigravity/antigravity-claude-opus-4-6-thinking": {
        "compress": {
          "minContextPercent": "26%",
          "maxContextPercent": "44%"
        }
      }
    }
  }
}
```

`minContextPercent` / `maxContextPercent` accept legacy fractions (`0.25`), percent strings (`"25%"`), or absolute token counts when Pi knows the current model context window. `minContextLimit` / `maxContextLimit` and `modelMinContextLimits` / `modelMaxContextLimits` are explicit absolute-or-percent aliases. `modelOverrides` and the `modelMin*` / `modelMax*` maps support exact model keys plus `*` / `?` wildcard patterns; matching is applied from generic to specific so exact bare-model matches override bare wildcards, and exact `provider/model` matches override provider wildcards. Array fields are union-merged, so model-specific `protectedTools` extend the defaults instead of replacing them. If `compress.protectUserMessages` is enabled, range compression appends selected user messages verbatim instead of rejecting the range; individual message compression still skips protected raw user messages. Protected tool outputs are copied into summaries for tools protected by name or `protectedFilePatterns`; protected `subagents` result reads also try to include the saved `result.md` artifact when available. Set `dcp.debug: true` to write a JSONL debug log of DCP context/prune/compress events to `~/.pi/agent/dcp-debug.jsonl` (override the path with `PI_DCP_DEBUG_LOG`, or enable without config via `PI_DCP_DEBUG=1`); off by default. The log is size-limited and rotated: once it reaches `dcp.debugLog.maxBytes` (default `5242880` = 5 MB) it is renamed to `.1`, older backups shift down (`.1`→`.2`, …) and the oldest beyond `dcp.debugLog.maxBackups` (default `3`, minimum `1`) is dropped; override either with `PI_DCP_DEBUG_MAX_BYTES` / `PI_DCP_DEBUG_MAX_BACKUPS`.

## LSP setup

The LSP module reads language-server definitions from `lsp.servers` in the shared config file:

```text
~/.config/pi/pi-tools-suite.jsonc
```

Install the language servers used by the bundled example config. The commands below are written for macOS/Linux with a POSIX shell; most npm, `dotnet`, `pip`, and `rustup` commands also work on Windows, but paths and the GDScript wrapper differ.

```bash
# TypeScript / JavaScript
npm install -g typescript typescript-language-server

# Python
python3 -m pip install --user python-lsp-server

# C# / Unity
dotnet tool install -g Microsoft.CodeAnalysis.LanguageServer

# GDScript / Godot
# Install Godot 4.x and make sure the `godot` command is on PATH.
# macOS Homebrew example. On other OSes, use the official Godot installer/package.
brew install --cask godot

# Ruby
brew install ruby-lsp
# or, if using RubyGems directly:
gem install ruby-lsp

# Rust
rustup component add rust-analyzer

# Markdown
npm install -g vscode-langservers-extracted
```

Extra runtime requirements:

- The GDScript wrapper also needs `nc` and `python3`; both are available by default on most macOS/Linux setups. The wrapper starts Godot headless on a free localhost port and the LSP manager kills the whole process group on shutdown/abort.
- C# expects `~/.dotnet/tools` on `PATH`, or an explicit `bin` path such as `~/.dotnet/tools/roslyn-language-server` in the config.
- Rust diagnostics require a Rust project root such as `Cargo.toml`.
- C#/Unity diagnostics require a project root such as `*.csproj`, `*.sln`, or Unity `ProjectSettings/ProjectVersion.txt`.
- Markdown link diagnostics are provided by `vscode-markdown-language-server` when validation is enabled; Mermaid fence checks are supplemented locally by pi-tools-suite, so no separate Mermaid LSP is required for the default diagnostics.

OS notes:

- macOS/Linux: the sample commands and default GDScript wrapper are intended to work as-is once the binaries are on `PATH`.
- Windows: npm, Python, .NET, Ruby, Rust, and Markdown servers can be installed natively, but adjust executable paths, for example `%USERPROFILE%\.dotnet\tools\roslyn-language-server.exe`. The bundled GDScript wrapper uses `bash`, `nc`, POSIX signals, and process groups, so use WSL/Git Bash or replace that server command with a Windows-specific wrapper.
- Package-manager commands vary by distro. Replace `brew install ...` with your OS package manager or the official installer where appropriate.

Minimal shared config shape:

```jsonc
{
  "lsp": {
    "servers": [
      {
        "id": "typescript",
        "include": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
        "rootMarkers": ["tsconfig.json", "package.json"],
        "bin": "typescript-language-server",
        "args": ["--stdio"],
        "languageIdByExtension": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".mjs": "javascript"
        }
      }
    ]
  }
}
```

Project-local overrides can be added in `.pi/pi-tools-suite.jsonc`; pi-tools-suite asks for trust before using project-local LSP binaries.

## Async sub-agents

Sub-agent model routing normally follows task overrides, subagent type config, then `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` fallbacks. Set `ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` (or `PI_SUBAGENTS_FORCE_CURRENT_MODEL=1`) to ignore task/config/env model choices and launch every sub-agent with the current parent session model. When this flag is enabled, any `--model` entries in sub-agent extra args are stripped so they cannot override the current model.

For an oh-my-openagent-style workflow, run `/ultrawork` or `/ulw` to ask the parent agent to split broad work into configured async-subagents roles (`quick`, `scan`, `research`, `docs`, `frontend`, `implement`, `tests`, `review`, `deep`, `oracle`). Set `ULTRAWORK=1` before launching Pi to apply that compact routing prompt to normal non-slash user inputs automatically. Set `ULTRAWORK_AUTO=1` to ask the lightweight router model to classify only the first normal user input on non-GPT parent models: clear broad/parallel work is transformed into ultrawork, vague potentially-complex work gets a soft delegation hint, and narrow work is left unchanged. GPT-like parent models skip only this automatic transform; they can still use `/ultrawork` and `subagents` normally. `frontend` is for UI/UX, styling, layout, responsive behavior, and visual component polish; `review` covers security/performance/audit tracks; `implement` covers refactors; `deep` covers debugging/root-cause; `oracle` is for sparse cross-provider second opinions on high-stakes uncertainty. Run `/hyperplan` to pressure-test a plan before implementation.

Async-subagents also injects a lightweight oh-my-openagent-style system-prompt strategy by model: non-GPT parents get `parallel-first`, an orchestration-first hint that favors ultrawork/subagents for broad work, while GPT-like parents get `deep-work`, a direct deep-worker hint that uses subagents only when clearly useful. Explicit custom system prompts (`--system-prompt`, `SYSTEM.md`, custom templates) are respected and skip this injection by default. Disable it with `PI_AGENT_STRATEGY=off`; force a strategy with `PI_AGENT_STRATEGY=parallel-first` or `PI_AGENT_STRATEGY=deep-work`; set `PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT=1` to append it even when a custom prompt is present.

For blind-model screenshot/image inspection, use the main-session `coding-discipline` lookup tool. Async-subagents still supports `imagePaths` on tasks when a broader delegated track genuinely needs images, but it no longer ships a dedicated `vision` role. Dynamic provider capabilities can be missing or stale after switching models, so blind parent models can still be configured explicitly with case-insensitive `*` masks under `asyncSubagents.vision.blindModelPatterns` in `~/.config/pi/pi-tools-suite.jsonc`; this keeps guidance honest, not a sub-agent role.

When a task omits `subagentType`, async-subagents asks a lightweight router model to choose one configured type for each task from the task text/scope and the `types.<name>.description` metadata. Explicit task `subagentType` still wins. Keep type descriptions short, literal, and distinct because they are inserted into the router prompt for a small model. Router settings live under `asyncSubagents.routing` (`enabled`, `model`, `maxTaskChars`, `maxTokens`, `maxRetries`, `timeoutMs`, `debug`); the default router model is `zai/glm-4.5-air`. If the router is disabled, unavailable, aborted, or returns invalid JSON, omitted types fall back to `defaultType`.

Define optional `presets` under `asyncSubagents` in `~/.config/pi/pi-tools-suite.jsonc`, `$PI_CONFIG_DIR/pi-tools-suite.jsonc`, or project `.pi/pi-tools-suite.jsonc`, then use `/subagent-preset` or `/subagent-preset-config` to pick one persistent active preset for future spawns across all sessions. Set `AGENTS_PRESET=<name>` before launching Pi to override the saved preset for only the current process/session without changing the saved selection. If Pi is already running, use `/subagent-preset session <name>` for the same process-only override, and `/subagent-preset session-clear` to remove that runtime override. The TUI only selects presets already present in config; it does not edit JSON. If no `asyncSubagents` section exists, run `/subagent-preset init` to insert the bundled sample from `src/async-subagents/async-subagents.sample.jsonc` into the shared config (or to copy a standalone override file when `ASYNC_SUBAGENTS_CONFIG` / `PI_SUBAGENTS_CONFIG` is set). Existing config sections/files are never overwritten. Presets select an agent/model configuration: they can provide global fallback `model`/`thinking`/`extraArgs` and per-role overrides under `asyncSubagents.presets.<name>.types.<subagentType>`. They can also provide ordered `fallbackModels` globally or per-role; when a sub-agent fails with quota/rate-limit errors such as 429, async-subagents immediately tries the next fallback model and remembers the exhausted provider for the current Pi process/session, so later spawns skip that provider until Pi exits. This is intended for provider-level fallback chains such as `antigravity/* → openai-codex/* → zai/*` or `openai-codex/* → zai/*`; omit fallbacks for effectively unlimited providers. Antigravity account rotation has priority over preset fallback: async-subagents only falls back after Antigravity reports that all configured accounts are exhausted for that model. Explicit task model overrides and force-current-model disable preset fallback for that task. The active preset name is stored separately in `~/.pi/agent/subagent-preset-selection.json`.

Example shared async-subagents config section:

```jsonc
{
  "asyncSubagents": {
    "defaultType": "quick",
    "routing": {
      "enabled": true,
      "model": "zai/glm-4.5-air",
      "timeoutMs": 12000
    },
    "presets": {
      "cheap": {
        "description": "Use GLM for text/code roles.",
        "types": {
          "quick": { "model": "zai/glm-5.2", "thinking": "off" },
          "frontend": { "model": "antigravity/gemini-3-flash-preview", "fallbackModels": ["zai/glm-5.2"], "thinking": "medium" },
          "review": { "model": "zai/glm-5.2", "thinking": "high" }
        }
      }
    },
    "types": {
      "frontend": {
        "description": "Use for frontend UI/UX visual work: styling, layout, typography, animation, responsive states, component polish, accessibility. Avoid backend/business logic unless needed for UI behavior.",
        "thinking": "medium"
      },
      "review": {
        "description": "Use for review/audit of existing code or changes: correctness, security, performance, maintainability, API risks, quality. Do not implement new code.",
        "thinking": "high"
      }
    }
  }
}
```

### Parent-model-aware model selection (`modelByParent`)

Any type profile can carry `modelByParent`: a map from glob model refs (matched against the **current parent model**, e.g. `"zai/*"`) to a model for that role. The first matching key wins. Values may be a model string or `{ "model": "...", "fallbackModels": [...] }`. It is resolved after an explicit task `model` / `forcedModel`, but **before** the preset/static profile `model`, so a role can always pick a model based on who the parent is — independent of the active preset.

The canonical use case is an **`oracle`** role that consults a flagship model from a *different* provider than the parent for a second opinion:

```jsonc
"oracle": {
  "description": "Cross-provider second opinion: consult a flagship from a different provider than the parent to pressure-test a hard decision. Read-only; advise, do not edit.",
  "model": "openai-codex/gpt-5.5",
  "fallbackModels": ["zai/glm-5.2"],
  "thinking": "xhigh",
  "modelByParent": {
    "zai/*":         { "model": "openai-codex/gpt-5.5", "fallbackModels": ["zai/glm-5.2"] },
    "openai-codex/*": "zai/glm-5.2",
    "antigravity/*": { "model": "zai/glm-5.2", "fallbackModels": ["openai-codex/gpt-5.5"] },
    "anthropic/*":   { "model": "openai-codex/gpt-5.5", "fallbackModels": ["zai/glm-5.2"] }
  }
}
```

With this config a GLM parent (`zai/*`) spawns the oracle on `gpt-5.5`, a GPT parent (`openai-codex/*`) spawns it on `glm-5.2`, and so on — automatically, at spawn time, with no `task.model` needed. The parent model ref is read from the spawn context (`ctx.model`) and passed into resolution. Pattern matching is case-insensitive `*` glob (same engine as `vision.blindModelPatterns`). When no key matches (or no parent model is known), the role falls back to its static `model` + `fallbackModels`. An explicit `task.model` or `ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` still overrides the match.

Sub-agents run with `--no-session` by default to avoid writing duplicate Pi session JSONL files for fire-and-forget background work. Set `ASYNC_SUBAGENTS_ENABLE_SESSIONS=1` to restore persisted per-agent sessions under each agent's `sessions/` directory; this also registers the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`) needed for switching and deeper post-mortem navigation.

Sub-agent runs are stored in the current project's `.pi/subagents/` directory while the main session is alive. Each spawn updates `.pi/subagents/registry.json` with the latest run and `agentId -> runDir` mappings. Because of that, `subagents({ action: "status" })`, `wait`, and `stop` can omit `runDir` to target the latest run, and `subagents({ action: "result", agentId: "..." })` can resolve the run from the registry even if the exact `runDir` was lost during compaction. Result reads always return a summary-first response with artifact paths; raw `result.md` and `stderr.log` are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs before the session ends. On normal main-session shutdown, Pi stops sub-agents and removes the project-local run files/registry to avoid leaving `.pi/subagents/` clutter behind; reload and fork shutdowns preserve them so in-process recovery still works.

Runtime logs are minimized by default: successful agents do not keep `events.jsonl`, and `stderr.log` is discarded unless the agent fails. Set `ASYNC_SUBAGENTS_DEBUG_LOGS=1` / `PI_SUBAGENTS_DEBUG_LOGS=1` to keep diagnostic logs for successful agents too; debug event logs store a compact RPC event summary instead of the full streaming transcript. Defaults are 0 bytes for `events.jsonl` without debug, 32 MiB for debug `events.jsonl`, 8 MiB for retained `stderr.log`, and 8 MiB for a single RPC JSON line; override with `ASYNC_SUBAGENTS_MAX_EVENTS_BYTES` / `PI_SUBAGENTS_MAX_EVENTS_BYTES`, `ASYNC_SUBAGENTS_MAX_STDERR_BYTES` / `PI_SUBAGENTS_MAX_STDERR_BYTES`, and `ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS` / `PI_SUBAGENTS_MAX_RPC_LINE_CHARS`.

`asyncSubagents` config also supports `maxConcurrent` (default 5, project-wide; `0` means unlimited), global/per-type `retry` with exponential backoff, global/per-type `maxResultBytes` for bounding `result.json.resultText` while keeping raw `result.md` intact, and global/per-type/preset `timeoutMs` for wall-clock agent watchdogs. Spawn calls and individual task objects can pass `timeoutSeconds` to shorten the watchdog for synthetic tests or bounded probes. Stop requests mark running, queued planned, and retry-pending agents as `stopped` so queued work is not launched later. Completed agents write `result.json` with status/duration/model/retry metadata plus best-effort `summary`, `findings`, `files`, `risks`, `nextActions`, and `confidence` fields for parent-agent chaining.

## Web search

`src/web-search` registers two Ollama-backed tools:

- `web_search` posts `{ query, max_results }` to `/api/experimental/web_search` and returns formatted title/URL/snippet results plus structured `details.results`.
- `web_fetch` posts `{ url }` to `/api/experimental/web_fetch` and returns extracted page text plus title/link metadata.

Both tools default to `http://localhost:11434`; set `OLLAMA_HOST` to point at another Ollama instance. Requests time out after 30 seconds by default. Override globally with `PI_WEB_SEARCH_TIMEOUT_MS` or per call with `timeout_ms` (maximum 120000 ms). Tool results include `host`, `timeoutMs`, and truncation metadata in `details`.

Troubleshooting:

| Symptom | Fix |
| --- | --- |
| `Could not connect to Ollama` | Start Ollama and check `OLLAMA_HOST`. |
| `Unauthorized by Ollama ... Run ollama signin` | Run `ollama signin`, then retry. |
| `endpoint is not available` | Update Ollama and make sure the experimental web search/fetch feature is enabled for that install. |
| `timed out after ...` | Increase per-call `timeout_ms` or `PI_WEB_SEARCH_TIMEOUT_MS` if the local web endpoint is slow. |
| `invalid JSON` / `unexpected response` | Check the Ollama version and the raw endpoint behavior; the tool reports the bad response shape instead of failing with a generic parser error. |

Do not send secrets, tokens, private repository text, or credential-bearing URLs through these tools; Ollama may query external web services to satisfy the request.

## Layout

```text
pi-tools-suite/
  index.ts
  package.json
  src/
    index.ts
    ast-grep/
    async-subagents/
    lsp/
    repo-discovery/
    antigravity-auth/
    todo/
    model-tools/
    usage/
    web-search/
    dcp/
    prompt-commands/
  docs/
  licenses/
  scripts/
  test/
```

## Checks

```bash
npm run smoke
npm test
npm run typecheck:async-subagents

# Optional longer/e2e checks
npm run test:async-subagents-e2e
npm run test:async-subagents-selection-e2e
npm run test:e2e
```

Supporting docs and historical standalone README content are kept in `docs/`; third-party license texts are kept in `licenses/`.

## SDK pin

This suite runs inside the Pi host process, so its `@earendil-works/*`
peerDependencies (`pi-ai`, `pi-coding-agent`, `pi-tui`) must match the host Pi
SDK version exactly. Otherwise npm can resolve a stale copy in this package's
own `node_modules` and cause a double-load (e.g. `0.75.4` here vs `0.79.4` in
the host).

The host repo keeps these aligned: `npm run sync:sdk-pin` rewrites these
peerDeps to the host version, and `npm run sync:sdk-pin:check` reports drift
(non-zero exit). When you bump the Pi SDK in the host `package.json`, the host
runs `sync:sdk-pin` and then you reinstall here:

```bash
npm install --ignore-scripts
```

The suite deliberately does not bump its own `version` field for SDK changes;
its peerDeps carry the version.

## Third-party notices

Parts of this extension suite are based on or adapted from code by other vendors and projects. The corresponding license texts and notices are included in `licenses/`.
