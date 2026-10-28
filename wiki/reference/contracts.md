# Contract catalogue

<!-- markdownlint-disable MD013 MD036 MD060 -->

> Scope: **current behavior only** for the as-is specs; change-oriented specs
> label themselves. These are **not** design docs. Every important claim is
> tagged with its source: `[confirmed by code]`, `[confirmed by tests]`,
> `[confirmed by docs]`, `[inferred]`, or `[unknown]`. Re-verify against
> current code before relying on any claim. Last broad drift audit:
> 2026-09-19. That pass reviewed and classified all discovered knowledge
> candidates, semantically re-verified every primary knowledge entry against its
> current implementation/tests, and reconciled this inventory with the then-current
> `specs/` directory. Root, Desktop, ACP, focused pi-tools-suite contract suites,
> the Desktop production web build, and the native Tauri/Rust tests were green.

## Project context

`pix` (package `pi-ui-extend`) is an SDK-first custom terminal renderer for the
pi coding agent, the Tauri/Svelte desktop app (`desktop/`, `acp/`), plus the
`external/pi-tools-suite` headless extension suite that ships alongside it.
The renderer (`src/`) owns UI, input, scroll, and tool state; the suite
(`external/pi-tools-suite/`) owns the higher-risk runtime behavior (auth,
privacy, background jobs, context mutation, external commands). `[confirmed by docs: README.md]`

## High-risk as-is areas (original screening)

Candidate areas were screened against the high-risk criteria (auth/security/
privacy, permissions, data/schema/migrations, public APIs, external integrations,
payments, background jobs, concurrency, irreversible actions, cross-cutting
architecture). The 4 retained are where the most risk and the most user-visible
behavior live, and all happen to live in `external/pi-tools-suite`.

| Area | Primary risk class | Spec |
|------|--------------------|------|
| `antigravity-auth` | auth/security — OAuth, refresh-token rotation, secret file writes | [antigravity-auth.md](../providers/antigravity-auth.md) |
| `async-subagents` | background jobs + concurrency — spawns child pi processes, registry, retry/failover | [async-subagents.md](../tools/agents/async-subagents.md) |
| `dcp` (dynamic context pruning) | data + cross-cutting — rewrites conversation context, persists state, irreversible pruning | [dcp.md](../context/dcp.md) |
| `lsp` trust & command execution | security — executes configured LSP server commands gated by a trust hash | [lsp-trust.md](../operations/lsp-trust.md) |

## Contract inventory

Feature and contract documents are grouped by subject in the Wiki. This
hand-maintained catalogue intentionally does not duplicate every guide or
implementation reference; native project search indexes Code and Knowledge.

**Suite / auth / tools**

| Spec | Topic |
|------|-------|
| [openai-codex-usage-refresh](../providers/openai-codex-usage-refresh.md) | OpenAI Codex usage-token refresh (host-side quota indicator) |
| [web-search-tavily-fallback](../tools/web-search-tavily-fallback.md) | Web search/extract via Ollama with Tavily fallback |
| [todo-thinking-model-overrides](../work-management/todos/todo-thinking-model-overrides.md) | Per-model todo thinking overrides |
| [todo-clear-session-replay](../work-management/todos/todo-clear-session-replay.md) | Persist todo clear in session replay |
| [project-agents-dir](../tools/agents/project-agents-dir.md) | Project-local sub-agent roles from `.pi/agents/*.md` |
| [parent-first-subagent-routing](../tools/agents/parent-first-subagent-routing.md) | Parent-first sub-agent role selection |
| [ui-qa-agent](../development/testing/ui-qa-agent.md) | Self-contained browser/TUI/desktop UI QA agent |
| [model-selector-fallbacks](../configuration/model-selector-fallbacks.md) | Ordered fallback arrays for singular model selectors |
| [repo-knowledge-agent-workflow](../search/repo-knowledge-agent-workflow.md) | Agent workflow for indexed retrieval and task-scoped documentation audits |
| [project-search-agent-tool](../search/project-search-agent-tool.md) | Read-only cross-source project history search in Desktop/TUI agent tools |
| [todo-repo-knowledge-finalization](../work-management/todos/todo-repo-knowledge-finalization.md) | Todo repo knowledge finalization reminder |

**TUI renderer (`src/`)**

