export const DEFAULT_PIX_CONFIG_JSONC = String.raw`{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pix.json",
  // pix renderer configuration
  "defaultModel": { "modelRef": "openai-codex/gpt-5.6-sol", "fallbackModels": [], "thinking": "medium" },
  "modelRouting": {
    "enabled": false,
    "modelRef": "openrouter/~typesafe/jev-latest",
    "fallbackModels": [],
    "defaultTier": "standard",
    "tiers": [
      { "id": "simple", "description": "Simple questions, lookups, explanations, and small localized edits.", "modelRef": "openrouter/~openai/gpt-luna-latest", "thinking": "minimal" },
      { "id": "standard", "description": "Normal implementation work, routine debugging, and moderate multi-file changes.", "modelRef": "openrouter/~openai/gpt-terra-latest", "thinking": "medium" },
      { "id": "complex", "description": "Complex debugging, architecture, broad refactors, and tasks with multiple interacting systems.", "modelRef": "openrouter/~openai/gpt-sol-latest", "thinking": "high" },
      { "id": "expert", "description": "Exceptionally difficult, ambiguous, or high-risk work requiring maximum reasoning depth.", "modelRef": "openrouter/~openai/gpt-astra-latest", "thinking": "xhigh" }
    ]
  },
  // Optional TUI model-picker whitelist. Desktop keeps an independent whitelist in pix-desktop.jsonc.
  // "visibleModels": ["openai-codex/gpt-5.6-sol", "zai/glm-5-turbo"],
  // Last applied thinking level per model for TUI. Desktop keeps independent preferences.
  // "thinkingByModel": { "openai-codex/gpt-5.6-sol": "high", "zai/glm-5-turbo": "max" },
  // Disable AGENTS.md / CLAUDE.md discovery for this project when set in <cwd>/.pi/pix.jsonc.
  "ignoreContextFiles": false,
  // Maximum pi session JSONL files to retain per project. 0 disables automatic deletion.
  "maxProjectSessions": 0,
	"desktop": {
    // Legacy compatibility field. Pix Desktop reads externalEditor from pix-desktop.jsonc instead.
    "externalEditor": "zed",
		"git": {
			// TUI LLM used by /code-review. Desktop keeps an independent Source Control preference.
      "reviewModelRef": "openai-codex/gpt-5.6-luna:medium",
      "reviewFallbackModels": [],
			// TUI LLM used by /commit-message. Desktop keeps an independent Source Control preference.
      "commitMessageModelRef": "openai-codex/gpt-5.6-luna:minimal",
      "commitMessageFallbackModels": []
    }
  },

  "toolRenderer": {
    "default": { "previewLines": 0, "direction": "head", "color": "toolTitle" },
    "tools": {
      "thinking": { "previewLines": 0, "direction": "head", "color": "assistantForeground" },
      "bash": { "previewLines": 6, "direction": "tail", "color": "warning" },
      "Bash": { "previewLines": 6, "direction": "tail", "color": "warning" },
      "shell": { "previewLines": 6, "direction": "tail", "color": "warning" },
      "shell_command": { "previewLines": 6, "direction": "tail", "color": "warning" },
      "repo_*": { "previewLines": 6, "direction": "head", "color": "warning" },
      "apply_patch": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "edit": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "Edit": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "write": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "Write": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "ast_apply": { "defaultExpanded": true, "previewLines": 9999, "direction": "head", "color": "toolMutation" },
      "Read": { "previewLines": 0, "direction": "head", "color": "success" },
      "read": { "previewLines": 0, "direction": "head", "color": "success" },
      "ast_grep": { "previewLines": 6, "direction": "head", "color": "toolSearch" },
      "ast_*": { "color": "toolSearch" },
      "compress": { "previewLines": 0, "direction": "head", "color": "info" },
      "web_search": { "previewLines": 6, "direction": "tail", "color": "toolSearch" },
      "web_fetch": { "previewLines": 12, "direction": "tail", "color": "toolSearch" },
      "question": { "previewLines": 6, "direction": "tail", "color": "accent" },
      "subagents": { "previewLines": 0, "direction": "tail", "color": "muted" },
      "todo": { "hidden": true, "color": "accent" },
      "ls": { "previewLines": 6, "direction": "head", "color": "success" },
      "LS": { "previewLines": 6, "direction": "head", "color": "success" },
      "grep": { "previewLines": 6, "direction": "head", "color": "toolSearch" },
      "Grep": { "previewLines": 6, "direction": "head", "color": "toolSearch" },
      "find": { "previewLines": 6, "direction": "head", "color": "toolSearch" },
      "Glob": { "previewLines": 6, "direction": "head", "color": "toolSearch" },
      "skill": { "previewLines": 0, "color": "toolSearch" }
    }
  },

  // Assistant output filters; supports glob-style wildcards or regex literals.
  // "outputFilters": { "patterns": ["secret-*", "/token=\\w+/"] },

  "modelColors": {
    "zai/*": "success",
    "openai-codex/*": "modelOpenAI",
    "antigravity/*": "warning",
    "antigravity/antigravity-claude-*": "error"
  },

  "promptEnhancer": { "modelRef": "openai-codex/gpt-5.6-luna", "fallbackModels": [] },
  "autocomplete": { "modelRef": "zai/glm-5-turbo", "fallbackModels": [], "debounceMs": 350, "timeoutMs": 3000, "maxTokens": 48, "maxPromptTokens": 1200, "includeRecentMessages": 0 },
  "sessionTitle": { "modelRef": "openai-codex/gpt-5.6-luna", "fallbackModels": ["zai/glm-5-turbo"] },
  "dictation": {
    // Deepgram API key used by terminal voice input. Desktop uses pix-desktop.jsonc.
    // Keep secrets in this user config (~/.config/pi/pix.jsonc), not project .pi/pix.jsonc.
    "apiKey": "",
    "language": "en",
    "model": "nova-3",
    "languages": {
      "en": { "deepgramLanguage": "en", "label": "English" },
      "ru": { "deepgramLanguage": "ru", "label": "Russian" }
    }
  }
}
`;
