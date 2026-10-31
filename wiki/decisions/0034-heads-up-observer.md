<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T01:29:23.792Z","result":{"path":"wiki/decisions/0034-heads-up-observer.md","documentHash":"addd6cfc95f4f88f628b1b544698e98ca8d007a4c97532e45fd1ca44bc6d0e01","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[{"draft":{"path":"wiki/decisions/0034-heads-up-observer.md","quote":"the user requested friendlier Observer output after approving\nthe Telescope icon (Eye is reserved for the agent; Radar was rejected)","startLine":96,"endLine":97},"existing":{"path":"wiki/decisions/0034-heads-up-observer.md","quote":"Status: accepted; supersedes runtime-only Desktop enablement above, not TUI\nenablement or profile-default propagation. User approval is in this conversation:\nicon-only eye, grey off / primary enabled / flicker during work","startLine":144,"endLine":146},"explanation":"Не хватает информации о том, какая запись определяет текущий значок статуса: раздел «presentation follow-up» утверждает, что иконка Eye зарезервирована для агента и выбран Telescope, а более поздний раздел «compact controls and persistence» предписывает icon-only eye. В более позднем разделе указано только, что он заменяет runtime-only enablement, а не выбор иконки. Нужен явный статус замены (supersession) решения об иконке, чтобы решить, совместимы ли эти утверждения."}],"reviewedSources":[{"path":"wiki/assistants/observer/heads-up-observer.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Heads up observer (experimental, opt-in)\n\nRationale and alternatives: [0034 — Bounded, opt-in Heads up observer](../../decisions/0034-heads-up-observer.md).\n\n## Behavior\n\nPix offers an optional passive observer of a coding conversation. It looks for\nup to three independent concrete, consequential, probably unnoticed contradictions or tradeoffs in\nthe current task. It is not a code reviewer or an enforcement mechanism: it\ncannot inspect files independently and must not claim facts absent from its\ninput. The normal result is no notice.\n\nThe implementation uses one provider-neutral registry inference, not a child\nagent, forked agent session, subprocess harness or tool loop. The request has\nno tools, tool choice `none`, low reasoning, zero retries and no implicit model\nfallback. The initial model reference is `openai-codex/gpt-6-luna`, a candidate\nfor evaluation rather than a measured quality winner. Missing credentials or\nmodel availability is reported as a controlled status, never replaced silently\nwith the parent model. Ordinary work in the parent is never awaited or resumed\nby an observer result.\n\nIt is off by default. `/heads-up on` enables the current runtime/session;\n`/heads-up off` cancels work. `/heads-up check` explicitly checks an enabled\nobserver, and `/heads-up status` shows phase, model and recorded counters.\n`/heads-up model provider/model-id` chooses its model without changing the main\nagent. Commands are registered extension commands; ACP executes them out of\nband without taking over the active parent run.\n\nTUI configuration is read from the agent directory's `heads-up.jsonc`, followed\nby a trusted working directory's `.pi/heads-up.jsonc`. Desktop instead reads the\n`headsUp` object in `~/.config/pi/pix-desktop.jsonc`, followed by the same object\nin a trusted working directory's `.pi/pix-desktop.jsonc`. Desktop never inherits\nstandalone `heads-up.jsonc` or TUI `pix.jsonc`; no automatic migration is made.\nInvalid JSONC and oversized files are ignored. Standalone files are bounded at\n16 KiB; a complete Desktop profile may be up to 1 MiB. Comments and trailing\ncommas are accepted. `enabled: true` explicitly opts new/reloaded runtimes in;\n`model` is a provider/model reference and numeric settings are clamped.\n\nDesktop Settings → Observer edits these saved defaults using the existing\nconflict-checked JSONC save flow, preserving unrelated keys and comments. It\n","startLine":1,"endLine":47},{"path":"wiki/configuration/model-selector-fallbacks.md","quote":"- The async-subagent router uses `model` + `fallbackModels`. Agent profiles using the modern `models` field already encode the whole ordered candidate chain in one array. Legacy `model` and each normalized `modelByParent` entry always resolve with `fallbackModels`, defaulting to `[]`.\n- Public JSONC schemas keep fallback arrays optional for backward compatibility with existing files. Loaders normalize an omitted fallback field to `[]` whenever the corresponding resolved selector exists.\n- Default config files explicitly write fallback arrays so newly created configs document the invariant.\n- Save/upsert operations that change a primary selector preserve its existing fallback array, or create `[]` when none exists.\n- Desktop Settings model controls use the shared fuzzy matcher rather than native select substring/type-ahead behavior. Primary selectors, fallback replacement and add controls, Git review/commit selectors (including thinking suffixes), and the visible-model chooser match and rank against model ref, model id, display name, and provider. Existing configured refs that are absent from the live catalog remain representable and searchable.\n\n## Execution contract\n\n- Helper workflows that advertise a fallback chain try candidates in order and de-duplicate repeated refs.\n- Pix default-model fallbacks apply only to brand-new sessions. An explicit runtime model and a model restored from session history remain strict user/session choices and do not silently fall through to configured defaults.\n- A fallback model without an explicit thinking suffix inherits the configured default-model thinking level; an explicit fallback suffix wins.\n- Autocomplete, prompt enhancement, Desktop/TUI Git helpers, lookup, session-title generation, DCP summaries, and async-subagent routing use their configured candidate chains rather than storing unused fallback metadata.\n- Cancellation/abort remains terminal and must not be converted into a fallback attempt.\n\n## Compatibility\n\n","startLine":39,"endLine":54},{"path":"wiki/configuration/guide.md","quote":"The setting covers model explanations, uncertainty prose, report labels and\nchecker-owned diagnostics. Quotations stay verbatim in their original language;\nfile paths, source IDs and JSON keys also remain unchanged. Unknown native or\nprovider diagnostic messages retain their original text. It does not change\nthe judge model or reasoning effort.\n\nSee [Wiki contradiction checks](../desktop/workbench/desktop-project-wiki.md#contradiction-checks).\n\n### Desktop Observer defaults\n\n**Settings → Desktop → Observer** edits the `headsUp` object in the Desktop\nprofile. For example:\n\n```jsonc\n{\n  \"headsUp\": {\n    \"enabled\": false,\n    \"model\": \"\u003cprovider\u003e/\u003cfast-model\u003e\",\n    \"minTurns\": 6,\n    \"minIntervalMs\": 60000,\n    \"maxChecksPerHour\": 12\n  }\n}\n```\n\nAdditional fields are `maxInputChars`, `maxInputCharsPerHour`, `maxTokens`,\n`timeoutMs` and `noticeTtlMs`. The settings UI shows time in seconds and saves\nmilliseconds. Model refs and numeric bounds are validated; fields can reset to\ndefaults. These settings apply to new or reloaded Desktop runtimes. The\nstatusbar popup's switch saves a per-session choice, restored after app restart,\nwithout changing configuration or other sessions. An explicit saved choice takes\nprecedence over the enable default; all other observer settings still use the\nprofile. A trusted project `.pi/pix-desktop.jsonc` can override defaults.\nDesktop does not inherit `heads-up.jsonc`; that remains the TUI observer config.\nEnabling an observer sends bounded conversation excerpts to its chosen provider.\n\n## pi-tools-suite configuration\n\nThe bundled suite loads:\n\n1. `~/.config/pi/pi-tools-suite.jsonc`;\n2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;\n3. the nearest project `.pi/pi-tools-suite.jsonc`.\n\nLater files override earlier files.\n\nDisable individual modules with `disabledModules` or\n`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with\n`PI_TOOLS_SUITE_DISABLED=1`.\n\nTo hide selected bundled async-subagent roles without disabling the sub-agent\nmodule, use `disabledBuiltinAgents`. A later config layer can re-enable inherited\nnames with `enabledBuiltinAgents`. These keys affect bundled roles only;\nsame-named project roles in `.pi/agents/*.md` remain available.\nDesktop exposes the user-level `disabledBuiltinAgents` list under\n","startLine":345,"endLine":399},{"path":"wiki/work-management/registry/resource-registry-publication-tags.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Registry publication scope and tags\n\n## Behavior\n\n- Skills and agents share the same publication model. **Local** means a project\n  copy not published in the configured Git registry. **Published** means published\n  in that shared registry, whether or not installed in this project. Publication is\n  not a machine-wide automatically loaded resource: other projects explicitly\n  install it. Project artifacts remain in the separate project-sync section.\n- Desktop displays **Installed** (all project copies, published or not) and\n  **Available** (remote copies absent locally) tabs. Cards independently show\n  publication and synchronization/conflict state through icons and accessible\n  labels/tooltips: Local only, Published · Project, or Published · Global.\n- Catalog entries show a colored skill/agent icon and name; description;\n  an optional separate tag-chip row (three visible tags plus an overflow count);\n  then status/publication icons on the left with action buttons on the right.\n  Missing descriptions still reserve the second row; long text truncates with\n  full-value tooltips. Entries are separated by\n  spacing, not colored divider lines. Project-sync rows are unchanged.\n- Resource cards keep at most two direct commands: the routine Install / Update /\n  Push / Pull action, plus Compare when a two-sided diff is available. Other\n  commands are in a labeled **More actions** (`⋮`) menu, with an icon beside each label: alternate conflict\n  resolution, tags, Global/Project visibility, unpublication and deletion.\n  Synced/context-only rows can therefore show only `⋮`. Menu commands retain\n  existing busy/setup guards and confirmations; a missing project key disables\n  **Make project** with a setup hint. The menu is not clipped by the catalog's\n  scrolling container, flips/clamps within the viewport, and dismisses on outside\n  interaction, catalog scroll, resize, refreshed items or changed availability.\n  Keyboard traversal uses the shared menu contract; Escape and Tab return focus\n  to the invoker (Tab then proceeds normally). Pending open/focus work is canceled\n  by dismissal or teardown.\n- Skills exposed by the ready active session's skill commands are marked\n  **In context** and included in Installed even without a project copy (for\n  example, globally loaded skills). Matching uses exact skill names and the\n  command source, not descriptions or ordinary same-named commands. These\n  skills offer no Install or missing-copy Update / Make local action. Updates\n  to an existing project copy remain available. Context availability never\n  implies project ownership: tags, uninstall and diff still require a local\n  project copy. Switching sessions, reload or loss of readiness recomputes the\n  marks; without a ready session the ordinary Registry catalog is unchanged.\n- Session-only skills with neither a project copy nor a Registry publication\n  carry an **External** badge beside their name, with the tooltip\n  **Available to the active session; not managed by Registry.** They retain\n  **In context** as their availability status, but have no Registry actions or\n  publication icon. Project copies and Registry publications do not carry this\n  badge.\n- Registry is Desktop-only. ACP handles filesystem/Git operations directly,\n  without loading tools-suite, starting a Pi runtime, or creating a session.\n  There is no `/registry` command or TUI Registry UI.\n- Newly discovered Local-only project skills and agents are saved automatically\n  to the Project registry namespace through background `sync-project`. This\n  requires a configured registry and project key. Full skill trees and agent\n  companions are retained; globally/context-loaded skills without project copies\n  are never published automatically. Existing published edits and unsafe states\n  (untracked collisions, diverged, registry-changed or removed-remote) are not\n  targets of this new-resource saving operation. Separately, Desktop debounces\n  automatic pushes of installed Project publications with `local-changes`,\n  including later body/asset edits. Global publications remain manual; unsafe\n  states are skipped. Background work is serialized with foreground Registry\n  actions, and obsolete workspace completions cannot update current state.\n- **Save to project registry** explicitly publishes an unpublished project copy\n  in the Project namespace. Pushes to existing publications retain their scope.\n  Existing collision/conflict protection applies.\n- The Registry Activity Bar local-changes menu offers **Sync project changes to\n  Registry** ([decision 0027](../../decisions/0027-sidebar-reason-actions.md)).\n  One workspace-scoped `push-project-resources` action freshly selects installed\n  skills/agents with `local-changes` and Project publication scope. Global/legacy\n  Global publications, unchanged resources, unpublished copies, unsafe/conflicted\n  states and project artifacts are untouched. Pushes run sequentially under the\n  checkout lock with existing revision/provenance guards and no overwrite dialog.\n  Failure stops the batch, reports the error and retains prior successful pushes;\n  retry selects only remaining eligible edits. It does not open a sidebar panel.\n- Published resources have a **Make project** / **Make global** visibility\n  toggle. Global definitions live in `skills/\u003cname\u003e` or `agents/\u003cname\u003e.md`;\n  Project definitions live in `projects/\u003cprojectKey\u003e/skills/\u003cname\u003e` or\n  `projects/\u003cprojectKey\u003e/agents/\u003cname\u003e.md`, including same-named agent companions.\n  Project definitions appear only for the matching project key; Global remains\n  visible everywhere. Initial publication is Project-scoped; Global requires\n  the visibility toggle.\n  The toggle requires a project key and confirmation, moves published bytes in\n  one Git commit/push, and never changes or republishes local copies/edits.\n  Provenance moves with the publication while retaining the local baseline and\n  any pending remote update. Legacy provenance without a scope means Global.\n- Global/Project name collisions are refused rather than shadowed or overwritten.\n  Global promotion and a new Global publication also refuse a same-named\n  definition in another project. Scoped install/update/push, diff, tags and\n  unpublication target only the visible namespace. A scope/key change during\n  asynchronous tag editing saves local tags but refuses automatic publication.\n- Make local confirms unpublication. It installs a copy first if absent, then\n  removes the shared definition and companions, retaining this project's copy\n  and copies already installed in other projects. An existing modified local\n  copy is not overwritten. Failed installation, an existing skill copy missing\n","startLine":1,"endLine":97},{"path":"wiki/configuration/model-visibility-whitelist.md","quote":"# Model visibility whitelist\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nGive Pix TUI and Desktop user-controlled model-picker whitelists while keeping the underlying runtime/ACP catalogs complete and keeping each frontend's preference storage independent.\n\n## Scope\n\n- `visibleModels` in TUI user `~/.config/pi/pix.jsonc` and Desktop user `~/.config/pi/pix-desktop.jsonc`.\n- The TUI combined model/thinking picker.\n- The Desktop combined model/thinking picker.\n- The temporary Desktop BTW side chat uses that same picker and preference.\n- Model-picker filtering only; session scope and model availability remain separate concepts.\n\n## Behavior\n\n- `visibleModels` is an optional array of exact `provider/model` refs. When omitted, the corresponding Pix frontend shows every model in its complete available catalog.\n- An explicit whitelist, including `[]`, is authoritative for picker visibility. The current active model is always kept visible so the picker cannot enter an invalid current-selection state.\n- The preference is user-level but not shared across TUI and Desktop. TUI persists to `pix.jsonc`; Desktop persists to `pix-desktop.jsonc`. Project profile files do not override the corresponding picker whitelist.\n- TUI builds its picker from the complete `ModelRuntime.getAvailableSnapshot()` rather than `session.scopedModels`; `enabledModels` continues to control SDK session scope/cycling but not picker visibility.\n- TUI `Shift+Tab` toggles `Manage visible models`. Management mode exposes hidden models, `Enter`/mouse click toggles the highlighted model, and the current model cannot be hidden. A clickable `Clear all` action saves `visibleModels: []`, hiding every non-current model. Edits are persisted immediately.\n- Desktop exposes a `Manage` mode in the same model/thinking dialog. It shows the complete ACP model option catalog with visibility checkmarks, saves changes immediately to the Desktop profile's `visibleModels` key, and prevents hiding the current model. `Clear all` saves an empty whitelist; the current model remains visible only through the current-model safety rule. `Shift+Tab` also toggles the mode while focus is in model search.\n- Desktop visibility saves use a compare-and-swap user-config write and retry against the newest document when another Desktop config writer wins the race. The picker may be closed while a visibility save is in flight; reopening waits for that save before reading the whitelist so an older read cannot reopen stale picker state.\n- Normal model selection never removes entries from the runtime or ACP model catalog; the whitelist is a presentation filter only.\n- BTW shares the Desktop whitelist and Manage writes, but keeps its selected\n  model/effort in memory independently of the parent. Each picker preserves its\n  own current-model exception; an empty whitelist therefore shows the parent\n  model in the statusbar picker and the side model in BTW. Auto and parent\n  defaults are not exposed by BTW. See [the BTW contract](../desktop/conversations/desktop-btw.md).\n- The project Tasks editor reuses the same Desktop combined model/thinking\n  picker and its `visibleModels` preference for an **optional per-task**\n  model/effort override. It can show the full ACP catalog in Manage mode and\n  keeps the currently assigned task model visible even when outside the\n  whitelist. Applying a selection only updates the task editor draft; it\n  never mutates a live ACP session or Desktop-wide model defaults. A matching\n  staged model+effort still writes the task override instead of treating Apply\n  as a no-op; clearing the selection restores normal session defaults.\n\n## Related files\n\n- `src/config.ts`\n- `src/default-pix-config.ts`\n- `src/schemas/pix-schema.ts`\n- `src/schemas/pix-desktop-schema.ts`\n- `schemas/pix.json`\n- `src/app/popup/menu-items-controller.ts`\n- `src/app/popup/popup-menu-controller.ts`\n- `src/app/popup/popup-action-controller.ts`\n- `src/app/rendering/popup-menu-renderer.ts`\n- `src/app/input/input-controller.ts`\n- `desktop/src/app/model-preferences.svelte.ts`\n- `desktop/src/app/desktop-overlays-view-model.svelte.ts`\n- `desktop/src/components/ModelThinkingPicker.svelte`\n- `desktop/src/components/WorkspaceSidebarTaskModelControl.svelte`\n- `desktop/src/lib/model-visibility.ts`\n\n## Verification\n\n- Root config tests cover normalization, persistence, explicit empty whitelists, and project-override suppression.\n- TUI menu tests cover full-catalog behavior under an explicit session scope and normal-vs-management whitelist filtering.\n- TUI popup/input tests cover the visibility mode and `Shift+Tab` routing.\n- Desktop unit tests cover JSONC whitelist parsing/updating; `svelte-check` covers the picker integration.\n\n\n","startLine":1,"endLine":74},{"path":"wiki/decisions/0066-native-repository-semantic-search.md","quote":"\n- Extend the shared history vector database: avoids a third file, but requires changing\n  existing writers/schema guards and coordinating their lifecycle; defer that migration.\n- Reuse another product's vector database directly: avoids duplicate embeddings but couples native\n  storage to that product's internals and risks existing paid data.\n- A persistent background indexer: improves large-repository coverage latency, but adds\n  consent, scheduling, process ownership and cost-control lifecycles beyond this request.\n\n## Consequences\n\nUsers may pay to embed repository content again; no claim of vector reuse is made.\nLarge projects need multiple explicit searches to reach full scoped coverage. Retaining old\nvectors consumes bounded disk space; exhaustion degrades visibly rather than erasing data.\nCurrent provider quality, cold latency and real semantic recall remain unverified without\nseparate permission for live provider evaluation. No structural/knowledge-review parity is implied.\n\n## Revisit when\n\nMeasured coverage/latency requires background indexing; cache caps are routinely reached;\nprovider compatibility expands; or a reviewed common vector-writer lifecycle permits safe\nconsolidation without paid-vector loss.\n\n\n","startLine":43,"endLine":65},{"path":"wiki/decisions/index.md","quote":"\n# Decision records\n\nWhy consequential choices were made. Status and replacement metadata govern each record; accepted does not mean every historical detail is the current contract. Numeric prefixes and existing duplicate numbers are preserved.\n\n[Wiki home](../index.md)\n\n## Pages\n\n- [0001 — Separate default, core and mechanical subagent coding](0001-subagent-coding-roles.md) — superseded\n- [0002 — Agent-owned decision history](0002-agent-owned-decision-history.md) — accepted\n- [0003 — Reveal Desktop after the initial document loads](0003-desktop-startup-reveal.md) — accepted\n- [0004 — External TUI incident profiling](0004-external-tui-incident-profiling.md) — accepted\n- [0005 — Disk-saving native watch builds](0005-watch-all-cargo-disk.md) — accepted\n- [0006 — Embedded opt-in TUI incident trace](0006-embedded-tui-incident-trace.md) — accepted\n- [0007 — Native spelling corrections in the macOS composer](0007-native-composer-spelling.md) — accepted\n- [0008 — Configured brainstorm council instead of a local skill](0008-configured-brainstorm-council.md) — superseded\n- [0009 — Five-round brainstorm with reviewed synthesis](0009-five-round-brainstorm.md) — accepted\n- [0010 — Audit scenario and transparent parent routing](0010-audit-council-modes.md) — accepted\n- [0011 — Read-only council research capabilities](0011-council-research-tools.md) — accepted\n- [0012 — Isolate suite module loading](0012-isolate-suite-module-loading.md) — accepted\n- [0013 — Conservative composer action inference](0013-composer-action-inference.md) — accepted\n- [0014 — Transactional conversation workspace rebinding](0014-conversation-workspace-rebinding.md) — superseded\n- [0015 — Canonical disposable harness output](0015-harness-artifact-storage.md) — accepted\n- [0016 — Native notification activation routing](0016-native-notification-activation.md) — accepted\n- [0016 — Retain Markdown image DOM during streaming](0016-streaming-image-dom-retention.md) — accepted\n- [0017 — Brainstorm v4: local protocol storage, quorum and ledger history](0017-brainstorm-v4-protocol-storage.md) — accepted\n- [0018 — Identity-only Desktop message actions](0018-desktop-message-action-identity.md) — accepted\n- [0019 — Desktop councils own persistent participant sessions](0019-desktop-persistent-council-sessions.md) — accepted\n- [0020 — Recover interrupted questions from the transcript](0020-question-transcript-recovery.md) — accepted\n- [0021 — Transparent workspace handoff](0021-transparent-workspace-handoff.md) — superseded\n- [0022 — Run-only council roster and effort](0022-brainstorm-run-roster.md) — accepted\n- [0023 — Remove workspace tool](0023-remove-workspace-tool.md) — accepted\n- [0024 — Native Desktop close warnings](0024-desktop-close-warning.md) — accepted\n- [0025 — Sparse read-only sidebar health](0025-sidebar-health-polling.md) — accepted\n- [0026 — Cross-instance Project Explorer clipboard](0026-cross-instance-file-clipboard.md) — accepted\n- [0026 — Pause-ready adopted continuations](0026-pause-ready-adopted-continuations.md) — accepted\n- [0027 — Cause-specific sidebar quick actions](0027-sidebar-reason-actions.md) — accepted\n- [0028 — Native Project Explorer context menu](0028-native-explorer-context-menu.md) — accepted\n- [0028 — Scoped file-operation reservations](0028-scoped-file-operation-reservations.md) — accepted\n- [0029 — Current-display-first window tiling](0029-window-tiling.md) — accepted\n- [0030 — Default-on suite codemode alongside direct tools](0030-suite-codemode.md) — accepted\n- [0031 — Single-channel subagent completion delivery](0031-subagent-completion-delivery.md) — superseded\n- [0032 — Per-conversation Desktop reading positions](0032-conversation-reading-position.md) — accepted\n- [0033 — Assistant prompt hygiene](0033-assistant-prompt-hygiene.md) — accepted\n- [0034 — Bounded, opt-in Heads up observer](0034-heads-up-observer.md) — accepted for an opt-in experiment, not general rollout\n- [0035 — Background queued forks](0035-background-queued-forks.md) — accepted\n- [0036 — Inactive-only native hover forwarding](0036-inactive-window-hover.md) — superseded\n- [0037 — Status-bar hover details](0037-status-bar-hover-details.md) — superseded for popup activation/retention/dismissal; content and chrome choices remain accepted\n- [0038 — Focus on hover](0038-focus-on-hover.md) — superseded\n- [0039 — Compact quota reset calendar](0039-quota-reset-calendar.md) — accepted\n- [0040 — Gap-free window tiling](0040-gap-free-window-tiling.md) — accepted\n- [0041 — Distinguish SDK raw fallback from DCP provider usage](0041-dcp-sdk-fallback-provenance.md) — accepted\n- [0042 — Native file actions for Preview and media](0042-preview-file-context-actions.md) — accepted\n- [0043 — Preserve subagent evidence on session shutdown](0043-subagent-evidence-retention.md) — accepted\n- [0044 — Retractable parent completion delivery](0044-retractable-subagent-completions.md) — accepted\n- [0045 — Remove hover focus](0045-remove-hover-focus.md) — accepted\n- [0046 — Task-scoped knowledge audit completion](0046-task-scoped-knowledge-completion.md) — superseded by [0067](0067-final-documentation-maintenance.md)\n- [0047 — Remove the Desktop Session inspector](0047-remove-session-inspector.md) — accepted\n- [0048 — Status-bar click popups](0048-status-bar-click-popups.md) — accepted\n- [0049 — Nonmodal model picker](0049-nonmodal-model-picker.md) — accepted\n- [0051 — Read-only Claude reset grants](0051-claude-reset-grants.md) — accepted\n- [0052 — Owned LSP control in Desktop and TUI](0052-owned-lsp-control.md) — superseded\n- [0053 — Repository-only commit author in Source Control](0053-repository-commit-author.md) — accepted\n- [0054 — Project-shared LSP ownership](0054-project-shared-lsp.md) — accepted\n- [0055 — Temporary, isolated BTW side chat](0055-temporary-btw-side-chat.md) — accepted\n- [0056 — Monitoring-only LSP panels](0056-lsp-monitoring.md) — accepted\n- [0057 — Canonical LSP reuse and bounded idle retention](0057-lsp-reuse-idle-cleanup.md) — accepted\n- [0058 — Reverse navigation into Files](0058-reverse-file-navigation.md) — accepted\n- [0059 — Private todos for every subagent role](0059-subagent-private-todos.md) — accepted\n- [0060 — Read-only repository queries for every subagent](0060-subagent-read-only-repo-tools.md) — accepted\n- [0061 — Scoped AST and public web tools for subagents](0061-subagent-scoped-ast-web-tools.md) — accepted\n- [0062 — Accessibility-gated macOS dictation-key interception](0062-macos-dictation-key.md) — accepted\n- [0063 — Kernel-owned cross-process task-file exclusion](0063-task-file-kernel-lock.md) — superseded (historical; not implemented by the current task store)\n- [0064 — SQLite-only project tasks with restricted mutations](0064-sqlite-project-tasks.md) — accepted\n- [0065 — Shared local repository search with a separate disposable file index](0065-native-repository-search.md) — superseded\n- [0066 — Consent-gated native repository embeddings without a history-index migration](0066-native-repository-semantic-search.md) — accepted\n- [0067 — Final documentation maintenance without knowledge-state gates](0067-final-documentation-maintenance.md) — accepted\n","startLine":1,"endLine":78},{"path":"wiki/decisions/0049-nonmodal-model-picker.md","quote":"# 0049 — Nonmodal model picker\n\n- Status: accepted\n- Recorded: 2026-10-05\n- Decided: 2026-10-05\n- Owner / approval evidence: user explicitly requested Model selection become a\n  popup like the other status-bar controls (conversation-only evidence).\n- Governing spec: [Desktop model picker popup](../configuration/desktop-model-picker-popup.md)\n- Replaces: the Model + Thinking modal exception in\n  [Desktop modal dialogs](../desktop/workbench/desktop-modal-dialogs.md); extends\n  [0048 — Status-bar click popups](0048-status-bar-click-popups.md).\n\n## Context\n\nStatus-bar details already use click-toggled nonmodal surfaces. Model + Thinking\nstill opened a blocking fullscreen native modal, contrary to the user's newly\nrequested consistency.\n\n## Observations and sources\n\nThe old component called `activateModalDialog` and used a fullscreen backdrop.\nIts search, staged Apply, default saving and visibility-management logic are\nindependent of modality. Native UI verification is not implied by these source\nobservations.\n\n## Decision\n\nUse a bounded native nonmodal dialog above the model button, retaining search\nand all configuration semantics. Dismiss with repeat activation, Escape, outside\ninteraction or focus leaving its region. Escape/Cancel restore trigger focus;\nsuccessful Apply restores composer focus; outside dismissal preserves the\ndestination. Guard cancelled opening requests and late Apply completion.\n\n## Alternatives\n\n- Keep the modal: conflicts with the explicit consistency request.\n- Immediately apply each row click: would change staged selection semantics,\n  which the user did not request.\n- Mount the entire selector inside the shared small details component: would\n  entangle session-owned async configuration state with a local details toggle.\n  Keep existing ownership and extract popup lifecycle/positioning instead.\n\n## Consequences\n\nThe workbench remains interactive. Dismissal no longer implies composer focus\nrestoration and does not abort already-submitted configuration requests.\nNonmodal access makes stale completions more exposed, so ownership guards and\ndeterministic lifecycle tests are required. Other modal dialogs are unchanged.\n\n## Revisit when\n\nNative keyboard or narrow-window testing reveals clipped controls, unwanted\nfocus restoration, or interaction conflicts with other status popups.\n\n\n","startLine":1,"endLine":55},{"path":"wiki/decisions/0052-owned-lsp-control.md","quote":"  directly exercises owner hard-kill with a stubborn descendant on POSIX.\n- [Trust](../operations/lsp-trust.md) protects project-local configuration; global\n  configuration is user-owned. Status must not turn that gate into an execution\n  side effect.\n- User requirements above are conversation-only evidence, not a separate\n  durable approval artifact. Assumption/limit: supported LSPs communicate over\n  stdio and do not intentionally daemonize out of the owned process group.\n\n## Decision\n\nKeep edit-triggered lazy startup. Share status/start/stop/restart/trust controls\nbetween a Desktop sidebar and `/lsp` TUI custom component. Stop suppresses lazy\nrestart until explicit Start/Restart. Trust is a separate no-spawn action.\n\nKeep session-owned root/control records separate from live processes: idle\ncleanup preserves failed errors and manual Stop, whereas session replacement\nresets them. Retained nested roots are revalidated against trusted configuration\nbefore Start/Restart; Stop alone cannot register an unknown root. This avoids\nstranding a lazily discovered nested server after stopping it.\n\nOn POSIX, run each server under a detached Node supervisor with the server and\nordinary descendants in that group. Use the LSP input pipe itself as owner\nliveness: EOF sweeps the group even after Pi is force-killed. Use a separate\ndescriptor only for actual server PID metadata, not liveness. Windows retains\nnormal taskkill process-tree cleanup; macOS is the only Desktop target.\n\nUse ACP/private correlated command transport rather than a model tool or user\nconversation message. Emit snapshots through the SDK session event stream:\nits RPC output guard redirects ordinary stdout writes to stderr, so a direct\nwrite loses the snapshot even though the command acknowledgement succeeds.\nTUI trust dismisses the panel before opening the normal trust dialog to avoid\ncompeting custom-UI ownership.\n\n## Alternatives\n\n- Exit hooks only: insufficient for native force-kill or parent crashes.\n- Put servers directly in the adapter group: does not supply the same standalone\n  TUI ownership mechanism and loses independent graceful control boundaries.\n- Separate liveness descriptor: rejected after unstable Bun proxy experiments;\n  stdio input EOF is the chosen ownership channel. No general runtime benchmark\n  claim follows from those experiments.\n- Eager/shared daemon or kill-all-by-name: violates lazy startup and risks\n  unrelated IDE processes.\n- Independent Desktop/TUI managers: duplicates trust/lifecycle policy.\n\n## Consequences\n\n","startLine":30,"endLine":76},{"path":"wiki/decisions/0072-session-native-subagents.md","quote":"  (`~/.pi/agent/sessions/\u003ccwd\u003e/subagents/\u003cparent stem\u003e/`): hidden from resume\n  lists too, but needs usage-stats and ACP special cases, ages outside the\n  project, and owned-launch records would need a separate global root;\n  replaced by the project-local layout.\n- Owned-launch state in `/tmp`: does not survive restart, breaking\n  reconciliation; rejected.\n- Migrating old run trees: the user chose no migration.\n\n## Consequences\n\n- No project-local run directories or sidecars for new runs; one lifecycle\n  source per child (its session) plus the parent's index.\n- TUI, ACP and Desktop use the shared session-native read model. Legacy run\n  directories are ignored by new readers and are not migrated.\n- Risk: a child that crashes before its first user message leaves no session\n  file; the parent session index must carry enough to report it.\n- Child history lives with the project: moving or deleting the project, or\n  manual Clean, removes it except protected owned-launch records; parent\n  references must then show the child as removed instead of failing.\n- Headless calls with a stable host session key use a deterministic UUID scope\n   and append-only `.pi/subagents/\u003cscope\u003e/headless-parent.jsonl` journal, so\n   separate calls can recover the parent index. Without a key, parent state is\n   process-local and is not recoverable by a later headless process. Journal\n   read errors and journals over 32 MiB fail closed with a redacted diagnostic;\n   they are not silently treated as empty state. Headless cold `send`, like\n   `spawn`, uses a detached broker to retain process ownership through the final\n   completion receipt. Interactive `/sub-open` refuses nonterminal children to\n   preserve the single-writer transcript contract. Planned and retry-pending\n   records may include an optional runtime `ownerPid`; external readers treat\n   those states as live only while that owner process is alive. Launch clears\n   the field, and scheduling a retry refreshes it to the current runtime PID.\n   A queued relaunch refreshes only `stopRequested` from durable parent entries\n   (including a fresh headless-journal read) before launch and after awaited\n   owned-provider preflight; cancellation prevents spawning. This does not add\n   cross-process compare-and-swap for competing cold sends, or resume timers\n   lost in a runtime crash.\n\n## Revisit when\n\n- The Pi SDK adds first-class child-session support or recursive listing.\n- Pix needs to resume or list children independently of their parent session.\n- Owned-launch recovery cannot locate records keyed by launch id after a crash.\n\n\n","startLine":146,"endLine":189},{"path":"wiki/operations/incidents/prompt-rpc-timeout.md","quote":"\n# Deferred investigation: prompt RPC acknowledgement timeout\n\nStatus: observed once in a user report; root cause unknown; investigate on recurrence.\nNo runtime fix or retry-policy change was made for this report.\n\n## Symptom\n\nPix displayed:\n\n```text\npi prompt failed: Error: Timeout waiting for response to prompt. Stderr:\nat Timeout._onTimeout (.../acp/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:465:24)\n```\n\nThe screenshot contained no child-process stderr detail after `Stderr:`.\nNo incident logs or reproduction were collected, so the initiating action,\npreflight duration, and eventual outcome of the original prompt are unknown.\n\n## Verified code path at triage\n\nInspected installed SDK version: `@earendil-works/pi-coding-agent` **1.0.2**.\nRecheck these implementation details against the installed version on recurrence.\n\n- SDK `dist/modes/rpc/rpc-client.js`, `send`: pending RPC commands time out\n  after **30,000 ms**. Timeout removes the pending request and rejects its\n  promise; it does not itself abort the child-side prompt.\n- SDK `dist/modes/rpc/rpc-mode.js`, `prompt` handler: successful acknowledgement\n  is emitted through `preflightResult`, after prompt preflight succeeds.\n  This is not a timeout measuring the complete model turn.\n- `acp/src/pi/pi-rpc-client.ts`, `PiRpcClient.prompt`: forwards to SDK\n  `RpcClient.prompt` without a retry loop.\n- `acp/src/acp/pix-acp-agent.ts`: the prompt catch clears the matching\n  `activeRun` and propagates `pi prompt failed` to the client.\n- SDK `dist/core/agent-session.js`, `_isRetryableError` / `_prepareRetry`:\n  model-error retries are a separate mechanism and do not wrap this RPC timeout.\n  The retry UI contract in [retry-toast-action](../../tui/retry-toast-action.md)\n  must not be read as coverage for RPC acknowledgement failures.\n\nThe observed error originates at the local Pix/SDK-to-Pi RPC boundary.\nIt does **not** establish whether the underlying delay was local, an extension\nwaiting for external work, or another cause. Slow input hooks/preflight and an\nunresponsive child are investigation hypotheses, not diagnosed causes.\n\n## On recurrence\n\n1. Preserve timestamp, session ID, initiating action (ordinary prompt or slash\n   command), model/provider, SDK version, and enabled extensions. Redact secrets\n   and private prompt content from shared evidence.\n2. Collect ACP/child logs around the event, including stderr, process exit\n   signals, and any subsequent agent events. Record whether the original prompt\n   continues or produces output after the error, before sending it again.\n3. Trace RPC request ID, command write, preflight/input-hook start and finish,\n   acknowledgement, and agent start/end. If instrumentation is missing, add\n   bounded diagnostics to distinguish blocked preflight from transport failure.\n4. Check late acknowledgement and event handling after `activeRun` is cleared:\n   session state, UI state, cancellation, and the next prompt must remain coherent.\n5. Reproduce with delayed preflight and with child failure before choosing a fix.\n   Add deterministic coverage for timeout, late completion, cancellation, and\n   absence of duplicate execution.\n\n## Safety constraint for a future fix\n\nDo not blindly resend `prompt`: a client-side timeout is not proof that the\nchild rejected or stopped the first request. A retry could execute the task\ntwice. First settle acknowledgement semantics and reconciliation/cancellation\nof in-flight work; merely increasing the timeout is not a root-cause diagnosis.\n\n\n","startLine":1,"endLine":69},{"path":"wiki/configuration/model-thinking-preferences.md","quote":"  }\n  ```\n\n- A valid thinking suffix on a model key is stripped before storage so `provider/model:high` and `provider/model` address the same preference.\n- Invalid values are ignored when the config is loaded.\n- Project profile files cannot override `thinkingByModel`; it is a user UI preference. TUI and Desktop use separate user files, matching the ownership model of `visibleModels`.\n- `defaultModel.thinking` remains the default for creating a new session. `thinkingByModel` is selector memory and does not replace the default-model contract.\n\n## Selector behavior\n\n- The combined model/thinking selector keeps staged thinking independently for each model while the selector is open.\n- When the highlighted/staged model changes, the selector first restores a value already staged for that model during the current picker interaction.\n- Otherwise a non-current model uses its persisted `thinkingByModel` preference when present.\n- The actual current session or draft thinking is authoritative for the currently active model when the selector opens. A stale persisted preference must not make the selector display a thinking level different from the session/draft that is really active.\n- If the remembered level is not supported by the selected model, the existing canonical clamp behavior chooses the nearest supported level. A missing preference falls back to the current staged/session thinking and is clamped the same way.\n- Changing a model's thinking, navigating to another model, then navigating back restores the newly staged value even before Apply/Enter.\n\n## Commit semantics\n\n- Durable `thinkingByModel` state changes only after the combined selection is successfully applied.\n- TUI persists after a successful draft selection or successful runtime model/thinking command.\n- Desktop persists after a successful draft selection or after the runtime config options report the effective applied thinking level.\n- Escape/cancel does not persist merely highlighted or staged model/thinking changes.\n","startLine":29,"endLine":51}],"notices":[],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":66,"excerptedSources":9,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->
# 0034 — Bounded, opt-in Heads up observer

