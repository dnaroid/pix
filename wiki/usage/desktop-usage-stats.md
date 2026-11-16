---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-11-16T15:08:39.564Z","result":{"path":"wiki/usage/desktop-usage-stats.md","documentHash":"ee193e8e2f1d267386610f11c417aaa42e4038f3f65cb1884b5ee6991a44df70","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (shared eye-in-triangle glyph), background jobs, Plan, the session activity HUD (Steps/Subagents), then notifications; conditional controls are omitted when absent. There are no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged. This replaces the historical icon, ordering and inter-group separator choices recorded in [0037](../decisions/0037-status-bar-hover-details.md).\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n","startLine":1,"endLine":29},{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n","startLine":1,"endLine":38},{"path":"wiki/desktop/conversations/desktop-session-parity.md","quote":"- Changing ACP session deletion semantics.\n\n## Behavior\n\n- Pix Desktop's ordinary project-scoped `session/list` returns the persisted\n  ACP session map immediately instead of synchronously parsing every native\n  JSONL transcript (large projects can contain hundreds of megabytes of saved\n  conversations). Native TUI/Desktop discovery reconciles in the background. A successful\n  changed-directory scan emits `pix/session/catalog_changed` with the owning\n  project cwd; Desktop then reloads the list and includes the new sessions.\n  The first response may temporarily precede discovery, but never blocks on it.\n  Desktop restoration first requests this fast list. If it omits any session ID\n  in that workspace's saved Desktop tab snapshot, Desktop retries with\n  `_meta['pix.waitForDiscovery']=true`; ACP waits for the coalesced native\n  discovery before returning the authoritative list. Confirmed absence can then\n  prune stale saved tabs. If discovery fails or is aborted, the list request\n  fails and restoration leaves the saved snapshot untouched while reporting the\n  error. When every saved tab is present in the fast response, restoration does\n  not wait for discovery. Stale workspace/client/generation responses are\n  ignored.\n  Other ACP clients retain synchronous, fully reconciled `session/list`.\n- Native background scans are single-flight per cwd and pre-scan a directory\n  revision from file names and filesystem fingerprints (device, inode, size,\n  modification time and change time). The first discovery reads the JSONL\n  files but retains only per-file title, first-prompt, activity and fork\n  metadata—not full-transcript/search text. Later scans reread only files whose\n  fingerprint changed; stable files are not parsed again. A file changing\n  during a read is not acknowledged as consumed, and failed/aborted reads are\n  retried. Deleted files are pruned from the per-file cache. The metadata cache\n  is scoped to the ACP adapter and cleared during teardown. Discovery uses the\n  configured Pi agent directory.\n  Failures retain mapped conversations and allow retries. A running scan is\n  canceled during adapter teardown, and stale connection/workspace notifications\n  cannot modify an unrelated Desktop catalog. Notifications received during an\n  in-flight initial list or refresh are replayed after that request settles.\n- A discovered native session is persisted in the ACP map so `session/load` can open it later.\n- Reconciliation deduplicates by resolved Pi session path and retains an existing ACP ID when present.\n- ACP session listings remain ordered by descending `updatedAt`. Native Desktop reconciliation and default SDK-based ACP discovery set `updatedAt` from the JSONL file's filesystem modification time, not its creation or message timestamps. Consequently, metadata-only edits reorder a session, including edits to a session with no messages.\n- Reconciliation persists the native parent-session path internally when present. `session/list` exposes a boolean `pix.isFork` and, when the parent is already mapped, its safe ACP id as `pix.parentSessionId` in that session's namespaced metadata; Desktop never receives a parent path.\n- The response carries ordered TUI open-tab session IDs in namespaced ACP metadata.\n- Desktop uses the returned sessions as the source for saved-session discovery. Restart restoration uses only the persisted Desktop tab snapshot; if none exists, Desktop treats it as empty and opens the draft rather than falling back to TUI tab state. The TUI snapshot remains an input only to later live reconciliation. The titlebar contains the persisted Desktop real tabs, subsequently reconciled TUI tabs, Desktop-opened tabs, and the active session.\n- Desktop and TUI both use UI-only draft tabs for new conversations. A draft is\n  not an ACP/Pi session and never participates in `session/list`, restored TUI\n  metadata, persisted Desktop active-session ids, or the persisted TUI\n  real-tab snapshot.\n- In either client, opening a draft or editing its composer does not create a\n  session. Selecting a saved session replaces the draft directly; a new real\n  session is materialized only on the first prompt or action that requires a\n  Pi session.\n- Desktop's embedded chooser and TUI's draft-tab-surface chooser present only returned\n  sessions that are not already represented by real tabs, so already-open or\n  running conversations are not duplicated there.\n- Without a search query, Desktop saved-session surfaces keep the same fork ordering as TUI: roots and siblings are sorted by descending `updatedAt` and each child follows its parent. Desktop draws thin SVG ancestry lines with rounded turns and small nodes instead of textual connectors. Separate keyboard-accessible, state-rotating Lucide chevrons collapse/expand descendants without selecting a conversation. Hover/focus highlights the row and its direct parent/children. Search results remain flat ranked matches while retaining fork markers and include descendants of collapsed branches. The initial cached response/background reconciliation behavior is unchanged; fork grouping and open-tab ordering are unchanged.\n- When restoring an older mapped session whose persisted history is unavailable, Desktop first waits for the concurrent runtime load. A loadable empty session is retained; only a record whose history and runtime both fail is cleaned up. Runtime-load generations prevent a late completion from repopulating state after that cleanup.\n- Per-session activity indicators may decorate titlebar tabs, but runtime activity never changes restored membership, ordering, close semantics, or saved-session discovery.\n- Missing or malformed TUI tab snapshots do not break session listing. A stale TUI snapshot cannot resurrect a tab during Desktop restart, including when the Desktop snapshot is missing or explicitly empty; both cases restore the draft instead of old real tabs.\n- Overlapping Desktop refreshes cannot apply results from an older workspace or ACP connection.\n- A refresh requested while the startup listing for the same connection and workspace is pending (session selector, native discovery) joins that listing instead of superseding it, so startup never loses its response and always restores a session or opens the draft.\n- If native discovery fails, mapped ACP sessions remain available.\n\n","startLine":29,"endLine":88},{"path":"wiki/desktop/workbench/desktop-window-state.md","quote":"  The maximization plugin still operates in those launches; logical geometry is\n  not persisted unless the native restore QA opt-in below is enabled.\n- Native restore QA can explicitly set `PI_UI_QA_WINDOW_RESTORE=1` alongside\n  `PI_UI_QA=1`: membership uses `qa-open-windows.json` and geometry uses\n  `.qa-restore-window-state.json` for maximization, never the user's snapshots. The initial QA\n  workspace override applies only when no windows were restored. Smoke still\n  disables membership restoration even if the QA restore opt-in is set.\n\n## Contracts\n\n- Window state is stored in Tauri's application configuration directory.\n- Normal size/position are owned by `window_geometry`/`window_restore`; the\n  official window-state plugin persists/restores **only maximization**. It must\n  not independently apply physical size/position after logical builder geometry.\n- Geometry is keyed by stable window label. Membership/workspaces/logical geometry use a versioned,\n  bounded `open-windows.json` in the same application configuration directory,\n  atomically replaced during clean exit on the existing shutdown worker.\n- Frontend pane layout uses localStorage keys under\n  `pix.desktop.windowLayout.\u003cencoded-window-label\u003e.\u003cpreference\u003e`. Windows sharing\n  a project or webview origin cannot overwrite each other's layout. Reload and\n  relaunch retain layout when the native label is retained; switching projects\n  within a window keeps that window's layout. Browser preview has its own namespace.\n- Legacy shared pane keys are not imported: their last writer cannot identify\n  the owning window. Each window starts with default panes once, then remembers\n  its own choices. Session-tab snapshots and active-session pointers also use\n  this window namespace (`sessionTabs` / `activeSessions`), retaining per-project\n  maps within each window. Legacy shared session keys are not imported either;\n  windows start with a draft once, without deleting saved sessions. Shared recent\n  projects and transient menus/dialogs are unchanged.\n- Native move/resize/close callbacks cache only normal logical geometry, with no\n  disk IO. Explicit Quit captures live normal geometry and freezes it with the\n  membership snapshot before background teardown; late events cannot mutate it.\n- Configured automatic main-window creation is disabled; native startup creates\n  either the saved window set or one default main window.\n\n## Verification\n\n- Run `cargo check --manifest-path desktop/src-tauri/Cargo.toml`.\n- Run the desktop checks and tests.\n- Run Rust `window_restore::tests` for snapshot validation, stable labels,\n  encoded workspace routes, last-window close and frozen teardown ordering.\n","startLine":103,"endLine":143},{"path":"wiki/desktop/rendering/desktop-tool-rows.md","quote":"\n## Behavior\n\n- File tools show the path instead of repeating a human title such as `read Read path`.\n- Reads of `SKILL.md` (direct `read` and the TUI-recognized non-mutating shell reader commands) display as `skill \u003cdirectory name\u003e` in child rows; in the collapsed group header they use the same accessible label and a GraduationCap icon. Lightweight replay omits `rawInput` until a result is expanded, so direct reads also classify from the tool location or read title at ingestion. Arbitrary shell programs are not classified by inspecting their effects. The skill name is cached during tool ingestion/update so collapsed headers never inspect `rawInput`.\n- Expanded activity-row icons use the same `activityIcon` tool-identity mapping as the collapsed trail, including Image for image reads and Wrench for unknown tools; lifecycle status is communicated by color, while the accessible label and tooltip retain the status. Pending is muted, in-progress is primary, completed is success, failed is error, and completed attention is warning/error as appropriate. Thinking uses the brain identity icon, primary while started without an end and success when completed (including historical thoughts without timing metadata). The collapsed icon trail remains unchanged and is not mounted while the group is expanded; its expanded header instead has a screen-reader-only “Tool activity” label alongside the disclosure chevron and duration. Image `read` classification is cached at transcript ingestion from `path`, `file_path`, or `filePath`, ACP location, a Read title's image-file extension, or an image output attachment; collapsed rendering never parses payloads.\n- Read ranges use the TUI `path:offset+limit` form.\n- Expanded source reads use theme-aware syntax highlighting by file extension, including `.gd` GDScript (keywords, types, strings and hash comments). Legacy read titles with range suffixes also resolve their source language. Unknown languages and oversized sources retain escaped, untruncated plaintext; directory listings remain plain.\n- Shell commands collapse whitespace to one line.\n- Expanded `codemode`, shell/execution aliases, `repo_*`, `ast_grep`, `ast_apply`, `subagents`, `brainstorm`, `web_search`, and `question` rows show full raw input in an explicitly labeled Input block before Result. Fields and nested tasks/questions are readable without JSON string escaping; multiline strings remain intact. No separate input block is added for `apply_patch`, reads, web fetches, planning or session tools. Existing patch presentation remains unchanged.\n- Selected calls with input but no result can still expand. Input formatting is deferred until the individual disclosure mounts; lightweight replay continues hydrating input/result only on demand.\n- Expanded executable inputs use the shared theme-aware syntax highlighter: JavaScript for `codemode`, shell syntax for shell/execution aliases. Other tool inputs remain plain text. Input keeps soft wrapping and all supplied fields; the shared large-source safeguard falls back to escaped plaintext without truncation.\n- Expanded text input/result panels grow to at most `min(480px, 60vh)` rather than 220px. They contain scroll chaining at both boundaries, so wheel/trackpad scrolling inside a panel does not move the surrounding chat at its start/end. Outside the panels chat scrolling remains normal.\n- Each expanded tool body has its own keyboard-accessible gutter button. Clicking it closes only that tool disclosure, unmounts its body and restores focus to its summary; the enclosing activity group and sibling disclosures stay open.\n- Search, repository, question, todo, subagent, and unknown tool inputs use compact TUI-style summaries.\n- The single `session` tool uses the subdued context tone. At ingestion, exact `action` values cache safe activity labels: `name` distinguishes title reads from renames, `search` searches session history, and `overview`/`read`/`recovery` review it. Missing/unknown action falls back to `Reviewing session`; rendering never reads raw payloads to choose a label. Old session tool names have no special presentation mapping.\n- `repo_context` rows put their query first and show their path prefix before limits; their discovery role is search. `repo_audit` shows every task-changed path before options and uses inspect. Historical `repo_ask` and `repo_knowledge` calls retain their legacy argument presentation for replay compatibility.\n- Tool names use operation roles (`inspect`, `search`, `mutation`, `execute`, `interact`, `context`, `agent`, `skill`, `compress`, `neutral`) rather than outcome roles such as success or warning: reads/audits are teal inspection, discovery/search is blue or indigo, execution is amber, mutation is magenta, interaction is blue, delegation is violet, skill reads are lime/olive, compression is copper, and other session/planning/orchestration is subdued slate. These tones apply to child-row tool names; collapsed activity headers use a muted icon trail instead. Each role has readable light and dark theme tokens. Activity-row icon identity follows the shared tool mapping; icon color expresses lifecycle/attention status separately from the operation hue.\n- Legacy ACP updates without a programmatic name or raw input fall back to splitting the existing title.\n- Consecutive thinking and tool entries share one collapsible activity group until a visible user, assistant, or system message boundary.\n- Assistant prose immediately following an activity group does not gain a separator border; activity grouping changes neither transcript ordering nor assistant-prose styling. User/system messages, uninterrupted assistant prose, and a trailing activity group likewise do not imply a divider contract.\n- Collapsed activity headers show one muted Lucide icon per thinking/tool entry in transcript order, preserving all repeats; skill reads use GraduationCap, and unknown tools fall back to Wrench. Each icon has a native title and screen-reader-only label. The trail scrolls horizontally with its scrollbar hidden rather than deduplicating or truncating; one disclosure chevron and elapsed duration remain separate parts of the single-line summary.\n- For groups of up to 128 entries, all trail icons mount. Larger groups mount only icons in the horizontal viewport plus four entries of overscan on each side; a full-width spacer preserves scrolling across the complete logical trail. The full ordered label remains available to screen readers. A `ResizeObserver` tracks viewport width and disconnects on teardown; virtualization bounds icon DOM without mounting tool bodies.\n- A live thought is active only when it has a recorded start and no recorded end, so replay data without timing metadata is not presented as live.\n- Expanding an activity group preserves the original interleaving of thinking blocks and individual tool calls. Child `thinking` rows stay muted even while live; the collapsed header has no status or action text. The header uses the same muted neutral hue with distinct opacity from expanded thinking labels.\n- The group itself does not hydrate tool bodies. Individual result disclosures hydrate on demand; closed groups/results do not mount their expensive Markdown, diffs, or attachment content. Reopening retains individual disclosure state within the same session, while switching sessions resets it even when replay IDs match.\n- A completed edit result patch is preferred because it carries full context. Otherwise explicit ACP diff content is used; when both are absent (notably session replay), edit and write diffs are reconstructed from recorded raw input.\n- Apply-patch input is rendered as one diff surface for both `*** Begin Patch` and unified-diff forms.\n- Failed mutations do not present their requested patch as an applied diff.\n- The mutation result text follows the diff and preserves all text blocks in order, including normal success output, `LSP diagnostics:`, and `comment-checker` notices.\n","startLine":33,"endLine":62},{"path":"wiki/desktop/guide.md","quote":"| Windows x64 | Legacy tooling only; unsupported |\n| macOS Apple Silicon | `.dmg` |\n| Linux x64 | Legacy tooling only; unsupported |\n\nRelease packages contain their own Node.js/Pix/ACP runtime. See\n[Installing Pix](../getting-started/installation.md) for checksum verification, upgrade and legacy\ncleanup rules.\n\n## Desktop workspace\n\nPix Desktop uses one project-oriented workbench instead of reproducing the TUI\ninside a window.\n\nThe left Activity Bar exposes:\n\n- **Work** — Tasks and Plans sections; project-local SQLite tasks (`.pi/tasks.sqlite`) have full UI\n  management, Quick Add, drag-and-drop, linked sessions and SHA-256 attachments;\n  slash commands and the agent task tool supplement the UI;\n- **Project** — file explorer with keyboard navigation and external-editor\n  actions;\n- **Wiki** — project knowledge pages and consistency findings;\n- **Source Control** — branch/status, diffs, stage/unstage, commit/push, code\n  review and safe repository tools;\n- **Registry** — private Git-backed skills/agents/project-state synchronization;\n- **Launch Commands** — saved launch commands, project package scripts and interactive terminals;\n- **Search indexes** — local and semantic search-store status by source;\n- **Usage** — Pix session usage across this project or all projects, with\n  selectable time period and cost, token and call metrics;\n- **LSP** — language-server status and controls;\n- **Logs** — diagnostic logs, when enabled;\n- **Settings** — Desktop-specific model, voice, editor and Source Control\n  preferences.\n\nThe Usage panel charts support hover and keyboard-focus tooltips, and clicking\na day, hour or model toggles a chart filter. Active day/hour filters appear as\nremovable chips; chart cross-filtering keeps the relevant breakdowns visible.\nSee the [usage panel specification](../usage/desktop-usage-stats.md) for filter\nand tooltip behavior.\n\nSettings → General includes a **Theme** preference: **System** (default),\n**Light**, or **Dark**. Pix applies it through the native window appearance, so\nsystem color-scheme-aware web content follows the selected theme. Changes are\nreapplied when the window regains focus or the Desktop configuration changes.\n\nLong-lived files, media, Git diff/review surfaces, and the interactive Terminal\nopened by composer `!!` commands live in the main workbench tab strip rather\nthan modal windows.\n\n## First run\n\nThe first-run dialog verifies the bundled runtime and can optionally:\n\n- import supported OpenCode credentials without overwriting existing Pi\n  credentials by default;\n- import a static Codex `OPENAI_API_KEY` when Pi has no OpenAI credential;\n- configure optional native repository semantic search.\n\nChatGPT/Codex OAuth refresh tokens are deliberately not copied between auth\nstores.\n\nShipped defaults contain no provider/model ids. When providers are connected\n","startLine":18,"endLine":78},{"path":"wiki/tui/concurrency.md","quote":"- Deferred paste, voice, and extension UI completion target their originating tab or are discarded after that scope is removed.\n- Restoring a tab draft does not enter another tab's undo history and cannot silently overwrite input typed after activation started.\n- Tab lifecycle mutations are mutually exclusive. Failed activation rolls back or disposes newly created/displaced runtimes.\n- Persisted tab snapshots are written in invocation order with unique temporary files.\n- Replacement/history work is cancelled when runtime, session, tab, or generation changes.\n- Terminal byte chunks preserve split UTF-8 sequences and batch printable-input rendering.\n- Shutdown detaches input before awaiting cleanup and applies one bounded cleanup deadline before forced exit.\n\n## Invariants\n\n- One runtime has at most one owning tab, and replacing that ownership disposes or explicitly transfers the displaced runtime.\n- Only the active tab's scope can mutate the shared editor and visible conversation.\n- Timers and subscriptions verify runtime ownership before mutation.\n- No stale persistence snapshot can replace a newer completed snapshot.\n\n## Edge cases\n\n","startLine":34,"endLine":50},{"path":"wiki/usage/session-usage.md","quote":"- Desktop marks session spend requestable only after that session's Pi runtime is\n  ready. If the popover was opened during runtime warm-up, it starts the request\n  when readiness arrives instead of leaving an ambiguous unloaded state. A failed\n  first load is shown as an explicit retryable error; if an older successful\n  snapshot already exists, that snapshot remains visible after a refresh failure.\n- A Desktop UI-only draft has no session spend and the session-spend popup does\n  not manufacture quota-only content for it.\n\n## Quota percentages\n\n- Current provider quota APIs do not provide a reliable mapping from recorded\n  per-model token/cost usage to account quota percentage points, nor do they\n  identify which concurrent session consumed those points.\n- The recorded-spend breakdown shows no quota percentages and no synthetic\n  provider/session-share percentage. Desktop's shared Usage surface additionally\n  combines weekly cycle dates and remaining quota on one timeline in a labelled **Limits**\n  section, alongside the hourly remaining-quota row when supplied. Header-derived rate\n  windows remain status-bar-trigger-only. This is account-wide telemetry,\n  never session-attributed usage. See [usage limits and model\n  chart](desktop-quota-calendar.md) and [decision\n  0039](../decisions/0039-quota-reset-calendar.md), which supersede the\n  former no-account-quota-block rule for this explicitly separated section.\n  Session-attributed values are recorded token totals and recorded/estimated\n  model costs, not an allocation of subscription quota or payment.\n- When the recorded-spend breakdown includes more than one model with nonzero\n  tokens (across any providers), the same Usage surface also shows a\n  provider-agnostic donut chart of token share by model, directly above the\n  existing provider/model table. With zero or one model with nonzero tokens it is omitted;\n  the existing table is unaffected either way.\n- Existing hourly/weekly account quota polling and status-bar indicators remain\n  independent runtime chrome; opening the session-spend popup never refreshes\n  them. The Limits section and model donut use the existing runtime/session-usage\n  snapshots, not a new request.\n\n## Lifecycle and concurrency\n\n- Desktop session-usage requests have a per-session generation guard independent\n  of runtime-status, quota, and DCP generations. Forget/reset invalidates stale\n  completions and their busy-state cleanup; an old request cannot repopulate a\n  reopened session.\n","startLine":201,"endLine":240},{"path":"wiki/tools/agents/project-agents-dir.md","quote":"## Non-goals\n\n- User-level (`~/.config/pi/agents/`) directory — project scope only.\n- Recursive agent dirs, `.jsonc` agent files, YAML dependency, or per-agent\n  preset definitions.\n- Changes to spawn behavior, router prompt templates, or tool schemas. The\n  parent system prompt gains only the effective role catalog described above.\n\n## Regression coverage\n\nCoverage includes load/replacement semantics,\nbody→promptAppend, name\nmismatch error, no-frontmatter skip, broken YAML error with path, walk-up\ndiscovery, project preset/profile precedence, resolved\nmodel/thinking/tools/modelByParent/retry behavior, and a fresh-reload test (file\nmutated between two `loadSubagentConfig` calls).\nAdditional tests verify that bundled roles are sourced from individual Markdown\nfiles and that `before_agent_start` exposes a project-local role in the effective\nsystem-prompt catalog while omitting that catalog when `subagents` is not an\navailable tool. Config tests also cover layered bundled-role disable/re-enable,\nand core tests verify that a same-named project role survives a bundled disable,\nfully replaces omitted built-in fields, and is announced as a project\nreplacement in the parent catalog.\n\n\n","startLine":167,"endLine":191},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n","startLine":1,"endLine":48},{"path":"wiki/decisions/0072-session-native-subagents.md","quote":"(`pid`, `exit_code`, `started_at`/`finished_at`, `retry_*`, `stop_*`,\n`model_fallback_*`, `launch.json`, `prompt.md`, `result.md/json`,\n`progress.jsonl`, `todo-progress.json`, `stderr.log`, `session_file`,\n`parent_session`, …) and a locked `registry.json`. Some of this was left over\nfrom the removed no-session mode (removed in stage 1 of this redesign). TUI,\nACP (`pix/subagents/open_session` needs `runDir` + `agentId`) and Desktop all\nread the run tree directly.\n\n## Observations and sources\n\n- OpenCode: a child is an ordinary session with `parentID`; its id is the\n  `task_id` used for resume; the result returns in `\u003ctask_result\u003e`; no run\n  directory. Its on-disk layout was not verified (source fetch returned 404).\n- Claude Code: child transcripts are `\u003csession\u003e/subagents/agent-\u003cid\u003e.jsonl`\n  plus a small `.meta.json`, deleted with the parent session (default 30\n  days); role frontmatter carries `maxTurns`, `model`, `tools`.\n- Pi SDK (installed version, read-only inspection):\n  - `SessionManager.list()`/`listAll()` read only top-level `*.jsonl` of each\n    session directory, non-recursively\n    (`dist/core/session-manager.js` `listSessionsFromDir` ~594–603,\n    `listAll` ~1460–1500). Files in a nested subdirectory never appear in\n    resume lists.\n  - The session file is flushed lazily: header and custom entries stay in\n    memory until the first user or assistant message, then are written\n    together (~680–806, `appendCustomEntry` ~901–911).\n  - `SessionHeader` has only `type`, `version`, `id`, `timestamp`, `cwd`,\n    optional `parentSession`; arbitrary metadata belongs in a `CustomEntry`.\n    No CLI `--parent-session` flag; RPC `new_session` accepts `parentSession`.\n  - No file locking; migration may rewrite a file. Two writers can race.\n  - Pix already treats `parentSession` as fork lineage (TUI fork grouping,\n    ACP fork metadata), so reusing it for children would mislabel them as\n    forks.\n- macOS owned launch (production-wired for Claude-provider children,\n  macOS/access-gated) keeps its whole durable ownership record set under the\n  per-agent directory (`owned_launch` pointer, `owned-launch/\u003cUUID\u003e/` with\n  spec, generation, claim, journals, receipts, retirement proof). Restart\n  reconciliation discovers it by scanning\n  `.pi/subagents/\u003cparentSessionId\u003e/owned/\u003cbatch\u003e/\u003cagentId\u003e/`\n  (`core/owned-retirement.ts` ~356–405, `core/owned-launch/label.ts` ~67–112).\n  The launchd access probe is given the directories it must reach\n  (`tools/spawn.ts` ~71–76).\n\n## Decision\n\n1. **Storage.** A child session lives in the project, in a directory named\n   after its parent's session id:\n   `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchild\u003e.jsonl`. Keeping children out\n   of the global Pi store hides them from every resume list and from usage\n   stats (the parent already records their usage) without per-surface\n","startLine":24,"endLine":72},{"path":"wiki/development/testing/desktop-qa-isolated-launch.md","quote":"require manual enabling. Exit 0 means both grants, 2 means missing permissions,\nand 1 denotes setup/diagnostic failure. This is not native UI verification.\n\nPermanent storage prevents accidental helper deletion, not permission revocation.\nThe helper may need renewed approval after migration or ad-hoc source updates;\nan available signing certificate can stabilize its designated requirement. No\ncredentials or captured evidence are stored with the installed helper.\n\n## Credentials, limits and failure cases\n\nDefault preparation copies no credentials. UI-only flows need none. In temporary mode,\n`--seed-config` explicitly copies only SDK settings/models and user Desktop/suite\nconfiguration. `--seed-api-keys` explicitly seeds literal API-key entries into\nprivate files. OAuth, session/CLI credential stores, command expressions and\nenvironment-variable references are not shared or resolved; no secrets are\nprinted. These seeds are not a complete authentication migration. Missing model\navailability/authentication must be reported, not repaired by attaching to the\nworking app. Parent agents must not inspect or populate `.pi/qa_auth.jsonc`.\n\nPermanent mode never seeds working-user credentials: reuse QA authorization or\nlet `ui-qa` import an explicitly user-authorized QA credential handoff.\n\nQA profiles may contain private configuration, API keys and test history. Keep\nthem mode-private under the owned run or permanent QA project; never export the entire profile with UI\nevidence. Scratch retention follows the project cleanup policy; export only\nsanitized evidence that must survive cleanup.\n\nThe pin contains native and embedded web assets. Development ACP still resolves\nits backend files from the checkout, so this is not a frozen release-runtime\nsnapshot. QA does not run another build inside the bounded launch step.\n\nTemporary ephemeral WebViews cannot validate production localStorage persistence\nor the watcher's Restart handoff. Explicit restart/recovery testing needs its\nown safe scenario; an unrelated active working run remains a legitimate blocker\nfor that scenario, not for ordinary isolated UI QA.\nPermanent QA may verify its own isolated localStorage across owned relaunches;\nthat still does not prove production persistence or the Restart handoff.\n\nMissing/ambiguous watcher, failed build, deadline, unsafe path, invalid manifest,\nunsupported isolation capability, native startup failure, inaccessible UI or\nmissing host permissions are explicit failures/blockers. An old working window,\nwindow title alone, static checks or browser preview cannot turn them into a pass.\n\n## Regression coverage\n\nRun the focused Node tests and native profile/lifecycle tests. Native acceptance\nmust identify the pinned source and actual QA PID, verify a real rendered UI in\nthe separate QA project, retain accessibility/pixel evidence, verify owned cleanup,\nand show that the working Desktop executable/PID was not restarted or closed.\n\n\n","startLine":192,"endLine":242}],"notices":["Native reranking unavailable or its context changed; original ranking retained.","Не удалось подтвердить полноту или актуальность результатов поиска."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":67,"excerptedSources":12,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

