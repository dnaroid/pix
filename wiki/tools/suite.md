<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T13:31:34.019Z","result":{"path":"wiki/tools/suite.md","documentHash":"db47387fff54092d7ad08a157048b0886402b95da204c661238b66e8e5eac823","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":24,"chunkCoverage":{"totalChunks":2,"checkedChunks":2,"totalComparisons":3,"checkedComparisons":3},"status":"incomplete","conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/tools/index.md","quote":"# Bundled tools and extension surface\n\nThe suite guide describes installed tools and configuration. API contracts, execution and native host behavior are kept alongside it.\n\n[Wiki home](../index.md)\n\n## Topics\n\n- [Sub-agents](agents/index.md) — Role selection, lifecycle, model pools and project-local roles. Read current contracts before relying on older delegation decisions.\n\n## Pages\n\n- [Background shell jobs](background-shell.md) — active\n- [Headless Tool API](headless-tool-api.md)\n- [Native Pi TUI presentation for pi-tools-suite](native-pi-tools-suite-ui.md)\n- [Fault-tolerant pi-tools-suite module loading](pi-tools-suite-module-loading.md) — active\n- [Claude provider search tool policy](provider-web-search-policy.md) — active\n- [Suite codemode](suite-codemode.md) — active\n- [pi-tools-suite](suite.md)\n- [Tavily fallback for web tools](web-search-tavily-fallback.md)\n\n\n","startLine":1,"endLine":22},{"path":"wiki/context/dcp-reliability-mechanisms.md","quote":"- Locked by `test/dcp-transaction-faults.test.ts`:\n  - a changed source during the model await cannot reach persistence;\n  - the same tool-call id with changed parameters is a conflict, not an\n    idempotent success;\n  - new interior content is not deleted by a previously committed exact block;\n  - failed command persistence neither mutates manual mode nor reports\n    success. `[confirmed by tests]`\n\n## Journal mirror, replay and pre-journal gating\n\n`src/dcp/journal.ts`, `src/dcp/index.ts`\n\n- DCP decisions persist as small structured custom entries (`dcp-journal`,\n  schema version 1) inside the session itself — no sidecar file. Replay of\n  init + delta operations reconstructs the block state. `[confirmed by code,\n  journal.ts:12-13,58]`\n- A pre-journal conversation is deliberately unsupported (clean break, no\n  migration of legacy sessions): operations fail with \"DCP is disabled for\n  this pre-journal session. Start a new session to use the current DCP\n  implementation.\" `[confirmed by code, index.ts:201,323]`\n- A blocked journal throws an explicit `DcpJournalError` carrying the blocked\n  reason instead of leaving partial work. `[confirmed by code,\n  index.ts:344,444]`\n- Pressure that cannot act is reported as a `progress-blocked` diagnostic with\n  an inferred reason (`inferDcpBlockedReason`) rather than looping as a no-op.\n  `[confirmed by code, index.ts:235,713-722]`\n- Locked by `test/dcp-journal.test.ts`, `test/dcp-journal-lifecycle.test.ts`,\n  `test/dcp-progress-opportunities.test.ts`. `[confirmed by tests]`\n\n## Budgeted auto-compression\n\n`src/dcp/auto-compress-budget.ts`\n\n- A retry `context_edit` must not turn the SDK's raw-history fallback estimate\n  into a false provider-native capacity floor. Canonical full-branch provenance\n  plus exact SDK scalar agreement authorizes rebasing to the actual DCP\n  projection, including resolved system/tool overhead; unknown or genuine native\n  floors remain conservative. The resolver is per context pass, not persisted\n","startLine":37,"endLine":74},{"path":"wiki/tui/guide.md","quote":"- `/export` / `/import` — move sessions through HTML/JSONL;\n- `/share` — publish a secret GitHub gist;\n- `/compact` — manually summarize older context;\n- `/delete` — permanently delete a session after confirmation.\n\n`maxProjectSessions` controls automatic per-project session retention; `0`\nkeeps sessions indefinitely.\n\n## Bundled pi-tools-suite\n\nPix links the bundled suite into the active Pi agent directory when safe. An\nexisting non-symlink installation is preserved.\n\nMajor capabilities include:\n\n| Area | Modules / behavior |\n| --- | --- |\n| Parallel work | `async-subagents`, presets, fallback routing, `/ultrawork`, `/hyperplan` |\n| Repository search | Native Code/Knowledge retrieval via `project_search` |\n| Structural edits | `ast-grep` |\n| Feedback | LSP diagnostics and comment checks |\n| Planning | hierarchical durable todos |\n| Context | DCP compression/pruning |\n| Web | local/cloud web-search integrations |\n| Providers | usage, Antigravity auth, OpenCode credential import |\n| Reusable resources | prompt commands, Git-backed Registry, session naming |\n| Recovery | bounded session overview/search/section tools |\n| Payload hygiene | truncation normalization and opt-in credential firewall |\n\nOptional modules activate only when their host requirements are available.\nBroken module imports/factories are skipped with a startup warning instead of\nremoving the whole suite. This does not certify unfinished feature behavior or\nundo arbitrary initialization side effects; see\n[module loading](../tools/pi-tools-suite-module-loading.md).\n\nAdaptive plans keep dependencies, blockers, ownership and the active step\nvisible:\n\n![Pix adaptive todo plan with hierarchy and blockers](../assets/screenshots/pix-adaptive-todo.png)\n\nParallel sub-agents report live status without taking over the main session:\n\n![Pix running parallel sub-agents alongside the main implementation plan](../assets/screenshots/pix-subagents.png)\n\nUseful suite commands include `/todos`, `/sub-status`, `/sub-stop`,\n`/ultrawork`, `/hyperplan`, `/usage`, `/dcp`, `/opencode-import`, and\n`/antigravity-add-account`.\nThe Git-backed resource Registry is available only in Pix Desktop.\n\n## Command map\n\n| Area | Commands |\n| --- | --- |\n| Renderer/resources | `/settings`, `/hotkeys`, `/reload`, `/changelog`, `/update` |\n| Models | `/model`, `/default-model`, `/scoped-models`, `/thinking`, `/default-thinking`, `/autocomplete` |\n| Project context | `/no-context-files`, `/compact` |\n| Prompt workflow | `/enhance`, `/queue`, `/copy` |\n| Git | `/code-review`, `/commit-message` |\n| Sessions | `/new`, `/new_tab`, `/resume`, `/name`, `/session`, `/search`, `/history`, `/jump`, `/tree` |\n","startLine":98,"endLine":156},{"path":"wiki/work-management/tasks/project-tasks-agent-tool.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Saved project tasks: SQLite agent API and slash commands\n\n## Scope\n\n- Project tasks belong to the session cwd; they are **not** the session-local\n  `todo` plan. Their only persistent source is `\u003ccwd\u003e/.pi/tasks.sqlite`.\n- No legacy compatibility, import or fallback exists for `tasks.jsonc`,\n  `tasks.json`, `tasks.d/`, Markdown task lists or old attachment markers.\n  Files left by older versions remain untouched and are **never consulted**.\n- `project-tasks` is a default-enabled pi-tools-suite module, independent\n  of repository search. The `project_tasks` tool and user-invoked `/tasks`/`/task`\n  commands use the same validated SQLite storage layer.\n- Tasks returned to a model enter that model's context. Reads do not copy\n  attachment bytes into context or trigger another model/network call.\n\n## User commands\n\n```text\n/tasks list\n/tasks list {\"status\":\"todo\",\"priority\":\"high\",\"type\":\"bug\"}\n/task get \u003cid\u003e\n/task add {\"type\":\"feature\",\"title\":\"Fix reconnect\",\"description\":\"...\"}\n/task update {\"id\":\"\u003cid\u003e\",\"status\":\"done\"}\n/task delete \u003cid\u003e\n/task attach \u003cid\u003e \u003crelative-project-file\u003e\n```\n\n- Commands run only on explicit invocation by the user. They do not ask the\n  model to infer a task mutation. Missing/invalid parameters report usage.\n- Add requires a valid type (`bug`, `feature`, `improvement`, `idea`)\n  and nonblank title and/or description; new tasks default to `todo` /\n  `medium`. Update is a bounded patch, not a document replacement. Delete\n  removes only the named row and cascades its attachment references.\n- Attach accepts only a regular file within the current project, with a 25 MiB\n  size bound; refuses symlink/escaped paths. File bytes are copied once into\n  an immutable SHA-256-named blob and associated with the exact task id.\n- `/task get` returns the task plus linked attachment **metadata**.\n- Task payloads may contain optional `parentId`, `epic`, `relatedTaskIds`,\n  `modelRef` and `links`. The agent-facing update tool never exposes these\n  structural fields and preserves them on status/title/description patches.\n  Deleting a task with remaining child or related-task references is rejected\n  under the SQLite writer transaction instead of leaving a broken hierarchy.\n\n## Restricted agent tool\n\n- The model-facing tool is named `project_tasks` and accepts:\n  - `list` with optional status/priority/type filters (compact results);\n  - `get` with id (full task and attachment metadata);\n  - `create` with type and content, **only at an explicit user request**;\n  - `update` with id and at least one of status/priority/title/description;\n  - `run` with id, **only when the user asks to execute that saved task**,\n    in Pix Desktop only.\n- Desktop-only `models` lists the selectable model catalog and supported\n","startLine":1,"endLine":58},{"path":"wiki/search/native-repository-search.md","quote":"  results/notices; no legacy index is queried.\n- Every Pi caller, including async/provider/council children, receives the same\n  unrestricted `project_search` schema and execution across sessions, tasks,\n  commits, code and knowledge, including `patch:`. Children suppress suite setup\n  commands and parent orchestration guidance only. Repository semantic embeddings\n  use the same explicitly configured global provider. Removed `repo_*` tools are not\n  part of ordinary search.\n\n## Optional reranking\n\n- The canonical global suite JSONC accepts optional `search.rerankerModel`, an OpenRouter\n  reranker model ID (for example `voyageai/rerank-3-lite`). Empty/omitted or invalid values\n  disable it. Project overrides, an API key alone, and legacy config do not enable it.\n  Desktop's **Reranker model** field edits this same global draft and uses its normal Save;\n  clearing the field removes the key. New default configs document it without enabling uploads.\n- Saving a nonempty model authorizes sending the query and bounded eligible Code/Knowledge\n  text plus Sessions/Tasks/Commits titles and snippets across projects in Pi/TUI/ACP/Desktop. Charges may\n  apply. Credentials use `OPENROUTER_API_KEY`, then shared Pi auth. This permission is\n  independent of `search.embedding`: hybrid/semantic queries can rerank local candidates\n  without embeddings. Removing embeddings does not disable a separately configured reranker.\n  Settings are excluded from remote reranking.\n- Pure lexical agent/native queries and document indexing never invoke reranking.\n  Desktop publishes local results first, then optionally reranks the merged selected\n  Sessions/Tasks/Commits/Code/Knowledge results after all source operations complete,\n  including late source replies. Embedding configuration is not required for this pass.\n  `project_search` hybrid/semantic queries likewise use one shared pass before final limits.\n  Up to 100 source-balanced candidates are sent once to\n  `https://openrouter.ai/api/v1/rerank`. History uploads contain only titles (512 characters)\n  and snippets (4096), never full sessions or diffs; native candidate content is capped\n  at 7500 characters. Provider documents remain capped at 8192 UTF-8 bytes each, while\n  the query plus all documents share a 32,000-byte UTF-8 budget. Native documents use\n  query-focused excerpts and avoid duplicate path/title headers. Each candidate shares\n  the remaining batch budget equally; truncated prefixes never split UTF-8 code points.\n  Code and prose with explicit identifiers, numeric anchors or acronyms retain contiguous\n  windows. Other prose uses extractive passages covering the whole question, or representative\n  sentences when there is no literal overlap. Selected sentences retain source order and\n  mark omissions with an ellipsis; this is not an answer-generation step.\n  Knowledge documents may include an explicit leading `Document status:` label from the\n  same hash-verified file used by freshness preflight. Only recognized leading `Status:`\n  metadata is used (first 32 lines, before a level-two-or-deeper heading, excluding fenced\n  examples); paths and incidental prose never imply status. The label shares the existing\n  byte budget, does not filter archived documents and adds no index schema or separate scan.\n  In-flight file changes still reject the ranking. Federated history that\n  cannot be verified during preflight stays in local results but is excluded from the\n  remote pool; verifiable candidates may still rerank with a partial notice. Revocation,\n  cancellation or stale sent-pool validation falls back to local order.\n  Candidate filters, deduplication and source policy apply before upload; native per-domain\n  caps and the requested final result limit apply after reranking. Returned relevance order\n  is preserved rather than re-sorted by local BM25. Desktop Settings retain their local slots.\n  Standalone native requests retain their Code/Knowledge pass; federated callers set\n  `skipRerank` and carry native freshness context to avoid double provider calls. Content upload does not\n  depend on `includeContent`; that flag controls only the returned payload.\n- Reranking has a four-second verification/slot/transport budget, bounded response size, no redirected\n  provider requests and strict index/score validation. Missing credentials, timeout,\n  provider errors and malformed responses retain original ranking with a redacted notice.\n  Global provider concurrency slots span transport lifetime. Source policy, configured\n  model, history source snapshots, native generation and current candidate bytes are checked around network work;\n  stale snapshots are not reranked, changed context rejects late ranking, caller cancellation\n  rejects the search. Periodic configuration/policy/generation checks cancel in-flight work;\n  no native SQLite handle is retained across reranker transport. History snapshots are\n  captured before retrieval and rechecked before upload and after transport. Desktop bounds\n  preparation to four seconds and the final request to 4.5 seconds, discarding late replies\n  even when an adapter ignores cancellation. CLI/Tauri `rerank` input is capped at 4 MiB\n  for bounded Unicode documents; other operations retain their 16 KiB input cap.\n\n## Optional semantic retrieval\n\n- The sole provider configuration is `~/.config/pi/pi-tools-suite.jsonc` (`HOME`, then\n  the operating-system home). Its valid explicit `search.embedding` object authorizes **all**\n  sources/projects in ordinary Pi, TUI, ACP and Desktop. There are no separate project,\n  task, session or settings opt-ins. Missing, malformed, oversized or redirected config\n","startLine":104,"endLine":174},{"path":"wiki/search/desktop-universal-search.md","quote":"  task hits by stable task ID; a semantic-only hit is not discarded by lexical\n  BM25 coverage rules. A disconnected, slow or failing ACP preserves fully\n  usable local task search with an independent diagnostic.\n- Commits search examines metadata for all ancestors of current HEAD, with no\n  30-commit window; it does not enumerate unrelated branches. The dedicated\n  `git_search_history` command leaves Source Control's 30-item history unchanged.\n  History examination and candidate selection run off the UI thread, returning\n  a bounded candidate list rather than serializing the whole history to the UI.\n  Aborting the search (new query, closed dialog) cancels the backend walk by\n  request id and kills its `git log`; each walk also has a 30-second deadline.\n  Fast native lexical matching covers subjects, full hashes and authors;\n  selecting either a native or hybrid commit hit opens Source Control and\n  the workbench Git Diff tab with that exact commit's read-only patch,\n  hash, subject, author and date. The transient search dialog closes only\n  after a valid commit diff is loaded. A separate ACP source performs\n  full-corpus BM25 plus semantic search over commit messages and metadata,\n  including non-literal matches. Changed-file paths (up to 256 paths / 32 KiB\n  per commit) enter local BM25 and previews, but not embedding inputs or hashes.\n  Previously paid vectors remain reusable; durable commit metadata refreshes\n  even when the content hash is unchanged. Hybrid results supersede duplicate\n  native hits without losing semantic eligibility, regardless of arrival order.\n  Search providers do not read diffs or mutate Git. Selection uses a separate\n  bounded, read-only native diff lookup; it rejects stale/non-HEAD-reachable\n  commit objects and cannot check out or modify the working tree. Root commits\n  and merges display their changes, with large patches visibly truncated.\n  Navigating to a newer search result, closing the dialog, or switching\n  projects invalidates a pending older commit reveal. Tasks-only searches\n  never invoke Git, and task embedding requires the global provider configuration. Missing Git or\n  malformed task storage reports a source-specific error without hiding other hits.\n- Explicit `patch:\u003cliteral\u003e` with Commits selected uses a read-only Git\n  pickaxe (`git log -G`, with the literal regex-escaped) over HEAD-reachable\n  changed lines. The scan is bounded to 50 matches and 8 seconds. Other\n  sources/native commit lookup are skipped. Patches are never embedded,\n  indexed or uploaded; returned commits open through the existing verified\n  read-only diff viewer. A missing ACP connection is reported, not silently\n  treated as no matches.\n- Commit history count is not capped. Hybrid indexing bounds individual Git fields to\n  64 KiB, and semantic document input to 8,192 characters including the saved\n  prefix and metadata; unusually large commit messages can therefore be truncated.\n- Hybrid commits use the global `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` provider,\n  knowledge embedding model, dimensions and prefixes; Desktop never selects or switches\n  the provider or alters the code/knowledge index. OpenRouter credentials use\n  `OPENROUTER_API_KEY`, then an API key in shared Pi `auth.json`\n  (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`); unrelated legacy configuration\n  and credentials are not read. The selected\n  provider may receive commit messages/metadata and search queries. The dialog\n  discloses that the first search may index the entire current HEAD history and\n  incur provider costs. This uses the same global semantic configuration as repository\n  search; history-specific settings remain separate.\n  Commit data and vectors live in `.pi/search/git-commits.sqlite`, in the\n  `pix_commit_meta`,\n  `pix_commit_documents`, and `pix_commit_vectors` tables. They reuse unchanged\n  commit hashes, content and compatible vectors across restarts and append new\n  commits. Reachability filtering excludes commits no longer on current HEAD.\n  Provider/model/dimension/prefix identity fences incompatible vectors; the\n  settings and commits vector tables may use distinct dimensions/encodings.\n  Legacy databases are not read, imported or migrated. Settings uses the shared\n  `~/.config/pi/search/settings.sqlite`; Sessions and Tasks use project-local\n  `.pi/search/sessions.sqlite` and `.pi/search/tasks.sqlite`. Stop and restart older\n  Pi/ACP/Desktop clients before using source-local stores: mixed-version writers\n  do not honor the new ownership protocol and are unsupported.\n  A changed incompatible embedding identity is never mixed with existing vectors.\n  A retained incompatible Settings cache blocks only settings-vector access, not\n  writes to the separate Task/Session namespaces. Compatibility errors report that\n  an explicit rebuild is required; normal indexing never silently replaces paid\n  vectors. Schema-2 Settings reconciliation belongs to Settings writes, not unrelated\n  namespace writes; global content-addressed vectors are retained across catalogues.\n  The global configuration editor explains recovery: run the suite's user-only\n  `/search-semantic reset-history` from the affected project to explicitly discard\n  derived project Task/Session/Commit vectors, never the global Settings cache.\n  Canonical tasks, sessions and Git history remain intact;\n  subsequent semantic searches can rebuild the cache and incur embedding charges.","startLine":250,"endLine":321},{"path":"wiki/proposals/agent-workflow-parity/background-shell.md","quote":"Когда задание завершилось, а сессия в этот момент выполняет ход, на ближайшей границе (`turn_end` / `agent_before_settle`) добавляется короткая custom-запись: «job X exited with code N, last lines…». Если сессия простаивает, запись показывается в UI **без** `triggerTurn`: автоматического продолжения агента нет, пользователь решает сам. Настройка `backgroundShell.notifyOnExit: \"context\" | \"ui-only\" | \"off\"`.\n\n### 2.5. Desktop и TUI\n\n- В статусе сессии появляется индикатор «N jobs». Поповер показывает список с хвостом вывода, кнопками Kill и «Open log».\n- ACP: приватное расширение-уведомление о смене статуса задания. Транскрипт рендерит вызов `Bash` с `run_in_background` как обычный tool call с бейджем job id.\n- Тяжёлое чтение логов не выполняется в UI-потоке.\n\n## 3. Безопасность\n\n- Политика команд та же, что у синхронного bash. Отдельно стоит решить, нужно ли подтверждение для фоновых сетевых серверов (bind на `0.0.0.0`) — это открытый вопрос.\n- Секреты в выводе проходят через существующий `credential-firewall` при отдаче модели, как и синхронный вывод.\n\n## 4. Риски\n\n- Утечки процессов. Это главный риск, нужны детерминированные тесты очистки.\n","startLine":47,"endLine":62},{"path":"wiki/context/dcp.md","quote":"tests are specified in [dcp-statistics.md](dcp-statistics.md).\n\n`/dcp stats`, TUI and Desktop share the read-only statistics formatter. It\nseparates dated context snapshots, durable block/commit metrics and recorded\nprovider reminder delivery; it never equates context callbacks with sends.\nOptional commit metrics live on the first block of a journaled transaction.\nScalar `dcp-diagnostic` observations are not projection or recovery authority.\n\n## Journal contract\n\nThe only supported durable format is `dcp-journal`, schema version 1. Operations\nform an append-only predecessor chain beginning with `init`; later `delta`\nrecords contain only changes required to reproduce the provider projection:\n\n- newly allocated stable-message → `mNNN` assignments and the high-water mark;\n- new exact v2 compression blocks and their active/superseded state;\n- explicitly committed pruned tool-result IDs and reasons;\n- the session-local manual-mode value when changed;\n- frozen nudge anchor data required to reproduce already published control text.\n\nEvery modern compression block has `version: 2`, an explicit replacement mode,\nordered `sourceMembers` and `mutationMembers`, and canonical content hashes. New\nblocks are immutable except for derived active/deactivation state. Reusing an\noperation ID with identical bytes is idempotent; reusing it with different data\nis a conflict.\n\nThe journal intentionally excludes full raw history, provider payloads, complete\ntool records, provider-seen evidence, pressure counters, and periodic snapshots.\nNo-op context transforms do not grow it.\n\nOn replay, transient tool records are reconstructed from raw branch messages;\ntool-result output text matches live capture byte-for-byte, including\nempty/whitespace content and adjacent text parts (without presentation\nseparators). Provider-seen evidence remains unknown after restart.\n\nPublication uses the host session append boundary. DCP validates and prepares a\ndetached state, revalidates owner/source/config/model, appends the operation, and\nonly then installs the committed projection in live state. The current host\ncontract does not claim stronger power-loss durability than the session manager\nitself; DCP does not add a second WAL, file lock, or `fsync` persistence engine.\n\n## Canonical identity and exact replacement\n\n`conversation-index.ts` builds ordered identity from the actual current\nprojection. Stable session entry identity wins over timestamps; equal timestamps\nare disambiguated by branch order and stable IDs. If the host exposes a lazy\ntail-only branch view, DCP recovers those entry identities through the host's\nfull-branch reader before rebuilding the projection. A modern exact operation\nis never widened by guessing a same-timestamp neighbour.\n\n","startLine":85,"endLine":134},{"path":"wiki/operations/desktop-lsp-onboarding.md","quote":"  selected server, progress, bounded install output, success/failure, and Retry\n  after failure. Success/error states may be closed normally.\n- Successful installation never continues the agent automatically. A paused\n  conversation stays paused until the user explicitly chooses Continue.\n- Only one pause/install pipeline is active at a time. Missing-LSP suggestions\n  from other sessions may be retained, but they stay hidden until the current\n  installation finishes so one installer tab cannot be overwritten by another.\n\n## Trusted installation\n\n- Desktop dispatches only hard-coded native installer IDs. No command text from\n  the model, mutation result, file contents, or session-state notification is\n  executed.\n- Package-manager work runs in a blocking Tauri worker rather than the UI thread.\n  Installed payloads use Pix-owned user locations where practical:\n  `~/.local/share/pix/lsp/\u003cid\u003e/`.\n- TypeScript/JavaScript, Svelte, and Vue use fixed npm package sets. Python uses\n  a Pix-owned virtual environment. Go uses a Pix-owned `GOBIN`. Ruby uses a\n  Pix-owned gem home. Rust uses the user's `rustup` component installation.\n  Missing package-manager prerequisites fail visibly in the installer tab.\n- After installation Desktop writes the fixed server template and returned\n  executable path/env into the trusted user\n  `~/.config/pi/pi-tools-suite.jsonc` LSP server list. JSONC comments and\n  unrelated settings are preserved, an existing server with the same ID is\n  replaced, and optimistic conflict checks retry before failing visibly.\n- Project-local `.pi/pi-tools-suite.jsonc` trust semantics are unchanged.\n  Installing an LSP does not auto-trust or rewrite project-local LSP commands.\n\n## Lifecycle and concurrency\n\n- Workspace changes clear pending warning/install UI state. A late native\n  installation result from the previous workspace is rejected before a new\n  user-config registration begins and cannot overwrite installer UI for the new\n  workspace.\n- Native package installation may already have written files before a workspace\n","startLine":57,"endLine":91},{"path":"wiki/development/release/release-distribution.md","quote":"plugin only when the `bundled-runtime` Cargo feature is enabled, so ordinary\ndevelopment/debug bundles do not require a `plugins.updater` configuration.\nThe release orchestrator also exports `VITE_PIX_DESKTOP_UPDATER=1` while Tauri\nbuilds the production frontend; without that explicit build flag the WebView\ndoes not start an updater check. This keeps `watch:all` and `tauri dev` from\ninitializing release-only updater state while preserving updater behavior in\nofficial release artifacts.\n\n## Verification\n\n`test:release` covers targets, checksums, complete-asset gates, version propagation,\npublished-release protection, stale output cleanup, platform filtering, conservative\ndependency sharing, bin shims, and strict size/content gates.\n`tests/release-update.test.ts` covers corrupt portable markers, no npm mutation\nunder `node_modules`, force behavior, stable GitHub metadata, exact asset/checksum\nselection, TUI/Desktop updater separation, and swap rollback. Desktop updater\ntests cover progress, install/restart, duplicate-install suppression, failure UX,\nand stale completion after disposal. Release packaging tests cover the exact\nsigned updater asset set and generated three-platform `latest.json`. Rust\n`backend_runtime` tests cover relocation, missing resources and development\noverrides.\n\nEvery built archive is extracted outside the checkout into paths with spaces.\nThe smoke harness isolates the user profile, allowlists only OS/session environment\nvariables (no provider/signing credentials), removes development Node/npm paths,\nadds a failing system-Node sentinel, invokes the real launcher, and runs the exact pinned\nbundled Node. It loads native clipboard/PTY dependencies (PTY execution asserts\nexplicit output), bundled JS/TS extensions and every retained esbuild binary. The\nesbuild probe reads the generated `DEPENDENCIES.json` inventory instead of recursively\nwalking the full dependency tree, avoiding pathological Windows filesystem cost.\nDesktop\nadditionally runs real ACP initialize/new/close without a model request; TUI\nasserts that ACP is absent. An inventory without esbuild is valid: Pi SDK 1.2\nloads TypeScript through jiti and no longer requires production esbuild. This\ndoes not skip the real JS/TS extension-load checks or allow a retained esbuild\ninstance to fail its transform. The standalone `verify.mjs` ships its built-in-only\n`esbuild-probe.mjs` helper alongside it. GUI checks use an app copied from a read-only mounted DMG, extracted DEB/AppImage\nor a temporary NSIS installation, and boot the native application diagnostic.\nLinux checks the DEB payload directly; for the AppImage it intentionally lets the\nnative Tauri host resolve `resource_dir()` from the extracted AppDir instead of\nhardcoding an AppImage-internal resource path. The DEB smoke likewise discovers\nthe unique installed `pix-runtime/release.json` instead of assuming a particular\nTauri Linux resource directory layout. Extracted AppImage native smoke launches\nits `AppRun` entrypoint rather than the inner executable so linuxdeploy's library\npaths and WebKit helper-process environment are preserved.\n\nThe copied `verify.mjs` is a one-shot verifier. After all assertions (and Desktop\nACP shutdown) succeed and it prints `PIX_RELEASE_RUNTIME_OK`, it exits explicitly.\nThis avoids native dependency handles keeping Windows Node alive after successful\nverification; the explicit exit is never reached on an assertion/RPC failure.\nThe native check must produce the backend completion marker, not merely exit\nsuccessfully. macOS executable paths are canonicalized rather than weakening\nTauri's protection against symlink-based resource resolution.\nAll process ceilings are deadlock safeguards, never speed assertions. Cross-OS\nsupport is verified by the native CI jobs, not inferred from a successful macOS\nbuild. Signing with real certificates still requires a credentialed release run.\nThe generic release subprocess ceiling remains 20 minutes, while the single Tauri\nDesktop packaging subprocess gets a 35-minute ceiling because a cold Windows\nRust build plus NSIS generation can legitimately exceed 20 minutes. The\nGitHub native job retains its independent 60-minute hard ceiling.\n\nWindows publishes only the NSIS installer. MSI is intentionally omitted because\nthe signed Tauri updater feed and native smoke both use NSIS; carrying a second\ninstaller adds several minutes of packaging time without adding a supported\nupdate path. Windows NSIS smoke passes encoded installer/destination paths in the\nPowerShell command itself rather than through inherited environment variables.\n\n## Implementation\n\n- `scripts/release/`: preparation, Node downloads, signing, installers, smoke and publication; launcher scripts are under `scripts/release/launchers/` and release tests under `scripts/release/test/`.\n- `.github/workflows/check.yml`: PR/master correctness matrix.\n- `.github/workflows/publish.yml`: release contract, native matrix and stable Release publication.\n","startLine":432,"endLine":503},{"path":"wiki/configuration/guide.md","quote":"defaults. These settings apply to new or reloaded Desktop runtimes. The\nstatusbar popup's switch saves a per-session choice, restored after app restart,\nwithout changing configuration or other sessions. An explicit saved choice takes\nprecedence over the enable default; all other observer settings still use the\nprofile. A trusted project `.pi/pix-desktop.jsonc` can override defaults.\nDesktop does not inherit `heads-up.jsonc`; that remains the TUI observer config.\nEnabling an observer sends bounded conversation excerpts to its chosen provider.\n\n## pi-tools-suite configuration\n\nThe bundled suite loads:\n\n1. `~/.config/pi/pi-tools-suite.jsonc`;\n2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;\n3. the nearest project `.pi/pi-tools-suite.jsonc`.\n\nLater files override earlier files.\n\nDisable individual modules with `disabledModules` or\n`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with\n`PI_TOOLS_SUITE_DISABLED=1`.\n\nTo hide selected bundled async-subagent roles without disabling the sub-agent\nmodule, use `disabledBuiltinAgents`. A later config layer can re-enable inherited\nnames with `enabledBuiltinAgents`. These keys affect bundled roles only;\nsame-named project roles in `.pi/agents/*.md` remain available.\nDesktop exposes the user-level `disabledBuiltinAgents` list under\n**Settings → Tools Suite → General → Built-in agents**.\nThe same General section exposes built-in suite modules as an enabled/disabled\nchecklist instead of raw `enabledModules` / `disabledModules` / `modules` JSON.\n\nDCP is intentionally narrower than the general suite layering above: its\n`dcp` section is read only from the user-level\n`~/.config/pi/pi-tools-suite.jsonc`. Protected tool continuity is bounded by\n`dcp.compress.maxProtectedToolContinuityBytes` (default `16384`). The budget\napplies to shaped tool receipts/digests in one compression block; exact\nprotected fragments are never silently truncated to satisfy it. Receipts show\nraw output size only; content hashes stay in fragment metadata and are not\nsent to the model.\n\nThe model setup wizards write the same suite model keys: TUI `pix install\n--models` and Desktop's model setup dialog both set `frontierModels` (the Strong\nmodel is the primary; extra frontier models have no role default; an untouched\nlist keeps existing entries with their flags and aliases),\n`builtinAgentModels`, the DCP summarizer pair and the vision `lookupModel` /\n`lookupFallbackModels` pair (optional, written only when set or cleared) and,\non explicit request, `search.embedding` / `search.rerankerModel` in the\nuser-level suite config (enabling embeddings sends project code and knowledge\ntext to the chosen provider).\n\n## Model providers\n\nPix uses credentials supported by Pi. The common paths are:\n\n| Need | Setup |\n| --- | --- |\n| Normal provider auth | Run stock Pi (`npx @earendil-works/pi-coding-agent`) and use `/login`, or configure the provider's supported environment/API-key source |\n| Existing OpenCode credentials | Run `/opencode-import` in Pix |\n","startLine":373,"endLine":430},{"path":"wiki/decisions/0064-sqlite-project-tasks.md","quote":"# 0064 — SQLite-only project tasks with restricted mutations\n\n- Status: accepted\n- Recorded: 2026-10-10\n- Decided: 2026-10-10\n- Owner / approval evidence: user chose SQLite for the Tasks panel and\n  explicitly rejected legacy-format support or migrations.\n- Governing specs: [Desktop Tasks](../work-management/tasks/desktop.md) and\n  [agent task tool](../work-management/tasks/project-tasks-agent-tool.md).\n- Replaces: [0063 — Kernel-owned task-file exclusion](0063-task-file-kernel-lock.md).\n\n## Problem\n\nAn agent and Desktop previously rewrote a shared JSONC task document. The\noperation could overwrite unrelated tasks and required an interoperable\ncross-process lock module (native Koffi and Rust kernel file locks). Separately,\npath-based attachment markers made ownership and Registry transport cumbersome.\n\n## Decision\n\n- A single project-local `.pi/tasks.sqlite` database (schema v1) is the only\n  source of saved tasks. Older `tasks.jsonc`/`tasks.d` files are never read,\n  imported or migrated. They are not canonical project state: Desktop\n  `.pi` cleanup (manual Clean and TTL) treats them as reclaimable.\n- SQLite WAL, foreign keys and bounded busy timeout replace all custom\n  cross-process task lock files, native bindings and lock-cleanup logic.\n- Last-close cleanup may unlink `-wal`/`-shm` while another reader inspects\n  their metadata. APFS can then report `nlink=0`; this is not a hard link.\n  All three readers (Desktop Rust, agent storage and ACP Registry) accept\n  this transient unlinked sidecar state while still rejecting real sidecar\n  hard links (`nlink\u003e1`), symlinks, and hard links to the canonical DB.\n- Task state is represented by one validated JSON payload **per database row**,\n  a monotonically increasing per-task revision and a stable task id. The\n  restricted API uses one-row transactions and rejects stale revisions.\n- The agent tool exposes list/get/create/update, with strict patch fields and\n  consent guidance. User-invoked `/task delete` and `/task attach` are not\n  accessible through that tool. **The Desktop UI remains fully interactive:**\n  create/edit/delete, status, priority, Quick Add, drag-and-drop, Composer task\n  capture and attachment management are preserved. Only the restricted tool\n  cannot delete/reorder.\n- Task attachments are immutable SHA-256 blobs, related by task id and hash in\n  SQLite; descriptions do not contain owned file references.\n- Registry synchronizes a consistent SQL snapshot and linked blobs. It never\n  byte-copies an active SQLite database without its WAL or mutates the local\n  database through whole-file replacement. A pull is an explicit bulk\n  synchronization operation, distinct from the agent's task-level tool.\n\n## Consequences\n\nIndependent task updates no longer overwrite one another. SQLite still uses\nnative OS locks internally, but their lifetime and concurrency semantics are\nmanaged by SQLite rather than handwritten application protocols.\n\nThe clean break intentionally means that old tasks are **not visible** until\nthe user recreates them explicitly in SQLite; the old files remain on disk\nwithout automatic deletion. An agent with unrestricted filesystem access\ncould bypass this tool; preventing every form of direct write requires\nindependent OS capability/sandbox restrictions, not only a restricted API.\n\n## Validation\n\n- Task-tool tests: single-row updates, conflicts, deletion restrictions,\n  immutable blob associations, explicit slash commands, no legacy fallback.\n- Desktop Rust tests: schema initialization, per-task changes, no-follow\n  storage checks, attachment integrity and Registry indicator.\n- ACP Registry tests: SQLite push/pull, attachment content, provenance.\n- Desktop UI tests: full CRUD controls, task drag, filters, run and session\n  reopening. Rust tests cover task-only mutation, atomic attachment links and\n  position rebalancing without overwriting unrelated content.\n\n\n","startLine":1,"endLine":71}],"notices":["Результат 1 не прошёл проверку: цитата отсутствует в предоставленном тексте.","Список источников в сохранённом отчёте сокращён по размеру; объём выполненной проверки указан отдельно."],"coverage":{"scope":"retrieved-passages","checkedPassages":24,"candidateSources":108,"excerptedSources":22,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"],"retainedPassages":12}}} -->
# pi-tools-suite