Evaluation follow-up (2026-10-04): the user requested an evaluator in this same
conversation. [The synthetic eval guide](../assistants/observer/evaluation.md) documents a
single-inference, opt-in harness using the production prompt/context/parser;
no full-agent runner or additional model judge is required. Scenario labels,
source checks and transparent lexical anchors are mechanically checkable, but
semantics still need manual review, including automated passes. This extends
verification of the experiment, not its default enablement or rollout scope.

- Status: accepted for an opt-in experiment, not general rollout
- Recorded: 2026-10-04 (retrospective documentation of the same-day discussion)
- Decided: 2026-10-04
- Owner / approval evidence: the user approved implementation after the revised
  Heads up design in this conversation, then requested independent review of
  Luna's implementation. This approval is conversation-only; no separate
  durable approval record is available.
- Governing spec: [Heads up observer](../assistants/observer/heads-up-observer.md)
- Replaces / replaced by: none

## Context

The user asked to investigate Claude Code's You Should Know and then try a
similar feature in Pix. The revised design narrowed the experiment to concrete,
consequential, probably unnoticed tradeoffs or contradictions in the current
task. Generic educational tips and a second autonomous code reviewer are outside
scope. The main agent and the user's composer must remain under their existing
owners, without observer-driven continuations or automatic edits.

