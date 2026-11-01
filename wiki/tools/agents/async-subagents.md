---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T13:52:44.528Z","result":{"path":"wiki/tools/agents/async-subagents.md","documentHash":"973cb8e6d0219b7b01a42ff029ba23f5996ed0c4a133f35f6971e6aef3c74d7b","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":30,"chunkCoverage":{"totalChunks":3,"checkedChunks":3,"totalComparisons":6,"checkedComparisons":6},"status":"incomplete","conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n  node_modules, HOME, credentials and the checkout are never copied into the\n  payload. Production runtime compilers/loaders such as jiti, and esbuild when\n  present in the production dependency graph, are retained.\n- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and\n  (Desktop only) `pix/app/acp/{dist,node_modules,...}`. Preserve the relative relationship between\n  ACP, Pix dist and the bundled tools suite. Native addons and dependency license\n  files are retained; `DEPENDENCIES.json` inventories shipped package metadata.\n- The shell/CMD launcher selects the absolute bundled Node path, prepends its\n  directory to PATH for child tools, preserves the caller's working directory,\n  forwards arguments, and propagates exit status.\n- Standalone means no separately installed Node/npm for Pix itself. Git, project\n  toolchains, optional language servers, voice/clipboard helpers and provider\n  credentials remain external requirements as applicable.\n\n## Payload optimization and size gates\n\nPreparation writes the TUI variant to `.artifacts/releases/\u003ctarget\u003e/pix` and the\nDesktop variant to `.artifacts/releases/\u003ctarget\u003e/desktop/pix`. Their `release.json`\n","startLine":1,"endLine":58},{"path":"wiki/tools/agents/subagent-model-pools.md","quote":"# Sub-agent model candidates and provider policy\n\nSub-agents primarily reduce the cost of bounded work and keep intermediate\nsource, searches and logs out of the parent context. The parent owns planning,\nintegration, decisions and the final answer. Actual savings depend on worker\nquality, retries and how much work the parent repeats; model order is a role\npolicy, not a price oracle.\n\n## Execution modes\n\n- `research`: read-only evidence gathering, searches and focused review questions.\n- `implement-core`: Sol for approved implementation handoffs, including explicit\n  user delegation or a concrete capability gap; no automatic weaker-model fallback.\n- `mechanical`: GLM-5.3 for sufficiently large prescribed behavior-preserving edits\n  with an exact scope and deterministic acceptance check, never broad migrations,\n  interface redesign or semantic changes to regression tests.\n- `verify`: run checks and interpret logs, without fixing source or tests.\n- `ui-qa`: isolated real-UI workflow for browsers, terminal/TUI apps, and\n  desktop GUIs with deterministic assertions and inspectable evidence.\n- `oracle`: a deliberate cross-vendor frontier second opinion and independent\n  post-implementation review for complex architectural tasks only, not automatic\n  worker escalation. Every parent requires another vendor, including fallbacks.\n  The duplicate bundled `frontier-review` role has been removed.\n- `knowledge-auditor`: economical docs-only role run before completion to update\n  task-affected documentation, without search setup, dirty-state checks or review receipts.\n\nTask-specific discipline belongs in the brief or `promptAppend`. A new project\nagent is warranted when it adds a durable contract, capabilities or resources,\nnot merely a professional title. `verify` has a behavioral no-edit contract;\nshell access is not a read-only filesystem sandbox.\n\n## Role-owned model candidates\n\nEach Markdown profile owns its ordered `models` list, or declares\n`modelSelection: frontier` to use the suite-level frontier list described\nbelow. There is no other global sub-agent preset or model-pool layer. The list\nis the complete candidate chain for initial selection and subsequent quota\nfallbacks:\n\n```yaml\n---\ndescription: Make bounded implementation changes.\nmodels:\n  - openai-codex/gpt-6-luna\n  - openai-codex/gpt-6.1-sol\nthinking: high\n---\n```\n\nModel references in `models` are exact `provider/model` values, not wildcards.\nThe resolver preserves that configured order unless the role declares a parent\nprovider policy. Runtime selection then removes candidates that are unregistered,\nunauthenticated, session-exhausted, or incompatible with required capabilities.\nTasks with images and `ui-qa` require confirmed image support. The first usable\ncandidate runs; remaining usable candidates form the quota fallback chain. An\nempty or unavailable chain rejects the batch before any child is launched.\nModel selection itself makes no LLM completion request; the optional role router\nis a separate operation.\n\nExplicit task `model`, CLI `--model`, and `FORCE_CURRENT_MODEL` remain deliberate\noverrides and do not add automatic fallback candidates. Capability checks and a\nstrict parent-provider boundary still apply to those overrides.\n\n## Parent-provider policy\n\n`parentProviderPolicy` controls the relationship between a role's candidates\nand the known parent model. It compares *vendors* (model-family owners), not\nprovider ids: the vendor is taken from a matching `frontierModels` entry's\n`vendor`, else inferred from the model id (`gpt-*`/`o\u003cN\u003e`/`codex` → openai,\n`glm-*` → zai, `claude-*` → anthropic, `gemini-*`/`gemma-*` → google, `grok-*`\n","startLine":2,"endLine":71},{"path":"wiki/decisions/0059-subagent-private-todos.md","quote":"# 0059 — Private todos for every subagent role\n\n- Status: accepted\n- Recorded: 2026-10-06\n- Decided: 2026-10-06\n- Owner / approval evidence: user requested todo for all roles in this conversation,\n  then explicitly included `frontier-review` and all roles in the folder.\n  No separate durable conversation artifact is cited.\n- Governing spec: [Async subagents](../tools/agents/async-subagents.md)\n- Replaces / replaced by: the todo-only empty-selection rule is superseded by\n  [0060](0060-subagent-read-only-repo-tools.md), which also allows gated repo\n  queries. The private-todo architecture remains in force; original rationale\n  below is retained as history.\n\n## Context\n\nChildren disable ordinary extension discovery. The parent previously owned the\nonly planning tool. All workers now need local planning without mutating the\nparent's list or enabling recursive delegation.\n\n## Observations and sources\n\nVerified: [spawn](../../external/pi-tools-suite/src/async-subagents/core/spawn.ts)\nloads an explicit extension allowlist. The ordinary\n[todo entrypoint](../../external/pi-tools-suite/src/todo/index.ts) loads a shared\nproject persistence file and parent-specific thinking, UI and follow-up hooks.\nThe installed SDK enforces CLI tool restrictions on extension tools too;\n[inventory tests](../../external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts)\nexercise actual offline child startup without model calls.\n\n## Decision\n\nLoad a lean todo entrypoint at the common child launch boundary, independent of\nrole name or visibility. Reuse normal todo actions and session-scoped state, but\nnever project persistence or parent workflow hooks. Add todo to explicit CLI\nallowlists; translate empty/no-tool selections to todo-only. Excluding todo is\nnot supported for children; other exclusions remain intact. Preserve unfinished\nwork across in-process compaction and optional session branch snapshots.\nEach retry/attempt gets a fresh list. Parent-only tools remain denied.\n\n## Alternatives\n\n- Per-role edits would omit future or hidden roles and duplicate policy.\n- Loading the full todo module would expose shared persistence and parent hooks.\n- A shared parent plan would let parallel workers overwrite each other's state.\n\n## Consequences\n\nAll roles can plan locally; explicitly tool-less roles now have a planning-only\nexception. No-session children retain their list only for the child lifetime.\nTodos do not automatically appear in the parent's list or final summary; workers\nmust report blockers. No additional model turn is scheduled by todo hooks.\n\n## Revisit when\n\nParent-side aggregation is requested, child sessions gain interactive navigation,\nor SDK changes affect extension allowlists, branch replay or compaction events.\n\n\n","startLine":1,"endLine":59},{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n- Compact status chrome labels context as `Context`, omits redundant hourly/weekly and `resets` text (window names and reset meaning remain in click details), and shows Claude Code provider model names without the `Claude Code ` prefix in the model/thinking display. Persistent model names use neutral foreground text and thinking uses muted text, leaving provider brand color to the icon; picker and usage-detail model colors are unchanged. Provider IDs and routing are unchanged. Context and quota use content-sized grid groups rather than equal columns; bounded inline controls clip excess content at very narrow widths instead of painting over neighboring controls, while detail panels remain unclipped.\n- Context and Usage have distinct inter-group spacing and fixed inner telemetry slots. Quota windows use track, reset countdown, then the associated warning/retry/cache indicator, with no bullet or middle-dot separators; loading placeholders follow the same order. Only actually present quota windows take space; the account label stays in the details rather than the trigger.\n  Neither Context nor quota triggers reserve or render numeric percentage slots, including their skeleton placeholders. Percentages remain available in detail panels and quota accessible descriptions; narrow-window clipping remains bounded by the outer control.\n","startLine":1,"endLine":35},{"path":"wiki/decisions/0001-subagent-coding-roles.md","quote":"# 0001 — Separate default, core and mechanical subagent coding\n\n- Status: superseded\n- Recorded: 2026-10-02 (retrospective)\n- Decided: 2026-10-01, in the preceding subagent-role change discussion\n- Owner / approval evidence: user requested the Luna/Sol/GLM split and selected\n  the common pi-tools-suite rather than project-local overrides.\n- Governing spec: [async-subagents](../tools/agents/async-subagents.md)\n- Replaces / replaced by: superseded by [0069 — Parent-owned implementation](0069-parent-owned-implementation.md)\n\n## Context\n\nThe previous default implementer used GLM-5.3 followed by Sol. We needed a\nbounded coding policy that reduces unaccepted migration work without sending\nevery task to Sol. The orchestration itself also needed earlier verification.\n\n## Observations and sources\n\n- **Reported observations:** the user-provided assessment at the start of this\n  session described GLM repeatedly leaving migrations unfinished after timeouts,\n  introducing incompatible interfaces/type errors and sometimes weakening tests\n  instead of preserving regression meaning. It also acknowledged orchestration\n  responsibility: migration scopes were too broad and checks too late. These\n  are attributed reports, not a controlled benchmark; original migration\n  diffs/logs were not attached to this record.\n- **Reported review evidence:** the same assessment stated that Luna found a\n  lost hidden-blocker check and weakened tests. This is useful review evidence,\n  not proof of implementation quality on equivalently sized tasks.\n- **Verified policy sources:** [role definitions](../../external/pi-tools-suite/src/async-subagents/agents),\n  [candidate contracts](../../external/pi-tools-suite/test/async-subagents/model-pools.test.ts)\n  and [routing eval](../../external/pi-tools-suite/test/prompt-evals/async-routing-e2e.test.ts).\n  These cover configuration/routing, not comparative coding quality or cost.\n- **Limits:** no matched implementation benchmark or accepted-work cost dataset\n  was established. Timeout alone does not demonstrate model weakness.\n\n## Decision\n\nIn the bundled suite, use Luna as default `implement` coder with Sol as the\navailability/quota fallback; use Sol-only `implement-core` for complex core\nchanges and ambiguous bugs, and GLM-5.3-only `mechanical` for small prescribed\nbehavior-preserving edits with deterministic checks. Code/delivery review uses\nSol, without a GLM fallback. Existing review visibility gates remain intact.\n\nResearch, verify, UI QA, docs-only knowledge auditing and cross-vendor oracle\npolicies remain separate and unchanged. This is not a global ban on GLM.\nProject overrides retain their normal precedence.\n\nRequire coherent migration slices, early affected typechecks and regressions,\npreserved negative/hidden-blocker checks and honest partial-work handoffs.\nPrompt instructions do not guarantee checkpointing or rollback after timeout.\n\n## Alternatives\n\n- Keep GLM as default coder: not chosen because of the reported unaccepted\n  migration work and regression weakening; retain it for narrow mechanical work.\n- Use Sol for all implementation: not chosen because the available evidence\n  did not establish that its additional cost was justified for ordinary tasks.\n- Treat Luna's review success as proof of coding superiority: rejected as an\n  unsupported inference. Luna-first is a starting policy to evaluate.\n- Only change model names: insufficient; broad scopes and late verification\n  were also implicated, so the policy includes orchestration safeguards.\n\n## Consequences\n\nExpected benefit: clearer task boundaries and less risky migration/review\nassignment. Sol-only roles lose automatic alternative-model availability.\nLuna's comparative implementation quality and total cost remain uncertain.\nParents must inspect partial diffs after timeouts rather than accepting them\nor blindly retrying on a stronger model.\n\n","startLine":1,"endLine":70},{"path":"wiki/tools/suite.md","quote":"\n### Legacy configuration compatibility\n\nOld built-in role names are no longer implicit aliases. `quick`, `scan`,\n`review`, `deep`, `docs`, `frontend`, and `tests` are valid only when explicitly\ndefined as ordinary project `.pi/agents/\u003cname\u003e.md` files.\n\nWithin an agent Markdown file, legacy `model` plus `fallbackModels` and\n`modelByParent` remain readable. `models` is a complete replacement list: it\nclears inherited legacy model/fallback/parent routing. New built-ins use ordered\n`models` lists and contain no parent-tier escalation maps.\n\nThe removed `asyncSubagents` section is not part of the public schema or generated\nuser config and is no longer read at runtime. Existing files can remain on disk\nwithout being rewritten, but they have no effect: migrate role definitions and\nmodel candidate ordering to `.pi/agents/*.md`, and bundled role visibility to\nthe top-level `disabledBuiltinAgents` / `enabledBuiltinAgents` lists. Runtime\nretry structures and the separate role router continue to use the term\n`fallbackModels` for actual fallback-only lists, not agent candidates.\n\nEvery sub-agent is a full persisted Pi session stored at `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchildSessionId\u003e.jsonl` (see [async-subagents](agents/async-subagents.md)); there is no opt-out. The session backs `subagents action=send` cold resume of finished agents, Desktop read-only sub-agent viewer tabs and the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`).\n\nThe module summary's `\u003cscope\u003e` means this parent scope, not a run/batch directory:\nfor a normal persisted parent it is `\u003cparentSessionId\u003e`. A keyed headless host\nuses a deterministic UUID derived from project root and host session key, with\n`headless-parent.jsonl` beside its child JSONLs. See the\n[headless journal contract](headless-tool-api.md). The run key\n`.pi/subagents/\u003cscope\u003e/\u003cbatch\u003e` is a compatibility identity, not a new directory.\n\nEvery sub-agent role (including project-local and future roles) gets a private `todo` tool for non-trivial multi-step work. Each child attempt owns its list; it cannot read or overwrite the parent's project plan. `todo` remains available even with restricted or empty work-tool selections. Child todos do not enable persistence commands, thinking overrides or automatic follow-up turns; unfinished work and blockers belong in the report to the parent.\n\nOptional work tools follow the final tool selection: bundled `research`,\n`implement-core`, `mechanical` and `oracle` request read-only\n`ast_grep`; only bundled `research` adds `web_search`/`web_fetch`. The tools-only\nloader preserves these extension names without loading `ast_apply`, LSP or\ncredential/setup commands. Unlike universal todo/repo, optional tools can be\nremoved by CLI lists/exclusions or project-local full replacements. Read-only\nresearch keeps canonical read/grep, never Codex's shell alias. Web uses existing\ncredentials/fallback and is for public evidence only, never secrets/private repo\ndata; missing prerequisites are reported to the parent. Council shares web\nregistration but retains its stricter guard and does not gain AST.\n\nEvery role also gets the full `project_search` tool without external search setup.\nCommon spawn loads only the tools-only entrypoint, never setup/update commands\nor the full suite. Restricted/empty tool lists and exclusions retain private\ntodo and `project_search`, not other work tools. All five sources and `patch:`\nare available, with the same consent, provider and cancellation safeguards as\nordinary Pi. No implicit external-backend setup is attempted.\n\nSub-agent child sessions are stored in the current project's `.pi/subagents/\u003cscope\u003e/` and survive main-session shutdown; the `runDir` compatibility key identifies a batch but is not a run directory. Run and agent records are kept session-natively as lifecycle entries in the parent session; there is no `registry.json`, and legacy run directories are ignored. `subagents({ action: \"status\" })`, `wait`, and `stop` can omit `runDir` to target the latest batch of the current parent scope, and `subagents({ action: \"result\", agentId: \"...\" })` resolves the latest-launched record for that `agentId` even if the exact `runDir` was lost during compaction or the session closed. Result reads always return a summary-first response with artifact paths; raw transcripts and full diagnostic logs are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs. On normal main-session shutdown, Pi stops that session's sub-agents but preserves run files, reports, attachments and session records; reload and fork shutdowns also skip stopping. Desktop scratch evidence keeps its 72-hour background TTL and immediate manual Clean. Parent-scoped sessions instead follow parent existence plus 24 hours of subtree inactivity after the parent is gone; Manual Clean preserves unretired owned-launch records (see the [artifact contract](../operations/harness-artifact-storage.md)). The draft macOS owned launcher prevents explicit cleanup while containment or either UUID launchd service's retirement is uncertain; stopping the bridge alone never authorizes deletion. This candidate remains gated on G1/T3 acceptance (see `wiki/tools/agents/async-subagents.md` in the Pix repository).\n\nNew launches do not write per-agent `launch.json`, `result.json`,\n`retry_count`, `started_at`, `finished_at`, `exit_code` or queued prompt\nsidecars. Parent `pi-tools-suite:subagent` entries carry launch, retry,\ncompletion, result and progress state; child JSONLs live directly under the\nscope with `subagent_meta`. The compatibility `runDir` key is an identity,\nnot a directory. Existing legacy transcripts remain inspectable through ACP's\nread-only resolver, not a lifecycle-state importer.\n\nDiagnostics and disposable evidence are distinct from the durable session\nrecords. See the [session-native lifecycle contract](agents/async-subagents.md)\n","startLine":1120,"endLine":1180},{"path":"wiki/tools/suite-codemode.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Suite codemode\n\n## Behavior\n\nThe `codemode` suite module is enabled by default. On session start it adds the\nSDK's QuickJS JavaScript tool to the active tool set without removing direct\ntools. Pix SDK hosts register `createCodemodeExtension({ mode: \"on\" })` when the\ntool is absent; hosts such as the Pi CLI reuse their existing definition.\nModel-specific tool profile changes preserve this non-managed tool.\n\nThe shared module catalog exposes `codemode` in Desktop **Settings → Tools Suite\n→ General → Modules** with its default and description. The checkbox writes\n`modules.codemode` in the shared user `pi-tools-suite.jsonc`. For example,\n`{ \"modules\": { \"codemode\": false } }` disables suite registration/activation.\nExisting list/map aliases, project overrides and environment precedence apply.\nChanges require extension reload or session restart; saving settings does not\nmodify the running session. Existing configs need no migration.\n\nSDK scripts use QuickJS, not a Node shell. They can call exposed session tools;\nnested calls retain SDK validation, safety hooks and cancellation. They emit\nexecution events and bounded metadata on the parent result, not independent\ntranscript tool-result messages. The SDK owns VM limits and script-state storage.\n\n## Constraints and failure cases\n\n- Do not widen explicit restricted selections: if either\n  `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION` or its legacy\n  `MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION` alias is truthy, the module does not\n  register or activate anything. This protects suite async-subagent profiles.\n- Disabling this module removes only the suite's contribution. It is not a hard\n  deny against a host, MCP integration or other extension independently enabling\n  codemode. Existing host definitions and settings (including a CLI's explicit\n  `codemode.mode: \"only\"`) are not overwritten.\n- QuickJS is not a security boundary against tool permissions: tools still run\n  with their host permissions. Inactive direct tools are not callable from scripts;\n  SDK `codemode`/`deferred` exposure retains its upstream semantics.\n- No new model routing policy, custom renderer, MCP setup or live config watcher.\n\n## Implementation\n\n- `external/pi-tools-suite/src/codemode/index.ts`\n- `external/pi-tools-suite/src/module-catalog.ts`\n- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`\n- `external/pi-tools-suite/src/config.ts`\n- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`\n- `desktop/src/components/settings/SettingsModuleVisibility.svelte`\n- `desktop/src/lib/tools-suite-module-visibility.ts`\n\n## Tests\n\n- `external/pi-tools-suite/test/codemode.test.ts`\n- `external/pi-tools-suite/test/codemode-sdk.case.ts` (`npm --prefix external/pi-tools-suite run test:sdk`)\n- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`\n- `external/pi-tools-suite/test/evals/coverage-manifest.ts`\n- `desktop/src/lib/tools-suite-module-visibility.test.ts`\n\n## Verification\n\nRun suite typecheck and focused codemode/config/model-tools/eval-contract tests;\nrun Desktop module-visibility tests and checks. Real installed-SDK tests exercise\nQuickJS, additive declarations, CLI reuse, nested hook blocking and cancellation\nwithout paid model calls. The codemode SDK integration cases run under Node,\nmatching the shipped host; Bun's delayed worker exit can exhaust the SDK's live\nworker limit between otherwise sequential tests. The suite's `npm test` includes\nthis Node leg after its Bun tests. In native Desktop check the default row and saved\noff/on JSONC round trip. Sync the live suite after verification.\n\n## Related\n\n- [Default-on integration decision](../decisions/0030-suite-codemode.md)\n- [Desktop config editing](../configuration/desktop-user-config-editing.md)\n\n\n","startLine":1,"endLine":78},{"path":"wiki/decisions/0031-subagent-completion-delivery.md","quote":"# 0031 — Single-channel subagent completion delivery\n\n- Status: superseded\n- Recorded: 2026-10-04\n- Decided: 2026-10-04\n- Owner / approval evidence: user approved the proposed single-delivery behavior in this task conversation.\n- Governing spec: [async-subagents — Parent completion delivery](../tools/agents/async-subagents.md#parent-completion-delivery)\n- Replaces / replaced by: replaced by [0044 — Retractable parent completion delivery](0044-retractable-subagent-completions.md)\n\n## Context\n\nAutomatic completion follow-ups wake an idle parent or queue another turn for a\nbusy parent. A parent intentionally waiting through `wait` or a `spawn` watch can\notherwise receive the same completion both as a tool result and a queued wakeup.\n\n## Observations and sources\n\nThe entrypoint previously removed a tracked child before sending its follow-up,\ndeduplicating callback/watcher reconciliation but not coordinating with polling\ntool responses. `polling.ts` returns its last state on timeout or abort; that\nsnapshot may not contain a completion which occurs immediately afterward.\nIn-process finality belongs to the retry/fallback callback, not an intermediate\ndisk receipt. These are source observations, not production incident measurements.\n\n## Decision\n\nUse per-launch, session-scoped in-memory reservations shared by the entrypoint\nand `wait`/`spawn`. Defer follow-ups while a relevant tool call is collecting.\nConsume only terminal states in its successfully constructed final response,\nthen release reservations and reconcile synchronously. Abort/error acknowledges\nnothing; timeout/fail-fast acknowledges only the completed subset actually\nreturned. Do not treat progress updates as delivery. Preserve the final-callback\ngate when polling in-process launches.\n\nDo not retract already queued follow-ups or add a persistent delivery ledger.\nExplicit repeated result/status/wait requests still return the requested state.\n\n## Alternatives\n\n- Suppress notifications whenever any wait runs: rejected because unrelated\n  agents/sessions and timeout/abort boundaries would lose notifications.\n- Deduplicate only callback vs watcher: existing behavior; it does not cover the\n  tool response channel.\n- Cancel queued follow-ups afterward: not chosen; reserving before collection\n  avoids requiring queue removal or SDK changes.\n\n## Consequences\n\nOne pending completion is consumed by a collecting tool response or delivered\nas a follow-up. Overlapping calls and agent ID reuse require reference-scoped\nreservation bookkeeping. The guarantee is local to the current extension\ninstance, not crash-consistent delivery across reloads. A long wait can defer a\nselected child's notification until the call exits.\n\n## Revisit when\n\nDurable completion replay is required, queued follow-ups must become retractable,\nor runtime tool-result acceptance requires an acknowledgement beyond successful\ntool execution. Regression coverage is in\n`external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`.\n\n\n","startLine":1,"endLine":62},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n   outgoing payload. `after_provider_response` treats HTTP status as diagnostic\n   acceptance only. A successful finalized assistant `message_end` can promote\n   provider evidence when the local attempt is unambiguous. This evidence is\n   runtime-only and returns to unknown after restart.\n6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.\n   Durable decisions are appended at their mutation/publication boundary.\n\nPlain `custom` entries are not provider messages. `dcp-journal` must never be\nstored as `custom_message` or copied into a model-facing tool result.\n\nAsync-subagent common spawn explicitly loads `dcp/subagent.ts` for every role\nand attempt, without interactive `/dcp` commands or the full suite. The normal\nDCP configuration and model overrides still apply. Enabled `compress` survives\nrestricted/empty work-tool lists, CLI exclusions and model selection; read-only\nchild/council guards allow this context-only operation. Async children are always\npersisted sessions and use the normal journal. An in-memory (unpersisted) session\n","startLine":1,"endLine":66},{"path":"wiki/decisions/0069-parent-owned-implementation.md","quote":"# 0069 — Parent-owned implementation and a smaller role pool\n\n- Status: accepted\n- Recorded: 2026-10-11\n- Decided: 2026-10-11\n- Owner / approval evidence: user approved tighter delegation after discussing\n  duplicated context/cost and explicitly selected removal of both bundled\n  `implement` and `delivery-review` in this task conversation.\n- Governing spec: [async-subagents](../tools/agents/async-subagents.md),\n  [parent-first routing](../tools/agents/parent-first-subagent-routing.md)\n- Replaces / replaced by: supersedes [0001](0001-subagent-coding-roles.md)\n\n## Context\n\nA default implementation worker encourages paying for both parent discovery and\nworker rediscovery. The prior policy allowed substantial independent parallel\nwork without requiring evidence that the handoff itself was useful. Separate\ndelivery review overlapped focused research and the parent's integration role.\n\n## Observations and sources\n\n- **Verified configuration:** the former bundled pool included `implement`\n  (Luna then Sol), `implement-core` (Sol), `mechanical` (GLM), and a separate\n  `delivery-review`. See the historical [0001](0001-subagent-coding-roles.md).\n- **User concern, not measured result:** duplicated context and coordination can\n  erase savings from lower worker token prices. No matched cost or capability\n  benchmark was supplied; removing roles does not prove a cost reduction.\n- **Current executable contracts:** [policy](../../external/pi-tools-suite/src/async-subagents/core/agent-strategy.ts),\n  [retirement tests](../../external/pi-tools-suite/test/async-subagents/retired-roles.test.ts),\n  [model candidates](../../external/pi-tools-suite/test/async-subagents/model-pools.test.ts),\n  and [selection evals](../../external/pi-tools-suite/test/evals/delegation-policy.ts).\n\n## Decision\n\nThe parent implements by default. Code handoff requires explicit user delegation,\na concrete capability gap in the implementation itself, or sufficiently large\nprescribed mechanical work with deterministic checks and expected net savings.\nArchitecture uncertainty gets a bounded read-only oracle opinion first when\nneeded; that opinion is not permission to transfer implementation. Size,\nparallelism, token price, and model tier alone are not grounds.\n\nRemove bundled `implement` and `delivery-review`, without aliases or deletion of\nproject-local roles. Keep seven roles: `implement-core`, `mechanical`, `research`,\n`verify`, `ui-qa`, `oracle`, and `knowledge-auditor`. Readiness evidence review\nuses `research`; the parent owns the final decision. Existing mandatory real UI\nQA, complex architectural review, and final documentation gates remain intact.\nModel candidates for retained roles do not change.\n\n## Alternatives\n\n- Keep `implement` as an explicitly requested general coder: not selected by the\n  user; the remaining `implement-core` can cover explicit implementation requests.\n- Keep `delivery-review`: not selected; focused evidence review fits `research`\n  without creating a second general review role or transferring release authority.\n- Delegate whenever work is parallelizable: rejected because reduced wall time\n  does not establish lower total cost or a capability advantage.\n\n## Consequences\n\nThe default catalog is smaller. Old explicit role names fail unless locally\ndefined, so callers must use the effective catalog. Explicit ordinary coding\nhandoffs now use Sol through `implement-core`, which may cost more than Luna;\navoiding unnecessary handoffs, not universally cheaper workers, is the goal.\nSavings remain an expectation, not a measured outcome. Prompt guidance cannot\nenforce a capability assessment or automatically price coordination overhead.\nLazy session-context references were discussed but are not implemented here.\n\n## Revisit when\n\nComparable completed tasks establish total cost per accepted verified change,\nincluding duplicate context, briefing, failures, review, rework and integration,\n","startLine":1,"endLine":71},{"path":"wiki/tools/agents/parent-first-subagent-routing.md","quote":"   window, capped at 300 seconds, is an explicit dependency wait rather than the\n   default. The separate `wait` action retains its own timeout.\n10. When `knowledge-auditor` is present in the effective catalog, the parent\n    delegates the final task-scoped repository-knowledge pass to it with a\n    concise behavior/result summary and the exact project-relative task-changed\n    paths. The auditor may repair only small confirmed documentation drift;\n    substantial or ambiguous drift returns to the parent for a decision.\n\n## Unchanged behavior\n\nMarkdown definitions, config precedence, role-owned model candidates,\nmodel/thinking overrides,\nspawn concurrency, and child model fallbacks remain unchanged. Every child is\nstarted with `--no-skills`; any `--skill \u003cpath\u003e`, `--skill=\u003cpath\u003e`, or\ncaller-supplied `--no-skills` arguments are stripped before invocation, so no\nchild role (including `ui-qa`) discovers or receives skills. This is role\nselection, not model routing.\n\n## Verification\n\n- `test/async-subagents/routing.test.ts`: explicit bypass and validation,\n  omitted/mixed tasks, disabled/unavailable routing, invalid/partial responses,\n  provider errors, fallback models, cancellation, and project Markdown roles.\n- `test/async-subagents/tools.test.ts`: public and internal spawn errors are\n  visible and create no run state; explicit spawns still apply their profiles\n  with the router disabled.\n- `test/tool-descriptions.test.ts`: parent catalog and tool guidance agree.\n- Opt-in live selection evals verify the parent-first boundary in both\n  directions: a targeted root-cause investigation and a compact already-specified\n  implementation stay in the parent without a `subagents` call, while an\n  explicit delegation request still produces one role-appropriate spawn without\n  model/thinking overrides or progress polling. They also distinguish normal\n  explicit parent selection from explicitly requested automatic routing. Direct\n  live evals additionally exercise a project-local Markdown specialist alongside\n  built-in roles.\n\nLive semantic results must be reported separately from deterministic tests.\n\n\n","startLine":79,"endLine":117},{"path":"wiki/tools/agents/owned-launch.md","quote":"# owned-launch — durable detached-descendant containment launcher (candidate)\n\nmacOS-only candidate implementation of the G1/T3 containment architecture.\nDraft integration in `core/spawn.ts` selects this launcher for\n`pi-claude-code-provider`; runtime stop, recovery, and cleanup also participate.\nThis wiring is **not yet accepted**: the real Pi/provider lifecycle matrix and\nindependent review must pass before G1/T3 can close.\n\nlaunchd jobs do not inherit the caller's TCC grants. `access-probe.ts` checks,\nwith a throwaway launchd job, that the project and run directories are\nreachable; when they definitively are not (external volume, no GUI domain),\nthe Claude-provider attempt falls back to the ordinary process-group launch\n(progress `owned_launch_unavailable`). An undecided probe keeps owned launch.\n\nGoal: a launched sub-agent's **entire descendant tree** — including\ndetached, `setsid`'d, exec'd, TERM-resistant descendants — is durably owned\nand cleaned up even when Pi, the bridge, and the worker are lost\nsimultaneously, with **no PID-based kill fallback**, no lost fork race, and\nno signal ever sent to an unrelated process.\n\n## Topology\n\n```\nPi (parent)\n └─ bridge                 detached process-group leader (parent's direct\n     │                     child; stdio JSONL RPC preserved; group signals\n     │                     reach only the bridge)\n     │ bootstraps (gui/\u003cuid\u003e, KeepAlive)\n     ▼\n  launchd ── supervisor    per-run UUID job; survives Pi/bridge/worker loss;\n     │                     owns worker job creation; journals before release\n     │ bootstraps (gui/\u003cuid\u003e, RunAtLoad, no KeepAlive)\n     ▼\n  launchd ── worker gate   per-run UUID job with its OWN fresh launchd\n     │                     resource coalition; parks until release, then\n     │                     forks a waitable payload (pi) in that coalition\n     └─ payload + all descendants (setsid/exec/…) stay in the coalition\n```\n\nPer-run UUID labels (`org.pix.\u003cuuid\u003e`) mean every launchctl action can only\never address jobs this launcher created; cleanup never sweeps by name or\nPID.\n\n## Launch sequence and durable ownership\n\n1. **TS launcher** (`launcher.ts`): prepare binaries asynchronously, then\n   `launchOwnedAgentSync({ binaries, … })` performs a normal synchronous\n   spawn using prebuilt binaries (the compatibility `launchOwnedAgent()`\n   wrapper prepares asynchronously). It creates a 0700\n   hidden staging dir and atomically publishes the complete spec under a fresh\n   UUID (existing path refused), resolves a sockets dir\n   (0700; short paths keep sockets beside the journal, long paths use a\n   fresh `mkdtemp` so `sockaddr_un.sun_path` stays under 104 bytes), writes\n   the 0600 `spec.txt` (borrowed env/argv/cwd + binary paths + labels +\n   timeouts) plus `claim_protocol` and a strictly increasing `generation`, invokes `beforeSpawn` to persist runtime\n   ownership metadata,\n   then spawns the bridge detached with piped stdio and a\n   minimal environment (`/bin/launchctl` is reached by absolute path).\n2. **Bridge** (`native/owned-launch-bridge.c`): validates 0700/ownership of\n   run and sockets dirs; takes the **exclusive launch claim** (`claim`,\n   published with `link(2)`; exit 17 when restart recovery already fenced\n   the run, 18 on claim I/O failure — both before any bind or launchctl\n   action; if the claim was already published, 18/13/14 first write a\n   durable `prelaunch_abort` record); binds four 0600 UNIX listeners (`control.sock`,\n   `stdin.sock`, `stdout.sock`, `stderr.sock`; `EADDRINUSE` fails closed —\n   stale entries are never unlinked); writes its diagnostic identity;\n   bootstraps the **supervisor** launchd job (KeepAlive) and verifies\n   `launchctl print` sees it; arms a 90 s root startup watchdog; then\n   relays stdio. The bridge never creates the worker job and never signals\n   anything.\n3. **Supervisor** (`native/owned-launch-supervisor.c`): connects the\n   control socket (fail closed if the bridge never appears — no worker job\n   exists yet, so nothing was released); creates the **worker** launchd job\n   itself (the bridge-bootstrap race is structurally avoided); waits for\n   the gate's `worker.json`.\n4. **Worker gate** (`native/owned-launch-worker-gate.c`): obtains its\n   kernel-issued audit token, its job's fresh resource coalition id, and\n   the boot identity; connects the stdio sockets (it never reads them, so\n   prompt bytes stay queued in the sockets across the park); publishes\n","startLine":1,"endLine":79}],"notices":["Неопределённость 1 не прошла проверку: цитата отсутствует в предоставленном тексте.","Список источников в сохранённом отчёте сокращён по размеру; объём выполненной проверки указан отдельно."],"coverage":{"scope":"retrieved-passages","checkedPassages":35,"candidateSources":116,"excerptedSources":26,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"],"retainedPassages":12}}} -->

