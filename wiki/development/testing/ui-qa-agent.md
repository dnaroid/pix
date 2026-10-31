<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T02:04:49.158Z","result":{"path":"wiki/development/testing/ui-qa-agent.md","documentHash":"a3127f293a14ad3e132a94e6cbfd10d943abea27190c76dacc16471a5dbf5b69","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/testing/ui-qa-subagent.md","quote":"\n## Related files\n\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/chrome-devtools/chrome-devtools-provider.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/native-terminal-host.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/bridge-client.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/release-helper.mjs`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/windows/windows-uia.ps1`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/linux/linux-atspi.py`\n- `external/pi-tools-suite/src/async-subagents/core/ui-qa.ts`\n- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`\n- `external/pi-tools-suite/test/async-subagents/core.test.ts`\n- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`\n- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.e2e.test.ts`\n- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`\n- `external/pi-tools-suite/test/async-subagents/ui-qa-macos-helper-cache.test.ts`\n- `external/pi-tools-suite/test/async-subagents/ui-qa-macos-release-helper.test.ts`\n- `external/pi-tools-suite/test/async-subagents/ui-qa-desktop.e2e.test.ts`\n- `external/pi-tools-suite/test/async-subagents/selection-e2e.test.ts`\n\n## Acceptance criteria\n\n","startLine":441,"endLine":469},{"path":"wiki/tools/agents/async-subagents.md","quote":"   instruction policy, not a runtime complexity classifier. This replaces the\n   code-review portion of [decision 0001](../../decisions/0001-subagent-coding-roles.md);\n   the parent-owned implementation and role-retirement policy is recorded in\n   [decision 0069](../../decisions/0069-parent-owned-implementation.md).\n   The retained `implement-core` role uses Sol; `mechanical` uses GLM-5.3.\n   Other retained role candidate policies are unchanged. Project-local profiles\n   with retired names remain valid; there are no aliases.\n   GPT-6 Sol is not an alias for GPT-6.1 Sol. Existing user/project model\n   lists still override defaults and are not rewritten by this rollover.\n   `[confirmed by frontier-models.ts and agents/*.md]`\n8. **Role router / auto-ultrawork classifier**: the role router and the\n   `ULTRAWORK_AUTO` classifier both try `routing.model`, then\n   `routing.fallbackModels`, then the current parent model, de-duplicating refs\n   and continuing past unavailable/provider-error candidates. Abort remains\n   terminal. `[confirmed by code, routing.ts/ultrawork-auto.ts]`\n9. **UI QA special role**: `ui-qa` is the only built-in real-UI role for\n   browser, terminal/TUI, and desktop-GUI verification. `browser-qa` is not an\n   alias; a project may define that name only as an ordinary independent role.\n   Like every async sub-agent, `ui-qa` runs without skills. UI QA additionally receives\n   `PI_SUBAGENT_AGENT_DIR` plus launcher-owned `PI_UI_QA_RUNNER` and\n   `PI_BROWSER_QA_RUNNER` paths, and gets private `ui-qa/flows/` plus\n   browser-backend `ui-qa/browser/flows/` workspaces.\n   The start prompt is a thin common contract: the child loads exactly one\n   backend guide (`browser`/`tui`/`desktop`, plus `browser --topic auth` only\n   when authentication is required) through the read-only allowlisted\n   `PI_UI_QA_RUNNER guide` command before any UI action. The unified runner\n   selects browser, PTY/TUI, or macOS Accessibility backends from a declarative\n   target and owns bounded execution/evidence cleanup.\n   `[confirmed by code,\n   config.ts/routing.ts/spawn.ts/ui-qa-runner.mjs]`\n10. **Bundled-role visibility**: top-level pi-tools-suite config may list role\n    names in `disabledBuiltinAgents`. The list follows the normal suite config\n    layer order; a later `enabledBuiltinAgents` entry removes an inherited\n    disable. Filtering happens after the bundled Markdown catalog is cloned and\n    before project `.pi/agents/*.md` definitions merge, so a project-local role\n    may intentionally reuse a disabled built-in name. Disabled built-ins are\n    absent from the parent catalog, explicit-role validation, and automatic\n    routing. A project-local role whose filename exactly matches a bundled role\n    replaces that bundled profile completely; omitted fields are not inherited.\n    The parent catalog explicitly lists active project replacements. There are\n    no role-name aliases or partial-merge exceptions. `[confirmed by code,\n    config.ts/agent-catalog.ts; confirmed by tests, core.test.ts]`\n    `knowledge-auditor` is a low-thinking economical docs-only role with a\n    20-minute default timeout. Before task completion the parent supplies the final\n    behavior/result and exact task-changed paths. The child updates affected\n    documentation from relevant implementation/tests, fixes small proven drift\n    and returns substantial or ambiguous discrepancies to the parent.\n    It also accepts explicit **spec-review** assignments with exact documentation\n    paths and a review goal. Neither mode runs knowledge dirty/acknowledgment,\n    index refreshes or exhaustive dependency traversal. No search installation,\n    initialized index, global clean verdict or review receipt is required.\n    Results contain changed documentation paths and concrete unresolved questions,\n    not global knowledge-state reporting. Preserve concurrent work and keep\n    disposable reports under `.pi/artifacts/`.\n11. **Session persistence and parent state**: every child is a full Pi session stored at `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchildSessionId\u003e.jsonl`. `agentId` is the subagent launch identifier (often supplied as `task.id`), distinct from the UUID Pi assigns to the child session; the parent records the session file reported by the child, and `subagent_meta` maps that session back to `agentId`. The parent stores durable lifecycle/index patches as custom entries in its own session and reconstructs records by folding them in order. Process handles, live activity, full result text and other transient data remain in a live in-memory overlay; there are no regular-agent sidecars or `registry.json`. A batch is an identity label, not a directory. Legacy run directories are ignored and are not migrated. `[confirmed by code and tests]`\n11a. **Follow-up turns (`send`)**: the parent may continue a child's conversation by `agentId`.\n    - **Live delivery** — while the child process is still running and its live channel is open, the message is written to the child's RPC stdin as `{type:\"prompt\", message, streamingBehavior: \"followUp\"|\"steer\"}` (default `followUp`). Pi queues it while streaming, or starts a new run when idle; the tool returns the reported disposition. The latest turn's full result text is read from the child session.\n    - **Settled race** — when `agent_settled` arrives while a live send is pending or was accepted during the current run, termination is deferred: the child is asked for `get_state` and terminated only if it is neither streaming nor has pending messages. Once settled termination is scheduled the channel is closing; new live sends are refused and the tool waits (up to 15 s) for the process to finish, then falls back to cold resume.\n    - **Cold resume** — a terminal child with a persisted session is relaunched under the project concurrency semaphore using that session. The send increments the turn, clears prior process identity while queued, and replaces the current result with the latest turn's text; no turn archives or launch-spec sidecars are created. Launch failures are recorded in the parent session state. In headless mode, cold `send` runs through the detached broker like `spawn`; the broker tracks the resumed `agentId` until its final completion receipt.\n    - Before relaunch, cancellation is refreshed from the parent's durable entries (or a fresh read of the stable-key headless journal), without replacing other in-memory record fields. It is checked after the semaphore wait and again after any awaited owned-provider preflight; a requested stop cancels the queued relaunch without spawning a child.\n","startLine":244,"endLine":303},{"path":"wiki/operations/harness-artifact-storage.md","quote":"- `external/pi-tools-suite/test/desktop-visual-prompt.test.ts`\n\n## Verification\n\nRun the native project cleanup tests to confirm both manual Clean and automatic\nTTL cleanup preserve the durable search database and sidecars.\n\nRun the five focused Bun test files above and suite source typecheck.\nAssertions cover log guidance on shell/Bash aliases, generic child prompts,\nproject-relative eval paths, unique run directories and explicit overrides.\nCheck generated runtime/live synchronization and review task-scoped knowledge\nagainst sources. Live model evals are a separate empirical prompt-compliance\ncheck, not implied by deterministic prompt tests.\n\n\n","startLine":123,"endLine":137},{"path":"wiki/maintenance/inventory.md","quote":"| [Lightweight desktop Markdown rendering](../desktop/rendering/desktop-markdown-rendering.md) | `desktop/rendering` | Implemented; this is the current Desktop Markdown contract. |\n| [Desktop text selection scopes](../desktop/rendering/desktop-text-selection.md) | `desktop/rendering` | Active implemented contract. |\n| [Desktop tool rows](../desktop/rendering/desktop-tool-rows.md) | `desktop/rendering` | Active implemented contract. |\n| [Desktop transcript scrolling](../desktop/rendering/desktop-transcript-scrolling.md) | `desktop/rendering` | Active implemented contract. |\n| [Desktop active-run close warning](../desktop/workbench/desktop-close-warning.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop command palette and command registry](../desktop/workbench/desktop-command-palette.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop right-click context menus](../desktop/workbench/desktop-context-menus.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop inactive-window pointer behavior](../desktop/workbench/desktop-inactive-hover.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop menu keyboard navigation](../desktop/workbench/desktop-menu-navigation.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop modal dialog lifecycle](../desktop/workbench/desktop-modal-dialogs.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop project switcher and identity color](../desktop/workbench/desktop-project-titlebar.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop project Wiki](../desktop/workbench/desktop-project-wiki.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop sidebar indicators](../desktop/workbench/desktop-sidebar-indicators.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop startup theme](../desktop/workbench/desktop-startup-theme.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop notifications (native and sound-only)](../desktop/workbench/desktop-system-notifications.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop optional menu-bar icon](../desktop/workbench/desktop-tray.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop window state persistence](../desktop/workbench/desktop-window-state.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop window tiling](../desktop/workbench/desktop-window-tiling.md) | `desktop/workbench` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Desktop unified workbench tabs](../desktop/workbench/desktop-workbench-tabs.md) | `desktop/workbench` | Active implemented contract. |\n| [Desktop workspace keyboard navigation](../desktop/workbench/desktop-workspace-navigation.md) | `desktop/workbench` | Active implemented contract. |\n| [Pix Desktop](../development/desktop.md) | `development` | guide/reference; no new implementation certification |\n| [Extension authors](../development/extensions.md) | `development` | guide/reference; no new implementation certification |\n| [Development](../development/guide.md) | `development` | guide/reference; no new implementation certification |\n| [CI and release verification](../development/release/ci-release.md) | `development/release` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Release and update verification](../development/release/guide.md) | `development/release` | guide/reference; no new implementation certification |\n| [GitHub Release distribution](../development/release/release-distribution.md) | `development/release` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Isolated Desktop QA from watch builds](../development/testing/desktop-qa-isolated-launch.md) | `development/testing` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Evaluation framework](../development/testing/evals.md) | `development/testing` | guide/reference; no new implementation certification |\n| [Default Pix QA project](../development/testing/qa-sandbox.md) | `development/testing` | guide/reference; no new implementation certification |\n| [Session revision discovery: experimental eval](../development/testing/session-revision-evaluation.md) | `development/testing` | guide/reference; no new implementation certification |\n| [Self-contained UI QA agent instructions](../development/testing/ui-qa-agent.md) | `development/testing` | Active implemented contract. |\n| [UI QA sub-agent specification](../development/testing/ui-qa-subagent.md) | `development/testing` | Active implemented contract. |\n| [watch:all Desktop web asset embedding](../development/watch-all-desktop-assets.md) | `development` | Active implemented contract. |\n| [Installing Pix](../getting-started/installation.md) | `getting-started` | guide/reference; no new implementation certification |\n| [LLM installation command](../getting-started/llm-install.md) | `getting-started` | guide/reference; no new implementation certification |\n| [Troubleshooting](../getting-started/troubleshooting.md) | `getting-started` | guide/reference; no new implementation certification |\n| [Desktop missing-LSP onboarding](../operations/desktop-lsp-onboarding.md) | `operations` | Active implemented contract. |\n| [Harness disposable artifact storage](../operations/harness-artifact-storage.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Deferred investigation: prompt RPC acknowledgement timeout](../operations/incidents/prompt-rpc-timeout.md) | `operations/incidents` | incident observation — cause unresolved |\n| [Unified diagnostic logging](../operations/logging.md) | `operations` | behavioral contract; explicit lifecycle unspecified |\n| [Project-shared LSP runtime and Desktop/TUI monitoring](../operations/lsp-runtime-control.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [lsp trust & command execution (as-is spec)](../operations/lsp-trust.md) | `operations` | Active implemented contract. |\n| [Session-only shell working directories](../operations/shell-workdir-session-grants.md) | `operations` | metadata status: active; implementation coverage not inferred from metadata alone |\n| [Pix](../overview.md) | `overview` | guide/reference; no new implementation certification |\n| [Council brief](../proposals/pix-code-health/brief.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |\n| [Discussion](../proposals/pix-code-health/discussion.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |\n| [Code Health для Pix — проект архитектурной рекомендации](../proposals/pix-code-health/draft-proposal.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |\n| [Code Health для Pix — итог архитектурного брейншторма](../proposals/pix-code-health/proposal.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |\n| [Disposition раунда 5](../proposals/pix-code-health/revision-notes.md) | `proposals/pix-code-health` | proposal / discussion — not approved implementation |\n| [antigravity-auth (as-is spec)](../providers/antigravity-auth.md) | `providers` | Active implemented contract. |\n| [Local Claude Code provider](../providers/claude-code-provider.md) | `providers` | metadata status: active; implementation coverage not inferred from metadata alone |\n","startLine":146,"endLine":196},{"path":"wiki/tools/agents/subagent-model-pools.md","quote":"model; `models` and the provider policy do that.\n\n## Project-local customization and compatibility\n\nProjects customize role behavior by adding or replacing\n`\u003cproject\u003e/.pi/agents/\u003crole\u003e.md`. There is no `.pi/agents/presets.jsonc`, saved\nsub-agent preset selection, `AGENTS_PRESET`, or `/subagent-preset` runtime\nsurface. A project that wants different worker economics changes the ordered\ncandidate list of the relevant role instead of selecting a global model pool.\n\nA project-local file with the same name as a bundled role replaces that bundled\nprofile completely. Omitted fields do not fall through to the built-in\ndefinition. The effective parent catalog explicitly reports active same-name\nreplacements so the parent knows it is seeing project-owned semantics. There\nare no role-name aliases or partial-merge exceptions.\n\nOld role names are not implicit aliases. `quick`, `scan`, `review`, `deep`,\n`docs`, `frontend`, and `tests` work only when explicitly defined as ordinary\nproject types. This keeps the effective catalog and accepted names exact.\n\nLegacy `model` plus `fallbackModels` and `modelByParent` still load when declared\nin an agent Markdown file. A modern `models` profile is the complete ordered\ncandidate chain. Empty `models` means no candidates, not permission to inherit\nthe parent model. Legacy singular selectors normalize with an explicit fallback\narray, including `[]`.\n\nThe removed `asyncSubagents` section is no longer part of the public config\nschema and is not read at runtime. Existing legacy files are left untouched but\nhave no effect. Migrate role definitions and model candidate choices to\n`\u003cproject\u003e/.pi/agents/*.md`. To hide only selected bundled roles, use top-level\n`disabledBuiltinAgents` in `pi-tools-suite.jsonc`; later config layers may\nre-enable names with `enabledBuiltinAgents`. The filter runs before project-local\nMarkdown is applied, so a same-named project role can intentionally replace a\ndisabled built-in.\n\n## Compact handoff\n\n","startLine":175,"endLine":211},{"path":"wiki/maintenance/migration-map.md","quote":"\n## Required files retained in place\n\nThese are tool/package contracts, legal/provenance or fixture/evidence records,\nnot a second project handbook. General project documentation belongs in Wiki.\n\n| Path | Reason |\n| --- | --- |\n| [.pi/skills/ci-reliability/SKILL.md](../../.pi/skills/ci-reliability/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/frontier-model-rollover/SKILL.md](../../.pi/skills/frontier-model-rollover/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pi-sdk-update/SKILL.md](../../.pi/skills/pi-sdk-update/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pi-sdk/SKILL.md](../../.pi/skills/pi-sdk/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pi-session-inspector/SKILL.md](../../.pi/skills/pi-session-inspector/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pi-tools-suite/SKILL.md](../../.pi/skills/pi-tools-suite/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pix-desktop-frontend/SKILL.md](../../.pi/skills/pix-desktop-frontend/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pix-desktop-qa/SKILL.md](../../.pi/skills/pix-desktop-qa/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/pix-renderer/SKILL.md](../../.pi/skills/pix-renderer/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [.pi/skills/project-agent-creator/SKILL.md](../../.pi/skills/project-agent-creator/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [AGENTS.md](../../AGENTS.md) | Tool-discovered instruction/skill; fixed path |\n| [acp/CHANGELOG.md](../../acp/CHANGELOG.md) | Independent package release history; fixed package metadata |\n| [desktop/test-fixtures/audio/README.md](../../desktop/test-fixtures/audio/README.md) | Fixture input or provenance; retained with test data |\n| [external/pi-tools-suite/docs/plan-writing.md](../../external/pi-tools-suite/docs/plan-writing.md) | Runtime-loaded plan guidance; desktop-plan-prompt resolves this installed path |\n| [external/pi-tools-suite/src/async-subagents/agents/implement-core.md](../../external/pi-tools-suite/src/async-subagents/agents/implement-core.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md](../../external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/mechanical.md](../../external/pi-tools-suite/src/async-subagents/agents/mechanical.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/oracle.md](../../external/pi-tools-suite/src/async-subagents/agents/oracle.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/research.md](../../external/pi-tools-suite/src/async-subagents/agents/research.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android-adb.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android-adb.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/android.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-auth.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-auth.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-chrome-devtools.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-chrome-devtools.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-playwright.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser-playwright.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/browser.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-linux.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-linux.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-windows.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-windows.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-native-terminal.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-native-terminal.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-pty.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui-pty.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui.md](../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/tui.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/async-subagents/agents/verify.md](../../external/pi-tools-suite/src/async-subagents/agents/verify.md) | Runtime-loaded role or runner-relative backend guide |\n| [external/pi-tools-suite/src/brainstorm/skill/SKILL.md](../../external/pi-tools-suite/src/brainstorm/skill/SKILL.md) | Tool-discovered instruction/skill; fixed path |\n| [external/pi-tools-suite/src/brainstorm/skill/prompts.md](../../external/pi-tools-suite/src/brainstorm/skill/prompts.md) | Runtime-loaded skill companion; relative-path contract |\n| [external/pi-tools-suite/src/claude-code-provider/CHANGELOG.md](../../external/pi-tools-suite/src/claude-code-provider/CHANGELOG.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |\n| [external/pi-tools-suite/src/claude-code-provider/DESIGN.md](../../external/pi-tools-suite/src/claude-code-provider/DESIGN.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |\n| [external/pi-tools-suite/src/claude-code-provider/SECURITY.md](../../external/pi-tools-suite/src/claude-code-provider/SECURITY.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |\n| [external/pi-tools-suite/src/claude-code-provider/UPSTREAM.md](../../external/pi-tools-suite/src/claude-code-provider/UPSTREAM.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |\n| [external/pi-tools-suite/test/claude-code-provider/upstream/README.md](../../external/pi-tools-suite/test/claude-code-provider/upstream/README.md) | Upstream provenance, security, design/history or offline test reference; not a current Pix contract |\n","startLine":258,"endLine":306},{"path":"wiki/tools/agents/parent-first-subagent-routing.md","quote":"\n## Verification\n\n- `test/async-subagents/routing.test.ts`: explicit bypass and validation,\n  omitted/mixed tasks, disabled/unavailable routing, invalid/partial responses,\n  provider errors, fallback models, cancellation, and project Markdown roles.\n- `test/async-subagents/tools.test.ts`: public and internal spawn errors are\n  visible and create no run state; explicit spawns still apply their profiles\n  with the router disabled.\n- `test/tool-descriptions.test.ts`: parent catalog and tool guidance agree.\n- Opt-in live selection evals verify the parent-first boundary in both\n  directions: a targeted root-cause investigation and a compact already-specified\n  implementation stay in the parent without a `subagents` call, while an\n  explicit delegation request still produces one role-appropriate spawn without\n  model/thinking overrides or progress polling. They also distinguish normal\n  explicit parent selection from explicitly requested automatic routing. Direct\n  live evals additionally exercise a project-local Markdown specialist alongside\n  built-in roles.\n\nLive semantic results must be reported separately from deterministic tests.\n\n\n","startLine":96,"endLine":117},{"path":"wiki/development/testing/index.md","quote":"# Testing, QA and evaluations\n\nDeterministic checks, native QA and opt-in evaluation harnesses have different evidence scopes. An isolated fixture or a browser preview is not proof about the real native target.\n\n[Wiki home](../../index.md)\n\n## Pages\n\n- [Isolated Desktop QA from watch builds](desktop-qa-isolated-launch.md) — active\n- [Evaluation framework](evals.md)\n- [Wiki contradiction evaluation](wiki-contradiction-evaluation.md)\n- [Default Pix QA project](qa-sandbox.md)\n- [Session revision discovery: experimental eval](session-revision-evaluation.md)\n- [Self-contained UI QA agent instructions](ui-qa-agent.md)\n- [UI QA sub-agent specification](ui-qa-subagent.md)\n\n\n","startLine":1,"endLine":17},{"path":"wiki/tools/suite.md","quote":"#### Browser backend and project auth\n\nThe capability-first runner and all backend resources live under\n`src/async-subagents/agents/ui-qa/`; the trusted browser runner, vendor code,\nlicense, and examples are grouped under its `browser/` directory. The launcher\nsupplies absolute paths in `PI_UI_QA_RUNNER` and `PI_BROWSER_QA_RUNNER`. Normal\nprobe/run uses the former;\nthe latter is invoked directly only for browser auth profile discovery and\nform-auth scaffolding. These non-secret paths are set only for QA children.\nEvery async sub-agent launches with `--no-skills`, and skill flags in\n`extraArgs` are stripped rather than forwarded. Agent roles are self-contained;\nthere is no profile field for injecting skills and no built-in QA `--skill`.\n\nA project `ui-qa.md` completely replaces the bundled UI-QA profile, like every\nother same-named project role. It does not inherit bundled models, tools,\nthinking, visibility fields, or Markdown instructions. Projects that replace\n`ui-qa` must explicitly carry forward every bundled field/instruction they\nstill require. Runtime runner/workspace isolation and credential handling remain\nenforced in code.\n\nPublic browser QA does not require an auth profile or `.pi/qa_auth.jsonc`: run it\nwith an explicit base URL, whose exact origin becomes the fail-closed allowlist.\nThe runner neither creates nor requests a credential file for that path.\n\nFor targets that actually require login, keep named dev/staging auth profiles in\nproject `.pi/qa_auth.jsonc` (there is no `/qa-auth` command). The private runner\nsupports `form`, `cookie`, `localStorage`,\n`sessionStorage`, `bearer`, and existing Playwright `storageState` auth. Every\nprofile must declare exact `allowedOrigins`; select the profile id explicitly only\nfor authenticated QA. On POSIX, keep the config at mode `0600`. During a run\nthose origins also form the fail-closed HTTP(S)/WebSocket allowlist and service\nworkers are blocked. Example:\n\n```jsonc\n{\n  \"profiles\": {\n    \"staging-admin\": {\n      \"description\": \"Staging administrator\",\n      \"traits\": [\"role:admin\", \"plan:enterprise\"],\n      \"baseUrl\": \"https://staging.example.test\",\n      \"allowedOrigins\": [\"https://staging.example.test\"],\n      \"auth\": {\n        \"type\": \"form\",\n        \"loginUrl\": \"https://staging.example.test/login\",\n        \"fields\": [\n          { \"selector\": \"input[name=email]\", \"value\": \"admin@example.test\" },\n          { \"selector\": \"input[name=password]\", \"value\": \"replace-me\" }\n        ],\n        \"submitSelector\": \"button[type=submit]\",\n        \"success\": { \"selector\": \"[data-testid=user-menu]\" }\n      }\n    }\n  }\n}\n```\n\nDo not place credential values in prompts, QA flows, shell arguments, or reports.\nThe helper reads JSONC internally and emits only redacted statuses. For form auth,\nvideo recording begins on the login page and captures the field-filling and submit\nsequence; password inputs remain browser-masked, but the private video may show","startLine":964,"endLine":1023},{"path":"wiki/context/dcp.md","quote":"\nCompression progress may retain cumulative debt across callbacks so new growth\nis not forgotten, but any one automatic recovery plan is capped by the savings\nrequired by the **current** budget. Under active progress/capacity pressure,\nraw-tail range planning leaves already-materialized compression blocks in place\nand selects only eligible raw history. This prevents a previously economical\nsummary from being folded together with a tiny new tail on every pass. A\nseparate automatic consolidation path may periodically merge a **batch of\nphysically adjacent block-only `bN` summaries**; it never spans raw messages and\nis still subject to exact full-projection gain checks. Non-pressure/manual\nconsolidation can also address `bN` blocks explicitly.\n\nThe emergency path protects the current user request, newest live assistant\ngroup, configured recent pairs, explicitly pinned tools/files, and results\nwithout completed provider evidence. `compress.protectedTools` and\n`protectedFilePatterns` are empty by default; explicit lists are opt-in and\nreplace earlier/model-layer values, so an empty list unpins. Independently, a\nconservative raw-deletion guard prevents discarding action/effect evidence\nwithout a safe replacement. It is not an exact-retention pin or a hardcoded\nverbatim list. If a safe exact summary cannot be prepared and the\nhard safety floor must prune eligible old result bodies, those decisions are\nexplicitly committed and replayed. If the remaining protected minimum itself\ncannot fit, DCP records a blocked state and uses the headless abort/handoff path\ninstead of sending the same oversized request indefinitely. An exact\nauto-compression failure at capacity does **not** jump directly to abort: DCP\nfirst re-evaluates the bounded emergency current-turn body-prune floor and only\nhands off when the post-recovery projection still exceeds input capacity.\nLikewise, a positive partial auto-compression commit is not provider-send\npermission when the request is still above input capacity: the same context pass\ncontinues through eligible emergency recovery and otherwise fails closed rather\nthan sending the oversized projection.\nBlocked handoffs emit a user-visible `progress-blocked` diagnostic containing\nthe reason and capacity figures before `ctx.abort()` is invoked.\n\nProvider send has an additional lifecycle fail-closed gate. A journal-backed\nsession epoch must complete a provider-ready `context` projection in that same\nepoch before `before_provider_request` may proceed. If a `session_start`,\ncompaction, model/session ownership transition, or equivalent lifecycle reset\noccurs after context construction but before provider send, DCP aborts that\nstale send with a diagnostic instead of allowing raw/unprojected session history\nto bypass DCP. A fresh context pass in the new epoch re-enables provider send.\n\nWhen emergency pressure has no normal compression candidate, DCP can still\nderive same-turn candidates from old, complete assistant tool-call/result pairs.\nIt never selects user messages, protected/recent pairs, compressed members, or\nresults that lack completed provider evidence. A strong reminder may therefore\nbe emitted even when normal range/message detectors return nothing.\n\nEmergency lossy pruning fires only after the configured hard threshold or after\nenough completed provider opportunities ignored a strong reminder. Repeated\ncontext transforms alone do not consume patience. Eligible result bodies are\nprocessed deterministically oldest-first until the bounded recovery target is\nmet; structural tool-call/result pairing remains intact. Successful emergency\npruning clears reminder/progress state and journals the committed prune IDs.\n\nProvider-seen evidence and ignored-reminder patience counters are runtime-only;\nrestart returns them to conservative unknown/zero state. Journal persistence\ncovers durable projection/prune decisions and frozen nudge anchors, not a legacy\nsidecar snapshot of emergency runtime counters.\n\nDiagnostic events distinguish the important blocked/emergency paths, including\n`context.strong_nudge_without_candidate`,","startLine":305,"endLine":366},{"path":"wiki/decisions/0027-sidebar-reason-actions.md","quote":"\n## Observations and sources\n\nVerified: the [indicator policy](../../desktop/src/lib/sidebar-indicator-policy.ts)\nalready enumerates causes; existing owners expose AI review, Git, task and Registry\ncallbacks. Panel operation state remains owned by its mounted panel. The existing\nProject Explorer uses a component-owned WebView menu and shared keyboard helpers.\nNative visual verification is separate from deterministic tests, not assumed here.\n\n## Decision\n\n","startLine":16,"endLine":26},{"path":"wiki/tools/agents/project-agents-dir.md","quote":"### Built-in definition source\n\n- Built-in role profiles are individual files in\n  `src/async-subagents/agents/*.md` and are parsed by the same\n  `readAgentDefinitionsFromDir` + `normalizeSubagentTypeProfile` path as project\n  agents.\n- `defaultType` is now `research` while bundled files are loaded in\n  deterministic filename order. Spec 29 supersedes silent spawn-error fallback\n  with parent-first role selection and recoverable routing errors.\n- The bundled `knowledge-auditor` is an economical docs-only role that updates\n  affected documentation from relevant implementation/tests without search setup or\n  knowledge-state checks; it fixes small proven drift and returns substantial\n  discrepancies to the parent.\n- Runtime-only invariants stay in runtime code. All async sub-agents disable\n  skill discovery and reject skill injection through `extraArgs`; role files are\n  therefore self-contained. As extended by `ui-qa-agent.md`, `ui-qa` additionally\n  receives launcher-owned runner/workspace paths. Its top-level\n  `agents/ui-qa.md` body is a thin common contract plus deterministic guide\n  routing; backend-specific browser/TUI/Desktop/auth instructions live in\n  non-role assets under `agents/ui-qa/guides/` and are loaded through the\n  allowlisted UI-QA runner. `ui-qa` is the only built-in UI-QA role name.\n","startLine":145,"endLine":165}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Неопределённость 2 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Результат 1 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":59,"excerptedSources":11,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->
# Self-contained UI QA agent instructions

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