## Observations and sources

The [inference adapter](../../src/bundled-extensions/heads-up/inference.ts) uses
the configured model registry with an empty tool list and no retries. The
[controller tests](../../tests/heads-up-controller.test.ts) exercise cadence,
bounded input, cancellation, late-result rejection and original-session usage.
The [extension tests](../../tests/heads-up-extension.test.ts) cover nonblocking
hooks, context edits, restricted runtimes and draft preservation. Desktop and ACP
coverage is linked from the governing spec.

Assumptions remain explicit: rare, evidence-backed notices may help people
supervise long coding tasks, but neither usefulness nor cost effectiveness has
been measured on real sessions. Luna is an initial configured candidate, not a
demonstrated best model. No model-family diversity benefit has been established.

## Decision

Use one bounded, tool-less model request through the existing registry rather
than a new session-fork API or the full async-subagent runner. Refresh a bounded
observation from the current session projection, separate user requirements from
assistant claims, and require real source IDs. Default to no notice.

Keep the feature off by default, with explicit enablement and a separately chosen
model. Do not silently fall back to the parent or switch providers. Rate and
input limits apply to manual checks too. Account finalized billable usage in the
originating session even when its finding becomes stale.

Present one expiring notice with local evidence expansion and session/runtime-local
feedback. Returning a note to the main conversation only fills a safe, empty
draft; the user chooses whether to send it. No learning pages, auto-fixes,
cross-session knowledge profile or feature telemetry are introduced.