# Desktop usage statistics panel

<!-- markdownlint-disable MD013 -->

## Goal

Show historical usage recorded in Pix sessions, with project scope, time
period, usage metrics and session-level detail.

## Source and data contract

`pix-sessions` is the only usage source. It scans the complete
`<agentDir>/sessions` tree across projects; each session's header `cwd`
identifies its project. `createUsageStatsSources({ log, agentDir })` creates
the source set. Accounting uses the shared `usageFromEntry(entry)` from
`src/app/session/session-usage.ts` and preserves its accounting semantics.

The wire contract has `USAGE_SOURCE_IDS = ['pix-sessions']` and
`USAGE_UNITS = ['tokens']`. `PROJECT_USAGE_SOURCE_IDS` is not part of the
contract. Buckets contain values and optional `projectCwd`, but no `series`,
`dims` or `quotaPercent`; change notifications are `{ source }` without a
`cwd`. Requests still require a valid `cwd`, but collection does not use it.

ACP `UsageStatsHost` owns one `UsageStatsService`; it does not maintain
per-project services or an LRU. The host disposes the service with the agent.

## Desktop behavior

The outer sidebar header reads **Usage**, with the refresh action immediately
before Close. There is no duplicate **Pix usage** toolbar inside the panel,
nor provider tabs or a source switch. The period selector defaults to **7 days**
and offers the supported periods for the available data.