# async-subagents (as-is spec)

<!-- markdownlint-disable MD013 MD022 MD031 MD032 MD040 -->

> Risk classes: **background jobs / concurrency / process management**. Spawns,
> monitors, stops, retries (with model fallback), and cleans up child pi
> processes ("sub-agents") from a parent pi session.
>
> _Investigated by a read-only sub-agent; re-verify claims against current code
> before relying on them. Line numbers are approximate._

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

Decision rationale: [0069 — Parent-owned implementation and a smaller role pool](../../decisions/0069-parent-owned-implementation.md)
(supersedes [0001](../../decisions/0001-subagent-coding-roles.md)).

Headless system for running isolated async sub-agents. Each sub-agent is a
separate `pi --mode rpc` child process that receives a task prompt via stdin
JSONL and streams RPC events back on stdout. The parent persists durable
lifecycle patches in its session custom entries and overlays live process state
in memory; it exposes tool + slash-command interfaces. `[confirmed by code]`

## Current behavior

### Parent orchestration guidance

- For non-UI work, the injected cost-aware strategy tells the parent to do the
  shortest discovery pass needed to resolve user intent, semantics, and the main
  causal path before delegating. When a few targeted repository/context searches
  or reads already establish the diagnosis and desired behavior, the parent
  continues directly rather than spawning research that duplicates the same
  investigation. `[confirmed by code, core/agent-strategy.ts]`
