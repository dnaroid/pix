# pi-tools-suite

Local all-in-one Pi extension package.

This package keeps shared Pi tools as ordinary source folders under `src/` and registers them through one entrypoint.

- `src/coding-discipline` — injects a deduplicated silent-mode and quality-discipline block at the very top of the main-session per-turn system prompt for GLM main-session models only (`isGlmModel`) immediately before the LLM request; text-only GLM models get the `lookup` bridge while vision-capable `zai/glm-5.3-flash` inspects images directly; non-GLM models are left untouched; disabled for async sub-agents
- `src/credential-firewall` — opt-in secret firewall for high-confidence outbound/session credential redaction; disabled by default
- `src/ast-grep` — `ast_grep` / `ast_apply`
- `src/async-subagents` — `subagents` tool and sub-agent slash commands, including oh-my-openagent-style `/ultrawork` (`/ulw`) and `/hyperplan` orchestration prompts, plus config-defined sub-agent model/thinking/args presets selected via `/subagent-preset` from `asyncSubagents` in `~/.config/pi/pi-tools-suite.jsonc`; includes the `frontend` profile for Gemini-friendly UI/UX and visual frontend work and the `oracle` profile for cross-provider second opinions; enforces a 30-minute per-agent execution timeout, project-wide `maxConcurrent` queueing, optional retry/backoff, and `result.json` structured metadata/chaining fields next to raw `result.md`; stores project-local run files and a registry under `.pi/subagents/` so result/status collection can recover after compaction or reload while the main session remains alive
- `src/lsp` — shared LSP diagnostics hook/library that enriches mutating tool results with diagnostics and shuts down language servers on session shutdown
- `src/comment-checker` — AI-slop comment guard that listens to the `tool_result` event for `write` / `edit` / `apply_patch` mutations, extracts net-new code comment lines, classifies them (filler phrasing, restating code, decorative separators, generic paraphrasing, or — under aggressive strictness — any non-valuable comment), and appends a short nudge to the tool result so the agent removes unnecessary comments on its next turn; TODO/FIXME, license headers, docstrings, pragmas, linter directives, shebangs, and decorators are never flagged; language-agnostic across `//` / `/* */` / `#` / `--` / `<!-- -->` / triple-quote comment styles; per-session deduplication (at most one nudge per 30 s) prevents fix/remark loops; configured via the `commentChecker` section (`enabled`, `strictness`: `conservative` | `balanced` | `aggressive`, default `balanced`) or `PI_COMMENT_CHECKER_ENABLED` / `PI_COMMENT_CHECKER_STRICTNESS`
- `src/session-name` — `session_name` tool for reading or setting the current session title directly from tool calls, without relying on slash-command parsing
- `src/session-recovery` — branch- and compaction-aware `session_overview`, `session_read_section`, `session_search`, and `session_recovery_context` tools for bounded recovery from Pi's raw append-only session history
- `src/repo-discovery` — `/idx-init`, `/idx-update`, and indexed-only `repo_architecture` / `repo_structure` / `repo_ast` / `repo_search` / `repo_explain` / `repo_deps`; tools register only when the launch project has `.indexer-cli`
- `src/antigravity-auth` — `antigravity` custom provider with Google Antigravity OAuth login, startup account list, auth.json-only runtime account loading, `/antigravity-add-account` OAuth append into rotation, `/antigravity-account` status display, account rotation/failover, Antigravity plus Gemini CLI model registration, and streaming through the Cloud Code Assist unified gateway
- `src/opencode-import` — `/opencode-import` for bounded migration of supported OpenCode OpenAI/Codex, GitHub Copilot, Z.ai, and Antigravity credentials into Pi; existing entries are preserved unless `--force` is passed
- `src/todo` — `todo` tool, `/todos`, `/todos-persist`, `/todos-scope`, and `/todos-clear` (also `/todos clear`); supports parent/subtask hierarchy, blockers, ready-task filtering, deferred out-of-scope items, batch operations, JSON/Markdown import/export, automatic clearing when all visible todos are completed, and optional project persistence via `/todos persist on` or `/todos-persist on`; localization/i18n has been removed
- `src/model-tools` — model-specific tool aliases such as Claude/GLM-style `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `LS`, GPT/Codex-style `shell`, and model-gated `apply_patch`
- `src/usage` — `/usage` command and startup hint for read-only AI quota checks across OpenAI, Zhipu AI, Z.ai, and Google Antigravity, including Antigravity quota by model
- `src/web-search` — `web_search` and `web_fetch` tools migrated from `@ollama/pi-web-search`; uses local Ollama by default or the official Ollama cloud API when an API key is configured, supports Tavily Search/Extract fallback, provides `/web-credentials` for secure user-level key storage, honors `OLLAMA_HOST`, supports request timeouts via `timeout_ms` / `PI_WEB_SEARCH_TIMEOUT_MS`, and reports provider-specific errors
- `src/dcp` — headless Dynamic Context Pruning ported from `opencode-dynamic-context-pruning` for the Pi SDK: explicit `compress` tool with range and message modes, `/dcp` commands (context, stats, sweep, manual, decompress, recompress, compress), same-call overlap validation, recoverable compressed-block rollups, grouped message-mode skip diagnostics, stable raw-message anchors when available, protected user/tool preservation, deduplication, error purging, and context nudges; visualization is left to `compress` tool responses and the renderer-owned context-percent click dialog
- `src/prompt-commands` — user slash-command builder: `/prompt-commands` opens a CRUD menu for saved prompt-backed slash commands, stores them under `promptCommands` in `~/.config/pi/pi-tools-suite.jsonc`, reloads after edits, and runs each saved prompt as a normal user message
- `src/skill-installer` — `/install-skill [name]` installs a personal skill folder from `~/.agents/local_skills` into the current project's `.pi/skills/` so it activates as a project-local skill, then automatically runs `/reload` so the new skill is picked up without a manual step; `/export-skill [name]` does the reverse, copying a project-local skill back to `~/.agents/local_skills/` for reuse in other projects (no reload, since the library lives outside the project); with no argument either command shows an interactive menu of available skills (folders containing `SKILL.md`), and the `<name>` form installs/exports it directly (headless-safe); existing destinations prompt to overwrite in the UI and are refused in headless mode; `.DS_Store` files are skipped

`index.ts` is intentionally only a thin auto-discovery shim that re-exports `src/index.ts`. There is no `pi.extensions` manifest here, so local Pi auto-discovery loads the suite once via `~/.pi/agent/extensions/pi-tools-suite/index.ts` and does not double-register tools.

Registration order is preserved in `src/index.ts`: coding-discipline, ast-grep, async-subagents, lsp, comment-checker, session-name, session-recovery, repo-discovery command/tool gate, antigravity-auth provider, OpenCode import, todo, model-tools, usage, web-search, dcp, prompt-commands, skill-installer, credential-firewall, then codex-reasoning-fix. Tool metadata and active model-specific tool sets have two modes: standard and repo-aware. When `.indexer-cli` enables `repo_*`, those tools stay active ahead of overlapping lower-level aliases so the indexed discovery surface has priority.

## Session recovery

When context compaction obscures the task, start with `session_overview`, inspect a
relevant ID with `session_read_section`, and use `session_search` once a concrete
phrase, path, symbol, tool, or error is known. `session_recovery_context` is the
compact convenience view for original/latest user instructions, file evidence,
recent errors, pending calls, and the last meaningful action. All four tools read
through Pi's active `SessionManager`; they do not accept arbitrary session paths.
They default to the active branch, while `scope: "all"` includes abandoned branches.
See [`docs/session-recovery.md`](docs/session-recovery.md) for the full contract and
limits.

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

`credential-firewall` is disabled by default. Enable it explicitly with `"modules": { "credential-firewall": true }`. When enabled it replaces high-confidence secret material in the final provider payload with stable placeholders such as `<SECRET:github_token:1>`. `secretFirewall.sessionHygiene` (default `true`) applies the same redactor to tool results and completed messages before they remain in session history; `secretFirewall.notify` controls warnings. Entropy-only detection is intentionally not used yet to avoid corrupting hashes, IDs, minified assets, and other high-entropy non-secrets.

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

Todo thinking can be enabled globally and forced to a fixed level for selected models. `todoThinkingOverrides` keys accept exact `provider/model` or bare-model names plus `*` and `?` wildcards. Full provider/model matches beat bare-model matches, exact matches beat wildcards, and the more specific wildcard wins. The override is applied at runtime to create/update and batch create/update mutations even when the model requests another level or omits `thinking`. Unsupported levels are normalized to the nearest level supported by the current model. Later config layers can remove an inherited entry with `null`.

```jsonc
{
  "todoThinking": true,
  "todoThinkingOverrides": {
    "zai/glm-5.3": "max",
    "cheap-provider/*": "high"
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
    "strategies": {
      "emergencyCurrentTurnPruning": {
        "enabled": true,
        "hardContextPercent": 0.82,
        "targetContextPercent": 0.70,
        "patience": 2,
        "keepRecentToolPairs": 8,
        "minOutputTokens": 500,
        "maxSuggestions": 8,
        "protectedTools": []
      }
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

`minContextPercent` / `maxContextPercent` accept legacy fractions (`0.25`), percent strings (`"25%"`), or absolute token counts when Pi knows the current model context window. `minContextLimit` / `maxContextLimit` and `modelMinContextLimits` / `modelMaxContextLimits` are explicit absolute-or-percent aliases. `modelOverrides` and the `modelMin*` / `modelMax*` maps support exact model keys plus `*` / `?` wildcard patterns; matching is applied from generic to specific so exact bare-model matches override bare wildcards, and exact `provider/model` matches override provider wildcards. Array fields are union-merged, so model-specific `protectedTools` extend the defaults instead of replacing them. If `compress.protectUserMessages` is enabled, range compression appends selected user messages verbatim instead of rejecting the range; individual message compression still skips protected raw user messages. Protected tool outputs are copied into summaries for tools protected by name or `protectedFilePatterns`; protected `subagents` result reads also try to include the saved `result.md` artifact when available.

`strategies.emergencyCurrentTurnPruning` is the default-enabled lossy safety floor for a single unfinished turn that has no normal compression candidate. DCP first emits emergency reminders and offers only safe old same-turn tool-result candidates. After `patience` ignored reminders, or at the model-independent `hardContextPercent`, it replaces eligible oldest result bodies until the estimated provider context reaches `targetContextPercent` or a margin below the model emergency threshold. User messages, configured/protected data, the newest `keepRecentToolPairs`, and results not present in an accepted provider request are never selected. The raw session transcript is unchanged. Setting `enabled` to `false` disables same-turn candidates and lossy pruning, but keeps the non-destructive emergency reminder.

Set `dcp.debug: true` to write a JSONL debug log of DCP context/prune/compress events to `~/.pi/agent/dcp-debug.jsonl` (override the path with `PI_DCP_DEBUG_LOG`, or enable without config via `PI_DCP_DEBUG=1`); off by default. The log is size-limited and rotated: once it reaches `dcp.debugLog.maxBytes` (default `5242880` = 5 MB) it is renamed to `.1`, older backups shift down (`.1`→`.2`, …) and the oldest beyond `dcp.debugLog.maxBackups` (default `3`, minimum `1`) is dropped; override either with `PI_DCP_DEBUG_MAX_BYTES` / `PI_DCP_DEBUG_MAX_BACKUPS`.

## LSP setup

The LSP module reads language-server definitions from `lsp.servers` in the shared config file:

```text
~/.config/pi/pi-tools-suite.jsonc
```

Install the language servers used by the bundled example config. The commands below are written for macOS/Linux with a POSIX shell; most npm, `dotnet`, `pip`, and `rustup` commands also work on Windows, but paths and the GDScript wrapper differ.

```bash
# TypeScript / JavaScript
npm install -g typescript typescript-language-server

# Svelte
npm install -g svelte-language-server

# Vue
npm install -g @vue/language-server

# Python
python3 -m pip install --user python-lsp-server

# Go
go install golang.org/x/tools/gopls@latest

# C / C++ (clangd)
brew install llvm
# or use your distro's clangd package: apt install clangd, dnf install clang-tools-extra, ...

# Lua
brew install lua-language-server

# Bash
npm install -g bash-language-server

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

### Popular language-server examples

Copy the entries you need into `lsp.servers` of the shared config. Values mirror the commented templates shipped in the generated config file; where they disagree, the generated file is authoritative. Both diagnostics modes are on by default: servers that support pull diagnostics (`textDocument/diagnostic`) are queried directly, and push diagnostics (`publishDiagnostics`) are awaited for every server — `pullDiagnostics: false` / `waitForPublishDiagnostics: false` disable either side explicitly. Servers start lazily: one spawns only after a mutating tool (Edit/Write/ast-grep/apply_patch) touches a file matching `include`, and diagnostics land in that tool's result.

```jsonc
{
  "lsp": {
    "servers": [
      // Svelte (verified with svelte-language-server): compiler + embedded TS/JS diagnostics
      {
        "id": "svelte",
        "include": ["**/*.svelte"],
        "exclude": ["**/node_modules/**"],
        "rootMarkers": ["svelte.config.js", "package.json"],
        "bin": "svelteserver",
        "args": ["--stdio"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": { ".svelte": "svelte" }
      },
      // Vue (Volar)
      {
        "id": "vue",
        "include": ["**/*.vue"],
        "exclude": ["**/node_modules/**"],
        "rootMarkers": ["package.json"],
        "bin": "vue-language-server",
        "args": ["--stdio"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": { ".vue": "vue" }
      },
      // Python (python-lsp-server)
      {
        "id": "python",
        "include": ["**/*.py", "**/*.pyi"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/.tox/**", "**/.mypy_cache/**", "**/.ruff_cache/**"],
        "rootMarkers": ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", ".git"],
        "bin": "pylsp",
        "args": [],
        "languageIdByExtension": { ".py": "python", ".pyi": "python" }
      },
      // Go (gopls, push diagnostics)
      {
        "id": "go",
        "include": ["**/*.go"],
        "exclude": ["**/.git/**", "**/vendor/**"],
        "rootMarkers": ["go.mod", ".git"],
        "bin": "gopls",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": { ".go": "go" }
      },
      // Rust (rust-analyzer, push diagnostics)
      {
        "id": "rust",
        "include": ["**/*.rs"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/target/**"],
        "rootMarkers": ["Cargo.toml", "rust-project.json", ".git"],
        "bin": "rust-analyzer",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 20000,
        "pullDiagnostics": false,
        "waitForPublishDiagnostics": true,
        "languageIdByExtension": { ".rs": "rust" }
      },
      // C / C++ (clangd, push diagnostics)
      {
        "id": "clangd",
        "include": ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": ["compile_commands.json", "CMakeLists.txt", "Makefile", ".clang-format", ".git"],
        "bin": "clangd",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": {
          ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
          ".h": "c", ".hh": "cpp", ".hpp": "cpp"
        }
      },
      // C# / Unity (Roslyn)
      {
        "id": "csharp",
        "include": ["**/*.cs", "**/*.csx"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/bin/**", "**/obj/**", "**/.vs/**", "**/Library/**", "**/Temp/**", "**/Logs/**"],
        "rootMarkers": ["*.sln", "*.csproj", "global.json", "Directory.Build.props", "Directory.Packages.props", "Packages/manifest.json", "ProjectSettings/ProjectVersion.txt", ".git"],
        "bin": "~/.dotnet/tools/roslyn-language-server",
        "args": ["--stdio", "--autoLoadProjects", "--logLevel", "Error"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 15000,
        "languageIdByExtension": { ".cs": "csharp", ".csx": "csharp" }
      },
      // Ruby
      {
        "id": "ruby",
        "include": ["**/*.rb", "**/*.rake", "**/Gemfile", "**/Rakefile", "**/*.gemspec"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/vendor/bundle/**", "**/.bundle/**", "**/tmp/**", "**/log/**"],
        "rootMarkers": ["Gemfile.lock", "*.gemspec", "Rakefile", ".ruby-version", ".git"],
        "bin": "ruby-lsp",
        "args": [],
        "startupTimeoutMs": 60000,
        "diagnosticsWaitMs": 10000,
        "languageIdByExtension": { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby" }
      },
      // Lua (lua-language-server)
      {
        "id": "lua",
        "include": ["**/*.lua"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".luarc.json", ".git"],
        "bin": "lua-language-server",
        "args": [],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 6000,
        "languageIdByExtension": { ".lua": "lua" }
      },
      // Bash
      {
        "id": "bash",
        "include": ["**/*.sh", "**/*.bash"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".git"],
        "bin": "bash-language-server",
        "args": ["start"],
        "startupTimeoutMs": 15000,
        "diagnosticsWaitMs": 5000,
        "languageIdByExtension": { ".sh": "shellscript", ".bash": "shellscript" }
      },
      // Markdown (link validation settings ship in the generated config template)
      {
        "id": "markdown",
        "include": ["**/*.md", "**/*.markdown", "**/*.mdown", "**/*.mkd", "**/*.mmd"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".git", "package.json", "README.md"],
        "bin": "vscode-markdown-language-server",
        "args": ["--stdio"],
        "startupTimeoutMs": 15000,
        "diagnosticsWaitMs": 5000,
        "languageIdByExtension": { ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown", ".mkd": "markdown", ".mmd": "markdown" }
      }
    ]
  }
}
```

Notes:

- Svelte resolves `svelte` and `typescript` from the workspace `node_modules`, so project-local versions win; `.svelte.js`/`.svelte.ts` runes modules are not covered because their extensions collide with the TypeScript server.
- Vue requires `@vue/language-server` v2+ (the `vue-language-server` binary) plus the workspace's `vue` package for template type-checking.
- The full commented templates (including GDScript via a headless Godot wrapper and the complete Markdown link-validation `settings`) are written to the shared config file on first run.

## Async sub-agents

Sub-agent model routing normally follows task overrides, subagent type config, then `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` fallbacks. Set `ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` (or `PI_SUBAGENTS_FORCE_CURRENT_MODEL=1`) to ignore task/config/env model choices and launch every sub-agent with the current parent session model. When this flag is enabled, any `--model` entries in sub-agent extra args are stripped so they cannot override the current model.

For an oh-my-openagent-style workflow, run `/ultrawork` or `/ulw` to ask the parent agent to split broad work into configured async-subagents roles (`quick`, `scan`, `research`, `docs`, `frontend`, `browser-qa`, `implement`, `tests`, `review`, `deep`, `oracle`). Set `ULTRAWORK=1` before launching Pi to apply that compact routing prompt to normal non-slash user inputs automatically. Set `ULTRAWORK_AUTO=1` to ask the lightweight router model to classify only the first normal user input on non-GPT parent models: clear broad/parallel work is transformed into ultrawork, vague potentially-complex work gets a soft delegation hint, and narrow work is left unchanged. GPT-like parent models skip only this automatic transform; they can still use `/ultrawork` and `subagents` normally. `frontend` is for UI/UX, styling, layout, responsive behavior, and visual component polish; `browser-qa` reproduces browser bugs and proves fixes with deterministic assertions plus screenshot/video/trace evidence; `review` covers security/performance/audit tracks; `implement` covers refactors; `deep` covers debugging/root-cause; `oracle` is for sparse cross-provider second opinions on high-stakes uncertainty. Run `/hyperplan` to pressure-test a plan before implementation.

### Private browser QA and project auth

The built-in `browser-qa` role runs on `zai/glm-5.3-flash`, with
`openai-codex/gpt-5.6-luna` as its fallback. Its browser
workflow is an explicit private skill under `src/async-subagents/private-skills/`,
outside normal Pi skill discovery. The role's first-class `isolatedSkills` setting launches the child with
`--no-skills` plus one self-contained private workflow. It bundles the relevant
scenario-design, locator, waiting, assertion, evidence, and cleanup guidance next
to its trusted runner, so browser QA does not depend on a separately installed
skill or CLI. The private workflow remains mandatory when configuration appends
other isolated skills; parent and ordinary sub-agent sessions do not discover it.

Public browser QA does not require an auth profile or `.pi/qa_auth.jsonc`: run it
with an explicit base URL, whose exact origin becomes the fail-closed allowlist.
The runner neither creates nor requests a credential file for that path.

For targets that actually require login, keep named dev/staging auth profiles in
project `.pi/qa_auth.jsonc` (there is no `/qa-auth` command). The private runner
supports `form`, `cookie`, `localStorage`,
`sessionStorage`, `bearer`, and existing Playwright `storageState` auth. Every
profile must declare exact `allowedOrigins`; select the profile id explicitly only
for authenticated QA. On POSIX, keep the config at mode `0600`. During a run
those origins also form the fail-closed HTTP(S)/WebSocket allowlist and service
workers are blocked. Example:

```jsonc
{
  "profiles": {
    "staging-admin": {
      "description": "Staging administrator",
      "traits": ["role:admin", "plan:enterprise"],
      "baseUrl": "https://staging.example.test",
      "allowedOrigins": ["https://staging.example.test"],
      "auth": {
        "type": "form",
        "loginUrl": "https://staging.example.test/login",
        "fields": [
          { "selector": "input[name=email]", "value": "admin@example.test" },
          { "selector": "input[name=password]", "value": "replace-me" }
        ],
        "submitSelector": "button[type=submit]",
        "success": { "selector": "[data-testid=user-menu]" }
      }
    }
  }
}
```

Do not place credential values in prompts, QA flows, shell arguments, or reports.
The helper reads JSONC internally and emits only redacted statuses. For form auth,
video recording begins on the login page and captures the field-filling and submit
sequence; password inputs remain browser-masked, but the private video may show
other visible login identifiers and must be treated as sensitive evidence. Tracing
starts only after login succeeds and is sanitized before retention. The launcher
provides each browser QA process with its own
`.pi/subagents/<run>/<agent-id>/browser-qa/` workspace. Declarative flows,
screenshots, video, sanitized traces, and result manifests stay there, so normal
session shutdown or `subagents cleanup` removes them with the run directory.
The runner validates the owning agent metadata and refuses flows outside that
workspace; reusing an agent id clears stale browser QA files first. Trace archives
have network records and non-image resources removed, then known
configured/runtime credential values are redacted and verified before retention.
Listing profiles when the auth file is absent returns an empty list without
creating a template. Only an explicit authenticated request may create the
private template. Missing, rejected, or expired selected auth returns
`QA_AUTH_UPDATE_REQUIRED`, naming only the profile/file/reason needed for the
parent to ask the user for an update and rerun. See
`src/async-subagents/private-skills/browser-qa/references/qa-auth.example.jsonc`
for complete profile shapes and `references/qa-flow.example.jsonc` beside it for
the declarative, non-executable QA action/assertion format.

Browser QA videos automatically visualize pointer interactions. Clicks and
double-clicks show a transient cursor and pulse. Native drag/drop is replayed
for 450 ms with a large orange cursor, progressively drawn high-contrast path,
and green drop marker. The isolated, pointer-transparent layer is installed for
the whole browser context, including same-origin frames, declared popups, and
form-auth submission, and clears during the normal post-action stable interval
so screenshots and assertions remain state-focused.

Async-subagents also injects a lightweight oh-my-openagent-style system-prompt strategy by model: non-GPT parents get `parallel-first`, an orchestration-first hint that favors ultrawork/subagents for broad work, while GPT-like parents get `deep-work`, a direct deep-worker hint that uses subagents only when clearly useful. Explicit custom system prompts (`--system-prompt`, `SYSTEM.md`, custom templates) are respected and skip this injection by default. Disable it with `PI_AGENT_STRATEGY=off`; force a strategy with `PI_AGENT_STRATEGY=parallel-first` or `PI_AGENT_STRATEGY=deep-work`; set `PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT=1` to append it even when a custom prompt is present.

For blind-model screenshot/image inspection, use the main-session `coding-discipline` lookup tool; the bundled default uses vision-capable `zai/glm-5.3-flash`. Async-subagents still supports `imagePaths` on tasks when a broader delegated track genuinely needs images, but it no longer ships a dedicated `vision` role. Dynamic provider capabilities can be missing or stale after switching models, so blind parent models can still be configured explicitly with case-insensitive `*` masks under `asyncSubagents.vision.blindModelPatterns` in `~/.config/pi/pi-tools-suite.jsonc`; do not include `zai/glm-5.3-flash` because it accepts image input. This keeps guidance honest, not a sub-agent role.

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
        "description": "Use GLM by role, including GLM-5.3 Flash for multimodal work.",
        "types": {
          "quick": { "model": "zai/glm-5.3", "thinking": "off" },
          "frontend": { "model": "zai/glm-5.3-flash", "thinking": "medium" },
          "browser-qa": { "model": "zai/glm-5.3-flash", "fallbackModels": ["openai-codex/gpt-5.6-luna"], "thinking": "low" },
          "review": { "model": "zai/glm-5.3", "thinking": "high" }
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
  "model": "openai-codex/gpt-5.6-sol",
  "fallbackModels": ["zai/glm-5.3"],
  "thinking": "max",
  "modelByParent": {
    "zai/*":         { "model": "openai-codex/gpt-5.6-sol", "fallbackModels": ["zai/glm-5.3"] },
    "openai-codex/*": "zai/glm-5.3",
    "antigravity/*": { "model": "zai/glm-5.3", "fallbackModels": ["openai-codex/gpt-5.6-sol"] },
    "anthropic/*":   { "model": "openai-codex/gpt-5.6-sol", "fallbackModels": ["zai/glm-5.3"] }
  }
}
```

With this config a GLM parent (`zai/*`) spawns the oracle on `gpt-5.6-sol`, a GPT parent (`openai-codex/*`) spawns it on `glm-5.3`, and so on — automatically, at spawn time, with no `task.model` needed. The parent model ref is read from the spawn context (`ctx.model`) and passed into resolution. Pattern matching is case-insensitive `*` glob (same engine as `vision.blindModelPatterns`). When no key matches (or no parent model is known), the role falls back to its static `model` + `fallbackModels`. An explicit `task.model` or `ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` still overrides the match.

Sub-agents run with `--no-session` by default to avoid writing duplicate Pi session JSONL files for fire-and-forget background work. Set `ASYNC_SUBAGENTS_ENABLE_SESSIONS=1` to restore persisted per-agent sessions under each agent's `sessions/` directory; this also registers the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`) needed for switching and deeper post-mortem navigation.

Sub-agent runs are stored in the current project's `.pi/subagents/` directory while the main session is alive. Each spawn updates `.pi/subagents/registry.json` with the latest run and `agentId -> runDir` mappings. Because of that, `subagents({ action: "status" })`, `wait`, and `stop` can omit `runDir` to target the latest run, and `subagents({ action: "result", agentId: "..." })` can resolve the run from the registry even if the exact `runDir` was lost during compaction. Result reads always return a summary-first response with artifact paths; raw `result.md` and `stderr.log` are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs before the session ends. On normal main-session shutdown, Pi stops sub-agents and removes the project-local run files/registry to avoid leaving `.pi/subagents/` clutter behind; reload and fork shutdowns preserve them so in-process recovery still works.

Runtime logs are minimized by default: successful agents do not keep `events.jsonl`, and `stderr.log` is discarded unless the agent fails. Set `ASYNC_SUBAGENTS_DEBUG_LOGS=1` / `PI_SUBAGENTS_DEBUG_LOGS=1` to keep diagnostic logs for successful agents too; debug event logs store a compact RPC event summary instead of the full streaming transcript. Defaults are 0 bytes for `events.jsonl` without debug, 32 MiB for debug `events.jsonl`, 8 MiB for retained `stderr.log`, and 8 MiB for a single RPC JSON line; override with `ASYNC_SUBAGENTS_MAX_EVENTS_BYTES` / `PI_SUBAGENTS_MAX_EVENTS_BYTES`, `ASYNC_SUBAGENTS_MAX_STDERR_BYTES` / `PI_SUBAGENTS_MAX_STDERR_BYTES`, and `ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS` / `PI_SUBAGENTS_MAX_RPC_LINE_CHARS`.

`asyncSubagents` config also supports `maxConcurrent` (default 5, project-wide; `0` means unlimited), global/per-type `retry` with exponential backoff, global/per-type `maxResultBytes` for bounding `result.json.resultText` while keeping raw `result.md` intact, and global/per-type/preset `timeoutMs` for wall-clock agent watchdogs. Spawn calls and individual task objects can pass `timeoutSeconds` to shorten the watchdog for synthetic tests or bounded probes. Stop requests mark running, queued planned, and retry-pending agents as `stopped` so queued work is not launched later. Completed agents write `result.json` with status/duration/model/retry metadata plus best-effort `summary`, `findings`, `files`, `risks`, `nextActions`, and `confidence` fields for parent-agent chaining.

## OpenCode credential import

`/opencode-import` migrates only credential formats with an explicit Pi mapping: OpenAI OAuth to `openai-codex`, OpenAI API keys to `openai`, GitHub Copilot OAuth, Z.ai aliases, and one matching OpenCode Antigravity account. It does not migrate OpenCode model definitions, defaults, MCP servers, plugins, instructions, or tool settings.

The default source is `OPENCODE_AUTH_CONTENT`, `OPENCODE_DATA_DIR/auth.json`, or the XDG/default OpenCode data directory. The destination is the active Pi agent directory, including `PI_CODING_AGENT_DIR`. Existing Pi credentials are preserved; pass `--force` only to replace supported entries intentionally. Successful writes are atomic, use restrictive file permissions, and trigger a runtime reload. The command also accepts `--path`, `--auth-path`, `--antigravity-path`, `--skip-auth-json`, and `--skip-antigravity` for controlled migrations.

## Web search

`src/web-search` registers two Ollama-first tools and the `/web-credentials` setup command:

- `web_search` posts `{ query, max_results }` and returns formatted title/URL/snippet results plus structured `details.results`.
- `web_fetch` posts `{ url }` and returns extracted page text plus title/link metadata.
- `/web-credentials` can set, inspect, or clear stored Ollama and Tavily API keys. Notifications and status output never display key values.

Without an Ollama API key, both tools default to `http://localhost:11434/api/experimental/...`; set `OLLAMA_HOST` to point at another Ollama instance. With an Ollama API key and no explicit `OLLAMA_HOST`, they use the official `https://ollama.com/api/web_search` and `/api/web_fetch` endpoints with bearer authentication. Requests time out after 30 seconds by default. Override globally with `PI_WEB_SEARCH_TIMEOUT_MS` or per call with `timeout_ms` (maximum 120000 ms). Tool results include `host`, `timeoutMs`, and truncation metadata in `details`.

Configure a Tavily key to enable automatic fallback for both tools. Ollama remains the primary provider; if any Ollama request or response fails, `web_search` retries through `https://api.tavily.com/search` and `web_fetch` retries through `https://api.tavily.com/extract`. The Tavily key is sent only in Tavily's bearer authorization header and is never accepted as a tool parameter or included in result details. Fallback results set `details.provider` to `tavily` and include the primary Ollama error under `details.fallbackFrom`; ordinary results set `details.provider` to `ollama`.

The recommended interactive setup is:

```text
/web-credentials
```

Choose Ollama or Tavily, paste the key, and it becomes active for later calls without a reload. Keys are stored in `~/.config/pi/pi-tools-suite-credentials.json` with mode `0600`. The same command can show configuration sources or clear stored keys without displaying them.

The command displays the official key pages before opening its menu:

- Ollama: <https://ollama.com/settings/keys>
- Tavily: <https://app.tavily.com/home>

Environment variables remain supported and take precedence over stored keys:

```bash
export OLLAMA_API_KEY="..."
export TAVILY_API_KEY="tvly-..."
```

The timeout applies independently to each provider attempt, so a failed Ollama request followed by Tavily can take up to roughly twice the configured timeout. Tavily Search fallback uses basic search and clamps `max_results` to Tavily's documented maximum of 20. Tavily Extract does not return page title/link metadata, so fallback uses the requested URL as the title and reports no links.

Troubleshooting:

| Symptom | Fix |
| --- | --- |
| `Could not connect to Ollama` | Start Ollama and check `OLLAMA_HOST`. |
| `Unauthorized by Ollama` | Run `ollama signin` for local Ollama, or update the Ollama key through `/web-credentials` / `OLLAMA_API_KEY`. |
| `endpoint is not available` | Update Ollama and make sure the experimental web search/fetch feature is enabled for that install. |
| `timed out after ...` | Increase per-call `timeout_ms` or `PI_WEB_SEARCH_TIMEOUT_MS` if the local web endpoint is slow. |
| `invalid JSON` / `unexpected response` | Check the Ollama version and the raw endpoint behavior; the tool reports the bad response shape instead of failing with a generic parser error. |
| `Tavily ... rejected TAVILY_API_KEY` | Update the Tavily key through `/web-credentials` or `TAVILY_API_KEY`. |
| `Tavily ... limit was exceeded` | Check Tavily usage/plan limits in the Tavily dashboard. |

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

### Prompt evaluations

Prompt evaluations are opt-in because they call a real model. They cover model-facing behavior that deterministic tests cannot prove: tool selection for `todo` and `compress`, async-subagent delegation/lifecycle boundaries, default internal role routing, ultrawork classification, and DCP summary retention. They are intentionally excluded from `npm test`.

```bash
# Full prompt-eval suite
npm run test:prompt-evals

# Focused suites
npm run test:prompt-evals:tool-selection
npm run test:prompt-evals:async
npm run test:prompt-evals:dcp
```

The default live model is `zai/glm-5-turbo`. Override it for the whole suite with `PI_TOOLS_SUITE_E2E_MODEL=provider/model`, or use the existing component variables such as `TOOL_SELECTION_E2E_MODEL`, `ASYNC_SUBAGENTS_MODEL`, `ASYNC_SUBAGENTS_ROUTING_E2E_MODEL`, and `DCP_SUMMARY_E2E_MODEL`. The normal deterministic coverage remains `npm test`; run prompt evals after changing tool descriptions, routing/classifier prompts, DCP summary prompts, or the default evaluation model.

### Unified eval harness

`test/evals/` adds a shared deterministic + live-model eval layer. The coverage
gate requires every registered extension and model-facing tool to have a
deterministic contract. The initial live corpus contains 20 cases across tool
selection, coding quality, orchestration/escalation, and negative overuse
controls. Coding-quality fixtures use executable behavioral checks rather than
an LLM judge, while reports compare parent/worker tokens, provider-reported cost,
tool calls, changed files, and elapsed time.

```bash
# Deterministic coverage/contract gate only
npm run test:evals:contracts

# Live matrix as Bun tests. Models are comma/semicolon separated.
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3,openai-codex/gpt-5.6-luna,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-sol' \
  npm run test:evals:live

# Produce JSON + Markdown comparison artifacts.
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-sol' \
  npm run evals:report

# Focus the report runner when iterating
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3' \
PI_TOOLS_SUITE_EVAL_CATEGORIES='coding-quality,negative' \
  npm run evals:report
```

Live evals are opt-in. The deterministic coverage registry is part of normal
tests, so adding an extension or tool without eval coverage fails the gate. See
[`docs/evals.md`](docs/evals.md) for the architecture, complete 20-case catalog,
fixtures, assertions, metrics, model matrix, report format, environment
variables, CI recommendations, and the procedure for adding new evals.

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
