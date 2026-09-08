// Default user config written when pi-tools-suite.jsonc is missing.
export const DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC = String.raw`{
  "$schema": "https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json",
  "disabledModules": [
    // "ast-grep",
    // "dcp"
  ],
  // Secret firewall is deliberately opt-in for now. Flip this to true to enable
  // high-confidence outbound redaction plus session-history hygiene.
  "modules": {
    "credential-firewall": false,
    // Optional non-store cleanup: removes only SDK truncation metadata text
    // proven to duplicate the already-visible result. Context Gateway observe
    // remains passive because this module is separate and disabled by default.
    "truncation-metadata-normalizer": false
  },
  "secretFirewall": {
    "sessionHygiene": true,
    "notify": true
  },
  // Context Gateway is passive/off by default. P01 supports off/observe only;
  // enforce is explicitly refused until capture/store/reader integration lands.
  "contextGateway": {
    "mode": "off",
    "budgets": {
      "maxInlineBytes": 8192,
      "maxResultBytes": 8192,
      "maxExactReadBytes": 32768,
      "maxSearchBytes": 8192,
      "maxSearchMatches": 12
    }
  },
  // Baseline preserves the historical repo_* argv/defaults. Native Compact is
  // an explicit experimental arm with bounded native flags/cursors/output.
  "repoDiscovery": {
    "profile": "baseline"
  },
  // Private Git repository used as the reusable resource registry. Create the
  // repo first, then set remote with /registry configure <git-url>.
  "resourceRegistry": {
    // "remote": "git@github.com:you/pix-resources.git",
    "branch": "main"
    // Optional per-project override. Normally the project key is derived from
    // the current repository's Git origin and stored under registry/projects/.
    // "projectKey": "github.com__you__my-project"
  },
  // When true, todo items may carry a per-task thinking level and the todo
  // module will switch/restore Pi's thinking level as in-progress tasks change.
  "todoThinking": true,
  // Force every todo mutation made under matching models to the configured
  // thinking level. Supports provider/model or bare-model keys with * / ? globs.
  // Set an inherited key to null in a later config layer to remove it.
  "todoThinkingOverrides": {
    "zai/glm-5.3": "max"
  },
  // Vision-capable model used by the coding-discipline lookup tool for blind-model
  // screenshot/image questions. Remove or set to null to disable lookup.
  "lookupModel": "zai/glm-5.3-flash",
  "terminalBell": { "sound": true },
  // comment-checker: nudges the agent to remove AI-slop code comments it just
  // added via write/edit/apply_patch. Net-new comments are classified and a
  // short notice is appended to the tool result when they look unnecessary
  // (filler phrasing, restating code, decorative separators, generic
  // paraphrasing). TODO/FIXME, license headers, docstrings, pragmas, linter
  // directives, and shebangs are never flagged. Strictness:
  //   "conservative" — only obvious AI-slop (filler/decorative);
  //   "balanced"     — + restate-code + generic-explanation (default);
  //   "aggressive"   — any non-valuable net-new comment.
  "commentChecker": { "enabled": true, "strictness": "balanced" },
  "dcp": {
    "enabled": true,
    // Write a JSONL debug log of DCP context/prune/compress events to
    // ~/.pi/agent/dcp-debug.jsonl. Also overridable via env
    // PI_DCP_DEBUG=1 / PI_DCP_DEBUG_LOG=/path. Off by default.
    // The log is size-limited and rotated: when it reaches debugLog.maxBytes
    // (default 5 MB) it is renamed to .1, pushing older backups down and
    // dropping the oldest past debugLog.maxBackups (default 3).
    "debug": false,
    "debugLog": { "maxBytes": 5242880, "maxBackups": 3 },
    "manualMode": { "enabled": false },
    "strategies": {
      "emergencyCurrentTurnPruning": {
        // Disabling this turns off same-turn candidates and lossy pruning;
        // non-destructive emergency reminders remain active.
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
      // glm-5.3 reports a ~1M-token window. Even zai/* 16%/30% = 160K/300K is
      // above the ~15% (~150K) point where long sessions degrade, and an
      // observed 14h/273K-token session never crossed 16%. Lower ONLY glm-5.3
      // within the zai family: 8%/15% (~80K/150K) so nudging starts early and
      // auto-compress fires at the observed degradation point. Other zai/*
      // models keep 16%/30%.
      "zai/glm-5.3": {
        "compress": {
          "minContextPercent": "8%",
          "maxContextPercent": "15%",
          "autoCandidates": { "minContextPercent": 0.08 },
          "messageMode": { "minContextPercent": 0.08 }
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
    },
    "compress": {
      "minContextPercent": "20%",
      "maxContextPercent": "55%",
      "nudgeFrequency": 1,
      "iterationNudgeThreshold": 4,
      "nudgeForce": "strong",
      "autoCandidates": { "minContextPercent": 0.2 },
      "messageMode": { "minContextPercent": 0.2 },
      "autoCompress": {
        "enabled": false,
        "patience": 2,
        "summarizerModel": ["zai/glm-5-turbo", "openai-codex/gpt-5.6-luna"],
        "timeoutMs": 20000
      }
    }
  },
  "toolRenderer": {},
  "promptCommands": {
    "commands": {
      "commit": { "prompt": "Commit all changes" }
    }
  },
  // LSP language servers. TypeScript/JavaScript is enabled by default;
  // uncomment additional server blocks after installing their binaries.
  "lsp": {
    "servers": [
      {
        "id": "typescript",
        "include": [
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.mjs"
        ],
        "exclude": [
          "**/node_modules/**",
          "**/.next/**"
        ],
        "rootMarkers": [
          "tsconfig.json",
          "package.json"
        ],
        "bin": "typescript-language-server",
        "args": [
          "--stdio"
        ],
        "languageIdByExtension": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".mjs": "javascript"
        }
      }
      // ,
      // {
      //   "id": "svelte",
      //   "include": [
      //     "**/*.svelte"
      //   ],
      //   "exclude": [
      //     "**/node_modules/**"
      //   ],
      //   "rootMarkers": [
      //     "svelte.config.js",
      //     "package.json"
      //   ],
      //   "bin": "svelteserver",
      //   "args": [
      //     "--stdio"
      //   ],
      //   "startupTimeoutMs": 30000,
      //   "diagnosticsWaitMs": 8000,
      //   "languageIdByExtension": {
      //     ".svelte": "svelte"
      //   }
      // }
      // ,
      // {
      //   "id": "python",
      //   "include": [
      //     "**/*.py",
      //     "**/*.pyi"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**",
      //     "**/__pycache__/**",
      //     "**/.venv/**",
      //     "**/venv/**",
      //     "**/.tox/**",
      //     "**/.mypy_cache/**",
      //     "**/.ruff_cache/**"
      //   ],
      //   "rootMarkers": [
      //     "pyproject.toml",
      //     "setup.py",
      //     "setup.cfg",
      //     "requirements.txt",
      //     "Pipfile",
      //     "poetry.lock",
      //     ".git"
      //   ],
      //   "bin": "pylsp",
      //   "args": [],
      //   "languageIdByExtension": {
      //     ".py": "python",
      //     ".pyi": "python"
      //   }
      // }
      // ,
      // {
      //   "id": "csharp",
      //   "include": [
      //     "**/*.cs",
      //     "**/*.csx"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**",
      //     "**/bin/**",
      //     "**/obj/**",
      //     "**/.vs/**",
      //     "**/Library/**",
      //     "**/Temp/**",
      //     "**/Logs/**"
      //   ],
      //   "rootMarkers": [
      //     "*.sln",
      //     "*.csproj",
      //     "global.json",
      //     "Directory.Build.props",
      //     "Directory.Packages.props",
      //     "Packages/manifest.json",
      //     "ProjectSettings/ProjectVersion.txt",
      //     ".git"
      //   ],
      //   "bin": "~/.dotnet/tools/roslyn-language-server",
      //   "args": [
      //     "--stdio",
      //     "--autoLoadProjects",
      //     "--logLevel",
      //     "Error"
      //   ],
      //   "startupTimeoutMs": 30000,
      //   "diagnosticsWaitMs": 15000,
      //   "languageIdByExtension": {
      //     ".cs": "csharp",
      //     ".csx": "csharp"
      //   }
      // }
      // ,
      // {
      //   "id": "gdscript",
      //   "include": [
      //     "**/*.gd",
      //     "**/*.gdshader",
      //     "**/*.gdshaderinc"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**",
      //     "**/.godot/**",
      //     "**/imported/**"
      //   ],
      //   "rootMarkers": [
      //     "project.godot"
      //   ],
      //   "bin": "bash",
      //   "args": [
      //     "-lc",
      //     "port=$(python3 -c 'import socket; s=socket.socket(); s.bind((\\"127.0.0.1\\", 0)); print(s.getsockname()[1]); s.close()'); log=\\"\${TMPDIR:-/tmp}/pi-godot-lsp-\${1##*/}-\${port}.log\\"; godot --headless --editor --path \\"$1\\" --lsp-port \\"$port\\" >\\"$log\\" 2>&1 & pid=$!; cleanup(){ kill \\"$pid\\" 2>/dev/null || true; wait \\"$pid\\" 2>/dev/null || true; }; trap 'cleanup; exit 143' TERM INT HUP; trap cleanup EXIT; for i in $(seq 1 80); do nc -z 127.0.0.1 \\"$port\\" 2>/dev/null && break; if ! kill -0 \\"$pid\\" 2>/dev/null; then cat \\"$log\\" >&2; exit 1; fi; sleep 0.25; done; if ! nc -z 127.0.0.1 \\"$port\\" 2>/dev/null; then echo \\"Godot LSP did not open 127.0.0.1:$port; see $log\\" >&2; exit 1; fi; nc 127.0.0.1 \\"$port\\"; status=$?; exit $status",
      //     "pi-godot-lsp",
      //     "{root}"
      //   ],
      //   "startupTimeoutMs": 30000,
      //   "diagnosticsWaitMs": 6000,
      //   "languageIdByExtension": {
      //     ".gd": "gdscript",
      //     ".gdshader": "gdshader",
      //     ".gdshaderinc": "gdshader"
      //   }
      // }
      // ,
      // {
      //   "id": "ruby",
      //   "include": [
      //     "**/*.rb",
      //     "**/*.rake",
      //     "**/Gemfile",
      //     "**/Rakefile",
      //     "**/*.gemspec"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**",
      //     "**/vendor/bundle/**",
      //     "**/.bundle/**",
      //     "**/tmp/**",
      //     "**/log/**"
      //   ],
      //   "rootMarkers": [
      //     "Gemfile.lock",
      //     "*.gemspec",
      //     "Rakefile",
      //     ".ruby-version",
      //     ".git"
      //   ],
      //   "bin": "ruby-lsp",
      //   "args": [],
      //   "startupTimeoutMs": 60000,
      //   "diagnosticsWaitMs": 10000,
      //   "languageIdByExtension": {
      //     ".rb": "ruby",
      //     ".rake": "ruby",
      //     ".gemspec": "ruby"
      //   }
      // }
      // ,
      // {
      //   "id": "rust",
      //   "include": [
      //     "**/*.rs"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**",
      //     "**/target/**"
      //   ],
      //   "rootMarkers": [
      //     "Cargo.toml",
      //     "rust-project.json",
      //     ".git"
      //   ],
      //   "bin": "rust-analyzer",
      //   "args": [],
      //   "startupTimeoutMs": 20000,
      //   "diagnosticsWaitMs": 20000,
      //   "pullDiagnostics": false,
      //   "waitForPublishDiagnostics": true,
      //   "languageIdByExtension": {
      //     ".rs": "rust"
      //   }
      // }
      // ,
      // {
      //   "id": "markdown",
      //   "include": [
      //     "**/*.md",
      //     "**/*.markdown",
      //     "**/*.mdown",
      //     "**/*.mkd",
      //     "**/*.mmd",
      //     "**/*.mermaid"
      //   ],
      //   "exclude": [
      //     "**/.git/**",
      //     "**/node_modules/**"
      //   ],
      //   "rootMarkers": [
      //     ".git",
      //     "package.json",
      //     "README.md"
      //   ],
      //   "bin": "vscode-markdown-language-server",
      //   "args": [
      //     "--stdio"
      //   ],
      //   "startupTimeoutMs": 15000,
      //   "diagnosticsWaitMs": 5000,
      //   "languageIdByExtension": {
      //     ".md": "markdown",
      //     ".markdown": "markdown",
      //     ".mdown": "markdown",
      //     ".mkd": "markdown",
      //     ".mmd": "markdown",
      //     ".mermaid": "markdown"
      //   },
      //   "initializationOptions": {
      //     "markdownFileExtensions": [
      //       "md",
      //       "markdown",
      //       "mdown",
      //       "mkd",
      //       "mmd",
      //       "mermaid"
      //     ]
      //   },
      //   "settings": {
      //     "markdown": {
      //       "validate": {
      //         "enabled": true,
      //         "referenceLinks": {
      //           "enabled": "error"
      //         },
      //         "fragmentLinks": {
      //           "enabled": "error"
      //         },
      //         "fileLinks": {
      //           "enabled": "error",
      //           "markdownFragmentLinks": "inherit"
      //         },
      //         "unusedLinkDefinitions": {
      //           "enabled": "hint"
      //         },
      //         "duplicateLinkDefinitions": {
      //           "enabled": "warning"
      //         },
      //         "ignoredLinks": []
      //       }
      //     }
      //   }
      // }
    ]
  }
}
`;