## Alternatives

A full async subagent adds execution capabilities and lifecycle machinery that
this passive observer does not need. A new general fork primitive would expand
the implementation before this feature's value is established. Repeated full
transcript requests weaken cost bounds; using only the parent's summary risks
omitting the overlooked fact itself.

Mandatory opposite-provider selection and multi-stage explanation requests were
deferred as separate, unproven quality/cost hypotheses. Automatic feedback into
the parent would change the feature from a user-facing observer into an agent
control mechanism.

## Consequences

The design limits interference and bounds request volume, but cannot independently
validate code or guarantee that a notice is correct. Truncated context can hide
relevant evidence. Credential filtering is best-effort; enabling the feature
sends selected conversation excerpts to its configured provider.

Runtime-local feedback and budgets do not survive runtime recreation. A provider
that ignores cancellation retains the in-flight lock until it settles. These
tradeoffs are documented rather than hidden behind implicit retries or overlap.

## Revisit when

Representative session evaluations show useful notices versus false alarms,
observed input/output usage and latency, or a measured advantage for another
model. Reconsider persistence and scheduling if resets or context omissions harm
the experiment. A production rollout or any observer-driven action needs a new
explicit decision; passing deterministic tests alone is not sufficient.

## Desktop friendly presentation follow-up — 2026-10-05