- The parent writes code by default. Implementation delegation requires an
  explicit user request, a concrete capability gap in the implementation itself,
  or sufficiently large prescribed mechanical work with deterministic checks and
  expected net savings after handoff overhead. Size, parallelism, isolation,
  token price, and worker availability alone are insufficient. Difficult
  architecture calls for bounded read-only `oracle` advice first when needed;
  the parent still implements unless a concrete implementation gap remains.
  Research addresses named uncertainties or independent
  evidence tracks. When the user requests independent investigation/review tracks,
  spawn scoped research agents before doing those tracks in the parent; a serial
  checklist is not delegation. Mandatory UI QA and architectural review gates remain
  exceptions, as does final knowledge maintenance. Implementation delegation begins only after cause,
  desired behavior, and acceptance criteria are settled; the prompt prefers the
  smallest coherent slice over broad speculative cross-layer edits. Product/UX
  decisions and integration stay with the parent. `[confirmed by code,
  core/agent-strategy.ts and tool-descriptions.ts]`
- For `oracle`, bounded means a narrow review scope, not a short runtime cap.
  Parent guidance omits both spawn-level and task-level `timeoutSeconds` unless
  the user explicitly requests a different budget, retaining the configured
  watchdog (3 hours by default). Briefs name one concrete question/invariant,
  task-changed paths/diff and exclusions, not a repository-wide audit. The bundled
  oracle reads adjacent contracts as needed, excludes unrelated worktree changes,
  stops at an evidence-backed verdict, returns coverage gaps and the next question when needed,
  and avoids exhaustive exploration or broad test suites. Timeout is incomplete
  work, not proof of a model/provider stall or an automatic model-switch trigger.
  This is prompt guidance: explicit timeout overrides and configured watchdogs
  remain honored; model selection and fallback behavior are unchanged.
  `[confirmed by core/agent-strategy.ts, agents/oracle.md;
  tests: test/tool-descriptions.test.ts, test/async-subagents/core.test.ts
  under external/pi-tools-suite/]`
- After spawn, the parent continues any independent work. It does not poll or
  wait merely for progress; waiting is reserved for a child result that truly
  blocks the next decision when no independent parent work remains. If the user
  changes requirements, the affected worker is stopped or rescoped before it
  continues editing. `[confirmed by code, core/agent-strategy.ts and
  tool-descriptions.ts]`
- Spawn's optional `watchSeconds` defaults to `0`: after validation, routing and
  scheduling, it returns without waiting for child completion. Positive watch
  windows remain opt-in and capped at 300 seconds, for a true dependency with no
  independent parent work. This does not change the separate `wait` timeout,
  concurrency queue, cancellation, retries or completion notifications.
- The bundled pool contains seven roles: `implement-core`, `mechanical`,
  `research`, `verify`, `ui-qa`, `oracle`, and `knowledge-auditor`.
  `implement-core` (Sol only) handles approved capability-driven or explicitly
  requested implementation handoffs. `mechanical` (GLM-5.3 only) handles prescribed
  behavior-preserving transformations large enough to amortize handoff overhead,
  not a few replacements. Broad migrations and semantic test changes must not
  go to `mechanical`. Workers verify interfaces/types and focused regressions
  after an early coherent slice, preserve negative/hidden-blocker assertions,
  and report partial work honestly. These are prompt contracts, not automatic
  rollback/checkpoint enforcement. Parents compare cost per accepted verified
  change including failed attempts, review, rework, duplicated context, briefing,
  and integration, not token price alone. Parallel execution can reduce latency
  without reducing total cost; model tier or review success alone is not proof
  of an implementation capability advantage.
  For optional delegation, compare the remaining parent work, not the original
  task size, with that full handoff cost. Unclear savings or comparable costs
  favor continuing in the parent; explicit user delegation and mandatory gates
  still take precedence. This is a brief judgment, not an extra cost-estimation
  tool call or verbose justification. Worker briefs state shared context once
  and prefer exact paths/ranges plus essential facts over copied files or
  history repeated across `task`, `scope`, and `parentObjective`.
  Research/verification/UI QA/knowledge-auditor/oracle candidate policies are
  unchanged. `[confirmed by agents/*.md, core/agent-strategy.ts;
  tests: test/async-subagents/model-pools.test.ts,
  test/prompt-evals/async-routing-e2e.test.ts under external/pi-tools-suite/]`
- Bundled `implement` and `delivery-review` are removed, with no alias. An
  explicit request for either is an unknown-role error unless a project-local
  Markdown profile defines that exact name; custom roles remain supported.
  Ordinary/readiness review is a focused `research` task, actual checks belong
  to `verify`/`ui-qa`, and the parent owns the readiness decision.
- `/ultrawork` and its auto-classifier do not override these delegation grounds.
  Explicit user invocation authorizes scoped delegation; an automatic suggestion
  is not a user request. Broad scope alone must not trigger immediate workers.
  These are prompt contracts, not a runtime capability or cost estimator.

