---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-30T23:30:52.623Z","result":{"path":"wiki/usage/session-usage.md","documentHash":"fe260719da6cf3acb81828a41afef35e289982671f5fa36453f8bf56a2c013c2","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[{"draft":{"path":"wiki/usage/session-usage.md","quote":"TUI also keeps money out of the status\n  bar, but now shows recorded costs in its on-demand breakdown (with compact\n  text bars for token shares when several models contributed).","startLine":103,"endLine":105},"existing":{"path":"wiki/usage/session-usage.md","quote":"TUI mouse tests assert that Usage opens the compact colored token breakdown and\n  contains no monetary price, agent/subagent split, session-share percentage, or\n  quota block.","startLine":310,"endLine":312},"explanation":"Внутреннее противоречие внутри самого черновика: раздел UI behavior утверждает, что TUI показывает записанные денежные затраты в своём on-demand breakdown (Usage), а разделы Verification и Risks/compatibility закрепляют, что TUI-презентация остаётся token-only и breakdown Usage не содержит денежной цены. Оба утверждения относятся к одному и тому же TUI-диалогу Usage в одном контракте и не могут выполняться одновременно."}],"uncertainties":[{"draft":{"path":"wiki/usage/session-usage.md","quote":"The async-subagents runner mirrors that usage into the originating parent\n  session through Pi's durable `appendUsage` entry with kind `async-subagent` and\n  a versioned JSON note containing `runDir` and `agentId`.","startLine":54,"endLine":56},"existing":{"path":"wiki/decisions/0072-session-native-subagents.md","quote":"new\n  features: `agentId` as a launch identifier mapped to Pi-assigned child session UUID, retention tied to the parent session,\n  per-role `maxTurns`/budget, batch label instead of `runDir`.","startLine":11,"endLine":13},"explanation":"Решение 0072 (принято 2026-10-17) поэтапно заменяет runDir на batch label и убирает run-каталоги, тогда как черновик (active implemented contract) всё ещё опирается на runDir/agentId и группировку по (runDir, agentId). Чтобы решить, конфликт это или описание разных стадий поэтапного внедрения, нужно знать, какая стадия редизайна 0072 сейчас реализована и заменён ли runDir в durable usage/statistics записях на момент черновика."}],"reviewedSources":[{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n- Compact status chrome labels context as `Context`, omits redundant hourly/weekly and `resets` text (window names and reset meaning remain in click details), and shows Claude Code provider model names without the `Claude Code ` prefix in the model/thinking display. Persistent model names use neutral foreground text and thinking uses muted text, leaving provider brand color to the icon; picker and usage-detail model colors are unchanged. Provider IDs and routing are unchanged. Context and quota use content-sized grid groups rather than equal columns; bounded inline controls clip excess content at very narrow widths instead of painting over neighboring controls, while detail panels remain unclipped.\n- Context and Usage have distinct inter-group spacing and fixed inner telemetry slots. Quota windows use track, reset countdown, then the associated warning/retry/cache indicator, with no bullet or middle-dot separators; loading placeholders follow the same order. Only actually present quota windows take space; the account label stays in the details rather than the trigger.\n  Neither Context nor quota triggers reserve or render numeric percentage slots, including their skeleton placeholders. Percentages remain available in detail panels and quota accessible descriptions; narrow-window clipping remains bounded by the outer control.\n","startLine":1,"endLine":35},{"path":"wiki/work-management/registry/resource-registry-project-state.md","quote":"## Type\n\nChange\n\n## Lifecycle\n\nImplemented; this is the current project-state registry contract.\n\n## Goal\n\nSynchronize project-scoped tasks, plans, and workspace state through the\nprivate Git registry without making task attachments depend on machine-specific\nabsolute paths.\n\n## Scope\n\n- Desktop Registry push/pull/sync for tasks, plans, workspace and project.\n- Project provenance in canonical `.pi/registry.jsonc` (with read-only legacy\n  lookup of `.pi/registry.json` when the canonical file is absent).\n- Portable synchronization of SQLite task rows and SHA-256 content-addressed\n  attachments from `.pi/tasks.sqlite` and `.pi/task-attachments`.\n- Pix Desktop local project-state initialization for workspaces that do not yet\n  have a `.pi` directory.\n\n## Remote layout\n\nFor project key `\u003ckey\u003e`, the registry stores:\n\n- `projects/\u003ckey\u003e/tasks.sqlite` (transaction-consistent online backup)\n- `projects/\u003ckey\u003e/task-attachments/\u003csha256\u003e` for blobs referenced by the\n  synchronized SQLite attachment association table\n- `projects/\u003ckey\u003e/plans/`\n- `projects/\u003ckey\u003e/workspace.jsonc`\n\nLegacy `projects/\u003ckey\u003e/TODO.md` files are ignored; Registry does not publish,\nfetch, report or delete them.\n\nThe Registry SQLite copy is a consistent transport snapshot: neither side\ncopies a live database's raw bytes without its WAL. Task descriptions contain\nplain text, and attachments are related by hash and task id inside SQLite,\nnot by embedded `file://` or portable text markers. There is no legacy\nJSONC/task overlay import or fallback.\n\n## Behavior\n\n- Registry provenance is JSONC. Status/read operations are side-effect free;\n  malformed or unsupported provenance is an error and is never bypassed by\n  falling back to the legacy file. The first subsequent provenance write\n  migrates legacy state by publishing the complete canonical document\n  atomically without clobbering a concurrently created canonical file, then\n  removes the legacy file only if its contents are unchanged. A failed legacy\n  cleanup is logged but does not undo the successful canonical write. Registry\n  writes add the Registry editor schema reference only when `$schema` is absent.\n","startLine":3,"endLine":55},{"path":"wiki/archive/workspace.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Conversation workspace — tool removed\n\n## Behavior\n\nPix TUI and Pix Desktop do not provide the bundled `workspace` tool.\nThe former `current`, `switch` and `back` actions, return stack, transactional\nruntime rebinding and transparent model continuation are removed.\n\nOrdinary project opening, session operations, context reload and workspace undo\nare unchanged. Legacy `workspace` state envelopes do not mutate ACP session cwd,\nthe translator, persisted session-map records or Desktop catalog cwd. Historical\n`pix.workspace` journal entries remain untouched, but are no longer restored by\na workspace host. Running processes must restart to unload the removed tool.\n\nSee [the removal decision](../decisions/0023-remove-workspace-tool.md), which\nsupersedes the [rebinding](../decisions/0014-conversation-workspace-rebinding.md)\nand [handoff](../decisions/0021-transparent-workspace-handoff.md) decisions.\n\n## Implementation\n\n- `src/app/runtime.ts`\n- `src/app/app.ts`\n- `src/app/session/session-lifecycle-controller.ts`\n- `acp/src/pi/pix-rpc-entry.js`\n- `acp/src/acp/pix-acp-agent.ts`\n- `acp/src/acp/session-state-bridge.ts`\n- `acp/src/acp/session-map.ts`\n- `desktop/src/app/session-coordinator.ts`\n- `desktop/src/app/desktop-session-orchestration.ts`\n\n## Tests\n\n- `tests/bundled-question-extension.test.ts`\n- `tests/session-lifecycle-controller.test.ts`\n- `acp/test/agent.test.ts`\n- `acp/test/session-state-bridge.test.ts`\n- `desktop/src/app/session-coordinator.test.ts`\n\n## Verification\n\nRoot, ACP and Desktop typechecks plus targeted bundled extension, session\nlifecycle and state bridge/coordinator regressions. These checks do not claim\ninteractive UI QA.\n\n\n","startLine":1,"endLine":50},{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n  node_modules, HOME, credentials and the checkout are never copied into the\n  payload. Production runtime compilers/loaders such as jiti, and esbuild when\n  present in the production dependency graph, are retained.\n- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and\n  (Desktop only) `pix/app/acp/{dist,node_modules,...}`. Preserve the relative relationship between\n  ACP, Pix dist and the bundled tools suite. Native addons and dependency license\n  files are retained; `DEPENDENCIES.json` inventories shipped package metadata.\n- The shell/CMD launcher selects the absolute bundled Node path, prepends its\n  directory to PATH for child tools, preserves the caller's working directory,\n  forwards arguments, and propagates exit status.\n- Standalone means no separately installed Node/npm for Pix itself. Git, project\n  toolchains, optional language servers, voice/clipboard helpers and provider\n  credentials remain external requirements as applicable.\n\n## Payload optimization and size gates\n\n","startLine":1,"endLine":56},{"path":"wiki/tools/native-pi-tools-suite-ui.md","quote":"## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\n`pi-tools-suite` provides native presentation when it runs in the ordinary Pi\nterminal UI without making Pix consume that presentation layer. Tool/state\nsemantics remain extension-owned; clean Pi uses Pi's public extension UI API,\nwhile Pix TUI and Pix Desktop keep their existing renderer/bridge ownership.\n\n## Host boundary\n\n- Native suite presentation is enabled only when the extension context is\n  `mode === \"tui\"`, dialog UI is available, and the process is not Pix-owned.\n- Pix marks its in-process runtimes with the process-local\n  `Symbol.for(\"pix.host.runtime\")` before extension loading. Both the normal\n  Pix runtime and sessionless draft-model runtime establish that marker.\n- Pix Desktop/RPC child processes are also recognized by the existing\n  `PIX_ACP_SESSION_STATE_BRIDGE`, `PIX_QUESTION_RPC_BRIDGE`, and Desktop\n  profile environment boundaries.\n- The guard is shared by every native suite widget. A Pix-owned host must not\n  call `ctx.ui.setWidget()` from todo, async-subagents, or DCP.\n- The suite `question` module is additionally marked clean-Pi-only in the\n  module loader and has its own Pix-host guard. Pix continues to register its\n  bundled `src/bundled-extensions/question` implementation and Desktop bridge;\n  it must never receive a duplicate suite `question` registration.\n- Headless/print/JSON/RPC operation keeps tool behavior without terminal\n  widgets. Native presentation never becomes a prerequisite for tool execution.\n\n## Todo widget\n\n- Todo presentation reads the canonical live `TaskState`; it does not parse\n  conversation text or reconstruct a second plan model.\n- The widget is shown above the editor only while visible `pending` or\n  `in_progress` tasks exist.\n- It summarizes active/pending/blocked counts and shows a bounded set of active\n  tasks with ID, current active form, and blockers. Completed/deferred/deleted\n  work remains available through the existing tool and `/todos` views instead\n  of occupying persistent terminal space.\n- Tool commits, replay/startup, compaction/tree changes, internal auto-clear\n  mutations, and shutdown refresh or clear the widget from the same canonical\n  state.\n- Each update prepares an immutable presentation snapshot: aggregate counts,\n","startLine":4,"endLine":51},{"path":"wiki/decisions/0072-session-native-subagents.md","quote":"  parent memory/parent-session entries, no sidecars; no migration; new\n  features: `agentId` as a launch identifier mapped to Pi-assigned child session UUID, retention tied to the parent session,\n  per-role `maxTurns`/budget, batch label instead of `runDir`.\n- Governing spec: [async-subagents](../tools/agents/async-subagents.md)\n- Replaces / replaced by: none. Changes the disk layout in the governing spec\n  stage by stage; [harness artifact storage](../operations/harness-artifact-storage.md)\n  changes in stage 5.\n\n## Context\n\nEvery child is already a full persisted Pi session (`pi --mode rpc\n--session-dir …`), but it lives inside a project run tree\n`.pi/subagents/\u003crun\u003e/\u003cagent\u003e/sessions/`. Around it sit about 20 sidecar files\n(`pid`, `exit_code`, `started_at`/`finished_at`, `retry_*`, `stop_*`,\n`model_fallback_*`, `launch.json`, `prompt.md`, `result.md/json`,\n`progress.jsonl`, `todo-progress.json`, `stderr.log`, `session_file`,\n`parent_session`, …) and a locked `registry.json`. Some of this was left over\nfrom the removed no-session mode (removed in stage 1 of this redesign). TUI,\nACP (`pix/subagents/open_session` needs `runDir` + `agentId`) and Desktop all\nread the run tree directly.\n\n## Observations and sources\n\n- OpenCode: a child is an ordinary session with `parentID`; its id is the\n  `task_id` used for resume; the result returns in `\u003ctask_result\u003e`; no run\n  directory. Its on-disk layout was not verified (source fetch returned 404).\n- Claude Code: child transcripts are `\u003csession\u003e/subagents/agent-\u003cid\u003e.jsonl`\n  plus a small `.meta.json`, deleted with the parent session (default 30\n  days); role frontmatter carries `maxTurns`, `model`, `tools`.\n- Pi SDK (installed version, read-only inspection):\n  - `SessionManager.list()`/`listAll()` read only top-level `*.jsonl` of each\n    session directory, non-recursively\n    (`dist/core/session-manager.js` `listSessionsFromDir` ~594–603,\n    `listAll` ~1460–1500). Files in a nested subdirectory never appear in\n    resume lists.\n  - The session file is flushed lazily: header and custom entries stay in\n    memory until the first user or assistant message, then are written\n    together (~680–806, `appendCustomEntry` ~901–911).\n  - `SessionHeader` has only `type`, `version`, `id`, `timestamp`, `cwd`,\n    optional `parentSession`; arbitrary metadata belongs in a `CustomEntry`.\n    No CLI `--parent-session` flag; RPC `new_session` accepts `parentSession`.\n  - No file locking; migration may rewrite a file. Two writers can race.\n  - Pix already treats `parentSession` as fork lineage (TUI fork grouping,\n    ACP fork metadata), so reusing it for children would mislabel them as\n    forks.\n","startLine":11,"endLine":55},{"path":"wiki/providers/claude-code-provider.md","quote":"The suite catalog enables the module by default. Pix TUI autoloads the personal\nsuite (its bootstrap installs/links bundled source); Desktop/ACP prefers that\ninstalled personal suite and otherwise uses the\nbundled copy. Run the suite sync after updating source. Isolated async children\nload only the suite-relative standalone module entrypoint, not the whole suite\nand not a user/project npm package. Existing owned-launch, tool-guard and\nprovider-web-search policies continue to apply.\n\n### Multiple Claude subscription profiles\n\nOpt-in `claudeCodeProvider` settings live **only** in the user-level\n`~/.config/pi/pi-tools-suite.jsonc`, shared by Pix Desktop/ACP and TUI. A\nworkspace's project config cannot supply OAuth paths. Desktop Settings → Tools\nSuite → Claude Accounts edits this file through the existing validated settings\neditor; no login tokens are read, copied, stored, or displayed by Pix. The\naccount editor supports naming, ordering, adding, removing and copying CLI\ncommands to log in/check status with a separate `CLAUDE_CONFIG_DIR`. The toggle\nis disabled until at least two profiles are listed. Saving changes takes effect\non the next provider request; an existing in-flight request keeps its snapshot.\n\nDesktop Session usage, when the active model is Claude Code or the session\nhas recorded Claude Code calls, includes a\ncompact account selector between `Session usage` and `Subagents`. It reads\nonly the user-level Tools Suite config when opened. `Default` with rotation\noff uses the ordinary Claude CLI login; `Auto` with rotation on clears the\nmanual preference. Choosing a named profile writes `selectedAccount` under\n`claudeCodeProvider` via a compare-and-swap JSONC edit that preserves other\nsettings and detects concurrent saves. This is a global **preferred account\nfor the next model request**, not a change to an in-flight call; it also works\nwhile automatic rotation is off. With rotation enabled, the selected account\nis attempted first, and its quota rejection still triggers the bounded\nfallback and optional pause. Explicit preference changes clear only that\naccount's process-local cooldown once; no account is retried twice in one\nrequest. Renaming/removing the preferred profile in Settings clears it, and an\ninvalid stale name in manually edited JSONC falls back instead of blocking\nthe provider.\n\nEach attempt publishes only a profile label and timestamp through the\nsession-owned `claude-code-account` event, allowing Desktop to show\n`Last: \u003clabel\u003e`. This identifies an attempted account, not a confirmed\nsuccessful login. The selector does not automatically refresh subscription\nusage or relabel existing quota bars: previously displayed quotas may belong\nto the prior login. The UI displays no OAuth tokens or private config paths.\nAll file reads/writes are asynchronous and scoped to the lifetime of the\npopup, and a concurrent-file conflict does not overwrite newer settings.\n\nExample (each directory must first be authenticated with Claude Code CLI):\n\n```jsonc\n\"claudeCodeProvider\": {\n  \"autoRotate\": true,\n  \"rotationDelaySeconds\": 60,\n  \"accounts\": [\n    { \"name\": \"Personal\", \"configDir\": \"~/.claude-personal\" },\n    { \"name\": \"Work\", \"configDir\": \"~/.claude-work\" }\n  ]\n}\n```\n\nIn Desktop Settings → Tools Suite → Claude Accounts, the **Claude quota\nwarnings** switch is discoverable through settings search, including quota and\nrate-limit terms, and controls whether the provider displays notices for Claude's\n`allowed_warning` rate-limit events. Its user-only setting is\n`claudeCodeProvider.showRateLimitWarnings` in\n`~/.config/pi/pi-tools-suite.jsonc`; it defaults to `false`. The provider reads\nthis preference during initialization, so reload/restart sessions to apply a\nchange. Disabling these notices suppresses only the `allowed_warning` UI\nnotifications: structured quota telemetry, rejected-quota notifications/errors\nand account-rotation warnings are unchanged.\n\nWhen disabled or absent, Claude Code retains its original single-profile login\nbehavior. With rotation enabled, startup checks the first configured profile,\nnot the implicit default `~/.claude`. Per-request model subprocesses receive\na pinned `CLAUDE_CONFIG_DIR`; neither mutates `process.env` nor forwards an\nOAuth token. The provider-specific `pi_claude_code_provider_web_search` tool\nis not registered or used; the suite's separate `web_search`/`web_fetch`\ntools are unchanged.\nTwo profiles with the same\nresolved path or duplicate names are invalid; the backend rejects malformed\nconfiguration rather than silently choosing the wrong login.\n\nOnly a **structured** `rate_limit_event` with `status: rejected` and\n`rateLimitType` of `five_hour` or `seven_day` qualifies for failover. A request\nstarts at the selected available account and visits each configured account at\nmost once; rate-limited accounts enter a shared process-wide cooldown until\ntheir reported reset time (or two minutes when unknown), capped at eight days.\nConcurrent requests may already be using the same account when a rejection\narrives; subsequent selections honor the cooldown. A profile becomes eligible\nagain after its reset. No implicit rotation happens for auth, transport,\noverload, cancellation, or other errors, nor after any model content or tool\ncall has started streaming. Pre-output rejections discard the abandoned\nattempt's start/error events, preserving a single logical Pi stream. Retries\n","startLine":19,"endLine":110},{"path":"wiki/usage/desktop-usage-stats.md","quote":"`USAGE_UNITS = ['tokens']`. `PROJECT_USAGE_SOURCE_IDS` is not part of the\ncontract. Buckets contain values and optional `projectCwd`, but no `series`,\n`dims` or `quotaPercent`; change notifications are `{ source }` without a\n`cwd`. Requests still require a valid `cwd`, but collection does not use it.\n\nACP `UsageStatsHost` owns one `UsageStatsService`; it does not maintain\nper-project services or an LRU. The host disposes the service with the agent.\n\n## Desktop behavior\n\nThe outer sidebar header reads **Usage**, with the refresh action immediately\nbefore Close. There is no duplicate **Pix usage** toolbar inside the panel,\nnor provider tabs or a source switch. The period selector defaults to **7 days**\nand offers the supported periods for the available data.\n\n**Provider limits** is a separate disclosure above historical statistics. It\nuses the same account-quota widgets and `displayModelUsage` precedence as the\nstatus-bar popover: remaining percentages, hourly segments, reset countdowns,\nweekly calendar/day slices, daily-budget warnings and cached-state labels.\nDay slices describe the aggregate weekly quota, not independently measured daily\nlimits. Expanding **Provider limits** discovers authenticated supported provider routes from\nthe sessionless model catalogue and queries their quotas through `draft_config`,\nindependently of the active session/model (OpenAI, Anthropic/Claude Code, Z.ai,\nand Antigravity). Account-wide routes use one representative model; Antigravity\nretains model-specific queries. Queries have bounded concurrency, refresh every\nfive minutes while expanded (one minute for pending local Claude Code credentials),\nand also run on header refresh while expanded. Collapsing the section or closing\nthe panel stops polling and queued queries; already-started requests may finish\nbut their late completions are ignored, including after a same-workspace reopen.\nCompletions from previous workspaces/connections or disposed panels are ignored. Failed\nrefreshes retain prior quotas as cached; missing quotas remain visible as loading,\nunavailable or failed provider rows, rather than silently omitting the provider.\nProvider quota rows are app-wide, not owned by an ACP connection or workspace, and\npersist in localStorage under `pix.desktop.providerUsageQuota.v1`. Remounts,\nproject switches, reconnects and application restarts can therefore render the\nlast rows immediately. Refresh-time credential-scope checks still discard rows\nbelonging to a different login; persisted loading rows without quota data are\nnot restored.\nWhen an OpenRouter API key is configured (`OPENROUTER_API_KEY` or Pi\n`auth.json`'s `openrouter.api_key`), Provider limits also shows an OpenRouter\nrow. Its Tauri `openrouter_usage` command requests `/api/v1/key` and\n`/api/v1/credits` (credits 403/404 are tolerated) and returns balance\n(`total_credits - total_usage`), key spend for today/week/month, key limit and\neffective budget. Neither the key nor its label is returned. The frontend polls\nevery five minutes only while Provider limits is expanded and persists its\nsnapshot in localStorage under `pix.desktop.openRouterUsage.v1`; on failure,\navailable cached values remain visible with a **Cached** marker.\nExisting runtime snapshots (including draft telemetry) supplement fetched quotas;\nthere are no usage-history-derived quota estimates. The\nnewest snapshot wins for each provider/account/model before grouping models into\none chart block per provider/account, including Antigravity. For each hourly or\nweekly window the summary uses the lowest reported remaining percentage and\nthat window's actual reset time, rather than summing or averaging model pools.\nSelected cached windows retain the cached indicator; distinct accounts remain\nseparate. Loading/unavailable/error placeholders are also grouped by provider\nand do not duplicate a provider that already has a chart. The panel shows no\nmodel names or repeated `Limits` headings; the status-bar popover keeps its\nexisting heading. Request-header RPM/TPM windows are not\naccount quotas and are not rendered here. Missing quota data has an explicit\nempty state; provider limits do not depend on historical usage being present.\n\nProvider rows (both quota charts and missing/loading placeholders) are ordered\nby descending call count across all available Pix usage history, across projects\nand dates, independently of historical chart filters. Credential-route aliases\nshare their quota-provider family's score; accounts within a provider share\nthat score. The last order is saved per project as `usagePanel.providerOrder`\nin `.pi/workspace.jsonc`, restored together with disclosure state before quota\nrequests start, and used throughout loading. Partial, stale, failed or empty\nhistory never resets that order. Only a complete `ready` snapshot with valid\ncalls can update it. Equal call counts retain the saved relative provider order;\nnew providers without a saved rank and accounts within each provider use a stable\nprovider/account fallback. Tokens and cost are not popularity proxies. While\n**Provider limits** is expanded it also consumes the shared history snapshot\nfor this ordering, without mounting or calculating collapsed historical charts.\nQuotas still render if history is empty or unavailable.\n\nDisclosure state is project-local in `.pi/workspace.jsonc` under\n`usagePanel.collapsedSections`. Stable ids (`provider-limits`, `overview`,\n`activity`, `daily`, `models`, `sessions`, `cache`) survive metric/filter changes,\npanel reopening and application restart. Missing ids default to expanded.\nChanges preserve JSONC comments and sibling settings, serialize accepted toggles\nacross panel reopening, and retry conditional-write conflicts without dropping\nother sections' changes. Malformed configuration is not overwritten; failures\nremain visible and are sent to Desktop diagnostics. Late restores cannot undo\nuser input or apply another project's state; accepted writes remain scoped to\ntheir original project even after panel teardown.\n\n","startLine":24,"endLine":110},{"path":"wiki/operations/desktop-lsp-onboarding.md","quote":"- After installation Desktop writes the fixed server template and returned\n  executable path/env into the trusted user\n  `~/.config/pi/pi-tools-suite.jsonc` LSP server list. JSONC comments and\n  unrelated settings are preserved, an existing server with the same ID is\n  replaced, and optimistic conflict checks retry before failing visibly.\n- Project-local `.pi/pi-tools-suite.jsonc` trust semantics are unchanged.\n  Installing an LSP does not auto-trust or rewrite project-local LSP commands.\n\n## Lifecycle and concurrency\n\n- Workspace changes clear pending warning/install UI state. A late native\n  installation result from the previous workspace is rejected before a new\n  user-config registration begins and cannot overwrite installer UI for the new\n  workspace.\n- Native package installation may already have written files before a workspace\n  switch. A global user-config write that was already started may still finish;\n  it is an approved global registration and stale UI completion is ignored.\n- Session teardown clears that session's visible or pause-pending suggestion.\n\n## Related files\n\n- `external/pi-tools-suite/src/lsp/onboarding.ts`\n- `external/pi-tools-suite/src/lib/lsp.ts`\n- `external/pi-tools-suite/test/lsp-onboarding.test.ts`\n- `desktop/src-tauri/src/lsp_install.rs`\n- `desktop/src/lib/lsp-onboarding.ts`\n- `desktop/src/app/lsp-onboarding.svelte.ts`\n- `desktop/src/components/TranscriptPane.svelte`\n- `desktop/src/components/LspInstallPane.svelte`\n- `desktop/src/lib/workbench-tabs.ts`\n- `desktop/src/app/workbench-model.ts`\n\n## Verification\n\n- pi-tools-suite onboarding tests cover catalog matching, registered-server\n  suppression, and the structured private state event.\n- Desktop helper tests cover trusted event parsing, comment-preserving/conflict-safe\n  JSONC server registration, pause-pending teardown, serialized installation,\n  and stale workspace completion.\n- Workbench/model and source-level regressions cover the centered warning,\n  pause/install wiring, dedicated installer tab, and no-auto-continue copy.\n- Native Rust tests pin the trusted installer catalog and reject arbitrary\n  installer identifiers.\n","startLine":77,"endLine":119},{"path":"wiki/development/release/ci-release.md","quote":"- `npm run check:ci:preflight`\n- `npm run check:ci` (after installing native-host prerequisites)\n- `node --import tsx --test tests/node-version.test.ts`\n- `npm run check`\n- `npm run test:release`\n- `npm run test:tools-suite` with an isolated `HOME` when reproducing CI defaults locally\n- `git diff --check`\n\n## Tests\n\n- `scripts/release/test/workflow.test.mjs`\n- `tests/ci-gate.test.ts`\n- `tests/ci-preflight.test.ts`\n- `tests/ci-test-contracts.test.ts`\n- `tests/ci-history-report.test.ts`\n- `external/pi-tools-suite/test/evals/compress-schema.test.ts`\n- `external/pi-tools-suite/test/comment-checker.test.ts`\n- `external/pi-tools-suite/test/evals/session-token-efficiency.test.ts`\n- `tests/node-version.test.ts`\n- `tests/voice-controller.test.ts`\n- `acp/test/git-assistant.test.ts`\n- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`\n- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`\n- `acp/test/registry.test.ts`\n","startLine":193,"endLine":216},{"path":"wiki/assistants/observer/evaluation.md","quote":"the current prompt/schema/corpus and do not establish current model quality.\n\nReport outcomes are `tp`, `tn`, `fp`, `fn`, `wrong_notice`, `invalid`, `error`,\n`timeout`, `cancelled` and `not_run`. `wrong_notice` means rubric mismatch,\nnot an independent semantic verdict. Missing attributable usage is a transport or\naccounting failure, matching the production controller's refusal to display it.\n\nMetrics are deliberately separate:\n\n- Precision proxy = `tp / (tp + fp + wrong_notice)`; it is `null`/`n/a` when no\n  notice was emitted. Recall = `tp / all planned positive cases`, conservatively\n  including failed/unrun positives. An always-silent model therefore fails.\n- False-positive rate = `fp / planned negative cases`; correct-silence rate =\n  `tn / planned negative cases`. Inspect these together with coverage: failed\n  negative requests are not evidence that a model knows when to remain silent.\n- Valid-response coverage, per-case latency, p50/p95 latency, input/cache/output\n  usage and provider-reported cost remain separate. Zero reported cost does not\n  imply free subscription usage; missing usage is explicit and not reconstructed.\n\n**Read every emitted notice, including automated passes.** Check whether it names\nthe actual consequence, attributes the change to the correct actor/time, avoids\nunsupported claims, and warrants interrupting the user. Record accept/reject/unsure\nwith a reason beside each notice. Do not call this small development set a\nheld-out benchmark or extrapolate its precision to real coding sessions. Keep the\nsame corpus/prompt/config hashes when comparing runs; after tuning on failures,\nadd fresh cases before claiming generalization.\n\n## Reports and exit status\n\nEach live run creates a unique `.pi/artifacts/heads-up-eval-*/` with:\n\n```text\nresults.jsonl     Incremental visible responses and results\ninputs.json       Sanitized model inputs and separate, model-hidden rubrics\nreport.json       Results, metrics, served model, config and source hashes\nreport.md         Readable comparison plus all responses, including passes\nempty-workspace/  Provider-discovery cwd; no session transcript\n```\n\nJSON metadata records selected models, repetitions, code hashes, corpus hash,\nsystem-prompt hash, Git HEAD, timing and whether hashed files changed during the\nrun. The Git commit alone is insufficient for an uncommitted worktree. Reports\nexclude hidden reasoning, credentials, headers and raw provider errors. They are\nlocal scratch artifacts subject to Pix cleanup; copy reports elsewhere before\ntheir TTL expires when retaining benchmark evidence.\n\nExit 0 means fixture validation or all **automated** live checks passed, not\nproduction readiness. Exit 1 means a quality/rubric failure. Exit 2 means invalid\narguments, unavailable credentials/model, incomplete execution or source drift.\nAn interrupted process may only leave `results.jsonl`.\n\n## Initial observations (2026-10-04)\n\nTwo real runs used `openai-codex/gpt-6-luna` with the unchanged production prompt,\n900 output tokens, low reasoning and a 20-second timeout. Each sent 18 requests.\nBoth produced seven warnings and eleven correct abstentions, with no invalid\nJSON, provider errors or timeouts. The datasets are synthetic development cases,\n","startLine":143,"endLine":199},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n   outgoing payload. `after_provider_response` treats HTTP status as diagnostic\n   acceptance only. A successful finalized assistant `message_end` can promote\n   provider evidence when the local attempt is unambiguous. This evidence is\n   runtime-only and returns to unknown after restart.\n6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.\n   Durable decisions are appended at their mutation/publication boundary.\n\nPlain `custom` entries are not provider messages. `dcp-journal` must never be\nstored as `custom_message` or copied into a model-facing tool result.\n\nAsync-subagent common spawn explicitly loads `dcp/subagent.ts` for every role\nand attempt, without interactive `/dcp` commands or the full suite. The normal\nDCP configuration and model overrides still apply. Enabled `compress` survives\nrestricted/empty work-tool lists, CLI exclusions and model selection; read-only\nchild/council guards allow this context-only operation. Async children are always\n","startLine":1,"endLine":67}],"notices":[],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":67,"excerptedSources":11,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"conflicts"}} -->

# Session usage and billing accounting

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix TUI and Desktop one session-spend view that reports recorded billable
usage, includes async sub-agents, and does not confuse account-wide quota
percentages with spend attributable to one conversation.

## Accounting

- Session spend is the sum of recorded billable calls in the persisted session,
  including abandoned/forked branches. Rewinding conversation ancestry does not
  undo provider billing, so a spend view must not hide calls merely because they
  are no longer on the active branch.
- Normal assistant-message `usage`, explicit session `usage` entries, and usage
  attached to compaction/branch-summary/tool-result entries participate when
  present. Provider/model attribution comes from assistant or explicit usage
  records; usage without that identity remains `Unattributed` rather than being
  guessed.
- Totals expose recorded input/output/cache token counters and total tokens.
  Monetary totals normally use the recorded `cost.total` already stored by Pi.
  For `pi-claude-code-provider` calls with zero/missing cost, known original
  Anthropic model tariffs estimate API-equivalent spend from separate input,
  output, cache-read and cache-write counters (including one-hour cache writes).
  Positive recorded cost is never replaced. Other providers, unknown models and
  total-token-only records are not repriced; persisted entries are not modified.
  Explicit original model IDs use their exact SDK catalog entry. Subscription
  aliases use the bridge's current defaults: `opus` → `claude-opus-5-5`,
  `sonnet` → `claude-sonnet-5`, `fable` → `claude-fable-5-1`, and
  `haiku` → `claude-haiku-4-5`. Historical alias calls cannot prove their served
  version and therefore remain estimates using these defaults.
- The breakdown groups recorded/estimated spend first by provider and then by model.
  Each model row owns its combined token/cost totals regardless of whether a
  call came from the parent agent, an async sub-agent, a retry, or a fallback.

## Async sub-agents

- Every finalized child assistant `message_end` carries provider/model/usage.
  The async-subagents runner mirrors that usage into the originating parent
  session through Pi's durable `appendUsage` entry with kind `async-subagent` and
  a versioned JSON note containing `runDir` and `agentId`. Legacy `agent:<id>`
  notes remain readable.
- The originating parent session manager is captured by the tool invocation and
  owns the usage append. A background agent finishing after a tab/session switch
  must never charge the newly active session.
- Retries and model/provider fallbacks are intentionally counted per finalized
  child assistant call; each provider call was billable even if a later retry or
  fallback ultimately produced the accepted result.
- The runner also appends version-1 `pi-tools-suite:subagent-statistics` custom
  entries on that captured parent manager: task preview (id, role, icon, requested
  model, task and scope), tool execution starts (name), and terminal state.
  Optional telemetry failures must not interrupt execution or billing. No tool
  arguments/results or child transcript are copied. Tool counts are starts,
  including failed/cancelled calls, not successful completions.
- Durable statistics group by `(runDir, agentId)` rather than agent id alone.
  Earlier spawn tool-result previews may recover task metadata. Legacy id-only
  usage matches a unique known run, or remains a legacy id row when no run is
  known. Ambiguous/missing notes are included in child-unattributed totals;
  missing billing and tool telemetry are shown as unknown, never invented zeros.
  Status/lookups of other runs do not make those runs part of this session.

## UI behavior

The experimental [Heads up observer](../assistants/observer/heads-up-observer.md) also records finalized
side-inference usage in the originating session, using the `heads-up` usage kind.
A dismissed or stale finding does not erase the request's usage. Provider
failures that return no usage cannot be reconstructed. Its model rows participate
in the same provider/model breakdown; its own status additionally reports check
and token counters without estimating subscription quota.

The temporary [Desktop BTW chat](../desktop/conversations/desktop-btw.md) records finalized side-response
usage with the `btw` kind in its original parent session. It does not persist side
questions/answers. Cancelled or discarded results still count when the provider
returns usage; calls without usage cannot be reconstructed. An accounting failure
blocks further BTW inference until reload rather than silently losing known spend.

- In Pix TUI, clicking `Usage` opens a session-owned dialog with on-demand
  loading, guarded refresh and retryable errors; repeat activation closes it.
  Desktop opens it only on
  button activation (click, Enter or Space), not hover or mere focus. Neither
  forces a provider quota refresh. See [status-bar click popups](../decisions/0048-status-bar-click-popups.md).
  Desktop keeps the panel open after pointer departure. Repeat activation closes
  it without another spend request; Escape, outside pointer interaction or focus
  leaving the trigger/panel region also dismiss it. Escape restores trigger focus.
- The compact session detail remains intentionally compact and does not split parent-agent
  and sub-agent consumption into separate presentation rows; both are one session.
  Desktop keeps recorded cost in its on-demand detail popover, but does not show a
  dollar amount inline in the status bar. TUI also keeps money out of the status
  bar, but now shows recorded costs in its on-demand breakdown (with compact
  text bars for token shares when several models contributed).
  Its separately labelled, account-wide Limits section uses only cached
  hourly/weekly quota windows and reset-credit metadata; opening Usage never
  polls the provider. `Provider pages` offers the same allowlisted external
  destinations as Desktop. `Refresh limits` on Claude Code is an explicit
  quota-only refresh, distinct from `Refresh spend`.
  In Desktop, the `Session usage` header shows the shared provider logo
  immediately after the title for the currently selected session model.
  This follows the active model selection, not the providers in historical
  recorded spend; unknown providers and Auto routing reserve no icon slot.
  Desktop adds a `Subagents` button at the right of the Session usage header,
  shown only after a spend snapshot loads with a nonempty subagent call list.
  It is hidden while the snapshot is unavailable, when the optional breakdown
  is absent, or when its call list is empty; calls without recorded billable
  usage still qualify. It opens a separate native modal with
  rotating-chevron task disclosures, role icons, requested/recorded models,
  tool-start counts, exact token categories and per-run token/cost totals.
  Between `Session usage` and `Subagents`, active Claude Code routes or sessions
  with recorded Claude Code calls additionally
  show a compact OAuth-account select populated from the user-level
  `pi-tools-suite.jsonc`. A named selection saves the preferred profile for
  **future** model requests using a compare-and-swap JSONC write, without
  changing any currently streaming request. `Default` or `Auto` clears that
  preference depending on rotation mode. `Last: <name>` indicates the
  profile most recently attempted in this session; it is not a billing/quota
  attribution guarantee. Saved quota rows may still reflect a prior login,
  and merely selecting a profile never triggers network quota polling.
  Sessions without active or recorded Claude Code calls do not render this
  selector. With no configured OAuth
  profiles, the selector and last-attempted-account label are entirely hidden;
  configuration remains in Tools Suite Settings. Details of profile selection
  and bounded fallback belong in
  [Claude Code provider](../providers/claude-code-provider.md).
  The modal shows the list of subagent calls and their expandable details,
  without run statuses, session-wide totals, main-agent comparisons or explanatory
  banners/footer. The role icon sits directly before the role name in a fixed
  semantic blue, independent of status or primary accent. Recognized providers
  use shared provider logos before recorded/configured model labels in the summary;
  expanded details do not repeat model labels or a model table. Unknown providers
  keep text labels without an empty icon slot. Tool calls appear as a list of
  names/counts only when nonempty, without a heading or unknown/empty-tool text.
  The Run path is immediately clickable when project navigation is available,
  without an existence check while rendering. Only activation validates that the
  directory exists inside the current workspace; a valid target closes the modal
  and reveals the folder in Project Files. Missing or inaccessible targets remain
  plain text after a failed activation. Session/workspace changes and teardown
  invalidate stale completions. Changed files and their coverage gaps are not
  displayed in this modal; optional durable changes data remains available in
  the usage protocol independently of presentation.
  Completed runs remain visible; no active-only HUD or child-file
  traversal is used. Old runtimes without the optional breakdown show an
  unavailable message. Refresh uses the same guarded spend request, never quota
  refresh or model inference, and retains the last snapshot on failure.
  Escape/backdrop/close dismiss only the modal and return focus to its invoker;
  the underlying Usage panel remains open, and session teardown removes both.
  Backend accounting still conserves main, subagent, side-call and unattributed
  usage independently of this list-only presentation. Estimated per-run costs
  in this modal use `~` for API-equivalent pricing.
  TUI exposes the same persisted child-run breakdown with a `Subagents (n)`
  action, a keyboard-searchable selector and a separate per-run dialog.
  It displays role icons, recorded/configured models, task/scope, available
  tool-start counts, exact input/output/cache counters, per-run tokens/costs,
  and run identity; unknown telemetry stays explicitly unknown. Estimated
  child costs use `~`. As on Desktop, it omits statuses, main-agent comparisons,
  explanatory banners and change-coverage summaries. `Open run` validates
  existence and canonical containment in the current workspace only when
  activated; failed targets cease to be actionable. The dialog can scroll
  using the mouse wheel; leaving the selector returns to Usage, while a valid
  opened run returns to its session summary. PageUp/PageDown also scroll
  longer dialog details from the keyboard. Session/tab changes prevent
  stale reads, menus and run validation from resurfacing an old popup.
  Desktop displays monetary values without an approximation prefix; estimated
  model values explain in an accessible label that these are original-model API rates, not
  subscription charges. `costEstimated` propagates from calls to model, provider
  and session totals through ACP.
  Known subscription provider headings offer an accessible external-link icon:
  Claude Code opens `https://claude.ai/code#settings/usage`; OpenAI Codex opens
  `https://chatgpt.com/settings/usage?tab=overview`; z.ai (`zai`) opens
  `https://z.ai/manage-apikey/coding-plan/personal/usage`. Unknown providers get no guessed URL.
  The native external opener launches the page in the system browser, without
  refreshing quota or making a model call. Failed opening shows a retryable error.
- Model labels use the same model-color conventions as the rest of Pix. TUI
  honors configured `modelColors` rules with the normal provider-palette
  fallback; Desktop uses its matching model-ref tone mapping and shows the
  shared provider glyph beside each recognized provider heading.
- Desktop loads the spend report on demand through `pix/session/usage`; TUI reads
  the owning session's complete persisted entries on demand. Opening the popup
  does not start a model request and does not refresh provider quota. TUI
  retains the last successful report after an explicit spend refresh fails.
- For an active Claude Code provider session, Desktop also offers an explicit
  `Refresh limits` action in this popover. This action is separate from opening
  Usage and from recorded session spend; it nudges a bounded headless Claude
  CLI, then queries Pix's quota endpoint and updates the independent status-bar
  limits. It never interprets CLI output as billable usage or quota.
- Active TUI/Desktop sessions expose `Usage` even when their provider has no
  quota API, because recorded session spend does not depend on quota support.
- Desktop marks session spend requestable only after that session's Pi runtime is
  ready. If the popover was opened during runtime warm-up, it starts the request
  when readiness arrives instead of leaving an ambiguous unloaded state. A failed
  first load is shown as an explicit retryable error; if an older successful
  snapshot already exists, that snapshot remains visible after a refresh failure.
- A Desktop UI-only draft has no session spend and the session-spend popup does
  not manufacture quota-only content for it.

## Quota percentages

- Current provider quota APIs do not provide a reliable mapping from recorded
  per-model token/cost usage to account quota percentage points, nor do they
  identify which concurrent session consumed those points.
- The recorded-spend breakdown shows no quota percentages and no synthetic
  provider/session-share percentage. Desktop's shared Usage surface additionally
  combines weekly cycle dates and remaining quota on one timeline in a labelled **Limits**
  section, alongside the hourly remaining-quota row when supplied. Header-derived rate
  windows remain status-bar-trigger-only. This is account-wide telemetry,
  never session-attributed usage. See [usage limits and model
  chart](desktop-quota-calendar.md) and [decision
  0039](../decisions/0039-quota-reset-calendar.md), which supersede the
  former no-account-quota-block rule for this explicitly separated section.
  Session-attributed values are recorded token totals and recorded/estimated
  model costs, not an allocation of subscription quota or payment.
- When the recorded-spend breakdown includes more than one model with nonzero
  tokens (across any providers), the same Usage surface also shows a
  provider-agnostic donut chart of token share by model, directly above the
  existing provider/model table. With zero or one model with nonzero tokens it is omitted;
  the existing table is unaffected either way.
- Existing hourly/weekly account quota polling and status-bar indicators remain
  independent runtime chrome; opening the session-spend popup never refreshes
  them. The Limits section and model donut use the existing runtime/session-usage
  snapshots, not a new request.

## Lifecycle and concurrency

- Desktop session-usage requests have a per-session generation guard independent
  of runtime-status, quota, and DCP generations. Forget/reset invalidates stale
  completions and their busy-state cleanup; an old request cannot repopulate a
  reopened session.
- TUI waits for the full-session read and validates the captured session owner
  and tab lifecycle before showing a dialog. Stale completion is discarded.
- Loaded Desktop spend snapshots are scoped to their session and cleared when
  that runtime is forgotten or the ACP connection resets.
- Running async sub-agents do not intentionally disable session-usage reads.
  Usage already durably mirrored into the parent session remains readable; a
  child call that has not finalized yet is not counted until its usage entry is
  appended.

## Protocol

- `pix/session/usage` accepts `{ sessionId }` and returns `{ sessionId, usage }`.
- ACP reads Pi's persisted entries with the flat append-order `getEntries()` RPC
  and runs the shared Pix session-usage aggregator over all of them. It does not
  ask a quota provider or synchronously traverse the JSONL file, and it avoids
  the nested `get_tree` response, which cannot be JSON-serialized once a linear
  session chain grows past the RPC process stack limit.

## Implementation

- `src/app/session/session-usage.ts`
- `src/app/session/session-usage-pricing.ts`
- `src/app/session/session-subagent-usage.ts`
- `src/app/session/session-subagent-changes.ts`
- `src/app/screen/mouse-controller.ts`
- `src/app/model/model-usage-controller.ts`
- `external/pi-tools-suite/src/async-subagents/core/usage.ts`
- `external/pi-tools-suite/src/async-subagents/core/statistics.ts`
- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/session-usage.ts`
- `desktop/src/lib/subagent-usage.ts`
- `desktop/src/lib/subagent-usage-parser.ts`
- `desktop/src/lib/project-path-navigation.ts`
- `desktop/src/lib/validated-project-path.ts`
- `desktop/src/app/session-runtime-status.svelte.ts`
- `desktop/src/components/RuntimeStatusBarItems.svelte`
- `desktop/src/components/SubagentUsageDialog.svelte`
- `desktop/src/components/ValidatedProjectPath.svelte`

## Tests

- `tests/session-usage.test.ts`
- `tests/session-subagent-usage.test.ts`
- `tests/session-subagent-changes.test.ts`
- `tests/mouse-controller.test.ts`
- `external/pi-tools-suite/test/async-subagents-usage.test.ts`
- `external/pi-tools-suite/test/async-subagents-statistics.test.ts`
- `acp/test/agent.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/session-usage.test.ts`
- `desktop/src/lib/subagent-usage.test.ts`
- `desktop/src/lib/project-path-navigation.test.ts`
- `desktop/src/lib/validated-project-path.test.ts`
- `desktop/src/components/SubagentUsageDialog.test.ts`
- `desktop/src/app/session-runtime-status.test.ts`
- `desktop/src/components/StatusBarHover.test.ts`

## Verification

- Shared unit tests cover provider/model grouping, merging parent and async-agent
  calls into one model total, unattributed usage, and the compact formatter.
  `tests/session-usage.test.ts` also covers proxy aliases, explicit original IDs,
  separate cache tariffs, one-hour writes, estimate propagation, preservation of
  positive cost/unknown models/other providers, and immutable persisted records.
- TUI mouse tests assert that Usage opens the compact colored token breakdown and
  contains no monetary price, agent/subagent split, session-share percentage, or
  quota block.
- Async-subagents tests validate child `message_end` extraction and durable usage
  append on the captured parent manager; statistics tests cover captured-parent
  task/tool/state telemetry and session aggregation, including ambiguous legacy
  identities and missing telemetry.
- Root subagent usage tests cover aggregation and conservation. Desktop tests
  cover parsing and formatting; dialog source-contract tests pin content,
  dismissal wiring and disclosure affordances, not rendered interactions.
  Native UI behavior requires separate UI QA.
- Desktop ACP-client and runtime lifecycle tests cover the independent usage
  request and stale forget/reset completion handling.
- Desktop source-contract tests pin click-only popup activation, dismissal and
  Usage content placement; they do not establish rendered or native UI behavior.

## Related

- `wiki/usage/desktop-usage-stats.md`: account/machine-wide usage history panel
  (per-provider sources, never summed); its `pix-sessions` source reuses the
  session usage extraction described here.

## Risks / compatibility

- Old sessions created before async-agent usage mirroring cannot reconstruct
  exact historical child-agent cost unless that usage was already persisted by
  another mechanism. Pix reports what is recorded; it does not invent missing
  historical spend.
- Providers may report zero monetary cost while still reporting tokens. Only the
  known Claude Code proxy uses the documented API-equivalent estimate fallback;
  it is not the actual subscription bill. TUI presentation remains token-only.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"fe260719da6cf3acb81828a41afef35e289982671f5fa36453f8bf56a2c013c2","checkedAt":"2026-10-30T23:30:52.627Z","maxDocumentChars":128000} -->