Local all-in-one Pi extension package.

This package keeps shared Pi tools as ordinary source folders under `src/` and registers them through one entrypoint.

When hosted by Pix TUI/Desktop, selected suite failures and degradations are
reported to Pix's shared JSONL diagnostics (`~/.config/pi/logs/`). These
payload-free, rate-limited events cover module loading, DCP, search indexing,
subagents, TODO/project tasks, workspace grants, LSP, auth and web provider
fallback. In particular, DCP auto/manual failures and unsafe provider sends,
plus failed manual and background indexing, have distinct diagnostic events. They do not
copy ordinary tool outputs, prompts or UI notifications into logs. Logging is
non-blocking and optional; standalone Pi remains independent of Pix's runtime,
and detailed DCP/subagent logs remain separate. Search indexing writes
selected metadata to the shared Pix Logger without a project-local log file. See
[`wiki/operations/logging.md`](../operations/logging.md).

The opt-in [Headless Tool API](headless-tool-api.md) executes the
original Pi SDK read and Pix model-specific shell/patch tools alongside
standalone extension tools, without a second Pi/ACP model session. ChatGPT
selects the GPT/Codex profile, not Claude's aliases. The host controls
workspace scope, read-only mode and approvals. The bridge also exposes the
original Pix `todo` tool with session-scoped persisted state and the original
async `subagents` actions through a detached broker, including project-local
roles from `.pi/agents/*.md` (`subagents_catalog` lists them).
The headless tool inventory provides the original Pix tool descriptions for
MCP `tools/list`, with headless-specific caveats for `subagents`. It does not
export the full Pi parent prompt, `coding-discipline`, DCP or other
`before_agent_start` instructions into MCP initialization.

