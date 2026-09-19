export const DEFAULT_DESKTOP_CONFIG_JSONC = String.raw`{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json",
  "defaultModel": { "modelRef": "openai-codex/gpt-5.6-sol", "fallbackModels": [], "thinking": "medium" },
  "ignoreContextFiles": false,
  "promptEnhancer": { "modelRef": "openai-codex/gpt-5.6-luna", "fallbackModels": [] },
  "autocomplete": {
    "modelRef": "zai/glm-5-turbo",
    "fallbackModels": [],
    "debounceMs": 350,
    "timeoutMs": 3000,
    "maxTokens": 48,
    "maxPromptTokens": 1200,
    "includeRecentMessages": 0
  },
  "sessionTitle": { "modelRef": "openai-codex/gpt-5.6-luna", "fallbackModels": ["zai/glm-5-turbo"] },
  "dictation": {
    "apiKey": "",
    "language": "en",
    "model": "nova-3"
  },
  "desktop": {
    "externalEditor": "zed",
    "git": {
      "reviewModelRef": "openai-codex/gpt-5.6-luna:medium",
      "reviewFallbackModels": [],
      "commitMessageModelRef": "openai-codex/gpt-5.6-luna:minimal",
      "commitMessageFallbackModels": []
    }
  }
}
`;
