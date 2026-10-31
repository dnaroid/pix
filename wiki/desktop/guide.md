<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-30T23:28:59.327Z","result":{"path":"wiki/desktop/guide.md","documentHash":"d1bc2c3eae27d3913deef75bb29e786939c1c9840d1734534d4c767e5a690ab7","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/desktop.md","quote":"\n# Pix Desktop\n\nLightweight Tauri 2 + Svelte 5 client for Pix. It runs `pix-acp` as an\nisolated child process and communicates with it over ACP JSON-RPC.\n\n## Platform support\n\nPix Desktop is currently supported and released only on **macOS Apple Silicon**.\nWindows and Linux Desktop packages are intentionally not produced or\nplatform-validated in CI for now. This does not affect Pix TUI support on\nWindows or Linux.\n\n## Visual direction\n\nThe desktop client follows the terminal renderer's information hierarchy:\nproject-scoped sessions are horizontal tabs, the transcript remains visually\nuninterrupted, thinking and tool activity stay compact, and model, thinking,\nconnection, and workspace controls live in the bottom status area. The left\nActivity Bar hosts workspace tools (Tasks, Project, Wiki, Source Control and\nothers); conversations are not a chat list beside chat-bubble messages.\n\n## Local setup\n\nFrom the repository root:\n\n```sh\nnpm --prefix acp install\nnpm --prefix desktop install\nnpm run dev:desktop\n```\n\nFor repository-wide development, run `npm run watch:all` from the repository\nroot instead. It watches Pix, pix-acp, the bundled tool suite, and both Desktop\nlayers. Desktop is restarted only after a successful build; on a build error,\nthe last working process stays open.\n\n`dev` and `build` compile `acp/dist/main.js` before Tauri starts. The current\nMVP expects `node` to be available on `PATH`; pix-acp resolves pi's bundled RPC\nentry from its pinned npm dependency. Packaging Node and pix-acp as a signed\nsidecar is intentionally deferred.\n\nFor non-standard development setups, set `PIX_ACP_NODE_BINARY` to the Node\nexecutable and/or `PIX_ACP_ENTRY` to a built pix-acp entry point.\n\n## macOS title bar quirks\n\nThe project selector lives in a custom title bar (`ProjectTitlebar.svelte`,\n36px tall) rendered under `titleBarStyle: \"Overlay\"` + `hiddenTitle`. Two\nTauri 2/macOS traps are easy to reintroduce:\n\n- **Window dragging stops working.** `data-tauri-drag-region` sends the\n  `window.start_dragging` IPC, which is *not* part of `core:window:default`\n","startLine":1,"endLine":53},{"path":"wiki/overview.md","quote":"- **Bring repository-scale tools.** The bundled `pi-tools-suite` adds indexed\n  discovery, AST tools, LSP diagnostics, parallel agents, durable planning,\n  context compression, registry workflows and more.\n\nPix is not a separate agent protocol replacing Pi. It runs on the Pi SDK, so Pi\nmodels, tools, skills, extensions and sessions remain part of the same\necosystem.\n\n## Pix Desktop\n\nPix Desktop turns the same Pi/Pix runtime into an IDE-like native workbench.\n\nAssistant messages can include `pix-html` blocks that automatically\npreview self-contained HTML/JavaScript prototypes or Canvas games in a\nsandboxed iframe. Native form Submit and `window.pix.submit(json)` return\ndata to the current ACP conversation without overwriting your draft.\nThe iframe auto-fits the game's content up to a bounded height, uses the\nnative Pix scrollbar styling, and gives the agent the available inline width\nwhen you request an interactive prototype.\nSee [HTML Sandbox](desktop/rendering/desktop-html-sandbox.md) for the syntax and limits.\n\n**Platform support:** Pix Desktop currently supports **macOS on Apple Silicon\nonly**. Windows and Linux Desktop packages are not currently published or\nplatform-validated in CI. The Pix TUI remains supported on the release targets\nlisted below.\n\nThe Activity Bar provides:\n\n- **Tasks** — full interactive Desktop manager over project-local\n  `.pi/tasks.sqlite` (Quick Add, edit, priority/status, drag-and-drop,\n  attachments and linked sessions); `/task` slash commands and restricted\n  `project_tasks` agent tool provide additional access;\n- **Project** — keyboard-friendly file tree, Preview and external-editor actions;\n- **Wiki** — project pages, nested sections and assets in `wiki/`, with visual\n  Markdown editing; configure `wiki.path` and `wiki.index` in\n  `.pi/workspace.jsonc` (see [Project Wiki](desktop/workbench/desktop-project-wiki.md));\n- **Source Control** — initialize Git, stage/unstage, diff, review, commit,\n  publish/push and safe repository tools;\n- **Registry** — initialize `.pi`, configure private Git-backed resources and\n  synchronize project tasks, plans and workspace state;\n- **Package Scripts** — package-manager scripts and interactive terminals;\n- **Search indexes** — inspect local stores and edit shared global semantic-search configuration;\n- **Settings** — Desktop-specific models, voice, editor and Git preferences.\n\nDesktop production releases use the signed native Tauri updater.\n\nConfiguration is intentionally separate from the TUI:\n\n```text\n~/.config/pi/pix-desktop.jsonc\n\u003cworkspace\u003e/.pi/pix-desktop.jsonc\n```\n\nSee **[Pix Desktop](desktop/guide.md)** for installation, first-run behavior,\nworkspace details and troubleshooting.\n\n## Pix TUI\n\nPix TUI keeps coding-agent work dense without turning the terminal into a raw\ntranscript.\n\n- persistent project-scoped tabs;\n- lazy session restore;\n- searchable command picker;\n- expandable thinking/tool rows;\n- structured todo and sub-agent panels;\n- images, Markdown, diffs and file links;\n- inline local shell (`!`) and raw terminal (`!!`);\n- voice input and prompt helpers;\n- mouse-aware navigation and status actions.\n\n","startLine":73,"endLine":143},{"path":"wiki/decisions/0055-temporary-btw-side-chat.md","quote":"\nA side question should explain work without entering the parent's prompt queue,\nchanging its paused/running state, or creating a second task. The former Session\ninspector was removed; BTW is not a restoration of that activity pane. Existing\nModelRuntime streaming and the narrow private RPC-control path supply the model\nand credentials without another worker/runtime. These are implementation\nobservations, not a claim that all provider behavior is identical.\n\n## Decision\n\nKeep one memory-only side conversation per parent runtime. Desktop owns history\nand drafts; the runtime prepares a bounded canonical context snapshot and owns\none independent abortable inference. ACP forwards correlated transient events,\nnot transcript messages or replayable activity snapshots. Only fixed-purpose usage\nmetadata is persisted to the original session manager.\n\nOpening/hiding the right-hand pane never invokes the model. Questions refresh\ncompleted parent context but the snapshot stays fixed during each response.\nExplicit excerpts are data, not permission to invoke tools. Follow-up history is\ndiscarded when its underlying context is replaced. Model choice belongs to BTW\nonly. Copy/insert is an explicit user action; insertion is draft-only and requires\nthe correct empty main composer with no attachments.\n\nCancel/timeout does not release the physical request slot until its provider\nsettles. Reload/rebind cannot start another request over an abort-ignoring one.\nLate results may still contribute usage but cannot restore deleted side memory.\n\n## Alternatives\n\n- Full subagent/fork: creates tools, execution and persistence semantics the user\n  explicitly did not choose.\n- Reuse parent prompt/queue: risks interruption and contaminates the main history.\n- Durable side history: rejected by the user for this iteration.\n- Use rendered transcript DOM as context: misses canonical edits/compaction and\n","startLine":11,"endLine":44},{"path":"wiki/usage/desktop-usage-stats.md","quote":"The Usage panel is remounted when switching workbench tabs. To avoid a cold\nrender on each remount, the frontend retains disclosure state and provider order\nin a module-level per-project cache, usage-stat snapshots per ACP client and\nproject, and app-wide provider quota rows in localStorage. Cached values render\nimmediately; disclosure state is re-read from workspace configuration in the\nbackground, and opening still refetches usage statistics and resumes quota\npolling. Refresh indicators display over retained data. Usage-stat snapshots\nremain in-memory remount optimizations; quota rows persist across restarts.\n\nHistorical disclosure headers remain mounted through loading, empty results and\nrefreshes; empty sections explain the lack of data inside their expanded body.\nCold loads use skeletons and expanded sections show a small update spinner.\nWarm refreshes retain charts and settled missing-provider rows rather than\nreplacing them with skeletons. Cached/status text stays in the existing single-line\nprovenance row rather than inserting/removing a banner above the disclosures.\n\n`UsageSourceView` provides a **This project / All projects** segmented toggle,\ndefaulting to **This project**. Project filtering compares normalized\n`projectCwd` values with the current workspace. Metrics are cost, tokens and\ncalls. Breakdown charts, a plan-quota KPI and a calls-total series are not\nshown. Top-session rows are clickable only when they belong to the current\nproject; other-project rows remain informational. Usage session ids are Pi\nsession header ids, which differ from the ACP ids Desktop assigns to sessions\nit creates, so each session summary also carries `sessionFile`. A click\nresolves the ACP id by matching it against the catalog's `pix.sessionFile`,\nthen by an identical id. If neither matches, Desktop refreshes the catalog once\nand reports an error when the session is still missing.\n\nThe calendar, daily bars, hour-of-day strip and **By model** shares are\ninteractive. Hovering or keyboard-focusing a populated chart item shows an\nimmediate Pix-styled tooltip (day and value; daily total and per-model values\nwith colors; or hour range, value and share). Tooltips flip below or clamp to\nthe viewport and dismiss on scroll, resize or blur; chart items do not use\nnative SVG titles. Click, Enter or Space toggles the corresponding local day,\nhour or model filter. The model dropdown, **By model** rows and daily-bar legend\nshare model-filter state; the collapsed **Other** row is not selectable. Items\nwith no usage are not interactive unless they are already selected.\n\nActive day/hour filters appear as removable **Active chart filters** chips under\nthe controls. KPIs, top sessions and cache efficiency use all active filters.\nCalendar and daily bars respond to hour and model filters (not day), the hour\nstrip responds to day and model (not hour), and **By model** shares respond to\nday and hour (not model). Selected items are highlighted and other items in\nthose charts are dimmed. A day/hour filter that has no matching data in the\ncurrent period, scope and model is silently dropped. The empty state is based\non the period total, not the filtered total.\n\nTime filtering is provided by `filterByTime(buckets, { day, hour })` in\n`desktop/src/lib/usage-stats.ts`: filtering drops untimed buckets, and an hour\nfilter matches hourly buckets only.\n\nThe activity calendar uses local-time day buckets and shows localized date,\nmonth and weekday labels. Week columns start on the system locale's first day\nof week (`localWeekStart` via `Intl.Locale` week info; Monday when the runtime\ndoes not expose it), and the Mon/Wed/Fri row labels follow that order. The\ngrid is always padded to whole weeks. Days before the window in the first\ncolumn show their real activity from the same project/model/hour-filtered\nhistory, using the same color scale, and support value tooltips. These context\ndays are marked `outside`: they cannot be selected and are excluded from the\ncalendar summary and period totals. Other charts and KPIs keep the selected\nperiod. Context days without activity, missing dates and future padding cells\nremain faint noninteractive outlines; future days never carry activity.\nFor the 7d period the calendar shows the current local week\n(`currentWeekWindow`), while KPIs and other charts keep the rolling 7 days.\nHour-of-day strips use localized ticks and tooltips;\ndaily bars and the coverage date use the system locale through\n`desktop/src/components/usage/usage-format.ts` (`formatDayKey`, `formatDate`,\n`weekdayLabels`, `monthLabel`, `formatHour`, `formatHourTick`). Formatting uses\n`Intl`, without a hardcoded `en-US` locale.\n\n## Persistent cache\n\nUsage data is cached globally within the selected Pi agent profile, not in a\n","startLine":124,"endLine":196},{"path":"wiki/configuration/guide.md","quote":"Desktop Settings → Assistant. They are saved in the user Desktop profile as\n`search.ragModelRef` (empty means Desktop default model) and\n`search.ragThinking` (default `medium`). They are independent of the active\nconversation model and the Jev router. Search and the RAG answer view allow\nstopping/cancelling work without affecting existing conversations.\n\nSee [Pix Desktop](../desktop/guide.md).\n\n### Wiki contradiction judge\n\n`knowledgeCheck.modelRef` selects a dedicated model for both manual and background\nWiki contradiction checks. `knowledgeCheck.thinking` sets its reasoning effort.\nThese settings are independent of `search.ragModelRef`, `search.ragThinking` and\nthe session default. Configure the shared judge in\n`~/.config/pi/pi-tools-suite.jsonc`, or override it in\n`~/.config/pi/pix-desktop.jsonc`:\n\n```jsonc\n{\n  \"knowledgeCheck\": {\n    \"modelRef\": \"zai/glm-5.3-flash\",\n    \"thinking\": \"low\",\n    \"reportLanguage\": \"ru\"\n  }\n}\n```\n\nThe model above is an example, not an automatically selected default. Select\nmodels and reasoning in the **model setup wizard → Features → Assistant**:\n**Contradiction judge** writes the shared Suite fields; **Contradiction judge\n(Desktop override)** writes only the Desktop profile. Both are optional slots\nwithout Main/Fast/Strong role defaults. **Use Tools Suite setting** clears the\ncorresponding Desktop field; **Low (default)** clears explicit Suite reasoning.\nModel and reasoning can be reset independently, including when the model is\ninherited and reasoning is overridden. The TUI setup wizard exposes the same\nslots; Desktop-only overrides are never written to `pix.jsonc` and setup does\nnot create a partial Desktop profile if it does not yet exist.\n\n**Settings → Tools Suite → General** and **Settings → Desktop → Assistant**\nshow a read-only judge summary with **Edit in wizard…**, not separate model\nselectors. The report-language selector remains editable in Settings. Opening\nor cancelling the wizard writes nothing. Existing judge choices are read back,\nappear on **In use**, and participate in replace-everywhere. Saving unrelated\nroles with untouched judge slots does not select or replace the judge.\n\nEach nonempty Desktop field overrides only that Suite field; blank or omitted\nDesktop fields inherit Suite. When reasoning is unset in both files it is\n`low`; supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`\nand `max`. `off` omits an explicit reasoning request. Use `provider/model`\nwithout a `:thinking` suffix, since reasoning has its own field.\n\nNo judge is selected by default. When both model fields are empty, checks fail\nwith an actionable configuration message before retrieval; they do not silently\nuse the Search or session model. An invalid explicit configuration or an\nunavailable judge also fails without provider fallback. Existing users who\npreviously relied on the Search answer model must set `knowledgeCheck.modelRef`\nexplicitly; there is no automatic configuration migration.\n\nThese are user-global settings; project `.pi/` configs do not override them.\nChanges apply to the next check, not a request already running. Saved reports\nretain the judge that produced them; selecting another model does not by itself\ninvalidate a content-hash stamp or restart a completed background pass.\n\n### Wiki contradiction report language\n\n`knowledgeCheck.reportLanguage` selects `en` (English) or `ru` (Russian) for\nWiki contradiction reports. Set the shared preference in\n`~/.config/pi/pi-tools-suite.jsonc`, or override it in\n`~/.config/pi/pix-desktop.jsonc`:\n\n```jsonc\n{\n  \"knowledgeCheck\": { \"reportLanguage\": \"ru\" }\n}\n```\n\nThe controls are **Settings → Tools Suite → General → Contradiction report\n","startLine":260,"endLine":336},{"path":"wiki/desktop/conversations/desktop-user-message-actions.md","quote":"- Newly submitted Desktop rows are associated with the first new Pi user entry by comparing current-branch user entry IDs before and after the serialized prompt; later steering/follow-up entries must not replace that binding. Stale prompt generations or replaced clients cannot bind rows. Extension/builtin commands that create no Pi user entry are marked renderer-only. Historical rows carry their persisted entry ID in `replay-entry:\u003cid\u003e` on both initial and older history pages and on full live-branch history. Message actions use this identity, never prompt text or a visible-row/branch-length offset. Rows without a proven entry ID fail closed and ask the user to wait for prompt settlement or reload. `[confirmed by code: desktop/src/app/prompt-run-lifecycle.svelte.ts, desktop/src/app/user-message-context-actions.ts, acp/src/acp/pix-acp-agent.ts]`\n\n## Copy and fork behavior\n\n- **Copy message** copies the full selected message. Session-backed rows use the existing ACP host clipboard path; renderer-only rows use the Desktop browser clipboard. `[confirmed by code]`\n- **Fork** forks at the selected Pi user entry and replaces the currently open source session, matching the existing Desktop `/fork` behavior. `[confirmed by code: desktop/src/app/conversation-fork-action.ts]`\n- **Fork in new tab** uses the same Pi `session/fork` primitive but keeps the source ACP session/tab open and activates the new fork. `[confirmed by code]`\n- Forking into a new tab does not cancel or forget the source run. It snapshots the latest source transcript and preserves the source composer text/attachments; the new composer receives the selected Pi user text without source attachments. Later source events remain scoped to the source tab. A stale fork response after client/workspace/session replacement discards the created fork without changing the new selection. Sessions share the project filesystem; this is not worktree isolation. `[confirmed by code]`\n\n## Edit and resend behavior\n\n","startLine":23,"endLine":33},{"path":"wiki/getting-started/troubleshooting.md","quote":"For diagnosis, leave the memory watchdog enabled. It writes RSS/heap reports to\n`~/.config/pi/memory-reports/` and periodic samples to `~/.config/pi/logs/`.\nSee [Unified diagnostic logging](../operations/logging.md) for retention and privacy\ndetails.\nSee [Memory watchdog](../configuration/guide.md#memory-watchdog) and the engineering note\n[TUI streaming-thinking memory growth](../tui/tui-streaming-thinking-memory.md)\nfor the root cause, invariants, and regression coverage.\n\n## Pix Desktop Linux AppImage opens a blank window\n\nLinux Desktop is legacy, unsupported tooling (macOS is the only supported\nDesktop platform). If you still run the legacy Linux AppImage and terminal\nstderr contains:\n\n```text\nCould not create default EGL display: EGL_BAD_PARAMETER. Aborting...\n```\n\nuse the documented\n[Linux AppImage Wayland/Mesa workaround](../desktop/guide.md#linux-appimage-blank-window-eglbadparameter).\nDo not apply that workaround to unrelated Desktop errors.\n\n## An extension behaves differently from stock Pi\n\nPix supports the Pi SDK extension UI surface, including toasts, widgets, menus,\ndialogs, custom UI and terminal input hooks. Extensions that depend on private\nrenderer internals may still need adaptation.\n\n","startLine":84,"endLine":111},{"path":"wiki/desktop/integrations/desktop-git-workflows.md","quote":"- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`, `desktop-navigation-view-model-services.ts`, `desktop-workbench-git-services.ts` and `desktop-workbench-prop-builders.ts`: workspace-assistant readiness for Source Control and Git Diff, independent of conversation-tab runtime readiness.\n- `desktop/src/lib/acp-client.ts`, `desktop/src/lib/acp-pix-extensions.ts`, `acp/src/acp/desktop-commands.ts` and `acp/src/acp/pix-acp-agent.ts`: cwd-bound Git-assistant request transport and standalone ACP execution without allocating a conversation session.\n- `desktop/src/lib/git-workflow.ts` and `git.ts`: shared policies, types and prompt/draft helpers.\n- `desktop/src-tauri/src/git_operations.rs`: secondary commands and temporary-repository tests; `desktop/src-tauri/src/git_ci.rs`: bounded/cancellable `gh`/`glab` queries and provider normalization; `desktop/src-tauri/src/lib.rs`: repository detection/initialization, command registration and window/app teardown.\n\n## Verification\n\nRepository-author regression coverage is in\n`desktop/src/lib/git-identity-editor.test.ts` (inherited values, errors/retry,\nread/edit races, serialized saves and disposal),\n`desktop/src/app/git-workspace.test.ts` (shared mutation lock and A → B → A\ncompletion), and `desktop/src-tauri/src/git_identity.rs` (real temporary Git\nrepositories, local-only save, included defaults, unchanged config on invalid\ninput/lock contention or staged-write failure, linked-worktree precedence,\npermissions/history preservation, and exact-root confinement). Run the native subset with\n`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_identity`.\n\nThe sparse closed-panel lane follows [sidebar indicators](../workbench/desktop-sidebar-indicators.md) and [decision 0025](../../decisions/0025-sidebar-health-polling.md).\n\n`npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:web` cover static checking, the existing suite and production frontend compilation. Focused behavior tests are in `git-ci.test.ts`, `GitCiSection.test.ts`, `git-workspace.test.ts`, `git-assist-workflow.test.ts`, `git-assist.test.ts`, `desktop-workbench-prop-builders.test.ts`, `git-workflow.test.ts` and `DesktopEditorSurfaces.test.ts`; CI-repair tests cover default/configured model selection, prompt policy and stale failed-HEAD cleanup, while the CI store tests cover stale workspace/HEAD completion, refresh coalescing, teardown cancellation and serialized job loading. Rust tests cover provider URL/status normalization in addition to exact-root Git initialization and nested-repository refusal. ACP request parsing and standalone dispatch are covered by `acp/test/desktop-commands.test.ts` and `acp/test/agent.test.ts`.\n\n`npm --prefix desktop run test:git-workflow` mounts the real Svelte components with deterministic fake Git/ACP callbacks in Chromium. It exercises all three flows, partial/explicit staging, draft races, push partial success, no-session/no-remote/conflict states, keyboard controls, stable review/diff selection, full-height review and 360px light/dark Source Control geometry/semantic colors. Screenshots are written to ignored `desktop/.artifacts/git-workflow/`.\n\n`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_secondary` exercises real local Git in temporary repositories: bounded/unborn history, stash/index/untracked preservation, safe discard, fetch/pull and divergence refusal. Browser callbacks do not contact a remote or paid model, and these tests do not alter the user's repository index, commits, remotes or stashes. Live provider/native-webview end-to-end behavior is a separate integration check, not asserted by the browser fixture.\n","startLine":216,"endLine":239},{"path":"wiki/desktop/workbench/desktop-project-wiki.md","quote":"\nOnly completed `conflicts` results containing grounded findings produce a red\nnotification. Several newly conflicting pages in a pass update one notification.\nDeduplication compares the body hash and paired source paths/quotations, including\nthe report already stored in the file; a paraphrased explanation or repeated\nunchanged result does not notify again. Notification actions retain their project\nand generation, so they cannot navigate a replacement project's workbench.\n\n### Shared checking and save behavior\n\nPre-save checks keep their editor/draft ownership and cancellation rules; a\nbackground manual result never authorizes saving an edited draft. A saved-page\nbackground result can update its original file's footer only through the raw\nexpected-content guard. If recording fails or the file has changed, the report\nis retained with a recording notice and the new file is not overwritten.\nApp-owned report/checkpoint writes share the judge slot so they cannot invalidate\nanother comparison's raw evidence snapshot while that model request is active.\nA failed explicit recheck preserves an unchanged page's existing green stamp.\n\n**New page** still\ncreates an empty file; its first content save runs the check. Other project-file\nsaves retain their existing behavior.\n\nRelated pages come from the existing native Knowledge search, scoped to the\nsame project's Wiki before retrieval. Hybrid queries use native BM25 and vector\nretrieval with reciprocal-rank fusion and the configured optional reranker.\nExisting source selection, exclusions and provider configuration apply; checking\na page does not enable sources or configure providers. Disabled, unavailable or\nincomplete semantic retrieval leaves the check incomplete, even when lexical\nmatches are available. The saved version of the draft itself is excluded from\nexternal evidence. Evidence is restricted to safe `.md` and `.markdown` pages.\nOther Knowledge-supported formats inside the Wiki, such as an asset's `.txt`\ncompanion, are excluded normally before reading their originals; they do not\nmake the Markdown comparison incomplete. Unsafe/private paths and results\noutside the configured Wiki remain actual retrieval failures.\n\nA separate sessionless model call compares the draft with original source text.\nIt uses the independent `knowledgeCheck.modelRef` and `knowledgeCheck.thinking`\npreferences, never the Search answer model or session default. Each nonempty\nuser-global Desktop field overrides the corresponding user-global Tools Suite\nfield; empty or omitted Desktop fields inherit Suite. Reasoning defaults to\n`low`; a model must be selected explicitly. Invalid settings or an unavailable\njudge produce an error, not a fallback to another provider. Model references use\n`provider/model` without a thinking suffix. Project config cannot override the\njudge. Preferences are captured at the start of each check; an in-flight check\nkeeps its selected model. Validation of model preferences precedes retrieval.\nJudge selection and reasoning are managed in the model setup wizard under\n**Features → Assistant**, with shared Suite and optional Desktop-override slots.\nSettings show the saved values read-only with **Edit in wizard…**; report\nlanguage remains an ordinary editable setting. Opening/cancelling the wizard\ndoes not change a judge, restart completed checks or invalidate existing stamps.\nThe normal provider runtime, credentials and extension loading are reused.\nIt creates no conversation. Drafts, sources and their metadata are\nuntrusted data, including any instructions embedded in them. The comparison\nasks for incompatible claims about the same entity, environment, version and\ntime period. Explicit supersession, historical values and different scopes do\nnot by themselves constitute contradictions. The model does not choose which\nclaim is authoritative or rewrite either document.\nThe report names the judge model used for that request. Its task is to compare\nclaims within the supplied draft and passages; a bounded selection alone is not\na reason to abstain. Missing conditions that materially change the verdict on\nspecific claims remain a real uncertainty.\n\n`knowledgeCheck.reportLanguage` controls model explanations, uncertainty prose,\nreport labels and checker-owned diagnostics. It accepts `en` and `ru`; the\nuser-global Desktop value overrides the user-global Tools Suite value, with\nEnglish as the fallback. An empty Desktop value inherits the suite setting.\nPreferences are read for each check. Source quotations, paths and structured\nidentifiers remain unchanged, as do unknown native/provider diagnostics.\nSee [configuration](../../configuration/guide.md#wiki-contradiction-report-language)\nfor the settings locations and example.\n\nThe operation has explicit budgets:\n\n| Input or stage | Limit |\n| --- | --- |\n| Logical document | 128,000 characters |\n","startLine":411,"endLine":487},{"path":"wiki/getting-started/installation.md","quote":"Verify:\n\n```powershell\npix.cmd --help\npix.cmd install --check\npix.cmd update --check\n```\n\n## Pix Desktop\n\nPix Desktop is a native Tauri application with its own bundled Pix/ACP runtime;\nthe TUI is not required.\n\n- **macOS:** open the `.dmg` and copy Pix Desktop into Applications or\n  `~/Applications`. Release packages require macOS 13.5 or newer.\n- **Windows/Linux:** not currently supported. Packaging assets exist only as\n  legacy tooling; do not install them for a supported Desktop setup.\n\nDesktop has a separate configuration profile:\n\n```text\n~/.config/pi/pix-desktop.jsonc\n```\n\nProject overrides live at `\u003cworkspace\u003e/.pi/pix-desktop.jsonc`. See\n[Pix Desktop](../desktop/guide.md) for features, first-run behavior and Linux-specific\ntroubleshooting.\n\n## Checksums\n\nOn Linux:\n\n```bash\nsha256sum \u003cdownloaded-file\u003e\n```\n\nOn macOS:\n\n```bash\nshasum -a 256 \u003cdownloaded-file\u003e\n```\n\nOn Windows PowerShell:\n\n```powershell\nGet-FileHash \u003cdownloaded-file\u003e -Algorithm SHA256\n```\n\nCompare the digest with the exact filename entry from the release's\n`SHA256SUMS` file before installing/replacing the payload.\n\n## First-run setup\n\nThe TUI health check is non-mutating:\n\n```bash\npix install --check\n```\n\n`pix install` / `pix setup` can additionally install the recommended Nerd\nFont, install the standalone `pi` CLI when missing, create non-secret config\ntemplates and print credential-aware next steps. It never imports provider\n","startLine":114,"endLine":175},{"path":"wiki/assistants/observer/heads-up-observer.md","quote":"Escape or focus leaving the trigger/popup dismisses it. Opening does not steal\nfocus. The popup lower edge touches the trigger's top, matching Plan\nwithout a visual gap or intervening dead pointer region.\nThe trigger has no browser-native tooltip. See [status-bar click popups](../../decisions/0048-status-bar-click-popups.md).\nConfigured model, cadence, interval and budget ceilings stay in Settings, not the\npopup. Earliest reservation expiry is shown only while limited. Never-run,\nno finding, finding, suppressed duplicate, malformed reply, error, timeout and\ncancellation are distinct results. Older snapshots without optional `details`\nremain readable; missing details are unavailable, not claimed successful checks.\nEligibility time is not a promised launch time: automatic work still requires\na successful final settlement or a pending evidence opportunity while idle, and the\nremaining gates must pass. The earliest reservation expiry is not a full reset.\n\nOpening the popup may issue `/heads-up snapshot`, a quiet out-of-band state\nrefresh with no inference, context assembly, transcript notification, or parent\nrun. Without a snapshot it is sent only for a registered extension command.\nOpening cannot enable the feature or alter the composer. Counter refreshes can\nclear a fully expired limit without starting a check. Its display clock only\nruns while the popup is open. Pending button requests, session switches,\ndisconnects and retired runtime instances are ownership-guarded. The popup\ncloses on owner replacement/unready transitions; a first snapshot completing\ninitial loading does not close it. Escape restores trigger focus; outside\nclick dismisses; popup controls are keyboard reachable. Closed UI does not\nintercept Escape. Popup geometry stays inside narrow viewports. Settings deep\nlinks wait for asynchronously loaded sections and focus the Observer heading.\n\n`/heads-up discuss` in Pix TUI, or Desktop's Insert question action, only fills\nan empty composer with no attachments and no blocking dialogue. It never sends\nthe draft, overwrites user text or starts a parent turn. The draft contains only\nthe note title and consequence (no wrapper, evidence records or internal IDs);\nattachment mentions and effort-shortcut words are neutralized.\nNo number-key interception, automatic modal dialogue, generated learning page\nor auto-fix exists in this experiment.\n\n## Lifecycle, accounting and failure cases\n\nEach controller owns one runtime/session. New genuine user input, stop/error,\n","startLine":314,"endLine":350},{"path":"wiki/development/testing/desktop-qa-isolated-launch.md","quote":"```\n\nThis is a target fragment; real flows still require backend probing, content\nreadiness, deterministic UI assertions and evidence. The launcher directly\nspawns the pinned `.app` inner executable in its runner-owned process group;\nthere is no LaunchServices `open` handoff, detached GUI, or name-based attach.\nHuman invocation is `npm run qa:desktop -- launch --manifest \u003cmanifestPath\u003e`.\n\n## Profile and lifecycle\n\nIsolation activates only for `PI_UI_QA=1` with `PI_UI_QA_PROFILE_DIR`. Explicit\ninvalid profiles fail before Tauri storage/plugins/windows initialize. The\nlauncher supplies private HOME, PI_CODING_AGENT_DIR, PI_CONFIG_DIR and XDG paths,\nand does not forward ambient runtime, watcher, provider-home or credential\noverrides. Normal launches and legacy QA without a profile keep their behavior.\n\nThe native application uses a UUID-derived runtime application identifier.\nTemporary profiles use nonpersistent/incognito WebViews for every created window.\nPermanent profiles require explicit `PI_UI_QA_PERSISTENT_WEBVIEW=1` matching the\nprofile marker and macOS 14+; older systems fail before window creation because\ntheir WebKit implementation otherwise falls back to the working default store.\nInitial, restored and newly created permanent windows use the profile UUID as\ntheir WebKit data-store identifier and are not incognito. That OS-owned store\nlives outside the profile directory; no automatic store deletion is implemented.\nWindow membership and\ngeometry storage resolve in its private application profile. ACP inherits the\nprivate agent/config paths: test sessions, drafts, queues and history do not\nshare the working user's agent store. The test workspace is separate from the\nsource checkout. This is state isolation, not a general OS sandbox.\n\nBefore spawning, the launcher requires an embedded versioned isolation-capability\nmarker, so a pre-isolation binary cannot open the working WebView store even\nbriefly. On setup the native process atomically writes private `runtime.json`\nwith contract, actual PID/executable/profile and unique application identifier.\nPermanent mode also requires the embedded `PIX_DESKTOP_PERSISTENT_QA_V1`\ncapability before profile initialization/launch, and exact runtime contract,\n`persistentWebview: true` and `webviewStoreId` equal to the profile UUID.\nTemporary mode rejects a persistent runtime. The launcher verifies these against the pinned manifest, retains the verified\ncredential-free `identity.json` beside it for post-run inspection, and reports\n`QA isolation verified`. Stale identity is cleared before every launch. Neither\nmarker is a source hash or proof that every\nsource edit was included; the build-completion assumption is unchanged.\n\nOne prepared profile may have only one launch at a time. A surviving/crashed\nowner lock is not automatically stolen; temporary mode may prepare a new profile,\nwhile permanent mode must finish its owned launch before reusing that profile.\nCleanup is restricted\nto the owned QA process. QA-only SIGINT/SIGTERM/SIGHUP listeners request Tauri's\nnormal exit worker, allowing it to save state and stop its separately grouped\nACP/terminal children even when the runner signals the whole owned group.\nOnly that isolated infrastructure cancellation can bypass active-work\nconfirmation; working-app Quit/Restart and ordinary QA UI actions retain it.\nListener tasks are cancelled on teardown and the live runtime marker is removed.\nThe runner still has a bounded forced-cleanup deadline; a forced termination is\nnot evidence of successful persistence or complete graceful cleanup.\n\n## Persistent helper and permission setup\n\nThe UI automation helper is infrastructure, not a QA artifact. Source/development\nruns share the permanent per-OS-user installation at\n`~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility`. Neither\nRegistry Clean nor project scratch TTL cleanup reaches it. The path uses the\n","startLine":82,"endLine":143}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":57,"excerptedSources":12,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->
# Pix Desktop

