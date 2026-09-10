# Specs index

<!-- markdownlint-disable MD013 MD036 MD060 -->

> Scope: **current behavior only** for the as-is specs; change-oriented specs
> label themselves. These are **not** design docs. Every important claim is
> tagged with its source: `[confirmed by code]`, `[confirmed by tests]`,
> `[confirmed by docs]`, `[inferred]`, or `[unknown]`. Re-verify against
> current code before relying on any claim. Last broad drift audit:
> 2026-09-10. That pass refreshed the Desktop activity/Markdown/sidebar contracts,
> added the Desktop IDX contract, indexed recent text-selection/user-config and
> reload-context work, and re-verified changed knowledge inputs against current
> implementation/tests.

## Project context

`pix` (package `pi-ui-extend`) is an SDK-first custom terminal renderer for the
pi coding agent, the Tauri/Svelte desktop app (`desktop/`, `acp/`), plus the
`external/pi-tools-suite` headless extension suite that ships alongside it.
The renderer (`src/`) owns UI, input, scroll, and tool state; the suite
(`external/pi-tools-suite/`) owns the higher-risk runtime behavior (auth,
privacy, background jobs, context mutation, external commands). `[confirmed by docs: CLAUDE.md]`

## High-risk as-is areas (original screening)

Candidate areas were screened against the high-risk criteria (auth/security/
privacy, permissions, data/schema/migrations, public APIs, external integrations,
payments, background jobs, concurrency, irreversible actions, cross-cutting
architecture). The 4 retained are where the most risk and the most user-visible
behavior live, and all happen to live in `external/pi-tools-suite`.

| Area | Primary risk class | Spec |
|------|--------------------|------|
| `antigravity-auth` | auth/security — OAuth, refresh-token rotation, secret file writes | [antigravity-auth.md](./antigravity-auth.md) |
| `async-subagents` | background jobs + concurrency — spawns child pi processes, registry, retry/failover | [async-subagents.md](./async-subagents.md) |
| `dcp` (dynamic context pruning) | data + cross-cutting — rewrites conversation context, persists state, irreversible pruning | [dcp.md](./dcp.md) |
| `lsp` trust & command execution | security — executes configured LSP server commands gated by a trust hash | [lsp-trust.md](./lsp-trust.md) |

## Canonical `specs/` inventory

Feature/contract specs stored in this directory, grouped by area. Filenames
carry no numbers; ordering is by group. Additional behavioral documents may
live beside the subsystem they describe (for example `docs/` or
`external/pi-tools-suite/docs/`). This hand-maintained index intentionally does
not duplicate those; Spec Wiki discovers and classifies them independently.

**Suite / auth / tools**

| Spec | Topic |
|------|-------|
| [openai-codex-usage-refresh](./openai-codex-usage-refresh.md) | OpenAI Codex usage-token refresh (host-side quota indicator) |
| [web-search-tavily-fallback](./web-search-tavily-fallback.md) | Web search/extract via Ollama with Tavily fallback |
| [todo-thinking-model-overrides](./todo-thinking-model-overrides.md) | Per-model todo thinking overrides |
| [todo-clear-session-replay](./todo-clear-session-replay.md) | Persist todo clear in session replay |
| [project-agents-dir](./project-agents-dir.md) | Project-local sub-agent roles from `.pi/agents/*.md` |
| [parent-first-subagent-routing](./parent-first-subagent-routing.md) | Parent-first sub-agent role selection |
| [browser-qa-inline-agent](./browser-qa-inline-agent.md) | Self-contained browser QA agent |
| [model-selector-fallbacks](./model-selector-fallbacks.md) | Ordered fallback arrays for singular model selectors |

**TUI renderer (`src/`)**

| Spec | Topic |
|------|-------|
| [retry-toast-action](./retry-toast-action.md) | Retry action on the exhausted-retries toast |
| [session-extension-bind-before-prompt](./session-extension-bind-before-prompt.md) | Bind session extensions before the first prompt |
| [session-title-after-resource-command](./session-title-after-resource-command.md) | Session title after a leading resource command |
| [idx-startup-update](./idx-startup-update.md) | Keep `idx` current at pix startup |
| [reload-context-inventory](./reload-context-inventory.md) | Reload/resource context inventory and tool-alias capability checks |
| [clickable-markdown-links](./clickable-markdown-links.md) | Clickable wrapped markdown links |
| [markdown-soft-wrap-highlighting](./markdown-soft-wrap-highlighting.md) | Syntax highlighting across soft wraps |
| [mermaid-markdown-rendering](./mermaid-markdown-rendering.md) | Mermaid diagrams in chat Markdown |
| [question-inactive-tab](./question-inactive-tab.md) | question tool UI in an inactive tab |
| [fenced-code-block-rendering](./fenced-code-block-rendering.md) | Fenced code blocks in chat Markdown |
| [model-scope-fallback](./model-scope-fallback.md) | Model scope fallback to the available snapshot |
| [file-link-opening](./file-link-opening.md) | File link opening (Zed / web / media routing) |
| [tui-git-slash-commands](./tui-git-slash-commands.md) | TUI Git code-review and confirmed commit-message commands |