Use the same one-agent/one-Markdown definition for real UI QA as for other
built-in and project-local roles. The canonical `ui-qa` role covers browser,
terminal/TUI, and native desktop verification while preserving the browser
providers' credential, isolation, evidence, and cleanup protections.

## Definition and resources

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md` holds the model,
  fallback, thinking, tools, and timeout frontmatter plus a thin common
  contract: real-target and `BLOCKED` invariants, deterministic-assertion
  oracle, bounded execution, owned cleanup, private evidence, and the minimal
  backend-guide/probe/run invocation syntax. It deliberately contains no
  browser-provider, terminal-presentation, desktop-platform, or credential
  implementation instructions.
- Backend-specific instructions are progressive-disclosure guides under
  `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
  (`browser.md`, `tui.md`, `desktop.md`) plus backend-scoped detail topics:
  browser `playwright`, `chrome-devtools`, and `auth`; TUI `pty` and
  `native-terminal`; desktop `macos-accessibility`, `windows-uia`, and
  `linux-at-spi`. The child loads exactly one base guide through the
  read-only runner command `node "$PI_UI_QA_RUNNER" guide --backend
  browser|tui|desktop`, then only the detail topic required by that base
  router. The command selects files from a fixed backend-scoped bundled
  allowlist (no model-composed paths or traversal), rejects cross-backend or
  unknown topics/options/extra arguments, bounds guide size, and prints only
  the requested document. Guides are not discoverable agent roles.