<!-- markdownlint-disable MD013 -->

Pix Desktop is the native Tauri/Svelte frontend for Pix. It ships with its own
Pix + ACP runtime, so installing the TUI is optional.

## Install

Use the native package for the current OS/CPU from
[GitHub Releases](https://github.com/dnaroid/pix/releases). Pix Desktop is
currently supported on macOS only; Windows/Linux Desktop packages are legacy
tooling, not a supported product:

| Platform | Package |
| --- | --- |
| Windows x64 | Legacy tooling only; unsupported |
| macOS Apple Silicon | `.dmg` |
| Linux x64 | Legacy tooling only; unsupported |

Release packages contain their own Node.js/Pix/ACP runtime. See
[Installing Pix](../getting-started/installation.md) for checksum verification, upgrade and legacy
cleanup rules.

## Desktop workspace

Pix Desktop uses one project-oriented workbench instead of reproducing the TUI
inside a window.

The left Activity Bar exposes:

- **Tasks** — project-local SQLite tasks (`.pi/tasks.sqlite`) with full UI
  management, Quick Add, drag-and-drop, linked sessions and SHA-256 attachments;
  slash commands and the agent task tool supplement the UI;
- **Project** — file explorer with keyboard navigation and external-editor
  actions;
- **Source Control** — branch/status, diffs, stage/unstage, commit/push, code
  review and safe repository tools;
- **Registry** — private Git-backed skills/agents/project-state synchronization;
- **Package Scripts** — project package scripts and interactive terminals;
- **Search indexes** — local and semantic search-store status by source;
- **Usage** — Pix session usage across this project or all projects, with
  selectable time period and cost, token and call metrics;
- **LSP** — language-server status and controls;
- **Settings** — Desktop-specific model, voice, editor and Source Control
  preferences.

The Usage panel charts support hover and keyboard-focus tooltips, and clicking
a day, hour or model toggles a chart filter. Active day/hour filters appear as
removable chips; chart cross-filtering keeps the relevant breakdowns visible.
See the [usage panel specification](../usage/desktop-usage-stats.md) for filter
and tooltip behavior.

Settings → General includes a **Theme** preference: **System** (default),
**Light**, or **Dark**. Pix applies it through the native window appearance, so
system color-scheme-aware web content follows the selected theme. Changes are
reapplied when the window regains focus or the Desktop configuration changes.

Long-lived files, media, Git diff/review surfaces, and the interactive Terminal
opened by composer `!!` commands live in the main workbench tab strip rather
than modal windows.

## First run

The first-run dialog verifies the bundled runtime and can optionally:

- import supported OpenCode credentials without overwriting existing Pi
  credentials by default;
- import a static Codex `OPENAI_API_KEY` when Pi has no OpenAI credential;
- configure optional native repository semantic search.

ChatGPT/Codex OAuth refresh tokens are deliberately not copied between auth
stores.

Shipped defaults contain no provider/model ids. When providers are connected
and no default model is configured, Desktop opens a **Main / Fast / Strong**
model setup dialog. Skip dismisses it for this browser profile (remembered in
local storage). Reopen it from any model summary in Settings with **Edit in
wizard…**; cancelling a manual run changes nothing.

Steps: Roles (first run) or **In use** (manual run), then per-feature pages
(Features, Routing & desktop, Agents) with model, fallback chips and thinking
level per slot, then optional **Search & embeddings**. The **In use** step lists
every configured model with its usage count; replacing one updates it
everywhere — roles, slots, fallback lists and the frontier list. Unsupported
thinking levels move to the nearest supported level, slots with constraints
(vision Lookup, OpenRouter-only search & task classifier) keep the old model,
a **Newer: … — replace** hint appears when the catalog has a newer release of
the same provider and line, and **New frontier release** makes a model the
primary frontier model while keeping the previous one in the list.

The frontier primary defaults to the Strong role; extra frontier models have
no role default. An untouched frontier list keeps existing entries with their
flags and aliases; an edited list replaces everything after the primary.
Saving writes `pix.jsonc`, `pi-tools-suite.jsonc` and, when it exists,
`pix-desktop.jsonc` (including `search.intentModelRef`, one key for search
intent and task type classification), plus `search.embedding` /
`search.rerankerModel` when search is enabled. Open Settings editors reload
from disk afterwards. Setup uses sessionless ACP requests and does not create
a chat session.

**Features → Assistant** includes **Contradiction judge** (shared Suite setting)
and **Contradiction judge (Desktop override)**, with independent reasoning.
Neither slot defaults to a session or Search model. An empty Desktop override
inherits Suite; its model and reasoning can each be reset in the wizard. These
choices appear in **In use** and replace-everywhere. See the
[judge configuration contract](../configuration/guide.md#wiki-contradiction-judge).

Settings show models read-only with **Edit in wizard…**: Default & router
models, Feature models, Contradiction judge, Git models, Observer model, Sub-agent models, Lookup
models and Summarizer models. Wizard-managed routing tiers (simple, standard,
complex, expert) show model/thinking read-only; custom tiers stay editable, as
do non-model settings such as Auto by default, routing fallback tier, visible
models, RAG thinking effort, autocomplete limits, frontier flags and economy.

Code and Knowledge use native local search. Optional semantic retrieval requires
explicit project consent/configuration in `.pi/search/semantic.json`; eligible
chunks and queries may be sent externally using `OPENROUTER_API_KEY`. Existing
Legacy search directories/configuration are not consulted.

## Project initialization states

Desktop exposes explicit setup actions instead of failing with generic empty
panels:

- Source Control shows **Initialize Git** when the selected workspace has no Git
  repository. Pix refuses to create a nested repository when the workspace is
  already inside another Git root.
- Registry offers **Initialize project Registry** as an optional full scaffold
  setup (SQLite tasks, plans and attachments); saving a task, plan, attachment
  or project setting creates only the required `.pi` storage on demand. Merely
  opening/reading a workspace does not create `.pi`. Creating a new `.pi`
  appends `/.pi/` to the root `.gitignore` while preserving existing rules and
  newline style; existing `.pi` directories are not retroactively ignored.
  Initialization does not import, read or remove old JSONC task files.
- Search indexes reports local/semantic store state without initializing or
  repairing indexes.

## Configuration

Desktop does not inherit the TUI's `pix.jsonc`.

User configuration:

```text
~/.config/pi/pix-desktop.jsonc
```

Project override:

```text
<workspace>/.pi/pix-desktop.jsonc
```

Schema:

```text
https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json
```

The Desktop profile contains settings consumed by Desktop/ACP, including model
defaults, prompt helpers, visible models, external editor, voice input and Git
review/commit-message model preferences. TUI-only renderer/theme settings stay
in `pix.jsonc`.

Project settings (name color and logo) open from **Project settings…** at the
bottom of the project switcher menu, or by right-clicking the project badge in
the titlebar. They can assign a logo using **Initials** or **Image**. Images may
be selected with the native file chooser or generated through OpenRouter; they
remain previews until saved. A saved image is stored as `.pi/project-icon.png`,
`.jpg`, `.webp`, `.gif` or `.svg` (content-detected, up to 4 MB) and referenced
by `.pi/workspace.jsonc`. Generation uses `OPENROUTER_API_KEY` or the OpenRouter
key in Pi's `auth.json`; it sends the project name, optional prompt (up to 1000
characters) and up to the first 1000 README characters to the provider. The
default image model is `google/gemini-2.5-flash-image`; configure
`desktop.projectIcon.model` in global or project `pix-desktop.jsonc` to override
it. `.pi` cleanup preserves the canonical icon files. See the
[project identity contract](workbench/desktop-project-titlebar.md).

See [Configuration and accounts](../configuration/guide.md) for provider and voice setup.

## BTW side questions

Open **⋯ → Side question (BTW)** in the composer to ask about the current task
in a resizable pane on the right. `/btw` also opens it; `/btw question` sends a
question there. Both work while the main agent is running or paused. Opening the
pane alone does not call a model or move the main draft and attachments.

BTW supports follow-up questions and Markdown/code answers. Its model/effort
button opens the same **Model + Thinking** selector as the statusbar, using your
Desktop visible-model list rather than showing every model. **Manage** edits
that shared list. Choose a model and its supported thinking level, then Apply;
the selection affects only the next BTW question, never the main agent.
**Same as main session** inherits both the parent's resolved model and effort;
**Use main** restores this mode. Applied effort choices are remembered per model
only while the side chat exists; they do not change the main model defaults.
**Add selected text** explicitly includes a selected transcript/file
excerpt. BTW has no tools: it cannot independently read files, search or run tests.
Each question uses current completed parent context; shortened context is labelled.

**Stop** stops only the side response. Hiding the pane keeps its temporary
history, draft and reading position; reopening restores them. Each parent session
has its own side conversation. **New conversation** clears it. Closing/replacing
the parent runtime, reconnecting or exiting discards the temporary conversation;
it is not saved into the main chat or restored after restart.

Use **Copy** or **Insert** on an answer to reuse it. Insert requires an empty main
composer with no attachments and only writes a draft; it never sends it. Model
usage still counts towards the original session. See the [BTW contract](conversations/desktop-btw.md).

## Observer (experimental)

The **binoculars** on the right of the statusbar are grey when Observer is off and primary-colored
when enabled, except static amber binoculars while blocked by an Observer budget limit.
The tooltip and popup say «Достигнут лимит проверок» and show the earliest known
quota release time (not a promised check or full reset). Once the runtime clears
the limit, the binoculars return to primary. They pulse only while checking (unless reduced motion is enabled).
Click it for the **current-session switch**, **Check now**, current state/reason,
last check result and duration, and actual usage counters. The switch is saved
with this session and restored after restart; other sessions are unaffected.
Opening this popup does not
call a model. Checking does consume the selected provider's tokens/quota.

The popup's **Observer settings** action opens **Settings → Desktop → Observer**.
Choose the observer model independently of the main agent, set enablement for
new sessions and cadence, and expand advanced budgets/timing for input/output
limits, timeout and notice lifetime. Save applies defaults to new or reloaded
sessions; it does not change the active session's switch. Trusted project
configuration can override the user defaults. TUI settings are independent.

Findings still appear above the composer with evidence and feedback. **Insert
question** only fills an empty draft; it does not send it or change code. A
waiting observer may need more completed agent turns, not only elapsed time.
See the [feature contract](../assistants/observer/heads-up-observer.md) and the
[reproducible evaluator](../assistants/observer/evaluation.md) for limitations and checks.

## Updates

Packaged production Desktop builds use Tauri Updater. On startup Pix checks the
signed release feed; when a newer version exists, the UI exposes an Update
action with download progress.

Windows uses the packaged installer flow. macOS/Linux offer Restart after the
replacement is ready. Development/watch builds do not run the production
updater, and Desktop never falls back to npm or the portable-TUI updater.

## Linux AppImage blank window: `EGL_BAD_PARAMETER`

This issue was reproduced on a Fedora/Bazzite-family Wayland/Mesa system. The
repository keeps the original diagnostic handoff separately; the instructions
below are the generalized user-facing fix.

### Symptom

Pix Desktop launches a window, but the WebView remains blank. Starting the
AppImage from a terminal shows:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

An `atk-bridge` accessibility warning may also appear; in the reproduced case
that warning was not the cause of the blank window.

The observed failure is consistent with a Wayland/Mesa compatibility problem
where the AppImage's bundled `libwayland-client` conflicts with the host
EGL/Mesa stack.

### Workaround

Apply this only when the AppImage has the exact blank-window /
`EGL_BAD_PARAMETER` symptom.

Assuming the AppImage is stored as:

```text
~/.local/opt/pix-desktop/pix-desktop.AppImage
```

create a wrapper beside it:

```sh
#!/bin/sh
set -eu

app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wayland_lib=$(ldconfig -p 2>/dev/null | awk '/libwayland-client\.so\.0/{print $NF; exit}')

if [ -n "${wayland_lib:-}" ] && [ -r "$wayland_lib" ]; then
  export LD_PRELOAD="$wayland_lib${LD_PRELOAD:+:$LD_PRELOAD}"
fi

exec "$app_dir/pix-desktop.AppImage" "$@"
```

Save it as:

```text
~/.local/opt/pix-desktop/pix-desktop
```

then:

```bash
chmod +x ~/.local/opt/pix-desktop/pix-desktop
```

If a user desktop entry exists, point `Exec=` and `TryExec=` at the wrapper
rather than directly at the AppImage, for example:

```ini
Exec=/home/YOU/.local/opt/pix-desktop/pix-desktop %U
TryExec=/home/YOU/.local/opt/pix-desktop/pix-desktop
```

On the reproduced host, `ldconfig -p` resolved the host library to
`/usr/lib64/libwayland-client.so.0`; the wrapper intentionally discovers the
path instead of hard-coding it.

Do not remove a working wrapper during an upgrade until the new AppImage has
been tested without it.

### If the error is different

Do not apply the preload workaround to unrelated failures. Capture stderr from a
terminal launch and diagnose the exact message. In particular, an ACP warning is
not established by the `EGL_BAD_PARAMETER` log alone.

## Desktop UI automation

Native Desktop verification needs a desktop-capable automation environment.
Browser-only automation is not a substitute for testing the Tauri/WebKit
application. On Linux, semantic native automation may also require a working
AT-SPI accessibility bus.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"d1bc2c3eae27d3913deef75bb29e786939c1c9840d1734534d4c767e5a690ab7","checkedAt":"2026-10-30T23:28:59.330Z","maxDocumentChars":128000} -->
