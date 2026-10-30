---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-30T23:31:48.257Z","result":{"path":"wiki/usage/desktop-usage-stats.md","documentHash":"8bbdbdf54538bdebe20509cee9ee7486e963cf769076643453d270b7f361a11d","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[{"draft":{"path":"wiki/usage/desktop-usage-stats.md","quote":"When an OpenRouter API key is configured (`OPENROUTER_API_KEY` or Pi\n`auth.json`'s `openrouter.api_key`), Provider limits also shows an OpenRouter\nrow.","startLine":62,"endLine":64},"existing":{"path":"wiki/tools/suite.md","quote":"OpenRouter credentials use `OPENROUTER_API_KEY`, then shared\nPi auth storage (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); Ollama needs no key.","startLine":126,"endLine":127},"explanation":"Источник разрешает чтение учётных данных OpenRouter из OPENROUTER_API_KEY, а затем из общего хранилища аутентификации Pi, но только для настройки семантического поиска/реранкера в pi-tools-suite. Черновик описывает чтение ключа OpenRouter из Pi auth.json (openrouter.api_key) для строки квот провайдера в панели Usage. Отсутствует информация о том, применяется ли порядок чтения учётных данных, специфичный для поиска, к квотам панели Usage или черновик определяет собственный независимый источник учётных данных; без этого неясно, совместимы ли эти утверждения."}],"reviewedSources":[{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n","startLine":1,"endLine":32},{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n","startLine":1,"endLine":40},{"path":"wiki/usage/session-usage.md","quote":"  cover parsing and formatting; dialog source-contract tests pin content,\n  dismissal wiring and disclosure affordances, not rendered interactions.\n  Native UI behavior requires separate UI QA.\n- Desktop ACP-client and runtime lifecycle tests cover the independent usage\n  request and stale forget/reset completion handling.\n- Desktop source-contract tests pin click-only popup activation, dismissal and\n  Usage content placement; they do not establish rendered or native UI behavior.\n\n## Related\n\n- `wiki/usage/desktop-usage-stats.md`: account/machine-wide usage history panel\n  (per-provider sources, never summed); its `pix-sessions` source reuses the\n  session usage extraction described here.\n\n## Risks / compatibility\n\n- Old sessions created before async-agent usage mirroring cannot reconstruct\n  exact historical child-agent cost unless that usage was already persisted by\n  another mechanism. Pix reports what is recorded; it does not invent missing\n  historical spend.\n- Providers may report zero monetary cost while still reporting tokens. Only the\n  known Claude Code proxy uses the documented API-equivalent estimate fallback;\n","startLine":320,"endLine":341},{"path":"wiki/search/desktop-universal-search.md","quote":"  usable local task search with an independent diagnostic.\n- Commits search examines metadata for all ancestors of current HEAD, with no\n  30-commit window; it does not enumerate unrelated branches. The dedicated\n  `git_search_history` command leaves Source Control's 30-item history unchanged.\n  History examination and candidate selection run off the UI thread, returning\n  a bounded candidate list rather than serializing the whole history to the UI.\n  Fast native lexical matching covers subjects, full hashes and authors;\n  selecting either a native or hybrid commit hit opens Source Control and\n  the workbench Git Diff tab with that exact commit's read-only patch,\n  hash, subject, author and date. The transient search dialog closes only\n  after a valid commit diff is loaded. A separate ACP source performs\n  full-corpus BM25 plus semantic search over commit messages and metadata,\n  including non-literal matches. Changed-file paths (up to 256 paths / 32 KiB\n  per commit) enter local BM25 and previews, but not embedding inputs or hashes.\n  Previously paid vectors remain reusable; durable commit metadata refreshes\n  even when the content hash is unchanged. Hybrid results supersede duplicate\n  native hits without losing semantic eligibility, regardless of arrival order.\n  Search providers do not read diffs or mutate Git. Selection uses a separate\n  bounded, read-only native diff lookup; it rejects stale/non-HEAD-reachable\n  commit objects and cannot check out or modify the working tree. Root commits\n  and merges display their changes, with large patches visibly truncated.\n  Navigating to a newer search result, closing the dialog, or switching\n  projects invalidates a pending older commit reveal. Tasks-only searches\n  never invoke Git, and task embedding requires the global provider configuration. Missing Git or\n  malformed task storage reports a source-specific error without hiding other hits.\n- Explicit `patch:\u003cliteral\u003e` with Commits selected uses a read-only Git\n  pickaxe (`git log -G`, with the literal regex-escaped) over HEAD-reachable\n  changed lines. The scan is bounded to 50 matches and 8 seconds. Other\n  sources/native commit lookup are skipped. Patches are never embedded,\n  indexed or uploaded; returned commits open through the existing verified\n  read-only diff viewer. A missing ACP connection is reported, not silently\n  treated as no matches.\n- Commit history count is not capped. Hybrid indexing bounds individual Git fields to\n  64 KiB, and semantic document input to 8,192 characters including the saved\n  prefix and metadata; unusually large commit messages can therefore be truncated.\n- Hybrid commits use the global `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` provider,\n  knowledge embedding model, dimensions and prefixes; Desktop never selects or switches\n  the provider or alters the code/knowledge index. OpenRouter credentials come only\n  from `OPENROUTER_API_KEY`; unrelated legacy configuration and credentials are not read. The selected\n  provider may receive commit messages/metadata and search queries. The dialog\n  discloses that the first search may index the entire current HEAD history and\n  incur provider costs. This uses the same global semantic configuration as repository\n  search; history-specific settings remain separate.\n  Commit data and vectors live in `.pi/search/git-commits.sqlite`, in the\n  `pix_commit_meta`,\n  `pix_commit_documents`, and `pix_commit_vectors` tables. They reuse unchanged\n  commit hashes, content and compatible vectors across restarts and append new\n  commits. Reachability filtering excludes commits no longer on current HEAD.\n  Provider/model/dimension/prefix identity fences incompatible vectors; the\n  settings and commits vector tables may use distinct dimensions/encodings.\n  Legacy databases are not read, imported or migrated. Settings, Sessions and Tasks\n  use `settings.sqlite`, `sessions.sqlite` and `tasks.sqlite`. Stop and restart older\n  Pi/ACP/Desktop clients before using source-local stores: mixed-version writers\n  do not honor the new ownership protocol and are unsupported.\n  A changed incompatible embedding identity is never mixed with existing vectors.\n  A retained incompatible Settings cache blocks only settings-vector access, not\n  writes to the separate Task/Session namespaces. Compatibility errors report that\n  an explicit rebuild is required; normal indexing never silently replaces paid\n  vectors. Schema-2 Settings reconciliation belongs to Settings writes, not unrelated\n  namespace writes; global content-addressed vectors are retained across catalogues.\n  The global configuration editor explains recovery: run the suite's user-only\n  `/search-semantic reset-history` from the affected project to explicitly discard\n  derived project Task/Session/Commit vectors, never the global Settings cache.\n  Canonical tasks, sessions and Git history remain intact;\n  subsequent semantic searches can rebuild the cache and incur embedding charges.\n  Missing config/key/provider retains local BM25 results and durable caches.\n  Durable source-local ownership precedes paid batches. The publication fence is\n  same-file only; there is no cross-database atomic transaction. The global\n  `~/.config/pi/search-provider-work.sqlite` coordinates at most four valid local provider\n  leases across projects/processes; after a crash or partition it cannot prove the count of\n  remote provider executions. Source/provider leases renew every 30 seconds and expire\n","startLine":250,"endLine":320},{"path":"wiki/work-management/registry/desktop-registry-plans.md","quote":"# Desktop Work plans navigation\n\n## Behavior\n\n- The workspace sidebar's **Work** destination stacks two accordions in a\n  fixed order: **Plans** first, then **Tasks** (no segment switcher). Each\n  header is a `\u003cbutton aria-expanded\u003e` with a state-rotating Lucide\n  `ChevronRight` (`data-work-section-toggle`) and a count (`N` plans,\n  `N · M done` tasks). Plans is always sized to its content (capped at half the\n  panel height while Tasks is open, otherwise at the panel height, then\n  scrolls); an open Tasks fills the rest. A collapsed section shrinks to its\n  header and stays directly below the section above it, never pinned to the\n  panel bottom.\n- Accordion state is persisted per project in `.pi/workspace.jsonc` under\n  `workPanel.collapsedSections` (ids `plans`, `tasks`; both open when omitted;\n  unknown ids retained). Writes preserve comments/sibling settings and share the\n  per-workspace compare-and-swap queue with other Desktop view-state writers\n  (`app/workspace-config-persistence.ts`). Section bodies render only after the\n  state is restored; malformed config keeps defaults and reports\n  `frontend:work-panel-state` to the diagnostic logger. The former\n  `pix.desktop.work.segment:\u003cworkspace\u003e` localStorage key is no longer read.\n- The Work header title is **Work** and its activity-bar action is **Work** or\n  **Hide Work**. Its subtitle reports `N plans · M tasks`.\n- Saved project plans appear in Work → Plans, not in Registry. The Plans accordion uses\n  the existing canonical project-document snapshot and works without a\n  configured remote registry or ready conversation session. When there are no\n  plans, its header is disabled and remains collapsed.\n- Registry contains only its resource catalog and project status. The\n  project-sync **plans** artifact action opens Work, expands the Plans accordion and the\n  sidebar if collapsed; stale-workspace actions are\n  ignored.\n- Choosing a plan opens the existing main-workspace Preview tab, leaving the\n  Registry list and search intact. Markdown uses Preview's existing rendered\n  reading mode and explicit editing controls; no second document viewer is added.\n- The selected row follows the actual Preview file, not an optimistic click.\n  Failed or stale reads therefore do not falsely select a different plan.\n- Each card is a single line with a file icon (a spinner instead while a run of\n  the plan is Running), truncated name without `.md`, optional task-owner icon\n  and circular `N/M` checklist progress ring. **Run** and a three-dot actions\n  menu (like task cards) appear on hover/focus; the menu holds **Open session**,\n  **Resume** and **Delete plan** and closes on Escape, outside click or choice.\n  The actions menu is portalled to the document body as a fixed-position overlay,\n  positioned beside the trigger and flipped above when needed; it closes on\n  outside pointer/focus, scroll, resize, Escape or Tab. The linear checklist\n  indicator remains for the session HUD/status surfaces.\n  The ring does not animate or invoke an LLM.\n  Progress is exposed as an accessible progressbar with completed/total\n  value text and `data-plan-checklist-progress`; no native title tooltip is\n  shown. Counts describe saved\n  Markdown task markers only, not whether gates or Definition of Done passed.\n  A plan with no checklist items and unavailable progress both show a dash,\n  with distinct accessible labels/tooltips.\n  Run creates and activates a new conversation, then sends an instruction to read\n  and execute the saved plan at its exact project-relative path. It does not\n  create a saved task or consume the current composer draft. Unsaved Preview\n  edits are not part of the launched plan. If the plan file disappears while the\n  new session is starting, no prompt is sent and the error banner names the\n  removed plan. Run requires a ready session service: the button stays\n  disabled until the ACP client is initialized and startup restoration of the\n  workspace's active session has finished (restoration may replace the active\n  session, so an earlier click would be lost). The launch action repeats the\n  same guard. Browsing and deletion remain available offline.\n- A successful plan launch records `sessionId → plan path` per workspace in\n  `localStorage` under `pix.desktop.planLaunches:\u003cworkspace\u003e`. Only canonical\n  `.pi/plans` paths are retained, with at most the 50 newest launches. Stale or\n  reset launches are not recorded.\n- Delete confirms the full plan path and warns that deletion and loss of unsaved\n  edits cannot be undone. Cancellation leaves the file untouched. Successful\n  deletion refreshes the list, closes Preview only if it is showing that plan,\n  and schedules normal plans registry synchronization. It waits for pending\n  saves and blocks new saves of that plan until deletion completes. Errors retain\n  the list entry and use the existing UI/diagnostic error reporting.\n- Plan actions reject duplicate launches/deletes. Stale confirmation, runtime\n  preparation and completion cannot mutate a different workspace or conversation;\n  a session created after launch invalidation is closed instead of activated.\n- List scroll survives Plans-panel remounts within the current workspace and is\n  remembered per workspace. There is no plan search field.\n- Registry has no plans controls or plan-list props; the Plans accordion is the\n  persistent plan navigator. Opening it does not focus search.\n- The plan list fills the Work panel height with no 45% height cap or bottom\n  border. It is not a floating picker or dialog.\n- Plans owned by a task show a small owner icon with the task label in its\n  tooltip. Ownership comes from task `links` containing the canonical plan path;\n  there are no owner-group headings or manual plan-to-task linking.\n- A task card whose linked plan has a saved checklist with every item checked\n  (`total \u003e 0`, `completed \u003e= total`) and whose status is not `done` shows\n  **All plan items checked** with a **Mark done** button. The status changes only\n  when the user clicks it (same path as the status menu); it is disabled while\n  tasks are busy. Plans with no checklist or unavailable progress show no hint.\n- Plan cards list no run rows. **Open session** in the menu opens the Running\n","startLine":1,"endLine":90},{"path":"wiki/desktop/guide.md","quote":"| Windows x64 | Legacy tooling only; unsupported |\n| macOS Apple Silicon | `.dmg` |\n| Linux x64 | Legacy tooling only; unsupported |\n\nRelease packages contain their own Node.js/Pix/ACP runtime. See\n[Installing Pix](../getting-started/installation.md) for checksum verification, upgrade and legacy\ncleanup rules.\n\n## Desktop workspace\n\nPix Desktop uses one project-oriented workbench instead of reproducing the TUI\ninside a window.\n\nThe left Activity Bar exposes:\n\n- **Tasks** — project-local SQLite tasks (`.pi/tasks.sqlite`) with full UI\n  management, Quick Add, drag-and-drop, linked sessions and SHA-256 attachments;\n  slash commands and the agent task tool supplement the UI;\n- **Project** — file explorer with keyboard navigation and external-editor\n  actions;\n- **Source Control** — branch/status, diffs, stage/unstage, commit/push, code\n  review and safe repository tools;\n- **Registry** — private Git-backed skills/agents/project-state synchronization;\n- **Package Scripts** — project package scripts and interactive terminals;\n- **Search indexes** — local and semantic search-store status by source;\n- **Usage** — Pix session usage across this project or all projects, with\n  selectable time period and cost, token and call metrics;\n- **LSP** — language-server status and controls;\n- **Settings** — Desktop-specific model, voice, editor and Source Control\n  preferences.\n\nThe Usage panel charts support hover and keyboard-focus tooltips, and clicking\na day, hour or model toggles a chart filter. Active day/hour filters appear as\nremovable chips; chart cross-filtering keeps the relevant breakdowns visible.\nSee the [usage panel specification](../usage/desktop-usage-stats.md) for filter\nand tooltip behavior.\n\nSettings → General includes a **Theme** preference: **System** (default),\n**Light**, or **Dark**. Pix applies it through the native window appearance, so\nsystem color-scheme-aware web content follows the selected theme. Changes are\nreapplied when the window regains focus or the Desktop configuration changes.\n\nLong-lived files, media, Git diff/review surfaces, and the interactive Terminal\nopened by composer `!!` commands live in the main workbench tab strip rather\nthan modal windows.\n\n## First run\n\nThe first-run dialog verifies the bundled runtime and can optionally:\n\n- import supported OpenCode credentials without overwriting existing Pi\n  credentials by default;\n- import a static Codex `OPENAI_API_KEY` when Pi has no OpenAI credential;\n- configure optional native repository semantic search.\n\nChatGPT/Codex OAuth refresh tokens are deliberately not copied between auth\nstores.\n\nShipped defaults contain no provider/model ids. When providers are connected\nand no default model is configured, Desktop opens a **Main / Fast / Strong**\nmodel setup dialog. Skip dismisses it for this browser profile (remembered in\n","startLine":18,"endLine":78},{"path":"wiki/tui/concurrency.md","quote":"- Deferred paste, voice, and extension UI completion target their originating tab or are discarded after that scope is removed.\n- Restoring a tab draft does not enter another tab's undo history and cannot silently overwrite input typed after activation started.\n- Tab lifecycle mutations are mutually exclusive. Failed activation rolls back or disposes newly created/displaced runtimes.\n- Persisted tab snapshots are written in invocation order with unique temporary files.\n- Replacement/history work is cancelled when runtime, session, tab, or generation changes.\n- Terminal byte chunks preserve split UTF-8 sequences and batch printable-input rendering.\n- Shutdown detaches input before awaiting cleanup and applies one bounded cleanup deadline before forced exit.\n\n## Invariants\n\n- One runtime has at most one owning tab, and replacing that ownership disposes or explicitly transfers the displaced runtime.\n- Only the active tab's scope can mutate the shared editor and visible conversation.\n- Timers and subscriptions verify runtime ownership before mutation.\n- No stale persistence snapshot can replace a newer completed snapshot.\n\n## Edge cases\n\n- Switching tabs while draft persistence, session replacement, history loading, paste, voice, or custom UI is pending.\n","startLine":34,"endLine":51},{"path":"wiki/tools/agents/project-agents-dir.md","quote":"\u003e\n\u003e Status: implemented and current. Re-verify against code before relying on\n\u003e line numbers.\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nLet a project ship its own sub-agent definitions as individual Markdown files\n(Claude Code `.claude/agents/*.md` style). Files live in `\u003cproject\u003e/.pi/agents/`;\neach file becomes a `subagentType` available to the `subagents` tool, the LLM\nrouter, and the parent system-prompt role catalog. Each role owns its ordered\nmodel candidate list; there is no separate project-wide model-pool layer.\nBundled built-in roles use the same Markdown definition format and parser under\n`src/async-subagents/agents/*.md`.\n\n## Behavior\n\n### Discovery\n\n1. From the spawn cwd, walk up towards the filesystem root; the **first**\n   `.pi/agents` directory found wins (same walk-up semantics as\n   `findProjectConfig` for `\u003cproject\u003e/.pi/pi-tools-suite.jsonc`).\n2. Only top-level `*.md` files (non-recursive) are loaded, dotfiles excluded,\n","startLine":6,"endLine":35},{"path":"wiki/usage/desktop-quota-calendar.md","quote":"- `src/app/model/model-usage-status.ts`\n- `src/app/model/model-usage-reset-credits.ts`\n- `acp/src/acp/desktop-commands.ts`\n- `desktop/src/lib/acp-client-types.ts`\n- `desktop/src/lib/acp-response-parsers.ts`\n- `desktop/src/lib/quota-calendar.ts`\n- `desktop/src/lib/runtime-status.ts`\n\n## Tests\n\n- `desktop/src/components/QuotaResetCalendar.test.ts`\n\n- `desktop/src/components/UsageLimitBars.test.ts`\n- `desktop/src/components/ModelUsageDonut.test.ts`\n- `desktop/src/components/ResetCreditsSection.test.ts`\n- `desktop/src/lib/quota-calendar.test.ts`\n- `desktop/src/lib/acp-response-parsers.test.ts`\n- `desktop/src/components/StatusBarHover.test.ts`\n- `desktop/src/components/DesktopVisualRegressions.test.ts`\n- `desktop/src/lib/runtime-status.test.ts`\n- `desktop/src/app/session-runtime-status.test.ts`\n- `tests/model-usage-status.test.ts`\n- `tests/anthropic-reset-credits.test.ts`\n\n## Verification\n\nFocused Desktop Vitest, including a DST-observing timezone run for date helpers;\nDesktop check and build:web. Native visual QA is not asserted by unit/source tests.\n\n\n","startLine":180,"endLine":209},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n","startLine":1,"endLine":52},{"path":"wiki/tools/suite.md","quote":"\n### Native repository embedding setup and privacy\n\nNative lexical search requires no credentials. `/search-semantic status` shows\nwhether global semantics are configured. `/search-semantic configure \u003cembedding JSON\u003e`\nsaves the embedding object and authorizes semantic retrieval for all sources/projects;\n`/search-semantic off` removes it. `/search-semantic reset-history` is an explicit\nuser-only recovery command for incompatible history caches in the current project: it\nclears only recognized derived task/session/commit/settings vectors and identity metadata\nfrom their source-local databases (`tasks.sqlite`, `sessions.sqlite`, `git-commits.sqlite`,\nand `settings.sqlite`), preserving canonical tasks, sessions and Git history. Repository\nvectors live alongside source chunks in `code.sqlite` and `knowledge.sqlite`; they are\nunchanged by this history reset. Legacy databases are not read, imported or migrated.\nSchema-1 Settings caches are rejected without mutation. Status inspection never repairs\nstores. Stop and restart every\nolder Pi/ACP/Desktop client before using split stores; old clients do not honor the new\nwork protocol and mixed-version writes are unsupported. A separate global\n`~/.config/pi/search-provider-work.sqlite` coordinates at most four concurrent provider\nleases; after a crash or partition this cannot prove the count of remote provider\nexecutions. Source/provider leases renew every 30 seconds and expire after 90 seconds.\nQueued sources keep their claim renewed and recheck after acquiring a slot; cancellation\nretains ownership until tracked transport settles, and lost owners cannot publish. After\ntwo failed/interrupted network attempts (initial plus one automatic retry), explicit\nContinue is required; success resets failures, and Continue clears the exhausted budget\nbefore reconciliation. A short failed-work cooldown applies. Crashes after transmission\ncan still result in duplicate provider billing; this is not exactly-once delivery. See\n[decision 0070](../decisions/0070-search-source-work-recovery.md).\nThe next search can re-embed and incur charges. Busy, unsafe, redirected or unrecognized\nstorage fails closed without a reset. Desktop Settings Search edits the same global file\nwithout ACP. No independent consent flag or confirmation step is used. Old\n`.pi/search/semantic.json` and Desktop semantic booleans are ignored; keys/caches alone\nnever activate semantics. OpenRouter credentials use `OPENROUTER_API_KEY`, then shared\nPi auth storage (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); Ollama needs no key.\n\nOptional `search.rerankerModel` in the same global suite JSONC enables OpenRouter\none merged rerank of selected Sessions/Tasks/Commits/Code/Knowledge results, independently of\n`search.embedding`. For example, `\"rerankerModel\": \"voyageai/rerank-3-lite\"`.\nSaving a nonempty model authorizes sending queries and bounded candidate text\nacross projects; charges may apply. Missing/empty values disable it; credentials\nalone do not enable it. Pure lexical agent/native search and indexing never invoke reranking.\nDesktop publishes local results first, then optionally reranks once all sources finish.\nSettings remain local. History sends bounded titles/snippets, not entire sessions/diffs;\nthe source-balanced 100-candidate pass precedes final result limits.\nDesktop's **Reranker model** field uses the same draft and normal Save; clearing\nit removes the key. `/search-semantic off` only removes embeddings, not a separately\nconfigured reranker. Provider failure/timeout retains original ranking. See\n[native repository search](../search/native-repository-search.md#optional-reranking)\nfor limits, filtering and lifecycle safeguards.\n\nTo configure file suffixes for native repository search, set `search.codeExtensions`\nand/or `search.knowledgeExtensions` arrays in the global\n`~/.config/pi/pi-tools-suite.jsonc` settings. For example:\n\n```jsonc\n{\n  \"search\": {\n    \"codeExtensions\": [\".gdshaderinc\", \"mydsl\"],\n    \"knowledgeExtensions\": [\".guide\"]\n  }\n}\n```\n\nEach configured list replaces the full built-in list for that category; lists are not\nadditive. An explicit empty list disables the category, while an omitted list uses its\nbuilt-in defaults. Only configured suffixes are indexed; filenames such as `Dockerfile`\nand `Makefile` have no special handling. Entries are simple 1–32 character suffixes\n(letters, digits, `_`, `+` or `-`), with optional leading dots; matching is\ncase-insensitive. Each source accepts at most 128 entries, and the effective Code and\nKnowledge lists must not overlap. Unsupported paths/globs and invalid or overlapping\nsettings are rejected. Normal ignore, binary, size and link exclusions still apply.\nChanges take effect on the next explicit search/index scan; saving settings alone does\nnot scan or trigger embeddings. Project-local settings do not override these lists.\n\nThe [Codex reasoning replay spec](../providers/codex-reasoning-fix.md) owns the\n","startLine":95,"endLine":168},{"path":"wiki/desktop/conversations/desktop-session-tabs.md","quote":"## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nPreserve Pix conversation/session membership and lazy draft semantics after conversation tabs move into the unified top Workbench tab strip beside Preview and Git Diff.\n\n## Behavior\n\n- Visible conversation sessions remain selected and ordered by the existing `buildTabSessions` / Desktop-TUI parity rules. The unified workbench chrome does not change session membership or backend synchronization.\n- Desktop persists its own ordered visible conversation-tab membership per workspace **within each stable native window label**. Active-session pointers use the same window scope. Two windows, including windows on the same project, cannot overwrite each other's snapshots. Switching projects retains each project's snapshot within that window. Browser preview uses its own namespace. On restart, only the Desktop snapshot determines which real session tabs are restored, including an explicit empty list; stale TUI `pix.tabs` metadata must not resurrect sessions that Desktop had closed. Sessions opened only in Desktop are restored as well. A missing Desktop snapshot is treated as an empty snapshot, so startup opens the UI-only draft rather than falling back to TUI tab state. Ordinary TUI changes may still reconcile into the live Desktop tab list after startup.\n- Session snapshots use `pix.desktop.windowLayout.\u003cencoded-window-label\u003e.sessionTabs` and `.activeSessions`. Legacy origin-wide `pix.desktop.sessionTabs` / `pix.desktop.activeSessions` are not imported because their owning window is unknowable; existing windows start with a draft once and remember subsequent tab choices. Saved sessions remain available in the chooser.\n- A fast startup catalog must not erase saved tabs merely because native discovery is still running. If any saved tab is absent, Desktop waits for [authoritative catalog reconciliation](desktop-session-parity.md#behavior) before pruning or choosing the startup session. Failed reconciliation preserves the saved snapshot and reports the error.\n- Restored Desktop tabs and sessions explicitly selected/opened in Desktop retain Desktop-owned membership even if a later TUI `pix.tabs` snapshot omits them. Refresh/navigation must not silently close or reorder these tabs; explicit close/delete and unavailable-session pruning still apply. Unselected tabs introduced only by live TUI reconciliation remain governed by that reconciliation.\n- The persisted Desktop active-session id is valid at startup only when it is still a member of the persisted Desktop tab snapshot. If that active id is stale, Desktop falls back to the first still-available persisted tab; if the persisted tab list is empty, startup opens the UI-only draft instead of an old TUI session. Closing the last real Desktop tab clears the persisted active-session pointer.\n- Alongside these window/project tab snapshots, Desktop keeps each real session's last-known model reference, display name and thinking level. Startup can display the saved active tab's selection before the session/runtime is attached (or the first persisted tab when the active pointer is stale). This is display-only: the Model control stays disabled until runtime readiness; saved selections never populate pickers, submit parameters, model-routing decisions or quota requests. Accepted runtime configuration replaces the snapshot, including removing it when no model is supplied. Closed/removed tabs prune their display metadata; project switching preserves other project snapshots. Missing, malformed or old metadata leaves ordinary tab restoration intact; storage writes are best effort. Draft selections are not persisted here.\n- A persisted fork session is identified from Pi's native parent-session metadata. ACP exposes `pix.isFork` and, when available from its existing map records, the safe ACP-only `pix.parentSessionId` session-list metadata value to Desktop; no parent path is exposed. Workbench tabs render a branch icon beside fork titles.\n- Conversation tabs are `kind: \"session\"` members of `WorkbenchTabs`. Preview, Git Diff, Terminal, and LSP installer tabs may appear between them visually, but those UI-only tabs never enter the session id arrays used by `buildTabSessions`, restore metadata, saved-session selection, or ACP/TUI synchronization.\n- A newly opened or reopened sub-agent session is inserted immediately after its recorded parent when that parent is already visible; repeated insertions place the newest child nearest the parent. Selecting a child that is already visible does not reorder it. If its parent is not visible, the existing append behavior applies. This ordering is part of the existing persisted Desktop tab snapshot; restarting preserves that snapshot without repositioning restored children. Selecting a saved child does not require its parent to be open.\n- A sub-agent conversation tab displays the agent icon resolved from the matching live parent sub-agent run snapshot (`runDir` and `agentId`). If the snapshot or profile icon is unavailable, including after restart, the tab uses the neutral bot icon. This is separate from the session status and fork indicators and does not alter ACP/network protocols.\n- The active conversation runtime and the selected workbench surface are distinct concepts. While an auxiliary workbench tab is selected, the current session remains the underlying active runtime and keeps its activity/status state. Selecting a conversation tab activates/loads that session and selects the shared `conversation-workspace` panel.\n- Unsent composer text and staged attachments are owned by the conversation tab that produced them. Switching between real sessions or between a real session and the UI-only draft snapshots the source composer and restores the target composer; content from one conversation must never appear in another tab. Closing a session or discarding a draft removes its composer snapshot, and changing workspace clears all composer snapshots.\n- Selecting an existing session makes its composer editable immediately while runtime startup and persisted-history hydration continue. Normal prompt submission snapshots text/attachments, clears the composer, and renders the local user message immediately; the actual ACP prompt waits for that session's runtime and pending hydration. Selection changes do not retarget an accepted send: its hydration continues into that session's cached transcript, preserving older-history pagination without overwriting the newly selected conversation. Close/reopen, workspace changes, or client replacement invalidate its runtime ownership and prevent stale sends; close/reset/replacement also invalidate retained hydration. While one such submission is awaiting startup, further input remains editable but another submission in that session is not consumed; after startup, follow-up input uses the normal running-prompt queue. Runtime-dependent commands retain their startup gates. A failed startup reports that the message was not sent; its local message remains visible unless the conversation is explicitly closed or its workspace is reset. Missing history must not erase it.\n- The deferred attachment-ownership effect cancels stale asynchronous additions on conversation changes without clearing the target tab's restored attachments. Workspace changes still invalidate and clear the live attachment draft.\n","startLine":14,"endLine":38}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":65,"excerptedSources":12,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

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
not restored.
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
raw endpoint responses or reset-credit counts. Expired saved windows are
removed and remaining windows retain their original observation timestamp.

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

## Tests

Focused coverage is in `tests/usage-stats-local-sources.test.ts`,
`tests/usage-stats-service.test.ts`, `tests/usage-snapshot-cache.test.ts`,
`tests/usage-stats-worker-collector.test.ts`, `tests/model-usage-cache.test.ts`,
`acp/test/usage-stats-host.test.ts`,
Desktop usage derivation/store tests, and `UsagePanel.test.ts`. These cover
the source contract, whole-tree collection, single-service host, project
filtering, local calendar formatting, persisted stale-first hydration,
profile/account isolation, invalidation and teardown races, corrupt cache
handling, and panel behavior.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"8bbdbdf54538bdebe20509cee9ee7486e963cf769076643453d270b7f361a11d","checkedAt":"2026-10-30T23:31:48.263Z","maxDocumentChars":128000} -->