- The shared loader turns the thin body into `promptAppend`; only the short
  `description` reaches parent/router catalogs. No QA-specific prompt injection
  is required. Project-specific setup may explicitly route to a local document
  or skill file for manual reading; this does not enable skill auto-loading.
- The capability-first runner and its browser/TUI/desktop backends live under
  `agents/ui-qa/`. The trusted Playwright browser runner, vendor
  dependency/license, and browser JSONC assets are grouped under
  `agents/ui-qa/browser/`; the Chrome DevTools adapter lives under
  `agents/ui-qa/drivers/` and probes the external `chrome-devtools` CLI rather
  than loading a project skill. Vendor bytes stay unchanged; both runners accept
  only the canonical `ui-qa` owner type. JSONC examples are optional reference
  assets, not additional instructions.
- The old skill and separate design/scaffold documents are removed. Ordinary
  `.pi/agents` discovery remains non-recursive, so assets cannot become roles.

## Default project selection

An explicit project, path, URL or real-data requirement takes precedence.
The agent must not silently redirect an explicit target to synthetic data.
When the application is known but no data project is specified, prefer its
documented disposable QA project rather than the user's working projects.
This substitutes project data only, never a mock application or UI surface.
An unclear application or unsafe required target remains `BLOCKED`.

In the Pix source checkout, the common role routes to `wiki/development/testing/qa-sandbox.md`.
Desktop preparation seeds a fresh owned workspace by default; an explicit
`--empty-workspace` supports empty-project scenarios. For TUI/manual setup,
`npm run qa:sandbox` creates a fresh copy under `.pi/artifacts/`. Each seeded
copy gets a separate empty Git repository, with no commits, remotes or template
hooks, and no real credentials, sessions or tasks database. Report the actual
project and coverage limits; sandbox success does not prove real-data behavior.
Pix Desktop setup explicitly reads the local QA skill; the launcher still
forces `--no-skills` and does not inject project skills.