**Provider limits** is a separate disclosure above historical statistics. It
uses the same account-quota widgets and `displayModelUsage` precedence as the
status-bar popover: remaining percentages, hourly segments, reset countdowns,
weekly calendar/day slices, daily-budget warnings and cached-state labels.
Day slices describe the aggregate weekly quota, not independently measured daily
limits. Expanding **Provider limits** discovers authenticated supported provider routes from
the sessionless model catalogue and queries their quotas through `draft_config`,
independently of the active session/model (OpenAI, Anthropic/Claude Code, Z.ai,
and Antigravity). Account-wide routes use one representative model; Antigravity
retains model-specific queries. Queries have bounded concurrency, refresh every
five minutes while expanded (one minute for pending local Claude Code credentials),
and also run on header refresh while expanded. Collapsing the section or closing
the panel stops polling and queued queries; already-started requests may finish
but their late completions are ignored, including after a same-workspace reopen.
Completions from previous workspaces/connections or disposed panels are ignored. Failed
refreshes retain prior quotas as cached; missing quotas remain visible as loading,
unavailable or failed provider rows, rather than silently omitting the provider.
Provider quota rows are app-wide, not owned by an ACP connection or workspace, and
persist in localStorage under `pix.desktop.providerUsageQuota.v1`. Remounts,
project switches, reconnects and application restarts can therefore render the
last rows immediately. Refresh-time credential-scope checks still discard rows
belonging to a different login; persisted loading rows without quota data are
not restored. The in-memory quota snapshot updates with each result, but the
localStorage write happens once per refresh: when the load finishes, on pause,
and on dispose.
When an OpenRouter API key is configured (`OPENROUTER_API_KEY` or Pi
`auth.json`'s `openrouter.api_key`), Provider limits also shows an OpenRouter
row. Its Tauri `openrouter_usage` command requests `/api/v1/key` and
`/api/v1/credits` (credits 403/404 are tolerated) and returns balance
(`total_credits - total_usage`), key spend for today/week/month, key limit and
effective budget. Neither the key nor its label is returned. The frontend polls
every five minutes only while Provider limits is expanded and persists its
snapshot in localStorage under `pix.desktop.openRouterUsage.v1`; on failure,
available cached values remain visible with a **Cached** marker.
Existing runtime snapshots (including draft telemetry) supplement fetched quotas;
there are no usage-history-derived quota estimates. The
newest snapshot wins for each provider/account/model before grouping models into
one chart block per provider/account, including Antigravity. For each hourly or
weekly window the summary uses the lowest reported remaining percentage and
that window's actual reset time, rather than summing or averaging model pools.
Selected cached windows retain the cached indicator; distinct accounts remain
separate. Loading/unavailable/error placeholders are also grouped by provider
and do not duplicate a provider that already has a chart. The panel shows no
model names or repeated `Limits` headings; the status-bar popover keeps its
existing heading. Request-header RPM/TPM windows are not
account quotas and are not rendered here. Missing quota data has an explicit
empty state; provider limits do not depend on historical usage being present.

Provider rows (both quota charts and missing/loading placeholders) are ordered
by descending call count across all available Pix usage history, across projects
and dates, independently of historical chart filters. Credential-route aliases
share their quota-provider family's score; accounts within a provider share
that score. The last order is saved per project as `usagePanel.providerOrder`
in `.pi/workspace.jsonc`, restored together with disclosure state before quota
requests start, and used throughout loading. Partial, stale, failed or empty
history never resets that order. Only a complete `ready` snapshot with valid
calls can update it. Equal call counts retain the saved relative provider order;
new providers without a saved rank and accounts within each provider use a stable
provider/account fallback. Tokens and cost are not popularity proxies. While
**Provider limits** is expanded it also consumes the shared history snapshot
for this ordering, without mounting or calculating collapsed historical charts.
Quotas still render if history is empty or unavailable.

Disclosure state is project-local in `.pi/workspace.jsonc` under
`usagePanel.collapsedSections`. Stable ids (`provider-limits`, `overview`,
`activity`, `daily`, `models`, `sessions`, `cache`) survive metric/filter changes,
panel reopening and application restart. Missing ids default to expanded.
Changes preserve JSONC comments and sibling settings, serialize accepted toggles
across panel reopening, and retry conditional-write conflicts without dropping
other sections' changes. Malformed configuration is not overwritten; failures
remain visible and are sent to Desktop diagnostics. Late restores cannot undo
user input or apply another project's state; accepted writes remain scoped to
their original project even after panel teardown.

Sections stay closed until their saved state is restored, so persisted collapsed
sections never briefly render expanded or start background requests. Only an
explicit summary activation changes/persists disclosure state; native toggle
events caused by rendering or restoration do not. Collapsed section content is
unmounted and its chart-specific derivations sleep until expansion. Provider
quota polling and its minute clock also stop while **Provider limits** is
collapsed. Historical sections and provider popularity share one source: it
remains active while any historical section or **Provider limits** is expanded,
but stops accepting completions and requesting source-change updates when all
are collapsed. Re-expansion requests the current
snapshot; data retained for other expanded sections is rendered only on expansion.
Header refresh does not wake collapsed sections and is disabled when all sleep.

The Usage panel is remounted when switching workbench tabs. To avoid a cold
render on each remount, the frontend retains disclosure state and provider order
in a module-level per-project cache, usage-stat snapshots per ACP client and
project, and app-wide provider quota rows in localStorage. Cached values render
immediately; disclosure state is re-read from workspace configuration in the
background, and opening still refetches usage statistics and resumes quota
polling. Refresh indicators display over retained data. Usage-stat snapshots
remain in-memory remount optimizations; quota rows persist across restarts.

Historical disclosure headers remain mounted through loading, empty results and
refreshes; empty sections explain the lack of data inside their expanded body.
Cold loads use skeletons and expanded sections show a small update spinner.
Warm refreshes retain charts and settled missing-provider rows rather than
replacing them with skeletons. Cached/status text stays in the existing single-line
provenance row rather than inserting/removing a banner above the disclosures.

`UsageSourceView` provides a **This project / All projects** segmented toggle,
defaulting to **This project**. Project filtering compares normalized
`projectCwd` values with the current workspace. Metrics are cost, tokens and
calls. Breakdown charts, a plan-quota KPI and a calls-total series are not
shown. Top-session rows are clickable only when they belong to the current
project; other-project rows remain informational. Usage session ids are Pi
session header ids, which differ from the ACP ids Desktop assigns to sessions
it creates, so each session summary also carries `sessionFile`. A click
resolves the ACP id by matching it against the catalog's `pix.sessionFile`,
then by an identical id. If neither matches, Desktop refreshes the catalog once
and reports an error when the session is still missing.

The calendar, daily bars, hour-of-day strip and **By model** shares are
interactive. Hovering or keyboard-focusing a populated chart item shows an
immediate Pix-styled tooltip (day and value; daily total and per-model values
with colors; or hour range, value and share). Tooltips flip below or clamp to
the viewport and dismiss on scroll, resize or blur; chart items do not use
native SVG titles. Click, Enter or Space toggles the corresponding local day,
hour or model filter. The model dropdown, **By model** rows and daily-bar legend
share model-filter state; the collapsed **Other** row is not selectable. Items
with no usage are not interactive unless they are already selected.

Active day/hour filters appear as removable **Active chart filters** chips under
the controls. KPIs, top sessions and cache efficiency use all active filters.
Calendar and daily bars respond to hour and model filters (not day), the hour
strip responds to day and model (not hour), and **By model** shares respond to
day and hour (not model). Selected items are highlighted and other items in
those charts are dimmed. A day/hour filter that has no matching data in the
current period, scope and model is silently dropped. The empty state is based
on the period total, not the filtered total.

Time filtering is provided by `filterByTime(buckets, { day, hour })` in
`desktop/src/lib/usage-stats.ts`: filtering drops untimed buckets, and an hour
filter matches hourly buckets only.

The activity calendar uses local-time day buckets and shows localized date,
month and weekday labels. Week columns start on the system locale's first day
of week (`localWeekStart` via `Intl.Locale` week info; Monday when the runtime
does not expose it), and the Mon/Wed/Fri row labels follow that order. The
grid is always padded to whole weeks. Days before the window in the first
column show their real activity from the same project/model/hour-filtered
history, using the same color scale, and support value tooltips. These context
days are marked `outside`: they cannot be selected and are excluded from the
calendar summary and period totals. Other charts and KPIs keep the selected
period. Context days without activity, missing dates and future padding cells
remain faint noninteractive outlines; future days never carry activity.
For the 7d period the calendar shows the current local week
(`currentWeekWindow`), while KPIs and other charts keep the rolling 7 days.
Hour-of-day strips use localized ticks and tooltips;
daily bars and the coverage date use the system locale through
`desktop/src/components/usage/usage-format.ts` (`formatDayKey`, `formatDate`,
`weekdayLabels`, `monthLabel`, `formatHour`, `formatHourTick`). Formatting uses
`Intl`, without a hardcoded `en-US` locale.

## Persistent cache

Usage data is cached globally within the selected Pi agent profile, not in a
project's `.pi/usage-cache`. The versioned directory is
`<agentDir>/cache/usage/v1/`, where `agentDir` is the profile directory selected
by ACP (or the SDK default). `history.json` holds the last complete
`pix-sessions` snapshot for the whole profile; quota persistence uses one
hashed model slot per profile containing its credential scope and quota.
Project filters, metrics and charts derive from the same saved history rather than caching
duplicate per-project views. Disclosure state and the saved provider order
remain project-local preferences in `.pi/workspace.jsonc`.

ACP restores history before answering the first Usage request, marks it
`stale`, and starts normal collection without replacing saved charts with cold
skeletons. To keep that first request fast, ACP warms the host once per process
about 3 s after a `pix-desktop` `initialize` (unref'd timer, skipped after
dispose): `UsageStatsHost.warm()` loads the usage module and restores the disk
snapshot without collecting; failures are swallowed and retried by the next
real request. The root usage-stats module never imports the Pi SDK barrel;
`agentDir` is a required option that the ACP host supplies
(`options.agentDir ?? getAgentDir()`). `UsageStatsService.restore()` coalesces concurrent restores
and cannot overwrite a newer live snapshot or resurrect a disposed service.
The collector persists complete `ready` results only: partial scans, errors
and failed refreshes cannot replace the last complete history. JSON parsing
and serialization run in the existing collection worker by default; the
existing in-process fallback remains available when worker startup fails.

The sessionless draft catalogue accepts `includeUsageCache: true` to return
account-verified stale quota snapshots without contacting quota endpoints.
The panel hydrates them before live queries finish. Quota cache keys include
profile and locally resolved credential identity: OpenAI OAuth uses the tuple
of verified JWT `chatgpt_account_id` and `sub` (or JWT `email` when `sub` is
absent); if either claim is missing, it falls back to refresh/access token
identity. Anthropic/Claude has no proven stable account id and therefore uses
conservative token identity.
Other supported identities include API keys, Claude CLI credential source
and login, and the entire enabled Antigravity refresh-credential/project set
(not a fallback email). Identity lookup does not refresh OAuth or use quota
network calls. Missing or changed identity cannot read another login's cache.
Credential identity crosses the Desktop boundary only as an opaque hash. The
saved model slot is restored only when its saved scope matches the current
identity; a successful refresh for another account replaces it, bounding
orphaned quota files. Persisted quota payloads contain
display windows and account labels, never credentials, authorization headers,
raw endpoint responses or reset-credit counts. Saved windows retain their
original percentages, reset timestamps and observation timestamp until fresh
observations arrive, including after reset; no refill is predicted. Stale data
does not retain banked reset credits. Credential/account invalidation behavior
is unchanged.

Cached panel queries bypass the older route-only Claude telemetry fallback
and request `freshOnly` provider results, so Antigravity's legacy embedded
credential-file quota cache cannot be relabelled as a new successful refresh.
The native cache checks identity again after a live query and before returning
its result. A login change invalidates the batch (`usageCacheInvalidated`),
clears retained panel quotas and ignores peer responses. Catalogue responses
may include `usageCache.routeScopes`, mapping routes to opaque identity hashes;
individual query responses may include `usageCacheScope`. These optional,
validated fields detect account changes between requests in one batch and
remain backward compatible when omitted. Invalidation immediately re-reads
the catalogue and starts one fresh generation without waiting for abandoned
requests; repeated invalidation falls back to the one-minute retry. Ordinary
polling remains five minutes.

Cache writes use private files (`0600`) and atomic unique-temp-file renames;
new cache directories use `0700`. Files are versioned, size-bounded and
validated. Missing, corrupt, unsupported or unwritable cache files do not
prevent live collection; handled failures are reported once per owner and
operation with sanitized diagnostics. Failed Antigravity live probes remain
failed while previously displayed bars are retained; the failed response itself
is not reported as a cache diagnostic. This is a disposable last-success cache,
not an archive or credential store; deleting
the directory simply makes the next expanded section cold.

Restoring data is not permission to wake collapsed sections. Quota cache
hydration/live polling starts only with **Provider limits** expanded; history
restoration/collection starts only while an expanded historical section or
provider popularity needs the shared source. All-collapsed panels have no
refresh timers, subscriptions or quota requests. Closing/pausing ignores late
frontend completions; existing cache data remains available on reopening or
application restart.

## Lifecycle and derivation

Cold collection is progressive. The first unprimed `LocalUsageSource`
collection stats all session files, parses files modified within
`partialWindowMs` (7 days by default) first, and emits an interim snapshot with
status `loading`, null coverage and the message “Showing recent sessions while
older history loads.” It then reads all files and returns the complete
snapshot. Warm refreshes skip this partial pass; `clear()` resets the source
for another cold collection. `JsonlTailCache.read` accepts `{ prune?: boolean
}`; `prune: false` retains cached entries for paths not requested.

`UsageStatsService` forwards `onPartial` to sources. Interim data is emitted
through `onChange` only when it can populate a cold entry (there is no retained
snapshot, or the retained snapshot is still `loading`); it never replaces
retained data. Sources may implement `dispose()`, which the service calls when
disposed.

Parsing is performed by `WorkerCollector` in a worker thread. The main thread
resolves session roots and includes them with each collect request; the worker
owns the warm per-file cache. Abort is forwarded to the worker. A worker crash
rejects pending calls and the next collection respawns it. If startup fails
(worker error/exit or 30-second ready timeout), the service logs
`usage_stats.worker_unavailable` once and uses in-process collection for the
rest of that session. `createUsageStatsSources({ log, agentDir, inProcess })`
selects the source setup; `createPixSessionsSource` requires `{ agentDir }` or
`{ roots }`, with optional `partialWindowMs`.

On a measured 2.1 GB session tree containing 1,372 files, the first interim
snapshot took about 1.5 seconds, full collection 6–7.5 seconds, and warm
refresh about 0.2 seconds; maximum host event-loop lag was about 1 ms (versus
about 36 ms in-process). These are measured observations, not timing
guarantees.

The Desktop store requests usage while at least one historical section or
**Provider limits** (for popularity ordering) is expanded,
refreshes on demand and reacts to source-change notifications only while active.
Local-day bucketing and project
scope filtering are derived on Desktop; no request is needed to switch project
scope. Session summaries expose project paths so the UI can keep
other-project rows non-clickable.

## Regression coverage

Coverage includes the source contract, whole-tree collection, single-service host, project
filtering, local calendar formatting, persisted stale-first hydration,
profile/account isolation, invalidation and teardown races, corrupt cache
handling, and panel behavior.
