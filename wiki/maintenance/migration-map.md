# Documentation migration map

All full moved texts are in Wiki. Paths in the first column are historical identifiers,
not links to live locations. SHA-256 provenance is available in the
[machine-readable map](migration-map.json). No source documents were merged or
deduplicated: coverage is preserved file-for-file; only navigation and path references
were reorganized. Git can detect these content-preserving moves when changes are committed;
the migration does not stage or commit the pre-existing working tree.

## Moved documents and resources

| Original path | Wiki location | Disposition |
| --- | --- | --- |
| `external/pi-tools-suite/src/async-subagents/core/owned-launch/README.md` | [wiki/tools/agents/owned-launch.md](../tools/agents/owned-launch.md) | candidate architecture; local entry point retained |
| `DESIGN.md` | [wiki/desktop/design.md](../desktop/design.md) | moved |
| `README.md` | [wiki/overview.md](../overview.md) | full text moved; concise entry point retained |
| `acp/README.md` | [wiki/architecture/acp.md](../architecture/acp.md) | full text moved; concise entry point retained |
| `assets/screenshots/pix-adaptive-todo.png` | [wiki/assets/screenshots/pix-adaptive-todo.png](../assets/screenshots/pix-adaptive-todo.png) | moved |
| `assets/screenshots/pix-adaptive-todo.svg` | [wiki/assets/screenshots/pix-adaptive-todo.svg](../assets/screenshots/pix-adaptive-todo.svg) | moved |
| `assets/screenshots/pix-command-menu.png` | [wiki/assets/screenshots/pix-command-menu.png](../assets/screenshots/pix-command-menu.png) | moved |
| `assets/screenshots/pix-command-menu.svg` | [wiki/assets/screenshots/pix-command-menu.svg](../assets/screenshots/pix-command-menu.svg) | moved |
| `assets/screenshots/pix-overview.png` | [wiki/assets/screenshots/pix-overview.png](../assets/screenshots/pix-overview.png) | moved |
| `assets/screenshots/pix-overview.svg` | [wiki/assets/screenshots/pix-overview.svg](../assets/screenshots/pix-overview.svg) | moved |
| `assets/screenshots/pix-subagents.png` | [wiki/assets/screenshots/pix-subagents.png](../assets/screenshots/pix-subagents.png) | moved |
| `assets/screenshots/pix-subagents.svg` | [wiki/assets/screenshots/pix-subagents.svg](../assets/screenshots/pix-subagents.svg) | moved |
| `assets/screenshots/pix-tabs.png` | [wiki/assets/screenshots/pix-tabs.png](../assets/screenshots/pix-tabs.png) | moved |
| `assets/screenshots/pix-tabs.svg` | [wiki/assets/screenshots/pix-tabs.svg](../assets/screenshots/pix-tabs.svg) | moved |
| `desktop/README.md` | [wiki/development/desktop.md](../development/desktop.md) | full text moved; concise entry point retained |
| `docs/brainstorms/pix-code-health/brief.md` | [wiki/proposals/pix-code-health/brief.md](../proposals/pix-code-health/brief.md) | moved |
| `docs/brainstorms/pix-code-health/discussion.md` | [wiki/proposals/pix-code-health/discussion.md](../proposals/pix-code-health/discussion.md) | moved |
| `docs/brainstorms/pix-code-health/draft-proposal.md` | [wiki/proposals/pix-code-health/draft-proposal.md](../proposals/pix-code-health/draft-proposal.md) | moved |
| `docs/brainstorms/pix-code-health/proposal.md` | [wiki/proposals/pix-code-health/proposal.md](../proposals/pix-code-health/proposal.md) | moved |
| `docs/brainstorms/pix-code-health/revision-notes.md` | [wiki/proposals/pix-code-health/revision-notes.md](../proposals/pix-code-health/revision-notes.md) | moved |
| `docs/concurrency.md` | [wiki/tui/concurrency.md](../tui/concurrency.md) | moved |
| `docs/configuration.md` | [wiki/configuration/guide.md](../configuration/guide.md) | moved |
| `docs/decisions/0001-subagent-coding-roles.md` | [wiki/decisions/0001-subagent-coding-roles.md](../decisions/0001-subagent-coding-roles.md) | moved |
| `docs/decisions/0002-agent-owned-decision-history.md` | [wiki/decisions/0002-agent-owned-decision-history.md](../decisions/0002-agent-owned-decision-history.md) | moved |
| `docs/decisions/0003-desktop-startup-reveal.md` | [wiki/decisions/0003-desktop-startup-reveal.md](../decisions/0003-desktop-startup-reveal.md) | moved |
| `docs/decisions/0004-external-tui-incident-profiling.md` | [wiki/decisions/0004-external-tui-incident-profiling.md](../decisions/0004-external-tui-incident-profiling.md) | moved |
| `docs/decisions/0005-watch-all-cargo-disk.md` | [wiki/decisions/0005-watch-all-cargo-disk.md](../decisions/0005-watch-all-cargo-disk.md) | moved |
| `docs/decisions/0006-embedded-tui-incident-trace.md` | [wiki/decisions/0006-embedded-tui-incident-trace.md](../decisions/0006-embedded-tui-incident-trace.md) | moved |
| `docs/decisions/0007-native-composer-spelling.md` | [wiki/decisions/0007-native-composer-spelling.md](../decisions/0007-native-composer-spelling.md) | moved |
| `docs/decisions/0008-configured-brainstorm-council.md` | [wiki/decisions/0008-configured-brainstorm-council.md](../decisions/0008-configured-brainstorm-council.md) | moved |
| `docs/decisions/0009-five-round-brainstorm.md` | [wiki/decisions/0009-five-round-brainstorm.md](../decisions/0009-five-round-brainstorm.md) | moved |
| `docs/decisions/0010-audit-council-modes.md` | [wiki/decisions/0010-audit-council-modes.md](../decisions/0010-audit-council-modes.md) | moved |
| `docs/decisions/0011-council-research-tools.md` | [wiki/decisions/0011-council-research-tools.md](../decisions/0011-council-research-tools.md) | moved |
| `docs/decisions/0012-isolate-suite-module-loading.md` | [wiki/decisions/0012-isolate-suite-module-loading.md](../decisions/0012-isolate-suite-module-loading.md) | moved |
| `docs/decisions/0013-composer-action-inference.md` | [wiki/decisions/0013-composer-action-inference.md](../decisions/0013-composer-action-inference.md) | moved |
| `docs/decisions/0014-conversation-workspace-rebinding.md` | [wiki/decisions/0014-conversation-workspace-rebinding.md](../decisions/0014-conversation-workspace-rebinding.md) | moved |
| `docs/decisions/0015-harness-artifact-storage.md` | [wiki/decisions/0015-harness-artifact-storage.md](../decisions/0015-harness-artifact-storage.md) | moved |
| `docs/decisions/0016-native-notification-activation.md` | [wiki/decisions/0016-native-notification-activation.md](../decisions/0016-native-notification-activation.md) | moved |
| `docs/decisions/0016-streaming-image-dom-retention.md` | [wiki/decisions/0016-streaming-image-dom-retention.md](../decisions/0016-streaming-image-dom-retention.md) | moved |
| `docs/decisions/0017-brainstorm-v4-protocol-storage.md` | [wiki/decisions/0017-brainstorm-v4-protocol-storage.md](../decisions/0017-brainstorm-v4-protocol-storage.md) | moved |
| `docs/decisions/0018-desktop-message-action-identity.md` | [wiki/decisions/0018-desktop-message-action-identity.md](../decisions/0018-desktop-message-action-identity.md) | moved |
| `docs/decisions/0019-desktop-persistent-council-sessions.md` | [wiki/decisions/0019-desktop-persistent-council-sessions.md](../decisions/0019-desktop-persistent-council-sessions.md) | moved |
| `docs/decisions/0020-question-transcript-recovery.md` | [wiki/decisions/0020-question-transcript-recovery.md](../decisions/0020-question-transcript-recovery.md) | moved |
| `docs/decisions/0021-transparent-workspace-handoff.md` | [wiki/decisions/0021-transparent-workspace-handoff.md](../decisions/0021-transparent-workspace-handoff.md) | moved |
| `docs/decisions/0022-brainstorm-run-roster.md` | [wiki/decisions/0022-brainstorm-run-roster.md](../decisions/0022-brainstorm-run-roster.md) | moved |
| `docs/decisions/0023-remove-workspace-tool.md` | [wiki/decisions/0023-remove-workspace-tool.md](../decisions/0023-remove-workspace-tool.md) | moved |
| `docs/decisions/0024-desktop-close-warning.md` | [wiki/decisions/0024-desktop-close-warning.md](../decisions/0024-desktop-close-warning.md) | moved |
| `docs/decisions/0025-sidebar-health-polling.md` | [wiki/decisions/0025-sidebar-health-polling.md](../decisions/0025-sidebar-health-polling.md) | moved |
| `docs/decisions/0026-cross-instance-file-clipboard.md` | [wiki/decisions/0026-cross-instance-file-clipboard.md](../decisions/0026-cross-instance-file-clipboard.md) | moved |
| `docs/decisions/0026-pause-ready-adopted-continuations.md` | [wiki/decisions/0026-pause-ready-adopted-continuations.md](../decisions/0026-pause-ready-adopted-continuations.md) | moved |
| `docs/decisions/0027-sidebar-reason-actions.md` | [wiki/decisions/0027-sidebar-reason-actions.md](../decisions/0027-sidebar-reason-actions.md) | moved |
| `docs/decisions/0028-native-explorer-context-menu.md` | [wiki/decisions/0028-native-explorer-context-menu.md](../decisions/0028-native-explorer-context-menu.md) | moved |
| `docs/decisions/0028-scoped-file-operation-reservations.md` | [wiki/decisions/0028-scoped-file-operation-reservations.md](../decisions/0028-scoped-file-operation-reservations.md) | moved |
| `docs/decisions/0029-window-tiling.md` | [wiki/decisions/0029-window-tiling.md](../decisions/0029-window-tiling.md) | moved |
| `docs/decisions/0030-suite-codemode.md` | [wiki/decisions/0030-suite-codemode.md](../decisions/0030-suite-codemode.md) | moved |
| `docs/decisions/0031-subagent-completion-delivery.md` | [wiki/decisions/0031-subagent-completion-delivery.md](../decisions/0031-subagent-completion-delivery.md) | moved |
| `docs/decisions/0032-conversation-reading-position.md` | [wiki/decisions/0032-conversation-reading-position.md](../decisions/0032-conversation-reading-position.md) | moved |
| `docs/decisions/0033-assistant-prompt-hygiene.md` | [wiki/decisions/0033-assistant-prompt-hygiene.md](../decisions/0033-assistant-prompt-hygiene.md) | moved |
| `docs/decisions/0034-heads-up-observer.md` | [wiki/decisions/0034-heads-up-observer.md](../decisions/0034-heads-up-observer.md) | moved |
| `docs/decisions/0035-background-queued-forks.md` | [wiki/decisions/0035-background-queued-forks.md](../decisions/0035-background-queued-forks.md) | moved |
| `docs/decisions/0036-inactive-window-hover.md` | [wiki/decisions/0036-inactive-window-hover.md](../decisions/0036-inactive-window-hover.md) | moved |
| `docs/decisions/0037-status-bar-hover-details.md` | [wiki/decisions/0037-status-bar-hover-details.md](../decisions/0037-status-bar-hover-details.md) | moved |
| `docs/decisions/0038-focus-on-hover.md` | [wiki/decisions/0038-focus-on-hover.md](../decisions/0038-focus-on-hover.md) | moved |
| `docs/decisions/0039-quota-reset-calendar.md` | [wiki/decisions/0039-quota-reset-calendar.md](../decisions/0039-quota-reset-calendar.md) | moved |
| `docs/decisions/0040-gap-free-window-tiling.md` | [wiki/decisions/0040-gap-free-window-tiling.md](../decisions/0040-gap-free-window-tiling.md) | moved |
| `docs/decisions/0041-dcp-sdk-fallback-provenance.md` | [wiki/decisions/0041-dcp-sdk-fallback-provenance.md](../decisions/0041-dcp-sdk-fallback-provenance.md) | moved |
| `docs/decisions/0042-preview-file-context-actions.md` | [wiki/decisions/0042-preview-file-context-actions.md](../decisions/0042-preview-file-context-actions.md) | moved |
| `docs/decisions/0043-subagent-evidence-retention.md` | [wiki/decisions/0043-subagent-evidence-retention.md](../decisions/0043-subagent-evidence-retention.md) | moved |
| `docs/decisions/0044-retractable-subagent-completions.md` | [wiki/decisions/0044-retractable-subagent-completions.md](../decisions/0044-retractable-subagent-completions.md) | moved |
| `docs/decisions/0045-remove-hover-focus.md` | [wiki/decisions/0045-remove-hover-focus.md](../decisions/0045-remove-hover-focus.md) | moved |
| `docs/decisions/0046-task-scoped-knowledge-completion.md` | [wiki/decisions/0046-task-scoped-knowledge-completion.md](../decisions/0046-task-scoped-knowledge-completion.md) | moved |
| `docs/decisions/0047-remove-session-inspector.md` | [wiki/decisions/0047-remove-session-inspector.md](../decisions/0047-remove-session-inspector.md) | moved |
| `docs/decisions/0048-status-bar-click-popups.md` | [wiki/decisions/0048-status-bar-click-popups.md](../decisions/0048-status-bar-click-popups.md) | moved |
| `docs/decisions/0049-nonmodal-model-picker.md` | [wiki/decisions/0049-nonmodal-model-picker.md](../decisions/0049-nonmodal-model-picker.md) | moved |
| `docs/decisions/0051-claude-reset-grants.md` | [wiki/decisions/0051-claude-reset-grants.md](../decisions/0051-claude-reset-grants.md) | moved |
| `docs/decisions/0052-owned-lsp-control.md` | [wiki/decisions/0052-owned-lsp-control.md](../decisions/0052-owned-lsp-control.md) | moved |
| `docs/decisions/0053-repository-commit-author.md` | [wiki/decisions/0053-repository-commit-author.md](../decisions/0053-repository-commit-author.md) | moved |
| `docs/decisions/0054-project-shared-lsp.md` | [wiki/decisions/0054-project-shared-lsp.md](../decisions/0054-project-shared-lsp.md) | moved |
| `docs/decisions/0055-temporary-btw-side-chat.md` | [wiki/decisions/0055-temporary-btw-side-chat.md](../decisions/0055-temporary-btw-side-chat.md) | moved |
| `docs/decisions/0056-lsp-monitoring.md` | [wiki/decisions/0056-lsp-monitoring.md](../decisions/0056-lsp-monitoring.md) | moved |
| `docs/decisions/0057-lsp-reuse-idle-cleanup.md` | [wiki/decisions/0057-lsp-reuse-idle-cleanup.md](../decisions/0057-lsp-reuse-idle-cleanup.md) | moved |
| `docs/decisions/0058-reverse-file-navigation.md` | [wiki/decisions/0058-reverse-file-navigation.md](../decisions/0058-reverse-file-navigation.md) | moved |
| `docs/decisions/0059-subagent-private-todos.md` | [wiki/decisions/0059-subagent-private-todos.md](../decisions/0059-subagent-private-todos.md) | moved |
| `docs/decisions/0060-subagent-read-only-repo-tools.md` | [wiki/decisions/0060-subagent-read-only-repo-tools.md](../decisions/0060-subagent-read-only-repo-tools.md) | moved |
| `docs/decisions/0061-subagent-scoped-ast-web-tools.md` | [wiki/decisions/0061-subagent-scoped-ast-web-tools.md](../decisions/0061-subagent-scoped-ast-web-tools.md) | moved |
| `docs/decisions/0062-macos-dictation-key.md` | [wiki/decisions/0062-macos-dictation-key.md](../decisions/0062-macos-dictation-key.md) | moved |
| `docs/decisions/0063-task-file-kernel-lock.md` | [wiki/decisions/0063-task-file-kernel-lock.md](../decisions/0063-task-file-kernel-lock.md) | moved |
| `docs/decisions/0064-sqlite-project-tasks.md` | [wiki/decisions/0064-sqlite-project-tasks.md](../decisions/0064-sqlite-project-tasks.md) | moved |
| `docs/decisions/0065-native-repository-search.md` | [wiki/decisions/0065-native-repository-search.md](../decisions/0065-native-repository-search.md) | moved |
| `docs/decisions/0066-native-repository-semantic-search.md` | [wiki/decisions/0066-native-repository-semantic-search.md](../decisions/0066-native-repository-semantic-search.md) | moved |
| `docs/decisions/0067-final-documentation-maintenance.md` | [wiki/decisions/0067-final-documentation-maintenance.md](../decisions/0067-final-documentation-maintenance.md) | moved |
| `docs/decisions/0068-global-semantic-configuration.md` | [wiki/decisions/0068-global-semantic-configuration.md](../decisions/0068-global-semantic-configuration.md) | moved |
| `docs/decisions/0069-parent-owned-implementation.md` | [wiki/decisions/0069-parent-owned-implementation.md](../decisions/0069-parent-owned-implementation.md) | moved |
| `docs/decisions/0070-search-source-work-recovery.md` | [wiki/decisions/0070-search-source-work-recovery.md](../decisions/0070-search-source-work-recovery.md) | moved |
| `docs/decisions/0071-brainstorm-skill-on-subagents.md` | [wiki/decisions/0071-brainstorm-skill-on-subagents.md](../decisions/0071-brainstorm-skill-on-subagents.md) | moved |
| `docs/decisions/0072-session-native-subagents.md` | [wiki/decisions/0072-session-native-subagents.md](../decisions/0072-session-native-subagents.md) | moved |
| `docs/decisions/README.md` | [wiki/decisions/README.md](../decisions/README.md) | moved |
| `docs/decisions/TEMPLATE.md` | [wiki/decisions/TEMPLATE.md](../decisions/TEMPLATE.md) | moved |
| `docs/desktop-mvp.md` | [wiki/archive/desktop-mvp.md](../archive/desktop-mvp.md) | moved |
| `docs/desktop-operation-lock-audit.md` | [wiki/architecture/desktop-operation-lock-audit.md](../architecture/desktop-operation-lock-audit.md) | moved |
| `docs/desktop-task-manager.md` | [wiki/work-management/tasks/desktop.md](../work-management/tasks/desktop.md) | moved |
| `docs/desktop.md` | [wiki/desktop/guide.md](../desktop/guide.md) | moved |
| `docs/development.md` | [wiki/development/guide.md](../development/guide.md) | moved |
| `docs/extensions.md` | [wiki/development/extensions.md](../development/extensions.md) | moved |
| `docs/heads-up-eval.md` | [wiki/assistants/observer/evaluation.md](../assistants/observer/evaluation.md) | moved |
| `docs/incidents/prompt-rpc-timeout.md` | [wiki/operations/incidents/prompt-rpc-timeout.md](../operations/incidents/prompt-rpc-timeout.md) | moved |
| `docs/installation.md` | [wiki/getting-started/installation.md](../getting-started/installation.md) | moved |
| `docs/llm-install.md` | [wiki/getting-started/llm-install.md](../getting-started/llm-install.md) | moved |
| `docs/qa-sandbox.md` | [wiki/development/testing/qa-sandbox.md](../development/testing/qa-sandbox.md) | moved |
| `docs/release.md` | [wiki/development/release/guide.md](../development/release/guide.md) | moved |
| `docs/troubleshooting.md` | [wiki/getting-started/troubleshooting.md](../getting-started/troubleshooting.md) | moved |
| `docs/usage.md` | [wiki/tui/guide.md](../tui/guide.md) | moved |
| `external/pi-tools-suite/README.md` | [wiki/tools/suite.md](../tools/suite.md) | full text moved; concise entry point retained |
| `external/pi-tools-suite/docs/dcp-protected-continuity.md` | [wiki/context/dcp-protected-continuity.md](../context/dcp-protected-continuity.md) | moved |
| `external/pi-tools-suite/docs/evals.md` | [wiki/development/testing/evals.md](../development/testing/evals.md) | moved |
| `external/pi-tools-suite/docs/headless-tool-api.md` | [wiki/tools/headless-tool-api.md](../tools/headless-tool-api.md) | moved |
| `external/pi-tools-suite/docs/session-recovery.md` | [wiki/context/session-recovery.md](../context/session-recovery.md) | moved |
| `external/pi-tools-suite/docs/subagent-model-pools.md` | [wiki/tools/agents/subagent-model-pools.md](../tools/agents/subagent-model-pools.md) | moved |
| `external/pi-tools-suite/docs/ui-qa-subagent.md` | [wiki/development/testing/ui-qa-subagent.md](../development/testing/ui-qa-subagent.md) | moved |
| `scripts/session-revision-eval/README.md` | [wiki/development/testing/session-revision-evaluation.md](../development/testing/session-revision-evaluation.md) | full text moved; concise entry point retained |
| `specs/antigravity-auth.md` | [wiki/providers/antigravity-auth.md](../providers/antigravity-auth.md) | moved |
| `specs/assistant-prompt-composition.md` | [wiki/context/assistant-prompt-composition.md](../context/assistant-prompt-composition.md) | moved |
| `specs/async-subagents.md` | [wiki/tools/agents/async-subagents.md](../tools/agents/async-subagents.md) | moved |
| `specs/brainstorm.md` | [wiki/assistants/brainstorm.md](../assistants/brainstorm.md) | moved |
| `specs/ci-release.md` | [wiki/development/release/ci-release.md](../development/release/ci-release.md) | moved |
| `specs/claude-code-provider.md` | [wiki/providers/claude-code-provider.md](../providers/claude-code-provider.md) | moved |
| `specs/claude-image-count.md` | [wiki/providers/claude-image-count.md](../providers/claude-image-count.md) | moved |
| `specs/claude-image-read-recovery.md` | [wiki/providers/claude-image-read-recovery.md](../providers/claude-image-read-recovery.md) | moved |
| `specs/clickable-markdown-links.md` | [wiki/rendering/clickable-markdown-links.md](../rendering/clickable-markdown-links.md) | moved |
| `specs/codex-reasoning-fix.md` | [wiki/providers/codex-reasoning-fix.md](../providers/codex-reasoning-fix.md) | moved |
| `specs/dcp-provider-cache-stability.md` | [wiki/context/dcp-provider-cache-stability.md](../context/dcp-provider-cache-stability.md) | moved |
| `specs/dcp-reliability-mechanisms.md` | [wiki/context/dcp-reliability-mechanisms.md](../context/dcp-reliability-mechanisms.md) | moved |
| `specs/dcp-statistics.md` | [wiki/context/dcp-statistics.md](../context/dcp-statistics.md) | moved |
| `specs/dcp.md` | [wiki/context/dcp.md](../context/dcp.md) | moved |
| `specs/deepgram-voice-input.md` | [wiki/assistants/deepgram-voice-input.md](../assistants/deepgram-voice-input.md) | moved |
| `specs/desktop-activity-row-timing.md` | [wiki/desktop/rendering/desktop-activity-row-timing.md](../desktop/rendering/desktop-activity-row-timing.md) | moved |
| `specs/desktop-agent-pause.md` | [wiki/desktop/conversations/desktop-agent-pause.md](../desktop/conversations/desktop-agent-pause.md) | moved |
| `specs/desktop-async-lifecycle.md` | [wiki/architecture/desktop-async-lifecycle.md](../architecture/desktop-async-lifecycle.md) | moved |
| `specs/desktop-attachments.md` | [wiki/desktop/conversations/desktop-attachments.md](../desktop/conversations/desktop-attachments.md) | moved |
| `specs/desktop-autocomplete.md` | [wiki/desktop/conversations/desktop-autocomplete.md](../desktop/conversations/desktop-autocomplete.md) | moved |
| `specs/desktop-btw.md` | [wiki/desktop/conversations/desktop-btw.md](../desktop/conversations/desktop-btw.md) | moved |
| `specs/desktop-close-warning.md` | [wiki/desktop/workbench/desktop-close-warning.md](../desktop/workbench/desktop-close-warning.md) | moved |
| `specs/desktop-command-palette.md` | [wiki/desktop/workbench/desktop-command-palette.md](../desktop/workbench/desktop-command-palette.md) | moved |
| `specs/desktop-context-menus.md` | [wiki/desktop/workbench/desktop-context-menus.md](../desktop/workbench/desktop-context-menus.md) | moved |
| `specs/desktop-diff-view.md` | [wiki/desktop/integrations/desktop-diff-view.md](../desktop/integrations/desktop-diff-view.md) | moved |
| `specs/desktop-draft-optimistic-submit.md` | [wiki/desktop/conversations/desktop-draft-optimistic-submit.md](../desktop/conversations/desktop-draft-optimistic-submit.md) | moved |
| `specs/desktop-first-run-bootstrap.md` | [wiki/configuration/desktop-first-run-bootstrap.md](../configuration/desktop-first-run-bootstrap.md) | moved |
| `specs/desktop-git-workflows.md` | [wiki/desktop/integrations/desktop-git-workflows.md](../desktop/integrations/desktop-git-workflows.md) | moved |
| `specs/desktop-html-sandbox.md` | [wiki/desktop/rendering/desktop-html-sandbox.md](../desktop/rendering/desktop-html-sandbox.md) | moved |
| `specs/desktop-inactive-hover.md` | [wiki/desktop/workbench/desktop-inactive-hover.md](../desktop/workbench/desktop-inactive-hover.md) | moved |
| `specs/desktop-live-model-switching.md` | [wiki/configuration/desktop-live-model-switching.md](../configuration/desktop-live-model-switching.md) | moved |
| `specs/desktop-lsp-onboarding.md` | [wiki/operations/desktop-lsp-onboarding.md](../operations/desktop-lsp-onboarding.md) | moved |
| `specs/desktop-markdown-rendering.md` | [wiki/desktop/rendering/desktop-markdown-rendering.md](../desktop/rendering/desktop-markdown-rendering.md) | moved |
| `specs/desktop-menu-navigation.md` | [wiki/desktop/workbench/desktop-menu-navigation.md](../desktop/workbench/desktop-menu-navigation.md) | moved |
| `specs/desktop-modal-dialogs.md` | [wiki/desktop/workbench/desktop-modal-dialogs.md](../desktop/workbench/desktop-modal-dialogs.md) | moved |
| `specs/desktop-model-picker-popup.md` | [wiki/configuration/desktop-model-picker-popup.md](../configuration/desktop-model-picker-popup.md) | moved |
| `specs/desktop-native-process-lifecycle.md` | [wiki/architecture/desktop-native-process-lifecycle.md](../architecture/desktop-native-process-lifecycle.md) | moved |
| `specs/desktop-package-scripts.md` | [wiki/desktop/integrations/desktop-package-scripts.md](../desktop/integrations/desktop-package-scripts.md) | moved |
| `specs/desktop-project-titlebar.md` | [wiki/desktop/workbench/desktop-project-titlebar.md](../desktop/workbench/desktop-project-titlebar.md) | moved |
| `specs/desktop-project-wiki.md` | [wiki/desktop/workbench/desktop-project-wiki.md](../desktop/workbench/desktop-project-wiki.md) | moved |
| `specs/desktop-qa-isolated-launch.md` | [wiki/development/testing/desktop-qa-isolated-launch.md](../development/testing/desktop-qa-isolated-launch.md) | moved |
| `specs/desktop-question-tool.md` | [wiki/desktop/conversations/desktop-question-tool.md](../desktop/conversations/desktop-question-tool.md) | moved |
| `specs/desktop-quota-calendar.md` | [wiki/usage/desktop-quota-calendar.md](../usage/desktop-quota-calendar.md) | moved |
| `specs/desktop-registry-plans.md` | [wiki/work-management/registry/desktop-registry-plans.md](../work-management/registry/desktop-registry-plans.md) | moved |
| `specs/desktop-registry-resource-diff.md` | [wiki/work-management/registry/desktop-registry-resource-diff.md](../work-management/registry/desktop-registry-resource-diff.md) | moved |
| `specs/desktop-runtime-status.md` | [wiki/usage/desktop-runtime-status.md](../usage/desktop-runtime-status.md) | moved |
| `specs/desktop-search-index-status.md` | [wiki/search/desktop-search-index-status.md](../search/desktop-search-index-status.md) | moved |
| `specs/desktop-send-to-fork.md` | [wiki/desktop/conversations/desktop-send-to-fork.md](../desktop/conversations/desktop-send-to-fork.md) | moved |
| `specs/desktop-session-parity.md` | [wiki/desktop/conversations/desktop-session-parity.md](../desktop/conversations/desktop-session-parity.md) | moved |
| `specs/desktop-session-sidebar.md` | [wiki/desktop/conversations/desktop-session-sidebar.md](../desktop/conversations/desktop-session-sidebar.md) | moved |
| `specs/desktop-session-tabs.md` | [wiki/desktop/conversations/desktop-session-tabs.md](../desktop/conversations/desktop-session-tabs.md) | moved |
| `specs/desktop-sidebar-indicators.md` | [wiki/desktop/workbench/desktop-sidebar-indicators.md](../desktop/workbench/desktop-sidebar-indicators.md) | moved |
| `specs/desktop-slash-commands.md` | [wiki/desktop/conversations/desktop-slash-commands.md](../desktop/conversations/desktop-slash-commands.md) | moved |
| `specs/desktop-startup-theme.md` | [wiki/desktop/workbench/desktop-startup-theme.md](../desktop/workbench/desktop-startup-theme.md) | moved |
| `specs/desktop-system-notifications.md` | [wiki/desktop/workbench/desktop-system-notifications.md](../desktop/workbench/desktop-system-notifications.md) | moved |
| `specs/desktop-terminal-commands.md` | [wiki/desktop/integrations/desktop-terminal-commands.md](../desktop/integrations/desktop-terminal-commands.md) | moved |
| `specs/desktop-text-selection.md` | [wiki/desktop/rendering/desktop-text-selection.md](../desktop/rendering/desktop-text-selection.md) | moved |
| `specs/desktop-tool-rows.md` | [wiki/desktop/rendering/desktop-tool-rows.md](../desktop/rendering/desktop-tool-rows.md) | moved |
| `specs/desktop-transcript-scrolling.md` | [wiki/desktop/rendering/desktop-transcript-scrolling.md](../desktop/rendering/desktop-transcript-scrolling.md) | moved |
| `specs/desktop-tray.md` | [wiki/desktop/workbench/desktop-tray.md](../desktop/workbench/desktop-tray.md) | moved |
| `specs/desktop-universal-search.md` | [wiki/search/desktop-universal-search.md](../search/desktop-universal-search.md) | moved |
| `specs/desktop-usage-stats.md` | [wiki/usage/desktop-usage-stats.md](../usage/desktop-usage-stats.md) | moved |
| `specs/desktop-user-config-editing.md` | [wiki/configuration/desktop-user-config-editing.md](../configuration/desktop-user-config-editing.md) | moved |
| `specs/desktop-user-message-actions.md` | [wiki/desktop/conversations/desktop-user-message-actions.md](../desktop/conversations/desktop-user-message-actions.md) | moved |
| `specs/desktop-window-state.md` | [wiki/desktop/workbench/desktop-window-state.md](../desktop/workbench/desktop-window-state.md) | moved |
| `specs/desktop-window-tiling.md` | [wiki/desktop/workbench/desktop-window-tiling.md](../desktop/workbench/desktop-window-tiling.md) | moved |
| `specs/desktop-workbench-tabs.md` | [wiki/desktop/workbench/desktop-workbench-tabs.md](../desktop/workbench/desktop-workbench-tabs.md) | moved |
| `specs/desktop-workspace-navigation.md` | [wiki/desktop/workbench/desktop-workspace-navigation.md](../desktop/workbench/desktop-workspace-navigation.md) | moved |
| `specs/fenced-code-block-rendering.md` | [wiki/rendering/fenced-code-block-rendering.md](../rendering/fenced-code-block-rendering.md) | moved |
| `specs/file-link-opening.md` | [wiki/rendering/file-link-opening.md](../rendering/file-link-opening.md) | moved |
| `specs/harness-artifact-storage.md` | [wiki/operations/harness-artifact-storage.md](../operations/harness-artifact-storage.md) | moved |
| `specs/heads-up-observer.md` | [wiki/assistants/observer/heads-up-observer.md](../assistants/observer/heads-up-observer.md) | moved |
| `specs/historical-thinking-prune.md` | [wiki/context/historical-thinking-prune.md](../context/historical-thinking-prune.md) | moved |
| `specs/logging.md` | [wiki/operations/logging.md](../operations/logging.md) | moved |
| `specs/lsp-runtime-control.md` | [wiki/operations/lsp-runtime-control.md](../operations/lsp-runtime-control.md) | moved |
| `specs/lsp-trust.md` | [wiki/operations/lsp-trust.md](../operations/lsp-trust.md) | moved |
| `specs/markdown-soft-wrap-highlighting.md` | [wiki/rendering/markdown-soft-wrap-highlighting.md](../rendering/markdown-soft-wrap-highlighting.md) | moved |
| `specs/math-markdown-rendering.md` | [wiki/rendering/math-markdown-rendering.md](../rendering/math-markdown-rendering.md) | moved |
| `specs/mermaid-markdown-rendering.md` | [wiki/rendering/mermaid-markdown-rendering.md](../rendering/mermaid-markdown-rendering.md) | moved |
| `specs/model-routing.md` | [wiki/configuration/model-routing.md](../configuration/model-routing.md) | moved |
| `specs/model-scope-fallback.md` | [wiki/configuration/model-scope-fallback.md](../configuration/model-scope-fallback.md) | moved |
| `specs/model-selector-fallbacks.md` | [wiki/configuration/model-selector-fallbacks.md](../configuration/model-selector-fallbacks.md) | moved |
| `specs/model-thinking-preferences.md` | [wiki/configuration/model-thinking-preferences.md](../configuration/model-thinking-preferences.md) | moved |
| `specs/model-visibility-whitelist.md` | [wiki/configuration/model-visibility-whitelist.md](../configuration/model-visibility-whitelist.md) | moved |
| `specs/native-pi-tools-suite-ui.md` | [wiki/tools/native-pi-tools-suite-ui.md](../tools/native-pi-tools-suite-ui.md) | moved |
| `specs/native-repository-search.md` | [wiki/search/native-repository-search.md](../search/native-repository-search.md) | moved |
| `specs/openai-codex-usage-refresh.md` | [wiki/providers/openai-codex-usage-refresh.md](../providers/openai-codex-usage-refresh.md) | moved |
| `specs/overview.md` | [wiki/reference/contracts.md](../reference/contracts.md) | moved |
| `specs/parent-first-subagent-routing.md` | [wiki/tools/agents/parent-first-subagent-routing.md](../tools/agents/parent-first-subagent-routing.md) | moved |
| `specs/pi-tools-suite-module-loading.md` | [wiki/tools/pi-tools-suite-module-loading.md](../tools/pi-tools-suite-module-loading.md) | moved |
| `specs/project-agents-dir.md` | [wiki/tools/agents/project-agents-dir.md](../tools/agents/project-agents-dir.md) | moved |
| `specs/project-search-agent-tool.md` | [wiki/search/project-search-agent-tool.md](../search/project-search-agent-tool.md) | moved |
| `specs/project-tasks-agent-tool.md` | [wiki/work-management/tasks/project-tasks-agent-tool.md](../work-management/tasks/project-tasks-agent-tool.md) | moved |
| `specs/provider-web-search-policy.md` | [wiki/tools/provider-web-search-policy.md](../tools/provider-web-search-policy.md) | moved |
| `specs/question-inactive-tab.md` | [wiki/tui/question-inactive-tab.md](../tui/question-inactive-tab.md) | moved |
| `specs/release-distribution.md` | [wiki/development/release/release-distribution.md](../development/release/release-distribution.md) | moved |
| `specs/reload-context-inventory.md` | [wiki/context/reload-context-inventory.md](../context/reload-context-inventory.md) | moved |
| `specs/repo-knowledge-agent-workflow.md` | [wiki/search/repo-knowledge-agent-workflow.md](../search/repo-knowledge-agent-workflow.md) | moved |
| `specs/resource-registry-agent-companions.md` | [wiki/work-management/registry/resource-registry-agent-companions.md](../work-management/registry/resource-registry-agent-companions.md) | moved |
| `specs/resource-registry-project-state.md` | [wiki/work-management/registry/resource-registry-project-state.md](../work-management/registry/resource-registry-project-state.md) | moved |
| `specs/resource-registry-publication-tags.md` | [wiki/work-management/registry/resource-registry-publication-tags.md](../work-management/registry/resource-registry-publication-tags.md) | moved |
| `specs/retry-toast-action.md` | [wiki/tui/retry-toast-action.md](../tui/retry-toast-action.md) | moved |
| `specs/session-extension-bind-before-prompt.md` | [wiki/architecture/session-extension-bind-before-prompt.md](../architecture/session-extension-bind-before-prompt.md) | moved |
| `specs/session-quota-wait.md` | [wiki/providers/session-quota-wait.md](../providers/session-quota-wait.md) | moved |
| `specs/session-title-after-resource-command.md` | [wiki/context/session-title-after-resource-command.md](../context/session-title-after-resource-command.md) | moved |
| `specs/session-usage.md` | [wiki/usage/session-usage.md](../usage/session-usage.md) | moved |
| `specs/shell-workdir-session-grants.md` | [wiki/operations/shell-workdir-session-grants.md](../operations/shell-workdir-session-grants.md) | moved |
| `specs/suite-codemode.md` | [wiki/tools/suite-codemode.md](../tools/suite-codemode.md) | moved |
| `specs/todo-clear-session-replay.md` | [wiki/work-management/todos/todo-clear-session-replay.md](../work-management/todos/todo-clear-session-replay.md) | moved |
| `specs/todo-initial-status.md` | [wiki/work-management/todos/todo-initial-status.md](../work-management/todos/todo-initial-status.md) | moved |
| `specs/todo-repo-knowledge-finalization.md` | [wiki/work-management/todos/todo-repo-knowledge-finalization.md](../work-management/todos/todo-repo-knowledge-finalization.md) | moved |
| `specs/todo-thinking-model-overrides.md` | [wiki/work-management/todos/todo-thinking-model-overrides.md](../work-management/todos/todo-thinking-model-overrides.md) | moved |
| `specs/tui-embedded-memory-trace.md` | [wiki/tui/tui-embedded-memory-trace.md](../tui/tui-embedded-memory-trace.md) | moved |
| `specs/tui-external-memory-profiler.md` | [wiki/tui/tui-external-memory-profiler.md](../tui/tui-external-memory-profiler.md) | moved |
| `specs/tui-git-slash-commands.md` | [wiki/tui/tui-git-slash-commands.md](../tui/tui-git-slash-commands.md) | moved |
| `specs/tui-input-paste.md` | [wiki/tui/tui-input-paste.md](../tui/tui-input-paste.md) | moved |
| `specs/tui-model-thinking-selector.md` | [wiki/tui/tui-model-thinking-selector.md](../tui/tui-model-thinking-selector.md) | moved |
| `specs/tui-session-tabs.md` | [wiki/tui/tui-session-tabs.md](../tui/tui-session-tabs.md) | moved |
| `specs/tui-streaming-thinking-memory.md` | [wiki/tui/tui-streaming-thinking-memory.md](../tui/tui-streaming-thinking-memory.md) | moved |
| `specs/ui-qa-agent.md` | [wiki/development/testing/ui-qa-agent.md](../development/testing/ui-qa-agent.md) | moved |
| `specs/watch-all-desktop-assets.md` | [wiki/development/watch-all-desktop-assets.md](../development/watch-all-desktop-assets.md) | moved |
| `specs/web-search-tavily-fallback.md` | [wiki/tools/web-search-tavily-fallback.md](../tools/web-search-tavily-fallback.md) | moved |
| `specs/workspace.md` | [wiki/archive/workspace.md](../archive/workspace.md) | moved |
| `src/bundled-extensions/terminal-bell/README.md` | [wiki/tui/terminal-bell.md](../tui/terminal-bell.md) | full text moved; concise entry point retained |

