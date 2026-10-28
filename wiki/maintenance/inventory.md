# Documentation inventory

Every migrated document/resource has a topic, purpose (its preserved title), lifecycle evidence and destination below.
An active metadata tag is not treated as proof of implementation or completed verification.
Fixed-path documents and fixture/upstream exclusions are accounted for in the [migration map](migration-map.md).

| Document / purpose | Topic | Lifecycle / currency |
| --- | --- | --- |
| [pix-acp](../architecture/acp.md) | `architecture` | guide/reference; no new implementation certification |
| [Desktop connection lifecycle and bounded update replay](../architecture/desktop-async-lifecycle.md) | `architecture` | Active implemented contract. |
| [Desktop native process lifecycle](../architecture/desktop-native-process-lifecycle.md) | `architecture` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop global operation lock audit](../architecture/desktop-operation-lock-audit.md) | `architecture` | guide/reference; no new implementation certification |
| [Bind session extensions before prompting](../architecture/session-extension-bind-before-prompt.md) | `architecture` | Active implemented contract. |
| [Spec: Pix Desktop MVP](../archive/desktop-mvp.md) | `archive` | historical — Desktop MVP baseline, not current product contract |
| [Conversation workspace — tool removed](../archive/workspace.md) | `archive` | historical — conversation workspace tool removed (original active metadata retained) |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-adaptive-todo.png) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-adaptive-todo.svg) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-command-menu.png) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-command-menu.svg) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-overview.png) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-overview.svg) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-subagents.png) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-subagents.svg) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-tabs.png) | `assets/screenshots` | resource |
| [Documentation screenshot / editable SVG source](../assets/screenshots/pix-tabs.svg) | `assets/screenshots` | resource |
| [Multi-model brainstorm and audit council (skill)](../assistants/brainstorm.md) | `assistants` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Deepgram voice input](../assistants/deepgram-voice-input.md) | `assistants` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Evaluating Heads up](../assistants/observer/evaluation.md) | `assistants/observer` | guide/reference; no new implementation certification |
| [Heads up observer (experimental, opt-in)](../assistants/observer/heads-up-observer.md) | `assistants/observer` | experimental, opt-in; not general rollout |
| [Desktop first-run bootstrap](../configuration/desktop-first-run-bootstrap.md) | `configuration` | Active implemented contract. |
| [Desktop live model switching](../configuration/desktop-live-model-switching.md) | `configuration` | Active implemented contract. |
| [Desktop model picker popup](../configuration/desktop-model-picker-popup.md) | `configuration` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop user config editing](../configuration/desktop-user-config-editing.md) | `configuration` | Active implemented contract. |
| [Configuration and accounts](../configuration/guide.md) | `configuration` | guide/reference; no new implementation certification |
| [First-prompt model routing](../configuration/model-routing.md) | `configuration` | Active implemented contract. |
| [Model scope fallback](../configuration/model-scope-fallback.md) | `configuration` | Active implemented contract. |
| [Model selector fallback arrays](../configuration/model-selector-fallbacks.md) | `configuration` | Active implemented contract. |
| [Model-specific thinking preferences](../configuration/model-thinking-preferences.md) | `configuration` | Active implemented contract. |
| [Model visibility whitelist](../configuration/model-visibility-whitelist.md) | `configuration` | Active implemented contract. |
| [Assistant prompt composition](../context/assistant-prompt-composition.md) | `context` | metadata status: active; implementation coverage not inferred from metadata alone |
| [DCP protected continuity](../context/dcp-protected-continuity.md) | `context` | metadata status: active; implementation coverage not inferred from metadata alone |
| [DCP provider-cache stability](../context/dcp-provider-cache-stability.md) | `context` | Active implemented contract. |
| [DCP reliability mechanisms (as-is spec)](../context/dcp-reliability-mechanisms.md) | `context` | Active implemented contract. |
| [DCP statistics and lifecycle observability](../context/dcp-statistics.md) | `context` | Active implemented contract. |
| [dcp: dynamic context pruning (as-is spec)](../context/dcp.md) | `context` | Active implemented contract. |
| [Historical thinking pruning (experimental)](../context/historical-thinking-prune.md) | `context` | experimental, opt-in; not general rollout |
| [Reload context inventory](../context/reload-context-inventory.md) | `context` | Active implemented contract. |
| [Session tool](../context/session-recovery.md) | `context` | Active implemented contract. |
| [Name sessions after a leading resource command](../context/session-title-after-resource-command.md) | `context` | Active implemented contract. |
| [0001 — Separate default, core and mechanical subagent coding](../decisions/0001-subagent-coding-roles.md) | `decisions` | superseded |
| [0002 — Agent-owned decision history](../decisions/0002-agent-owned-decision-history.md) | `decisions` | accepted |
| [0003 — Reveal Desktop after the initial document loads](../decisions/0003-desktop-startup-reveal.md) | `decisions` | accepted |
| [0004 — External TUI incident profiling](../decisions/0004-external-tui-incident-profiling.md) | `decisions` | accepted |
| [0005 — Disk-saving native watch builds](../decisions/0005-watch-all-cargo-disk.md) | `decisions` | accepted |
| [0006 — Embedded opt-in TUI incident trace](../decisions/0006-embedded-tui-incident-trace.md) | `decisions` | accepted |
| [0007 — Native spelling corrections in the macOS composer](../decisions/0007-native-composer-spelling.md) | `decisions` | accepted |
| [0008 — Configured brainstorm council instead of a local skill](../decisions/0008-configured-brainstorm-council.md) | `decisions` | superseded |
| [0009 — Five-round brainstorm with reviewed synthesis](../decisions/0009-five-round-brainstorm.md) | `decisions` | accepted |
| [0010 — Audit scenario and transparent parent routing](../decisions/0010-audit-council-modes.md) | `decisions` | accepted |
| [0011 — Read-only council research capabilities](../decisions/0011-council-research-tools.md) | `decisions` | accepted |
| [0012 — Isolate suite module loading](../decisions/0012-isolate-suite-module-loading.md) | `decisions` | accepted |
| [0013 — Conservative composer action inference](../decisions/0013-composer-action-inference.md) | `decisions` | accepted |
| [0014 — Transactional conversation workspace rebinding](../decisions/0014-conversation-workspace-rebinding.md) | `decisions` | superseded |
| [0015 — Canonical disposable harness output](../decisions/0015-harness-artifact-storage.md) | `decisions` | accepted |
| [0016 — Native notification activation routing](../decisions/0016-native-notification-activation.md) | `decisions` | accepted |
| [0016 — Retain Markdown image DOM during streaming](../decisions/0016-streaming-image-dom-retention.md) | `decisions` | accepted |
| [0017 — Brainstorm v4: local protocol storage, quorum and ledger history](../decisions/0017-brainstorm-v4-protocol-storage.md) | `decisions` | accepted |
| [0018 — Identity-only Desktop message actions](../decisions/0018-desktop-message-action-identity.md) | `decisions` | accepted |
| [0019 — Desktop councils own persistent participant sessions](../decisions/0019-desktop-persistent-council-sessions.md) | `decisions` | accepted |
| [0020 — Recover interrupted questions from the transcript](../decisions/0020-question-transcript-recovery.md) | `decisions` | accepted |
| [0021 — Transparent workspace handoff](../decisions/0021-transparent-workspace-handoff.md) | `decisions` | superseded |
| [0022 — Run-only council roster and effort](../decisions/0022-brainstorm-run-roster.md) | `decisions` | accepted |
| [0023 — Remove workspace tool](../decisions/0023-remove-workspace-tool.md) | `decisions` | accepted |
| [0024 — Native Desktop close warnings](../decisions/0024-desktop-close-warning.md) | `decisions` | accepted |
| [0025 — Sparse read-only sidebar health](../decisions/0025-sidebar-health-polling.md) | `decisions` | accepted |
| [0026 — Cross-instance Project Explorer clipboard](../decisions/0026-cross-instance-file-clipboard.md) | `decisions` | accepted |
| [0026 — Pause-ready adopted continuations](../decisions/0026-pause-ready-adopted-continuations.md) | `decisions` | accepted |
| [0027 — Cause-specific sidebar quick actions](../decisions/0027-sidebar-reason-actions.md) | `decisions` | accepted |
| [0028 — Native Project Explorer context menu](../decisions/0028-native-explorer-context-menu.md) | `decisions` | accepted |
| [0028 — Scoped file-operation reservations](../decisions/0028-scoped-file-operation-reservations.md) | `decisions` | accepted |
| [0029 — Current-display-first window tiling](../decisions/0029-window-tiling.md) | `decisions` | accepted |
| [0030 — Default-on suite codemode alongside direct tools](../decisions/0030-suite-codemode.md) | `decisions` | accepted |
| [0031 — Single-channel subagent completion delivery](../decisions/0031-subagent-completion-delivery.md) | `decisions` | superseded |
| [0032 — Per-conversation Desktop reading positions](../decisions/0032-conversation-reading-position.md) | `decisions` | accepted |
| [0033 — Assistant prompt hygiene](../decisions/0033-assistant-prompt-hygiene.md) | `decisions` | accepted |
| [0034 — Bounded, opt-in Heads up observer](../decisions/0034-heads-up-observer.md) | `decisions` | accepted for an opt-in experiment, not general rollout |
| [0035 — Background queued forks](../decisions/0035-background-queued-forks.md) | `decisions` | accepted |
| [0036 — Inactive-only native hover forwarding](../decisions/0036-inactive-window-hover.md) | `decisions` | superseded |
| [0037 — Status-bar hover details](../decisions/0037-status-bar-hover-details.md) | `decisions` | superseded for popup activation/retention/dismissal; content and chrome choices remain accepted |
| [0038 — Focus on hover](../decisions/0038-focus-on-hover.md) | `decisions` | superseded |
| [0039 — Compact quota reset calendar](../decisions/0039-quota-reset-calendar.md) | `decisions` | accepted |
| [0040 — Gap-free window tiling](../decisions/0040-gap-free-window-tiling.md) | `decisions` | accepted |
| [0041 — Distinguish SDK raw fallback from DCP provider usage](../decisions/0041-dcp-sdk-fallback-provenance.md) | `decisions` | accepted |
| [0042 — Native file actions for Preview and media](../decisions/0042-preview-file-context-actions.md) | `decisions` | accepted |
| [0043 — Preserve subagent evidence on session shutdown](../decisions/0043-subagent-evidence-retention.md) | `decisions` | accepted |
| [0044 — Retractable parent completion delivery](../decisions/0044-retractable-subagent-completions.md) | `decisions` | accepted |
| [0045 — Remove hover focus](../decisions/0045-remove-hover-focus.md) | `decisions` | accepted |
| [0046 — Task-scoped knowledge audit completion](../decisions/0046-task-scoped-knowledge-completion.md) | `decisions` | superseded by [0067](../decisions/0067-final-documentation-maintenance.md) |
| [0047 — Remove the Desktop Session inspector](../decisions/0047-remove-session-inspector.md) | `decisions` | accepted |
| [0048 — Status-bar click popups](../decisions/0048-status-bar-click-popups.md) | `decisions` | accepted |
| [0049 — Nonmodal model picker](../decisions/0049-nonmodal-model-picker.md) | `decisions` | accepted |
| [0051 — Read-only Claude reset grants](../decisions/0051-claude-reset-grants.md) | `decisions` | accepted |
| [0052 — Owned LSP control in Desktop and TUI](../decisions/0052-owned-lsp-control.md) | `decisions` | superseded |
| [0053 — Repository-only commit author in Source Control](../decisions/0053-repository-commit-author.md) | `decisions` | accepted |
| [0054 — Project-shared LSP ownership](../decisions/0054-project-shared-lsp.md) | `decisions` | accepted |
| [0055 — Temporary, isolated BTW side chat](../decisions/0055-temporary-btw-side-chat.md) | `decisions` | accepted |
| [0056 — Monitoring-only LSP panels](../decisions/0056-lsp-monitoring.md) | `decisions` | accepted |
| [0057 — Canonical LSP reuse and bounded idle retention](../decisions/0057-lsp-reuse-idle-cleanup.md) | `decisions` | accepted |
| [0058 — Reverse navigation into Files](../decisions/0058-reverse-file-navigation.md) | `decisions` | accepted |
| [0059 — Private todos for every subagent role](../decisions/0059-subagent-private-todos.md) | `decisions` | accepted |
| [0060 — Read-only repository queries for every subagent](../decisions/0060-subagent-read-only-repo-tools.md) | `decisions` | accepted |
| [0061 — Scoped AST and public web tools for subagents](../decisions/0061-subagent-scoped-ast-web-tools.md) | `decisions` | accepted |
| [0062 — Accessibility-gated macOS dictation-key interception](../decisions/0062-macos-dictation-key.md) | `decisions` | accepted |
| [0063 — Kernel-owned cross-process task-file exclusion](../decisions/0063-task-file-kernel-lock.md) | `decisions` | superseded (historical; not implemented by the current task store) |
| [0064 — SQLite-only project tasks with restricted mutations](../decisions/0064-sqlite-project-tasks.md) | `decisions` | accepted |
| [0065 — Shared local repository search with a separate disposable file index](../decisions/0065-native-repository-search.md) | `decisions` | superseded |
| [0066 — Consent-gated native repository embeddings without a history-index migration](../decisions/0066-native-repository-semantic-search.md) | `decisions` | accepted |
| [0067 — Final documentation maintenance without knowledge-state gates](../decisions/0067-final-documentation-maintenance.md) | `decisions` | accepted |
| [0068 — Global semantic configuration is authorization](../decisions/0068-global-semantic-configuration.md) | `decisions` | accepted |
| [0069 — Parent-owned implementation and a smaller role pool](../decisions/0069-parent-owned-implementation.md) | `decisions` | accepted |
| [0070 — Source-isolated search indexes and bounded uncertain recovery](../decisions/0070-search-source-work-recovery.md) | `decisions` | accepted |
| [0071 — Brainstorm council as a skill on ordinary sub-agents](../decisions/0071-brainstorm-skill-on-subagents.md) | `decisions` | accepted |
| [0072 — Session-native sub-agents without run directories](../decisions/0072-session-native-subagents.md) | `decisions` | accepted |
| [Decision log](../decisions/README.md) | `decisions` | decision-log guidance/template |
| [NNNN — Decision title](../decisions/TEMPLATE.md) | `decisions` | proposed \| accepted \| superseded \| withdrawn |
| [Desktop agent pause and continuation](../desktop/conversations/desktop-agent-pause.md) | `desktop/conversations` | Active implemented contract. |
| [Desktop chat attachments](../desktop/conversations/desktop-attachments.md) | `desktop/conversations` | Implemented; this is the current Desktop attachment contract. |
| [Desktop prompt autocomplete](../desktop/conversations/desktop-autocomplete.md) | `desktop/conversations` | Active implemented contract. |
| [Temporary Desktop BTW side chat](../desktop/conversations/desktop-btw.md) | `desktop/conversations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop draft-session optimistic submit](../desktop/conversations/desktop-draft-optimistic-submit.md) | `desktop/conversations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop Question Tool](../desktop/conversations/desktop-question-tool.md) | `desktop/conversations` | Implemented; this is the current Desktop Question contract. |
| [Desktop queued send to fork](../desktop/conversations/desktop-send-to-fork.md) | `desktop/conversations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop and TUI session parity](../desktop/conversations/desktop-session-parity.md) | `desktop/conversations` | Active implemented contract. |
| [Desktop session activity HUD](../desktop/conversations/desktop-session-sidebar.md) | `desktop/conversations` | Active implemented contract. |
| [Desktop conversation-tab interaction](../desktop/conversations/desktop-session-tabs.md) | `desktop/conversations` | Active implemented contract. |
| [Desktop slash commands and fuzzy command search](../desktop/conversations/desktop-slash-commands.md) | `desktop/conversations` | Active implemented contract. |
| [Desktop user-message actions](../desktop/conversations/desktop-user-message-actions.md) | `desktop/conversations` | Active implemented contract. |
| [Pix Desktop Design Contract](../desktop/design.md) | `desktop` | guide/reference; no new implementation certification |
| [Pix Desktop](../desktop/guide.md) | `desktop` | guide/reference; no new implementation certification |
| [Desktop diff view](../desktop/integrations/desktop-diff-view.md) | `desktop/integrations` | Active implemented contract. |
| [Desktop Source Control workflows](../desktop/integrations/desktop-git-workflows.md) | `desktop/integrations` | Active implemented contract. |
| [Desktop package scripts and terminals](../desktop/integrations/desktop-package-scripts.md) | `desktop/integrations` | Active implemented contract. |
| [Desktop terminal commands (`!` / `!!`)](../desktop/integrations/desktop-terminal-commands.md) | `desktop/integrations` | Active implemented contract. |
| [Desktop activity row timing](../desktop/rendering/desktop-activity-row-timing.md) | `desktop/rendering` | Active implemented contract. |
| [Pix Desktop interactive HTML sandbox](../desktop/rendering/desktop-html-sandbox.md) | `desktop/rendering` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Lightweight desktop Markdown rendering](../desktop/rendering/desktop-markdown-rendering.md) | `desktop/rendering` | Implemented; this is the current Desktop Markdown contract. |
| [Desktop text selection scopes](../desktop/rendering/desktop-text-selection.md) | `desktop/rendering` | Active implemented contract. |
| [Desktop tool rows](../desktop/rendering/desktop-tool-rows.md) | `desktop/rendering` | Active implemented contract. |
| [Desktop transcript scrolling](../desktop/rendering/desktop-transcript-scrolling.md) | `desktop/rendering` | Active implemented contract. |
| [Desktop active-run close warning](../desktop/workbench/desktop-close-warning.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop command palette and command registry](../desktop/workbench/desktop-command-palette.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop right-click context menus](../desktop/workbench/desktop-context-menus.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop inactive-window pointer behavior](../desktop/workbench/desktop-inactive-hover.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop menu keyboard navigation](../desktop/workbench/desktop-menu-navigation.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop modal dialog lifecycle](../desktop/workbench/desktop-modal-dialogs.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop project switcher and identity color](../desktop/workbench/desktop-project-titlebar.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop project Wiki](../desktop/workbench/desktop-project-wiki.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop sidebar indicators](../desktop/workbench/desktop-sidebar-indicators.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop startup theme](../desktop/workbench/desktop-startup-theme.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop notifications (native and sound-only)](../desktop/workbench/desktop-system-notifications.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop optional menu-bar icon](../desktop/workbench/desktop-tray.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop window state persistence](../desktop/workbench/desktop-window-state.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop window tiling](../desktop/workbench/desktop-window-tiling.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop unified workbench tabs](../desktop/workbench/desktop-workbench-tabs.md) | `desktop/workbench` | Active implemented contract. |
| [Desktop workspace keyboard navigation](../desktop/workbench/desktop-workspace-navigation.md) | `desktop/workbench` | Active implemented contract. |
| [Pix Desktop](../development/desktop.md) | `development` | guide/reference; no new implementation certification |
| [Extension authors](../development/extensions.md) | `development` | guide/reference; no new implementation certification |
| [Development](../development/guide.md) | `development` | guide/reference; no new implementation certification |
| [CI and release verification](../development/release/ci-release.md) | `development/release` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Release and update verification](../development/release/guide.md) | `development/release` | guide/reference; no new implementation certification |
| [GitHub Release distribution](../development/release/release-distribution.md) | `development/release` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Isolated Desktop QA from watch builds](../development/testing/desktop-qa-isolated-launch.md) | `development/testing` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Evaluation framework](../development/testing/evals.md) | `development/testing` | guide/reference; no new implementation certification |
| [Default Pix QA project](../development/testing/qa-sandbox.md) | `development/testing` | guide/reference; no new implementation certification |
| [Session revision discovery: experimental eval](../development/testing/session-revision-evaluation.md) | `development/testing` | guide/reference; no new implementation certification |
| [Self-contained UI QA agent instructions](../development/testing/ui-qa-agent.md) | `development/testing` | Active implemented contract. |
| [UI QA sub-agent specification](../development/testing/ui-qa-subagent.md) | `development/testing` | Active implemented contract. |
| [watch:all Desktop web asset embedding](../development/watch-all-desktop-assets.md) | `development` | Active implemented contract. |
| [Installing Pix](../getting-started/installation.md) | `getting-started` | guide/reference; no new implementation certification |
| [LLM installation command](../getting-started/llm-install.md) | `getting-started` | guide/reference; no new implementation certification |
| [Troubleshooting](../getting-started/troubleshooting.md) | `getting-started` | guide/reference; no new implementation certification |
| [Desktop missing-LSP onboarding](../operations/desktop-lsp-onboarding.md) | `operations` | Active implemented contract. |
| [Harness disposable artifact storage](../operations/harness-artifact-storage.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Deferred investigation: prompt RPC acknowledgement timeout](../operations/incidents/prompt-rpc-timeout.md) | `operations/incidents` | incident observation — cause unresolved |
| [Unified diagnostic logging](../operations/logging.md) | `operations` | behavioral contract; explicit lifecycle unspecified |
| [Project-shared LSP runtime and Desktop/TUI monitoring](../operations/lsp-runtime-control.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [lsp trust & command execution (as-is spec)](../operations/lsp-trust.md) | `operations` | Active implemented contract. |
| [Session-only shell working directories](../operations/shell-workdir-session-grants.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Pix](../overview.md) | `overview` | guide/reference; no new implementation certification |
| [Council brief](../proposals/pix-code-health/brief.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |
| [Discussion](../proposals/pix-code-health/discussion.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |
| [Code Health для Pix — проект архитектурной рекомендации](../proposals/pix-code-health/draft-proposal.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |
| [Code Health для Pix — итог архитектурного брейншторма](../proposals/pix-code-health/proposal.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |
| [Disposition раунда 5](../proposals/pix-code-health/revision-notes.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |
| [antigravity-auth (as-is spec)](../providers/antigravity-auth.md) | `providers` | Active implemented contract. |
| [Local Claude Code provider](../providers/claude-code-provider.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Claude Code provider image count](../providers/claude-image-count.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Claude Code provider attachment-read recovery](../providers/claude-image-read-recovery.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Codex reasoning replay wire workaround](../providers/codex-reasoning-fix.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |
| [OpenAI Codex usage-token refresh](../providers/openai-codex-usage-refresh.md) | `providers` | Active implemented contract. |
| [Session quota wait](../providers/session-quota-wait.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Specs index](../reference/contracts.md) | `reference` | behavioral contract; explicit lifecycle unspecified |
| [Clickable wrapped markdown links](../rendering/clickable-markdown-links.md) | `rendering` | Active implemented contract. |
| [Fenced code blocks in chat Markdown](../rendering/fenced-code-block-rendering.md) | `rendering` | Active implemented contract. |
| [File link opening](../rendering/file-link-opening.md) | `rendering` | Active implemented contract. |
| [Markdown soft-wrap highlighting](../rendering/markdown-soft-wrap-highlighting.md) | `rendering` | Active implemented contract. |
| [LaTeX math in Desktop and TUI Markdown](../rendering/math-markdown-rendering.md) | `rendering` | Implemented in both Pix renderers. |
| [Mermaid diagrams in chat Markdown](../rendering/mermaid-markdown-rendering.md) | `rendering` | Active implemented contract. |
| [Desktop search index status](../search/desktop-search-index-status.md) | `search` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop universal search](../search/desktop-universal-search.md) | `search` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Native repository Code and Knowledge search](../search/native-repository-search.md) | `search` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Project-wide search for Pi agents](../search/project-search-agent-tool.md) | `search` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Indexed repository discovery and audit workflow](../search/repo-knowledge-agent-workflow.md) | `search` | Active implemented contract. |
| [async-subagents (as-is spec)](../tools/agents/async-subagents.md) | `tools/agents` | Active implemented contract. |
| [owned-launch — durable detached-descendant containment launcher (candidate)](../tools/agents/owned-launch.md) | `tools/agents` | candidate — not accepted; G1/T3 remains open |
| [Parent-first sub-agent role selection](../tools/agents/parent-first-subagent-routing.md) | `tools/agents` | Active implemented contract. |
| [Project-local sub-agents from `.pi/agents/*.md` (delta spec)](../tools/agents/project-agents-dir.md) | `tools/agents` | Active implemented contract. |
| [Sub-agent model candidates and provider policy](../tools/agents/subagent-model-pools.md) | `tools/agents` | guide/reference; no new implementation certification |
| [Headless Tool API](../tools/headless-tool-api.md) | `tools` | guide/reference; no new implementation certification |
| [Native Pi TUI presentation for pi-tools-suite](../tools/native-pi-tools-suite-ui.md) | `tools` | Active implemented contract. |
| [Fault-tolerant pi-tools-suite module loading](../tools/pi-tools-suite-module-loading.md) | `tools` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Claude provider search tool policy](../tools/provider-web-search-policy.md) | `tools` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Suite codemode](../tools/suite-codemode.md) | `tools` | metadata status: active; implementation coverage not inferred from metadata alone |
| [pi-tools-suite](../tools/suite.md) | `tools` | guide/reference; no new implementation certification |
| [Tavily fallback for web tools](../tools/web-search-tavily-fallback.md) | `tools` | Active implemented contract. |
| [Spec: Application concurrency and lifecycle safety](../tui/concurrency.md) | `tui` | Active implemented contract. |
| [Using Pix TUI](../tui/guide.md) | `tui` | guide/reference; no new implementation certification |
| [question in an inactive tab](../tui/question-inactive-tab.md) | `tui` | Active implemented contract. |
| [Retry action for exhausted automatic retries](../tui/retry-toast-action.md) | `tui` | Active implemented contract. |
| [terminal-bell](../tui/terminal-bell.md) | `tui` | guide/reference; no new implementation certification |
| [Opt-in TUI incident trace](../tui/tui-embedded-memory-trace.md) | `tui` | metadata status: active; implementation coverage not inferred from metadata alone |
| [External TUI memory/freeze profiler](../tui/tui-external-memory-profiler.md) | `tui` | metadata status: active; implementation coverage not inferred from metadata alone |
| [TUI Git assistant slash commands](../tui/tui-git-slash-commands.md) | `tui` | Active implemented contract. |
| [TUI input paste classification](../tui/tui-input-paste.md) | `tui` | metadata status: active; implementation coverage not inferred from metadata alone |
| [TUI combined model and thinking selector](../tui/tui-model-thinking-selector.md) | `tui` | Active implemented contract. |
| [TUI session tabs and UI-only draft conversations](../tui/tui-session-tabs.md) | `tui` | metadata status: active; implementation coverage not inferred from metadata alone |
| [TUI streaming-thinking memory growth](../tui/tui-streaming-thinking-memory.md) | `tui` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop quota resets](../usage/desktop-quota-calendar.md) | `usage` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Desktop runtime context and model limits](../usage/desktop-runtime-status.md) | `usage` | Active implemented contract. |
| [Desktop usage statistics panel](../usage/desktop-usage-stats.md) | `usage` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Session usage and billing accounting](../usage/session-usage.md) | `usage` | Active implemented contract. |
| [Desktop Work plans navigation](../work-management/registry/desktop-registry-plans.md) | `work-management/registry` | behavioral contract; explicit lifecycle unspecified |
| [Desktop Registry resource diff](../work-management/registry/desktop-registry-resource-diff.md) | `work-management/registry` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Registry agent companion directories](../work-management/registry/resource-registry-agent-companions.md) | `work-management/registry` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Resource Registry: project state](../work-management/registry/resource-registry-project-state.md) | `work-management/registry` | Implemented; this is the current project-state registry contract. |
| [Registry publication scope and tags](../work-management/registry/resource-registry-publication-tags.md) | `work-management/registry` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Pix Desktop project Tasks — SQLite-only](../work-management/tasks/desktop.md) | `work-management/tasks` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Saved project tasks: SQLite agent API and slash commands](../work-management/tasks/project-tasks-agent-tool.md) | `work-management/tasks` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Persist todo clear in session replay](../work-management/todos/todo-clear-session-replay.md) | `work-management/todos` | Active implemented contract. |
| [Todo initial status and blocked-work handoff](../work-management/todos/todo-initial-status.md) | `work-management/todos` | metadata status: active; implementation coverage not inferred from metadata alone |
| [Todo completion without knowledge-state reminders](../work-management/todos/todo-repo-knowledge-finalization.md) | `work-management/todos` | Active implemented contract. |
| [Todo thinking model overrides](../work-management/todos/todo-thinking-model-overrides.md) | `work-management/todos` | Active implemented contract. |