## Runtime behavior

All async sub-agent children are self-contained: `spawnAgent` always forces
`--no-skills` and strips `--skill` / `--skill=...` flags from forwarded CLI
arguments. `isolatedSkills` is no longer a supported profile field, so UI QA has
no special skill-loading path and cannot receive optional injected skills. The
launcher also appends `--models <effective-model>` after forwarded arguments,
preventing persisted model patterns from resolving unrelated providers in the
isolated child.

`ui-qa` is the only built-in UI-QA role name. `browser-qa` has no alias or
migration path; a project-local `browser-qa.md` is an ordinary independent
project role and receives no UI-QA runner/workspace treatment.

The launcher sets non-secret `PI_UI_QA_RUNNER` and `PI_BROWSER_QA_RUNNER` paths
resolved relative to the installed package. QA instructions invoke the unified
runner for the read-only `guide` loader, capability probe, and browser/TUI/desktop
execution; they invoke the trusted browser runner directly only for auth profile
discovery/scaffolding as the browser-auth guide instructs.
Inherited runner/workspace paths are replaced for QA children and stripped from
other children. Unified flows plus native/TUI evidence use the private
agent-local `ui-qa/` workspace; the trusted browser backend uses its
`ui-qa/browser/` subdirectory.
Model-authored flows are credential-free but still use mode `0600` on POSIX so
the existing runner path/privacy validation succeeds without weakening it.