**Desktop (`desktop/`, `acp/`)**

| Spec | Topic |
|------|-------|
| [desktop-session-parity](./desktop-session-parity.md) | Desktop and TUI session parity |
| [desktop-project-titlebar](./desktop-project-titlebar.md) | Desktop project selector in the macOS overlay title bar |
| [desktop-activity-row-timing](./desktop-activity-row-timing.md) | Desktop activity names and completed durations |
| [desktop-markdown-rendering](./desktop-markdown-rendering.md) | Lightweight desktop Markdown rendering |
| [desktop-attachments](./desktop-attachments.md) | Desktop chat attachments |
| [desktop-diff-view](./desktop-diff-view.md) | Desktop diff view |
| [desktop-window-state](./desktop-window-state.md) | Desktop window state persistence |
| [desktop-tool-rows](./desktop-tool-rows.md) | Desktop tool result rows |
| [desktop-autocomplete](./desktop-autocomplete.md) | Desktop prompt autocomplete |
| [desktop-session-sidebar](./desktop-session-sidebar.md) | Desktop session sidebar |
| [desktop-slash-commands](./desktop-slash-commands.md) | Desktop slash commands and fuzzy search |
| [desktop-user-message-actions](./desktop-user-message-actions.md) | Desktop user-message Copy, Fork, Fork in new tab, and conflict-safe Undo changes |
| [desktop-question-tool](./desktop-question-tool.md) | Desktop Question tool |
| [desktop-text-selection](./desktop-text-selection.md) | Desktop text-selection scopes |
| [desktop-user-config-editing](./desktop-user-config-editing.md) | Desktop JSONC user-config editing |
| [desktop-idx-panel](./desktop-idx-panel.md) | Desktop IDX repository intelligence and Spec Wiki maintenance |
| [desktop-sidebar-indicators](./desktop-sidebar-indicators.md) | Live semantic Activity Bar health and attention indicators |

**DCP family**

| Spec | Topic |
|------|-------|
| [dcp-provider-cache-stability](./dcp-provider-cache-stability.md) | DCP provider-cache stability (as-is, journal era) |
| [dcp-reliability-mechanisms](./dcp-reliability-mechanisms.md) | DCP reliability mechanisms — transactions, epochs, budgets, bounded reads (as-is; consolidates the former roadmap/evidence/review docs) |

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
- **dcp ↔ session-recovery coupling.** `session-recovery` knows the
  `dcp-journal` / `dcp-nudge` custom entry types. `[confirmed by code]`
- **No production code was changed** to produce or refresh these specs. The
  original screening used read-only sub-agents plus direct file reading.

## Caveats / known unknowns

- These specs describe behavior, not guarantees. Several tagged `[unknown]`
  items (e.g. whether `$PI_CONFIG_DIR` is attacker-controllable in the host)
  depend on the pi host environment, not this repo.
- "Confirmed by tests" means a test exists; it does **not** mean the behavior is
  fully covered for all edge cases (see each spec's *Gaps / risks*).
- The former DCP roadmap/evidence/review-remediation docs (implementation
  plans, partially Russian) were consolidated into the English as-is spec
  [dcp-reliability-mechanisms.md](./dcp-reliability-mechanisms.md); originals
  are preserved in git history. Plan 32
  (`plans/32-dcp-session-journal-simplification-plan.md`) was implemented and
  the `plans/` directory has since been removed. Current DCP behavior lives in
  [dcp.md](./dcp.md) and
  [dcp-provider-cache-stability.md](./dcp-provider-cache-stability.md).
- The former `desktop/MARKDOWN.md` and
  `docs/desktop-markdown-media.md` contracts were consolidated into
  [desktop-markdown-rendering.md](./desktop-markdown-rendering.md). The former
  DCP emergency-current-turn change document was consolidated into
  [dcp.md](./dcp.md). Originals remain available in git history.
