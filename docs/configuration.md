# Configuration and accounts

<!-- markdownlint-disable MD013 -->

Pix uses Pi's provider ecosystem and authentication stores, but the TUI and Pix
Desktop keep separate frontend configuration profiles.

## TUI configuration

User profile:

```text
~/.config/pi/pix.jsonc
```

Project override:

```text
<workspace>/.pi/pix.jsonc
```

Schema:

```text
https://unpkg.com/pi-ui-extend/schemas/pix.json
```

Example:

```jsonc
{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pix.json",
  "defaultModel": {
    "modelRef": "openai-codex/gpt-6.1-sol",
    "fallbackModels": [],
    "thinking": "medium"
  },
  "modelRouting": {
    "enabled": false,
    "default": false,
    "modelRef": "openrouter/~typesafe/jev-latest",
    "fallbackModels": [],
    "defaultTier": "standard",
    "tiers": [
      {
        "id": "simple",
        "description": "Simple questions, lookups, explanations, and small localized edits.",
        "modelRef": "openrouter/~openai/gpt-luna-latest",
        "thinking": "minimal"
      },
      {
        "id": "standard",
        "description": "Normal implementation work, routine debugging, and moderate multi-file changes.",
        "modelRef": "openrouter/~openai/gpt-terra-latest",
        "thinking": "medium"
      },
      {
        "id": "complex",
        "description": "Complex debugging, architecture, broad refactors, and tasks with multiple interacting systems.",
        "modelRef": "openrouter/~openai/gpt-sol-latest",
        "thinking": "high"
      },
      {
        "id": "expert",
        "description": "Exceptionally difficult, ambiguous, or high-risk work requiring maximum reasoning depth.",
        "modelRef": "openrouter/~openai/gpt-astra-latest",
        "thinking": "xhigh"
      }
    ]
  },
  "promptEnhancer": {
    "modelRef": "openai-codex/gpt-6-luna",
    "fallbackModels": []
  },
  "autocomplete": {
    "modelRef": "zai/glm-5-turbo",
    "fallbackModels": [],
    "debounceMs": 350,
    "timeoutMs": 3000
  },
  "sessionTitle": {
    "modelRef": "openai-codex/gpt-6-luna",
    "fallbackModels": ["zai/glm-5-turbo"]
  },
  "dictation": { "language": "en" },
  "ignoreContextFiles": false,
  "maxProjectSessions": 0,
  "memoryWatchdog": { "enabled": true, "thresholdMb": 3072, "heapSnapshot": true },
  "toolRenderer": {
    "default": { "previewLines": 0 },
    "tools": {
      "shell": { "previewLines": 6, "direction": "tail" },
      "repo_*": { "previewLines": 6, "direction": "head" },
      "apply_patch": { "defaultExpanded": true }
    }
  }
}
```

Project settings override the user profile. Use `/settings` to inspect the
effective settings summary and `/reload` after changing resources.

### Memory watchdog

The TUI samples its own memory every 15 seconds. When RSS crosses
`memoryWatchdog.thresholdMb` (default `3072`), Pix shows a warning toast and
writes a leak report to `~/.config/pi/memory-reports/pix-memory-<time>-<pid>.json`:
the memory timeline for the last hour (RSS, JS heap, external and ArrayBuffer
memory), V8 heap-space statistics, active handles, and app counters such as
open tabs and loaded runtimes. Another report is written each time RSS doubles
again, and only the five newest reports are kept.

With `heapSnapshot: true` (default) the first report also gets a
`.heapsnapshot` next to it, which you can open in Chrome DevTools → Memory. The
snapshot write briefly pauses the UI, and it is skipped when the JS heap is
above 4 GiB. A growing `rssMb` with a flat `heapUsedMb` in the timeline points
at memory outside the JS heap (buffers, native modules). Every 20th sample (about
every five minutes) and every report are also logged to `~/.config/pi/pix.log`.

Turn the watchdog off with `"memoryWatchdog": { "enabled": false }` (or
`"memoryWatchdog": false`) and restart Pix.

### Automatic first-prompt model routing

`modelRouting` is shared conceptually by TUI and Desktop but configured in
their separate profiles. It is disabled by default. When enabled, new
sessionless drafts expose an `Auto` model choice. Selecting `Auto` routes only
the first real user prompt, then creates the session directly with the chosen
tier's `modelRef` and `thinking`; resumed and existing sessions are never
re-routed.

Set `modelRouting.default` to `true` to make new conversation drafts start in
`Auto`. The combined model/thinking pickers in both frontends can set either
`Auto` or the currently staged concrete model + thinking pair as the default
directly, so editing JSONC is not required.

The primary router defaults to OpenRouter Jev Latest. Jev is called through
OpenRouter's Decisions API as a semantic choice over the configured tier
`id`/`description` pairs. `fallbackModels` are ordinary router models tried
in order if the primary router cannot decide. `defaultTier` is the deterministic
fallback when every router attempt fails. Target model refs are not shown to the
router, so changing the concrete model behind a semantic tier does not change
the routing vocabulary.