The unified runner selects exactly one backend from the flow target, reports
candidate capabilities and rationale, and normalizes assertions, observations,
typed artifact links. Every probe/run selection also exposes an authoritative
`selection.guide = {backend, topic}` when a supported detail route exists. The
child must reconcile its loaded detail guide with that value before `run`; this
keeps provider/presentation/platform routing capability-driven without putting
those decisions in the common role body. `BLOCKED` results additionally carry
a normalized
`blockedHandoff`: selected backend/platform driver, missing capabilities,
reason, remediation, `manualActionRequired: true`, and
`automaticRemediationAttempted: false`. This gives the parent agent a stable
environment-repair/install/permission handoff without granting the QA child
permission to modify the host. TUI runs use a real PTY plus ANSI/VT screen model
and automatically retain a bounded asciicast v2 replay. Desktop control is
platform-specific behind the same runner contract: macOS uses bundled
Accessibility/CGWindow/ScreenCaptureKit, Windows uses bundled PowerShell/.NET UI
Automation with Win32 exact-window PNG capture, and Linux uses bundled Python
AT-SPI with runtime-probed screenshot/keyboard producers. macOS exact-window
video scales to fill the Retina encoder surface; Windows/Linux currently report
`windowVideo` as missing rather than fabricating video evidence from another
surface. Evidence never replaces deterministic assertions. Launch contracts,
private
paths, deadlines, and owned-process cleanup are enforced by the runner rather
than by model instructions alone.

