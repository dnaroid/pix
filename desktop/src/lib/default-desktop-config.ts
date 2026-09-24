export const DEFAULT_DESKTOP_CONFIG_JSONC = String.raw`{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json",
  "defaultModel": { "modelRef": "openai-codex/gpt-6-sol", "fallbackModels": [], "thinking": "medium" },
  "modelRouting": {
    "enabled": false,
    "default": false,
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
  "ignoreContextFiles": false,
  "promptEnhancer": { "modelRef": "openai-codex/gpt-6-luna", "fallbackModels": [] },
  "autocomplete": {
    "modelRef": "zai/glm-5-turbo",
    "fallbackModels": [],
    "debounceMs": 350,
    "timeoutMs": 3000,
    "maxTokens": 48,
    "maxPromptTokens": 1200,
    "includeRecentMessages": 0
  },
  "sessionTitle": { "modelRef": "openai-codex/gpt-6-luna", "fallbackModels": ["zai/glm-5-turbo"] },
  "dictation": {
    "apiKey": "",
    "language": "en",
    "model": "nova-3"
  },
  "desktop": {
    "notifications": {
      "enabled": true
    },
    "git": {
      "reviewModelRef": "openai-codex/gpt-6-luna:medium",
      "reviewFallbackModels": [],
      "commitMessageModelRef": "openai-codex/gpt-6-luna:minimal",
      "commitMessageFallbackModels": []
    }
  }
}
`;