- `src/claude-code-provider` — maintained local Claude Code subscription adapter,
  derived from upstream 0.5.0 with Pix image-count/recovery fixes. See
  [origin and updates](../../external/pi-tools-suite/src/claude-code-provider/UPSTREAM.md). Before switching
  an existing installation, run `npm run migrate:claude-provider` at the Pix
  root, then `npm run sync:pi-tools-suite` and restart Desktop/TUI. Disable old
  provider declarations in trusted project settings and explicit launch args
  too. The migration retains the external npm package on disk.

- `src/coding-discipline` — injects a deduplicated silent-mode and quality-discipline block at the very top of the main-session per-turn system prompt for GLM main-session models only (`isGlmModel`) immediately before the LLM request; text-only GLM models get the `lookup` bridge while vision-capable `zai/glm-5.3-flash` inspects images directly; non-GLM models are left untouched; disabled for async sub-agents
- `src/credential-firewall` — opt-in secret firewall for high-confidence outbound/session credential redaction; disabled by default
- `src/ast-grep` — `ast_grep` / `ast_apply`
- `src/background-shell` — background shell jobs: `run_in_background` on `Bash`/`bash`/`shell`, `shell_output`/`shell_kill`/`shell_jobs` (Claude aliases `BashOutput`/`KillShell`), `/background-jobs`, per-session process-group lifecycle, orphan detection, exit notices and the Desktop/TUI job indicator; see [the background shell contract](background-shell.md)
- `src/brainstorm` — `/brainstorm [--mode auto|brainstorm|audit] <topic>` forwards to the explicit `brainstorm` skill; five-round council via ordinary `subagents` and a deterministic helper, with reviewed parent synthesis and no implementation. Protocol files live under configured council storage (default `.pi/brainstorms/`). No dedicated tool, ACP host or Desktop council UI. See [the council contract](../assistants/brainstorm.md).
- `src/async-subagents` — `subagents` tool and sub-agent slash commands, including oh-my-openagent-style `/ultrawork` (`/ulw`) and `/hyperplan` orchestration prompts; roles are Markdown files under `src/async-subagents/agents/*.md` plus project `.pi/agents/*.md`; parent implementation is default, with handoffs only for explicit user delegation, an implementation capability gap, or sufficiently large prescribed mechanical work whose deterministic checks and expected net savings justify overhead; includes a cross-vendor `oracle` profile for bounded second opinions and complex architectural review; defaults to a 3-hour per-agent execution timeout when none is specified (explicit timeouts override it), with project-wide concurrency queueing, optional per-agent retry/backoff, and structured result/chaining metadata in parent session lifecycle entries; child JSONLs live under `.pi/subagents/<scope>/`, with no new run directories, registry or per-agent result sidecars, so result/status collection can recover from the parent session records after compaction or reload; clean Pi TUI sessions additionally get a live native widget for queued/running/retrying agents, while Pix keeps its renderer-owned presentation
- `src/lsp` — shared LSP diagnostics hook/library that enriches mutating tool results with diagnostics and shuts down language servers on session shutdown
- `src/comment-checker` — AI-slop comment guard that listens to the `tool_result` event for `write` / `edit` / `apply_patch` mutations, extracts net-new code comment lines, classifies them (filler phrasing, restating code, decorative separators, generic paraphrasing, or — under aggressive strictness — any non-valuable comment), and appends a short nudge to the tool result so the agent removes unnecessary comments on its next turn; TODO/FIXME, license headers, docstrings, pragmas, linter directives, shebangs, and decorators are never flagged; language-agnostic across `//` / `/* */` / `#` / `--` / `<!-- -->` / triple-quote comment styles; per-session deduplication (at most one nudge per 30 s) prevents fix/remark loops; configured via the `commentChecker` section (`enabled`, `strictness`: `conservative` | `balanced` | `aggressive`, default `balanced`) or `PI_COMMENT_CHECKER_ENABLED` / `PI_COMMENT_CHECKER_STRICTNESS`
- `src/session` — one `session` tool for naming and bounded raw-history recovery through `action: name | overview | read | search | recovery`; no old tool aliases
- `src/truncation-metadata-normalizer` — default-on metadata cleanup for SDK-truncated `Read` / shell / `ast_grep` results; removes only a proven duplicate `details.truncation.content` copy while preserving visible content and structural truncation metadata; can be disabled through the normal module config
- `src/repo-discovery/subagent.ts` — internal child facade for native project search, not a catalog module or command registrar.
- `src/project-search` — always-registered `project_search`, with the same full schema and execution for ordinary Pi and every async/provider/council child: authoritative
  project stores are read-only; explicitly opted-in semantic searches can
  incrementally write the project-owned search-vector cache.
  Searches saved Sessions (first user/last completed assistant on the active
  branch), Tasks, HEAD-reachable commits and changed paths, and Code/Knowledge
  via the native backend. `patch:<literal>` searches Git
  changed lines only on demand. Available in both Pix Desktop and TUI without
  a second LLM, another persistent index or implicit setup. Hits carry bounded
  snippets plus source identities (file/line, commit, session path or task ID).
  `indexMode: "lexical"` avoids embedding calls; repository semantic retrieval
  is authorized by `search.embedding` in the shared global `~/.config/pi/pi-tools-suite.jsonc` config.