## Required files retained in place

These are tool/package contracts, legal/provenance or fixture/evidence records,
not a second project handbook. General project documentation belongs in Wiki.

| Path | Reason |
| --- | --- |
| [.pi/skills/ci-reliability/SKILL.md](../../.pi/skills/ci-reliability/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/frontier-model-rollover/SKILL.md](../../.pi/skills/frontier-model-rollover/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pi-sdk-update/SKILL.md](../../.pi/skills/pi-sdk-update/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pi-sdk/SKILL.md](../../.pi/skills/pi-sdk/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pi-session-inspector/SKILL.md](../../.pi/skills/pi-session-inspector/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pi-tools-suite/SKILL.md](../../.pi/skills/pi-tools-suite/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pix-desktop-frontend/SKILL.md](../../.pi/skills/pix-desktop-frontend/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pix-desktop-qa/SKILL.md](../../.pi/skills/pix-desktop-qa/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/pix-renderer/SKILL.md](../../.pi/skills/pix-renderer/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [.pi/skills/project-agent-creator/SKILL.md](../../.pi/skills/project-agent-creator/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [AGENTS.md](../../AGENTS.md) | Tool-discovered instruction/skill; fixed path |
| [acp/CHANGELOG.md](../../acp/CHANGELOG.md) | Independent package release history; fixed package metadata |
| [desktop/test-fixtures/audio/README.md](../../desktop/test-fixtures/audio/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/docs/plan-writing.md](../../external/pi-tools-suite/docs/plan-writing.md) | Runtime-loaded plan guidance; desktop-plan-prompt resolves this installed path |
| [external/pi-tools-suite/src/async-subagents/agents/implement-core.md](../../external/pi-tools-suite/src/async-subagents/agents/implement-core.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md](../../external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/mechanical.md](../../external/pi-tools-suite/src/async-subagents/agents/mechanical.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/oracle.md](../../external/pi-tools-suite/src/async-subagents/agents/oracle.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/research.md](../../external/pi-tools-suite/src/async-subagents/agents/research.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android-adb.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android-adb.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-auth.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-auth.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-chrome-devtools.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-chrome-devtools.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-playwright.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-playwright.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-linux.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-linux.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-windows.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-windows.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-native-terminal.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-native-terminal.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-pty.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-pty.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/async-subagents/agents/verify.md](../../external/pi-tools-suite/src/async-subagents/agents/verify.md) | Runtime-loaded role or runner-relative backend guide |
| [external/pi-tools-suite/src/brainstorm/skill/SKILL.md](../../external/pi-tools-suite/src/brainstorm/skill/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [external/pi-tools-suite/src/brainstorm/skill/prompts.md](../../external/pi-tools-suite/src/brainstorm/skill/prompts.md) | Runtime-loaded skill companion; relative-path contract |
| [external/pi-tools-suite/src/claude-code-provider/CHANGELOG.md](../../external/pi-tools-suite/src/claude-code-provider/CHANGELOG.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |
| [external/pi-tools-suite/src/claude-code-provider/DESIGN.md](../../external/pi-tools-suite/src/claude-code-provider/DESIGN.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |
| [external/pi-tools-suite/src/claude-code-provider/SECURITY.md](../../external/pi-tools-suite/src/claude-code-provider/SECURITY.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |
| [external/pi-tools-suite/src/claude-code-provider/UPSTREAM.md](../../external/pi-tools-suite/src/claude-code-provider/UPSTREAM.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |
| [external/pi-tools-suite/test/claude-code-provider/upstream/README.md](../../external/pi-tools-suite/test/claude-code-provider/upstream/README.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |
| [external/pi-tools-suite/test/evals/delivery-review/README.md](../../external/pi-tools-suite/test/evals/delivery-review/README.md) | Test/evaluation guide or retained evidence; stays beside its harness |
| [external/pi-tools-suite/test/evals/delivery-review/RESULTS.md](../../external/pi-tools-suite/test/evals/delivery-review/RESULTS.md) | Test/evaluation guide or retained evidence; stays beside its harness |
| [external/pi-tools-suite/test/evals/fixtures/coding-async/README.md](../../external/pi-tools-suite/test/evals/fixtures/coding-async/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/coding-hypotheses/README.md](../../external/pi-tools-suite/test/evals/fixtures/coding-hypotheses/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/coding-regression/README.md](../../external/pi-tools-suite/test/evals/fixtures/coding-regression/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/0001-legacy-label.md](../../external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/0001-legacy-label.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/0002-local-snapshots.md](../../external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/0002-local-snapshots.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/TEMPLATE.md](../../external/pi-tools-suite/test/evals/fixtures/decision-policy/docs/decisions/TEMPLATE.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/decision-policy/specs/product.md](../../external/pi-tools-suite/test/evals/fixtures/decision-policy/specs/product.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/README.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/failed-gate.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/failed-gate.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/independent.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/independent.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/invalidated-evidence.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/invalidated-evidence.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/scoped-blocker.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/scoped-blocker.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/shared-contract.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/shared-contract.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/worker-claim.md](../../external/pi-tools-suite/test/evals/fixtures/plan-guidance/plans/worker-claim.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/demo-project/AGENTS.md](../../external/pi-tools-suite/test/fixtures/demo-project/AGENTS.md) | Tool-discovered instruction/skill; fixed path |
| [external/pi-tools-suite/test/fixtures/demo-project/README.md](../../external/pi-tools-suite/test/fixtures/demo-project/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/demo-project/docs/checkout-plan.md](../../external/pi-tools-suite/test/fixtures/demo-project/docs/checkout-plan.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/demo-project/docs/lsp-diagnostics.md](../../external/pi-tools-suite/test/fixtures/demo-project/docs/lsp-diagnostics.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/hard-to-find-project/AGENTS.md](../../external/pi-tools-suite/test/fixtures/hard-to-find-project/AGENTS.md) | Tool-discovered instruction/skill; fixed path |
| [external/pi-tools-suite/test/fixtures/hard-to-find-project/README.md](../../external/pi-tools-suite/test/fixtures/hard-to-find-project/README.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/hard-to-find-project/docs/support-report.md](../../external/pi-tools-suite/test/fixtures/hard-to-find-project/docs/support-report.md) | Fixture input or provenance; retained with test data |
| [external/pi-tools-suite/test/fixtures/tool-selection-payment-retry.md](../../external/pi-tools-suite/test/fixtures/tool-selection-payment-retry.md) | Fixture input or provenance; retained with test data |
| [fixtures/qa/pix-project/README.md](../../fixtures/qa/pix-project/README.md) | Package/runtime companion; retained at owning subsystem path |
| [fixtures/qa/pix-project/docs/notes.md](../../fixtures/qa/pix-project/docs/notes.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/context7/SKILL.md](../../skills/context7/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [skills/handoff/SKILL.md](../../skills/handoff/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [skills/pdf/SKILL.md](../../skills/pdf/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [skills/pdf/forms.md](../../skills/pdf/forms.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/pdf/reference.md](../../skills/pdf/reference.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/simplify/SKILL.md](../../skills/simplify/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [skills/skill-creator/SKILL.md](../../skills/skill-creator/SKILL.md) | Tool-discovered instruction/skill; fixed path |
| [skills/skill-creator/agents/analyzer.md](../../skills/skill-creator/agents/analyzer.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/skill-creator/agents/comparator.md](../../skills/skill-creator/agents/comparator.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/skill-creator/agents/grader.md](../../skills/skill-creator/agents/grader.md) | Package/runtime companion; retained at owning subsystem path |
| [skills/skill-creator/references/schemas.md](../../skills/skill-creator/references/schemas.md) | Package/runtime companion; retained at owning subsystem path |