### Spawn (`core/spawn.ts`)
1. Each sub-agent is spawned via `node:child_process.spawn()` running the pi binary in RPC mode. `[confirmed by code, spawn.ts ~188]`
2. **Pi invocation resolution** (`core/pi-invocation.ts`): detects how pi was launched (Bun virtual script, direct node script, or generic runtime). Direct pi entrypoint → `process.execPath + [currentScript, ...args]`; generic node/bun → `pi` from PATH; Windows → `process.execPath args`. `[confirmed by code]`
3. **Pi args**: `--mode rpc`, `--session-dir <dir>` (and `--session <file>` on resume), `--no-extensions`, `--extension <model-tools>`, the allowlisted provider dependencies of the final model (`--extension <antigravity-auth>` or the suite-local `claude-code-provider/index.ts` entrypoint), `--no-skills`, `--model <model>`, `--tools <list>` (or `--no-tools`), `--thinking <level>`, filtered extra user args, `--models <effective-model>`, then `--extension <tool-guard>`. The final model scope prevents persisted `enabledModels` or an extra `--models` value from resolving unrelated providers in the isolated child. Skill flags from `extraArgs` are stripped, so child agents never discover or receive skills. Before anything else, `-m value`, `--model=value` and `--provider=value` in extra args are normalized to `--model value` / `--provider value` (the installed Pi CLI documents the long, space-separated forms), so owned-launch selection, provider dependencies and the child all see the same final model. `[confirmed by code, spawn.ts, provider-extensions.ts; confirmed by tests, core.test.ts, provider-extensions.test.ts]`
4. **Stdin RPC**: sends two JSONL messages — `{type:"get_state",id:"sub_get_state"}` then `{type:"prompt",id:"sub_prompt",message:<prompt>[,images:<base64[]>]}`. Stdin stays open; EOF = pi shutdown. `[confirmed by code]`
5. **Extensions** loaded into children: `model-tools` (model-specific tool args) and `tool-guard` (strips parent-only tools: `question`, `subagents`, all `async_subagents_*`). Provider dependencies come from an explicit allowlist in `core/provider-extensions.ts`, recomputed on every attempt (retry and provider-changing fallback) from that attempt's final model:
    - `todo/subagent.ts` is also loaded for **every role**, including project-local roles, and automatically for future roles. It exposes regular `todo` actions with a private child-session/attempt list. This is a planning exception to work-tool restrictions: restricted/empty role tool selections and extra CLI tool flags retain `todo` while preserving restrictions on work tools. Children neither read nor write the parent's project `.pi/todo-plan.json`. Retries/new attempts start with a new list; optional child session history stores local snapshots, branch navigation replays only that branch, and compaction retains unfinished tasks with a fresh snapshot. For parent progress reporting, todo state is sent as a private telemetry-only RPC `setWidget` notification; no interactive widget or child UI is installed. The parent progress is live state, not a sidecar file. It exposes optional progress to Desktop: each visible compact subagent icon has a 2px progress track above it, 2px from the icon's top at 70% opacity, showing completed/total fill (including an empty track at 0/n). Absent, empty and completed plans have no track; popup progress rings/counts and overflow behavior are unchanged, with no parent-plan aggregate. This progress does not update/share the parent's todo state, and completing a plan does not mean the agent has finished. The lean entrypoint does not load persistence commands, interactive UI widgets, thinking overrides, auto-follow-up turns or the parent's knowledge-audit reminder. Recursive delegation and interactive user questions remain denied. Children use todos for non-trivial multi-step work and report unfinished work/blockers to the parent; trivial work needs no plan. See [decision 0059](../../decisions/0059-subagent-private-todos.md), with the common-capability exception expanded by [decision 0060](../../decisions/0060-subagent-read-only-repo-tools.md). `[confirmed by todo/subagent.ts, async-subagents/core/todo-progress.ts; tests: test/async-subagents/todo.test.ts, todo-progress.test.ts]`
   - `repo-discovery/subagent.ts` is loaded for every child role and attempt. It registers the same unrestricted `project_search` schema and execution as ordinary Pi: all five sources (`sessions`, `tasks`, `commits`, `code`, `knowledge`), all supported options, and `patch:<literal>`. This applies equally to async children, provider children and council participants. The child facade only suppresses suite setup commands and parent orchestration guidance; ordinary role work-tool restrictions and parent-only delegation guards remain. Repository semantic embedding requires valid explicit global `search.embedding` configuration and respects enabled project sources; there is no independent consent flag or confirmation step. Children inherit this authorization but cannot configure providers. Legacy external-backend setup/update commands are removed. See [0060](../../decisions/0060-subagent-read-only-repo-tools.md), [0068](../../decisions/0068-global-semantic-configuration.md) and [project search](../../search/project-search-agent-tool.md). `[confirmed by repo-discovery/subagent.ts, core/child-tools.ts; tests: test/async-subagents/repo-tools.test.ts, provider-child-inventory.test.ts]`
   - `dcp/subagent.ts` loads DCP for **every role and attempt**, including project-local replacements and read-only council participants. It uses normal DCP configuration/model overrides, prompts, compression and lifecycle hooks but registers no interactive `/dcp` commands. `compress` is a common capability alongside private todo and unrestricted `project_search`: empty/restricted tool lists, CLI exclusions and model changes cannot remove it when DCP is enabled. Read-only guards permit context compression, not product-source mutation. Disabled DCP configuration still suppresses registration. Child sessions are always persisted and use the normal journal contract (and survive `send` cold resume). This does not enable session persistence or load the whole suite. See [DCP lifecycle](../../context/dcp.md#lifecycle-and-persistence). `[confirmed by dcp/subagent.ts, core/child-tools.ts, core/spawn.ts; tests: test/async-subagents/dcp.test.ts, provider-child-inventory.test.ts, work-tools.test.ts]`
   - Optional work capabilities are tool-driven, not universal or granted by role
     name. Bundled `research`, `implement-core`, `mechanical` and
     `oracle` opt into read-only `ast_grep`; only bundled `research`
     adds `web_search`/`web_fetch`. Executors explicitly retain the existing
     seven builtin work tools. Project-local full replacements do not inherit
     these optional choices. Common launch preserves supported extension names
     through model alias selection, derives capabilities from the final CLI
     allowlist/exclusions and loads `async-subagents/work-tools.ts` only when an
     optional tool survives. It registers only requested tools, no commands,
     `ast_apply`, LSP or full suite. Empty/no-tools selections, later lists and
     exclusions may remove optional tools; universal todo/DCP/repo is unchanged.
     Every attempt overwrites `PI_SUBAGENT_WORK_TOOLS`, preventing inherited
     capability contamination. Read-only optional selections retain canonical
     builtins (not Codex's grep-to-shell alias), reselect only available permitted
     tools on session/model/before-agent events and reject non-allowlisted calls.
     Executing selections retain existing mutation authority without web by
     default. Research uses web for public evidence, never secrets/private data
     or local discovery, and reports access gaps rather than configuring keys.
     Existing web adapters, credentials, cancellation and fallback are reused.
     Brainstorm council participants are ordinary `research` children; the
     skill's `council-guard.ts` further narrows them to read/grep/web/project_search
     (see [brainstorm](../../assistants/brainstorm.md)). Inventory tests do not prove research
     quality/live services; privacy guidance is not a network/filesystem sandbox.
     See [decision 0061](../../decisions/0061-subagent-scoped-ast-web-tools.md).
     `[confirmed by core/child-tools.ts, core/spawn.ts, work-tools.ts, agents/*.md;
     tests: test/async-subagents/work-tools.test.ts, provider-child-inventory.test.ts]`
   - `antigravity-auth` is restored after `--no-extensions` only when the effective explicit task/CLI model is `antigravity/<model>`; a model sourced only from `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` does not opt it in. Later `--model`, `-m`, or `--model=...` extra args override the task model for this decision.
   - A final model on `pi-claude-code-provider` (including the environment model) injects exactly one trusted suite-relative `src/claude-code-provider/index.ts`. No user/project settings or npm package lookup participates. The local manifest retains the characterized `0.5.0` identity; standalone and declared entrypoints must stay inside the module's realpath root. Explicit `--extension`/`-e` entries are inspected against the child cwd: one local entry is reused, distinct local entry aliases or any external/npm copy of this provider are rejected before launch. Owned launch, dependency injection and the child share `selectsClaudeProvider` over the trimmed task/environment model and normalized final CLI model/provider/scope. The legacy locator injection remains only as a test seam, not a production discovery path.
   - A missing local module, invalid metadata or unsupported version raises `ProviderExtensionError` (`provider_not_installed` / `provider_metadata_invalid` / `provider_version_unsupported`, bounded message with model, package and an action hint) before any child artifact or process exists. The synchronous throw is permanent: no retry and no model fallback, the concurrency slot is released and the bounded launch-failure artifacts are written.
   `[confirmed by code, spawn.ts, provider-extensions.ts; confirmed by tests, core.test.ts, provider-extensions.test.ts]`
6. **Environment**: child inherits parent env plus `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION=1`, `PI_TERMINAL_BELL_DISABLED=1`, and `PI_TOOLS_SUITE_DISABLED_MODULES` appended with `async-subagents,coding-discipline,question`. `[confirmed by code, spawn.ts ~230-240]`
7. **Model selection**: explicit forced/task/CLI model wins. Otherwise the
   resolved role profile and optional parent-model mapping produce the ranked
   candidate list. For bundled explicit-model roles only, suite
   `builtinAgentModels` supplies a per-role primary; later user/project suite
   config layers merge this map by role, and `null` clears an inherited entry
   back to the current suite default. Desktop exposes searchable pickers
   discovered from bundled profiles (not a separate role list); unknown stored
   refs are retained, and Reset removes the current layer's choice. Project
   local full profile replacements are unaffected and continue using the
   Registry override file. Project suite-config `builtinAgentModels` entries
   are ignored for disabled/unknown roles and frontier/automatic roles (use
   `frontierModels` for those). Fresh launches see changes; already-running
   children keep their selected model. Bundled roles with no configured choice
   use their authored primary. Roles with `modelSelection: frontier` use the
   suite config's
   `frontierModels` list. Economy mode removes `expensive` frontier models.
   Explicit task/CLI/forced, global, and per-role environment model priorities
   remain higher than suite choices; they do not rewrite the fallback policy.
   Bundled fallback order is preserved with the selected primary deduplicated.
   `parentProviderPolicy` then applies `any`, `prefer-other`, strict
   `require-other`, or `require-other-if-frontier` semantics relative to the
   known parent model's vendor (model family, not provider string).
   Runtime model selection removes unavailable/image-incompatible candidates,
   and session fallback skips models/providers already exhausted by quota
   failures. The fallback layer follows the already-resolved chain; it does not
   independently force a provider change. Per-role environment model overrides
   are applied while loading the effective role catalog.
   `[confirmed by code, config.ts/model-selection.ts/model-fallback.ts]`
   Installed project agents may also have a project-local primary-model choice
   in `.pi/agent-model-overrides.json` (version 1 with a `models` map). It is
   loaded from the owning project `.pi` beside the selected `.pi/agents`
   directory (including launches from nested working directories) for fresh
   configurations only and applies below explicit task, CLI,
   and global choices but above the authored profile/parent selection; per-role
   environment choices retain priority. The choice changes only the primary
   candidate, preserving authored profile and matching parent-branch fallback
   candidates, and existing economy/vendor policies still apply. Removing a
   name from the map restores the current authored profile or parent mapping.
   Only project-local named profiles with explicit model configuration are
   eligible; built-ins, removed agents, automatic profiles and
   `modelSelection: frontier` profiles are ignored. This file is independent
   of authored definitions and Registry sync/hash/publication. Malformed or
   unsafe state fails closed at runtime and Registry writes refuse it.
   `[confirmed by project-model-overrides.ts, config.ts; tests:
   project-model-overrides.test.ts]`
   Legacy singular role selectors normalize with an explicit `fallbackModels`
   array (including `[]`), and every normalized `modelByParent` entry carries
   its own fallback array. Modern `models` profiles already encode the complete
   ordered candidate chain. `[confirmed by code, config.ts]`
   The bundled `oracle` uses `modelSelection: frontier`,
   `vendorsByParentVendor`, and `parentProviderPolicy: require-other`. Its
   profile pairs OpenAI parents with Anthropic candidates, Anthropic parents
   with OpenAI candidates, and other parents with OpenAI then Anthropic;
   missing parent identity or no eligible paired candidate fails closed. GLM
   is never an oracle candidate. The vendor map orders vendors first, then
   candidates follow `frontierModels` order within each vendor. A new frontier
   model is a `frontierModels` config entry, not an oracle edit.
   After strict `require-other` validation, the runtime appends a model-selection
   confirmation with the parent model/vendor and the cross-vendor guarantee for
   the selected candidate and eligible fallback chain, including when a prompt
   override replaces the task brief. Non-strict policies do not receive this
   guarantee. Oracle relies on that runtime check instead of refusing work when
   the task brief omits the parent's identity; unknown-parent and same-vendor
   launches remain blocked by model selection.
   The shipped frontier list is Astra, GLM-5.3, and
   `anthropic/claude-opus-5-5` with alias `*opus*` (any serving provider).
   Sol is not frontier. Astra is enabled for `oracle` in the default list.
   Economy mode excludes both expensive candidates for OpenAI, Anthropic, and
   Z.ai parents under the default pairing, hiding the oracle from those parent
   catalogs. The oracle prompt also limits consequential decisions to one
   question each and forbids re-invoking merely to confirm an earlier answer.
   The bundled `frontier-review` role has been merged into `oracle` and removed;
   oracle has no parent-tier visibility gate. User/project roles and model lists
   remain explicit overrides and are not rewritten. Oracle provides both a
   deliberate second opinion and the independent architectural review gate.
   The review gate applies **only to complex architectural tasks** after
   implementation and targeted checks: consequential changes to subsystem
   boundaries, core interfaces, or cross-module lifecycle/persistence invariants.
   Routine features, local bug fixes, mechanical edits, role availability, and
   large diffs alone do not trigger it. The parent classifies the task; this is
   instruction policy, not a runtime complexity classifier. This replaces the
   code-review portion of [decision 0001](../../decisions/0001-subagent-coding-roles.md);
   the parent-owned implementation and role-retirement policy is recorded in
   [decision 0069](../../decisions/0069-parent-owned-implementation.md).
   The retained `implement-core` role uses Sol; `mechanical` uses GLM-5.3.
   Other retained role candidate policies are unchanged. Project-local profiles
   with retired names remain valid; there are no aliases.
   GPT-6 Sol is not an alias for GPT-6.1 Sol. Existing user/project model
   lists still override defaults and are not rewritten by this rollover.
   `[confirmed by frontier-models.ts and agents/*.md]`
8. **Role router / auto-ultrawork classifier**: the role router and the
   `ULTRAWORK_AUTO` classifier both try `routing.model`, then
   `routing.fallbackModels`, then the current parent model, de-duplicating refs
   and continuing past unavailable/provider-error candidates. Abort remains
   terminal. `[confirmed by code, routing.ts/ultrawork-auto.ts]`
9. **UI QA special role**: `ui-qa` is the only built-in real-UI role for
   browser, terminal/TUI, desktop-GUI, and explicitly selected Android verification. `browser-qa` is not an
   alias; a project may define that name only as an ordinary independent role.
   Like every async sub-agent, `ui-qa` runs without skills. UI QA additionally receives
   `PI_SUBAGENT_AGENT_DIR` plus launcher-owned `PI_UI_QA_RUNNER` and
   `PI_BROWSER_QA_RUNNER` paths, and gets private `ui-qa/flows/` plus
   browser-backend `ui-qa/browser/flows/` workspaces.
   The start prompt is a thin common contract: the child loads exactly one
   backend guide (`browser`/`tui`/`desktop`/`android`, plus `browser --topic auth` only
   when authentication is required) through the read-only allowlisted
   `PI_UI_QA_RUNNER guide` command before any UI action. The unified runner
   selects browser, PTY/TUI, desktop, or Android ADB/UI Automator backends from a declarative
   target and owns bounded execution/evidence cleanup.
   `[confirmed by code,
   config.ts/routing.ts/spawn.ts/ui-qa-runner.mjs]`
10. **Bundled-role visibility**: top-level pi-tools-suite config may list role
    names in `disabledBuiltinAgents`. The list follows the normal suite config
    layer order; a later `enabledBuiltinAgents` entry removes an inherited
    disable. Filtering happens after the bundled Markdown catalog is cloned and
    before project `.pi/agents/*.md` definitions merge, so a project-local role
    may intentionally reuse a disabled built-in name. Disabled built-ins are
    absent from the parent catalog, explicit-role validation, and automatic
    routing. A project-local role whose filename exactly matches a bundled role
    replaces that bundled profile completely; omitted fields are not inherited.
    The parent catalog explicitly lists active project replacements. There are
    no role-name aliases or partial-merge exceptions. `[confirmed by code,
    config.ts/agent-catalog.ts; confirmed by tests, core.test.ts]`
    `knowledge-auditor` is a low-thinking economical docs-only role with a
    20-minute default timeout. Before task completion the parent supplies the final
    behavior/result and exact task-changed paths. The child updates affected
    documentation from relevant implementation/tests, fixes small proven drift
    and returns substantial or ambiguous discrepancies to the parent.
    It also accepts explicit **spec-review** assignments with exact documentation
    paths and a review goal. Neither mode runs knowledge dirty/acknowledgment,
    index refreshes or exhaustive dependency traversal. No search installation,
    initialized index, global clean verdict or review receipt is required.
    Results contain changed documentation paths and concrete unresolved questions,
    not global knowledge-state reporting. Preserve concurrent work and keep
    disposable reports under `.pi/artifacts/`.
11. **Session persistence and parent state**: every child is a full Pi session stored at `<cwd>/.pi/subagents/<parentSessionId>/<childSessionId>.jsonl`. `agentId` is the subagent launch identifier (often supplied as `task.id`), distinct from the UUID Pi assigns to the child session; the parent records the session file reported by the child, and `subagent_meta` maps that session back to `agentId`. The parent stores durable lifecycle/index patches as custom entries in its own session and reconstructs records by folding them in order. Process handles, live activity, full result text and other transient data remain in a live in-memory overlay; there are no regular-agent sidecars or `registry.json`. A batch is an identity label, not a directory. Legacy run directories are ignored and are not migrated. `[confirmed by code and tests]`
11a. **Follow-up turns (`send`)**: the parent may continue a child's conversation by `agentId`.
    - **Live delivery** — while the child process is still running and its live channel is open, the message is written to the child's RPC stdin as `{type:"prompt", message, streamingBehavior: "followUp"|"steer"}` (default `followUp`). Pi queues it while streaming, or starts a new run when idle; the tool returns the reported disposition. The latest turn's full result text is read from the child session.
    - **Settled race** — when `agent_settled` arrives while a live send is pending or was accepted during the current run, termination is deferred: the child is asked for `get_state` and terminated only if it is neither streaming nor has pending messages. Once settled termination is scheduled the channel is closing; new live sends are refused and the tool waits (up to 15 s) for the process to finish, then falls back to cold resume.
    - **Cold resume** — a terminal child with a persisted session is relaunched under the project concurrency semaphore using that session. The send increments the turn, clears prior process identity while queued, and replaces the current result with the latest turn's text; no turn archives or launch-spec sidecars are created. Launch failures are recorded in the parent session state. In headless mode, cold `send` runs through the detached broker like `spawn`; the broker tracks the resumed `agentId` until its final completion receipt.
    - Before relaunch, cancellation is refreshed from the parent's durable entries (or a fresh read of the stable-key headless journal), without replacing other in-memory record fields. It is checked after the semaphore wait and again after any awaited owned-provider preflight; a requested stop cancels the queued relaunch without spawning a child.
    - A non-terminal agent without a live channel (e.g. owned by another parent process) is refused rather than relaunched concurrently. `[confirmed by code, core/spawn.ts, core/live-channel.ts, core/store.ts, tools/send.ts; tests: send.test.ts]`
12. **Timeout**: default 3 hours (10,800 seconds; `DEFAULT_AGENT_TIMEOUT_MS`) when no task-, spawn-, role-, or global-level timeout is configured. Explicit `timeoutSeconds`/`timeoutMs` values override this default, including values longer than 3 hours; the default is not a hard cap. For macOS owned-launch agents, the supervisor's native watchdog defaults to the same 3 hours and receives the resolved per-agent timeout for explicit overrides. Timeout and terminal outcome are recorded in parent-session entries; ordinary process termination behavior is unchanged. `[confirmed by code]`
13. **agent_end**: finalizes the parent record; no result sidecar is written. `[confirmed by code]`
14. **RPC prompt failure** (`success=false`): records failure in parent state, not in a result file. `[confirmed by code]`
15. **Exit handling**: waits 10ms for stdio flush, then finalizes. Exit-code resolution: timed_out→124, completedFromAgentEnd→0, lastAgentEndError→1, numeric→code, signal→128, else→1. `[confirmed by code]`
16. **Parent billing accounting**: every finalized child assistant `message_end` with valid provider/model/usage is mirrored into the originating parent session through a durable `appendUsage("async-subagent", ...)` record. The spawn tool uses the captured parent session manager rather than whichever tab/session is active when a background child later finishes. Retries and provider/model fallbacks therefore record every billable child call. `[confirmed by code and async-subagents-usage.test.ts]`

### Parent completion delivery

- Decision: [0044 — Retractable parent completion delivery](../../decisions/0044-retractable-subagent-completions.md), superseding [0031](../../decisions/0031-subagent-completion-delivery.md).
- The optional parent [Heads Up observer](../../assistants/observer/heads-up-observer.md#delegated-work-first-increment)
  receives a separate runtime-only evidence bridge: spawn captures session/anchor
  ownership before routing awaits, and final retry/fallback completion publishes
  a bounded child-reported result. This is not a parent message, wakeup, verified
  mutation/test receipt or an additional completion-delivery channel. It does not
  change wait/watch arbitration and does not replay adopted launches. Rationale:
  [0034 — Heads Up observer](../../decisions/0034-heads-up-observer.md#delegated-evidence-follow-up-2026-10-04).
- A tracked child's terminal status (`done`, `failed`, or `stopped`) remains
  extension-owned and retractable while the parent is busy, rather than entering
  the SDK follow-up queue immediately. At the successful `agent_before_settle`
  boundary, still-unconsumed completions become `async-subagents-agent-completion`
  custom-message drafts with one continuation request. An idle parent is woken
  via `triggerTurn: true`, `deliverAs: "followUp"`; only one idle wakeup is submitted
  per reconciliation. Autonomous watcher/reconciliation wakeups are gated from
  `agent_start` until this extension's `agent_settled` hook observes the outcome;
  this prevents an idle-looking SDK state from waking the parent while earlier
  asynchronous settlement hooks are still running. A normal settlement releases
  the gate, preserving ordinary idle wakeups. An aborted settlement keeps it held
  until the next `agent_start`: completions remain pending (not acknowledged or
  discarded) and are delivered exactly once at the next run's normal
  `agent_before_settle` boundary. Completions arriving after the boundary remain
  eligible at settlement or the next two-second watcher tick. `[confirmed by code,
  index.ts/core/notifications.ts/completion-delivery.ts]`
- `wait` reserves only its selected tracked agents in the originating session;
  `spawn` reserves its newly scheduled agents before launch. During that call,
  reconciliation defers their follow-ups. A successful final tool response
  consumes only terminal agents actually present in its final snapshot.
  Reservation release and acknowledgement are synchronous, before reconciliation.
  A timeout/fail-fast response may consume a subset; remaining children retain
  automatic notification. A completion arriving after a nonterminal snapshot
  is not consumed. Abort or error releases reservations without acknowledgement.
- Reservations are scoped to live launch objects, not just agent IDs, and
  overlapping calls release only their own reservations. Polling does not report
  an in-process intermediate disk receipt as terminal while its final
  retry/fallback callback is pending. Successful `result` tool responses also
  acknowledge the matching final state captured before execution. Successful
  Tool hooks inspect `tool_execution_end`, after all `tool_result`
  transformations; acknowledgement is tool-execution evidence, not proof that
  an outer script printed the result. Already delivered SDK
  messages are not retracted. Arbitration is in-memory for the current extension
  instance, not a durable cross-restart delivery ledger.
- Completion callbacks and the two-second disk watcher share reconciliation:
  removing the tracked child before delivery prevents duplicate notifications.
  In-process launches wait for their final retry/fallback callback rather than
  treating an intermediate attempt's disk receipt as final. The watcher handles
  running children adopted after extension reload.
- A completion belonging to another session stays pending until that parent
  session is active again. Session shutdown suppresses wakeups and keeps pending
  entries untouched during cleanup.
- Deterministic entrypoint tests cover idle-parent delivery, terminal statuses,
  duplicate refreshes, session isolation and shutdown suppression in
  `external/pi-tools-suite/test/async-subagents/tools.test.ts`. Arbitration,
  watched spawn/wait callbacks, filtered waits, timeout-boundary races, abort,
  error, fail-fast, busy-parent boundary delivery and result/artifact receipts are covered in
  `external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`.
  Normal-settlement release, aborted-settlement hold, idle-before-settled-hook
  suppression, and next-run exactly-once delivery are covered by
  `external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts` and
  the real-SDK regression `external/pi-tools-suite/test/async-subagents/completion-abort-sdk.test.ts`.

### Concurrency (`core/concurrency.ts`)
- `createSemaphore(limit)`: `limit ≤ 0` = unlimited. `acquire(signal?)` queues when full, rejects on abort. `[confirmed by code]`
- Project-scoped semaphores cached in a `PROJECT_SEMAPHORES` Map keyed by resolved cwd; reused if same limit or if active/waiting > 0. `[confirmed by code, tools/spawn.ts ~50-58]`
- Default max concurrent = 5 (`DEFAULT_MAX_CONCURRENT`); configurable only through `PI_SUBAGENTS_MAX_CONCURRENT` or `ASYNC_SUBAGENTS_MAX_CONCURRENT`. Preset files configure model pools only and do not accept `maxConcurrent`. `[confirmed by code, core/config.ts:673-699]`

### Retry (`core/retry.ts`)
- `spawnAgentWithRetry()` wraps `spawnAgent` with retry + model-fallback loops. `[confirmed by code]`
- **Retry eligibility** (`shouldRetry`): status not `stopped`, exitCode ≠ 0; if `retryableExitCodes` is set the code must be in it; `undefined` → retry any non-zero; empty array → disable. `[confirmed by code, retry.ts ~140-148]`
- **Backoff**: exponential `delayMs = retry.backoffMs * 2^(attempt-1)`. `[confirmed by code]`
- **Retry metadata**: retry count, pending state and next retry time are kept in parent-session custom entries/live state, not sidecar files. `[confirmed by code]`
- **Model fallback** (before retry): if `isQuotaLimitCompletion` and a fallback exists, respawns immediately (no backoff); fallback metadata is recorded in parent state. `[confirmed by code]`
- `AbortSignal` cancels pending retry timer and settles immediately. Returns `{initial, done}`; `done` resolves when all attempts finish or abort. `[confirmed by code]`

### Model fallback (`core/model-fallback.ts`)
- In-memory session state: `exhaustedModels`/`exhaustedProviders` Sets, `fallbackByModel`/`fallbackByProvider` Maps; resettable via `resetSessionModelFallbacks()`. `[confirmed by code]`
- `selectSessionModelWithFallback` / `nextFallbackModel` walk the resolved chain skipping exhausted models/providers. They do not independently require a different provider; remembered provider exhaustion can exclude same-provider candidates. `[confirmed by code; model-pool-contract.test.ts]`
- `isQuotaLimitCompletion` scans available in-memory result text and stderr tail for quota indicators. `[confirmed by code]`
- Antigravity providers are **never** marked exhausted at the provider level (`shouldRememberProviderExhaustion` returns false) — each account is tried individually. `[confirmed by code]`

### State (session-native store)
- Parent-session custom entries hold durable lifecycle patches; live process state overlays them in memory. Results come from the child session or a parent-authored failure message, with compact structured data in the parent record. There is no `result.json`, pid file, or registry. `[confirmed by code]`
- Planned/queued and retry-pending records may persist optional `ownerPid`, identifying the runtime that owns their semaphore wait or retry timer (not the child PID). External readers report those states while that PID is alive; a missing/dead owner means the queue/timer is no longer owned and the record reads as stopped. Launch clears `ownerPid`; scheduling a retry writes the current runtime PID. These records do not make queued work recoverable after its owner exits.
- Status reconciliation checks live process state and durable lifecycle records; `wait` polls the scoped read model until terminal or timeout. `[confirmed by code]`

### Durable records and lookup
- Parent-session custom entries are folded in order to reconstruct scoped
  records; the in-memory store overlays process handles and transient state.
  Headless calls with a stable host session key use a deterministic UUID scope
  and `.pi/subagents/<scope>/headless-parent.jsonl`; without a key, state is
  process-local. A journal over 32 MiB or a non-ENOENT read failure is
  diagnosed (without logging journal contents) and propagated; it is not
  treated as an empty scope. Store hydration likewise propagates read errors
  and remains retryable rather than caching a failed empty read. `[confirmed by code]`
- `runDir` is a compatibility alias for a batch label, not a directory. Lookup
  is scoped to the current parent session; agent id without a batch resolves to
  the latest-launched matching record. Legacy timestamp run directories are
  ignored and not migrated. `[confirmed by code]`
- `/sub-open` opens only a terminal child session; it refuses a nonterminal
  child so the interactive session and its running process cannot write the
  same transcript concurrently. `[confirmed by commands.ts]`

### Cleanup (`core/cleanup.ts`) / Stop (`core/stop.ts`, `core/process.ts`)
- Session shutdown stops that session's subagents; it does not delete child
  sessions or parent journal records. Sibling-session agents are not stopped;
  reload/fork continue to skip shutdown stopping. Process cancellation/ownership
  safeguards are unchanged. Explicit cleanup and Desktop cleanup are separate
  deletion mechanisms; see [project-state cleanup](../../work-management/registry/resource-registry-project-state.md).
  `[confirmed by index.ts and tools.test.ts]`
  Decision: [0043 — Preserve subagent evidence on session shutdown](../../decisions/0043-subagent-evidence-retention.md).
- Explicit `cleanup` removes legacy timestamp run directories and orphan session scopes, while preserving scopes with owned-launch state that must remain. It does not act as a migration or legacy reader. `[confirmed by code]`
- `stopAgents` records stop state in the parent session and signals the tracked process/process group; it does not write stop/result sidecars. `validateStopSignal` allows only SIGTERM/SIGINT/SIGKILL. ESRCH handled gracefully. `[confirmed by code]`
- With launcher-owned `process_group` metadata, `stopAgents` uses
  `terminateProcessTree`: POSIX signals the negative Pi PID (its process group),
  not every descendant. A descendant that starts a separate group/session is
  outside this boundary and can survive force stop. Graceful child forwarding
  is not evidence of cleanup after `SIGKILL`. On missing group (`ESRCH`), the
  helper does not fall back to a potentially reused positive PID.
  `[confirmed by process.ts/stop.ts and process-topology.test.ts]`
- `test/async-subagents/process-topology.test.ts` and its
  `fixtures/process-topology.mjs` characterize this POSIX boundary offline:
  same-group cleanup, detached survival, graceful forwarding, and an unrelated
  control process. These are OS-topology fixtures, not real Pi/provider tests
  or an acceptance claim for Claude cleanup. Detached-provider rollout remains
  gated on a separately proven lifecycle mechanism; the characterization must
  not be used to weaken that requirement.

#### G1/T3 durable ownership candidate (not yet accepted)

`core/owned-launch/` now contains a macOS candidate launcher integrated in
`core/spawn.ts`, but it is not an accepted replacement for the lifecycle
contract above. Its intended boundary is a
fresh launchd resource coalition for ordinary unprivileged fork/exec
descendants, including detached process groups and sessions. A separate
KeepAlive supervisor must durably record ownership before payload release,
recover by cancelling, and retain responsibility while cleanup is uncertain.
Signals must use authentic generation-bound audit tokens after membership
validation. Empty PID enumeration, bridge exit, RPC completion and a stop
request are not cleanup receipts.

**launchd access fallback.** launchd-started jobs do not inherit Pi/Pix privacy
(TCC) grants, so a project on an external/removable volume (or another
TCC-protected location) is unreachable by the supervisor/worker. Before an
attempt that may select `pi-claude-code-provider`, `tools/spawn.ts` asks
`core/owned-launch/access-probe.ts` whether a throwaway UUID-labelled launchd
job (`org.pix.launchd-probe.<uuid>`, plist in a private `/tmp` dir) can list
both the project cwd and the run directory. Definitive `ok`/`denied` verdicts
are cached per directory set for the process lifetime; concurrent callers share
one probe (~0.1 s). On `denied` (including a refused bootstrap, which is not
cached) the attempt uses the ordinary process-group launch with the provider
dependency unchanged, writes progress stage `owned_launch_unavailable`, and
reports `suite:owned-launch-unavailable` (warn). An undecided probe (`unknown`,
timeout/IO) keeps owned launch (fail closed). The fallback has the ordinary
process-group containment guarantees only, not durable descendant ownership.
Parent loss is covered: the child Pi sees RPC stdin EOF and exits, and the
Claude provider's `process.on("exit")` hook (`claude-process.ts`) synchronously
SIGKILLs every Claude CLI process group not yet proven terminated, because Pi's
RPC shutdown calls `process.exit()` without awaiting the SIGTERM→SIGKILL
escalation. Descendants that left the group (`setsid`/daemonized) are not
covered. `[tests: provider-parent-loss.test.ts]`
`[confirmed by code: access-probe.ts, tools/spawn.ts, core/spawn.ts; tests:
owned-launch/access-probe.test.ts, provider-extensions.test.ts]`

The failure model covers process crashes and ordinary descendant fork/exec,
not external deletion, renaming or corruption of the private ownership
directory, privileged coalition migration, or work delegated to unrelated
system services. Pi/Pix itself must retain every ownership directory until
both UUID launchd services are independently confirmed absent. Kernel-zero
containment and service retirement are distinct facts: a drain receipt alone
must not authorize deletion or reuse of recovery artifacts. A release racing
bridge loss may transiently launch work; the guarantee is eventual verified
drain, not an atomic promise that no payload instruction runs after loss.

Acceptance requires receipt-gated spawn/state/stop/cleanup integration,
preserved payload exit status, nonblocking stdio forwarding, and the complete
offline lifecycle matrix using real Pi plus the unmodified provider. The first
native draft failed independent review (startup parsing/bootstrap defects,
false-success paths and ownership abandonment); those defects must be repaired
and re-reviewed before G1/T3 can close. The repaired draft passed native
fixture tests, but review additionally found receipt-before-retirement,
one-shot completion polling, and post-spawn metadata publication gaps.
Draft repairs now persist metadata before spawning, continuously reconcile
receipts after bridge loss, recover terminal exit status from durable records,
and require independently confirmed absence of both UUID jobs before artifact
deletion or reuse. Ambiguous `launchctl print` results are not absence; only
the exact missing-service result can retire a job. Retirement markers are
atomically replaceable so an interrupted write can be repaired.

Restart reconciliation must continue after recovering `exit_code` until every
generation is retired; that exit record alone is not terminal authorization.
Preparation publishes a complete spec and a `claim_protocol` declaration from
a hidden staging directory before publishing the ownership pointer. Hidden
staging leftovers are retained: age does not prove that a paused launcher
cannot resume. Likewise, elapsed startup grace, an absent journal, and absent
jobs do not prove a pending generation was never launched.

Late launch is excluded by an exclusive per-generation launch claim. The
bridge and restart recovery each write a complete record to a private temp
file and publish it as `claim` with `link(2)`, which refuses an existing
target. The bridge claims before binding any listener or running any
`launchctl` action and exits (17) on a fence, so a fenced generation provably
bootstrapped nothing and released nothing. Recovery fences only unclaimed
generations that declared the protocol, are not held by a live in-process
launch handle, and are older than a grace period; the grace protects a slow
live launcher's liveness, never safety. A parent whose own reaped bridge
never claimed may fence at once. A fenced generation without a journal or
receipt is `never-launched`: exit 1, slot released, and deletable only after
both UUID services are independently confirmed absent. A bridge that wins
the claim but fails deterministically before any `launchctl` action (listener
bind 13, plist 14, claim directory fsync 18) durably writes `prelaunch_abort`,
which is also `never-launched`. Any other bridge-claimed generation stays
pending until the supervisor's receipt; a bridge crash or bootstrap failure
between claim and supervisor bootstrap remains pending (fail closed). Legacy
generations without the declaration, and legacy `never_launched` markers,
never resolve. Bridge exit cleanup unlinks only listeners it bound itself.

Each generation also publishes a strictly increasing `generation` record with
its spec. The agent's outcome is the newest generation's, so a stale pointer
or a retry crash before the pointer write (older retired directories remain)
cannot hide it; legacy ties fail closed. Reconciliation never persists a
recovered exit for a run this process still holds a live launch handle for —
the in-process settle loop owns that completion — and an owned attempt that
is terminal and retired but has a pending retry reports `retrying`.

Runtime completion and retry callbacks wait for service retirement as well
as a verified drain. A terminal failure without kernel-zero proof remains
non-deletable even after both services disappear. Pointerless or unreadable
ownership metadata with surviving UUID directories selects durable cancellation
of those directories, never a saved-PID signal or an immediate `stopped` record.
Preparation failures before spawning roll back their fresh directories; bridge
spawn failures retain an explicit `bridge_launch_failed` marker. An unproven
failure releases its slot only when retired and journal-less (the supervisor
journals before any release). These cases must not
strand a concurrency slot. An intentional cancellation after RPC settlement
preserves the RPC outcome (including failure); a fake CLI's exit code is not
the exit code of its still-running Pi RPC payload.

Native binaries are built once per source fingerprint: concurrent first launches in one process share a single build, and separate processes build under private temp names published by atomic rename, so parallel cold-cache spawns and crashed-build leftovers never fail a launch (found by the live T9 concurrency smoke). Live Claude smokes T4–T9 (`test/live/claude-provider-live.test.ts`, opt-in `PI_CLAUDE_LIVE=1`, isolated Pi state, provider paid-launch cap) cover parent tool round trip/abort, DCP projection/evidence/compression, DCP Claude summary and timeout fallback, todo persistence/compaction/resume, and owned Claude children (success, stop, timeout, `maxConcurrent`).

The bridge treats owner-stdin EOF as cancellation, not ordinary payload EOF.
Print-mode integration tests therefore give the real Pi payload `/dev/null`
without closing the owner channel. Output sources are excluded from polling
while their relay queue holds bytes: HUP must neither overwrite queued output
nor cause a busy loop under backpressure. The real pipe/socket regression
checks over 256 KiB on both stdout and stderr, final JSONL integrity, and owner
EOF after the worker stops reading stdin.

Opt-in tests from removable-volume checkouts must use an internal-volume
snapshot with copied dependencies and fixtures, not symlinks back to the
checkout. macOS permission-blocked timeouts are inconclusive. The corrected
real Pi/unmodified-provider launcher matrix passes eight cases; runtime-path
verification and fresh independent reviews still gate acceptance. Historical
fixture successes below do not waive these gates. Provider installation,
authentication, live inference and resolver rollout are outside this work.

#### Offline G1 ownership prototype (test-only; gate remains open)

`test/async-subagents/ownership-prototype.test.ts`, its bounded cleanup harness,
and the split
`fixtures/ownership-{owner,wrapper,guardian,cli}.mjs` model a possible POSIX
ownership topology, not the installed provider or Pi. A fake Pi owner hosts a
private Unix socket and authorizes each connection with a per-owner credential.
A detached-per-request wrapper must authenticate *before* spawning a non-detached
guardian; that guardian independently authenticates and confirms its own PGID
membership before declaring ready. Only then can the wrapper launch a fake CLI
non-detached. The guardian holds a private IPC liveness channel from the wrapper
and its own owner socket; either EOF/error triggers `SIGKILL` of the captured
group while the guardian is still a member. Once guardian readiness is verified,
the wrapper also anchors its own launch-time verified PGID and kills that group
if the guardian unexpectedly exits or disconnects; this fallback covers guardian
loss with the fake CLI active. It does not hold provider stdout or stderr handles.
Wrapper exit follows actual fake CLI root exit, including exit codes 0 and 7
after explicit completion with a surviving descendant. The socket credential
and trusted detached-wrapper launch topology are fixture inputs, **not** an assertion that
arbitrary wrappers or current provider launch/auth support this mechanism.

Deterministic IPC barriers exercise owner death before authorization and with a
resistant CLI active; wrong credentials fail closed *before spawning*. At an
unreleased guardian-ready barrier owner death leaves no CLI, but this does not
prove an atomic owner-death/no-launch guarantee. A separate release-versus-owner-
SIGKILL race permits transient launch after previously granted authorization and
checks eventual bounded teardown of any recorded actors. Tests also check direct
guardian SIGKILL with active resistant CLI and leaf, explicit root completion
survivor cleanup, concurrent owner/guardian loss, provider-style negative-PGID
SIGTERM, and isolation between concurrent groups and an unrelated control.
Assertions observe liveness before
fixture finally/backstop cleanup. These offline tests do not close G1/T3: the current
provider's auth preflight is non-detached, its request child is detached, and its
environment allowlist removes arbitrary transport configuration; integrating
owner transport and credentials with real Pi/provider, and testing the actual
provider+Pi matrix, remain unresolved. No runtime behavior changes here.
`joint-race.test.ts` characterizes a **rejected** terminal-ordering candidate:
in the fixture's actual CLI `exit` callback, a test-only marker and self-`SIGSTOP`
preempt the wrapper immediately before its synchronous `process.exit`. With the
wrapper still live and owning its group, killing the guardian and verifying it
nonlive before `SIGCONT` lets wrapper exit with the natural CLI code (0 or 7),
while a resistant leaf is still live before fixture cleanup. An unrelated control
survives. This demonstrates that separate guardian-loss and natural-completion
cases do not prove their combined ordering; it is fixture topology evidence,
not Pi/provider integration. The fixture does not model the provider's follow-up
cleanup after child exit, so this is not an observed real-provider orphan.
ACK *after* group `SIGKILL` is not a valid remedy:
that signal kills wrapper and guardian too. G1/T3 remain blocked pending a
proven production ownership and terminal-arbitration protocol.

#### macOS native relay experiment (test-only; no production integration)

`test/async-subagents/fixtures/native-ownership.c` and
`native-ownership.test.ts` exercise a narrower candidate with real macOS
`fork`/`setpgid`/`waitid`/`waitpid`/signals. Relay A stays outside B's group;
its direct child B is the group's sentinel and launches fake CLI C and a
SIGTERM-resistant same-group leaf D. A holds the sole writer of B's private
liveness pipe. B kills its own group on A EOF; B reports **actual** C wait
status to A (0 or 7). A never auto-reaps B: even if B dies after reporting,
`waitid(P_PID, B, ..., WEXITED|WNOHANG|WNOWAIT)` can observe B as a waitable
zombie before A kills `-B` and finally reaps B. A missing C report after
readiness fails closed (90), not fabricated success. If B dies before startup
topology verification, `getpgid(B)` may fail even though C/D already joined
B's group.
A checks the unreaped child's exit state, sends `SIGKILL` to **negative** B
before reaping even on startup failure (never to positive B), then closes its
private liveness writer so a still-running, pre-group B can create its group
and self-clean on EOF; startup failure exits 98 after reaping B. A test-only
pre-ready `SIGSTOP` checkpoint permits B
to launch C/D before the test kills B into a zombie, then resumes A and
checks nonzero failure and dead descendants *before* harness cleanup. A
separate checkpoint after the real C report verifies kernel-stopped A, B's
zombie, and A's subsequent WNOWAIT evidence before group cleanup; healthy
completion, B loss before report, and A SIGKILL/pipe EOF remain separate
cases. A (and C) explicitly restores waitable default SIGCHLD disposition without
`SA_NOCLDWAIT`. Fixture-local generous watchdogs bound running actors, not a
basis for passing assertions. They cannot release a SIGSTOP checkpoint if the
test runner itself is killed; the harness's bounded waits and finally path
resume checkpoints during ordinary failures. Harness best-effort
cleanup aggregates errors and verifies recorded topology plus a live member
before negative group signaling; that ps-to-signal check is non-atomic and is
**not** production ownership proof. Only A holds the direct-child anchor; the
harness is not a general process killer. An unrelated control stays isolated.

This only demonstrates a native ownership/terminal-ordering primitive for
this **single same-group topology**. No Pi binding, provider authentication
preflight, private transport configuration, provider stdout ownership, or
timeout/stop matrix exists. Simultaneous A+B SIGKILL and descendants calling
`setsid`/escaping B's group are not contained. PID-reuse nonoccurrence is not
proved by finite tests. Related public Apple XNU source supports the anchor:
[`forkproc` reserves zombie IDs](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_fork.c#L975-L978),
[`WNOWAIT` skips reaping](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_exit.c#L3244-L3249),
and [reaping leaves the group and removes the PID hash entry](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_exit.c#L2806-L2823).
Group signaling targets eligible live members, not the zombie leader itself.
This public `xnu-10063.141.1` source is related to, but not an exact verified
match for, the test host's `xnu-10063.141.1.712.16~1` build; it is not a blanket
guarantee across macOS releases. A must stay alive and retain its waitable child.
This does **not** close G1/T3 or change runtime code.

#### Zombie-member PGID discriminator (test-only; macOS host observation)

`test/async-subagents/zombie-member-pgid.test.ts` compiles the standalone
`fixtures/zombie-member-pgid.c` with warnings as errors. The test binary Q
forks detached/session-leader A. A forks K; K moves to its own group **in A's
session** and forks Z. Z joins A's group, acknowledges its group/session, and
exits; K proves Z is its direct waitable child with `waitid(WNOWAIT)` and holds
it unreaped. A relays that private-pipe topology and exits; Q positively
`waitpid`-reaps A **before** attempting negative-A **signal 0 only**. Q
records its exact return/errno, K's liveness, and K's second WNOWAIT status
7 before K reaps Z. Completion-pipe EOF confirms K closed that descriptor
after its report; Q exit or owner-pipe closure alone would not prove K reaped
Z. An early-stdin-EOF case retains Z through the probe. Native watchdogs
limit K's lifetime independently of Q: this topology does **not** guarantee
that the captured number still identifies A's group at probe time. No
SIGTERM/SIGKILL probe is safe here. The JS runner observes stdin errors and
write/end callbacks, bounds both the initial wait and independent final close,
and retains the fixture directory if either Q close or K completion cannot be
confirmed. It may signal
only its owned direct Q child as a backstop, never a recorded PID/group. This
remains an OS fixture, not a provider test.

On the tested macOS host, the verified topology was A group/session A,
K group K/session A, Z group A/session A; both Z wait observations reported
exit status 7. An **earlier exploratory** run observed `-1`, `errno=1`
(`EPERM`) for signal 0, SIGTERM, and SIGKILL after A's reap; those destructive
observations are historical only and are **not** retained regression probes.
The safe regression checks **only signal 0** returning `-1`, `errno=1` (Darwin
EPERM), alongside the second WNOWAIT status 7 and K's completion EOF. The
measured result is **EPERM**, not the hypothesized ESRCH. Separately, source
inspection of the unchanged 0.5.0 snapshot's `src/process-utils.ts` shows that
`waitForProcessGroupExit` treats signal-0 EPERM as possible continued existence,
not successful disappearance; `terminateProcessGroup` rejects TERM/KILL EPERM
as a cleanup error. The native test does not invoke that provider function.
Thus the proposed zombie-only-group-as-ESRCH handshake is not supported on
this host. This neither proves safe provider cleanup nor contains escaped
descendants or arbitrary joint failures, and is not a proof that every
integration-only design is impossible. G1/T3 remain blocked; runtime/provider
behavior is unchanged.

#### Session-only anchor discriminator (test-only; macOS host observation)

`test/async-subagents/session-only-anchor.test.ts` compiles
`fixtures/session-only-anchor.c` with warnings as errors. Unlike the rejected
zombie-member experiment, **no member remains in A's process group**: A creates
a session, forks K, and K moves to PGID K while retaining SID A. After K's
private readiness acknowledgement, A exits and native Q positively reaps A.
Q checks `getsid(K) == A` and probes **only** `kill(-A, 0)`. Both explicit
release and early runner-input EOF cases observe `-1`, `errno=3` (Darwin
`ESRCH`), followed by K's completion report with SID A and completion-pipe EOF.
Runner EOF is forwarded only after the probe. No destructive signal targets a
recorded PID/group. The runner reuses the bounded stdin/close/retention helper;
its only termination backstop targets its owned direct Q child. Native
watchdogs bound the experiment but can release K independently of Q, so this
is a finite topology observation, not an indefinite identity guarantee.

The related public XNU commit linked above supports the narrower identity
argument while the session reference remains:
[new groups retain their existing session](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_proc.c#L2505-L2568),
[leader exit clears the leader pointer](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_exit.c#L2340-L2348),
and [final session release removes its hash entry](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_proc.c#L2369-L2400).
PID allocation excludes session-hash IDs. Additionally,
[`setpgid` requires an existing group when the requested PGID differs from the target PID](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_prot.c#L614-L630).
Thus a retained SID A can reserve the number without leaving a zombie-only
PGID A that produces EPERM. This is not an exact host-source match or a proof
across all macOS releases.

**Remaining ownership gap:** in actual integration, Pi **P** spawns wrapper
**A**, which forks **K**. An external Q that owns P does not thereby acquire
wait/reap ownership of A or K. K is not Q's direct waitable child; after A
exits, unexpected K loss and subsequent reap can release the
session before P's delayed negative-A signal. A private registration socket,
PID polling, or releasing K only after P exits does not itself prevent K's
earlier death. The test does not bind K to actual Pi, prove safe keeper loss,
or exercise provider force/timeout/concurrency. G1/T3 remain blocked; this
positive discriminator is not lifecycle acceptance or a runtime change.

**Read-only ptrace follow-up:** XNU's
[`PT_ATTACH` path](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/mach_process.c#L241-L300)
can reparent K to tracer P after authorization, but identifies the target by
numeric PID. `PT_TRACE_ME` instead uses the caller's current parent: K cannot
use it to select grandparent P. Registration followed by attach alone is
unsafe if A and K both disappear and K is reaped before the attach. Neither
socket registration nor checking identity immediately before attach makes
that lookup atomic. No ptrace call or actual PID-reuse attack was executed.

The inspected host Node v26.7.0 reports libuv 1.52.1 and links Homebrew libuv.
Matching upstream libuv
[`uv__wait_children`](https://github.com/libuv/libuv/blob/1cfa32ff59c076ffb6ed735bbc8c18361558661f/src/unix/process.c#L101-L148)
iterates registered process handles and calls `waitpid(process->pid, ...)`,
not `waitpid(-1, ...)`; the kqueue branch registers `NOTE_EXIT` per spawned
child. This removes a source-level objection that this loop necessarily reaps
an unknown attached K. It is not a binary-equivalence or actual-Pi retention
test, nor proof of all signal dispositions, other reapers, attach permission,
or safe native integration.

A narrower, **unimplemented** single-loss protocol would keep A alive and K
waitable until P acknowledges attachment, with no K watchdog/EOF exit while P
may still attach. K loss alone then leaves A retaining its PID; A loss alone
requires K to remain alive. Joint A+K loss before attachment remains outside
that argument. Observing P exit without signaling a numeric PID is a separate
unproved startup/cleanup requirement; registration failure cannot silently
release K or turn a leaked keeper into success. This hypothesis does not
authorize reducing G1/T3's required failure coverage.

#### Actual Pi/provider offline contract (test-only; not native relay integration)

`test/async-subagents/provider-offline.test.ts` launches the installed **Pi CLI**
through Node in RPC mode, explicitly loading the maintained suite-local provider
by default. A missing vendored module fails rather than silently skipping.
For historical comparison only,
`PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT=/absolute/local/snapshot` selects an external
0.5.0 snapshot; absent/malformed sources or mismatched original process/cleanup
hashes fail. The staging helper copies manifest, entrypoints, `src`, `extensions`
and `bridge`, verifies copied source hashes and records a private snapshot
manifest. Local SDK peers and the vendored provider's explicitly declared
`jsonc-parser` dependency are symlinked without installing or fetching; external
historical snapshots do not inherit undeclared dependencies.

Each run has a fresh private HOME, agent directory, cwd, settings and temp root.
The Node executable is resolved locally from the runner executable or PATH,
then probed with a bounded subprocess under a minimal environment (not inherited
`NODE_OPTIONS`); PATH is used only for locating candidates. Pi gets only explicit
whitelisted environment variables; no real auth, project
config, inherited extension discovery, provider web search, tools, context
files, skills, templates, themes, model defaults, telemetry or online catalog
refresh. The provider's **existing** `PI_CLAUDE_CODE_PROVIDER_PATH` points to
the executable test fake: its captures show `--version`, `auth status`, and
`--help` all ran against that fake. The fixture advertises a synthetic eligible
subscription and produces a synthetic initialized Claude stream; it never
authenticates, calls Claude, starts a network connection or spawns descendants.
Pi's correlated RPC state/model responses establish real registration and
explicit model selection. The fake's captured argv and JSONL stdin establish
provider launch flags, empty MCP catalog, disabled tools, and input framing.
Pi's actual RPC final message completes successfully for fake exit 0 and
**fails** (stopReason `error`, not success) for fake exit 7 even after a
synthetic successful result; Pi RPC itself can still exit 0.
Pi RPC uses observed stdin writes/errors and bounded response waits. Its close
is confirmed before removing the private workdir even on failure; the fake
records per-launch nonce/PID start and synchronous exit markers and has its own
independent watchdog. Cleanup requires the four expected launch markers plus
exit markers and signal-0 absence checks, not a fixed startup delay or an empty
directory. An early Pi failure before all four launches conservatively retains
the workdir. Missing exit evidence also retains it and reports an explicit
cleanup failure. No recorded PID receives a termination signal; PID reuse can
cause conservative retention, not termination of its new owner. The fixture
starts no descendants. These safeguards depend on this fixed fake-only launch
contract; they are not production ownership or a general arbitrary-launch proof.

A separate spy-only call to this same snapshot's exported
`terminateProcessGroup` confirms that it first attempts `SIGTERM` on a
negative PGID even when the supplied ChildProcess already has `exitCode=0`.
No real OS signal is sent. In the provider's success path,
`supervisor.wait()` and stdout drain precede `running.terminate()` and only
then does exit/result validation publish success (`src/provider.ts`). This
creates a **new unresolved A post-exit PGID identity question**: with the
actual unmodified provider and native relay A outside B's group, Pi observes
A's exit before cleanup, so A may already have been reaped by Pi when provider
cleanup signals `-A`. Retaining B anchors B's identity, not A's former PGID.
A successful spy call is **not** an
actual PID-reuse counterexample, and these tests do not show a real misdirected
signal. Resolve ordering/identity against the actual relay boundary, not by
claiming B's zombie anchor automatically protects A's former PGID. This baseline
harness proves no A/B binding or owner-death/force/timeout/concurrency contract;
the isolated patch experiments below are separate. G1/T3 remain blocked; no
installed provider or production runtime has been changed.

#### Isolated offline provider relay patch (test-only)

`provider-native-patch.ts` copies the adapter into a hash-checked private
provider snapshot; neither `/tmp/package` nor any installed extension is
modified. macOS-only `provider-native-patched.test.ts` exercises actual Pi RPC
fake exits 0/7 and a compiled `-Werror` A/B/C relay against the staged
provider: C natural 0/7, a resistant leaf, private-control EOF, direct A loss,
joint control/A loss, B loss, idle/total timeout and concurrent cancellation.
P spawns non-detached A with a private control pipe, so ordinary provider stdin
completion is not cancellation. A retains its direct child B unreaped through
negative-B group cleanup; B monitors A-only liveness and self-kills its own group
on EOF. C closes inherited private descriptors before exec. Provider termination
closes control and validates receipt/close rather than signaling A's recorded PID
or former group after Node reaps it. A receipt records successful group signaling
and B reaping, not an atomic observation that every descendant has disappeared;
the lifecycle cases additionally observe their known actors before teardown.
The staged spawn preserves both `stdin: "pipe"` and `stdin: "ignore"`; the
ignored-stdin regression also completes with validated cleanup.
Checkpoints include abort before B readiness (which can fail without a relay
receipt and must retain `livenessUnknown`) and a C status observed by A while
its direct waitable B remains held before B is killed. A's test-only fault
commands target only that direct waitable child; injected post-cleanup failure
returns `FAILED:98`, never `CLEAN:98`, and an omitted receipt is also rejected.
The adapter consumes receipt/errors immediately with a 64-byte buffer limit,
checks stream/control/child close errors and requires an exact `CLEAN:<exit>`
receipt. The separate staged adapter test covers early stream error, oversized
input, control EPIPE and close without end. Harness waits and finalization are
bounded by wall-clock deadlines; incomplete cleanup preserves its workdir.

`provider-native-owner-loss.test.ts` separately starts installed Pi RPC with the
isolated patch and `fixtures/provider-owner-loss-cli.mjs`, waits for an active
request and resistant leaf in B's group, then SIGKILLs only its directly owned
Pi child. Both actors must be observed dead before test cleanup and before their
independent watchdog deadlines. Failed process observation is an error, not proof
of absence. This proves that single-Pi-death case with A retained, not Pi-group
force, simultaneous A/B loss, escaped groups or production ownership. G1/T3
remain blocked. No runtime rollout, install, auth inspection or live Claude call
follows from these results.

`provider-native-boundaries.test.ts` characterizes two remaining counterexamples
with `fixtures/provider-boundary-cli.mjs`. In a private compiled relay copy,
the joint-loss checkpoint kills A's direct waitable B and holds A before its
group cleanup; the harness then kills its directly owned A. Same-group C and
its leaf remain alive and adapter termination rejects. Separately, a detached
leaf in a different group remains alive after normal C exit and a validated
`CLEAN` receipt. This is an ordered joint-loss counterexample, not a claim that
two signals execute atomically. Neither case asserts that real Claude exhibits
these fixture behaviors. Survivors are observed before watchdog expiry and
before test-owned socket EOF cleanup; known actors must then be observed dead.
No saved descendant PID/PGID is signaled by test teardown. These passing
characterization tests confirm limitations, not G1/T3 acceptance or a general
macOS impossibility result.

#### macOS launchd coalition / audit-token feasibility (test-only; no owner-loss proof)

`test/async-subagents/audit-token-signal-feasibility.test.ts` compiles the
standalone `fixtures/audit-token-signal-feasibility.c` with warnings as errors.
The native parent forks **one direct waitable child** with an independent 8s
alarm. The child obtains its own kernel-issued `TASK_AUDIT_TOKEN` and sends it
over a pipe. Apple SDK `libproc.h` declares
`proc_signal_with_audittoken(audit_token_t *, int)`; `mach/task_info.h` defines
the token request; `mach/message.h` defines `val[8]`; `bsm/libbsm.h` exposes
PID and PID-version accessors. The fixture mutates the token's version slot
and verifies through Apple's accessors that the PID is unchanged and the
version differs. On the macOS 14.6 host (`xnu-10063.141.1.712.16~1`) the
wrong-version `SIGUSR1` returned **3** and set errno **3** (ESRCH), leaving the
child waitable and running; the exact original token returned **0**, and
`waitpid` confirmed death by SIGUSR1 (30). The fixture never enumerates or
signals an unrelated PID; its failure backstop targets only its still-unreaped
direct child. This observes host behavior, not guaranteed future SPI stability.

#### macOS external audit-token acquisition via `task_name_for_pid` (test-only)

`test/async-subagents/audit-token-external-probe.test.ts` compiles the
standalone `fixtures/audit-token-external-probe.c` with warnings as errors.
Unlike the cooperating fixture above, the forked child immediately execs the
unmodified `/bin/sleep 30` and never publishes a token or cooperates; a
close-on-exec pipe write end observes only that the exec itself happened. The
parent then obtains the kernel-issued token externally through the unprivileged
route described in
[Apple Developer Forums thread 652363](https://developer.apple.com/forums/thread/652363)
and implemented by the public
[endpoint-sec crate](https://docs.rs/endpoint-sec/latest/src/endpoint_sec/audit.rs.html#185)
(`AuditToken::from_pid`): `task_name_for_pid(mach_task_self(), pid, &port)`,
then `task_info(port, TASK_AUDIT_TOKEN, ...)`, releasing the port with
`mach_port_deallocate`. XNU `kern_proc.c task_name_for_pid` permits this for
same-euid-and-ruid callers on non-zombie targets, so this does **not** require
the SIP-restricted `task_for_pid`; the earlier research assumption that only a
privileged `task_for_pid` exposes `TASK_AUDIT_TOKEN` is wrong. XNU
`proc_info.c psignal_by_audit_token` resolves through
`proc_find_audit_token`, which validates only the embedded PID (`val[5]`) and
PID version (`val[7]`; on this SDK `audit_token_t` is `unsigned int val[8]`).
The private `PROC_PIDUNIQIDENTIFIERINFO` struct/flavor are copied from XNU
`bsd/sys/proc_info_private.h` and its `p_idversion` (filled by XNU as
`proc_pidversion(p)`) is asserted equal to the externally obtained token's
`audit_token_to_pidversion`, grounding the token-synthesis alternative in
exact XNU source. On the macOS 14.8.7 host the wrong-pidversion exact-PID
`SIGKILL` returned **3** and set errno **3** (ESRCH) while the child stayed
running with an unchanged pid version; the genuine token `SIGKILL` returned 0
and `waitpid` observed death by SIGKILL (9); the task name port was released.
Emergency backstop kills only the fixture's own still-unreaped direct child.
This is a primitive offline proof of unprivileged external token acquisition
and exact-generation rejection, not G1/T3 closure: it does not enumerate
noncooperating descendants, prove PID non-reuse beyond the observed
generation, or integrate any runtime kill path. Runtime is unchanged.

`launchd-coalition-feasibility.test.ts` requires explicit opt-in
`PI_OFFLINE_COALITION_PROBE=1` on macOS and separately compiles
`fixtures/launchd-coalition-feasibility.c`. The private
`PROC_PIDCOALITIONINFO` flavor/struct and resource coalition index are copied
from [Apple XNU `proc_info_private.h`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/sys/proc_info_private.h#L65-L70)
and [Apple XNU `coalition.h`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/osfmk/mach/coalition.h#L78-L82),
not a guessed SDK structure. They are private ABIs; this XNU commit is not
the exact host build. A single UUID-labelled one-shot job is bootstrapped into
the current `gui/<uid>` user session with an owned temporary plist, binary,
and output file; no persistent LaunchAgent is installed. On this host the
direct baseline resource coalition was **7207**, the job's was **7238**, and
the job's fork, `setsid`, and exec stages all reported **7238**. The first
attempt using `user/<uid>` returned bootstrap error 5 (no adoption claim for
that domain); `gui/<uid>` succeeded. Each native actor has its own 5–7s
expiry. The runner bootouts only its exact UUID service in `finally`, checks
that `launchctl print` no longer finds it, and probes only the two recorded
job PIDs with `ps` (never signals them). In the passing run bootout returned
0, print returned 113, and the recorded PID scan returned 1 (no matches).
Missing identities or ambiguous cleanup retain owned files and fail closed.
The test deadline exceeds the sum of command/poll deadlines, leaving margin
for `finally` cleanup; registration ambiguity after a timed-out bootstrap is
reported, not converted into a cleanup guarantee.
Neither finite scan proves perpetual PID non-reuse or automatic descendant
cleanup when both owner and helper disappear.

This is **feasibility**, not a coalition kill implementation: no coalition
member enumeration/signaling, no provider/Pi integration, no proof that
launchd automatically cleans descendants on joint owner/helper death, no
guarantee of a surviving enumerator, and no tested force/timeout/race matrix.
G1/T3 remain blocked. Existing relays and runtime are unchanged.

#### Coalition accounting after leader exit (offline primitive)

`test/async-subagents/launchd-coalition-accounting.test.ts` and
`fixtures/launchd-coalition-accounting.c` use the same explicit macOS opt-in.
A one-shot UUID launchd leader forks a child which calls `setsid()` and
execs unmodified `/bin/sleep`. A CLOEXEC pipe handshake replaces a guessed
startup delay. An external probe observes the recorded leader generation
gone while the resource counters still report one live member, obtains the
child's authentic audit token, kills that exact generation, then requires a
successful resource-usage read with `tasks_started == tasks_exited`.
ESRCH from coalition lookup is not a passing zero observation in this test.
Unexpected process-info/token errors are indeterminate, not proof of death.
Cleanup rejects ambiguous command outcomes and retains artifacts on failure.

This passed on macOS 14.8.7 / Darwin 23.6.0. It establishes the observed
accounting primitive, not durable launcher ownership or G1/T3 acceptance.
The initial source cache is XNU main, not the exact host build. Follow-up
source verification uses the clean public `xnu-10063.141.1` checkout at commit
`d8b80295118ef25ac3a784134bcf95cd8e88109f` (the host's private `.712.16`
build is unavailable):

- [`task.c:1871–1907`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/osfmk/kern/task.c#L1871-L1907)
  adopts a new/exec-copy task into the inherited resource coalition before
  its thread can run; exec-copy adoption overlaps the old task's membership.
- [`thread.c:557–566`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/osfmk/kern/thread.c#L557-L566)
  removes membership as the last active thread terminates.
- [`coalition.c:851–852`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/osfmk/kern/coalition.c#L851-L852)
  reports the started/exited counters under the coalition lock; IDs are
  allocated monotonically within the boot (`:1239`), and reap removes the
  object only after termination and zero active references (`:2032–2075`).
- [`kern_exec.c:3894–3908`](https://github.com/apple-oss-distributions/xnu/blob/d8b80295118ef25ac3a784134bcf95cd8e88109f/bsd/kern/kern_exec.c#L3894-L3908)
  restricts explicit spawn into another coalition to privileged coalition
  members or the private coalition-spawn entitlement.

For a known-populated, boot-bound coalition with no new external privileged
adoption, zero members therefore leaves no member able to fork a successor.
Journal-bound ESRCH can separately mean that exact non-reused coalition was
reaped; an arbitrary unknown CID's ESRCH proves nothing. This is not a sandbox
against privileged actors or work delegated to independent launchd services.
Private-ABI/host-build drift remains a platform-support limitation, not an
inference from passing fixtures that every macOS release is supported.

#### Independent recovery after joint owner loss (offline, cooperating actors only)

`external/pi-tools-suite/test/async-subagents/recovery-owner-loss-feasibility.test.ts`
and `fixtures/recovery-actors.c` / `fixtures/recovery-supervisor.c` extend the
feasibility family with opt-in `PI_OFFLINE_COALITION_PROBE=1` on macOS.
The harness owns fake app A; A owns a direct waitable helper B; B forks C,
which calls `setsid()` and execs. A separate UUID-labelled, one-shot launchd
job R is started before owner loss, outside the A/B lineage. No persistent
LaunchAgent or provider is installed.

A kills and reaps B, then the harness explicitly SIGKILLs its directly owned
A and confirms its signal exit. This is ordered joint loss, not an atomic
simultaneous kill. Before opening the recovery gate, the harness observes C
running (not a zombie), in a separate process group and reparented to PID 1.
R loads the actors' pre-loss checkpoint files, probes authentic audit tokens
for A/B absence and C liveness, then sends C an exact-generation SIGKILL.
R's atomic receipt must report successful delivery and subsequent ESRCH;
the harness separately observes C absent, before `finally` cleanup and with
more than five seconds remaining before C's independent 25s watchdog.

On the recovery experiment's macOS 14.8.7 host, signum 0 was rejected with
EINVAL by `proc_signal_with_audittoken`. Thus these **cooperating fixtures
ignore SIGUSR1**, which R uses for generation-bound liveness probes. This is
not a harmless probe for arbitrary processes. R never fabricates a future
generation for the orphan C: if C died unexpectedly, such a token might
target a reused PID. The earlier direct-waitable-child test separately covers
wrong-generation rejection while retaining the child's identity.

Native actors have bounded alarms; R has a 15s backstop. Temporary job cleanup
bootouts only the exact UUID service and checks its absence plus recorded
R/C PID absence. Process-observation errors are not evidence of death;
ambiguous cleanup retains the owned files and fails. Alarms are failure
backstops, not evidence of successful recovery.

This baseline case proves a **surviving independent recovery owner can clean one known,
cooperating escaped descendant**. The baseline does not use coalition enumeration or
demonstrate discovery of noncooperating descendants, concurrent-fork drain,
restart/loss of R, durable recovery across reboot, private-API portability,
or real Pi/provider integration. G1/T3 remain blocked; runtime is unchanged.

##### Restart variant: fresh R2 rebuilds the target after R1 is killed pre-cleanup

The same files add a second opt-in case covering restart/loss of the recovery
owner itself. R1 is bootstrapped first and, after confirming A/B loss through
its own stale-token probes, writes an `owner-loss-<gen>` marker and parks on a
generation gate the harness never opens, so it structurally cannot reach
cleanup code. The harness then SIGKILLs R1 through exact UUID job control
(`launchctl kill SIGKILL` of R1's exact service; never a saved numeric PID),
requires R1's recorded PID to be ps-absent (existence only), and checks
launchd's recorded last terminating signal is 9. Only then does it boot out
the service and require `launchctl print` to miss it. C must still be alive
and `receipt-a.json` absent after R1's removal. Gate timeout still writes a
failure receipt; neither timeout nor the alarm(15) can substitute for the
asserted SIGKILL termination.

A fresh R2 — a new UUID-labelled one-shot job with a distinct generation
suffix on its supervisor artifacts — then rebuilds A/B/C identity solely from the
persisted pre-loss checkpoint files (token/PID/PID-version still validated
against each other by the libbsm accessors), reports ESRCH for A and B, and,
after its own gate, performs the same exact-token liveness probe, SIGKILL, and
ESRCH confirmation on C. Its receipt and an independent ps absence check must
both land over five seconds before C's watchdog and before `finally`. Distinct generation file
names prevent R1/R2 artifact collisions; R2 reads no R1 receipt or checkpoint
and has no channel to R1's memory.

Deliberately not exercised by this variant's plain-generation R2: the
post-kill/pre-receipt idempotent restart (R1 dying after killing C but before
writing its receipt). Without an explicit checkpoint contract, R2 rejects a
dead target (liveness probe ESRCH → fail receipt, no SIGKILL), rather than
treating an already-absent target as successful idempotent recovery; the
explicit contract is the separate experiment below. All earlier caveats still
apply: cooperating SIGUSR1 probes only, no discovery of noncooperating
descendants, no reboot or general containment claim, watchdogs are failure
backstops rather than proof, and G1/T3 remain blocked.

##### Post-kill/pre-receipt variant: R2 records already-absent recovery from a validated postkill checkpoint

`recovery-postkill-restart.test.ts` (with `recovery-harness.ts`, split from
the earlier files to avoid duplicating the launchd/ps harness) adds the
bounded post-kill/pre-receipt case under two further explicit supervisor
modes in `fixtures/recovery-supervisor.c`; the legacy and plain-generation
contracts above are unchanged. `kill-then-park` R1 confirms owner loss,
parks on its gate, performs the actual exact-token SIGKILL of C, confirms
ESRCH, and only then writes an atomic `postkill-<gen>.json` naming the exact
killed actor identity (token/PID/PID-version), its generation, and the
observed kill result. It then parks on a `receipt-gate-<gen>` the harness
never opens — structurally before any receipt. The harness independently
observes C ps-absent with more than five seconds of watchdog margin, requires
`receipt-<gen>` absent, then removes R1 through exact UUID job control only
(`launchctl kill SIGKILL`, never a numeric PID), requiring launchd's last
terminating signal 9 and R1's PID ps-absence before bootout 0 and print 113.

A fresh R2 (new UUID job, distinct generation, no memory or IPC channel to
R1) rebuilds A/B/C from the persisted pre-loss checkpoints, confirms A/B
ESRCH, and strictly validates the postkill checkpoint: parse, internal
token↔PID/PID-version consistency via the libbsm accessors, recorded
successful kill and confirmed-gone result, kill before the leaf watchdog,
generation match, and cross-check of token/PID/PID-version/deadline against
`leaf.json`. Only then does it probe C's own token and require ESRCH,
writing a distinct `already-absent` receipt recording `kill_attempted=0`
and a NOT_ATTEMPTED `kill_return=-2` sentinel — this mode cannot send
SIGKILL at all. Its receipt and an independent ps absence must land before
`finally` with watchdog margin.

Fail-closed contract, pinned by deterministic negative tests using only
safe original authentic tokens (no future token is ever fabricated or
signaled): a missing checkpoint, an identity-mismatched checkpoint (a really
dead actor's authentic token substituted for the leaf's), and a contradicted
checkpoint (the leaf's own identity claiming a confirmed kill while the leaf
is observably alive) each produce a failure receipt with `kill_attempted=0`.
Additional cases reject trailing fields, extra lines, inconsistent kill/gone
errno values, and a wrong generation. Parsing consumes the complete bounded
record and rejects embedded NULs, truncation, and any suffix beyond its single
newline. C must remain alive after every negative case, dying only by its own watchdog. An
arbitrary dead target therefore never becomes success.

Claim boundary: this proves restart recovery only when the first owner
crashed (process kill) after its confirmed kill checkpoint was published.
It does not cover a crash in the kill-to-checkpoint window (an unrecorded
kill still fails closed under these modes; that window is the separate
opt-in experiment below), power loss, or reboot; watchdogs remain failure
backstops, not proof. G1/T3 remain blocked; runtime is unchanged.

##### Kill-to-checkpoint-window variant: R2 concludes cause-unknown absence from its own probe

`recovery-kill-window-restart.test.ts` (reusing `recovery-harness.ts`; the
pinned post-kill/pre-receipt file is untouched) adds two more explicit
opt-in supervisor modes in `fixtures/recovery-supervisor.c`; every earlier
mode — including the strict `already-absent` missing-record failure — is
unchanged. The published postkill record format and its strict loader now live
in `fixtures/recovery-postkill-record.h`, shared by all restart modes so the
record contract has one owner.

`kill-park-precheck <gen>` R1 is identical to `kill-then-park` through the
real exact-token SIGKILL of C and its ESRCH confirmation, then writes a
`precheck-<gen>` marker and parks on a new `checkpoint-gate-<gen>` the
harness never opens — structurally before any postkill record or receipt
exists. The harness independently observes C ps-absent with more than five
seconds of watchdog margin, requires both `postkill-<gen>.json` and
`receipt-<gen>.json` absent, then removes R1 through exact UUID job control
only (`launchctl kill SIGKILL`, never a numeric PID), requiring launchd's
last terminating signal 9 and R1's PID ps-absence before bootout 0 and
print 113. The crashed owner therefore leaves no durable kill record at all.

`already-absent-unknown <kill-gen>` R2 — a fresh UUID job, distinct
generation, rebuilt solely from the persisted pre-loss actor records, with
no R1 memory, IPC, marker, or receipt channel — confirms A/B exact-token
ESRCH as always, then branches: a *present* `postkill-<kill-gen>.json`
goes through exactly the strict validation above (every loader failure
reason unchanged; a non-ENOENT lookup error fails closed as `unreadable`),
so a present-but-invalid record fails closed **even when C is observably
gone** (`postkill_record=present`); presence itself is classified without
following symlinks — `lstat`, with any nonregular entry rejected
explicitly as present with reason `not-regular` — so a dangling
`postkill-<kill-gen>.json` symlink, which a following `access(F_OK)` probe
would misread as ENOENT, can never enter the cause-unknown path. Only a
genuinely ENOENT-absent record may take the cause-unknown path, where R2's
own bounded (~3s) exact-token
absence probe is the only evidence. ESRCH yields a distinct
`status=ok stage=already-absent reason=cause-unknown postkill_record=absent`
receipt recording `kill_attempted=0` and the NOT_ATTEMPTED
`kill_return=-2` sentinel, still requiring `recovered_at < leaf_deadline`:
the restart may honestly conclude "already absent, cause unknown" — never
kill success or attribution. A live or timing-out target fails
`target-alive/not-absent`; an unexpected probe return fails closed. Neither
new mode can signal SIGKILL on the restart side, and no pre-kill intent
record exists: intent would prove nothing R2 may consume.

Deterministic negative cases pin the fail-closed contract with only safe,
original authentic tokens (no future token is fabricated or signaled):
an ENOENT record with the leaf still alive fails `target-alive/not-absent`
with `kill_attempted=0` and no SIGKILL — both when no record exists at all
and when a well-formed record exists under a *different* generation,
proving there is no sibling-record scan or generation inference — and a
present-but-corrupt record built from the dead leaf's own authentic
identity fails with the strict loader reason although an absence probe
would have succeeded, as does a dangling `postkill-<kill-gen>.json`
symlink with the leaf already dead: a present nonregular entry that must
fail closed with `not-regular` rather than be misclassified as missing by
a following F_OK probe. In the live-target cases, the leaf survives every
failure receipt and dies only by its own watchdog; the corrupt-record and
dangling-symlink cases instead reuse the already-dead leaf from the
positive experiment.

Claim boundary: this proves bounded process-crash recovery inside the
kill-to-checkpoint window, where absence is re-proven by R2's own probe.
`cause-unknown` cannot attribute C's death (R1's kill, the watchdog, or an
external actor). The bounded probe can wait for an in-flight termination,
but this test parks R1 after ESRCH and does not separately prove that race.
It does not prove power loss or reboot
durability (per-file fsync only), PID reuse across reboot, or discovery of
unknown descendants; `wait_gone` ESRCH-as-gone semantics are inherited from
the pinned baseline path. If such a contract were ever ported to
production, `cause-unknown` must remain a distinct class that never feeds
kill-verified metrics, idempotency claims, or retry suppression; a
kill-success claim still requires the durable per-kill record. Gate-park
budgets (8s gate + 8s checkpoint-gate + 8s receipt-gate) can exceed the
supervisor's `alarm(15)` if the harness is slow, same reliance on prompt
harness action as the existing receipt-gate design. G1/T3 remain blocked;
runtime is unchanged.

### Structured results and logs
- Full result text is retained only in child sessions; the `result` action response is bounded to at most 50 KiB. Compact structured result data and parent-authored error/timeout/stop messages are stored in parent-session custom entries. Regular agents do not write result, progress, retry, or stderr sidecars. `[confirmed by code]`
- RPC event transcripts are not written. Current tool activity and stderr tail are live in-memory state and are not restored after parent restart; lifecycle and structured state are represented by session custom entries. `[confirmed by code]`

## Public contracts / inputs / outputs

### Tools (`tools/*.ts`)
- **spawn**: `{tasks: AgentTask[], runDir?, slug?, thinking?, extraArgs?, timeoutSeconds?, watchSeconds?}`. `AgentTask = {id?, task, scope?, subagentType?, model?, thinking?, promptAppend?, promptOverride?, focus?, imagePaths?, tools?, extraArgs?, timeoutSeconds?, parentObjective?}`. `[confirmed by code]`
- `ui-qa` is an explicit built-in role and has no compatibility alias. UI-QA tasks require
  confirmed image-capable model candidates even when `imagePaths` is empty.
  `[confirmed by code, routing.ts/model-selection.ts]`
- **send** `{runDir?, agentId, message, mode?: "followUp"|"steer"}` (internal `async_subagents_send`): live follow-up/steer for a running child, otherwise cold resume of a terminal child's persisted session; returns `details.delivery` (`live` with disposition, or `resume` with `turn`). See Current behavior §11a. `[confirmed by code, tools/send.ts, tools/subagents.ts]`
- **status** `{runDir?, agentIds?}`, **wait** `{runDir?, agentIds?, timeout?, interval?, failFast?}`, **result** `{runDir?, agentId}`, **stop** `{runDir?, agentIds?, force?, signal?}`, **cleanup** `{runRoot?, days?, keep?, delete?}`. `[confirmed by code]`

### Storage layout

```
<cwd>/.pi/subagents/<parent-scope>/
  <child-session-id>.jsonl       # ordinary Pi session; child sole writer
  headless-parent.jsonl          # only for stable-key headless scopes
  owned/<batch>/<agentId>/...    # owned-launch file-based exception only
```

Parent state is persisted as custom entries in its Pi session, or in the
headless journal when a stable host session key exists. No regular-agent
run directories, sidecars, or registry are created. Disposable UI-QA/browser
workspaces live at `.pi/artifacts/subagents/<batch>-<agentId>/`. See
[decision 0072](../../decisions/0072-session-native-subagents.md).

### ACP/Desktop child-session viewer

ACP `pix/subagents/open_session` and `pix/subagents/session_state` expose a
validated private child-todo snapshot read from persisted todo custom entries
or `todo` tool results, including explicit clears. The scanner incrementally
reads complete history in bounded chunks; it does not discard middle entries.
The viewer also reports the child's recorded provider/model/thinking and
queries quota through the existing model-usage path, with a bounded per-route
one-minute cache. Viewing never starts a Pi runtime or mutates the child JSONL;
quota unavailability does not suppress todo or model state. Desktop shows the
child's quota and private todo in its status bar, never the parent's. Viewer
configuration, todo clearing, session-usage inspection and manual Claude
limit refresh remain unavailable. A read-only viewer can open a new draft tab
(Plus or `session.new`/Cmd+T); this does not make the child writable or permit
session mutation/startup from the viewer.

## Invariants
- `agentId` identifies a launch record, not Pi's session UUID; repeated identifiers resolve according
  to latest-launched order within the relevant scope. `[confirmed by code]`
- Sub-agents never receive the `subagents` tool → recursive spawning is impossible. `[confirmed by code, tool-guard.ts]`
- Sub-agents never keep the Claude provider's `pi_claude_code_provider_web_search` tool active (approved policy: no provider web search in any child). The Pix-maintained provider no longer registers it, even during `session_start`; the tool guard still excludes or blocks a copy exposed by a legacy provider as defense in depth. Restricted `--tools` lists also drop it. The opt-in real-Pi test checks the inventory actually handed to the provider for default, restricted and no-tools roles. `[confirmed by code, pi-claude-code-provider.ts and tool-guard.ts; confirmed by tests, extension.case.js and provider-child-inventory.test.ts]`
- Semaphore is project-wide (keyed by resolved cwd). `[confirmed by code]`
- `ui-qa` tests the requested user-facing surface through the capability-first
  runner: browser delegates to the trusted backend, TUI uses a real PTY plus
  headless ANSI/VT screen model, and macOS desktop uses the bundled semantic
  Accessibility/CGWindow driver. Missing capabilities return `BLOCKED`; static
  or mock checks never replace requested UI execution. `[confirmed by code and
  agent contract]`

## Edge cases
- **No runDir**: lookup is scoped to the current parent and resolves the latest-
  launched matching agent; no project-wide mtime scan occurs. `[confirmed by code]`
- **Implicit Antigravity model with isolated extensions**: if Antigravity is selected only through the model environment fallback or pi's persisted default, the child keeps `--no-extensions` and does not load `antigravity-auth`; callers must explicitly select an Antigravity model in task/CLI arguments. `[confirmed by code; confirmed by tests]`
- **Oversized RPC lines**: agent_end oversized lines still trigger termination with a fallback result; others dropped with a marker. `[confirmed by code]`
- **Retry + stop**: stop cancels pending retries and records stop state in the parent session. `[confirmed by code]`
- **Windows termination**: `taskkill /T /F` (tree kill) with 1s timeout, fallback `process.kill`. `[confirmed by code]`

## Side effects
- Writes child session transcripts, parent-session custom entries (or stable-key
  headless journal), and owned-launch files when applicable. Regular agents do
  not receive registry or lifecycle sidecars. `[confirmed by code]`
- Spawns one `pi --mode rpc` child per task; SIGTERM primary, SIGKILL fallback. `[confirmed by code]`
- Sets `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION`, `PI_TERMINAL_BELL_DISABLED`, `PI_TOOLS_SUITE_DISABLED_MODULES` in child env. `[confirmed by code]`

## Regression coverage

- Command-free child DCP, lifecycle activation, disabled configuration and actual compression under an in-memory (`SessionManager.inMemory()`) host without journal/session writes or raw-history mutation. Real async children are persisted and journal normally.

- Optional policy, CLI removals, project replacements, read-only lifecycle/call guard, AST preview-only execution and actual SDK inventories for Claude/Codex models.

- Existing search/apply behavior.

- Credential/provider, fallback, timeout and cancellation behavior reused by child web tools.

- Child-local state, unchanged parent persistence, CLI restrictions, compaction and branch replay.

- Real offline child startup exposes todo and gated repo queries for default, restricted and empty selections.

- Common repo registration, no setup, prerequisite gates, lifecycle selection and adapters.

- Cross-package report bridge, launch ownership, provenance labels, redaction and duplicate suppression.

- Tool-result/follow-up arbitration and reservation lifecycle regressions.

- Real SDK tool hooks, settlement continuation and provider-request counts with a deterministic offline provider.

- Launcher transport/parser units, real pipe/socket backpressure regression, and opt-in native launchd crash/recovery tests.

- Mocked receipt recovery, pending state, and fail-closed retirement/deletion.

- Opt-in real Pi/unmodified-provider offline lifecycle matrices, using a local protocol fixture rather than live inference.

- Config/profile loading, semaphore behavior, process lifecycle, retry, model fallback, running stop behavior, structured results, and project-agent definitions.

- Default task-audit and explicit spec-review modes, tools, visibility and boundaries.

- Public tool validation and spawn/status/wait/result/stop integration.

- Explicit and automatic role routing, parent-model/project gates, unknown-role failures, and confirmation that `browser-qa` has no built-in alias.

- Role candidate ordering, parent-provider policy, runtime availability, and session fallback behavior.

- Task normalization, live-state tracking/rendering, polling, and slash-command UI.

- Opt-in LLM routing selection without spawning a real child.

- Opt-in real subprocess workflows.

## Gaps / risks
1. **pid-check race**: `process.kill(pid,0)` is point-in-time; a process exiting
   between checks flips status on the next poll, not immediately. `[inferred]`
2. **Headless recovery**: without a stable host session key, parent records are
   process-local and cannot be recovered by a later process. `[confirmed by code]`
3. **`model_fallback_from`/`model_fallback_to` are diagnostic metadata** and are
   not a durable source for later routing decisions. `[confirmed by code]`
4. **Polling minimum interval is bounded in code**, so very short waits cannot
   become high-frequency busy polling. `[confirmed by code]`
5. **External process death remains asynchronous**: a child killed outside the
   launcher is observed on the next state reconciliation/poll. `[inferred]`
7. **Structured-result file-ref extraction is best-effort** and can produce
   false positives. `[confirmed by code]`

## Suggested verification
1. Add an integration test for externally killed children across semaphore/state
   reconciliation boundaries.
2. Headless invocations without a stable host session key are process-local;
   callers needing cross-process recovery must provide a stable key.
3. Keep opt-in real-subprocess E2E coverage for routing/model fallback and
   cleanup on supported CI/provider environments.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"19234a89-390d-4a92-841c-d7eb9a972182","contentHash":"973cb8e6d0219b7b01a42ff029ba23f5996ed0c4a133f35f6971e6aef3c74d7b","checkedAt":"2026-10-31T13:52:44.531Z","maxDocumentChars":128000} -->