Browser provider selection happens inside the browser backend and is likewise
capability-driven. `target.browserDriver` accepts `auto`, `playwright`, or
`chrome-devtools`. `auto` keeps ordinary E2E and every trusted auth profile on
Playwright; DevTools-only accessibility-tree, console/network, Lighthouse,
performance-trace, or heap-summary actions select Chrome DevTools. Explicit
`target.devtools` startup/attach options also select Chrome DevTools in `auto`
mode. The selection never depends on repository or application identity.

Playwright-backed runs launch Playwright's pinned Chromium build first. When
that build is missing (for example after a project Playwright upgrade without
`playwright install`), the trusted runner falls back only to Chromium
executables already present on the host: the newest builds in the Playwright
browser cache (`PLAYWRIGHT_BROWSERS_PATH` or the platform default), then system
Google Chrome/Chromium. It never downloads or installs a browser. If nothing
launches, or Playwright itself cannot be loaded, it reports
`QA_BROWSER_UNAVAILABLE` (exit 43) with remediation and `missingCapabilities`;
the browser adapter normalizes that to `BLOCKED`, and the unified runner merges
those capabilities into `blockedHandoff`.

The Chrome DevTools provider requires `chrome-devtools-mcp >= 1.9.0`, creates a
random per-run daemon session, and stops only that session. By default it uses
`--autoConnect=true` to discover Chrome's remote-debugging endpoint; it does
not guess or scan ports, and Chrome remote debugging must already be enabled.
An explicit exact credential-free local loopback `browserUrl` overrides this
default. An explicit `headless` boolean opts into launching an isolated browser
instead. All modes create a task-owned isolated page/context unless
`reuseExistingBrowserSession: true` is explicitly authorized by the parent/user
alongside `browserUrl`. The runner closes only its own page and stops only its
own daemon; it does not stop external Chrome or close unrelated tabs.

DevTools execution disables JavaScript evaluation, extensions/PWA/experimental
categories, usage statistics, and CrUX lookup; enables network-header
redaction/page-id routing; restricts writes to the evidence directory; and
passes exact target/allowed origins into the DevTools network allowlist. Raw
network headers and response bodies are never published. Trusted
`.pi/qa_auth.jsonc` profiles remain Playwright-only, and the QA child never
installs/upgrades the CLI or moves credentials into DevTools arguments/profile
state. Supported DevTools flow actions are the common navigation/basic
interaction/text/URL/screenshot subset plus `snapshotAccessibility`,
`assertNoConsoleErrors`, `assertConsole`, `assertNetworkRequest`, `lighthouse`,
`performanceTrace`, and `heapSummary`. DevTools locators resolve one UID from
the latest AX snapshot using `{role,name?,exact?}` or `{text,exact?}`. Raw heap
snapshots and raw performance traces are deleted after retaining bounded
sanitized summaries. Top-level
deterministic `environment` remains Playwright-only; DevTools blocks it rather
than approximating locale/timezone/reduced-motion semantics.

