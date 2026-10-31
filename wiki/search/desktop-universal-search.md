---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T01:53:41.417Z","result":{"path":"wiki/search/desktop-universal-search.md","documentHash":"d9e2fc0a7d31755bc20273478cb29531d851807d15714c0be7aabe84fa1f3812","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":20,"chunkCoverage":{"totalChunks":2,"checkedChunks":2,"totalComparisons":3,"checkedComparisons":3},"status":"conflicts","conflicts":[{"draft":{"path":"wiki/search/desktop-universal-search.md","quote":"Hybrid commits use the global `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` provider,\n  knowledge embedding model, dimensions and prefixes; Desktop never selects or switches\n  the provider or alters the code/knowledge index.","startLine":287,"endLine":289},"existing":{"path":"wiki/configuration/guide.md","quote":"Optional repository embeddings use the `embedding` object in\n  project `.pi/search/semantic.json` and `OPENROUTER_API_KEY`; chunks/queries may\n  be transmitted externally.","startLine":500,"endLine":502},"explanation":"Оба утверждения описывают конфигурацию семантических вложений для поиска по репозиторию. Черновик (и связанные с ним активные спецификации) требует единственный глобальный конфигурационный файл `~/.config/pi/pi-tools-suite.jsonc` с ключом `search.embedding` и явно называет прежний проектный файл устаревшим, тогда как source-8 предписывает использовать объект `embedding` в проектном файле `.pi/search/semantic.json`. Один и тот же параметр не может одновременно задаваться глобальным и проектным файлом конфигурации."}],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n","startLine":1,"endLine":42},{"path":"wiki/search/desktop-search-index-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop search index status\n\nSource ownership and uncertain-work recovery are specified in\n[decision 0070](../decisions/0070-search-source-work-recovery.md).\n\n## Goal\n\nThe workspace sidebar's **Search indexes** panel explains local search stores per source.\n\n## Behavior\n\n- Sources: Code, Knowledge, Settings, Sessions, Tasks, Git commits. Each source row has an accessible checkbox; the five non-Settings source selections are project-local, while Settings is global across projects and synchronized with Desktop Settings → Assistant → Search settings. The Local cache column shows cached file/session/task/commit counts, with Settings showing available authored fields, rather than chunk counts or live source totals. Code and Knowledge counts are cached files; Sessions counts distinct session IDs present in cached title or public-message chunk tables. Counts describe cached entities, not current corpus totals. Stored vectors are retained cache, not proof of current coverage. Turning a source off retains its cache.\n","startLine":1,"endLine":17},{"path":"wiki/search/native-repository-search.md","quote":"  results/notices; no legacy index is queried.\n- Every Pi caller, including async/provider/council children, receives the same\n  unrestricted `project_search` schema and execution across sessions, tasks,\n  commits, code and knowledge, including `patch:`. Children suppress suite setup\n  commands and parent orchestration guidance only. Repository semantic embeddings\n  use the same explicitly configured global provider. Removed `repo_*` tools are not\n  part of ordinary search.\n\n## Optional reranking\n\n- The canonical global suite JSONC accepts optional `search.rerankerModel`, an OpenRouter\n  reranker model ID (for example `voyageai/rerank-3-lite`). Empty/omitted or invalid values\n  disable it. Project overrides, an API key alone, and legacy config do not enable it.\n  Desktop's **Reranker model** field edits this same global draft and uses its normal Save;\n  clearing the field removes the key. New default configs document it without enabling uploads.\n- Saving a nonempty model authorizes sending the query and bounded eligible Code/Knowledge\n  text plus Sessions/Tasks/Commits titles and snippets across projects in Pi/TUI/ACP/Desktop. Charges may\n  apply. Credentials use `OPENROUTER_API_KEY`, then shared Pi auth. This permission is\n  independent of `search.embedding`: hybrid/semantic queries can rerank local candidates\n  without embeddings. Removing embeddings does not disable a separately configured reranker.\n  Settings are excluded from remote reranking.\n- Pure lexical agent/native queries and document indexing never invoke reranking.\n  Desktop publishes local results first, then optionally reranks the merged selected\n  Sessions/Tasks/Commits/Code/Knowledge results after all source operations complete,\n  including late source replies. Embedding configuration is not required for this pass.\n  `project_search` hybrid/semantic queries likewise use one shared pass before final limits.\n  Up to 100 source-balanced candidates are sent once to\n  `https://openrouter.ai/api/v1/rerank`. History uploads contain only titles (512 characters)\n  and snippets (4096), never full sessions or diffs; native candidate content is capped\n  at 7500 characters. Provider documents remain capped at 8192 UTF-8 bytes each, while\n  the query plus all documents share a 32,000-byte UTF-8 budget. Native documents use\n  query-focused excerpts and avoid duplicate path/title headers. Each candidate shares\n  the remaining batch budget equally; truncated prefixes never split UTF-8 code points.\n  Code and prose with explicit identifiers, numeric anchors or acronyms retain contiguous\n  windows. Other prose uses extractive passages covering the whole question, or representative\n  sentences when there is no literal overlap. Selected sentences retain source order and\n  mark omissions with an ellipsis; this is not an answer-generation step.\n  Knowledge documents may include an explicit leading `Document status:` label from the\n  same hash-verified file used by freshness preflight. Only recognized leading `Status:`\n  metadata is used (first 32 lines, before a level-two-or-deeper heading, excluding fenced\n  examples); paths and incidental prose never imply status. The label shares the existing\n  byte budget, does not filter archived documents and adds no index schema or separate scan.\n  In-flight file changes still reject the ranking. Federated history that\n  cannot be verified during preflight stays in local results but is excluded from the\n  remote pool; verifiable candidates may still rerank with a partial notice. Revocation,\n  cancellation or stale sent-pool validation falls back to local order.\n  Candidate filters, deduplication and source policy apply before upload; native per-domain\n  caps and the requested final result limit apply after reranking. Returned relevance order\n  is preserved rather than re-sorted by local BM25. Desktop Settings retain their local slots.\n  Standalone native requests retain their Code/Knowledge pass; federated callers set\n  `skipRerank` and carry native freshness context to avoid double provider calls. Content upload does not\n  depend on `includeContent`; that flag controls only the returned payload.\n- Reranking has a four-second verification/slot/transport budget, bounded response size, no redirected\n  provider requests and strict index/score validation. Missing credentials, timeout,\n  provider errors and malformed responses retain original ranking with a redacted notice.\n  Global provider concurrency slots span transport lifetime. Source policy, configured\n  model, history source snapshots, native generation and current candidate bytes are checked around network work;\n  stale snapshots are not reranked, changed context rejects late ranking, caller cancellation\n  rejects the search. Periodic configuration/policy/generation checks cancel in-flight work;\n  no native SQLite handle is retained across reranker transport. History snapshots are\n  captured before retrieval and rechecked before upload and after transport. Desktop bounds\n  preparation to four seconds and the final request to 4.5 seconds, discarding late replies\n  even when an adapter ignores cancellation. CLI/Tauri `rerank` input is capped at 4 MiB\n  for bounded Unicode documents; other operations retain their 16 KiB input cap.\n\n## Optional semantic retrieval\n\n- The sole provider configuration is `~/.config/pi/pi-tools-suite.jsonc` (`HOME`, then\n  the operating-system home). Its valid explicit `search.embedding` object authorizes **all**\n  sources/projects in ordinary Pi, TUI, ACP and Desktop. There are no separate project,\n  task, session or settings opt-ins. Missing, malformed, oversized or redirected config\n  fails closed to local retrieval. A key or existing vector cache alone does not enable\n  semantics. Legacy project config and Desktop consent booleans are ignored, not migrated.\n","startLine":106,"endLine":178},{"path":"wiki/assistants/deepgram-voice-input.md","quote":"  wait for finalization or commit an unsettled interim into a destroyed\n  composer.\n- Repeated microphone toggles while a stop is already in flight join that stop\n  and do not restart recording from the same user action.\n- macOS builds declare `NSMicrophoneUsageDescription`; desktop CSP permits\n  `wss://api.deepgram.com` and does not permit exposing the permanent key.\n\n## Configuration compatibility\n### Desktop search input\n\nUniversal Search exposes an on-screen microphone when WebView capture is\nsupported. It reuses the same native token grant, configured language/model,\ncapture/transport and finalization as the composer; no permanent key enters the\nWebView. Interim text is separate from the query. Final transcripts replace the\ncurrent input selection with spacing and the search query's 2048-character\nlimit. Stopping only edits the query; explicit Search/Enter waits for the final\ntranscript before searching. Manual edits, filters, workspace/client replacement\nand dialog close invalidate ownership before teardown, so late callbacks cannot\nedit, refocus or submit into a later scope. The dialog keeps errors visible and\ndiscloses Deepgram audio transmission in Search details. It does not register\nthe native F5 shortcut; the accepted composer-only scope remains unchanged.\nThe surrounding Universal Search dialog separately fences transcript, focus,\ncaret and submission callbacks across edits, filter changes, scope/client\nreplacement and close/unmount.\n\n### Existing settings\n\n`dictation.apiKey` is the preferred Deepgram credential and is intended only for\nthe relevant frontend's user config (`pix.jsonc` for TUI, `pix-desktop.jsonc`\nfor Desktop); the Desktop Settings form exposes its own value as a sensitive\nfield. Desktop config accepts only `dictation.apiKey`, `dictation.language`,\nand `dictation.model` (default `nova-3`).\n\nThe TUI additionally has the active language-picker configuration:\n`dictation.languages`, keyed by the selectable local language code, with each\nentry's `label` and optional `deepgramLanguage` transport code. This is the\n","startLine":146,"endLine":181},{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n","startLine":1,"endLine":32},{"path":"wiki/search/project-search-agent-tool.md","quote":"through a single bounded `project_search` tool. Use the same project data\nsources and project-owned search-cache tables as Desktop Universal Search,\nwithout duplicating a persistent index or invoking a second answer LLM/Jev.\nAuthoritative project task/session/Git state remains read-only; explicit\nsemantic searches may update source-local SQLite stores under explicit global provider configuration.\nNative Code/Knowledge uses disposable `.pi/search/code.sqlite` and `.pi/search/knowledge.sqlite` stores;\nsee [native repository search](native-repository-search.md) and [0065](../decisions/0065-native-repository-search.md).\n\n## Behavior\nSearch indexing writes selected metadata-only diagnostics to the **shared Pix\nJSONL logger** at `~/.config/pi/logs/` (`search.index` module). The old\n`.pi/artifacts/search-diagnostics-*/events.jsonl` writer is retired: no search\ncode opens an independent diagnostic file. Each host uses the in-process Pix\nsink; standalone Pi remains functional when that optional sink is absent.\nNormal starts, per-session successful/empty passes, cancellation and five-second\nprovider-wait heartbeats are not written. Failed and incomplete index passes\ninclude bounded counts (checked/skipped sessions, discovered/cached chunks,\nsaved vectors, provider calls), elapsed duration, fixed execution phase and\nallowlisted error type/OS/SQLite code. A successful pass that saved vectors is\n`debug`-only. Skipped transcripts emit a rate-limited warning with a fixed\nreason and safe code; raw session IDs, file paths, parent/child IDs, provider\nmessages, prompts and document text never enter these events. The separate\nuser-requested manual result retains existing bounded skip details for the\ncurrent action, without building a Desktop Activity history.\n\nBackground session synchronization normally rechecks cross-host inactivity after\n30 seconds. If a worker throws or finishes with an operationally incomplete\nindex (e.g. an unreadable transcript), periodic recovery backs off to 2, 4, 8,\nthen at most 15 minutes instead of retrying every 30 seconds. Deferred or\nnot-yet-mature sessions do not trigger failure backoff. A fresh session or\nsource change can trigger a debounced earlier retry; explicit manual\nIndex/Continue is unaffected. Generic background-worker errors generate\n`search:background-failed` (warn), tagged with a fixed phase, error category\nand allowlisted OS/SQLite code; repeated causes are coalesced for five minutes\nwith a suppressed count. Per-session failures use the same safe categories\nwithout including session IDs. Ordinary cancellations, including a deliberate\nchange to the enabled search sources, are not warnings. Invalid or unreadable\nsource policies remain operational failures.\n\nThe background idle-session selection reads activity/lease metadata in one\nSQLite connection per candidate sweep instead of reopening the source database\nfor each session. This metadata snapshot only filters candidates: immediately\nbefore provider requests and final publication, current activity and source\npolicy are rechecked. Manual TUI/CLI session indexing first reconciles public\ntranscript metadata and chunks, then authenticates and embeds explicit saved\nnames against that updated index. A cold first pass must not silently omit\nsaved-name vectors and require a second Continue to populate them.\n\n\n- `project-search` is a default-enabled module in the bundled pi-tools-suite\n  catalog. It registers one `project_search` tool in ordinary Pi with the suite, the main Pix TUI and\n  Desktop agent extension runtimes, without a project-index registration gate.\n  No external index setup commands, RAG generation or writes\n  to canonical task/session/Git data occur. Search-cache writes are limited\n  to source-local caches. Tasks and public session messages also synchronize in the background.\n- Required `query` is a nonempty string of at most 2,048 characters.\n  Project-local source selection is shared with Desktop through\n  `.pi/workspace.jsonc` under `search.sources`. The optional map accepts boolean\n  `code`, `knowledge`, `sessions`, `tasks`, and `commits` flags. Missing\n  workspace/search/map/flags enables **Code only** among the five project sources;\n  malformed/unsafe workspace config or an invalid source map fails closed for all six\n  sources. The tool's available-source description, prompt guidance and parameter\n  schema track the enabled sources dynamically. `sources` optionally selects\n  unique enabled values from `sessions`, `tasks`, `commits`, `code`, and\n  `knowledge` (all enabled tool sources by default, initially Code only).\n  Settings is a Desktop-only source, never a tool parameter choice. Explicit\n  requests for disabled sources are skipped without dispatch. Disabling a source cancels/rejects stale work and\n  retains its caches for reuse if re-enabled. Global embedding configuration\n  remains unchanged and cannot override project selection. Legacy\n  `.pi/search-sources.json` and its lock are not read, imported or migrated.\n  `limit` is 1–20 (default 10). `indexMode` is `hybrid` (default),\n  `semantic`, or `lexical`. Code and Knowledge always use the native backend.\n  `hybrid`/`semantic` additionally permit querying maintained task/session-name/session-message\n","startLine":11,"endLine":83},{"path":"wiki/development/testing/session-revision-evaluation.md","quote":"invalid or missing response is incomplete, not `unchanged`.\n\nExit codes: **0** all annotated relations and query expectations match;\n**1** completed quality eval has misses; **2** setup/transport/budget/cache failure.\nFixture validation also exits 0, but is explicitly not a model-quality score.\nUnannotated accepted edges are listed for review and are not counted as correct.\nThe harness is not added to default CI; live checks must remain opt-in.\n\n## What is automatic\n\n1. All supplied messages are split into lines and language-neutral ICU sentences,\n   with long pieces bounded to 600 UTF-16 units. Every fragment has exact original\n   `entryId/start/end` provenance. This is **structural source-span extraction**,\n   not semantic atomic-assertion extraction. Questions, headings, proposals and\n   automated text can remain in the corpus.\n2. For each later message, retrieve its three most similar **earlier spans across\n   the whole supplied branch**, plus the highest-scoring immediately preceding\n   message span if absent. Discovery never sees expected labels or search queries.\n   Short messages include two preceding messages for reference resolution.\n   Context can dominate similarity; this is an evaluated weakness, not a solved filter.\n3. Jev classifies `requested/reported/unchanged/uncertain`. Positive replacements\n   require a second same-model `changed` check. The second check is not independent\n   confirmation. Model inputs include source context, but only the selected span\n   may be superseded. `reported` means claimed in the transcript, not verified.\n4. Query vectors rank source spans. A small assertion-local overlay attaches later\n   decisions/reports to each of the top three spans without deleting history or\n   suppressing the whole source message. As-of queries exclude later spans and\n   edges; historical mode suppresses overlays. This is **not a general relation\n   graph**: reversals through intermediate nodes, reaffirmed latest reports and\n   non-assertion anchors remain unresolved. Raw rankings are retained for comparison.\n\n## Corpus and scoring\n\nThe JSON corpus is an array of cases, each with `id`, `split`, ordered\n`messages: [{id, role, text}]`, `expected`, and optional `queries`.\n\n- Relations: `{earlierId, laterId, relation, evidence}`. `evidence` is an exact\n  substring of the earlier message and must occur **inside the candidate span**,\n  not just context or another fact in the same message. Sparse gold annotations\n  measure recall of those particular spans; other semantically equivalent spans\n  are not automatically credited or deemed wrong.\n","startLine":28,"endLine":68},{"path":"wiki/configuration/guide.md","quote":"\nExisting Pi provider credentials are preserved by default. Use\n`/opencode-import --force` only when replacement is intentional.\n\nOpenCode model definitions, MCP servers, plugins, instructions and tool settings\nare not migrated automatically because their formats/security assumptions do not\nmap safely.\n\n## Voice input\n\nPut a Deepgram key in the frontend-specific user profile:\n\n```jsonc\n{\n  \"dictation\": {\n    \"apiKey\": \"your-deepgram-api-key\",\n    \"language\": \"en\"\n  }\n}\n```\n\n- TUI: `~/.config/pi/pix.jsonc`;\n- Desktop: `~/.config/pi/pix-desktop.jsonc`.\n\n`DEEPGRAM_API_KEY` remains supported as a compatibility fallback.\n\nThe TUI also needs an audio recorder such as SoX, `ffmpeg`, or `arecord` on\nLinux.\n\nDesktop requests a short-lived Deepgram token from the local Tauri backend; the\npermanent key is not exposed to the WebView. The key used for Deepgram\n`/v1/auth/grant` needs Member-or-higher authorization. Desktop also needs OS\nmicrophone permission.\n\n## Optional integrations\n\n- **Web search:** local Ollama can work without a cloud key; cloud Ollama/Tavily\n  credentials can be configured with `/web-credentials`.\n- **Context7:** export `CONTEXT7_API_KEY`.\n- **LSP:** configure/trust servers in tools-suite configuration. See\n  [pi-tools-suite LSP setup](../tools/suite.md#lsp-setup).\n- **Repository search:** Code and Knowledge search is native across Pi, TUI,\n  ACP and Desktop. Optional repository embeddings use the `embedding` object in\n  project `.pi/search/semantic.json` and `OPENROUTER_API_KEY`; chunks/queries may\n  be transmitted externally. Legacy external-search data/configuration is not read, migrated,\n  deleted or modified by this integration.\n\n## Local project instructions\n\n","startLine":458,"endLine":506},{"path":"wiki/tools/suite.md","quote":"\n### Native repository embedding setup and privacy\n\nNative lexical search requires no credentials. `/search-semantic status` shows\nwhether global semantics are configured. `/search-semantic configure \u003cembedding JSON\u003e`\nsaves the embedding object and authorizes semantic retrieval for all sources/projects;\n`/search-semantic off` removes it. `/search-semantic reset-history` is an explicit\nuser-only recovery command for incompatible history caches in the current project: it\nclears only recognized derived task/session/commit/settings vectors and identity metadata\nfrom their source-local databases (`tasks.sqlite`, `sessions.sqlite`, `git-commits.sqlite`,\nand `settings.sqlite`), preserving canonical tasks, sessions and Git history. Repository\nvectors live alongside source chunks in `code.sqlite` and `knowledge.sqlite`; they are\nunchanged by this history reset. Legacy databases are not read, imported or migrated.\nSchema-1 Settings caches are rejected without mutation. Status inspection never repairs\nstores. Stop and restart every\nolder Pi/ACP/Desktop client before using split stores; old clients do not honor the new\nwork protocol and mixed-version writes are unsupported. A separate global\n`~/.config/pi/search-provider-work.sqlite` coordinates at most four concurrent provider\nleases; after a crash or partition this cannot prove the count of remote provider\nexecutions. Source/provider leases renew every 30 seconds and expire after 90 seconds.\nQueued sources keep their claim renewed and recheck after acquiring a slot; cancellation\nretains ownership until tracked transport settles, and lost owners cannot publish. After\ntwo failed/interrupted network attempts (initial plus one automatic retry), explicit\nContinue is required; success resets failures, and Continue clears the exhausted budget\nbefore reconciliation. A short failed-work cooldown applies. Crashes after transmission\ncan still result in duplicate provider billing; this is not exactly-once delivery. See\n[decision 0070](../decisions/0070-search-source-work-recovery.md).\nThe next search can re-embed and incur charges. Busy, unsafe, redirected or unrecognized\nstorage fails closed without a reset. Desktop Settings Search edits the same global file\nwithout ACP. No independent consent flag or confirmation step is used. Old\n`.pi/search/semantic.json` and Desktop semantic booleans are ignored; keys/caches alone\nnever activate semantics. OpenRouter credentials use `OPENROUTER_API_KEY`, then shared\nPi auth storage (`PI_CODING_AGENT_DIR` or `~/.pi/agent`); Ollama needs no key.\n\nOptional `search.rerankerModel` in the same global suite JSONC enables OpenRouter\none merged rerank of selected Sessions/Tasks/Commits/Code/Knowledge results, independently of\n`search.embedding`. For example, `\"rerankerModel\": \"voyageai/rerank-3-lite\"`.\nSaving a nonempty model authorizes sending queries and bounded candidate text\nacross projects; charges may apply. Missing/empty values disable it; credentials\nalone do not enable it. Pure lexical agent/native search and indexing never invoke reranking.\nDesktop publishes local results first, then optionally reranks once all sources finish.\nSettings remain local. History sends bounded titles/snippets, not entire sessions/diffs;\nthe source-balanced 100-candidate pass precedes final result limits.\nDesktop's **Reranker model** field uses the same draft and normal Save; clearing\nit removes the key. `/search-semantic off` only removes embeddings, not a separately\nconfigured reranker. Provider failure/timeout retains original ranking. See\n[native repository search](../search/native-repository-search.md#optional-reranking)\nfor limits, filtering and lifecycle safeguards.\n\nTo configure file suffixes for native repository search, set `search.codeExtensions`\nand/or `search.knowledgeExtensions` arrays in the global\n`~/.config/pi/pi-tools-suite.jsonc` settings. For example:\n\n```jsonc\n{\n  \"search\": {\n    \"codeExtensions\": [\".gdshaderinc\", \"mydsl\"],\n    \"knowledgeExtensions\": [\".guide\"]\n  }\n}\n```\n\nEach configured list replaces the full built-in list for that category; lists are not\nadditive. An explicit empty list disables the category, while an omitted list uses its\nbuilt-in defaults. Only configured suffixes are indexed; filenames such as `Dockerfile`\nand `Makefile` have no special handling. Entries are simple 1–32 character suffixes\n(letters, digits, `_`, `+` or `-`), with optional leading dots; matching is\ncase-insensitive. Each source accepts at most 128 entries, and the effective Code and\nKnowledge lists must not overlap. Unsupported paths/globs and invalid or overlapping\nsettings are rejected. Normal ignore, binary, size and link exclusions still apply.\nChanges take effect on the next explicit search/index scan; saving settings alone does\nnot scan or trigger embeddings. Project-local settings do not override these lists.\n\nThe [Codex reasoning replay spec](../providers/codex-reasoning-fix.md) owns the\nlast suite hook's narrow wire-only contract, evidence, and known cached\nWebSocket continuation limitation.\n\n","startLine":94,"endLine":170},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n","startLine":1,"endLine":52},{"path":"wiki/decisions/0070-search-source-work-recovery.md","quote":"# 0070 — Source-isolated search indexes and bounded uncertain recovery\n\n- Status: accepted\n- Recorded: 2026-10-11\n- Decided: 2026-10-11\n- Owner / approval evidence: user request for six isolated search indexes; explicit\n  answer to `uncertain-paid-work` selected automatic recovery after a delay, with\n  bounded retries and possible duplicate billing (conversation entry `b2025f1e`,\n  2026-10-11 17:13 UTC). This approves the recovery trade-off, not production readiness.\n- Governing specs: [native search](../search/native-repository-search.md),\n  [universal search](../search/desktop-universal-search.md),\n  [index status](../search/desktop-search-index-status.md)\n- Replaces / replaced by: none. This changes the shared-storage implementation\n  described historically in [0066](0066-native-repository-semantic-search.md),\n  not its provider/privacy contract or [0068](0068-global-semantic-configuration.md).\n\n## Context\n\nSettings and Tasks shared a SQLite writer while awaiting provider HTTP. A local\n60-second writer-acquisition workaround did not remove the architectural cause.\nThe user required six source databases, short transactions, compatible-vector\nmigration, unchanged canonical data and one global embedding configuration.\n\n## Observations and sources\n\n- `external/pi-tools-suite/src/project-search/source-work.mjs` and its tested ACP\n  twin implement durable source ownership and shared provider slots.\n- `external/pi-tools-suite/test/source-work.test.mjs` exercises independent\n  processes, terminated workers in a live process, heartbeat expiry, cancellation,\n  migration interruption and retained originals using fixtures, not paid providers.\n- A process crash can leave a provider request accepted remotely but no locally\n  recorded result. Local leases cannot establish whether it was billed or stopped.\n  This uncertainty was explained before the user's recovery choice above.\n- Real provider behavior and real Desktop recovery were not verified in this task.\n\n## Decision\n\nThe governing specifications are [native repository search](../search/native-repository-search.md),\n[Desktop universal search](../search/desktop-universal-search.md), and\n[Desktop search index status](../search/desktop-search-index-status.md). The suite\n[README](../tools/suite.md) also summarizes the recovery contract.\n\nUse one database per source and a separate global SQLite coordinator, not a\ntransaction held during HTTP. Source claims and provider slots use 90-second\nrenewable leases. Expired leases can be reclaimed regardless of whether the PID\nstill exists: a terminated worker can share a live parent PID. Publication must\nvalidate ownership plus current content/model before a short commit.\n\nSource and provider leases renew every 30 seconds and expire after 90 seconds. Normal\ncancellation retains both claims and slots until the tracked transport actually settles;\nlost ownership cannot be resurrected or used to publish. A queued source keeps its claim\nrenewed and rechecks ownership after acquiring a provider slot. After two failed or\n","startLine":1,"endLine":52},{"path":"wiki/desktop/workbench/desktop-project-wiki.md","quote":"Display sampling alone does not invalidate a completed comparison. The merge\nalso enforces the actual escaped 384 KiB report envelope by omitting whole\npassages/findings with notices, never by rewriting quotations. Dropped findings\ncannot yield a green result, and an established retained conflict stays red.\n\nQueries sample representative sections when the draft exceeds the query budget.\nSource passages retain bounded leading context for lifecycle and scope metadata.\nOrdinary query sampling, top-candidate/source limits, excerpts and context\nreduction describe the review scope in a compact coverage summary. They do not\nmake a successfully completed comparison of the selected passages incomplete.\nPassages and leading context end on complete lines; optional context never\ndisplaces the reserved matched range. Timeouts, failed or stale retrieval,\nunavailable/incomplete semantics, unreadable sources and genuine comparison\nuncertainty still produce notices and prevent a clear result. Sources\nare reread from validated project files; cached search snippets are not used as\nproof. The model can also compare two claims within the draft. With zero external\nevidence, internal findings remain available, but cross-document consistency\ncannot be established.\n\nFindings require known source IDs and exact, uniquely occurring quotations in\nthe draft and source passage after newline normalization. Line ranges are\ncomputed from those texts. Metadata context alone cannot ground a quote.\nMalformed output, fabricated or ambiguous quotations and model uncertainties\nmake the check incomplete; independently valid findings can still be shown.\n\n- **No contradictions found in the reviewed passages** allows the initiating\n  Save to write that same draft only when retrieval of the selected material and comparison completed.\n  A manual check in Edit does not save the draft.\n- **Potential contradictions found** preserves the draft and displays paired\n  quotations, paths, line ranges and an explanation. Coverage notices remain\n  visible when other parts of the check were incomplete.\n- **Consistency check is incomplete** preserves the draft and reports missing\n  coverage or a failed check. It never automatically counts as a clear result.\n\nThe report is a collapsible document in both Preview and Edit, and in the\nretained sidebar task. Its summary keeps status, counts and actions accessible\nwhile collapsed. The expanded body separates established contradictions,\nmaterial uncertainties, checker diagnostics and the actual reviewed source\npassages. Each finding and uncertainty pairs the draft quote with an original\nsource quote, real project-relative paths and inclusive line ranges. Individual\nfindings and source excerpts can be expanded independently. Model prose is\nrendered as text, not executable HTML.\n\nUncertainties use the same exact-quotation grounding as conflicts: a missing\ndeciding condition is explained separately from the two actual claims. A pair\nreturned in both classifications remains an uncertainty, never a proven conflict.\nLegacy free-text uncertainties remain visible as diagnostics without invented\ncitations. New results retain up to 12 original evidence passages and 48,000\ncharacters; optional background context does not become quoted evidence. Older\nreports without source inventories explicitly indicate that those snapshots\nwere not retained.\n\nA citation opens the saved source in rendered Markdown Preview, retaining\nback/forward history. Before highlighting, Preview locates the exact quote\nuniquely in the current file, normalizing line endings and recalculating moved\nline ranges. A missing or ambiguous quote shows a stale-evidence notice and\nnever highlights old line numbers. When Markdown formatting prevents exact\nrendered-text highlighting, the containing source-mapped block is highlighted\nwith an explicit explanation and the literal quote. Ordinary source links and\nWiki search ranges retain their existing behavior. Evidence highlights are\nremoved on navigation, editing, inactive Preview and disposal.\n\n**Resolve in new session** / **Разрулить в новой сессии** is an explicit action\non a completed non-clear report. It creates and selects a normal conversation\nin that report's project and submits the report's actionable data — status,\nconflicts, uncertainties and notices — with the exact captured document text,\nbound to its SHA-256. Retrieval statistics, the judge model and reviewed\npassages without findings are not handed off. The Wiki Conflicts comparison\noffers the same action for one finding: it requires a current report on a saved\npage, submits only that finding and the target path/hash, and lets the agent\nread the saved file instead of embedding its text. Opening, expanding or completing a report\nnever starts a conversation. Duplicate clicks during startup cannot create\nmultiple sessions. Workspace/client replacement and project reset invalidate\npending startup; a newly allocated stale session is closed without submitting\nthe task.\n\n","startLine":521,"endLine":596}],"notices":["Результат 2 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Неопределённость 2 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Список источников в сохранённом отчёте сокращён по размеру; объём выполненной проверки указан отдельно."],"coverage":{"scope":"retrieved-passages","checkedPassages":24,"candidateSources":88,"excerptedSources":19,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"],"retainedPassages":12}}} -->

# Desktop universal search

## Behavior

Desktop's UI retrieves and navigates these sources independently of the
headless `project_search` agent tool. Both read the same canonical task,
session and Git stores and the native Code/Knowledge engine; the agent tool
provides compact evidence and IDs for the calling agent, without RAG inference
or a separate persistent index. Queries reuse maintained task, saved-session-name
and public-message vectors and may embed the bounded query under the explicit
global embedding configuration and project source policy. Task/session documents
are maintained by authorized background/manual indexing, not query backfill.
It also incrementally populates current Git commit metadata/message
vectors using the suite-owned configured embedding provider and the shared
`pix_commit_*` tables. Unlike Desktop's progressively updated UI, the agent
tool waits for
the selected sources (up to 60 seconds) and returns one combined response. See
[project-wide agent search](project-search-agent-tool.md).

- Source ownership and uncertain-work recovery are specified in
  [decision 0070](../decisions/0070-search-source-work-recovery.md).
- The five non-Settings source selections in the Search indexes panel are project-local and control both indexing
  and search. Universal Search exposes only enabled-source filters and excludes
  disabled sources from retrieval; disabling a source cancels owned work and
  suppresses stale results. Selection is stored in `.pi/workspace.jsonc` under
  `search.sources`; caches are retained and reused if a source is re-enabled. The
  optional map accepts boolean `code`, `knowledge`, `sessions`, `tasks`, and
  `commits` flags. Missing workspace/search/map/flags defaults Code on and all
  other project sources off. Settings remains a separate global selection, default
  enabled. Malformed/unsafe workspace config or an invalid source map fails closed
  for all six sources. Embedding configuration remains global and does not override
  project selection. The former `.pi/search-sources.json` and its lock are not read,
  imported or migrated. Initial
  selection inspection is bounded to five seconds; timeout or invalid policy fails
  closed with a visible notice. Policy refresh runs every three seconds after the
  previous read settles, and source results are discarded when cancelled,
  superseded, or based on an obsolete policy revision.
- Submitted inline Settings/Sessions searches read the same project policy before
  dispatch; they do not substitute the missing-policy defaults for an enabled
  project. Disabled sources produce a notice without dispatch. Local typeahead
  remains navigation over already displayed settings metadata or saved titles,
  not document indexing or a semantic provider request.
- Desktop provides one current-project dialog, opened from the titlebar or
  Cmd+Shift+F (Ctrl+Shift+F on non-macOS hosts). Settings, Sessions, Tasks, Commits,
  Code and Knowledge are independently selectable. Results use a shared local
  field-weighted BM25 ranking over retrieved, deduplicated candidates, not fixed
  source interleaving or comparison of unrelated vector scores. BM25 uses
  positive Robertson IDF, term-frequency saturation and field-length normalization
  (k1=1.2, b=0.75), with title scores weighted 3× relative to metadata.
  Exact titles win score ties. Case, punctuation, identifier word boundaries, ё/е,
  a small Russian inflection heuristic and English plurals are normalized. A
  bounded
  authored technical vocabulary maps Russian autocomplete variants (including
  «авто-пополнение») and English "auto completion" to the same `autocomplete`
  concept, without matching unrelated Auto routing/thinking. Common query
  stop words and conversational query framing are ignored when possible (unless
  the query contains only stop words).
  Metadata hits matching less than half of distinct meaningful terms are dropped.
  Authored setting synonyms, task IDs, commit changed-file paths and commit
  hash prefixes (at least seven hex digits) remain searchable. Code/Knowledge
  requests include native bounded content for local BM25 and previews.
  Missing/truncated excerpts remain opaque candidates below lexical matches,
  as are configured semantic settings/task candidates, first/final session-excerpt
  matches, and semantic/full-message/patch commit candidates without visible
  lexical evidence.
  Source-local rank only breaks
  lexical ties; results remain capped at 60. This local ranking adds no provider calls or
  on-demand file reads. Only Code/Knowledge retrieval uses the normalized technical
  concept as its query (one shared native request for the selected domains); settings and sessions
  retain the original query. No general machine translation or extra source
  discovery is attempted.
- Optional global `search.rerankerModel` adds one remote pass over up to 100
  source-balanced Sessions/Tasks/Commits/Code/Knowledge candidates after all source
  operations finish, including late replies; local results remain visible while waiting.
  Settings are excluded and keep their locally ranked slots. The final relevance order
  is not re-sorted by BM25 and is capped at 60. Native retrieval skips its internal pass
  to avoid double reranking. History uploads only bounded titles/snippets, not full
  sessions or diffs; config/policy/history/native freshness checks fence upload and
  publication. Timeout/error keeps local ranking, and cancellation discards late replies.
  See [reranking safeguards](native-repository-search.md#optional-reranking).
- Search runs only on Search or Enter in the input. Typing/changing types cancels
  stale requests and clears results but never runs a query. Empty queries do not
  search. Activating a result is separate from submitting a query.
- Search modes are **Auto** (the default), **Search**, and **RAG**.
  Search remains the existing direct source lookup without an intent classifier.
  Auto calls the private ACP `pix/search/intent` method **only after an explicit
  search submission** (never while typing). The stateless classifier uses
  OpenRouter Decisions API and `~typesafe/jev-latest` by default, with an optional
  OpenRouter model override in Desktop `search.intentModelRef` (empty selects
  Jev). This preference is also used by the quick-task type classifier, independently
  of `search.ragModelRef` and `search.ragThinking`. The search intent request
  makes a single constrained `search | ask` choice. Only the entered query is sent; no workspace path,
  source results, transcripts, snippets or files are included in the request.
  Auto has a visible OpenRouter/cost disclosure and requires a saved OpenRouter
  credential. It is independent of semantic embedding configuration.
  No other model-routing tiers or provider fallback models are used.
  Jev is bounded to five seconds, uses no result cache, and missing credentials,
  invalid answers, provider failures or timeouts select Search, with a visible
  fallback notice. Explicit `patch:` searches skip Jev and remain Search.
  Query edits, filter/mode changes, dialog close, workspace/client replacement,
  and new submissions invalidate old decisions and cancel in-flight requests.
  If Jev chooses Search, existing source search runs unchanged. If it chooses
  Ask, RAG starts immediately inside the dialog. Manual RAG bypasses Jev.
  The selected mode is held in window-only memory; a new workspace defaults
  to Auto, with no automatic search or generation on reopen.
- RAG retrieves from the existing selected Search sources (Settings, Sessions,
  Tasks, Commits, Code and Knowledge), reusing native lexical repository retrieval, the local
  session excerpt FTS and commit metadata/semantics. Source ranking reuses the
  current unified order (local BM25 or completed optional reranking), capped at 12 evidence items with at most four
  from each category. No duplicate vector index or full transcript/diff index
  is created. Code/Knowledge source files are reread by the ACP backend with
  realpath, regular-file and symlink checks, project-root containment, bounded
  file sizes (2 MiB), and cited line windows. Session evidence is reread from the
  authenticated canonical transcript, starting one message before the matched
  message through the last persisted branch head (or the whole branch when no
  message anchor exists). It preserves chronology and short user reversals.
  Missing/stale message anchors never fall back to client snippets. If the entire
  suffix cannot fit the remaining 30,000-character total / 28,000-character
  session budget, generation fails explicitly rather than dropping late turns.
  Commit messages are reread only for
  HEAD-reachable commits. Other source types use bounded search-result metadata.
  Unavailable/unsafe files are omitted; empty evidence does not invoke an LLM.
  Retrieved source content and the question are explicitly sent to the chosen
  model provider for RAG generation, separately from the Jev query-only intent
  classification and semantic-index configuration. Provider charges may apply.
- Generation runs in an isolated temporary Pi SDK ModelRuntime, without
  creating a Pi/ACP conversation/session or mutating project state. The private
  Desktop-only `pix/search/rag` request carries bounded evidence references,
  and `pix/search/rag_delta` sends validated text and the exact set of
  verified source IDs; request IDs prevent cross-query notification leaks.
  Source excerpts are untrusted data in the model prompt. The model must cite
  only supplied evidence as `[1]`, `[2]`, etc., and report missing evidence
  instead of inventing facts. Generation buffers text until citation syntax and
  bounds are checked and session revisions are revalidated. Missing, malformed or
  out-of-range references fail closed before answer text is exposed. This checks
  citation syntax/source identity, not semantic entailment. The prompt distinguishes
  proposals, authorization, promises, reported execution and independently verified
  outcomes; assistant reports are not filesystem proof. The output is displayed as Markdown in the
  existing search dialog with inline clickable citations and a source list.
  Each source reuses the same navigation as a normal Search hit (code line,
  knowledge line, commit diff, session, task or setting). Unknown citation
  numbers are inert. Generation supports cancellation and an owned 90-second
  deadline; stale completion after close/edit/filter/project change is ignored.
  RAG failures display the complete originating error message as plain text,
  including provider stream errors and backend validation/configuration failures,
  rather than an opaque availability notice. Line breaks are preserved and long
  messages wrap without truncation. Stack traces and arbitrary request/auth objects
  are not serialized for display. Cancellation and stale-request suppression remain unchanged.
- Desktop user settings at `search.ragModelRef` and `search.ragThinking` own
  the independent answer model and reasoning effort. Empty model reference
  means the normal Desktop default model; effort defaults to medium and supports
  Off, Minimal, Low, Medium, High, Extra High and Max. The structured Assistant
  settings use the existing catalog-backed model selector and a thinking-level
  selector. These settings are distinct from modelRouting/Auto, semantic-search
  embedding configuration and the currently active conversation model. Search mode and
  RAG generation do not automatically change the user's conversation.
- The dialog uses a compact input/filter/results layout. A persistent live
  footer spinner and `Searching…` label remain while the initial request or any
  late source is pending, including alongside partial results. Result-region
  busy semantics cover both states. Real source warnings, a compact semantic
  configuration status and brief provider/cost disclosures remain accessible in a
  collapsed `Search details` section with an explicit rotating Lucide chevron.
  The six result-type filter chips and the `Search settings` action live inside
  this disclosure, not in always-visible toolbar/footer rows. This is the only
  settings action in the dialog; the semantic status does not repeat it.
  Static implementation explanations (ranking, index mechanics, vector dimensions,
  query syntax and healthy backend diagnostics) are not shown here. A redundant
  `Current project` label is not shown; the dialog is already project-scoped.
  The mode switcher remains always visible and says only `Auto / Search / RAG`,
  with a short query/excerpt transmission notice for Auto/RAG. Expanded details
  disclose embedding-provider transmission/costs when configured and microphone
  transmission when supported. Warnings remain scrollable without clipping.
  Timeout notices are not repeated as
  warnings. Completed empty searches remain
  distinct from pending/error states.
- Result rows have visibly different pointer-hover, keyboard-focus and active-row
  treatments using semantic theme colors in light and dark modes. No result is
  preselected on a fresh search; Arrow Down/Up selects the first/last row when
  needed. Pointer hover uses a fully rounded, inset outline and category badge
  contrast rather than a protruding left border. Keyboard focus remains visible,
  disabled rows do not highlight, and reduced motion disables transitions.
- An on-screen microphone provides voice query input through the existing
  [Deepgram transport](../assistants/deepgram-voice-input.md), using Desktop's configured
  model/language and short-lived native token. Audio is sent to Deepgram; the
  permanent key stays native. Interim text is shown separately; final text
  replaces the input selection with normalized spacing, bounded to 2048
  characters without discarding other query text. Stopping the microphone does
  not search automatically. Explicit Search/Enter waits for finalization before
  submitting. Manual editing, filter changes, scope/client replacement and
  close/unmount cancel recording ownership and ignore late callbacks, caret
  updates, focus and submission. Unsupported capture environments omit the
  microphone; permission/configuration errors remain visible. F5 remains
  composer-only under [0062](../decisions/0062-macos-dictation-key.md).
- Closing/reopening retains query, selected types and completed results in the
  current window, without resubmitting. Workspace or ACP-client replacement clears
  this memory. Closing cancels pending work; an interrupted query retains its input
  but must be explicitly submitted again. Nothing is persisted to disk.
- Tasks search reads the same `.pi/tasks.sqlite` rows as the Tasks panel and
  locally matches labels, descriptions, IDs, type, status, priority, links to
  project files/artifacts, parent task ID/title, related task IDs/titles in
  both directions, epic flag, assigned model/effort and associated `sessionId`
  across all tasks (including done). Linked attachment **names** are read from
  the SQLite association table in one background native query. File contents,
  attachment blobs and session contents are never searched as part of Tasks.
  Selection verifies
  the stable task ID still exists in storage, then reveals it in Tasks; it never
  runs or edits the task. If the panel has not loaded a newly added external task,
  selection asks to refresh Tasks rather than overwriting its current document.
  The reveal/scroll operation rechecks workspace, connection and navigation
  ownership after rendering so a cancelled or superseded selection cannot scroll
  a different project's panel.
- Task semantics use the global embedding configuration without a
  task-specific toggle. While the workspace is connected, bootstrap and task-store
  changes index task documents in the background, independently of searches.
  Enabling/changing the global provider resynchronizes the workspace. Queries
  rank existing document vectors and may send the entered query; background
  indexing sends task `title`+`description` (2,000-character combined cap per
  task) and saved plan Markdown to the configured knowledge embedding model.
  Each plan is split into overlapping chunks (2,000-character window, 1,800
  stride, at most 64 chunks per plan); every chunk is embedded with the plan
  path and title as context, and query results collapse to one hit per plan
  (best chunk). Plan content is therefore uploaded when
  task semantic search is enabled. Status, priority,
  IDs, hierarchy, links/paths, session/model assignment, attachment filenames
  and bytes are never included in the embedding input; existing user-authored
  description text remains eligible even if it itself contains paths.
  Task data never uses repository-search tables or the settings-only `documents`
  table: `pix_task_index_meta`, `pix_task_documents` and `pix_task_vectors`
  are separate table families in `.pi/search/tasks.sqlite`. Only IDs, content
  hashes and configured-dimension float32 vectors persist, not the task text.
  Embeddings are keyed by a hash of semantic text. Status/link/model changes
  reuse the same vector; description edits, renames and deletions reconcile
  changed IDs/hashes and prune unreferenced vectors. Queries validate returned
  hashes against the current SQLite corpus before surfacing any task hit.
  SQLite write ownership, revalidation and cancellation fence concurrent
  writes, provider responses after configuration changes/removal, and stale task payloads.
  Background workers drain changed/missing documents in bounded provider batches;
  task database creation, replacement and WAL-backed edits are detected, including
  external writers. Metadata-only edits reuse vectors; deletions reconcile references.
  Queries do not initiate task-document embeddings. Cached vectors are retained when disabled, but no further
  provider requests are made without valid global configuration.
  The ACP semantic task RPC returns bounded search hits, fused with the local
  task hits by stable task ID; a semantic-only hit is not discarded by lexical
  BM25 coverage rules. A disconnected, slow or failing ACP preserves fully
  usable local task search with an independent diagnostic.
- Commits search examines metadata for all ancestors of current HEAD, with no
  30-commit window; it does not enumerate unrelated branches. The dedicated
  `git_search_history` command leaves Source Control's 30-item history unchanged.
  History examination and candidate selection run off the UI thread, returning
  a bounded candidate list rather than serializing the whole history to the UI.
  Aborting the search (new query, closed dialog) cancels the backend walk by
  request id and kills its `git log`; each walk also has a 30-second deadline.
  Fast native lexical matching covers subjects, full hashes and authors;
  selecting either a native or hybrid commit hit opens Source Control and
  the workbench Git Diff tab with that exact commit's read-only patch,
  hash, subject, author and date. The transient search dialog closes only
  after a valid commit diff is loaded. A separate ACP source performs
  full-corpus BM25 plus semantic search over commit messages and metadata,
  including non-literal matches. Changed-file paths (up to 256 paths / 32 KiB
  per commit) enter local BM25 and previews, but not embedding inputs or hashes.
  Previously paid vectors remain reusable; durable commit metadata refreshes
  even when the content hash is unchanged. Hybrid results supersede duplicate
  native hits without losing semantic eligibility, regardless of arrival order.
  Search providers do not read diffs or mutate Git. Selection uses a separate
  bounded, read-only native diff lookup; it rejects stale/non-HEAD-reachable
  commit objects and cannot check out or modify the working tree. Root commits
  and merges display their changes, with large patches visibly truncated.
  Navigating to a newer search result, closing the dialog, or switching
  projects invalidates a pending older commit reveal. Tasks-only searches
  never invoke Git, and task embedding requires the global provider configuration. Missing Git or
  malformed task storage reports a source-specific error without hiding other hits.
- Explicit `patch:<literal>` with Commits selected uses a read-only Git
  pickaxe (`git log -G`, with the literal regex-escaped) over HEAD-reachable
  changed lines. The scan is bounded to 50 matches and 8 seconds. Other
  sources/native commit lookup are skipped. Patches are never embedded,
  indexed or uploaded; returned commits open through the existing verified
  read-only diff viewer. A missing ACP connection is reported, not silently
  treated as no matches.
- Commit history count is not capped. Hybrid indexing bounds individual Git fields to
  64 KiB, and semantic document input to 8,192 characters including the saved
  prefix and metadata; unusually large commit messages can therefore be truncated.
- Hybrid commits use the global `~/.config/pi/pi-tools-suite.jsonc` `search.embedding` provider,
  knowledge embedding model, dimensions and prefixes; Desktop never selects or switches
  the provider or alters the code/knowledge index. OpenRouter credentials come only
  from `OPENROUTER_API_KEY`; unrelated legacy configuration and credentials are not read. The selected
  provider may receive commit messages/metadata and search queries. The dialog
  discloses that the first search may index the entire current HEAD history and
  incur provider costs. This uses the same global semantic configuration as repository
  search; history-specific settings remain separate.
  Commit data and vectors live in `.pi/search/git-commits.sqlite`, in the
  `pix_commit_meta`,
  `pix_commit_documents`, and `pix_commit_vectors` tables. They reuse unchanged
  commit hashes, content and compatible vectors across restarts and append new
  commits. Reachability filtering excludes commits no longer on current HEAD.
  Provider/model/dimension/prefix identity fences incompatible vectors; the
  settings and commits vector tables may use distinct dimensions/encodings.
  Legacy databases are not read, imported or migrated. Settings, Sessions and Tasks
  use `settings.sqlite`, `sessions.sqlite` and `tasks.sqlite`. Stop and restart older
  Pi/ACP/Desktop clients before using source-local stores: mixed-version writers
  do not honor the new ownership protocol and are unsupported.
  A changed incompatible embedding identity is never mixed with existing vectors.
  A retained incompatible Settings cache blocks only settings-vector access, not
  writes to the separate Task/Session namespaces. Compatibility errors report that
  an explicit rebuild is required; normal indexing never silently replaces paid
  vectors. Schema-2 Settings reconciliation belongs to Settings writes, not unrelated
  namespace writes; global content-addressed vectors are retained across catalogues.
  The global configuration editor explains recovery: run the suite's user-only
  `/search-semantic reset-history` from the affected project to explicitly discard
  derived project Task/Session/Commit vectors, never the global Settings cache.
  Canonical tasks, sessions and Git history remain intact;
  subsequent semantic searches can rebuild the cache and incur embedding charges.
  Missing config/key/provider retains local BM25 results and durable caches.
  Durable source-local ownership precedes paid batches. The publication fence is
  same-file only; there is no cross-database atomic transaction. The global
  `~/.config/pi/search-provider-work.sqlite` coordinates at most four valid local provider
  leases across projects/processes; after a crash or partition it cannot prove the count of
  remote provider executions. Source/provider leases renew every 30 seconds and expire
  after 90 seconds. A queued source renews its claim and rechecks it after acquiring a slot;
  cancellation retains ownership until tracked transport settles, and lost ownership cannot
  publish. After two failed/interrupted network attempts (initial plus one automatic retry),
  explicit Continue is required; success resets failures, and Continue clears the exhausted
  budget before reconciliation. A short failed-work cooldown applies. Crashes after
  transmission can still duplicate provider billing.
  Contention is bounded; cancellation preserves committed batches and does not
  evict live owners or delete the index. Query/filter edits and closing cancel
  provider work and invalidate late publication. Public user/assistant session
  text and eligible saved titles may be sent for semantic indexing; tool outputs,
  thinking, attachments, task attachments, diffs and file contents are not sent
  by this source. Provider
  failures are opaque and credential-free; native/local hits remain available.
- Settings search uses authored labels, descriptions and synonyms, never
  configured values, credentials or unrelated settings files. A result opens
  its exact section and focuses its stable field ID.
- The inline Settings sidebar and saved-conversation search box reuse the same
  Desktop authored settings catalog, local BM25 normalization/ranking, and
  explicit `pix/search/query` Search retrieval as Universal Search, scoped to
  their respective source only. Typing previews local catalog fields or visible
  saved session titles immediately, including partial-word matches; it does not
  start semantic/provider work. Enter or the compact Search control submits
  the current query to the shared ACP backend. No Auto intent or RAG runs from
  these fields. Settings matches filter the existing mounted field controls
  by section/field identity (unlisted advanced rows retain local filtering);
  session matches are shown only when their stable ID remains in the available
  saved-conversation list, so already open tabs never reappear through search.
  Editing, connection/project changes and unmount cancel requests and ignore
  stale completions; unavailable ACP leaves local previews usable. Independent
  global semantic configuration and provider disclosures still apply.
- Sessions search is local lexical lookup of the current project's session-list
  titles, deduplicated by stable session ID. The existing listing's display
  title (named title or first-message fallback) is used. On explicit session
  queries, the search also incrementally indexes **only** the first user
  message and last completed assistant reply on the active parent-linked
  JSONL branch. Pi SDK `stopReason: "stop"` marks completed assistant
  messages; tool calls (`toolUse`), errors, interruptions, tool results, and
  inactive branches are not treated as final answers. The indexed text is
  bounded to 4,096 / 6,144 characters for first/final respectively. Oversized
  message lines (over 1 MiB) and sessions (over 64 MiB) are skipped.
  A local SQLite FTS5 index in `pix_session_boundary_*` tables in
  `.pi/search/sessions.sqlite` matches first/final excerpts lexically without embedding.
  Public-message chunks have a separate local lexical index and may also be embedded
  as described below. Per-file size/mtime and text-projection-version fingerprints
  skip unchanged JSONL; projection changes refresh existing first/final excerpts.
  Changed, deleted and unmapped sessions are reconciled by background indexing.
  Session queries use cached SQLite titles/snippets and lexical/semantic chunks;
  they perform stat-only freshness checks and do not read whole JSONL transcripts.
  A changed or missing file is excluded until an eligible background index refresh
  updates the cache. Legacy caches lacking indexed-file/range records require
  background backfill; there is no query-time scan fallback. Chunk byte offsets
  and lengths address serialized JSONL message records; text start/end are UTF-16
  positions in sanitized projected text. Cached sanitized snippets suffice for
  results, so query-time range reads are unnecessary. Sessions without a cached
  title are skipped. Queries observe renames/deletions only after indexing.
  Selecting a result opens/activates and hydrates that session, without paging
  to or guessing a particular message. First/final excerpt retrieval remains
  lexical and independent of semantic embedding configuration.
- Explicitly saved session names may also be semantically indexed with the
  shared global provider configuration. Names obtained from `session_info` that are identical to the first
  user message remain local lexical fallback; only authenticated named titles
  are eligible. The session-map entry retains this title provenance so the
  search layer cannot accidentally embed the first-message display fallback.
  This title namespace remains separate from the public-message chunk namespace below;
  unnamed sessions are eligible for message indexing. A valid global provider
  configuration authorizes uploading existing and new public user/assistant text;
  without it, local lexical retrieval remains available.
  Explicit names are synchronized locally to the dedicated
  `pix_session_meta`, `pix_session_titles` and `pix_session_vectors`
  tables inside `.pi/search/sessions.sqlite`. Rename/delete reconciliation removes
  stale title rows and unused vectors; repeated identical names share the same
  content-hashed embedding. A name change cannot use a stale vector belonging
  to the old title. Provider work requires valid global configuration and any
  required credentials, is batched and serialized behind SQLite write ownership,
  and can be canceled on configuration change/removal or project replacement. Background
  indexing can continue after a query, while local lexical hits remain usable
  immediately. The configured knowledge model, dimensions, prefixes and endpoint
  apply; session metadata is separate from settings/commit
  model identity. Incompatible metadata fails closed instead of deleting
  previously paid vectors.
- Session search additionally covers all public user/assistant text on the last
  persisted parent-linked JSONL branch, including short approvals/reversals and
  assistant commentary labelled with its stop reason. It excludes tool bodies,
  thinking blocks, attachments and abandoned branches; it does not classify messages
  with JEV. Native session ID and header cwd must match the discovered source.
  Top-level `pix-html` fences (including the `html-sandbox` alias) are attachments:
  their fence and source are excluded from both roles' public text before chunking,
  embedding, first/final excerpt extraction and RAG evidence budgeting. Prose before
  and after them remains searchable. Backtick/tilde fences and case-insensitive
  language tags follow Desktop fence recognition; an unclosed attachment excludes
  the remaining text. Ordinary code fences, nested Markdown examples and inline
  mentions remain text. Attachment-only messages retain ancestry but produce no
  chunks. Offsets refer to the projected text, not the original message source.
  The canonical JSONL is unchanged. A projection-version change invalidates cached
  chunk revisions even for unchanged files; normal synchronization replaces old
  text rows, and live retrieval never ranks removed source via cached vectors.
  Unchanged prose hashes continue to reuse compatible paid embeddings.
  Corrupt, incomplete, redirected, oversized or cyclic transcripts fail closed.
  For this public-message reader, the file cap remains 64 MiB; the per-record
  text cap is 1,048,576 UTF-16 characters of combined public text, not raw JSONL
  size. Large image/tool/thinking records are fully validated in a cancellable
  worker with a 30-second deadline per large record, retaining ancestry and public text only.
  Ordinary small records parse locally. Invalid JSON, worker failures/timeouts
  and oversized public text reject the session without truncation. These rules
  do not change the separate first/final boundary reader's raw-line cap.
  Missing parent links remain fail-closed; physical file order never repairs them.
  UTF-16-safe chunks are at most 1,600 characters and retain message ID, offsets,
  role, ordinal and content hash. Results remain one per session; the best chunk
  supplies a snippet and message identity for RAG, while navigation opens the session.
  All production session discovery (search, manual and background) admits a
  session only at least **24 hours from creation**. Creation time is the native
  filename timestamp, else a bounded imported-session header timestamp, then
  filesystem birthtime; modification time is never an age fallback. Young entries
  retain only minimal age metadata and are not hydrated for title/body. Saved-title
  and public-message automatic indexing additionally waits for **one hour of
  inactivity per session**, using transcript modification time and persisted
  runtime activity. New activity resets that session's delay; a running agent
  blocks its own session via renewable cross-host leases, not other idle sessions.
  Startup reuses persisted activity without starting a new hour. Metadata-only
  eligibility checks run approximately every 30 seconds. Automatic discovery
  reads file metadata plus bounded 16 KiB identity headers for new/changed files,
  caching unchanged headers instead of calling SDK full-transcript listing.
  Only eligible changed revisions hydrate titles/bodies. ACP reconciles an admitted
  title individually, without rediscovering the corpus or pruning other sessions'
  paid caches. A read-only shared retry-budget preflight pauses automatic discovery
  while Continue is required; encountering that state during a sweep stops the
  remaining candidates. Existing matching cached
  vectors stay searchable; session queries never create document embeddings.
  Background discovery persists a single successful pass-start watermark in
  `pix_session_sweep` in the sessions cache, bound to embedding identity and
  logical cache incarnation/revision; it does not persist a per-file manifest.
  Only a fully successful title-and-chunk pass advances the checkpoint. Failed,
  deferred, cancelled, unreadable or missing-title work cannot certify it. After
  restart, eligible unchanged bodies can be skipped using transcript mtime/ctime,
  activity, mapped title update time and the creation-plus-24-hour deadline, with
  a conservative two-second overlap. Candidate discovery remains complete for
  queries; only indexing work is filtered. Metadata and bounded identity-header
  checks still run. A cache/model mismatch or backwards clock forces a full
  eligible sweep; partial cache writes may invalidate the previous cutoff.
  Manual Index/Continue is a full repair pass and seeds the same watermark only
  on full success. Because the checkpoint is scalar, one pending mature session
  may hold it back; successful unchanged attempts are reused in memory meanwhile.
  Manual Index/Continue bypasses the idle delay only, not the 24-hour creation
  minimum. Mature-file changes use directory events coalesced into dirty paths,
  bootstrap plus bounded five-minute missed-event reconciliation, and maturity
  deadlines that admit sessions even without events. The one-shot CLI fully
  reconciles. Optional ACP snapshot requests can warm the digest from a bounded
  1.5-second session snapshot; ACP reconnect falls back to native metadata.
  Session digests cover mature file revisions and mature mapped title/id aliases.
  Session-index logical revision is trigger-maintained and commit-coupled across
  title, metadata, chunk and vector content tables; work heartbeat, FTS, WAL and
  VACUUM changes do not affect it. Legacy caches remain read-only during status,
  using a bounded metadata fingerprint until a writer installs revision tracking.
  Shared CLI/Desktop receipts use the updated source fingerprint, so old receipts
  require a new manual pass.
  With a valid global provider configuration and credentials, existing and new
  public text is uploaded in batches of 16; unchanged hashes reuse paid vectors.
  Automatic/manual synchronization drains remaining work, checking eligibility
  around provider requests and before publishing automatic results.
  Failures do not create a paid polling loop; explicit Continue retries interrupted work.
  Search indexing diagnostics use Pix's shared JSONL logger in
  `~/.config/pi/logs/`, not a source-local `events.jsonl`. Terminal failures,
  incomplete passes, meaningful vector saves (debug), background-worker failures
  and repeated skipped-transcript causes are recorded with fixed, bounded
  metadata only. No per-session heartbeat/start/empty-success spam, file path,
  transcript ID or text, prompt, provider body or credential is logged.
  Repeated skip/worker causes are coalesced per workspace for five minutes.
  After a worker failure or operationally incomplete index, periodic recovery
  backs off to 2–15 minutes, while fresh changes and explicit Index/Continue
  can trigger earlier work. There is no separate Activity log in the index
  status panel; its inline statuses, error banners and per-source actions remain.
  Standalone Pi without the Pix log sink does not create separate search logs.
  Source leases are shared with Pi/TUI; publication rechecks transcript revision and
  provider authorization. Workspace replacement/disposal aborts owned work.
  Local lexical message search is available without embeddings. There is no
  message-filter setting or relation graph.
  Obsolete `messageFilterEnabled` writes are rejected; legacy config keys are
  ignored. Opening search polls cheap status without discovering transcripts
  or rerunning queries.
- Code/Knowledge use [native lexical-first repository search](native-repository-search.md)
  through the same packaged engine as agent `project_search`, without external indexing
  tools, keys or an active ACP session for lexical search. Native results preserve paths, line ranges and bounded content
  for navigation/reranking/RAG. Requests own cancellation and ignore stale completion;
  concurrent publications use SQLite generation checks. No provider setup occurs.
  A valid `search.embedding` object in `~/.config/pi/pi-tools-suite.jsonc` enables native
  semantic enrichment across all projects and sources, configured in ordinary Pi with
  `/search-semantic configure <embedding JSON>` or in Desktop Tools Suite → Search, with
  the shared suite draft and top Save button. Configure in Settings from Search indices
  opens and focuses the Embedding model field, including after asynchronous config loading. There is
  no independent consent flag or confirmation step. The shared disclosure covers eligible
  semantic inputs and possible costs. Lexical results publish before optional hybrid
  enrichment, with bounded incremental coverage notices. Configuration changes cancel/restart
  search; no active ACP session is needed to read/change the global configuration.
  Native failure reports a source-specific notice without an external backend fallback.
  Successful empty native results remain empty. Failed semantic enrichment retains
  already-published lexical evidence; other local source results survive.
  Legacy search panels, setup/update commands, installers and adapters are absent;
  existing user data is not modified.
- Semantic settings search uses the same global configuration as all other sources.
  Only authored settings metadata and submitted queries enter its embedding input.
  Workspace startup registers `id`, `section`, `label`, `description` and `synonyms`
  through `pix/search/sync`, independently of opening Settings or submitting a search.
  The normalized catalogue fingerprint controls rebuilds: additions, removals and
  semantic field metadata changes reconcile the index, reusing unchanged chunk hashes.
  CSS/layout changes and user configuration values are not embedding inputs and do not
  invalidate the catalogue. A new application build/startup catches catalogue changes;
  no source-code filesystem watcher or rebuild of every field on each search is used.
  Settings and Tasks report separate activity/errors; cancellation and source revision
  checks prevent stale publications after edits, provider changes or teardown.
  Settings/Tasks indexing waits asynchronously for the source-local writer for up to
  90 seconds, remaining active while queued. Cancellation interrupts this
  wait; expiration reports a source-specific busy error without invoking the batch's
  provider work. Other local writes retain the short 600 ms acquisition budget.
  Status polling does not schedule writes or retries. A successful indexing pass clears
  that source's error.
  The provider, knowledge model, dimensions, prefixes and endpoint are configurable;
  responses require matching identity and strict vector validation. Settings offers
  a native global provider editor and an all-project/all-source upload/cost disclosure,
  without source checkboxes or another confirmation. OpenRouter credentials resolve
  from `OPENROUTER_API_KEY`, then static Pi SDK auth storage; Ollama needs no
  OpenRouter key. Invalid/missing configuration, required credentials or provider
  failure leaves local lexical lookup usable.
- Pi and native Desktop config saves share a bounded configuration-file directory
  lock, preserve unknown fields, compare original contents before atomic publication,
  and reject unsafe/oversized files. Desktop revisions identify the full content,
  including manual edits. Lock leftovers fail closed; active owners are not evicted
  by age. ACP rejects obsolete per-source preference writes.
- Search uses five project-local source databases under `.pi/search/`:
  `sessions.sqlite`, `tasks.sqlite`, `git-commits.sqlite`, `code.sqlite` and
  `knowledge.sqlite`; shared Settings uses `~/.config/pi/search/settings.sqlite`.
  Settings owns schema-2 `metadata`, `documents` and `vectors`;
  history sources own their respective `pix_<domain>_*` tables. Native chunks,
  lexical indexes and compatible paid vectors coexist in each native source store.
  Short token-leased publications never hold a database writer lock over provider
  HTTP; see [decision 0070](../decisions/0070-search-source-work-recovery.md).
  Session title vectors use `pix_session_*`, while text-only first/final excerpts
  use `pix_session_boundary_*` FTS5 tables in `sessions.sqlite`. Public-message
  chunks, transcript revisions and provider-namespaced vectors use the shared
  `pix_session_chunks`, `pix_session_chunk_fts`, `pix_session_chunk_meta` and
  `pix_session_chunk_vectors` tables. Searches validate fresh live-branch chunks;
  retained vectors alone never authorize a stale session result.
  Legacy stores are not generally read, imported, migrated or repaired. The sole
  exception is compatible schema-2 project-local Settings vectors: an owned write
  may import them transactionally after validating configured identity. Read-only
  legacy files are never changed/deleted; incompatible identity/schema is skipped,
  while corrupt compatible data rejects the transaction atomically. Schema-1
  Settings caches remain incompatible; explicit recovery is separate from normal
  indexing. Settings vectors persist by content hash across catalogue versions;
  each query filters results against the caller's authored catalogue. Read-only
  status/configuration polling never writes or repairs stores.
  Obsolete running clients must be restarted separately; restart is not forced
  while a live draft is present. Source-local indexes do not modify canonical
  task storage, session files or Git history.
- Settings hashes/vectors and model metadata survive restarts and reuse unchanged
  content. SQLite/in-process writer queues acquire ownership before paid settings
  batches, use bounded contention waits and do not reset/unlink the database.
  The canonical search/ tree, its WAL/SHM sidecars, and any retained legacy
  databases or local backup files in that tree survive manual Clean and
  background TTL; no cleanup action may delete or reset the canonical database.

## Constraints and failure cases

- The Desktop search interface and RAG are Desktop-only. Session message indexing
  is shared with Pi/TUI `project_search`, scoped to the current project. Public text
  and its configured embeddings may persist in the source-local search store.
  Embedding configuration and credentials are shared with ordinary Pi across projects.
- Sources fail independently. Disconnected ACP retains authored settings lookup;
  missing/busy repository search does not suppress settings/session results. Request failures
  never imply a disconnected backend. Unexpected exceptions stay opaque; known
  source failures are credential-free. Aborts publish no failure notices.
- Initial source waiting is bounded to 20 seconds, including overview waiting
  and the shared repository request. Completed sources publish immediately,
  including lexical repository results before optional semantic enrichment. Slow sources keep working and may
  append/rerank results in the same open, current submission; a pending notice
  replaces endless blocking and is removed when that source completes. Authored
  settings fallback is available while its backend is pending and is replaced by
  the completed response. Failed sources retain their own warnings without
  hiding other results. Successful empty searches show `No results.` only when
  no sources remain pending; warnings/errors and still-pending empty searches
  are distinguished. Published snapshots are immutable. Query/filter edits,
  resubmission, workspace/client replacement or closing invalidate all old updates.
  Closing retains partial hits but removes pending indicators; reopening requires
  explicit resubmission to search again, never silently resumes cancelled sources.
  Commit indexing RPC has no ordinary 30-second client timeout; query/dialog
  lifecycle cancellation owns its transport. UI deadlines do not cancel source work, release serialization ownership, or
  kill/delete active native index work. Native/provider operational limits remain
  independent of this initial-wait limit.
- Title discovery has a cancellable 15-second deadline and is serialized to avoid
  concurrent session-map mutation. Mixed semantic requests revalidate titles after
  asynchronous provider work, including provider failure or revocation; rediscovery
  failures cross ACP as controlled reasons rather than publishing stale titles.
  Merging a captured native listing validates file presence under the map lock and
  preserves a more recent mapped rename; completed deletions cannot be resurrected
  by that listing. Missing session files are excluded from title hits.
- Workspace/client replacement, cancellation, revocation and disposal invalidate
  stale work. Dialog requests/listeners/timers are released on teardown; stale
  navigation cannot close a later dialog. Session activation checks workspace,
  connection and active session after asynchronous boundaries.
- File hits accept only safe project-relative formatter headers and ranges;
  opening validates that the file still exists.
- Deterministic tests need no paid requests. These reversible search extensions
  do not introduce a new durable decision. Existing stable session/message
  identity rationale: [0018 — Desktop message action identity](../decisions/0018-desktop-message-action-identity.md).
  Cleanup scope: [Registry project state](../work-management/registry/resource-registry-project-state.md).

## Implementation

- `acp/src/search/contract.ts`
- `acp/src/search/commit-contract.ts`
- `acp/src/search/commit-corpus.ts`
- `acp/src/search/commit-provider.ts`
- `acp/src/search/commit-service.ts`
- `acp/src/search/commit-worker.ts`
- `acp/src/search/bounded.ts`
- `acp/src/search/config.ts`
- `acp/src/search/documents.ts`
- `acp/src/search/session-titles.ts`
- `acp/src/search/intent.ts`
- `acp/src/search/rag-contract.ts`
- `acp/src/search/rag-request.ts`
- `acp/src/search/rag-evidence.ts`
- `acp/src/search/rag-service.ts`
- `acp/src/search/rag-citations.ts`
- `acp/src/search/session-chunk-service.ts`
- `acp/src/search/session-transcript.js`
- `acp/src/search/session-chunks.js`
- `acp/src/search/session-chunk-sync.js`
- `external/pi-tools-suite/src/project-search/session-transcript.mjs`
- `external/pi-tools-suite/src/project-search/session-chunks.mjs`
- `external/pi-tools-suite/src/project-search/session-chunk-sync.mjs`
- `acp/src/acp/openrouter-jev.ts`
- `acp/src/search/session-boundary-reader.ts`
- `acp/src/search/session-boundary-index.ts`
- `acp/src/search/session-boundary-service.ts`
- `acp/src/search/session-boundary-paths.ts`
- `acp/src/search/embeddings.ts`
- `acp/src/search/index-store.ts`
- `acp/src/search/source-work.js`
- `external/pi-tools-suite/src/project-search/source-work.mjs`
- `acp/src/search/request.ts`
- `acp/src/search/service.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/session-map.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/universal-search.ts`
- `desktop/src/lib/search-intent-controller.ts`
- `desktop/src/lib/search-rag.ts`
- `desktop/src/lib/search-source-deadline.ts`
- `desktop/src/lib/search-relevance.ts`
- `desktop/src/lib/search-query.ts`
- `desktop/src/lib/search-bm25.ts`
- `desktop/src/lib/project-search.ts`
- `desktop/src/lib/project-tasks.ts`
- `desktop/src/lib/git-workflow.ts`
- `desktop/src/app/project-tasks.svelte.ts`
- `desktop/src/components/WorkspaceSidebarTasksPanel.svelte`
- `desktop/src-tauri/src/git_operations.rs`
- `desktop/src/lib/search-dialog-memory.ts`
- `desktop/src/lib/search-dialog-controller.ts`
- `desktop/src/lib/search-voice-controller.ts`
- `desktop/src/lib/deepgram.ts`
- `desktop/src/lib/settings-search-catalog.ts`
- `desktop/src/app/search-navigation.ts`
- `desktop/src/components/UniversalSearch.svelte`
- `desktop/src/components/NativeRepositorySemanticConsent.svelte`
- `desktop/src-tauri/src/native_repository_semantic_config.rs`
- `desktop/src/components/DesktopTitlebar.svelte`
- `desktop/src/components/DesktopSidebar.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/settings/SettingsFieldRow.svelte`
- `desktop/src/components/settings/SettingsSearchPreferences.svelte`
- `desktop/src/components/settings/SettingsConfigEditor.svelte`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`

## Tests

- `tests/pix-desktop-search-schema.test.ts`
- `acp/test/search.test.ts`
- `acp/test/search-intent.test.ts`
- `acp/test/search-rag.test.ts`
- `acp/test/session-chunks.test.ts`
- `acp/test/session-attachments.test.ts`
- `acp/test/commit-search.test.ts`
- `acp/test/search-preferences.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/session-map.test.ts`
- `acp/test/pix-rpc-entry.test.ts`
- `desktop/src/lib/universal-search.test.ts`
- `desktop/src/lib/search-intent-controller.test.ts`
- `desktop/src/lib/search-rag.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/search-source-deadline.test.ts`
- `desktop/src/lib/search-relevance.test.ts`
- `desktop/src/lib/search-query.test.ts`
- `desktop/src/lib/search-bm25.test.ts`
- `desktop/src/lib/project-search.test.ts`
- `desktop/src/lib/search-dialog-memory.test.ts`
- `desktop/src/lib/search-dialog-controller.test.ts`
- `desktop/src/lib/search-voice-controller.test.ts`
- `desktop/src/lib/deepgram.test.ts`
- `desktop/src/app/search-navigation.test.ts`
- `desktop/src/components/UniversalSearch.test.ts`
- `desktop/src/components/WorkspaceSidebar.test.ts`
- `desktop/src/lib/settings-search-catalog.test.ts`
- `desktop/src/components/DesktopModalDialogs.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

Run Desktop typecheck and focused search/queue/navigation/settings/modal tests,
ACP typecheck/build/search/agent tests and schema generation/tests. Cover title
boost, Robertson IDF, saturation, length normalization, explicit hybrid mode in
both native domains, bounded/redacted source-failure notices, and native request cancellation.
Also cover title deduplication/scope/renames/deletions, authenticated public-text
projection and exclusion of private/tool/attachment content, cache-only session
document vectors on queries (query embedding remains permitted), obsolete-schema
rejection without mutation, source-local vector preservation,
restart/hash reuse, contention, cancellation, revocation and stale completion.
Real macOS QA checks explicit submit, Sessions labels, settings/file/session
activation and native-search failure isolation, task reveal, commit metadata, and close/reopen
retention. Cover completed versus interrupted retention, scope/client changes,
source isolation, task deletion, and stale task-navigation completions.
Deterministic checks do not claim live UI QA.
Full-message BM25 matches survive frontend ranking when the visible metadata
snippet contains no query terms; native and hybrid hits share one commit-hash ID.
 Commit-index directories, database and SQLite sidecars reject symlink redirects
 before opening the database or embedding; local BM25 remains usable.
 RAG regression tests cover source reference validation and navigation identity,
 strict source file containment, excluded symlinks, untrusted retrieval excerpts,
 user-profile model/effort selection, no-evidence model skipping, incremental ACP
 notifications, late-update isolation, and cancelled/failed model streams.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"f061c4de-d66a-4d75-9c7e-aef1d8e78d55","contentHash":"d9e2fc0a7d31755bc20273478cb29531d851807d15714c0be7aabe84fa1f3812","checkedAt":"2026-10-31T01:53:41.421Z","maxDocumentChars":128000} -->