When routing is enabled, `Auto` is visible in the normal model picker as well
as the New Conversation draft picker. Selecting `Auto` from an existing
conversation does not re-route that conversation; Pix opens or reuses a New
Conversation draft and enables Auto there.

Desktop exposes the same fields in Settings → Models, including editable tier
rows. The router provider needs valid credentials independently of the target
tier providers.

## Desktop configuration

Pix Desktop has an independent profile:

```text
~/.config/pi/pix-desktop.jsonc
<workspace>/.pi/pix-desktop.jsonc
```

Schema:

```text
https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json
```

Desktop settings cover Desktop/ACP behavior such as model defaults, model-picker
visibility/preferences, prompt helpers, voice, external editor and Source
Control review/commit-message/CI-repair models. Leaving the Source Control
**CI fix model** unset makes **Fix with AI** use the normal default model for
its new repair session. TUI renderer/theme/tool-row settings remain
in `pix.jsonc`.

### Desktop Universal Search: Auto intent

The Universal Search dialog (`Cmd+Shift+F`) offers **Auto · Jev** (default),
**Search**, and **RAG**. Search never makes an intent-router request. Auto
uses OpenRouter Jev Latest Decisions to choose between finding results and
generating a source-grounded answer. Classification happens only after the
user submits a query, never as the user types.

Auto requires the saved OpenRouter credential used by Pix. **Only the search
query** is sent to OpenRouter for this decision; project files, history,
indexed snippets and workspace paths are not uploaded by the classifier.
Provider charges may apply. If the key or Jev is unavailable, Auto falls back
to regular Search. This is separate from the `modelRouting` Auto model picker and
from semantic settings/session-title consent preferences.

RAG retrieves the selected sources from the existing search indexes, reads
bounded original excerpts as needed and streams a Markdown answer **inside**
Universal Search, with clickable [1], [2], ... references to the original
file/line, commit diff, session, task or setting. It is a separate model call,
not a Pi agent session. Retrieved code, documentation and session excerpts
may be sent to your selected RAG model provider; the provider may charge for
generation. No full-history or full-diff embedding index is created.

Choose a **RAG answer model** and **RAG thinking effort** under
Desktop Settings → Assistant. They are saved in the user Desktop profile as
`search.ragModelRef` (empty means Desktop default model) and
`search.ragThinking` (default `medium`). They are independent of the active
conversation model and the Jev router. Search and the RAG answer view allow
stopping/cancelling work without affecting existing conversations.

See [Pix Desktop](desktop.md).

### Desktop Observer defaults

**Settings → Desktop → Observer** edits the `headsUp` object in the Desktop
profile. For example:

```jsonc
{
  "headsUp": {
    "enabled": false,
    "model": "openai-codex/gpt-6-luna",
    "minTurns": 6,
    "minIntervalMs": 60000,
    "maxChecksPerHour": 12
  }
}
```

Additional fields are `maxInputChars`, `maxInputCharsPerHour`, `maxTokens`,
`timeoutMs` and `noticeTtlMs`. The settings UI shows time in seconds and saves
milliseconds. Model refs and numeric bounds are validated; fields can reset to
defaults. These settings apply to new or reloaded Desktop runtimes. The
statusbar popup's switch saves a per-session choice, restored after app restart,
without changing configuration or other sessions. An explicit saved choice takes
precedence over the enable default; all other observer settings still use the
profile. A trusted project `.pi/pix-desktop.jsonc` can override defaults.
Desktop does not inherit `heads-up.jsonc`; that remains the TUI observer config.
Enabling an observer sends bounded conversation excerpts to its chosen provider.

## pi-tools-suite configuration

The bundled suite loads:

1. `~/.config/pi/pi-tools-suite.jsonc`;
2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;
3. the nearest project `.pi/pi-tools-suite.jsonc`.

Later files override earlier files.

