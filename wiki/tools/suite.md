<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-30T23:13:00.954Z","result":{"path":"wiki/tools/suite.md","documentHash":"a9a480da12b9d201875ae8423bb0d6b57327812ba5c91e541d47eef1a119b995","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":21,"chunkCoverage":{"totalChunks":2,"checkedChunks":2,"totalComparisons":3,"checkedComparisons":3},"status":"conflicts","conflicts":[{"draft":{"path":"wiki/tools/suite.md","quote":"No independent consent flag or confirmation step is used.","startLine":123,"endLine":123},"existing":{"path":"wiki/search/repo-knowledge-agent-workflow.md","quote":"External repository embeddings retain independent\n  consent and saved-provider safeguards.","startLine":44,"endLine":45},"explanation":"Черновик явно отрицает существование отдельного флага согласия или шага подтверждения для семантического поиска: сам глобальный объект `search.embedding` авторизует отправку для всех источников/проектов. Source-6 утверждает, что внешние эмбеддинги репозитория сохраняют независимое согласие и safeguard'ы сохранённого провайдера. Это взаимоисключающие нормативные утверждения о наличии/отсутствии независимого consent-механизма для одной и той же функции эмбеддингов репозитория."},{"draft":{"path":"wiki/tools/suite.md","quote":"Each spawn updates `.pi/subagents/registry.json` with the latest run and `agentId -\u003e runDir` mappings.","startLine":1184,"endLine":1184},"existing":{"path":"wiki/tools/agents/async-subagents.md","quote":"there are no regular-agent sidecars or `registry.json`. A batch is an identity label, not a directory. Legacy run directories are ignored and are not migrated.","startLine":296,"endLine":296},"explanation":"Черновик утверждает, что каждый spawn обновляет файл `.pi/subagents/registry.json` с сопоставлением agentId -\u003e runDir, и что `subagents` может разрешать запуски по этому реестру. Спецификация async-subagents прямо заявляет, что файлов `registry.json` и sidecar'ов не существует, а legacy-каталоги запусков игнорируются и не мигрируют. Это два несовместимых описания одного и того же механизма хранения состояния запусков в одних и тех же условиях."},{"draft":{"path":"wiki/tools/suite.md","quote":"Every sub-agent is a full persisted Pi session under its agent's `sessions/` directory; there is no opt-out.","startLine":1162,"endLine":1162},"existing":{"path":"wiki/tools/agents/async-subagents.md","quote":"every child is a full Pi session stored at `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchildSessionId\u003e.jsonl`","startLine":296,"endLine":296},"explanation":"Черновик помещает персистентную сессию дочернего агента в каталог `sessions/` внутри каталога запуска агента; спецификация определяет единственное место хранения как `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchildSessionId\u003e.jsonl` без каталогов `sessions/`. Для одного и того же механизма персистентности сессий предложены взаимоисключающие схемы хранения."}],"uncertainties":[],"reviewedSources":[{"path":"wiki/tools/index.md","quote":"# Bundled tools and extension surface\n\nThe suite guide describes installed tools and configuration. API contracts, execution and native host behavior are kept alongside it.\n\n[Wiki home](../index.md)\n\n## Topics\n\n- [Sub-agents](agents/index.md) — Role selection, lifecycle, model pools and project-local roles. Read current contracts before relying on older delegation decisions.\n\n## Pages\n\n- [Background shell jobs](background-shell.md) — active\n- [Headless Tool API](headless-tool-api.md)\n- [Native Pi TUI presentation for pi-tools-suite](native-pi-tools-suite-ui.md)\n- [Fault-tolerant pi-tools-suite module loading](pi-tools-suite-module-loading.md) — active\n- [Claude provider search tool policy](provider-web-search-policy.md) — active\n- [Suite codemode](suite-codemode.md) — active\n- [pi-tools-suite](suite.md)\n- [Tavily fallback for web tools](web-search-tavily-fallback.md)\n","startLine":1,"endLine":20},{"path":"wiki/context/dcp-reliability-mechanisms.md","quote":"  index.ts:344,444]`\n- Pressure that cannot act is reported as a `progress-blocked` diagnostic with\n  an inferred reason (`inferDcpBlockedReason`) rather than looping as a no-op.\n  `[confirmed by code, index.ts:235,713-722]`\n- Locked by `test/dcp-journal.test.ts`, `test/dcp-journal-lifecycle.test.ts`,\n  `test/dcp-progress-opportunities.test.ts`. `[confirmed by tests]`\n\n## Budgeted auto-compression\n\n`src/dcp/auto-compress-budget.ts`\n\n- A retry `context_edit` must not turn the SDK's raw-history fallback estimate\n  into a false provider-native capacity floor. Canonical full-branch provenance\n  plus exact SDK scalar agreement authorizes rebasing to the actual DCP\n  projection, including resolved system/tool overhead; unknown or genuine native\n  floors remain conservative. The resolver is per context pass, not persisted\n  diagnostic/recovery authority, and uses the existing full-reader owner guard.\n  See [pressure policy](dcp.md#pressure-and-autonomous-policy),\n  `src/dcp/context-usage.ts`, `test/dcp-context-usage.test.ts`, and repository-root\n  `tests/dcp-usage-fallback.integration.test.ts`.\n\n- `createBudgetedAutoCompressionBlock` never treats a source-size estimate as\n  a net-savings estimate: it tries the economical prefix first, then the\n  largest prefix that passed the **same** retention and provider-evidence\n  policy; both attempts share one whole-operation deadline (operation timeout\n  plus a 1 s finalization grace). A model summarizer may consume at most 75% of\n  the configured operation timeout so deterministic extractive fallback and\n  publication retain bounded headroom; protection/evidence are never relaxed\n  and insufficient gain is never reported as success. `[confirmed by code,\n  auto-compress-budget.ts]`\n- Rejected attempts are memoized per state + **exact candidate source** key\n  (epoch + exact `sourceMembers` for the economical and largest-safe ranges),\n  not by the whole growing provider tail. Appending unrelated tool/user traffic\n  therefore does not repeatedly prepare the same byte-identical rejected range;\n  when exact membership is unavailable the memoizer falls back conservatively\n  to the full-context identity. `[confirmed by code, auto-compress-budget.ts;\n  confirmed by test/dcp-auto-compression-projection.test.ts]`\n- Deterministic extractive fallback is not rejected merely because its\n  continuation record exceeds 8192 tokens. Large sources may require a larger\n  lossless continuity floor; the shared exact replacement/full-projection gain\n  checks decide whether it is economical, and non-positive/insufficient plans\n  remain rejected. `[confirmed by code, auto-compress.ts; confirmed by\n  test/auto-compress.test.ts]`\n- Once a configured model summarizer actually fails/unavailable and DCP reaches\n  deterministic extraction, later automatic attempts in that live session skip\n  model summarizers; a successful deterministic fallback commit also establishes\n  that degraded mode. A later gain/economics rejection after a **successful**\n  model summary does not degrade the summarizer merely because the selected\n  range was too expensive to replace. This prevents repeated model timeouts\n  without turning `non-positive-gain` into a false session-wide model failure.\n  `[confirmed by code, dcp/index.ts, auto-compress.ts; confirmed by\n  test/auto-compress.test.ts and test/compress-pruner.test.ts]`\n- At capacity, a failed exact auto-compression attempt falls through to the\n  bounded emergency current-turn pruning floor before abort/handoff. DCP aborts\n  only when the projected context still cannot fit after eligible recovery and\n  emits a user-visible `progress-blocked` diagnostic first. `[confirmed by code,\n  dcp/index.ts; confirmed by test/compress-pruner.test.ts]`\n- A successful **partial** auto-compression commit follows the same capacity\n  rule: if its exact provider projection is still above input capacity, DCP\n  continues through same-pass emergency recovery and otherwise aborts instead of\n  treating positive gain as permission to send an oversized request. `[confirmed\n  by code, dcp/index.ts; covered by deterministic session-simulation provider\n  capacity assertions]`\n- Cumulative `compressionProgress.remainingTokens` is progress accounting, not\n  an unbounded sizing target for the next automatic rewrite. Candidate sizing\n  and `requiredGainTokens` are capped by the current budget requirement; under\n  active progress/capacity pressure raw-tail range candidates exclude existing\n","startLine":59,"endLine":125},{"path":"wiki/tui/guide.md","quote":"- `/export` / `/import` — move sessions through HTML/JSONL;\n- `/share` — publish a secret GitHub gist;\n- `/compact` — manually summarize older context;\n- `/delete` — permanently delete a session after confirmation.\n\n`maxProjectSessions` controls automatic per-project session retention; `0`\nkeeps sessions indefinitely.\n\n## Bundled pi-tools-suite\n\nPix links the bundled suite into the active Pi agent directory when safe. An\nexisting non-symlink installation is preserved.\n\nMajor capabilities include:\n\n| Area | Modules / behavior |\n| --- | --- |\n| Parallel work | `async-subagents`, presets, fallback routing, `/ultrawork`, `/hyperplan` |\n| Repository search | Native Code/Knowledge retrieval via `project_search` |\n| Structural edits | `ast-grep` |\n| Feedback | LSP diagnostics and comment checks |\n| Planning | hierarchical durable todos |\n| Context | DCP compression/pruning |\n| Web | local/cloud web-search integrations |\n| Providers | usage, Antigravity auth, OpenCode credential import |\n| Reusable resources | prompt commands, Git-backed Registry, session naming |\n| Recovery | bounded session overview/search/section tools |\n| Payload hygiene | truncation normalization and opt-in credential firewall |\n\nOptional modules activate only when their host requirements are available.\nBroken module imports/factories are skipped with a startup warning instead of\nremoving the whole suite. This does not certify unfinished feature behavior or\nundo arbitrary initialization side effects; see\n[module loading](../tools/pi-tools-suite-module-loading.md).\n\nAdaptive plans keep dependencies, blockers, ownership and the active step\nvisible:\n\n![Pix adaptive todo plan with hierarchy and blockers](../assets/screenshots/pix-adaptive-todo.png)\n\nParallel sub-agents report live status without taking over the main session:\n\n![Pix running parallel sub-agents alongside the main implementation plan](../assets/screenshots/pix-subagents.png)\n\nUseful suite commands include `/todos`, `/sub-status`, `/sub-stop`,\n`/ultrawork`, `/hyperplan`, `/usage`, `/dcp`, `/opencode-import`, and\n`/antigravity-add-account`.\nThe Git-backed resource Registry is available only in Pix Desktop.\n\n## Command map\n\n| Area | Commands |\n| --- | --- |\n","startLine":98,"endLine":150},{"path":"wiki/overview.md","quote":"- **Bring repository-scale tools.** The bundled `pi-tools-suite` adds indexed\n  discovery, AST tools, LSP diagnostics, parallel agents, durable planning,\n  context compression, registry workflows and more.\n\nPix is not a separate agent protocol replacing Pi. It runs on the Pi SDK, so Pi\nmodels, tools, skills, extensions and sessions remain part of the same\necosystem.\n\n## Pix Desktop\n\nPix Desktop turns the same Pi/Pix runtime into an IDE-like native workbench.\n\nAssistant messages can include `pix-html` blocks that automatically\npreview self-contained HTML/JavaScript prototypes or Canvas games in a\nsandboxed iframe. Native form Submit and `window.pix.submit(json)` return\ndata to the current ACP conversation without overwriting your draft.\nThe iframe auto-fits the game's content up to a bounded height, uses the\nnative Pix scrollbar styling, and gives the agent the available inline width\nwhen you request an interactive prototype.\nSee [HTML Sandbox](desktop/rendering/desktop-html-sandbox.md) for the syntax and limits.\n\n**Platform support:** Pix Desktop currently supports **macOS on Apple Silicon\nonly**. Windows and Linux Desktop packages are not currently published or\nplatform-validated in CI. The Pix TUI remains supported on the release targets\nlisted below.\n\nThe Activity Bar provides:\n\n- **Tasks** — full interactive Desktop manager over project-local\n  `.pi/tasks.sqlite` (Quick Add, edit, priority/status, drag-and-drop,\n  attachments and linked sessions); `/task` slash commands and restricted\n  `project_tasks` agent tool provide additional access;\n- **Project** — keyboard-friendly file tree, Preview and external-editor actions;\n- **Wiki** — project pages, nested sections and assets in `wiki/`, with visual\n  Markdown editing; configure `wiki.path` and `wiki.index` in\n  `.pi/workspace.jsonc` (see [Project Wiki](desktop/workbench/desktop-project-wiki.md));\n- **Source Control** — initialize Git, stage/unstage, diff, review, commit,\n  publish/push and safe repository tools;\n- **Registry** — initialize `.pi`, configure private Git-backed resources and\n  synchronize project tasks, plans and workspace state;\n- **Package Scripts** — package-manager scripts and interactive terminals;\n- **Search indexes** — inspect local stores and edit shared global semantic-search configuration;\n- **Settings** — Desktop-specific models, voice, editor and Git preferences.\n\nDesktop production releases use the signed native Tauri updater.\n\nConfiguration is intentionally separate from the TUI:\n\n```text\n~/.config/pi/pix-desktop.jsonc\n\u003cworkspace\u003e/.pi/pix-desktop.jsonc\n```\n\nSee **[Pix Desktop](desktop/guide.md)** for installation, first-run behavior,\nworkspace details and troubleshooting.\n\n## Pix TUI\n\nPix TUI keeps coding-agent work dense without turning the terminal into a raw\n","startLine":73,"endLine":131},{"path":"wiki/search/native-repository-search.md","quote":"- Every Pi caller, including async/provider/council children, receives the same\n  unrestricted `project_search` schema and execution across sessions, tasks,\n  commits, code and knowledge, including `patch:`. Children suppress suite setup\n  commands and parent orchestration guidance only. Repository semantic embeddings\n  use the same explicitly configured global provider. Removed `repo_*` tools are not\n  part of ordinary search.\n\n## Optional reranking\n\n- The canonical global suite JSONC accepts optional `search.rerankerModel`, an OpenRouter\n  reranker model ID (for example `voyageai/rerank-3-lite`). Empty/omitted or invalid values\n  disable it. Project overrides, an API key alone, and legacy config do not enable it.\n  Desktop's **Reranker model** field edits this same global draft and uses its normal Save;\n  clearing the field removes the key. New default configs document it without enabling uploads.\n- Saving a nonempty model authorizes sending the query and bounded eligible Code/Knowledge\n  text plus Sessions/Tasks/Commits titles and snippets across projects in Pi/TUI/ACP/Desktop. Charges may\n  apply. Credentials use `OPENROUTER_API_KEY`, then shared Pi auth. This permission is\n  independent of `search.embedding`: hybrid/semantic queries can rerank local candidates\n  without embeddings. Removing embeddings does not disable a separately configured reranker.\n  Settings are excluded from remote reranking.\n- Pure lexical agent/native queries and document indexing never invoke reranking.\n  Desktop publishes local results first, then optionally reranks the merged selected\n  Sessions/Tasks/Commits/Code/Knowledge results after all source operations complete,\n  including late source replies. Embedding configuration is not required for this pass.\n  `project_search` hybrid/semantic queries likewise use one shared pass before final limits.\n  Up to 100 source-balanced candidates are sent once to\n  `https://openrouter.ai/api/v1/rerank`. History uploads contain only titles (512 characters)\n  and snippets (4096), never full sessions or diffs; native candidate content is capped\n  at 7500 characters. Provider documents remain capped at 8192 UTF-8 bytes each, while\n  the query plus all documents share a 32,000-byte UTF-8 budget. Native documents use\n  query-focused excerpts and avoid duplicate path/title headers. Each candidate shares\n  the remaining batch budget equally; truncated prefixes never split UTF-8 code points.\n  Code and prose with explicit identifiers, numeric anchors or acronyms retain contiguous\n  windows. Other prose uses extractive passages covering the whole question, or representative\n  sentences when there is no literal overlap. Selected sentences retain source order and\n  mark omissions with an ellipsis; this is not an answer-generation step.\n  Knowledge documents may include an explicit leading `Document status:` label from the\n  same hash-verified file used by freshness preflight. Only recognized leading `Status:`\n  metadata is used (first 32 lines, before a level-two-or-deeper heading, excluding fenced\n  examples); paths and incidental prose never imply status. The label shares the existing\n  byte budget, does not filter archived documents and adds no index schema or separate scan.\n  In-flight file changes still reject the ranking. Federated history that\n  cannot be verified during preflight stays in local results but is excluded from the\n  remote pool; verifiable candidates may still rerank with a partial notice. Revocation,\n  cancellation or stale sent-pool validation falls back to local order.\n  Candidate filters, deduplication and source policy apply before upload; native per-domain\n  caps and the requested final result limit apply after reranking. Returned relevance order\n  is preserved rather than re-sorted by local BM25. Desktop Settings retain their local slots.\n  Standalone native requests retain their Code/Knowledge pass; federated callers set\n  `skipRerank` and carry native freshness context to avoid double provider calls. Content upload does not\n  depend on `includeContent`; that flag controls only the returned payload.\n- Reranking has a four-second verification/slot/transport budget, bounded response size, no redirected\n  provider requests and strict index/score validation. Missing credentials, timeout,\n  provider errors and malformed responses retain original ranking with a redacted notice.\n  Global provider concurrency slots span transport lifetime. Source policy, configured\n  model, history source snapshots, native generation and current candidate bytes are checked around network work;\n  stale snapshots are not reranked, changed context rejects late ranking, caller cancellation\n  rejects the search. Periodic configuration/policy/generation checks cancel in-flight work;\n  no native SQLite handle is retained across reranker transport. History snapshots are\n  captured before retrieval and rechecked before upload and after transport. Desktop bounds\n  preparation to four seconds and the final request to 4.5 seconds, discarding late replies\n  even when an adapter ignores cancellation. CLI/Tauri `rerank` input is capped at 4 MiB\n  for bounded Unicode documents; other operations retain their 16 KiB input cap.\n\n## Optional semantic retrieval\n\n","startLine":105,"endLine":170},{"path":"wiki/search/repo-knowledge-agent-workflow.md","quote":"maintenance, without treating generated answers as semantic proof.\n\n## Scope\n\n- Repo-aware tool descriptions, prompt guidance, schemas and search options.\n- General coding discovery, document/contract retrieval, and task-scoped audit.\n- Documentation and deterministic prompt/adapter tests.\n\n## Behavior\n\n- `repo_context`, `repo_inspect`, `repo_audit`, and `repo_search` are removed.\n  Code and Knowledge use native `project_search` across Pi/TUI/ACP/Desktop;\n  there is no external-backend fallback, setup/update command, panel, provider migration or\n  repository-search gate. See [Project-wide agent search](project-search-agent-tool.md).\n- Native lexical retrieval needs no embedding credentials. Opt-in repository and\n  commit embeddings use the project `.pi/search/semantic.json` `embedding` object\n  and `OPENROUTER_API_KEY`; chunks/queries may be transmitted externally.\n- The primary bundled extension exposes `project_search` with its full schema to\n  ordinary Pi, ACP, and every async child/provider child/council. Every caller has\n  the same sources (`sessions`, `tasks`, `commits`, `code`, `knowledge`), options,\n  and `patch:\u003cliteral\u003e` behavior; there is no child restriction or reduced facade.\n  Children still omit suite setup commands and parent orchestration/delegation\n  guidance, and retain their normal work-tool restrictions. `project_search` does\n  not initialize or update external search services. External repository embeddings retain independent\n  consent and saved-provider safeguards. See [decision 0060](../decisions/0060-subagent-read-only-repo-tools.md)\n  and [project search](project-search-agent-tool.md).\n- `project_search` is the single project retrieval tool. It defaults to all five\n  sources for every caller; choose sources explicitly to narrow scope. Code and\n  Knowledge use native search; unsupported legacy filters are removed from the\n  schema. See its spec for supported options and privacy details. Markdown\n  documents are searched subject to ignore/exclusion filters. Explicit frontmatter\n  kind/status takes precedence; inferred purpose is advisory.\n- Preserve visible warnings, truncation and continuation hints. Empty or degraded\n  retrieval does not establish the absence of a contract. Read authoritative\n  primary documents and relevant code/tests rather than trusting summaries or\n  rankings as semantic proof.\n- Start compact. Use `project_search` to locate relevant contracts, code and tests,\n  initially with at most 3 results and no inline content. For maps, inventories,\n  symbols or dependencies, use available file/path and structural tools as useful;\n  `project_search` is retrieval, not an architecture/dependency graph. Read exact\n  returned ranges directly; only\n  expand for a named gap. Exact identifier/text lookup uses available `Grep`/`grep`,\n  otherwise shell `rg`; path-only discovery uses available `Glob`/`find`, otherwise\n  shell `rg --files`. Read known paths directly; never require an unavailable tool.\n  These text-only fallbacks do not weaken AST-first routing for structural queries.\n- Being new to a repository alone does not request an architecture map: a\n  reading guide for a behavior starts with `project_search` and direct reads.\n  Before creating a spec or making a material behavior change, use\n  `project_search` to locate the contract and evidence, then read primary sources.\n  Keep the governing\n  document's behavior/scenarios/constraints/interfaces aligned in\n  the same task; create a focused spec only if needed. New specs use the\n  project's spec template (`specs/TEMPLATE.md` when present), with\n  `kind: spec` and intended `status`, and\n  project-root-relative paths in Implementation/Tests sections. If the template\n  is absent, ask before creating one rather than inventing a convention.\n  Existing useful documents do not need reformatting.\n- Before completing an implementation task, the parent runs the available\n  `knowledge-auditor` with the final behavior/result and exact task-changed\n  project-relative paths. Obtain the result and resolve concrete documentation\n  questions; the parent retains product and architecture decisions.\n- The docs-only specialist updates affected specs/README material using the final\n  implementation and tests as evidence. It fixes small, unambiguous drift and\n  returns substantial or ambiguous discrepancies to the parent. Accurate\n  documentation needs no edit. If the role is unavailable, the parent maintains\n  affected documentation directly.\n- Documentation maintenance does not require search setup. The bundled\n  role has no indexed-project visibility gate. Search and direct reads are\n  sufficient; retrieval results are not evidence of semantic correctness.\n","startLine":21,"endLine":89},{"path":"wiki/configuration/guide.md","quote":"without changing configuration or other sessions. An explicit saved choice takes\nprecedence over the enable default; all other observer settings still use the\nprofile. A trusted project `.pi/pix-desktop.jsonc` can override defaults.\nDesktop does not inherit `heads-up.jsonc`; that remains the TUI observer config.\nEnabling an observer sends bounded conversation excerpts to its chosen provider.\n\n## pi-tools-suite configuration\n\nThe bundled suite loads:\n\n1. `~/.config/pi/pi-tools-suite.jsonc`;\n2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;\n3. the nearest project `.pi/pi-tools-suite.jsonc`.\n\nLater files override earlier files.\n\nDisable individual modules with `disabledModules` or\n`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with\n`PI_TOOLS_SUITE_DISABLED=1`.\n\nTo hide selected bundled async-subagent roles without disabling the sub-agent\nmodule, use `disabledBuiltinAgents`. A later config layer can re-enable inherited\nnames with `enabledBuiltinAgents`. These keys affect bundled roles only;\nsame-named project roles in `.pi/agents/*.md` remain available.\nDesktop exposes the user-level `disabledBuiltinAgents` list under\n**Settings → Tools Suite → General → Built-in agents**.\nThe same General section exposes built-in suite modules as an enabled/disabled\nchecklist instead of raw `enabledModules` / `disabledModules` / `modules` JSON.\n\nDCP is intentionally narrower than the general suite layering above: its\n`dcp` section is read only from the user-level\n`~/.config/pi/pi-tools-suite.jsonc`. Protected tool continuity is bounded by\n`dcp.compress.maxProtectedToolContinuityBytes` (default `16384`). The budget\napplies to shaped tool receipts/digests in one compression block; exact\nprotected fragments are never silently truncated to satisfy it. Receipts show\nraw output size only; content hashes stay in fragment metadata and are not\nsent to the model.\n\nThe model setup wizards write the same suite model keys: TUI `pix install\n--models` and Desktop's model setup dialog both set `frontierModels` (the Strong\nmodel is the primary; extra frontier models have no role default; an untouched\nlist keeps existing entries with their flags and aliases),\n`builtinAgentModels`, the DCP summarizer pair and the vision `lookupModel` /\n`lookupFallbackModels` pair (optional, written only when set or cleared) and,\non explicit request, `search.embedding` / `search.rerankerModel` in the\nuser-level suite config (enabling embeddings sends project code and knowledge\ntext to the chosen provider).\n\n## Model providers\n\n","startLine":375,"endLine":424},{"path":"wiki/operations/lsp-runtime-control.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Project-shared LSP runtime and Desktop/TUI monitoring\n\n## Behavior\n\nLSP remains lazy: successful matching file mutations can start a configured\nserver and append diagnostics. Opening a panel or requesting status does not\nstart servers, prompt for trust, create a session, or send an LLM/user message.\n\nDesktop's LSP sidebar uses the active conversation as a connection to the shared\nproject runtime. Independent connected Desktop tabs and TUI Pi processes in the same\nproject reuse one manager and one server per configured server ID/root, rather\nthan one server per conversation. TUI `/lsp`\nopens a focused keyboard monitor: arrows browse processes, `u` refreshes, and\nEscape or Ctrl+C dismisses. Neither panel offers Start, Stop, Restart or Trust.\nDismissing either panel leaves servers running. Panels\nrefresh every four seconds while mounted and show state, root, PID when known,\nwarnings and errors. Requests are serialized within a panel; disposed panels\nignore late completions and release polling resources.\n\nRows represent actual runtime processes in `starting`, `running` or `stopping`\nstate, including idle running processes ready for reuse. Configuration/root\nmatches alone never create rows. Failed attempts with no reusable process are\nreported as warnings, not available-server rows. Each process is retired after\n15 minutes without Pix editing or an LSP request, measured from completion of\nits last operation. Overlapping requests and shared startup hold activity guards:\nin-flight work cannot expire. Activity from any attached owner resets the same\nprocess's timer. Status polling and cached diagnostic reads do not reset it.\nCleanup uses one resettable, unreferenced timer per idle process in the manager,\nnot UI polling or CPU/process sampling, and works without an open panel.\nAn idle-retired process disappears from monitoring; the next edit or LSP request\nlazily creates it again. Replacement waits for the retiring process's teardown\nbefore spawning another. Replacing or closing one session releases\nonly its attachment while another remains connected. Last departure tears down\nthe runtime. Existing file-based LSP tools retain their lazy acquisition path;\nmonitoring does not acquire a language server.\n\nReuse is generic for every configured server ID, including future additions:\nphysical workspace roots (and file/cwd aliases) are canonicalized before local\nmanager identity checks as well as IPC. Concurrent acquisition shares startup;\nretry of a failed client waits for its teardown and rechecks owner/cancellation\nfences. Different language-server IDs and legitimate separate package workspace\nroots remain independent, rather than being collapsed into one process globally.\n\nRepeated SDK extension binding (`session_start`) for an unchanged sessionManager\nand project retains its lease; it must not briefly detach the sole owner and\nkill reusable processes. A genuinely replaced session still fences old work.\n\nThe private ACP endpoint and `/lsp-control` retain their transport names for\ncompatibility but accept only `status`; former start/stop/restart/trust requests\nare rejected. Internal manager/broker control helpers remain for lifecycle\nregressions and are not exposed by either panel or command.\n\nThe existing [configuration trust contract](lsp-trust.md) is unchanged. Status\nuses noninteractive config loading. Trust prompts belong to the existing file\nexecution/edit path, not monitoring. Snapshots carry `trustRequired` independently\nof advisory/config-load warnings. The Desktop trust instruction appears only\nwhen that flag is true; monitoring can still display already-owned processes\nwithout granting the caller execution permission.\n\nLSP processes are owned by a local project broker, not an external IDE daemon\nor whichever tab happened to start them. Session startup attaches to this\nlightweight broker without launching any language server. A live IPC connection\nis the ownership lease: ordinary disconnect and client process death release\nit. Closing the original spawning tab must not kill a server another attached\ntab still uses. The last attachment's departure fences startup, shuts down\nowned servers and terminates the broker. On POSIX each server retains its\nsupervisor: broker-input EOF, server exit and supervisor failure sweep that\nserver/wrapper group, including stubborn descendants. Desktop's existing\nclose/quit consent remains: cancelling the close must not release the runtime's\nattachment. No native lifecycle changes or extra LSP confirmation are introduced.\n\nRationale: [0056 — Monitoring-only LSP panels](../decisions/0056-lsp-monitoring.md)\nand [0057 — Canonical LSP reuse and bounded idle retention](../decisions/0057-lsp-reuse-idle-cleanup.md).\nThese decisions supersede the controls/idle policy in [0052](../decisions/0052-owned-lsp-control.md)\nand [0054](../decisions/0054-project-shared-lsp.md). Project ownership from\n0054 remains in force.\n\n## Constraints and failure cases\n\n- No blanket eager startup or manual panel startup. Global configuration may\n  include languages absent from this project; status does not resolve candidate\n  roots into rows or missing-language warnings. Live processes remain visible\n  even if their config or root markers disappear.\n- Only Pix-owned, non-daemonizing children are controlled. A server intentionally\n  escaping its process group is outside the ownership guarantee. External IDE\n","startLine":1,"endLine":90},{"path":"wiki/operations/lsp-trust.md","quote":"  by a model or project file.\n- Automatic registrations are written to the trusted user\n  `~/.config/pi/pi-tools-suite.jsonc` layer with an absolute installed binary\n  path. Project-local config remains trust-gated exactly as described above and\n  is never auto-trusted or rewritten by onboarding.\n\n## Public contracts / inputs / outputs\n\n### Config locations & format\n- Global: `$HOME/.config/pi/pi-tools-suite.jsonc` (JSONC, `lsp.servers[]`); alt `$PI_CONFIG_DIR/pi-tools-suite.jsonc`; project: `\u003cproject\u003e/.pi/pi-tools-suite.jsonc` at the nearest matching ancestor (via `findUp`). `[confirmed by code]`\n- Schema `{ lsp: { servers: LspServerConfig[] } }`; `LspServerConfig` fields: `id`, `enabled`, `bin`, `args`, `cwd`, `env`, `config`, `include`, `exclude`, `rootMarkers`, `languageIdByExtension`, `startupTimeoutMs`, `diagnosticsWaitMs`, `pullDiagnostics`, `waitForPublishDiagnostics`, `initializationOptions`, `settings`, `maxFileSizeBytes`. `[confirmed by code: types.ts 27-44]`\n\n### Trust store\n- Path `$PI_AGENT_DIR/trust/lsp.json` (default `$HOME/.pi/agent/trust/lsp.json`). `[confirmed by code: trust.ts 21-24]`\n","startLine":75,"endLine":88},{"path":"wiki/work-management/tasks/project-tasks-agent-tool.md","quote":"- `/task get` returns the task plus linked attachment **metadata**.\n- Task payloads may contain optional `parentId`, `epic`, `relatedTaskIds`,\n  `modelRef` and `links`. The agent-facing update tool never exposes these\n  structural fields and preserves them on status/title/description patches.\n  Deleting a task with remaining child or related-task references is rejected\n  under the SQLite writer transaction instead of leaving a broken hierarchy.\n\n## Restricted agent tool\n\n- The model-facing tool is named `project_tasks` and accepts:\n  - `list` with optional status/priority/type filters (compact results);\n  - `get` with id (full task and attachment metadata);\n  - `create` with type and content, **only at an explicit user request**;\n  - `update` with id and at least one of status/priority/title/description;\n  - `run` with id, **only when the user asks to execute that saved task**,\n    in Pix Desktop only.\n- Desktop-only `models` lists the selectable model catalog and supported\n  thinking levels. `run` may include `modelRef` in `provider/model[:thinking]`\n  form; it must match that catalog and a supported thinking level.\n- Tool schema **does not expose delete, bulk modification, reorder, arbitrary\n  SQL, project-root override, attachment write, raw file write or storage\n  reset**. Unsupported fields are errors. Type, id, links, sessionId and\n  createdAt are not editable by this tool.\n- Status changes require explicit user confirmation, except the task launch\n  prompt can authorize final `done` after verified completion or `failed`\n  when the named task cannot be completed. That one-task authorization grants\n  no access to other tasks. Report persistence failures; never silently\n  create replacement tasks.\n- These are restrictions on this tool, not an OS sandbox: a separately\n  privileged shell/file tool could still modify SQLite directly if its\n  permissions allow it. Agent system guidance must prohibit bypassing the\n  task API; stronger guarantees require OS-level capabilities.\n\n","startLine":42,"endLine":74},{"path":"wiki/search/project-search-agent-tool.md","quote":"  batches and before publishing matches. Rewritten/unreachable commits are\n  excluded from the current results. Missing config/key/provider leaves\n  local Git matches intact. This does not create or migrate legacy code indexes.\n- Code and Knowledge default to the shared [native lexical/semantic backend](native-repository-search.md),\n  without credentials, incrementally updating the source-local native search stores.\n  Results include safe project-relative paths, inclusive line ranges and bounded excerpts.\n  No external search setup, fallback, or provider migration is allowed. Native `hybrid`/`semantic`\n  may embed scoped chunks and queries only when `~/.config/pi/pi-tools-suite.jsonc`\n  contains a valid `search.embedding` object, using the shared provider configuration and\n  source-local Code/Knowledge stores.\n  Up to 128 new chunks per search are indexed; incomplete coverage is reported and later\n  searches resume. Provider failures retain local results with a notice. `lexical` makes\n  no embedding calls. Symbol ranking is not supported.\n  The suite's `/search-semantic status|configure \u003cembedding JSON\u003e|off` command manages\n  the same global configuration in ordinary Pi without Desktop. Configuring it needs\n  no separate confirmation; that object itself enables semantics for all sources/projects.\n  Desktop's native Settings Search editor saves/removes the same file without ACP.\n  Legacy `.pi/search/semantic.json` and Desktop semantic booleans are ignored; credentials\n  and caches alone never activate semantics. OpenRouter credentials use\n  `OPENROUTER_API_KEY`, then shared Pi auth storage; Ollama requires no key. `pathPrefix` is a safe project-relative\n  directory/file scope.\n  `maxFiles` (1–50) limits distinct returned native files per domain at the final\n  result stage; candidate chunks remain available through ranking/reranking,\n  defaulting to three with no inline content or one when `includeContent`\n  is enabled. Combined final results remain capped at 20. Native supports\n  `dedupeFile`, `excludeTests`, `includeTests`, and `includeContent`; test filters\n  are mutually exclusive. `chunkTypes`, `minScore`, `includeImports`,\n  `dedupeSymbol`, and `cluster` are not supported tool options.\n- Optional global `search.rerankerModel` enables one shared rerank of up to 100\n  source-balanced Sessions/Tasks/Commits/Code/Knowledge candidates for nonlexical searches,\n  before native per-domain caps and the final result limit. Settings are not included.\n  History sends bounded titles/snippets, not whole sessions or diffs. Pure lexical requests\n  remain local; provider failure retains original ranking with a redacted notice.\n  See [reranking safeguards](native-repository-search.md#optional-reranking).\n- Federation isolates missing/unavailable sources with short controlled\n  notices, never raw provider diagnostics. Work is bounded to a 60-second\n  retrieval deadline with cancellation ownership, plus bounded reranker preparation/finalization\n  when configured. The agent receives **one final\n  response**, not a stream of early results. Concurrent local and indexed\n  source jobs are awaited, including cached semantic Tasks and on-demand Sessions/Commits when\n  eligible; a slow source is omitted only at the deadline or on failure.\n  Search returns a relevance-\n  ordered, deduplicated list with a maximum of 20 results, plus source-specific\n  notices. Output includes readable source IDs and structured details\n  (`path`, `startLine`, `endLine`, `hash`, `sessionId`, `taskId`)\n  so the agent can read and cite authoritative evidence afterward. Output text\n  is capped at 12,000 characters. An empty or partial search is not evidence\n  that a historical claim is false.\n- Calls use the invoking agent's model as the synthesizer. `project_search`\n  itself does not call JEV, run RAG or invoke any second answer model.\n  The agent must verify search hits against original code, documents or\n  history before treating them as definitive. Former `repo_context`,\n  `repo_inspect`, `repo_audit`, and `repo_search` tools are not registered.\n  `project_search` is the sole project retrieval tool; broad contract discovery\n  uses appropriate sources and is verified against authoritative files.\n\n","startLine":264,"endLine":319},{"path":"wiki/decisions/0067-final-documentation-maintenance.md","quote":"- Replaces: [0046 — Task-scoped knowledge audit completion](0046-task-scoped-knowledge-completion.md)\n\n## Context\n\nThe prior workflow required dirty checks, review receipts and exhaustive declared\ndependency coverage even for bounded implementation tasks. The user rejected that\nritual but explicitly retained the final documentation specialist.\n\n## Observations and sources\n\nThe prior contract is preserved in 0046. The role and todo completion hook enforced\nits model-facing instructions. The user's preference above is conversation evidence,\nnot a measured claim about documentation quality or runtime savings.\n\n## Decision\n\nKeep the final `knowledge-auditor` handoff to update task-affected documentation.\n","startLine":11,"endLine":27}],"notices":["Native reranking unavailable or its context changed; original ranking retained.","Не удалось подтвердить полноту или актуальность результатов поиска.","Результат 1 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Результат 3 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Результат 4 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Список источников в сохранённом отчёте сокращён по размеру; объём выполненной проверки указан отдельно."],"coverage":{"scope":"retrieved-passages","checkedPassages":24,"candidateSources":100,"excerptedSources":20,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"],"retainedPassages":12}}} -->
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
- `src/brainstorm` — `/brainstorm [--mode auto|brainstorm|audit] <topic>` and the model-only `brainstorm` tool: five-round brainstorming or evidence-based audit with reviewed parent synthesis. Preserves the protocol under `.pi/brainstorms/`, without starting implementation. Desktop uses persistent native participant sessions; TUI/legacy runs require async-subagents and the research role. See [the council contract](../assistants/brainstorm.md).
- `src/async-subagents` — `subagents` tool and sub-agent slash commands, including oh-my-openagent-style `/ultrawork` (`/ulw`) and `/hyperplan` orchestration prompts; roles are Markdown files under `src/async-subagents/agents/*.md` plus project `.pi/agents/*.md`; parent implementation is default, with handoffs only for explicit user delegation, an implementation capability gap, or sufficiently large prescribed mechanical work whose deterministic checks and expected net savings justify overhead; includes a cross-vendor `oracle` profile for bounded second opinions and complex architectural review; defaults to a 3-hour per-agent execution timeout when none is specified (explicit timeouts override it), with project-wide concurrency queueing, optional per-agent retry/backoff, and `result.json` structured metadata/chaining fields next to raw `result.md`; stores project-local run files and a registry under `.pi/subagents/` so result/status collection can recover after compaction or reload while the main session remains alive; clean Pi TUI sessions additionally get a live native widget for queued/running/retrying agents, while Pix keeps its renderer-owned presentation
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
- `src/model-tools` — model-specific tool aliases such as Claude/GLM-style `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `LS`, GPT/Codex-style `shell`, and model-gated `apply_patch`. `/shell-workdir allow <path>`, `list`, and `revoke <path>` manage canonical extra workdir roots for the current session only; see [the shell workdir contract](../operations/shell-workdir-session-grants.md).
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
clears only recognized derived task/session/commit/settings vectors and identity metadata
from their source-local databases (`tasks.sqlite`, `sessions.sqlite`, `git-commits.sqlite`,
and `settings.sqlite`), preserving canonical tasks, sessions and Git history. Repository
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

By default the council roster is the enabled `frontierModels` list in order (max 6).
Set `brainstorm.models` in `~/.config/pi/pi-tools-suite.jsonc` (or the usual
project override) to 2–6 distinct exact `provider/model` references to replace it;
there is never a silent fallback to different participants. `brainstorm.thinking`
defaults to `high`, `brainstorm.thinkingOverrides` sets per-model levels (default
`zai/glm-5.3 = max`), and `brainstorm.timeoutSeconds` is 600 per participant per
round (30–1800). `brainstorm.quorum` (default roster − 1, min 2) lets a round
continue when a participant fails; the gap is recorded. Protocols are written to
`brainstorm.outputDir` (default `.pi/brainstorms/`, outside the knowledge base);
`finalize` with `publish=true` copies only the final proposal to `docs/brainstorms/`.
The parent clarifies only material uncertainty and prepares a brief before paid
work. Default auto routing uses intent/context: create/develop alternatives →
brainstorm; inspect existing material → audit. The parent announces the choice;
mixed/unclear requests need clarification. Use `--mode brainstorm` or `--mode audit`
to override; mode is fixed once the run starts. No separate paid classifier is used.
Audit requires target material/version, author intent, criteria and coverage limits;
missing material must be supplied before launch. Its rounds are findings,
cross-check/coverage, critique of findings, priorities/minimal fixes and report
review. Findings need cited evidence, severity separate from confidence, and
validation; no findings is valid. The report preserves intent rather than silently
redesigning the target. These are model instructions, not quality guarantees.
The council performs five paid rounds (5 × roster size participant turns), plus configured retries and parent drafting/revision. `run` performs
rounds 1–4; `review` preserves the draft and runs round 5 with the original settings;
`finalize` requires that review and saves the final proposal and revision notes.
Legacy two-round runs cannot be continued under this protocol. Invalid modes
fail explicitly. Original v2 five-round runs can continue as
brainstorm; v2/v3 runs migrate to the v4 manifest (responses in `rounds/*.md`,
hash-checked). TUI/legacy runs use fresh workers and older-round ledgers. New
Desktop runs keep one ACP-owned session per slot through review, append only new
peer answers, and expose a compact storm panel with native session navigation.
Direct writes are blocked while a participant is owned. The saved execution mode
prevents silently replacing lost Desktop sessions with fresh workers; host-loss
recovery is not supported. Audit reports keep the `proposal.md` name.
For one run only, use
`/brainstorm --models provider/model:off,provider/other-model:low <topic>`
(optionally with `--mode audit`, either order; `--models=...` also works).
Supply 2–6 distinct models, comma-separated without spaces, each with explicit
effort: `off|minimal|low|medium|high|xhigh|max`. The parent passes the exact array
as `models` on `brainstorm(action="run")`; it must not choose an override itself.
Settings remain untouched; all five rounds, including review, use the saved
roster/efforts. Omit `models` on review/finalize (overrides are rejected there).
Without the option, configured defaults apply. Timeout/output root/quorum remain
configured; an explicit quorum larger than the selected roster is an error.
Missing auth/models or policy rejection fail explicitly; forced-current
model overrides and research CLI overrides are incompatible. Disable with
`modules.brainstorm: false`. Reload/restart after installing the module.

Participants in both modes can use `read`/`grep`, `web_search`/`web_fetch`, and
the unrestricted `project_search` tool through the common tools-only child entrypoint.
It has the same sources and schema as ordinary Pi, including private history and
`patch:` searches. The council-specific extension adds web access and its strict
call guard; private child `todo` is also allowed, without enabling mutations or
nested delegation. Repository embeddings use shared global configuration/provider
safeguards. No shell, edits, suite setup commands or nested agents are enabled. Participants
are instructed to research when useful, cite sources, report access gaps, and never
send private repository/brief content or secrets to web services. Tool selection is
enforced; privacy and source-quality instructions are not a network/filesystem sandbox.

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

`minContextPercent` / `maxContextPercent` accept legacy fractions (`0.25`), percent strings (`"25%"`), or absolute token counts when Pi knows the current model context window. `minContextLimit` / `maxContextLimit` and `modelMinContextLimits` / `modelMaxContextLimits` are explicit absolute-or-percent aliases. `modelOverrides` and the `modelMin*` / `modelMax*` maps support exact model keys plus `*` / `?` wildcard patterns; matching is applied from generic to specific so exact bare-model matches override bare wildcards, and exact `provider/model` matches override provider wildcards. Array fields are union-merged, so model-specific `protectedTools` extend the defaults instead of replacing them. If `compress.protectUserMessages` is enabled, range compression appends selected user messages verbatim instead of rejecting the range; individual message compression still skips protected raw user messages. Protected tool outputs are copied into summaries for tools protected by name or `protectedFilePatterns`; protected `subagents` result reads also try to include the saved `result.md` artifact when available.

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
do not cache an absolute workspace path. Harness-owned subagent/QA evidence
remains in `.pi/subagents/`. Explicit release/build paths and user-requested
deliverable paths are exceptions. New prompts/profiles/examples must keep this
rule; a custom `promptOverride` replaces base guidance and must include it itself.
Storage is disposable, not universally self-cleaning: initialized-project
Desktop cleanup has a 72-hour background TTL and manual Clean is immediate.
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
`src/async-subagents/agents/ui-qa/guides/`. `browser.md`, `tui.md`, and
`desktop.md` are compact routers; backend-scoped detail topics cover the actual
browser provider, TUI presentation, desktop platform driver, and explicit
browser-auth workflow. The child loads the matching base guide, then only the
routed detail topic read-only via the runner:

```sh
node "$PI_UI_QA_RUNNER" guide --backend browser   # or: tui | desktop
node "$PI_UI_QA_RUNNER" guide --backend browser --topic playwright
# other examples: chrome-devtools, tui/native-terminal, desktop/windows-uia
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
Accessibility, Windows UI Automation, or Linux AT-SPI implementation. Evidence
capabilities remain platform-specific and never replace deterministic
assertions. Unsupported platforms or missing required control permissions
return `BLOCKED`. QA does not
install GUI automation dependencies, change OS privacy/accessibility settings,
disable sandboxing, or operate unrelated user windows. Static or mock checks do
not substitute for the requested UI.

Unified flows and native/TUI evidence—including automatic recordings—stay in the owning agent's private
`.pi/subagents/<run>/<agent-id>/ui-qa/` workspace. Pass/fail requires a
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

Every sub-agent is a full persisted Pi session under its agent's `sessions/` directory; there is no opt-out. The session backs `subagents action=send` cold resume of finished agents, Desktop read-only sub-agent viewer tabs and the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`).

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

Sub-agent runs are stored in the current project's `.pi/subagents/` directory and survive main-session shutdown. Each spawn updates `.pi/subagents/registry.json` with the latest run and `agentId -> runDir` mappings. Because of that, `subagents({ action: "status" })`, `wait`, and `stop` can omit `runDir` to target the latest run, and `subagents({ action: "result", agentId: "..." })` can resolve the run from the registry even if the exact `runDir` was lost during compaction or the session closed. Result reads always return a summary-first response with artifact paths; raw `result.md` and `stderr.log` are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs. On normal main-session shutdown, Pi stops that session's sub-agents but preserves run files, reports, attachments and registry pointers; reload and fork shutdowns also skip stopping. Desktop's separate 72-hour background TTL and immediate manual Clean remain unchanged. The draft macOS owned launcher prevents explicit cleanup while containment or either UUID launchd service's retirement is uncertain; stopping the bridge alone never authorizes deletion. This candidate remains gated on G1/T3 acceptance (see `wiki/tools/agents/async-subagents.md` in the Pix repository).

Within a run directory, `prompts/<agentId>.md` is only the queued copy and
exists only while the agent is planned/queued. Launch deletes that copy; the
prompt remains at `<agentId>/prompt.md`, and the `prompts/` directory stays.
Missing `retry_count` means zero retries; setting the count to zero removes the
file. Missing `todo-progress.json` means no plan: total-zero progress is not
written, and clearing an empty plan removes the file. `started_at`,
`finished_at`, and `exit_code` remain separate files.

Runtime logs are minimized by default: no RPC event transcript is written (the persisted child session under `sessions/` is the full history), `progress.jsonl` records only lifecycle stages, and `stderr.log` is discarded unless the agent fails. The child argv of the latest turn is stored as `piArgs` in `launch.json`. Set `ASYNC_SUBAGENTS_DEBUG_LOGS=1` / `PI_SUBAGENTS_DEBUG_LOGS=1` to keep `stderr.log` for successful agents too. Defaults are 8 MiB for retained `stderr.log` and 8 MiB for a single RPC JSON line; override with `ASYNC_SUBAGENTS_MAX_STDERR_BYTES` / `PI_SUBAGENTS_MAX_STDERR_BYTES` and `ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS` / `PI_SUBAGENTS_MAX_RPC_LINE_CHARS`.

Runtime concurrency defaults to 5 agents per project and the global result summary bound defaults to 100000 bytes. These are internal engine defaults rather than normal user configuration. The fallback watchdog is 3 hours (10,800 seconds) if no timeout is specified. Per-agent `retry`, `maxResultBytes`, and `timeoutMs` belong in agent Markdown; spawn calls and individual task objects can pass `timeoutSeconds` to override the watchdog with a shorter or longer timeout. Explicit timeouts are not capped at 3 hours; the macOS owned-launch supervisor uses the same resolved timeout. Stop requests mark running, queued planned, and retry-pending agents as `stopped` so queued work is not launched later. Completed agents write `result.json` with status/duration/model/retry metadata plus best-effort `summary`, `findings`, `files`, `risks`, `nextActions`, and `confidence` fields for parent-agent chaining.

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

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"a9a480da12b9d201875ae8423bb0d6b57327812ba5c91e541d47eef1a119b995","checkedAt":"2026-10-30T23:13:00.959Z","maxDocumentChars":128000} -->
