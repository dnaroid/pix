export const DEFAULT_PIX_CONFIG_JSONC = String.raw`{
  // pix renderer configuration
  // See https://github.com/your-org/pi-ui-extend for docs
  "toolRenderer": {
    // Default rules applied to all tools without specific overrides
    "default": {
      "previewLines": 0,
      "direction": "head",
      "color": "toolTitle"
    },

    // Per-tool overrides (supports wildcard patterns like repo_*, ast_*)
    "tools": {
      // Shell / command execution
      "bash": {
        "previewLines": 6,
        "direction": "tail",
        "color": "warning"
      },
      "Bash": {
        "previewLines": 6,
        "direction": "tail",
        "color": "warning"
      },
      "shell": {
        "previewLines": 6,
        "direction": "tail",
        "color": "warning"
      },
      "shell_command": {
        "previewLines": 6,
        "direction": "tail",
        "color": "warning"
      },

      // Repository / code intelligence tools
      "repo_*": {
        "previewLines": 6,
        "direction": "head",
        "color": "warning"
      },

      // Patch / write tools
      "apply_patch": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },
      "edit": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },
      "Edit": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },
      "write": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },
      "Write": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },

      "ast_apply": {
        "defaultExpanded": true,
        "previewLines": 9999,
        "direction": "head",
        "color": "toolMutation"
      },

      // Read-only tools
      "Read": {
        "previewLines": 0,
        "direction": "head",
        "color": "success"
      },
      "read": {
        "previewLines": 0,
        "direction": "head",
        "color": "success"
      },

      // AST / search tools
      "ast_grep": {
        "previewLines": 6,
        "direction": "head",
        "color": "toolSearch"
      },
      "ast_*": {
        "color": "toolSearch"
      },

      // Compress (context compaction)
      "compress": {
        "previewLines": 0,
        "direction": "head",
        "color": "info"
      },

      // Web tools
      "web_search": {
        "previewLines": 6,
        "direction": "tail",
        "color": "toolSearch"
      },
      "web_fetch": {
        "previewLines": 12,
        "direction": "tail",
        "color": "toolSearch"
      },

      // Interactive
      "question": {
        "previewLines": 6,
        "direction": "tail",
        "color": "accent"
      },

      // Sub-agents
      "subagents": {
        "previewLines": 0,
        "direction": "tail",
        "color": "muted"
      },

      // Todo
      "todo": {
        "hidden": true,
        "color": "accent"
      },

      // File listing / search
      "ls": {
        "color": "success"
      },
      "LS": {
        "color": "success"
      },
      "grep": {
        "color": "toolSearch"
      },
      "Grep": {
        "color": "toolSearch"
      },
      "find": {
        "color": "toolSearch"
      },
      "Glob": {
        "color": "toolSearch"
      },

      // Skills
      "skill": {
        "color": "toolSearch",
        "previewLines": 0
      }
    }
  },

  // Output filters applied to assistant text in the renderer.
  // Supports glob-style * wildcards, or regex literals like "/<dcp-id>m\\d+<\\/dcp-id>/".
  // "outputFilters": {
  //   "patterns": [
  //     "<dcp-id>m*</dcp-id>"
  //   ]
  // },

  // Status bar model colors. Patterns match provider/model and longest match wins.
  "modelColors": {
    "zai/*": "success",
    "openai-codex/*": "modelOpenAI",
    "antigravity/*": "warning",
    "antigravity/antigravity-claude-*": "error"
  },

  // Prompt improver sidecar model. Uses a hidden in-memory Pi session.
  "promptEnhancer": {
    "modelRef": "zai/glm-5-turbo"
  },

  // Session title sidecar model. Generates a short name from the first user message.
  "sessionTitle": {
    "modelRef": "zai/glm-5-turbo"
  },

  // Dictation languages. Only uncommented entries are enabled in the UI.
  // When a single language is enabled, the language switcher is hidden.
  "dictation": {
    "language": "en",
    "languages": {
      "en": {
        "dirName": "vosk-model-small-en-us-0.15",
        "url": "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip",
        "label": "English"
      }
      // ,"en-in": {
      //   "dirName": "vosk-model-small-en-in-0.4",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip",
      //   "label": "Indian English"
      // }
      // ,"cn": {
      //   "dirName": "vosk-model-small-cn-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip",
      //   "label": "Chinese"
      // }
      ,"ru": {
        "dirName": "vosk-model-small-ru-0.22",
        "url": "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip",
        "label": "Russian"
      }
      // ,"fr": {
      //   "dirName": "vosk-model-small-fr-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip",
      //   "label": "French"
      // }
      // ,"de": {
      //   "dirName": "vosk-model-small-de-0.15",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip",
      //   "label": "German"
      // }
      // ,"es": {
      //   "dirName": "vosk-model-small-es-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip",
      //   "label": "Spanish"
      // }
      // ,"pt": {
      //   "dirName": "vosk-model-small-pt-0.3",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip",
      //   "label": "Portuguese"
      // }
      // ,"el": {
      //   "dirName": "vosk-model-el-gr-0.7",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-el-gr-0.7.zip",
      //   "label": "Greek"
      // }
      // ,"tr": {
      //   "dirName": "vosk-model-small-tr-0.3",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-tr-0.3.zip",
      //   "label": "Turkish"
      // }
      // ,"vn": {
      //   "dirName": "vosk-model-small-vn-0.4",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-vn-0.4.zip",
      //   "label": "Vietnamese"
      // }
      // ,"it": {
      //   "dirName": "vosk-model-small-it-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-it-0.22.zip",
      //   "label": "Italian"
      // }
      // ,"nl": {
      //   "dirName": "vosk-model-small-nl-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-nl-0.22.zip",
      //   "label": "Dutch"
      // }
      // ,"ca": {
      //   "dirName": "vosk-model-small-ca-0.4",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ca-0.4.zip",
      //   "label": "Catalan"
      // }
      // ,"ar": {
      //   "dirName": "vosk-model-ar-mgb2-0.4",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-ar-mgb2-0.4.zip",
      //   "label": "Arabic"
      // }
      // ,"ar-tn": {
      //   "dirName": "vosk-model-small-ar-tn-0.1-linto",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ar-tn-0.1-linto.zip",
      //   "label": "Arabic Tunisian"
      // }
      // ,"fa": {
      //   "dirName": "vosk-model-small-fa-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-fa-0.42.zip",
      //   "label": "Persian"
      // }
      // ,"tl": {
      //   "dirName": "vosk-model-tl-ph-generic-0.6",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-tl-ph-generic-0.6.zip",
      //   "label": "Filipino"
      // }
      // ,"uk": {
      //   "dirName": "vosk-model-small-uk-v3-nano",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-uk-v3-nano.zip",
      //   "label": "Ukrainian"
      // }
      // ,"kz": {
      //   "dirName": "vosk-model-small-kz-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-kz-0.42.zip",
      //   "label": "Kazakh"
      // }
      // ,"sv": {
      //   "dirName": "vosk-model-small-sv-rhasspy-0.15",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-sv-rhasspy-0.15.zip",
      //   "label": "Swedish"
      // }
      // ,"ja": {
      //   "dirName": "vosk-model-small-ja-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip",
      //   "label": "Japanese"
      // }
      // ,"eo": {
      //   "dirName": "vosk-model-small-eo-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-eo-0.42.zip",
      //   "label": "Esperanto"
      // }
      // ,"hi": {
      //   "dirName": "vosk-model-small-hi-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-hi-0.22.zip",
      //   "label": "Hindi"
      // }
      // ,"cs": {
      //   "dirName": "vosk-model-small-cs-0.4-rhasspy",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-cs-0.4-rhasspy.zip",
      //   "label": "Czech"
      // }
      // ,"pl": {
      //   "dirName": "vosk-model-small-pl-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip",
      //   "label": "Polish"
      // }
      // ,"uz": {
      //   "dirName": "vosk-model-small-uz-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-uz-0.22.zip",
      //   "label": "Uzbek"
      // }
      // ,"ko": {
      //   "dirName": "vosk-model-small-ko-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ko-0.22.zip",
      //   "label": "Korean"
      // }
      // ,"br": {
      //   "dirName": "vosk-model-br-0.8",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-br-0.8.zip",
      //   "label": "Breton"
      // }
      // ,"gu": {
      //   "dirName": "vosk-model-small-gu-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-gu-0.42.zip",
      //   "label": "Gujarati"
      // }
      // ,"tg": {
      //   "dirName": "vosk-model-small-tg-0.22",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-tg-0.22.zip",
      //   "label": "Tajik"
      // }
      // ,"te": {
      //   "dirName": "vosk-model-small-te-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-te-0.42.zip",
      //   "label": "Telugu"
      // }
      // ,"ky": {
      //   "dirName": "vosk-model-small-ky-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ky-0.42.zip",
      //   "label": "Kyrgyz"
      // }
      // ,"ka": {
      //   "dirName": "vosk-model-small-ka-0.42",
      //   "url": "https://alphacephei.com/vosk/models/vosk-model-small-ka-0.42.zip",
      //   "label": "Georgian"
      // }
    }
  }
}
`;