| Spec | Topic |
|------|-------|
| [retry-toast-action](../tui/retry-toast-action.md) | Retry action on the exhausted-retries toast |
| [session-extension-bind-before-prompt](../architecture/session-extension-bind-before-prompt.md) | Bind session extensions before the first prompt |
| [session-title-after-resource-command](../context/session-title-after-resource-command.md) | Session title after a leading resource command |
| [session-quota-wait](../providers/session-quota-wait.md) | Session quota wait with automatic/manual scheduled continuation |
| [heads-up-observer](../assistants/observer/heads-up-observer.md) | Experimental opt-in TUI/Desktop observer: bounded tool-less checks, evidence, feedback and session-attributed usage |
| [desktop-btw](../desktop/conversations/desktop-btw.md) | Temporary tool-less side chat: composer menu, current parent context, independent cancellation and no transcript persistence |
| [reload-context-inventory](../context/reload-context-inventory.md) | Reload/resource context inventory and tool-alias capability checks |
| [clickable-markdown-links](../rendering/clickable-markdown-links.md) | Clickable wrapped markdown links |
| [markdown-soft-wrap-highlighting](../rendering/markdown-soft-wrap-highlighting.md) | Syntax highlighting across soft wraps |
| [mermaid-markdown-rendering](../rendering/mermaid-markdown-rendering.md) | Mermaid diagrams in chat Markdown |
| [math-markdown-rendering](../rendering/math-markdown-rendering.md) | LaTeX formulas in Desktop and terminal Markdown |
| [question-inactive-tab](../tui/question-inactive-tab.md) | question tool UI in an inactive tab |
| [fenced-code-block-rendering](../rendering/fenced-code-block-rendering.md) | Fenced code blocks in chat Markdown |
| [model-scope-fallback](../configuration/model-scope-fallback.md) | Model scope fallback to the available snapshot |
| [model-visibility-whitelist](../configuration/model-visibility-whitelist.md) | Model picker visibility whitelist |
| [model-thinking-preferences](../configuration/model-thinking-preferences.md) | Per-model remembered thinking preferences with independent TUI/Desktop storage |
| [tui-model-thinking-selector](../tui/tui-model-thinking-selector.md) | Combined model and thinking selector |
| [tui-session-tabs](../tui/tui-session-tabs.md) | TUI session tabs and lazy UI-only draft conversations |
| [file-link-opening](../rendering/file-link-opening.md) | File link opening (Zed / web / media routing) |
| [tui-git-slash-commands](../tui/tui-git-slash-commands.md) | TUI Git code-review and confirmed commit-message commands |
| [deepgram-voice-input](../assistants/deepgram-voice-input.md) | Deepgram voice dictation (terminal and Desktop) |

**Desktop (`desktop/`, `acp/`)**

| Spec | Topic |
|------|-------|
| [desktop-session-parity](../desktop/conversations/desktop-session-parity.md) | Desktop and TUI session parity |
| [desktop-session-tabs](../desktop/conversations/desktop-session-tabs.md) | Desktop conversation tab interaction and lazy draft conversations |
| [desktop-project-titlebar](../desktop/workbench/desktop-project-titlebar.md) | Sidebar project switcher and project identity color |
| [desktop-workspace-navigation](../desktop/workbench/desktop-workspace-navigation.md) | Workspace Activity Bar and Project Explorer keyboard navigation |
| [desktop-project-wiki](../desktop/workbench/desktop-project-wiki.md) | Configurable project Wiki tree and Markdown WYSIWYG authoring |
| [desktop-command-palette](../desktop/workbench/desktop-command-palette.md) | Shared Desktop command registry and Command Palette |
| [desktop-menu-navigation](../desktop/workbench/desktop-menu-navigation.md) | Shared keyboard navigation for transient Desktop command menus |
| [desktop-modal-dialogs](../desktop/workbench/desktop-modal-dialogs.md) | Native modal dialog lifecycle, focus containment, and restoration |
| [desktop-workbench-tabs](../desktop/workbench/desktop-workbench-tabs.md) | Unified top workbench tabs for conversations, Preview, and Git Diff |
| [desktop-activity-row-timing](../desktop/rendering/desktop-activity-row-timing.md) | Desktop activity names and completed durations |
| [desktop-markdown-rendering](../desktop/rendering/desktop-markdown-rendering.md) | Lightweight desktop Markdown rendering |
| [desktop-attachments](../desktop/conversations/desktop-attachments.md) | Desktop chat attachments |
| [desktop-diff-view](../desktop/integrations/desktop-diff-view.md) | Desktop diff view |
| [desktop-window-state](../desktop/workbench/desktop-window-state.md) | Desktop window state persistence |
| [desktop-system-notifications](../desktop/workbench/desktop-system-notifications.md) | Background native completion, question, and agent-error notifications |
| [desktop-tool-rows](../desktop/rendering/desktop-tool-rows.md) | Desktop tool result rows |
| [desktop-autocomplete](../desktop/conversations/desktop-autocomplete.md) | Desktop prompt autocomplete |
| [desktop-agent-pause](../desktop/conversations/desktop-agent-pause.md) | Desktop turn-boundary pause and continuation |
| [desktop-lsp-onboarding](../operations/desktop-lsp-onboarding.md) | Desktop missing-LSP warning, safe pause, and trusted automatic installation |
| [desktop-live-model-switching](../configuration/desktop-live-model-switching.md) | Live Desktop model/thinking switching while an agent run is active |
| [desktop-runtime-status](../usage/desktop-runtime-status.md) | Desktop context usage, DCP statistics, and model quota status |
| [desktop-session-sidebar](../desktop/conversations/desktop-session-sidebar.md) | Session activity tab indicators, status entry point, and contextual inspector |
| [desktop-slash-commands](../desktop/conversations/desktop-slash-commands.md) | Desktop slash commands and fuzzy search |
| [desktop-user-message-actions](../desktop/conversations/desktop-user-message-actions.md) | Desktop user-message Copy, Fork, Fork in new tab, and conflict-safe Undo changes |
| [desktop-question-tool](../desktop/conversations/desktop-question-tool.md) | Desktop Question tool |
| [desktop-text-selection](../desktop/rendering/desktop-text-selection.md) | Desktop text-selection scopes |
| [desktop-user-config-editing](../configuration/desktop-user-config-editing.md) | Desktop JSONC user-config editing |
| [desktop-search-index-status](../search/desktop-search-index-status.md) | Desktop per-source local and semantic search-index status |
| [desktop-sidebar-indicators](../desktop/workbench/desktop-sidebar-indicators.md) | Live semantic Activity Bar health and attention indicators |
| [watch-all-desktop-assets](../development/watch-all-desktop-assets.md) | `watch:all` Desktop web-asset embedding and native rebuild invalidation |

