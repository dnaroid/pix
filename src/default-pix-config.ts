export const DEFAULT_PIX_CONFIG_JSONC = String.raw`{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pix.json",
  // pix renderer configuration
  "defaultModel": { "modelRef": "openai-codex/gpt-5.5", "thinking": "medium" },
  // Disable AGENTS.md / CLAUDE.md discovery for this project when set in <cwd>/.pi/pix.jsonc.
  "ignoreContextFiles": false,
  // Maximum pi session JSONL files to retain per project. 0 disables automatic deletion.
  "maxProjectSessions": 0,

  "toolRenderer": {
    "default": { "previewLines": 0, "direction": "head", "color": "toolTitle" },
    "tools": {
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

  "promptEnhancer": { "modelRef": "zai/glm-5-turbo" },
  "autocomplete": { "modelRef": "zai/glm-5-turbo", "debounceMs": 350, "timeoutMs": 3000, "maxTokens": 48, "maxPromptTokens": 1200, "includeRecentMessages": 0 },
  "sessionTitle": { "modelRef": "zai/glm-5-turbo" },
  "dictation": {
    "language": "en",
    "languages": {
      "en": { "dirName": "vosk-model-small-en-us-0.15", "url": "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip", "label": "English" },
      "ru": { "dirName": "vosk-model-small-ru-0.22", "url": "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip", "label": "Russian" }
    }
  }
}
`;