Status: accepted; the user requested friendlier Observer output after approving
the Telescope icon (Eye is reserved for the agent; Radar was rejected).
The [presentation spec](../assistants/observer/heads-up-observer.md#presentation-and-feedback)
governs the current popup.

Decision: show plain-language status and last-check outcome first; move raw
runtime reasons, resource counters, duration and feedback statistics behind a
keyboard-reachable Technical details disclosure, collapsed on each opening.
The screenshot provided in the conversation showed a dense diagnostics table;
reduced scanning effort is the design intent, not a measured usability result.
Keeping everything visible was rejected as overly technical; removing metrics
entirely would hide useful diagnostics. This changes presentation only, not
cadence, budgets, inference or controls. No-finding wording must not imply the
work is correct, and waiting copy must not promise a scheduled check. Revisit if
users need persistent diagnostics or localized UI copy.

## Desktop controls follow-up — 2026-10-04

The user explicitly requested and approved a permanent statusbar indicator with
details and a session toggle, plus model selection and other knobs in Desktop
settings. Approval is in this conversation, not a separate durable artifact.
The [current spec](../assistants/observer/heads-up-observer.md) governs this extension.

Use statusbar/popup for live, session-owned control; keep the finding itself
above the composer. Remove duplicate enable/check actions from the composer menu.
Expose observed last-check outcomes rather than presenting silence as success
or a minimum interval as a scheduled next launch. Read-only refresh must not
resume the parent or start inference. Pending controls and popup focus belong
to one session/runtime, including while settings load asynchronously.

Store Desktop defaults in the existing `pix-desktop.jsonc` profile under
`headsUp`, independent of standalone TUI observer configuration. Reuse the
normal conflict-checked settings editor and provider/model picker. Defaults
apply on new/reloaded runtimes; a popup switch originally changed only its current
runtime (the persistence follow-up below supersedes that part).
Immediate propagation to all running sessions was not chosen because it could
cancel or silently enable background requests in unrelated tabs. Shared TUI
defaults were rejected to preserve the requested Desktop separation. Existing
Desktop users of standalone `heads-up.jsonc` must set the new Desktop profile;
no automatic migration or default enablement is performed.

This changes discoverability and configuration, not the observer's inference
prompt, model-quality claims, or permission to act on findings. Browser
integration uses synthetic model/native IPC to verify the UI contract; native
window behavior and real-model usefulness remain distinct verification scopes.

## Desktop compact controls and persistence follow-up — 2026-10-04

Status: accepted; supersedes runtime-only Desktop enablement above, not TUI
enablement or profile-default propagation. User approval is in this conversation:
icon-only eye, grey off / primary enabled / flicker during work, dynamic-only popup,
the standard switch, and retaining enablement after application restart.

Evidence: the old popup command called only `setEnabled`, and initialization read
only profile defaults, so toggling was lost on runtime recreation. Decision: save
explicit Desktop on/off as non-message custom session metadata via the SDK and
restore the last valid choice for that session before publishing enabled state.
Branch navigation does not rewind a session-owned preference. Existing settings
still supply the model and limits. No automatic check runs simply on restoration.

Alternatives: writing global defaults would affect unrelated/new sessions;
browser-local storage would separate ownership from durable native sessions and
require replaying commands after reconnect. Neither is necessary to retain the
current-session switch. Consequences: forks inherit metadata only when present
in their copied branch, and drafts without a conversation are not persisted.
TUI behavior, runtime counters/budgets and inference policy remain unchanged.
Revisit if a global quick-toggle or explicit reset-to-default action is requested.

Keep only the eye in chrome and live diagnostics in the popup; static model and
budget settings remain in Settings. This removes duplicated configuration rather
than hiding diagnostics. The standard switch preserves keyboard semantics.

## Desktop limited indicator follow-up — 2026-10-04

Status: accepted; supersedes primary-for-all-enabled states in the compact
controls decision above. User requested a static amber eye for budget-blocked
checks, with the limit and earliest known quota release in tooltip and popup.
The [current spec](../assistants/observer/heads-up-observer.md#presentation-and-feedback)
defines the presentation contract.

Evidence: runtime publishes `limited` for both hourly check and input budgets;
`windowResetsAt` is the earliest reservation expiry, not a full reset or scheduled
check. Decision: use the semantic warning color, prioritize limited over a live
notice in status chrome, and restore primary only on a runtime state update.
The finding card remains untouched. Do not infer recovery from wall time, start
inference, or add polling. Keeping primary hides blocked work; guessing a full
reset from the earliest expiry misrepresents the input budget. Revisit if runtime
adds authoritative next-eligibility notifications. No inference policy changes.

## Delegated evidence follow-up — 2026-10-04

Status: accepted first increment for the same opt-in experiment. The user asked
to continue the delegated-work handoff; that handoff explicitly permits bounded
child reports while authoritative mutation/test provenance is unavailable.
The [governing spec](../assistants/observer/heads-up-observer.md#delegated-work-first-increment)
defines the scope and limitations.

Evidence: generic async completion notices are custom messages, excluded by the
observer's transcript reducer; parent summaries can therefore hide a concrete
child design conflict. Compact child events contain tool names/counts rather than
authoritative file mutations, command arguments or test output. Structured results
derive from the visible child report, not independent verification. Assumption:
attributing a concrete reported conflict can still be useful, but usefulness and
false-positive rates require semantic evaluation.

Decision: use a passive runtime bridge with launch ownership captured before
async routing, and bounded final reports after retries/fallback. Keep a single
parent observer and unchanged follow-up/wait arbitration. Treat reports as claims,
not inspected code or verified tests. Add a coalesced completion opportunity under
existing budgets/interval/concurrency, so parent settlement does not strand new
evidence. Retire launches across lifecycle boundaries instead of adopting old work.

Alternatives deferred: authoritative child-tool instrumentation is a larger
future provenance increment; global worktree diffs cannot attribute changes among
concurrent workers; one observer per child expands cost and ownership complexity;
using only parent follow-ups retains the original omission and delivery dependency.

Consequences: child summaries may be incomplete or wrong, clipping can hide a
correction, and lifecycle invalidation can drop late reports. This does not close
the verified-diff/test-evidence gap. Revisit when child mutation/test provenance
exists or representative sessions show omissions/false positives; do not infer
production readiness from synthetic eval scores alone.

## Settled checks and evidence-driven card review — 2026-10-04

Status: accepted. This supersedes the original `turn_end` launch policy and
open-notice suppression of all automatic requests, not the single-card,
opt-in, bounded-inference decision. Contract: [Heads up observer](../assistants/observer/heads-up-observer.md).

Context: the user reported a HUD test failure warning after a successful rerun,
then explicitly chose successful final agent settlement over intermediate turns
or todo boundaries. The user also approved rechecking an open card when new
evidence arrives after work completes, rather than periodic polling or a stack.

Evidence: in session `01a10822-1e93-779e-866f-13f50013a78b`, the failed codemode
result `0eb25993` was persisted at 18:55:01.651Z; Observer usage `64c7906f` at
18:55:06.939Z; test-expectation fixes `565271fd` at 18:55:19.024Z; the successful
shell rerun `0a8f9e7e` (82/82, six files) at 18:56:01.178Z; successful typecheck
`4edced57` at 18:56:15.826Z. The user's later inserted notice `2050c618` cited the
failed result. No Observer usage lies between that completed check and the
inserted notice. The runtime accounts usage after the provider completes, before
publishing. This supports an early assessment left visible across repairs, not
a completion delayed until after the retest. Exact inference snapshots and UI
delivery timestamps were not persisted, so those cannot be reconstructed.

Code evidence: ordinary results did not invalidate inference; `generation`
guarded lifecycle ownership and `revision` ordered UI snapshots. Open cards
blocked automatic reassessment. Context selection also serialized work backwards
and could skip a large newer record while backfilling an older small failure.
Those are independently reproducible risks, not proven causes of this incident.
Codemode and shell share the tool-result reducer; nested codemode calls arrive
as bounded aggregate text. There is no demonstrated shell-specific filtering bug.

Decision and scope:
- Accumulate completed turns, launch only after successful final settlement
  (after queued continuations), or accepted delegated evidence while idle.
  Failed/aborted settlement is not a trigger. Manual checks remain immediate.
- Refresh projected evidence before publishing a finding or applying a review.
  Changed bounded user/tool/delegated evidence, edited cited assistant text, or
  an active parent during automatic inference causes a coalesced fresh check,
  not delivery of the old verdict. Preserve lifecycle tokens and physical lock.
- Review the existing card on settled changed evidence, within the same
  interval/input/hour limits. The model reassesses that problem, not a new topic:
  still supported means keep the card identity and original TTL; `none` removes
  it. Unrelated successful checks do not imply resolution. No new evidence means
  no automatic paid review. Closed cards cannot be resurrected by late results.
- Serialize selected records chronologically and keep a contiguous recent work
  suffix under the total budget, plus pinned instructions. Do not fill a gap left
  by a large fresh result with smaller old failure evidence.

Alternatives: periodic polling spends on unchanged context and can observe
intermediate repairs; todo completion is optional and does not prove testing is
finished; a prompt-only change cannot enforce delivery freshness or restore
omitted records; blanket invalidation on every event starves useful findings;
command-name/exit-code heuristics cannot reliably match arbitrary nested tools.
A multi-card stack changes selection/UX and retains more stale claims, so remains
out of scope.

Consequences and limits: warnings arrive later and brief problems fixed within
one run are normally never shown. Changed evidence may defer an unrelated valid
finding, but reassessment can retain it; cost remains bounded. A visible card can
remain during work, a failed/refused review or until TTL. Model inference is still
fallible; prefix clipping and bounded history can omit relevant evidence, and
long records can reduce useful retained context. Deterministic tests establish
scheduling, freshness, payload and ownership behavior, not model accuracy.
Revisit on measured missed warnings, review cost/starvation, or availability of
authoritative per-check identity/provenance; do not add polling or command
matching based solely on this incident.

## Bounded active stack — 2026-10-04

Status: accepted. Supersedes the single-card/discovery suppression portions above,
not settlement, freshness, opt-in or inference budgets. Contract:
[Heads up observer](../assistants/observer/heads-up-observer.md).

Context and evidence: after the freshness fix the user explicitly requested the
proposed stack because one open card could hide other independent problems.
The approved proposal is up to three active findings, one visible card with
counter/navigation, and one combined review/discovery request under the existing
budgets. No claim is made about another product's undocumented stacking behavior.

Decision: return a complete supported set of up to three cards. Retained cards
use their existing IDs and preserve age/expiry; resolved/unsupported cards are
omitted. New cards use null IDs at the model boundary and receive runtime IDs.
Strict validation rejects the entire malformed/truncated/unknown-ID response;
it must not partly remove old cards. Exact topic duplicates merge; semantic
independence and relevance remain model judgments. Keep surviving cards in their
prior order, then append discoveries. Navigation changes selection only, never
requests inference or extends TTL. Desktop selection is local and scoped to its
runtime/session; TUI prev/next updates the selected snapshot member. Old Desktop
singleton snapshots remain readable via optional `notices` compatibility.

Concurrency: one physical inference lock/reservation serves the whole stack.
Changed evidence still rejects completion; membership changes (dismiss/expiry)
during assessment reject it atomically, preventing resurrection. Selection changes
do not cancel useful assessments. Independent expiries share one earliest-expiry
timer. Runtime replacement/lifecycle invalidation clears the stack.

Alternatives: retaining a singleton misses simultaneous problems; separate review
and discovery calls multiply spend; an unbounded queue retains more stale claims;
showing all cards at once crowds the composer. A full-set reply is simpler to
validate atomically than separate add/update/remove operations.

Consequences/assumptions: three is a bounded UX choice, not a measured optimum.
The unchanged output budget demands concise replies; truncation fails closed.
Descriptors can be clipped within small input budgets, explicitly labelled, while
preserving all active IDs. The deterministic suite covers limits, lifecycle,
selection, ownership and schema, not model accuracy. The current live-eval corpus
still expects one problem per positive fixture, so extra cards require human review
and cannot earn a proxy pass. Revisit after measured missed independent findings,
semantic duplicates, truncation rates or review cost; no increased budgets or
periodic polling is approved by this change.

## Strict visible freshness follow-up — 2026-10-04

Status: accepted. Supersedes retaining visible assertions across new work and
failed/refused reassessment, not the bounded-stack or inference-budget decisions.
Contract: [strict visible freshness](../assistants/observer/heads-up-observer.md#strict-visible-freshness).

Context: after the stale HUD warning and bounded-stack work, the user requested
currently supported cards rather than temporary problems that may already have
been fixed, and approved hiding unconfirmed cards without increasing limits.
Evidence: rejecting stale inference responses alone left previously displayed
cards visible during later repairs, errors and quota refusals. The SDK can emit
message completion before persistence, so projection-only comparisons leave a
delivery race. Assumption: conservative visibility is preferable to presenting
an old assessment as current; this does not establish model accuracy.

Decision: hide the complete visible stack synchronously on parent start or
user/tool/delegated evidence completion. Keep bounded private candidates with
original IDs and TTLs. Publish only neutral awaiting-review state, and restore
only cards supported by a successful current assessment after settlement.
An evidence-event revision complements projection comparison and lifecycle tokens.
Manual checks remain immediate but cannot publish claims while the parent runs.
Errors, unavailable context, malformed responses and limits never restore hidden
claims. Existing budgets, request ownership/accounting, expiry and no-polling
policy remain unchanged; neither hiding nor a refusal queues repeated retries.

Alternatives: TTL-only retention keeps known-stale assertions visible; optimistic
retention until review repeats the reported failure; polling or higher budgets
adds cost without guaranteeing truth; clearing all identity loses stable review
and expiry semantics. Consequences: cards can remain absent while review is
blocked, and clipping can prevent reconfirmation. Hidden does not mean resolved.
Revisit if measured missed findings or excessive conservative hiding outweigh
stale-warning risk, or authoritative fresh repository evidence becomes available.

## Semantic evaluation, structured feedback and adaptive discovery — 2026-10-05

Status: accepted. Supersedes exact-wording-only memory and fixed-interval new
discovery above, not strict freshness, stack review or resource limits. Contract:
[Heads up observer](../assistants/observer/heads-up-observer.md).

Context/evidence: the user approved improvements in priority order after comparison
with a local Claude Code reconstruction. That reconstruction is not authoritative
upstream source and no upstream code is copied. Historical Pix live evaluation had
a rejected-edit false positive and a keyword-accepted API warning with reversed
contract direction; those runs predate current stacking/freshness. Current code
used shown/feedback text and exact normalized wording as its duplicate key.
Assumptions: structured hints help continuity, explicit negative feedback is a more
defensible frequency signal than silence, and conservative bounded adaptation is
preferable to inferred user expertise. No improved model accuracy is claimed.

Decision/scope:
- Expand synthetic evaluation with change-state/direction pairs, multi-problem and
  active-review cases; require one-to-one rubric matches and human semantic review.
  Known inversion checks remain narrow heuristics, not a judge model. No paid live
  inference is part of this implementation verification.
- Ask the existing single inference for stable topic/subject hints; keep legacy
  responses readable. Retain at most 32 structured task-local shown/verdict records,
  suppress equal identities on equal bounded evidence text, and permit reconsideration
  on changed circumstances. Fresh user input/context-clearing ends this coarse task
  scope. Topic matching still depends on model consistency.
- Add explicit useful/incorrect feedback alongside known/irrelevant/dismiss and
  expose runtime-only counters. Negative relevance/accuracy verdicts multiply only
  new-discovery intervals 1→2→4; useful resets. Silence, dismiss and known never
  penalize cadence. Keep the base interval for all retained-card reviews and manual
  bypass unchanged. Session-local cadence/counters survive task boundaries, not
  runtime recreation. No telemetry, transcript logging or global/persisted memory.

Alternatives: semantic embedding/judge requests add cost and authority not justified
by evidence; exact wording misses paraphrases; permanent topic suppression hides new
circumstances; persistent user profiles need separate privacy/product approval;
upstream-style silence/ignored-submit backoff incorrectly treats attention as rejection;
slowing reviews leaves old findings hidden longer. Additional explanation calls,
full-context forks, auto-submit and weaker freshness are explicitly excluded.

Consequences: optional identity metadata increases payload size under unchanged
budgets. False key matches or unstable keys remain possible; changed citation content
is eligibility, not proof of novelty. New prompts reset task memory conservatively,
even when the user continues a task. The 4× cap and reset rule are bounded product
choices, not measured optima. Revisit with manually reviewed semantic precision,
duplicate/recurrence rates, usefulness feedback and missed independent findings;
perform any paid live evaluation separately and report coverage/cost honestly.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"f061c4de-d66a-4d75-9c7e-aef1d8e78d55","contentHash":"addd6cfc95f4f88f628b1b544698e98ca8d007a4c97532e45fd1ca44bc6d0e01","checkedAt":"2026-10-31T01:29:23.800Z","maxDocumentChars":128000} -->