Disable individual modules with `disabledModules` or
`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with
`PI_TOOLS_SUITE_DISABLED=1`.

To hide selected bundled async-subagent roles without disabling the sub-agent
module, use `disabledBuiltinAgents`. A later config layer can re-enable inherited
names with `enabledBuiltinAgents`. These keys affect bundled roles only;
same-named project roles in `.pi/agents/*.md` remain available.
Desktop exposes the user-level `disabledBuiltinAgents` list under
**Settings → Tools Suite → General → Built-in agents**.
The same General section exposes built-in suite modules as an enabled/disabled
checklist instead of raw `enabledModules` / `disabledModules` / `modules` JSON.

DCP is intentionally narrower than the general suite layering above: its
`dcp` section is read only from the user-level
`~/.config/pi/pi-tools-suite.jsonc`. Protected tool continuity is bounded by
`dcp.compress.maxProtectedToolContinuityBytes` (default `16384`). The budget
applies to shaped tool receipts/digests in one compression block; exact
protected fragments are never silently truncated to satisfy it. Receipts show
raw output size only; content hashes stay in fragment metadata and are not
sent to the model.

## Model providers

Pix uses credentials supported by Pi. The common paths are:

| Need | Setup |
| --- | --- |
| Normal provider auth | Run stock Pi (`npx @earendil-works/pi-coding-agent`) and use `/login`, or configure the provider's supported environment/API-key source |
| Existing OpenCode credentials | Run `/opencode-import` in Pix |
| Main model | Use `/model` |
| Default model/thinking | Use `/default-model`, `/default-thinking` |
| Scoped model list | Use `/scoped-models` |
| Usage/quota view | Use `/usage` |

Pix currently does not reproduce Pi's interactive `/login` / `/logout`
dialogs. Authenticate in stock Pi, then reload Pix.

Helper models such as autocomplete, prompt enhancement, session titles and Git
review may use different providers from the active conversation. Each helper's
provider needs its own valid credential.

## OpenCode migration

Run:

```text
/opencode-import
```

Supported mappings intentionally remain narrow:

- OpenAI OAuth → Pi `openai-codex`;
- OpenAI API key → Pi `openai`;
- GitHub Copilot OAuth → `github-copilot`;
- Z.ai/Zhipu-compatible credentials → `zai`;
- OpenCode Antigravity account → Pi Antigravity provider.

Existing Pi provider credentials are preserved by default. Use
`/opencode-import --force` only when replacement is intentional.

OpenCode model definitions, MCP servers, plugins, instructions and tool settings
are not migrated automatically because their formats/security assumptions do not
map safely.

## Voice input

Put a Deepgram key in the frontend-specific user profile:

```jsonc
{
  "dictation": {
    "apiKey": "your-deepgram-api-key",
    "language": "en"
  }
}
```

- TUI: `~/.config/pi/pix.jsonc`;
- Desktop: `~/.config/pi/pix-desktop.jsonc`.

`DEEPGRAM_API_KEY` remains supported as a compatibility fallback.

The TUI also needs an audio recorder such as SoX, `ffmpeg`, or `arecord` on
Linux.

Desktop requests a short-lived Deepgram token from the local Tauri backend; the
permanent key is not exposed to the WebView. The key used for Deepgram
`/v1/auth/grant` needs Member-or-higher authorization. Desktop also needs OS
microphone permission.

## Optional integrations

- **Web search:** local Ollama can work without a cloud key; cloud Ollama/Tavily
  credentials can be configured with `/web-credentials`.
- **Context7:** export `CONTEXT7_API_KEY`.
- **LSP:** configure/trust servers in tools-suite configuration. See
  [pi-tools-suite LSP setup](../external/pi-tools-suite/README.md#lsp-setup).
- **IDX:** Desktop can install managed IDX from the IDX panel; TUI repository
  discovery requires `idx` plus a project `.indexer-cli` index.

### IDX embedding providers

Installing `indexer-cli` with npm (including Desktop's managed install) requires
neither an API key nor Ollama; installation does not run setup or initialize a
project.

For a **new** project, `idx init` defaults to OpenRouter:
`perplexity/pplx-embed-v1-0.6b` for both code and documents, with 1024 dimensions.
Set `OPENROUTER_API_KEY` in the environment or `~/.config/idx/.env`; Ollama is not
needed. `idx setup` also defaults to OpenRouter, requires that key and skips
Ollama. Never commit real keys.

For local embeddings, explicitly use `idx setup --embedding local` and
`idx init --embedding local`. This mode requires Ollama with `jina-8k` for code
and `nomic-embed-text-v2-moe` for documents (768 dimensions), but no API key.
Tests/benchmarks that initialize a real local index must pass `--embedding local`
instead of relying on a default; mocked CLI tests need no embedding service.

Re-running `idx init` **without** `--embedding` preserves the existing project's
configuration, including older local configurations. There is no automatic
OpenRouter migration. In Desktop, an unchecked OpenRouter override means no
flag, **not** local mode. For explicit local initialization use the CLI.

`idx doctor` without an override checks dependencies of the saved providers in
the selected projects. A mixed local/OpenRouter set needs both Ollama and the
OpenRouter key; with no projects it defaults to OpenRouter prerequisites.
`idx doctor --embedding local|openrouter` explicitly selects the provider for
dependency checks and full reinitialization. A missing key or any prerequisite
failure must stop repair **before deleting the index**. An explicit provider
change rebuilds the derived index; vectors from different modes must not mix.
Do not switch an existing project without separate user approval.

Index storage stays local in both modes. In OpenRouter mode, however, code and
document chunks **and search queries are sent to an external service**. Agents
must disclose this before initialization and avoid paid indexing/semantic
queries merely to verify setup. Ollama-based web search is a separate integration
and is not an IDX OpenRouter prerequisite.

## Ignoring legacy context files

To override an unwanted `AGENTS.md` / `CLAUDE.md` in one directory, create:

```bash
touch AGENTS.override.md
```

Keep the override local without changing repository history:

```bash
echo AGENTS.override.md >> .git/info/exclude
```

To disable all context-file discovery:

- stock Pi: `pi --no-context-files` / `pi -nc`;
- Pix TUI: `/no-context-files on`.

Pix stores that project choice as `"ignoreContextFiles": true` in
`<workspace>/.pi/pix.jsonc`. Start a new session/restart Pix after changing the
setting.