**DCP family**

| Spec | Topic |
|------|-------|
| [dcp-provider-cache-stability](../context/dcp-provider-cache-stability.md) | DCP provider-cache stability (as-is, journal era) |
| [dcp-reliability-mechanisms](../context/dcp-reliability-mechanisms.md) | DCP reliability mechanisms — transactions, epochs, budgets, bounded reads (as-is; consolidates the former roadmap/evidence/review docs) |

## Cross-cutting observations

- **Shared secret store.** Antigravity OAuth tokens, opencode-imported accounts,
  and the LSP trust store all live under `~/.pi/agent/` (`auth.json`,
  `trust/<kind>.json`, kind `lsp` since the trust API is `ConfigKind`-generic).
  Antigravity writes `auth.json` with mode `0o600`; the LSP trust store still
  sets no explicit mode. `[confirmed by code]`
- **async-subagents → dcp artifact flow.** `async-subagents` writes `result.md`
  artifacts that `dcp` reads during compression through a bounded async reader
  (`readBoundedProtectedSubagentArtifact`): awaited fs ops, `realpath`
  confinement to the session cwd, and a 50 KB budget enforced before/during
  the read (`compression-blocks.ts`). Deleting a run dir before a rollup still
  loses that content from the summary. `[confirmed by code]`
- **dcp ↔ antigravity-auth coupling.** `antigravity-auth/constants.ts` exports
  `STATUS_KEY = "dcp:antigravity"`, a status channel keyed by DCP. `[confirmed by code]`
- **dcp ↔ session coupling.** The `session` history handlers know the
  `dcp-journal` / `dcp-nudge` custom entry types. `[confirmed by code]`
- **No production code was changed** to produce or refresh these specs. The
  original screening used read-only sub-agents plus direct file reading.

## Caveats / known unknowns

For migration-era guide drift about search configuration and Desktop platform
scope, see [known conflicts](../maintenance/known-conflicts.md).

- These specs describe behavior, not guarantees. Several tagged `[unknown]`
  items (e.g. whether `$PI_CONFIG_DIR` is attacker-controllable in the host)
  depend on the pi host environment, not this repo.
- "Confirmed by tests" means a test exists; it does **not** mean the behavior is
  fully covered for all edge cases (see each spec's *Gaps / risks*).
- The former DCP roadmap/evidence/review-remediation docs (implementation
  plans, partially Russian) were consolidated into the English as-is spec
  [dcp-reliability-mechanisms.md](../context/dcp-reliability-mechanisms.md); originals
  are preserved in git history. Plan 32
  (`plans/32-dcp-session-journal-simplification-plan.md`) was implemented and
  the `plans/` directory has since been removed. Current DCP behavior lives in
  [dcp.md](../context/dcp.md) and
  [dcp-provider-cache-stability.md](../context/dcp-provider-cache-stability.md).
- The former `desktop/MARKDOWN.md` and
  `docs/desktop-markdown-media.md` contracts were consolidated into
  [desktop-markdown-rendering.md](../desktop/rendering/desktop-markdown-rendering.md). The former
  DCP emergency-current-turn change document was consolidated into
  [dcp-reliability-mechanisms.md](../context/dcp-reliability-mechanisms.md).
  [dcp.md](../context/dcp.md). Originals remain available in git history.