For explicitly authorized synthetic diagnostics, a macOS-only
`target.application: { fixture: "texteditBlank" }` exception launches the fixed system
TextEdit bundle through `NSWorkspace.OpenConfiguration` with new-instance/no-substitution
and per-process no-restore/untitled-window flags. It cannot
combine with selectors or launch overrides and never weakens generic executable
validation. It refuses already-running TextEdit and retains only the completion
`NSRunningApplication`, using `isEqual` identity rather than PID/group ownership.
One blank focused untitled document is required before input. Exactly one
`texteditSmoke` action is required; `texteditBlankLifecycle` instead requires zero.
Only bounded `snapshotAccessibility` may accompany the smoke; snapshots stay inside
the retained-handle supervisor. Screenshot/video and generic companions are rejected
before launch, with no PID-based fallback. The helper posts seven fixed paired global HID key
events for `ghbdtn ` and checks live focused-app PID, AX identity, and exact text after
each key; U.S./ABC layout and secure-input/modifier guards fail closed without repair.
This is synthetic delivery, not physical-origin or product-counter acceptance. Generic
`pressKey` is unchanged. Launch/window correlation failure blocks input. Preflight/
launch and focus/post races remain; a new document may autosave. No persistent defaults,
HOME/environment edits, user container cleanup, or TCC reset is permitted. Existing
helper-signature/reapproval rules apply. Focused regression coverage lives in
`external/pi-tools-suite/test/async-subagents/textedit-fixture.test.ts`; static tests
do not establish runtime delivery. Foundation-only lifecycle tests live alongside
`textedit-native-policy.test.ts`; they are not AppKit/AX runtime proof.
**Manual TextEdit closing only:** no terminate/forceTerminate, PID/group signals,
UI close, reaper, or handle reconstruction is permitted in any fixture outcome.
Smoke status is separate from cleanup: `manualRequired` for a retained handle without
observed exit, `unknown` for absent completion/lost supervisor, `confirmed` only for
retained `isTerminated` plus no equal running instance, and `notNeeded` before any LS
request. After a sent launch, unknown results conservatively require manual inspection,
even if launch may not have occurred. Never infer completion from helper exit or retry
before manual resolution. EOF/timeouts/signals permanently revoke input; late callbacks
cannot restore it. Native launch has a 15-second budget and a 3-second late drain;
the parent releases only its own helper with a 5-second ceiling inside the runner's
10-second hard grace. Only the directly spawned helper may be killed at that ceiling.
Diagnostics do not repair launch or prove delivery/cleanup; see the
[macOS guide](../../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md).

POSIX desktop launch contracts are correlated and cleaned up by their owned
detached process group, not only by the launcher PID. This lets package-manager
wrappers hand off to the real GUI descendant without making that descendant
invisible to accessibility automation or leaving it behind after QA. On macOS,
`wait-window --pgid` services the AppKit run loop between polls so
NSWorkspace can register a GUI descendant launched after waiting begins.
In source/development runs, the bundled macOS driver is built into a
user-global, private
`~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility` executable
rather than the per-agent workspace. Its SHA-256 sidecar is checked under an
exclusive build lock; changed
source is compiled and signed in a private staging file, verified, then
atomically replaces the executable at the same path. The signature uses the
fixed `org.pix.ui-qa.macos-accessibility` identifier, not the staging filename.
When `PI_UI_QA_MACOS_CODESIGN_IDENTITY` names an available keychain signing
certificate, its certificate-based designated requirement can persist across
source updates. Without a certificate the helper is ad-hoc signed: its
designated requirement pins the code hash, so an updated build requires a new
user TCC grant even though the executable path and signing identifier stay
constant. Permissions belong to the helper identity; approval of Pix Desktop
alone is not proof that the helper's doctor sees them.
The home is resolved from the OS account rather than an overridden HOME.
The installation and lock are shared across projects; project Registry cleanup
does not reach them. A matching private legacy project binary may be copied and
signature-verified unchanged, never moved or symlinked; otherwise the bundled
source is compiled. A corrupt or unsafe global cache fails closed. No old cache
or TCC record is removed automatically. This changes source/development storage,
not release helper selection.
Only an explicit user/parent permission setup invokes `doctor --prompt`; normal
runner probes use plain `doctor`. Requests may return missing while approval is
pending and do not grant permission. Recheck from a fresh process after approval;
if a dialog does not appear, manually enable the exact reported helper path in
System Settings. Stable storage does not guarantee TCC grants survive moving or
re-signing the binary.
An installed macOS release instead selects the signed
`helpers/macos-accessibility` from its own payload, both in portable TUI and
Desktop's `pix-runtime`. The release builds it before copying the TUI payload
for Desktop, signs it with the same fixed identifier and release Apple signing
identity, and verifies the signature at packaging and at runtime. A missing or
invalid release helper blocks QA with reinstall guidance; the installed build
does not compile a replacement in the current project or require Xcode tools.
With a certificate-based designated requirement, the helper can retain its
TCC identity across release updates; the ad-hoc release fallback has a
code-hash requirement and may need renewed user approval after updates.
Windows uses the owned launcher PID as a process-tree root: UI Automation resolves
the actual GUI descendant before interaction, and cleanup stays scoped to the
launcher plus that correlated GUI root. Launch environments allow bounded
`PI_UI_QA_*` bootstrap
variables in addition to the generic environment allowlist; the runner always
supplies `PI_UI_QA=1`. Both TUI presentations preserve inherited `USER` and
`LOGNAME` alongside `HOME` so subscription CLIs can locate existing OS
credential-store entries. Absent identity variables remain absent; arbitrary
ambient variables, API keys and OAuth tokens are not forwarded. This does not
expand the flow-authored environment override allowlist.
For explicitly requested prompt diagnostics, TUI flows may set
`target.command.env.PI_DEBUG_PROMPT` to the string `0` or `1`. It is not
inherited from the runner environment; other `PI_*` overrides remain rejected
unless separately allowed. This flag enables existing application logging, not
a general environment or shell escape. Prompt dumps can contain project context
and must remain in the task's private evidence storage.
TUI targets may use their ordinary explicit project and
session arguments to open deterministic state inside the real PTY before
assertions. Because PTY input and application rendering are asynchronous, TUI
flows wait for the expected text or a stable frame after input before asserting
the resulting screen. PTY flows may send printable text as a bracketed paste
with `sendPaste` before a separate Enter key when the target supports bracketed
paste; the runner rejects the action unless the target enabled bracketed paste
mode. This prevents a bulk text write and immediate Enter from merging into
one unbracketed multiline paste. Visible-text assertions include prompt/editor
echo, so response assertions require an observable marker absent from the input.
Repeated unnamed Desktop evidence steps receive collision-free filenames based
on their action and step index, while explicit names remain available for stable
human-readable labels.