- `src/project-tasks` — default-enabled `project_tasks` reads and edits saved
  cwd `.pi/tasks.sqlite` tasks (`list`, `get`, `update`, `create`), plus
  explicit-user-request `run` via Pix Desktop Tasks Run (separate session or
  open an already-linked session; no duplicate prompt),
  independently of repository search. Updates are scoped to a single row and protected by
  SQLite transactions plus optimistic task revisions. The agent tool cannot
  delete or write SQL; user-invoked `/tasks list`, `/task get|add|update|delete`
  and `/task attach` perform validated user operations. Stored attachments
  are content-addressed SHA-256 blobs. This is separate from session `todo`.
  No legacy JSONC/overlay task import. See
  [contract](../work-management/tasks/project-tasks-agent-tool.md).

The ordered module catalog registers `project-search` without a repository-state gate.
Children suppress suite
setup commands and parent orchestration guidance only; they receive no restricted
search facade. Repository embeddings use the shared global configuration and
saved-provider safeguards.
- `src/antigravity-auth` — `antigravity` custom provider with Google Antigravity OAuth login, startup account list, auth.json-only runtime account loading, `/antigravity-add-account` OAuth append into rotation, `/antigravity-account` status display, account rotation/failover, model registration with live route mapping (current Antigravity catalog: Gemini 3.5/3.6/3.7/3.8 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6 Thinking, Claude Opus 4.6 Thinking, GPT-OSS 120B Medium, plus legacy Antigravity aliases and Gemini CLI mirrors), and streaming through the Cloud Code Assist unified gateway
- `src/opencode-import` — `/opencode-import` for bounded migration of supported OpenCode OpenAI/Codex, GitHub Copilot, Z.ai, and Antigravity credentials into Pi; existing entries are preserved unless `--force` is passed
- `src/question` — clean-Pi-only native `question` tool with the suite questionnaire contract, multi-select/custom-answer support, and a transient questionnaire widget kept immediately above the real Pi composer; Pix deliberately skips this module because Pix owns its bundled question renderer/Desktop bridge
- `src/todo` — `todo` tool, `/todos`, `/todos-persist`, `/todos-scope`, and `/todos-clear` (also `/todos clear`); supports parent/subtask hierarchy, blockers, ready-task filtering, deferred out-of-scope items, batch operations, JSON/Markdown import/export, automatic clearing when all visible todos are completed, and optional project persistence via `/todos persist on` or `/todos-persist on`; clean Pi TUI sessions also show the active plan as a native widget, while Pix presentation remains renderer-owned; localization/i18n has been removed
- `src/model-tools` — model-specific tool aliases such as Claude/GLM-style `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `LS`, GPT/Codex-style `shell`, and model-gated `apply_patch`. `/shell-workdir allow <path>`, `list`, and `revoke <path>` manage canonical extra workdir roots for the current session only; user-level `"restrictShellWorkdir": false` removes the workdir boundary; see [the shell workdir contract](../operations/shell-workdir-session-grants.md).
- `src/usage` — `/usage` command and startup hint for read-only AI quota checks across OpenAI, Zhipu AI, Z.ai, and Google Antigravity, including Antigravity quota by model
- `src/web-search` — `web_search` and `web_fetch` tools migrated from `@ollama/pi-web-search`; uses local Ollama by default or the official Ollama cloud API when an API key is configured, supports Tavily Search/Extract fallback, provides `/web-credentials` for secure user-level key storage, honors `OLLAMA_HOST`, supports request timeouts via `timeout_ms` / `PI_WEB_SEARCH_TIMEOUT_MS`, and reports provider-specific errors
- `src/dcp` — Dynamic Context Pruning ported from `opencode-dynamic-context-pruning` for the Pi SDK: explicit `compress` tool with range and message modes, `/dcp` commands (context, stats, sweep, manual, decompress, recompress, compress), same-call overlap validation, recoverable compressed-block rollups, grouped message-mode skip diagnostics, stable raw-message anchors when available, protected user/tool preservation, deduplication, error purging, and context nudges; clean Pi TUI sessions show a native context-capacity map driven by live SDK occupancy and the cached prepared DCP classification, while Pix keeps its existing renderer/Desktop visualization
- `src/prompt-commands` — user slash-command builder: `/prompt-commands` opens a CRUD menu for saved prompt-backed slash commands, stores them under `promptCommands` in `~/.config/pi/pi-tools-suite.jsonc`, reloads after edits, and runs each saved prompt as a normal user message
- Resource Registry is Desktop-only and runs directly in the Pix ACP service; tools-suite no longer registers `/registry` or a TUI Registry module. Existing `resourceRegistry` JSONC settings remain compatible with Desktop.

`index.ts` is intentionally only a thin auto-discovery shim that re-exports `src/index.ts`. There is no `pi.extensions` manifest here, so local Pi auto-discovery loads the suite once via `~/.pi/agent/extensions/pi-tools-suite/index.ts` and does not double-register tools. `src/module-catalog.ts` is the ordered single source of truth for bundled module names, defaults, descriptions, and host policy; runtime registration derives each conventional `src/<module-name>/index.ts` loader from that catalog, and Desktop Settings consumes the same metadata without importing runtime modules.

Registration order is preserved by the ordered catalog in `src/module-catalog.ts`. `project_search` uses native search and without external-backend setup or fallback. Repository and history semantics are enabled across sources/projects when the global `~/.config/pi/pi-tools-suite.jsonc` contains a valid `search.embedding` object; eligible semantic inputs may be sent to its configured endpoint. Project overrides and the former standalone semantic configuration do not authorize uploads and are not migrated. `/search-semantic configure` preserves JSONC comments and unrelated settings; Desktop edits the same configuration under Tools Suite → Search using the shared top Save button. See [project-search-agent-tool](../search/project-search-agent-tool.md). The Pix-maintained Claude provider does not register `pi_claude_code_provider_web_search` at all. The unconditional guard in `src/index.ts` (see [provider-web-search-policy](provider-web-search-policy.md)) also blocks legacy or third-party copies in parent sessions, while keeping Claude models and the suite's separate `web_search` available. Sub-agents exclude that name through their own guard.

### Native repository embedding setup and privacy

Native lexical search requires no credentials. `/search-semantic status` shows
whether global semantics are configured. `/search-semantic configure <embedding JSON>`
saves the embedding object and authorizes semantic retrieval for all sources/projects;
`/search-semantic off` removes it. `/search-semantic reset-history` is an explicit
user-only recovery command for incompatible history caches in the current project: it
clears only recognized derived task/session/commit vectors and identity metadata
from their project-local databases (`tasks.sqlite`, `sessions.sqlite`, `git-commits.sqlite`),
preserving canonical tasks, sessions and Git history. The shared all-project Settings
cache (`~/.config/pi/search/settings.sqlite`) is never reset by this command. Repository
vectors live alongside source chunks in `code.sqlite` and `knowledge.sqlite`; they are
unchanged by this history reset. Legacy databases are not read, imported or migrated.
Schema-1 Settings caches are rejected without mutation. Status inspection never repairs
stores. Stop and restart every
older Pi/ACP/Desktop client before using split stores; old clients do not honor the new
work protocol and mixed-version writes are unsupported. A separate global
`~/.config/pi/search-provider-work.sqlite` coordinates at most four concurrent provider
leases; after a crash or partition this cannot prove the count of remote provider
executions. Source/provider leases renew every 30 seconds and expire after 90 seconds.
Queued sources keep their claim renewed and recheck after acquiring a slot; cancellation
retains ownership until tracked transport settles, and lost owners cannot publish. After
two failed/interrupted network attempts (initial plus one automatic retry), explicit
Continue is required; success resets failures, and Continue clears the exhausted budget
before reconciliation. A short failed-work cooldown applies. Crashes after transmission
can still result in duplicate provider billing; this is not exactly-once delivery. See
[decision 0070](../decisions/0070-search-source-work-recovery.md).
The next search can re-embed and incur charges. Busy, unsafe, redirected or unrecognized
storage fails closed without a reset. Desktop Settings Search edits the same global file
without ACP. No independent consent flag or confirmation step is used. Old
`.pi/search/semantic.json` and Desktop semantic booleans are ignored; keys/caches alone
never activate semantics. OpenRouter credentials use `OPENROUTER_API_KEY`, then shared
Pi auth storage (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); Ollama needs no key.

Optional `search.rerankerModel` in the same global suite JSONC enables OpenRouter
one merged rerank of selected Sessions/Tasks/Commits/Code/Knowledge results, independently of
`search.embedding`. For example, `"rerankerModel": "voyageai/rerank-3-lite"`.
Saving a nonempty model authorizes sending queries and bounded candidate text
across projects; charges may apply. Missing/empty values disable it; credentials
alone do not enable it. Pure lexical agent/native search and indexing never invoke reranking.
Desktop publishes local results first, then optionally reranks once all sources finish.
Settings remain local. History sends bounded titles/snippets, not entire sessions/diffs;
the source-balanced 100-candidate pass precedes final result limits.
Desktop's **Reranker model** field uses the same draft and normal Save; clearing
it removes the key. `/search-semantic off` only removes embeddings, not a separately
configured reranker. Provider failure/timeout retains original ranking. See
[native repository search](../search/native-repository-search.md#optional-reranking)
for limits, filtering and lifecycle safeguards.

To configure file suffixes for native repository search, set `search.codeExtensions`
and/or `search.knowledgeExtensions` arrays in the global
`~/.config/pi/pi-tools-suite.jsonc` settings. For example:

```jsonc
{
  "search": {
    "codeExtensions": [".gdshaderinc", "mydsl"],
    "knowledgeExtensions": [".guide"]
  }
}
```

Each configured list replaces the full built-in list for that category; lists are not
additive. An explicit empty list disables the category, while an omitted list uses its
built-in defaults. Only configured suffixes are indexed; filenames such as `Dockerfile`
and `Makefile` have no special handling. Entries are simple 1–32 character suffixes
(letters, digits, `_`, `+` or `-`), with optional leading dots; matching is
case-insensitive. Each source accepts at most 128 entries, and the effective Code and
Knowledge lists must not overlap. Unsupported paths/globs and invalid or overlapping
settings are rejected. Normal ignore, binary, size and link exclusions still apply.
Changes take effect on the next explicit search/index scan; saving settings alone does
not scan or trigger embeddings. Project-local settings do not override these lists.

The [Codex reasoning replay spec](../providers/codex-reasoning-fix.md) owns the
last suite hook's narrow wire-only contract, evidence, and known cached
WebSocket continuation limitation.

## Brainstorm council configuration

Brainstorm is a skill driven by the parent through ordinary `subagents`, not a
dedicated tool or ACP council host. `/brainstorm <args>` forwards to
`/skill:brainstorm <args>`; natural-language requests do not auto-load it.
`modules.brainstorm: false` removes both entry points.

The helper reads normal global/project `pi-tools-suite.jsonc` layering itself.
The roster defaults to `frontierModels`; explicit `--models` is a user-selected,
run-only override, not permission for the parent to substitute cheaper models.
Timeout, output root and quorum remain configured. Participants are read-only,
with `read`, `grep`, `web_search`, `web_fetch` and `project_search`; no shell,
edits, suite setup or nested agents. Privacy instructions are not a network sandbox.

The current manifest is `pi-brainstorm-v6`. Legacy v4 and earlier protocols
remain readable evidence but cannot continue; there is no automatic v2/v3-to-v4
continuation in the current skill. Participants appear in the ordinary Subagents
status popup and read-only session viewers, not a dedicated council HUD.

The [brainstorm contract](../assistants/brainstorm.md) owns the five-round
workflow, helper commands, continuation validation, file handoff and failure
semantics. [0071](../decisions/0071-brainstorm-skill-on-subagents.md) records the
replacement of the old tool; [0017](../decisions/0017-brainstorm-v4-protocol-storage.md)
preserves historical storage/quorum/ledger rationale, not legacy continuation rights.

## Repository knowledge and spec maintenance

Use `project_search` for both broad repository discovery and focused lookup,
selecting sources and options as needed. It defaults to all five sources; Code and
Knowledge use native search exclusively. Follow
truncation/degradation diagnostics and read primary sources before relying on a
summary. The former `repo_context`, `repo_inspect`, `repo_audit` and `repo_search`
tools and the `/idx-init` and `/idx-update` commands are removed.

For a **material behavior-changing implementation**, the
model-facing contract is:

1. Find the existing primary behavioral contract before or while implementing.
2. Keep the governing spec aligned with the intended behavior in the same task.
   If none exists, create a focused spec with normal file editing tools. For a
   new spec, use the project's spec template (`specs/TEMPLATE.md` when present)
   without overwriting existing documents. If no template exists, ask before creating one.
   Declare
   `kind: spec` and intended `status` in frontmatter and list
   project-relative implementation/test paths in the appropriate sections.
3. Before completion, run the available `knowledge-auditor` with the final
   behavior/result and exact task-changed paths. It updates affected documentation
   against relevant source/tests, makes small proven fixes and returns substantial
   or ambiguous discrepancies to the parent. Obtain the result and resolve concrete
   documentation questions. If the role is unavailable, maintain the docs directly.
   This needs no knowledge dirty check, acknowledgment, index refresh or full
   traversal of declared dependencies. Accurate documentation needs no edit;
   do not expand into unrelated work.

Retrieval is bounded: output may be truncated, hybrid mode may degrade with
diagnostics, and an empty result does not prove that no contract exists.
Document metadata and inferred purpose are navigation aids, not a semantic
correctness verdict. The reviewer owns the final decision.

### Decision history

Keep current behavior in specs and significant rationale in `docs/decisions/`,
following the project's convention/template. Before changing a contract, read
linked decisions and check status/superseding links. Historical rationale does
not override the current spec. Plain Markdown already participates in retrieval
subject to normal exclusions; no special document kind or new storage is required.

Default to no new record. Record a decision only when explicitly requested by the
user, or when a choice involves materially different plausible alternatives,
consequential accepted risk or costly reversal AND its durable rationale will
help avoid repeating a dispute or mistake not already captured by an existing
record. Ask whether the rationale will still be useful in six months. A feature,
UX change, bug fix, implementation detail, dependency/model change or changed spec
alone is not a trigger. Keep ordinary behavior in specs; do not invent alternatives
or duplicate existing records. Apply this threshold prospectively without pruning
or rewriting history.

For qualifying choices, the parent records rationale while context is available:
status, context, evidence
versus assumptions, decision/scope, alternatives, consequences and revisit
triggers. Include approval evidence and recording date, and link the spec both
ways. Attribute conversation-only reports and disclose missing artifacts rather
than inventing motives or benchmarks. Skip trivial edits. Superseding decisions
link to their predecessors and mark/link old records without erasing history.

Include decision paths and rationale (or why no new record was needed) in the
final knowledge handoff. The auditor checks completeness and consistency,
escalates missing rationale only for qualifying choices, and never authors or
approves decisions from code alone. A justified no-record handoff is valid;
conflicting rationale still requires clarification. The parent performs the same
check if the auditor is absent.
This is a prompt/workflow contract, not automatic enforcement or measurement.

Mechanical edits do not require invented documentation changes or review receipts.
The documentation specialist is available without initialized project state. Todo completion and
file mutation results emit no knowledge-state reminders. The parent/catalog guidance
owns the final documentation handoff.

## Session recovery

When context compaction obscures the task, start with `session action=overview`, inspect a
relevant ID with `session action=read`, and use `session action=search` once a concrete
phrase, path, symbol, tool, or error is known. `session action=recovery` is the
compact convenience view for original/latest user instructions, file evidence,
recent errors, pending calls, and the last meaningful action. All four history actions read
through Pi's active `SessionManager`; they do not accept arbitrary session paths.
They default to the active branch, while `scope: "all"` includes abandoned branches.
See [`docs/session-recovery.md`](../context/session-recovery.md) for the full contract and
limits. `session action=name` reads or explicitly sets the current title. The
default-on `session` module owns all five actions; old `session-name` and
`session-recovery` config keys are not migrated and do not control it.

## Disabling modules

`codemode` is enabled by default: SDK QuickJS scripts are available alongside
ordinary tools. Disable the suite contribution with
`"modules": { "codemode": false }`, or use **Settings → Tools Suite → General →
Modules → codemode** in Pix Desktop. Reload extensions or restart the session
after changing module switches. Restricted child tool selections are not widened.
An existing CLI codemode definition is reused (including its own mode setting);
disabling the suite module does not disable codemode independently enabled by
the host or another extension. See [the contract](suite-codemode.md).

Disable suite modules without editing `src/index.ts` via config or environment variables. On startup, `~/.config/pi/pi-tools-suite.jsonc` is created if it is missing with a commented `disabledModules` template. Config is loaded from that file, then `$PI_CONFIG_DIR/pi-tools-suite.jsonc`, then the nearest project `.pi/pi-tools-suite.jsonc`; later layers win.

```jsonc
{
  "disabledModules": ["web-search"]
}
```

Environment overrides are applied last:

```bash
PI_TOOLS_SUITE_DISABLED_MODULES=web-search pi ...
PI_TOOLS_SUITE_DISABLED=1 pi ...   # disables all pi-tools-suite modules
```

`disabledExtensions`, `enabledModules`, `enabledExtensions`, and an `extensions` map are accepted as aliases for the same module names. Use `*` or `all` in `PI_TOOLS_SUITE_DISABLED_MODULES` to skip every registered module.

`credential-firewall` is disabled by default. Enable it explicitly with `"modules": { "credential-firewall": true }`. When enabled it replaces high-confidence secret material in the final provider payload with stable placeholders such as `<SECRET:github_token:1>`. `secretFirewall.sessionHygiene` (default `true`) applies the same redactor to tool results and completed messages before they remain in session history; `secretFirewall.notify` controls warnings. Entropy-only detection is intentionally not used yet to avoid corrupting hashes, IDs, minified assets, and other high-entropy non-secrets.

Saved prompt slash commands are stored under `promptCommands`. Use `/prompt-commands` to create, edit, rename, delete, list, show the config path, or run them from an interactive menu. After a CRUD edit the module reloads Pi resources so the slash-command list reflects the config. Each saved command sends its saved prompt as a user message.

```jsonc
{
  "promptCommands": {
    "commands": {
      "review": {
        "description": "Run a focused code review prompt",
        "prompt": "Review the current change. Focus on correctness and risks."
      }
    }
  }
}
```

Todo thinking can be enabled globally and limited by per-model Min/Max ranges. Only `{ "min": "low", "max": "medium" }` objects are supported; equal bounds force one level. Strings are ignored, not migrated. `todoThinkingOverrides` keys accept exact `provider/model` or bare-model names plus `*` and `?` wildcards. Full provider/model matches beat bare-model matches, exact matches beat wildcards, and the more specific wildcard wins. Create/update and batch mutations clamp explicit thinking, falling back to the existing task, session thinking, then Min when omitted. Supported levels inside the range are preserved. On sparse models, the ceiling takes priority: use a supported level at or below Max if possible, otherwise the model's lowest level. Model selection re-applies the active task's policy without rewriting saved plans; session baseline restoration is not clamped. Later config layers can remove an inherited entry with `null`.

```jsonc
{
  "todoThinking": true,
  "todoThinkingOverrides": {
    "zai/glm-5.3": { "min": "max", "max": "max" },
    "anthropic/claude-opus-*": { "min": "low", "max": "medium" }
  }
}
```

DCP settings are stored only under `dcp` in the user shared config file `~/.config/pi/pi-tools-suite.jsonc`. Legacy standalone `dcp.jsonc`, `$PI_CONFIG_DIR`, and project-local `.pi/pi-tools-suite.jsonc` DCP settings are intentionally ignored by the ported headless DCP module.

```jsonc
{
  "dcp": {
    "enabled": true,
    "compress": {
      "minContextPercent": "20%",
      "maxContextPercent": "55%",
      "maxContextLimit": 160000,
      "nudgeFrequency": 1,
      "iterationNudgeThreshold": 6,
      "nudgeForce": "strong",
      "protectedTools": ["compress", "write", "edit", "subagents"],
      "autoCompress": {
        "enabled": false,
        "patience": 2,
        "summarizerModel": [],
        "summarizerFallbackModels": [],
        "timeoutMs": 20000
      }
    },
    "strategies": {
      "emergencyCurrentTurnPruning": {
        "enabled": true,
        "hardContextPercent": 0.82,
        "targetContextPercent": 0.70,
        "patience": 2,
        "keepRecentToolPairs": 8,
        "minOutputTokens": 500,
        "maxSuggestions": 8,
        "protectedTools": []
      }
    },
    "modelOverrides": {
      "openai-codex/gpt-5*": {
        "compress": {
          "minContextPercent": "26%",
          "maxContextPercent": "46%"
        }
      },
      "openai-codex/gpt-5.4-mini": {
        "compress": {
          "minContextPercent": "20%",
          "maxContextPercent": "38%"
        }
      },
      "zai/*": {
        "compress": {
          "minContextPercent": "16%",
          "maxContextPercent": "30%"
        }
      },
      "antigravity/*sonnet*": {
        "compress": {
          "minContextPercent": "22%",
          "maxContextPercent": "40%"
        }
      },
      "antigravity/gemini-3.1-pro*": {
        "compress": {
          "minContextPercent": "24%",
          "maxContextPercent": "42%"
        }
      },
      "antigravity/gemini-3-flash*": {
        "compress": {
          "minContextPercent": "18%",
          "maxContextPercent": "34%"
        }
      },
      "antigravity/gemini-2.5-flash*": {
        "compress": {
          "minContextPercent": "18%",
          "maxContextPercent": "32%"
        }
      },
      "antigravity/antigravity-claude-opus-4-6-thinking": {
        "compress": {
          "minContextPercent": "26%",
          "maxContextPercent": "44%"
        }
      }
    }
  }
}
```

`minContextPercent` / `maxContextPercent` accept legacy fractions (`0.25`), percent strings (`"25%"`), or absolute token counts when Pi knows the current model context window. `minContextLimit` / `maxContextLimit` and `modelMinContextLimits` / `modelMaxContextLimits` are explicit absolute-or-percent aliases. `modelOverrides` and the `modelMin*` / `modelMax*` maps support exact model keys plus `*` / `?` wildcard patterns; matching is applied from generic to specific so exact bare-model matches override bare wildcards, and exact `provider/model` matches override provider wildcards. Array fields are union-merged, except `compress.protectedTools` and `protectedFilePatterns`: an explicit list replaces earlier/model-layer values, so an empty list unpins. If `compress.protectUserMessages` is enabled, range compression appends selected user messages verbatim instead of rejecting the range; individual message compression still skips protected raw user messages. Protected tool outputs are copied into summaries for tools protected by name or `protectedFilePatterns`; protected `subagents` result reads also try to include the saved `result.md` artifact when available.

`compress.autoCompress.enabled` is `false` by default. When explicitly enabled, its `patience` counts completed correlated main-provider opportunities, not repeated context transforms; `summarizerModel` supplies the primary summarizer list and `summarizerFallbackModels` appends explicit ordered fallbacks. Existing multi-entry `summarizerModel` configs remain supported. When both lists are empty, DCP uses the bounded extractive fallback without a model call. A configured model summarizer receives a bounded sub-deadline (75% of `timeoutMs`) so deterministic extractive fallback and durable publication retain time inside the whole operation budget. After a failed model-backed auto-compression attempt, subsequent automatic attempts in that session skip the model summarizer and use deterministic extraction. Auto commit is accepted only when the full projected replacement has positive gain and meets the current budget-recovery target.

`strategies.emergencyCurrentTurnPruning` is the default-enabled lossy safety floor for a single unfinished turn. DCP first emits emergency reminders and offers only safe old same-turn tool-result candidates. After `patience` completed ignored opportunities, at the model-independent `hardContextPercent`, or when exact auto-compression fails while input capacity is already exceeded, it replaces eligible oldest result bodies until the estimated provider context reaches `targetContextPercent` or a safe capacity margin. User messages, configured/protected data, the newest `keepRecentToolPairs`, and results without **completed** provider evidence are never selected. HTTP 2xx alone is not evidence; DCP promotes eligibility only after an unambiguously correlated successful finalized assistant response, and ambiguous retries/interleaving fail closed. If eligible recovery still cannot fit the request, DCP emits a user-visible blocked diagnostic with the capacity reason before abort/handoff. The raw session transcript is unchanged. Setting `enabled` to `false` disables same-turn candidates and lossy pruning, but keeps the non-destructive emergency reminder.

DCP durable state is journaled as append-only `dcp-journal` custom entries in
the Pi session JSONL. Resume/reload replays that journal; the current
implementation has no legacy sidecar importer or dual-write path. Protected
subagent artifacts are optional bounded recovery input: reads are async, rooted
at the session cwd, reject symlink escapes and oversized files, and never
silently truncate a required protected artifact.

Set `dcp.debug: true` to write a JSONL debug log of DCP context/prune/compress events to `~/.pi/agent/dcp-debug.jsonl` (override the path with `PI_DCP_DEBUG_LOG`, or enable without config via `PI_DCP_DEBUG=1`); off by default. The log is size-limited and rotated: once it reaches `dcp.debugLog.maxBytes` (default `5242880` = 5 MB) it is renamed to `.1`, older backups shift down (`.1`→`.2`, …) and the oldest beyond `dcp.debugLog.maxBackups` (default `3`, minimum `1`) is dropped; override either with `PI_DCP_DEBUG_MAX_BYTES` / `PI_DCP_DEBUG_MAX_BACKUPS`.

## LSP setup

The LSP module reads language-server definitions from `lsp.servers` in the shared config file:

```text
~/.config/pi/pi-tools-suite.jsonc
```

Install the language servers used by the bundled example config. The commands below are written for macOS/Linux with a POSIX shell; most npm, `dotnet`, `pip`, and `rustup` commands also work on Windows, but paths and the GDScript wrapper differ.

```bash
# TypeScript / JavaScript
npm install -g typescript typescript-language-server

