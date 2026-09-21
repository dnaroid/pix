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
    "modelRef": "openai-codex/gpt-5.6-sol",
    "fallbackModels": [],
    "thinking": "medium"
  },
  "modelRouting": {
    "enabled": false,
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
    "modelRef": "openai-codex/gpt-5.6-luna",
    "fallbackModels": []
  },
  "autocomplete": {
    "modelRef": "zai/glm-5-turbo",
    "fallbackModels": [],
    "debounceMs": 350,
    "timeoutMs": 3000
  },
  "sessionTitle": {
    "modelRef": "openai-codex/gpt-5.6-luna",
    "fallbackModels": ["zai/glm-5-turbo"]
  },
  "dictation": { "language": "en" },
  "ignoreContextFiles": false,
  "maxProjectSessions": 0,
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

### Automatic first-prompt model routing

`modelRouting` is shared conceptually by TUI and Desktop but configured in
their separate profiles. It is disabled by default. When enabled, new
sessionless drafts expose an `Auto` model choice. Selecting `Auto` routes only
the first real user prompt, then creates the session directly with the chosen
tier's `modelRef` and `thinking`; resumed and existing sessions are never
re-routed.

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
Control review/commit-message models. TUI renderer/theme/tool-row settings remain
in `pix.jsonc`.

See [Pix Desktop](desktop.md).

## pi-tools-suite configuration

The bundled suite loads:

1. `~/.config/pi/pi-tools-suite.jsonc`;
2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;
3. the nearest project `.pi/pi-tools-suite.jsonc`.

Later files override earlier files.

Disable individual modules with `disabledModules` or
`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with
`PI_TOOLS_SUITE_DISABLED=1`.

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
- **Telegram connector:** configure `telegramConnector.botToken` /
  `telegramConnector.chatId`, or `PIX_TELEGRAM_BOT_TOKEN` /
  `PIX_TELEGRAM_CHAT_ID`.
- **LSP:** configure/trust servers in tools-suite configuration. See
  [pi-tools-suite LSP setup](../external/pi-tools-suite/README.md#lsp-setup).
- **IDX:** Desktop can install managed IDX from the IDX panel; TUI repository
  discovery requires `idx` plus a project `.indexer-cli` index.

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
