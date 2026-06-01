// Default user config written when pi-tools-suite.jsonc is missing.
export const DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC = `{
  // Disable individual pi-tools-suite modules by uncommenting entries below.
  // Later project config in .pi/pi-tools-suite.jsonc can re-enable modules.
  "disabledModules": [
    // "ast-grep",
    // "async-subagents",
    // "terminal-bell",
    // "lsp",
    // "repo-discovery",
    // "antigravity-auth",
    // "todo",
    // "model-tools",
    // "usage",
    // "web-search",
    // "compress"
  ],

  // Dynamic Context Pruning (DCP) / compress module config.
  "dcp": {
    "enabled": true,
    "manualMode": {
      "enabled": false,
      "automaticStrategies": true
    },
    "compress": {
      "minContextPercent": 0.25,
      "nudgeFrequency": 1,
      "iterationNudgeThreshold": 8
    }
  },

  "asyncSubagents": {
    "defaultType": "quick",
    "routing": {
      "enabled": true,
      "model": "zai/glm-4.5-air",
      "maxTaskChars": 1200,
      "maxTokens": 512,
      "maxRetries": 1,
      "temperature": 0,
      "timeoutMs": 12000,
      "debug": false
    },
    "presets": {
      "cheap": {
        "description": "Use cheap GLM/Gemini Flash models for text/code roles; keep vision on the enabled GPT vision model.",
        "types": {
          "quick": {
            "model": "zai/glm-4.5-air",
            "thinking": "off"
          },
          "scan": {
            "model": "zai/glm-4.5-air",
            "thinking": "off"
          },
          "research": {
            "model": "zai/glm-5-turbo",
            "thinking": "low"
          },
          "docs": {
            "model": "zai/glm-4.5-air",
            "thinking": "low"
          },
          "frontend": {
            "model": "antigravity/gemini-3-flash-preview",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "medium"
          },
          "tests": {
            "model": "zai/glm-5-turbo",
            "thinking": "medium"
          },
          "review": {
            "model": "zai/glm-5.1",
            "thinking": "high"
          },
          "implement": {
            "model": "zai/glm-5.1",
            "thinking": "high"
          },
          "deep": {
            "model": "zai/glm-5.1",
            "thinking": "high"
          },
          "vision": {
            "model": "openai-codex/gpt-5.4-mini",
            "thinking": "off"
          }
        }
      },
      "gpt": {
        "description": "Prefer enabled GPT-family models: spark/mini for cheap roles, gpt-5.5 for heavy roles; fallback cross-provider on quota.",
        "types": {
          "quick": {
            "model": "openai-codex/gpt-5.3-codex-spark",
            "fallbackModels": [
              "zai/glm-4.5-air"
            ],
            "thinking": "off"
          },
          "scan": {
            "model": "openai-codex/gpt-5.3-codex-spark",
            "fallbackModels": [
              "zai/glm-4.5-air"
            ],
            "thinking": "off"
          },
          "research": {
            "model": "openai-codex/gpt-5.4-mini",
            "fallbackModels": [
              "zai/glm-5-turbo"
            ],
            "thinking": "low"
          },
          "docs": {
            "model": "openai-codex/gpt-5.3-codex-spark",
            "fallbackModels": [
              "zai/glm-4.5-air"
            ],
            "thinking": "low"
          },
          "frontend": {
            "model": "antigravity/gemini-3-flash-preview",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "medium"
          },
          "tests": {
            "model": "openai-codex/gpt-5.4-mini",
            "fallbackModels": [
              "zai/glm-5-turbo"
            ],
            "thinking": "medium"
          },
          "review": {
            "model": "openai-codex/gpt-5.5",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "implement": {
            "model": "openai-codex/gpt-5.5",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "deep": {
            "model": "openai-codex/gpt-5.5",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "vision": {
            "model": "openai-codex/gpt-5.4-mini",
            "thinking": "off"
          }
        }
      },
      "deep": {
        "description": "Use only enabled strong models, mixing GPT, Claude, and Gemini by role.",
        "types": {
          "quick": {
            "model": "openai-codex/gpt-5.4-mini",
            "fallbackModels": [
              "zai/glm-4.5-air"
            ],
            "thinking": "low"
          },
          "scan": {
            "model": "antigravity/gemini-3-flash-preview",
            "fallbackModels": [
              "openai-codex/gpt-5.3-codex-spark",
              "zai/glm-4.5-air"
            ],
            "thinking": "off"
          },
          "research": {
            "model": "antigravity/gemini-3.1-pro-preview",
            "fallbackModels": [
              "openai-codex/gpt-5.4-mini",
              "zai/glm-5-turbo"
            ],
            "thinking": "medium"
          },
          "docs": {
            "model": "antigravity/gemini-2.5-flash",
            "fallbackModels": [
              "openai-codex/gpt-5.3-codex-spark",
              "zai/glm-4.5-air"
            ],
            "thinking": "medium"
          },
          "frontend": {
            "model": "antigravity/gemini-3.1-pro-preview-customtools",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "low"
          },
          "tests": {
            "model": "antigravity/antigravity-claude-sonnet-4-6",
            "fallbackModels": [
              "openai-codex/gpt-5.4-mini",
              "zai/glm-5-turbo"
            ],
            "thinking": "high"
          },
          "review": {
            "model": "antigravity/antigravity-claude-sonnet-4-6",
            "fallbackModels": [
              "openai-codex/gpt-5.5",
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "implement": {
            "model": "openai-codex/gpt-5.5",
            "fallbackModels": [
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "deep": {
            "model": "antigravity/antigravity-claude-opus-4-6-thinking",
            "fallbackModels": [
              "openai-codex/gpt-5.5",
              "zai/glm-5.1"
            ],
            "thinking": "high"
          },
          "vision": {
            "model": "openai-codex/gpt-5.4-mini",
            "thinking": "off"
          }
        }
      }
    },
    "types": {
      "quick": {
        "description": "Use for tiny cheap tasks: answer a simple question, inspect one known file, or verify one fact. Not for broad repo search.",
        "model": "zai/glm-5-turbo",
        "thinking": "off"
      },
      "scan": {
        "description": "Use for finding files, symbols, text, or inventory across a repo. Return paths/facts; do not judge code quality.",
        "model": "zai/glm-5-turbo",
        "thinking": "off",
        "tools": [
          "read",
          "grep"
        ]
      },
      "research": {
        "description": "Use for multi-file codebase research: read several files and explain how something works. No edits.",
        "model": "zai/glm-5-turbo",
        "thinking": "low",
        "tools": [
          "read",
          "grep"
        ]
      },
      "docs": {
        "description": "Use for documentation work: README/API docs review, docs gaps, changelog, migration notes, examples.",
        "model": "zai/glm-5-turbo",
        "thinking": "low"
      },
      "frontend": {
        "description": "Use for frontend UI/UX visual work: styling, layout, typography, animation, responsive states, component polish, accessibility. Avoid backend/business logic unless needed for UI behavior.",
        "model": "antigravity/gemini-3-flash-preview",
        "fallbackModels": [
          "openai-codex/gpt-5.4-mini",
          "zai/glm-5.1"
        ],
        "thinking": "medium",
        "promptAppend": [
          "Act as a frontend UI/UX engineer for visual and product-facing work.",
          "Prioritize layout, typography, spacing, color, motion, responsive states, accessibility, and consistency with the existing design system.",
          "Before editing, inspect nearby components/styles and infer the project's design language. Avoid backend/business-logic changes unless required for UI behavior.",
          "When no mockup exists, choose a clear aesthetic direction and explain it briefly. Verify with targeted build/lint/tests or screenshot-relevant checks when possible."
        ]
      },
      "tests": {
        "description": "Use for tests: locate coverage, find gaps, run/check targeted test commands, diagnose failing tests.",
        "model": "zai/glm-5-turbo",
        "thinking": "medium",
        "tools": [
          "read",
          "grep",
          "bash"
        ]
      },
      "review": {
        "description": "Use for review/audit of existing code or changes: correctness, security, performance, maintainability, API risks, quality. Do not implement new code.",
        "model": "openai-codex/gpt-5.5",
        "fallbackModels": [
          "zai/glm-5.1"
        ],
        "thinking": "high",
        "tools": [
          "read",
          "grep"
        ]
      },
      "implement": {
        "description": "Use when the sub-agent should make or plan code changes for a feature, bug fix, or refactor.",
        "model": "openai-codex/gpt-5.5",
        "fallbackModels": [
          "zai/glm-5.1"
        ],
        "thinking": "high"
      },
      "deep": {
        "description": "Use for broad hard reasoning: architecture, system design, cross-module impact, complex tradeoffs.",
        "model": "openai-codex/gpt-5.5",
        "fallbackModels": [
          "zai/glm-5.1"
        ],
        "thinking": "high"
      },
      "vision": {
        "description": "Use only when task has imagePaths, screenshots, or asks to inspect visible UI/image content for a text-only parent.",
        "model": "openai-codex/gpt-5.4-mini",
        "thinking": "off",
        "promptAppend": [
          "You are a vision helper for a parent model that may not be able to see images.",
          "Inspect any attached images and any image paths mentioned in the task/scope. Describe concrete visible details, UI state, text, layout, errors, and uncertainties.",
          "If focus instructions are provided, prioritize them, but still mention other important visible findings.",
          "Do not make code changes. Return a compact visual description that the parent agent can rely on."
        ]
      }
    }
  },

  // Compact tool-renderer preview policy and name colors by tool name.
  // direction=head keeps the first lines; direction=tail keeps the last lines.
  // color accepts a Pi theme color name or a #rrggbb RGB literal. Tool entries
  // override default and can also set compactHidden.
  "toolRenderer": {},

  "promptCommands": {
    "commands": {
      "commit": {
        "prompt": "Commit all changes"
      }
    }
  }
}
`;