# Svelte
npm install -g svelte-language-server

# Vue
npm install -g @vue/language-server

# Python
python3 -m pip install --user python-lsp-server

# Go
go install golang.org/x/tools/gopls@latest

# C / C++ (clangd)
brew install llvm
# or use your distro's clangd package: apt install clangd, dnf install clang-tools-extra, ...

# Lua
brew install lua-language-server

# Bash
npm install -g bash-language-server

# C# / Unity
dotnet tool install -g Microsoft.CodeAnalysis.LanguageServer

# GDScript / Godot
# Install Godot 4.x and make sure the `godot` command is on PATH.
# macOS Homebrew example. On other OSes, use the official Godot installer/package.
brew install --cask godot

# Ruby
brew install ruby-lsp
# or, if using RubyGems directly:
gem install ruby-lsp

# Rust
rustup component add rust-analyzer

# Markdown
npm install -g vscode-langservers-extracted
```

Extra runtime requirements:

- The GDScript wrapper also needs `nc` and `python3`; both are available by default on most macOS/Linux setups. The wrapper starts Godot headless on a free localhost port and the LSP manager kills the whole process group on shutdown/abort.
- C# expects `~/.dotnet/tools` on `PATH`, or an explicit `bin` path such as `~/.dotnet/tools/roslyn-language-server` in the config.
- Rust diagnostics require a Rust project root such as `Cargo.toml`.
- C#/Unity diagnostics require a project root such as `*.csproj`, `*.sln`, or Unity `ProjectSettings/ProjectVersion.txt`.
- Markdown link diagnostics are provided by `vscode-markdown-language-server` when validation is enabled; Mermaid fence checks are supplemented locally by pi-tools-suite, so no separate Mermaid LSP is required for the default diagnostics.

OS notes:

- macOS/Linux: the sample commands and default GDScript wrapper are intended to work as-is once the binaries are on `PATH`.
- Windows: npm, Python, .NET, Ruby, Rust, and Markdown servers can be installed natively, but adjust executable paths, for example `%USERPROFILE%\.dotnet\tools\roslyn-language-server.exe`. The bundled GDScript wrapper uses `bash`, `nc`, POSIX signals, and process groups, so use WSL/Git Bash or replace that server command with a Windows-specific wrapper.
- Package-manager commands vary by distro. Replace `brew install ...` with your OS package manager or the official installer where appropriate.

Minimal shared config shape:

```jsonc
{
  "lsp": {
    "servers": [
      {
        "id": "typescript",
        "include": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
        "rootMarkers": ["tsconfig.json", "package.json"],
        "bin": "typescript-language-server",
        "args": ["--stdio"],
        "languageIdByExtension": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact",
          ".mjs": "javascript"
        }
      }
    ]
  }
}
```

Project-local overrides can be added in `.pi/pi-tools-suite.jsonc`; pi-tools-suite asks for trust before using project-local LSP binaries.

### Popular language-server examples

Copy the entries you need into `lsp.servers` of the shared config. Values mirror the commented templates shipped in the generated config file; where they disagree, the generated file is authoritative. Both diagnostics modes are on by default: servers that support pull diagnostics (`textDocument/diagnostic`) are queried directly, and push diagnostics (`publishDiagnostics`) are awaited for every server — `pullDiagnostics: false` / `waitForPublishDiagnostics: false` disable either side explicitly. Servers start lazily: one spawns only after a mutating tool (Edit/Write/ast-grep/apply_patch) touches a file matching `include`, and diagnostics land in that tool's result.

```jsonc
{
  "lsp": {
    "servers": [
      // Svelte (verified with svelte-language-server): compiler + embedded TS/JS diagnostics
      {
        "id": "svelte",
        "include": ["**/*.svelte"],
        "exclude": ["**/node_modules/**"],
        "rootMarkers": ["svelte.config.js", "package.json"],
        "bin": "svelteserver",
        "args": ["--stdio"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 30000,
        "languageIdByExtension": { ".svelte": "svelte" }
      },
      // Vue (Volar)
      {
        "id": "vue",
        "include": ["**/*.vue"],
        "exclude": ["**/node_modules/**"],
        "rootMarkers": ["package.json"],
        "bin": "vue-language-server",
        "args": ["--stdio"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": { ".vue": "vue" }
      },
      // Python (python-lsp-server)
      {
        "id": "python",
        "include": ["**/*.py", "**/*.pyi"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/.tox/**", "**/.mypy_cache/**", "**/.ruff_cache/**"],
        "rootMarkers": ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", ".git"],
        "bin": "pylsp",
        "args": [],
        "languageIdByExtension": { ".py": "python", ".pyi": "python" }
      },
      // Go (gopls, push diagnostics)
      {
        "id": "go",
        "include": ["**/*.go"],
        "exclude": ["**/.git/**", "**/vendor/**"],
        "rootMarkers": ["go.mod", ".git"],
        "bin": "gopls",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": { ".go": "go" }
      },
      // Rust (rust-analyzer, push diagnostics)
      {
        "id": "rust",
        "include": ["**/*.rs"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/target/**"],
        "rootMarkers": ["Cargo.toml", "rust-project.json", ".git"],
        "bin": "rust-analyzer",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 20000,
        "pullDiagnostics": false,
        "waitForPublishDiagnostics": true,
        "languageIdByExtension": { ".rs": "rust" }
      },
      // C / C++ (clangd, push diagnostics)
      {
        "id": "clangd",
        "include": ["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": ["compile_commands.json", "CMakeLists.txt", "Makefile", ".clang-format", ".git"],
        "bin": "clangd",
        "args": [],
        "startupTimeoutMs": 20000,
        "diagnosticsWaitMs": 8000,
        "languageIdByExtension": {
          ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
          ".h": "c", ".hh": "cpp", ".hpp": "cpp"
        }
      },
      // C# / Unity (Roslyn)
      {
        "id": "csharp",
        "include": ["**/*.cs", "**/*.csx"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/bin/**", "**/obj/**", "**/.vs/**", "**/Library/**", "**/Temp/**", "**/Logs/**"],
        "rootMarkers": ["*.sln", "*.csproj", "global.json", "Directory.Build.props", "Directory.Packages.props", "Packages/manifest.json", "ProjectSettings/ProjectVersion.txt", ".git"],
        "bin": "~/.dotnet/tools/roslyn-language-server",
        "args": ["--stdio", "--autoLoadProjects", "--logLevel", "Error"],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 15000,
        "languageIdByExtension": { ".cs": "csharp", ".csx": "csharp" }
      },
      // Ruby
      {
        "id": "ruby",
        "include": ["**/*.rb", "**/*.rake", "**/Gemfile", "**/Rakefile", "**/*.gemspec"],
        "exclude": ["**/.git/**", "**/node_modules/**", "**/vendor/bundle/**", "**/.bundle/**", "**/tmp/**", "**/log/**"],
        "rootMarkers": ["Gemfile.lock", "*.gemspec", "Rakefile", ".ruby-version", ".git"],
        "bin": "ruby-lsp",
        "args": [],
        "startupTimeoutMs": 60000,
        "diagnosticsWaitMs": 10000,
        "languageIdByExtension": { ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby" }
      },
      // Lua (lua-language-server)
      {
        "id": "lua",
        "include": ["**/*.lua"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".luarc.json", ".git"],
        "bin": "lua-language-server",
        "args": [],
        "startupTimeoutMs": 30000,
        "diagnosticsWaitMs": 6000,
        "languageIdByExtension": { ".lua": "lua" }
      },
      // Bash
      {
        "id": "bash",
        "include": ["**/*.sh", "**/*.bash"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".git"],
        "bin": "bash-language-server",
        "args": ["start"],
        "startupTimeoutMs": 15000,
        "diagnosticsWaitMs": 5000,
        "languageIdByExtension": { ".sh": "shellscript", ".bash": "shellscript" }
      },
      // Markdown (link validation settings ship in the generated config template)
      {
        "id": "markdown",
        "include": ["**/*.md", "**/*.markdown", "**/*.mdown", "**/*.mkd", "**/*.mmd"],
        "exclude": ["**/.git/**", "**/node_modules/**"],
        "rootMarkers": [".git", "package.json", "README.md"],
        "bin": "vscode-markdown-language-server",
        "args": ["--stdio"],
        "startupTimeoutMs": 15000,
        "diagnosticsWaitMs": 5000,
        "languageIdByExtension": { ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown", ".mkd": "markdown", ".mmd": "markdown" }
      }
    ]
  }
}
```

Notes:

- Svelte resolves `svelte` and `typescript` from the workspace `node_modules`, so project-local versions win; `.svelte.js`/`.svelte.ts` runes modules are not covered because their extensions collide with the TypeScript server.
- Vue requires `@vue/language-server` v2+ (the `vue-language-server` binary) plus the workspace's `vue` package for template type-checking.
- The full commented templates (including GDScript via a headless Godot wrapper and the complete Markdown link-validation `settings`) are written to the shared config file on first run.

## Async sub-agents

### Disposable output policy

Agent scratch output (test logs, temporary reports, mockups and captures) belongs
in unique task/run directories under the current project's `.pi/artifacts/`,
never project-root `artifacts/` or release/build `.artifacts/`. Code-generated
guidance and eval defaults share `PROJECT_ARTIFACTS_DIR` in `src/artifact-paths.ts`;
do not cache an absolute workspace path. Child transcripts, parent lifecycle
state and unretired owned-launch records remain in `.pi/subagents/`; new
disposable subagent/QA evidence belongs in `.pi/artifacts/subagents/`. Preserve
already-linked evidence at its original path. Explicit release/build paths and user-requested
deliverable paths are exceptions. New prompts/profiles/examples must keep this
rule; a custom `promptOverride` replaces base guidance and must include it itself.
Disposable evidence is not universally self-cleaning: initialized-project
Desktop scratch cleanup has a 72-hour background TTL and manual Clean is immediate.
Parent-scoped child sessions are instead kept while their parent session exists,
then reclaimed after the parent is gone and the subtree is idle for 24 hours;
unretired owned-launch records remain protected, including during Manual Clean.
Export evidence that must be retained. See the Pix
[artifact storage contract](../operations/harness-artifact-storage.md).

Model selection uses the ordered candidates from each agent's Markdown file,
then applies the role's parent-provider policy and runtime capabilities.
Explicit task/CLI model overrides suppress automatic fallbacks. Setting
`ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL=1` (or
`PI_SUBAGENTS_FORCE_CURRENT_MODEL=1`) deliberately selects the parent model and
strips conflicting model arguments; this is not the economical default.

The seven built-in modes are `implement-core` (Sol for approved implementation
handoffs), `mechanical` (GLM for sufficiently large prescribed behavior-preserving
edits with deterministic checks), `research` (read-only evidence, focused review,
and readiness evidence), `verify` (run checks and diagnose logs without fixing
files), `ui-qa` (real browser, terminal/TUI, and desktop-GUI verification),
`knowledge-auditor` (final affected-documentation maintenance without search setup or
knowledge-state receipts), and `oracle` (bounded second opinion and complex
architectural review). The parent owns readiness decisions. Bundled `implement`
and `delivery-review` are removed without aliases; project-local profiles under
those names remain valid. Task-specific discipline belongs in the brief.

Broad migrations and semantic regression changes never belong to `mechanical`.
Use coherent slices, an early affected typecheck and focused regression; do not
weaken assertions to make a migration pass. Oracle uses the cross-vendor frontier
pool. Compare expected net savings including failures, review, rework, duplicate
context, briefing and integration, not token price alone. No savings benchmark
is claimed; prompt policy does not enforce runtime cost/capability measurement.
See [coding acceptance guidance](agents/subagent-model-pools.md#coding-quality-and-acceptance).

For non-UI work, start with the shortest parent pass that resolves user intent,
semantics, and the main causal path. If a few targeted repository searches or
reads are enough to establish the diagnosis and desired behavior, continue in
the parent instead of spawning research that repeats the same investigation.
Write code in the parent by default. Delegate implementation only on explicit
user request, a concrete capability gap in the implementation itself, or sufficiently
large prescribed mechanical work with deterministic checks and expected net savings.
Size, parallelism, isolation, token price, or worker availability alone are not sufficient.
Research may address a named uncertainty or independent evidence track.
Mandatory UI QA, architectural review and final documentation maintenance remain exceptions.

Keep product/UX decisions and integration in the parent. Do not delegate
implementation before the cause, desired behavior, and acceptance criteria are
settled; prefer the smallest coherent slice over broad speculative cross-layer
edits. After spawning, continue independent parent work and do not poll or wait
merely for progress. Wait only when the child result blocks the next decision and
no independent parent work remains. If requirements change, stop or rescope the
affected worker before it continues editing. Read compact results and verify
selectively rather than repeating the worker's investigation. Do trivial
reads/edits directly. Redirect a noisy command to a log without an extra LLM when
no interpretation is needed. `verify`'s no-edit instruction is a behavioral
contract, not a read-only filesystem sandbox for its shell.

Run `/ultrawork` or `/ulw` for orchestration, `/hyperplan` to pressure-test a
plan, or set `ULTRAWORK=1` to apply the orchestration prompt to normal inputs.
`ULTRAWORK_AUTO=1` classifies only the first normal input on non-GPT parents;
GPT-like parents skip that automatic transform, not ordinary delegation.

See [Model candidates and provider policy](agents/subagent-model-pools.md) for the
selection contract, configuration examples, override rules and compatibility.

### Parent-first role selection

The parent normally selects an explicit `subagentType` from the effective
system-prompt catalog, preferring a matching project-local specialist. Valid
explicit types bypass the LLM router entirely; model selection, tools, and role
instructions are still applied by the normal config resolver.
Model/thinking overrides are not substitutes for selecting a role.

The router remains enabled as a fallback for omitted types: use it when the role
is unclear or the user explicitly requests automatic routing. Only omitted
tasks are classified, in one batch; the parent's explicit choices are preserved.
Real UI QA requires explicit `subagentType: "ui-qa"`. There is no
`browser-qa` role alias; that name is valid only when a project explicitly
defines its own independent `.pi/agents/browser-qa.md` role.

Unknown explicit types and failed/incomplete automatic routing reject the
**entire spawn batch before run state or child processes are created**. The tool
returns an error with affected task IDs and available types; the parent should
correct the roles and resubmit the whole batch. Provider error responses are
failures too, not successful routes. Configured fallback router models may be
tried, but missing routes are never silently replaced with `quick`/`defaultType`.

With `routing.enabled: false`, every spawn task must supply a valid explicit
type. `defaultType` remains a preference for genuinely ambiguous LLM choices
and a legacy config-resolver default, not a spawn error fallback. Existing
callers relying on an implicit default must now choose a type explicitly.

### Project-local agents (`.pi/agents/*.md`)

Bundled roles can be selectively hidden without disabling the whole
`async-subagents` module. Use the top-level suite config key
`disabledBuiltinAgents`; a later config layer can undo an inherited disable with
`enabledBuiltinAgents`:

```jsonc
{
  "disabledBuiltinAgents": ["oracle", "ui-qa"],
  // "enabledBuiltinAgents": ["ui-qa"]
}
```

This filter applies only to bundled definitions. A project-local
`.pi/agents/<name>.md` file with the same name is still loaded and becomes the
effective role, so disabling a bundled role does not reserve or blacklist that
name. Disabled bundled roles disappear from the parent catalog, explicit spawn
validation, and automatic routing.

`builtinAgentModels` selects the primary model for bundled roles whose Markdown
profile declares an explicit model. Values are `provider/model` refs, optionally
with a `:thinking` suffix. User and project suite-config layers merge entries
by role; `null` clears an inherited choice and restores the current bundled
default. Shipped suite defaults may provide model ids for built-in roles; the
interactive `pix install --models` wizard can populate or replace role choices
from the locally available model catalog. Fallback order and model-selection policies
remain in force. Unknown,
disabled, and automatic/frontier roles are ignored; configure frontier roles
through `frontierModels`. Project-local full replacements are unaffected and
continue to use the project Registry override file. Explicit task/CLI/forced,
global, and per-role environment priorities remain authoritative, as do economy
and vendor policies. Fresh launches load changed settings; running children
are unchanged. Desktop's searchable Sub-agents pickers derive eligible roles
from bundled profiles, retain unknown stored model refs, and Reset removes the
current layer's choice so inherited user settings or the suite default applies.

A project can ship sub-agent roles as individual Markdown files in
`<project>/.pi/agents/`. The first such directory found walking up from the
session cwd is used; each top-level `*.md` file becomes a `subagentType` named
after the file. Parent and router see the short `description`; only the child
receives the Markdown body. A project's ordered `models` are the role's complete
candidate chain and are filtered only by provider policy and runtime availability.

```markdown
---
description: Use for reviewing this repo's diff — knows the house rules.
icon: eye
models:
  - zai/glm-5.3-flash
  - openai-codex/gpt-6-luna
thinking: low
tools: read, grep
retry:
  maxRetries: 1
  backoffMs: 2000
---

You are this project's staff reviewer. Apply the repo rules from
AGENTS.md before approving anything; cite file paths first.
```

- Frontmatter keys: `name` (must match the filename), `description`, `icon`, `models`, `thinking`, `tools`, `extraArgs`, `promptAppend`, `promptOverride`, `retry`, `maxResultBytes`, `timeoutMs`, and parent-model gates. Legacy `model`, `fallbackModels`, and `modelByParent` still load. Unknown keys are rejected with an error naming the file.
- Array fields accept block lists (`- item`), inline arrays (`[a, b]`), or comma-separated strings (`tools: read, grep, bash`). The frontmatter YAML subset is intentionally small: scalars, quoted strings, numbers, comments, lists, and nested maps for `modelByParent`/`retry`. Tabs, block scalars (`|`/`>`), anchors/aliases, and flow maps are hard errors naming file and line.
- The markdown body becomes `promptAppend`: it is appended after the standard generated prompt (parent objective + task + output format), so the agent still receives its task in the usual structure. Use frontmatter `promptOverride` for full prompt replacement.
- Precedence: bundled Markdown defines the built-ins, then the nearest project
  `.pi/agents/*.md` definition replaces a same-named built-in profile
  completely. Omitted fields do not inherit from the built-in. There are no
  role-name aliases or partial-merge exceptions. Markdown is the only source of
  agent role/profile definitions. The removed `asyncSubagents` section and old
  standalone config-path variables are not read.
- Files without frontmatter are skipped (a `README.md` there is fine). Definition loading is uncached: edits apply on the next config read/spawn without a restart, and the effective system-prompt catalog is rebuilt at parent-agent start.
- Bundled roles use the same format internally under `src/async-subagents/agents/*.md`; built-in and project-local profiles therefore share one parser and normalization path instead of maintaining a second role-description schema in TypeScript.
- The parent catalog explicitly prints the active bundled-role names replaced by
  project-local definitions, so chat context reflects that the local role owns
  the complete effective contract.
  The gate applies consistently to the parent catalog, auto-router, and explicit
  role validation. The built-in `knowledge-auditor` uses this flag.
- `icon` names an agent glyph for UIs that render sub-agent widgets (pix TUI panel, Pix Desktop subagents panel): `agent` (neutral default), `search`, `code`, `flask`, `globe`, `sparkles`, `brain`, `wrench`, `terminal`, `bug`, `book`, `eye`, `zap`, `rocket`. The value is passed through opaquely; unknown names render as the neutral agent icon, and status stays color-coded next to it.

### Real UI QA (browser, TUI, and desktop GUI)

The built-in `ui-qa` role runs on `zai/glm-5.3-flash`, with
`openai-codex/gpt-6-luna` as its fallback. Its Markdown body
(`src/async-subagents/agents/ui-qa.md`) is a deliberately thin common contract:
test the real user-facing target, classify only the top-level backend, route
through on-demand guides, run through the unified runner, and keep deterministic
assertions as the oracle with bounded execution, owned cleanup, and private
evidence. Provider/presentation/platform details are intentionally absent from
the initial role body. The normal profile loader appends that body to the QA
child's task prompt; the parent and LLM router receive only the short
`description`. There is no additional QA skill to discover or read.

Backend specifics use progressive disclosure through bundled guides under
`src/async-subagents/agents/ui-qa/guides/`. `browser.md`, `tui.md`,
`desktop.md`, and `android.md` are compact routers; backend-scoped detail topics cover the actual
browser provider, TUI presentation, desktop platform driver, Android ADB/UI Automator, and explicit
browser-auth workflow. The child loads the matching base guide, then only the
routed detail topic read-only via the runner:

```sh
node "$PI_UI_QA_RUNNER" guide --backend browser   # or: tui | desktop | android
node "$PI_UI_QA_RUNNER" guide --backend browser --topic playwright
# other examples: chrome-devtools, tui/native-terminal, desktop/windows-uia, android/adb
```

The command resolves the guide from a backend-scoped fixed allowlist bundled
with the suite (never a model-composed path), rejects unknown/cross-backend
topics/options and extra arguments, bounds guide size, and prints only the
requested document. `probe` returns authoritative
`selection.guide = {backend, topic}`; the child reconciles that route before
`run`.

`ui-qa` authors one private declarative flow and invokes the capability-first
runner supplied in `PI_UI_QA_RUNNER`. The runner selects exactly one backend
from the target descriptor and reports candidate capabilities plus its selection
rationale. Browser routing selects the trusted Playwright backend or the
capability-probed Chrome DevTools provider. TUI routing selects PTY semantics or
the native-terminal mirror. Desktop routing selects the capability-probed macOS
Accessibility, Windows UI Automation, or Linux AT-SPI implementation. Android is a
separate backend, used only for an explicitly selected Android target, via ADB/UI
Automator (`adb` detail topic, alias `adb-uiautomator`). This does not expand Pix
Desktop's macOS-only product support. Evidence
capabilities remain platform-specific and never replace deterministic
assertions. Unsupported platforms or missing required control permissions
return `BLOCKED`. QA does not
install GUI automation dependencies, change OS privacy/accessibility settings,
disable sandboxing, or operate unrelated user windows. Static or mock checks do
not substitute for the requested UI.

Unified flows and evidence—including automatic recordings—stay in the owning
agent's private workspace under `.pi/artifacts/subagents/`. Already-linked evidence
at older paths is preserved, not moved. Protected child transcripts, parent state
and owned-launch records remain under `.pi/subagents/`; see the
[artifact contract](../operations/harness-artifact-storage.md). Pass/fail requires a
product-visible deterministic oracle such as terminal content/state,
accessibility/app-driver state, window/dialog state, or visible control values;
screenshots are supporting evidence, not the sole oracle. Cleanup is scoped to
the PTY/session/app process created by the QA run.

#### Browser backend and project auth

The capability-first runner and all backend resources live under
`src/async-subagents/agents/ui-qa/`; the trusted browser runner, vendor code,
license, and examples are grouped under its `browser/` directory. The launcher
supplies absolute paths in `PI_UI_QA_RUNNER` and `PI_BROWSER_QA_RUNNER`. Normal
probe/run uses the former;
the latter is invoked directly only for browser auth profile discovery and
form-auth scaffolding. These non-secret paths are set only for QA children.
Every async sub-agent launches with `--no-skills`, and skill flags in
`extraArgs` are stripped rather than forwarded. Agent roles are self-contained;
there is no profile field for injecting skills and no built-in QA `--skill`.

A project `ui-qa.md` completely replaces the bundled UI-QA profile, like every
other same-named project role. It does not inherit bundled models, tools,
thinking, visibility fields, or Markdown instructions. Projects that replace
`ui-qa` must explicitly carry forward every bundled field/instruction they
still require. Runtime runner/workspace isolation and credential handling remain
enforced in code.

Public browser QA does not require an auth profile or `.pi/qa_auth.jsonc`: run it
with an explicit base URL, whose exact origin becomes the fail-closed allowlist.
The runner neither creates nor requests a credential file for that path.

For targets that actually require login, keep named dev/staging auth profiles in
project `.pi/qa_auth.jsonc` (there is no `/qa-auth` command). The private runner
supports `form`, `cookie`, `localStorage`,
`sessionStorage`, `bearer`, and existing Playwright `storageState` auth. Every
profile must declare exact `allowedOrigins`; select the profile id explicitly only
for authenticated QA. On POSIX, keep the config at mode `0600`. During a run
those origins also form the fail-closed HTTP(S)/WebSocket allowlist and service
workers are blocked. Example:

```jsonc
{
  "profiles": {
    "staging-admin": {
      "description": "Staging administrator",
      "traits": ["role:admin", "plan:enterprise"],
      "baseUrl": "https://staging.example.test",
      "allowedOrigins": ["https://staging.example.test"],
      "auth": {
        "type": "form",
        "loginUrl": "https://staging.example.test/login",
        "fields": [
          { "selector": "input[name=email]", "value": "admin@example.test" },
          { "selector": "input[name=password]", "value": "replace-me" }
        ],
        "submitSelector": "button[type=submit]",
        "success": { "selector": "[data-testid=user-menu]" }
      }
    }
  }
}
```

Do not place credential values in prompts, QA flows, shell arguments, or reports.
The helper reads JSONC internally and emits only redacted statuses. For form auth,
video recording begins on the login page and captures the field-filling and submit
sequence; password inputs remain browser-masked, but the private video may show
other visible login identifiers and must be treated as sensitive evidence. Tracing
starts only after login succeeds and is sanitized before retention. The launcher
provides each UI QA process with its general `ui-qa/` workspace plus the browser
backend's `.pi/subagents/<run>/<agent-id>/browser-qa/` workspace. Unified flows
stay under `ui-qa/flows/`; browser adapter flows, screenshots, video, sanitized
traces, and result manifests stay under the backend workspace. Normal session
shutdown preserves them; explicit `subagents cleanup` removes them with the run
directory when lifecycle ownership has safely retired. Desktop's separate
background TTL/manual Clean policy also applies; export durable evidence.
The runner validates the owning agent metadata and refuses flows outside that
workspace; reusing an agent id clears stale browser QA files first. Trace archives
have network records and non-image resources removed, then known
configured/runtime credential values are redacted and verified before retention.
Listing profiles when the auth file is absent returns an empty list without
creating a template. Only an explicit authenticated request may create the
private template. Missing, rejected, or expired selected auth returns
`QA_AUTH_UPDATE_REQUIRED`, naming only the profile/file/reason needed for the
parent to ask the user for an update and rerun. See
`src/async-subagents/agents/ui-qa/browser/examples/qa-auth.example.jsonc`
for complete profile shapes and `examples/qa-flow.example.jsonc` beside it for
the declarative, non-executable QA action/assertion format.

Browser QA videos automatically visualize pointer interactions. Clicks and
double-clicks show a transient cursor and pulse. Native drag/drop is replayed
for 450 ms with a large orange cursor, progressively drawn high-contrast path,
and green drop marker. The isolated, pointer-transparent layer is installed for
the whole browser context, including same-origin frames, declared popups, and
form-auth submission, and clears during the normal post-action stable interval
so screenshots and assertions remain state-focused.

Async-subagents also injects a lightweight oh-my-openagent-style system-prompt strategy by model: non-GPT parents get `parallel-first`, an orchestration-first hint that favors ultrawork/subagents for broad work, while GPT-like parents get `deep-work`, a direct deep-worker hint that uses subagents only when clearly useful. Explicit custom system prompts (`--system-prompt`, `SYSTEM.md`, custom templates) are respected and skip this injection by default. Disable it with `PI_AGENT_STRATEGY=off`; force a strategy with `PI_AGENT_STRATEGY=parallel-first` or `PI_AGENT_STRATEGY=deep-work`; set `PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT=1` to append it even when a custom prompt is present.

For blind-model screenshot/image inspection, use the main-session `coding-discipline` lookup tool; the bundled default uses vision-capable `zai/glm-5.3-flash`. `lookupFallbackModels` is the ordered fallback array for `lookupModel` and defaults to `[]`; lookup tries the configured chain in order. Async-subagents still supports `imagePaths` on tasks when a broader delegated track genuinely needs images, but it no longer ships a dedicated `vision` role. Provider image metadata is supplemented by an internal compatibility list for known blind models so the parent does not falsely claim visual access; this is runtime capability policy, not agent configuration.

When `subagentType` is omitted, the lightweight role router classifies the task
using the descriptions. Explicit types bypass it. Unknown types or failed
routing reject the batch, never substitute `defaultType`. Choosing a worker
model from its candidate list does not involve an LLM call.

### Role-owned candidates and parent-provider policy

Each agent declares an ordered `models` list in Markdown, or `modelSelection:
frontier` to take its candidates from the suite-level frontier list (see
[Frontier models and economy mode](#frontier-models-and-economy-mode)). There is
no other global sub-agent preset or model-pool layer. Selection preserves role order, applies
`parentProviderPolicy`, checks runtime registration/auth/capability availability,
and takes the first usable candidate. Remaining usable candidates form the quota
fallback chain. No usable model, or an explicitly empty list, rejects the whole
batch before child processes are created. A custom agent must declare candidates
instead of silently inheriting the parent model.

`parentProviderPolicy` supports `any` (default), `prefer-other`,
`require-other`, and `require-other-if-frontier`. Despite the historical name,
the policy compares model *vendors* (family owners inferred from the model id:
`gpt-*` → openai, `glm-*` → zai, `claude-*`/`opus`/`sonnet`/`haiku` → anthropic, `gemini-*` → google,
...; the provider id is the fallback), so `openai/gpt-6-astra`,
`openai-codex/gpt-6-astra`, `github-copilot/gpt-6-astra` and OpenRouter refs are
one vendor, and the parent's own model is never an "other" candidate.
`require-other` needs a known parent, removes every same-vendor candidate from the
initial and fallback chain, and rejects same-vendor explicit overrides and
`--provider` extra args. `require-other-if-frontier` applies `require-other` for
a frontier parent and `prefer-other` otherwise.

### Frontier models and economy mode

Frontier models are named once in `pi-tools-suite.jsonc`; shipped suite defaults
include frontier model ids, and `pix install --models` can replace picks using
the locally available model catalog. Roles with
`modelSelection: frontier` (bundled `oracle`) take candidates from this ordered list, so a new frontier
release can be added as a config edit:

```jsonc
{
  "frontierModels": [
    { "model": "openai-codex/gpt-6-astra", "expensive": true, "aliases": ["*gpt*astra*"], "roles": ["oracle"] },
    { "model": "zai/glm-5.3" },
    { "model": "anthropic/claude-opus-5-5", "expensive": true, "aliases": ["*opus*"] }
  ],
  "economy": false
}
```

- `oracle` (`modelSelection: frontier`, `vendorsByParentVendor`,
  `require-other`) pairs OpenAI parents with Anthropic candidates, Anthropic
  parents with OpenAI candidates, and other parents with OpenAI then Anthropic.
  GLM is never an oracle candidate. Vendor-list order comes first, followed by
  `frontierModels` order within each vendor; missing parent identity or no
  eligible paired candidate fails closed. The default economy list hides the
  oracle for OpenAI, Anthropic, and Z.ai parents because their paired candidates
  are expensive. It provides
  a deliberate second opinion and required post-implementation review only for
  complex architectural tasks, not routine features, local bug fixes, mechanical
  edits, or large diffs alone. There is no parent-tier gate. The separate bundled
  `frontier-review` role was merged into oracle and removed. Task complexity is
  classified by the parent, not by runtime. Bundled `implement` and
  `delivery-review` are retired without aliases; project-local profiles using
  those names remain valid.
- Entry fields: `vendor` (override inference), `expensive`, `enabled: false`
  (still recognized as frontier, never selected), `aliases` (globs recognizing
  the same model under other refs, e.g. OpenRouter), `roles` (limit an entry to
  listed roles). A later config layer's list replaces the inherited one; `null`
  restores the built-in list.
- `economy: true` (or `PI_TOOLS_SUITE_ECONOMY=1`) excludes `expensive` frontier
  models from every role's automatic selection and rejects explicit overrides to
  them; only the forced current parent model is exempt. Config is re-read on each
  spawn, so toggling needs no restart. When nothing qualifies, spawn fails with
  the excluded models named, and a cross-vendor role is hidden from the catalog.

Image-bearing tasks and `ui-qa` require confirmed image support; configured
blind-model masks override runtime image metadata. Session quota state removes
exhausted models/providers from the already-resolved chain. The fallback layer
itself does not impose provider diversity; that constraint belongs to the role.
Explicit task/CLI model overrides and `FORCE_CURRENT_MODEL` suppress automatic
fallback candidates, but do not bypass image checks, economy mode, or `require-other`.

Projects customize model economics by replacing the relevant
`.pi/agents/<role>.md` candidate list. There is no `.pi/agents/presets.jsonc`,
saved sub-agent preset selection, `AGENTS_PRESET`, or `/subagent-preset` command.

### Legacy configuration compatibility

Old built-in role names are no longer implicit aliases. `quick`, `scan`,
`review`, `deep`, `docs`, `frontend`, and `tests` are valid only when explicitly
defined as ordinary project `.pi/agents/<name>.md` files.

Within an agent Markdown file, legacy `model` plus `fallbackModels` and
`modelByParent` remain readable. `models` is a complete replacement list: it
clears inherited legacy model/fallback/parent routing. New built-ins use ordered
`models` lists and contain no parent-tier escalation maps.

The removed `asyncSubagents` section is not part of the public schema or generated
user config and is no longer read at runtime. Existing files can remain on disk
without being rewritten, but they have no effect: migrate role definitions and
model candidate ordering to `.pi/agents/*.md`, and bundled role visibility to
the top-level `disabledBuiltinAgents` / `enabledBuiltinAgents` lists. Runtime
retry structures and the separate role router continue to use the term
`fallbackModels` for actual fallback-only lists, not agent candidates.

Every sub-agent is a full persisted Pi session stored at `<cwd>/.pi/subagents/<parentSessionId>/<childSessionId>.jsonl` (see [async-subagents](agents/async-subagents.md)); there is no opt-out. The session backs `subagents action=send` cold resume of finished agents, Desktop read-only sub-agent viewer tabs and the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`).

The module summary's `<scope>` means this parent scope, not a run/batch directory:
for a normal persisted parent it is `<parentSessionId>`. A keyed headless host
uses a deterministic UUID derived from project root and host session key, with
`headless-parent.jsonl` beside its child JSONLs. See the
[headless journal contract](headless-tool-api.md). The run key
`.pi/subagents/<scope>/<batch>` is a compatibility identity, not a new directory.

Every sub-agent role (including project-local and future roles) gets a private `todo` tool for non-trivial multi-step work. Each child attempt owns its list; it cannot read or overwrite the parent's project plan. `todo` remains available even with restricted or empty work-tool selections. Child todos do not enable persistence commands, thinking overrides or automatic follow-up turns; unfinished work and blockers belong in the report to the parent.

Optional work tools follow the final tool selection: bundled `research`,
`implement-core`, `mechanical` and `oracle` request read-only
`ast_grep`; only bundled `research` adds `web_search`/`web_fetch`. The tools-only
loader preserves these extension names without loading `ast_apply`, LSP or
credential/setup commands. Unlike universal todo/repo, optional tools can be
removed by CLI lists/exclusions or project-local full replacements. Read-only
research keeps canonical read/grep, never Codex's shell alias. Web uses existing
credentials/fallback and is for public evidence only, never secrets/private repo
data; missing prerequisites are reported to the parent. Council shares web
registration but retains its stricter guard and does not gain AST.

Every role also gets the full `project_search` tool without external search setup.
Common spawn loads only the tools-only entrypoint, never setup/update commands
or the full suite. Restricted/empty tool lists and exclusions retain private
todo and `project_search`, not other work tools. All five sources and `patch:`
are available, with the same consent, provider and cancellation safeguards as
ordinary Pi. No implicit external-backend setup is attempted.

Sub-agent child sessions are stored in the current project's `.pi/subagents/<scope>/` and survive main-session shutdown; the `runDir` compatibility key identifies a batch but is not a run directory. Run and agent records are kept session-natively as lifecycle entries in the parent session; there is no `registry.json`, and legacy run directories are ignored. `subagents({ action: "status" })`, `wait`, and `stop` can omit `runDir` to target the latest batch of the current parent scope, and `subagents({ action: "result", agentId: "..." })` resolves the latest-launched record for that `agentId` even if the exact `runDir` was lost during compaction or the session closed. Result reads always return a summary-first response with artifact paths; raw transcripts and full diagnostic logs are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs. On normal main-session shutdown, Pi stops that session's sub-agents but preserves run files, reports, attachments and session records; reload and fork shutdowns also skip stopping. Desktop scratch evidence keeps its 72-hour background TTL and immediate manual Clean. Parent-scoped sessions instead follow parent existence plus 24 hours of subtree inactivity after the parent is gone; Manual Clean preserves unretired owned-launch records (see the [artifact contract](../operations/harness-artifact-storage.md)). The draft macOS owned launcher prevents explicit cleanup while containment or either UUID launchd service's retirement is uncertain; stopping the bridge alone never authorizes deletion. This candidate remains gated on G1/T3 acceptance (see `wiki/tools/agents/async-subagents.md` in the Pix repository).

New launches do not write per-agent `launch.json`, `result.json`,
`retry_count`, `started_at`, `finished_at`, `exit_code` or queued prompt
sidecars. Parent `pi-tools-suite:subagent` entries carry launch, retry,
completion, result and progress state; child JSONLs live directly under the
scope with `subagent_meta`. The compatibility `runDir` key is an identity,
not a directory. Existing legacy transcripts remain inspectable through ACP's
read-only resolver, not a lifecycle-state importer.

Diagnostics and disposable evidence are distinct from the durable session
records. See the [session-native lifecycle contract](agents/async-subagents.md)
and [artifact policy](../operations/harness-artifact-storage.md) for current
ownership, recovery, retention, output bounds and debug logging. Old sidecar
paths are not instructions for new writers.

Runtime concurrency defaults to 5 agents per project and the global result summary bound defaults to 100000 bytes. These are internal engine defaults rather than normal user configuration. The fallback watchdog is 3 hours (10,800 seconds) if no timeout is specified. Per-agent `retry`, `maxResultBytes`, and `timeoutMs` belong in agent Markdown; spawn calls and individual task objects can pass `timeoutSeconds` to override the watchdog with a shorter or longer timeout. Explicit timeouts are not capped at 3 hours; the macOS owned-launch supervisor uses the same resolved timeout. Stop requests mark running, queued planned, and retry-pending agents as `stopped` so queued work is not launched later. Completed agents persist structured result metadata in parent session entries for parent-agent chaining, not a `result.json` sidecar.

## OpenCode credential import

`/opencode-import` migrates only credential formats with an explicit Pi mapping: OpenAI OAuth to `openai-codex`, OpenAI API keys to `openai`, GitHub Copilot OAuth, Z.ai aliases, and one matching OpenCode Antigravity account. It does not migrate OpenCode model definitions, defaults, MCP servers, plugins, instructions, or tool settings.

The default source is `OPENCODE_AUTH_CONTENT`, `OPENCODE_DATA_DIR/auth.json`, or the XDG/default OpenCode data directory. The destination is the active Pi agent directory, including `PI_CODING_AGENT_DIR`. Existing Pi credentials are preserved; pass `--force` only to replace supported entries intentionally. Successful writes are atomic, use restrictive file permissions, and trigger a runtime reload. The command also accepts `--path`, `--auth-path`, `--antigravity-path`, `--skip-auth-json`, and `--skip-antigravity` for controlled migrations.

## Web search

`src/web-search` registers two Ollama-first tools and the `/web-credentials` setup command:

- `web_search` posts `{ query, max_results }` and returns formatted title/URL/snippet results plus structured `details.results`.
- `web_fetch` posts `{ url }` and returns extracted page text plus title/link metadata.
- `/web-credentials` can set, inspect, or clear stored Ollama and Tavily API keys. Notifications and status output never display key values.

Without an Ollama API key, both tools default to `http://localhost:11434/api/experimental/...`; set `OLLAMA_HOST` to point at another Ollama instance. With an Ollama API key and no explicit `OLLAMA_HOST`, they use the official `https://ollama.com/api/web_search` and `/api/web_fetch` endpoints with bearer authentication. Requests time out after 30 seconds by default. Override globally with `PI_WEB_SEARCH_TIMEOUT_MS` or per call with `timeout_ms` (maximum 120000 ms). Tool results include `host`, `timeoutMs`, and truncation metadata in `details`.

Configure a Tavily key to enable automatic fallback for both tools. Ollama remains the primary provider; if any Ollama request or response fails, `web_search` retries through `https://api.tavily.com/search` and `web_fetch` retries through `https://api.tavily.com/extract`. The Tavily key is sent only in Tavily's bearer authorization header and is never accepted as a tool parameter or included in result details. Fallback results set `details.provider` to `tavily` and include the primary Ollama error under `details.fallbackFrom`; ordinary results set `details.provider` to `ollama`.

The recommended interactive setup is:

```text
/web-credentials
```

Choose Ollama or Tavily, paste the key, and it becomes active for later calls without a reload. Keys are stored in `~/.config/pi/pi-tools-suite-credentials.json` with mode `0600`. The same command can show configuration sources or clear stored keys without displaying them.

The command displays the official key pages before opening its menu:

- Ollama: <https://ollama.com/settings/keys>
- Tavily: <https://app.tavily.com/home>

Environment variables remain supported and take precedence over stored keys:

```bash
export OLLAMA_API_KEY="..."
export TAVILY_API_KEY="tvly-..."
```

The timeout applies independently to each provider attempt, so a failed Ollama request followed by Tavily can take up to roughly twice the configured timeout. Tavily Search fallback uses basic search and clamps `max_results` to Tavily's documented maximum of 20. Tavily Extract does not return page title/link metadata, so fallback uses the requested URL as the title and reports no links.

Troubleshooting:

| Symptom | Fix |
| --- | --- |
| `Could not connect to Ollama` | Start Ollama and check `OLLAMA_HOST`. |
| `Unauthorized by Ollama` | Run `ollama signin` for local Ollama, or update the Ollama key through `/web-credentials` / `OLLAMA_API_KEY`. |
| `endpoint is not available` | Update Ollama and make sure the experimental web search/fetch feature is enabled for that install. |
| `timed out after ...` | Increase per-call `timeout_ms` or `PI_WEB_SEARCH_TIMEOUT_MS` if the local web endpoint is slow. |
| `invalid JSON` / `unexpected response` | Check the Ollama version and the raw endpoint behavior; the tool reports the bad response shape instead of failing with a generic parser error. |
| `Tavily ... rejected TAVILY_API_KEY` | Update the Tavily key through `/web-credentials` or `TAVILY_API_KEY`. |
| `Tavily ... limit was exceeded` | Check Tavily usage/plan limits in the Tavily dashboard. |

Do not send secrets, tokens, private repository text, or credential-bearing URLs through these tools; Ollama may query external web services to satisfy the request.

## Layout

```text
pi-tools-suite/
  index.ts
  package.json
  src/
    index.ts
    coding-discipline/
    ast-grep/
    async-subagents/
    lsp/
    comment-checker/
    session-name/
    session-recovery/
    session/
    repo-discovery/
    antigravity-auth/
    opencode-import/
    question/
    todo/
    model-tools/
    background-shell/
    usage/
    web-search/
    truncation-metadata-normalizer/
    dcp/
    prompt-commands/
    resource-registry/
    credential-firewall/
    codex-reasoning-fix/
  docs/
  licenses/
  scripts/
  test/
```

## Checks

```bash
npm run smoke
npm test
npm run typecheck:async-subagents

# Optional longer/e2e checks
npm run test:async-subagents-e2e
npm run test:async-subagents-selection-e2e
npm run test:e2e
```

### Prompt evaluations

Prompt evaluations are opt-in because they call a real model. They cover model-facing behavior that deterministic tests cannot prove: tool selection for `todo` and `compress`, async-subagent delegation/lifecycle boundaries, default internal role routing, ultrawork classification, and DCP summary retention. They are intentionally excluded from `npm test`.

```bash
# Full prompt-eval suite
npm run test:prompt-evals

# Focused suites
npm run test:prompt-evals:tool-selection
npm run test:prompt-evals:async
npm run test:prompt-evals:dcp
```

The default live model is `zai/glm-5-turbo`. Override it for the whole suite with `PI_TOOLS_SUITE_E2E_MODEL=provider/model`, or use the existing component variables such as `TOOL_SELECTION_E2E_MODEL`, `ASYNC_SUBAGENTS_MODEL`, `ASYNC_SUBAGENTS_ROUTING_E2E_MODEL`, and `DCP_SUMMARY_E2E_MODEL`. The normal deterministic coverage remains `npm test`; run prompt evals after changing tool descriptions, routing/classifier prompts, DCP summary prompts, or the default evaluation model.

### Unified eval harness

`test/evals/` adds a shared deterministic + live-model eval layer. The coverage
gate requires every registered extension and model-facing tool to have a
deterministic contract. The initial live corpus contains 19 cases across tool
selection, coding quality, orchestration/escalation, and negative overuse
controls. Coding-quality fixtures use executable behavioral checks rather than
an LLM judge, while reports compare parent/worker tokens, provider-reported cost,
tool calls, changed files, and elapsed time.

```bash
# Deterministic coverage/contract gate only
npm run test:evals:contracts

# Live matrix as Bun tests. Models are comma/semicolon separated.
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3,openai-codex/gpt-6-luna,openai-codex/gpt-6.1-sol' \
  npm run test:evals:live

# Produce JSON + Markdown comparison artifacts.
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3,openai-codex/gpt-6-luna,openai-codex/gpt-6.1-sol' \
  npm run evals:report

# Focus the report runner when iterating
PI_TOOLS_SUITE_EVAL_MODELS='zai/glm-5.3' \
PI_TOOLS_SUITE_EVAL_CATEGORIES='coding-quality,negative' \
  npm run evals:report
```

Live evals are opt-in. The deterministic coverage registry is part of normal
tests, so adding an extension or tool without eval coverage fails the gate. See
[`docs/evals.md`](../development/testing/evals.md) for the architecture, complete 19-case catalog,
fixtures, assertions, metrics, model matrix, report format, environment
variables, CI recommendations, and the procedure for adding new evals.

Supporting docs and historical standalone README content are kept in `docs/`; third-party license texts are kept in `licenses/`.

## SDK pin

This suite runs inside the Pi host process, so its `@earendil-works/*`
peerDependencies (`pi-ai`, `pi-coding-agent`, `pi-tui`) must match the host Pi
SDK version exactly. Otherwise npm can resolve a stale copy in this package's
own `node_modules` and cause a double-load (e.g. `0.75.4` here vs `0.79.4` in
the host).

The host repo keeps these aligned: `npm run sync:sdk-pin` rewrites these
peerDeps to the host version, and `npm run sync:sdk-pin:check` reports drift
(non-zero exit). When you bump the Pi SDK in the host `package.json`, the host
runs `sync:sdk-pin` and then you reinstall here:

```bash
npm install --ignore-scripts
```

The suite deliberately does not bump its own `version` field for SDK changes;
its peerDeps carry the version.

## Third-party notices

Parts of this extension suite are based on or adapted from code by other vendors and projects. The corresponding license texts and notices are included in `licenses/`.