Profile merge semantics are unchanged: model-only overrides retain the body,
task prompt additions follow it, and a task `promptOverride` still receives
the profile's appended instructions. Explicit profile `promptAppend` can
replace the inherited body. Prompts are guidance, not immutable enforcement;
origin/auth/path/evidence checks continue to be implemented by the runner.

## Preserved contracts

- Pix Desktop's project workflow uses an isolated runner-owned launch of a
  pinned successful `watch:all` artifact for ordinary UI QA. This is a
  project-script contract, not a new generic backend or a reason to restart
  the parent's working Desktop. See `wiki/development/testing/desktop-qa-isolated-launch.md`.

- macOS window-wait failures retain the last application/window lookup error,
  including the matched application identity when available, rather than hiding
  selection failures behind a generic timeout. This diagnostic is not UI proof.
  When a launched process group has multiple application candidates, macOS
  selects the unique accessible-window owner, excluding windowless wrappers.
  Multiple window owners remain ambiguous; explicit app selectors are unchanged.

- Only the unified/trusted runners own browser execution and credential
  handling; the QA child never invokes Playwright or `chrome-devtools`
  directly for probe/run.
- Native/TUI QA exercises the actual shipping UI through a deterministic
  presentation selected by required capabilities, never by project identity.
  New role-authored flows explicitly use PTY/headless ANSI presentation for
  line-oriented/plain-terminal or protocol-focused targets, and use native-
  terminal presentation by default for structured/full-screen TUIs. The runner
  keeps omitted presentation as PTY only for backward compatibility. Native-
  terminal still controls one
  runner-owned PTY target and uses that same PTY for deterministic text/cursor/
  process oracles, but mirrors its exact byte stream through a private trusted
  bridge into a fresh owned terminal window whose real pixels are captured. No
  target argv/cwd/env is embedded into that terminal bootstrap. Native host
  providers are environment-selected, never project-selected: macOS prefers
  installed iTerm2 then Terminal.app; Windows uses Windows Terminal; Linux
  prefers kitty, then Alacritty, GNOME Terminal, Konsole, and xterm. Availability
  additionally requires the platform desktop driver to correlate/capture the
  real terminal window. If exact visual terminal evidence is required and that
  capability is unavailable, the result is `BLOCKED`; a headless replay cannot
  substitute for pixel evidence.
- Desktop QA discovers the documented launch contract, including any frontend
  server needed by a development binary. Native window discovery is not UI
  readiness: the agent must wait for and assert an application-content marker
  before checking the requested behavior. A title-only runner pass cannot be
  reported as product verification. Blank/unloaded content and rendered content
  with an empty accessibility tree are distinguished using retained screenshot
  and accessibility evidence; missing launch prerequisites are `BLOCKED`.
  Window discovery for a runner-owned launch defaults to 60 seconds and accepts
  an explicit `waitForWindow.timeoutMs` up to 90000, clamped to the remaining
  runner deadline. Other desktop steps retain the 30000 ms maximum and short
  default; the whole-run maximum stays 100000 ms. On a window timeout the agent
  inspects `application.log` and distinguishes an unfinished build, an exited
  launcher, and an available process without a window. Builds exceeding the
  bounded startup budget are handed to the parent as a prerequisite rather than
  treated as missing UI capabilities or retried with the same short wait.
- The actual requested target is tested; static checks or invented mock pages
  cannot substitute for requested UI QA.
- Public QA does not require credentials or create an auth file.
- Auth scaffolding uses discovered public selectors and secret placeholders;
  agents never read/edit the credential file. Auth paths stay private and
  fail closed on invalid permissions, symlinks, or non-empty replacement.
- Deterministic assertions, screenshot inspection, automatic bounded video
  evidence, redacted statuses, artifact links, bounded execution, and
  agent-local cleanup are preserved.
- A blocked preflight/run always exposes the parent-ready `blockedHandoff` and a
  non-empty remediation string. The QA child relays those fields and stops; it
  does not install automation dependencies, grant OS permissions, or invent a
  different fallback surface.

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/chrome-devtools/chrome-devtools-provider.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/native-terminal-host.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/bridge-client.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/release-helper.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/windows/windows-uia.ps1`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/linux/linux-atspi.py`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/core/ui-qa.ts`
- `external/pi-tools-suite/test/async-subagents/core.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-tui-environment.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-macos-helper-cache.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-macos-helper-cache-storage.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-macos-release-helper.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-desktop.e2e.test.ts`

## Verification

Core regression tests cover the thin body size and router contract, absence of
backend-specific sections from the start prompt, presence of every guide file
in the package/sync payload without new discoverable roles, body inheritance,
the legacy name migration, short parent catalogs, prompt delivery over child
RPC without skills, global child skill isolation and skill-flag stripping,
ordinary-child env cleanup, both UI-QA workspaces, and invoking both installed
runner paths from a temporary project with spaces.
Unified runner tests cover backend selection, the read-only allowlisted
`guide` command (exact base/detail document output, backend-scoped topic
isolation including explicit-only auth, strict rejection of unknown/cross-
backend topics/options/extra args/traversal, and operation from arbitrary cwd
including paths with spaces), authoritative `selection.guide` routing, real
PTY behavior
and bounded asciicast evidence, unsafe launch and path rejection, timeout
bounds, platform blockers, cross-platform native-terminal provider selection,
and static/protocol contracts for the bundled Windows UIA and Linux AT-SPI
helpers. An opt-in real macOS AppKit accessibility flow covers the currently
available host E2E with automatic exact-window video; a separate opt-in macOS
regression waits for a late GUI descendant in the wrapper's group without
requiring Screen Recording. Windows/Linux real-host
smokes remain platform-host verification rather than being inferred from tests
executed on macOS. Browser runner tests continue covering the trusted
credential-owning backend.

Live QA/model behavior must be verified separately from deterministic tests;
loading instructions through a second `guide` step changes their presentation.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"f061c4de-d66a-4d75-9c7e-aef1d8e78d55","contentHash":"a3127f293a14ad3e132a94e6cbfd10d943abea27190c76dacc16471a5dbf5b69","checkedAt":"2026-10-31T02:04:49.161Z","maxDocumentChars":128000} -->
