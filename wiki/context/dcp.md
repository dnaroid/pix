---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-30T23:15:57.187Z","result":{"path":"wiki/context/dcp.md","documentHash":"928645b848bc2696ce6affb114cb60ae8e10a7297fe0c2d83c60e42167c93955","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[{"draft":{"path":"wiki/context/dcp.md","quote":"`compress.protectedTools` and\n`protectedFilePatterns` are empty by default; explicit lists are opt-in and\nreplace earlier/model-layer values, so an empty list unpins.","startLine":317,"endLine":319},"existing":{"path":"wiki/tools/suite.md","quote":"Array fields are union-merged, so model-specific `protectedTools` extend the defaults instead of replacing them.","startLine":464,"endLine":464},"explanation":"Оба утверждения описывают семантику слияния списков `compress.protectedTools` (и защищающих паттернов) в одной конфигурации DCP. Черновик требует, чтобы явные списки заменяли предыдущие/модельные значения, и пустой список снимает защиту. source-2 утверждает, что поля-массивы объединяются по объединению, т.е. модельные `protectedTools` расширяют значения по умолчанию, а не заменяют их. Замена и объединение несовместимы для одного и того же поля в одинаковых условиях; одно и то же значение конфигурации не может одновременно и заменяться пустым списком, и расширяться объединением."}],"uncertainties":[{"draft":{"path":"wiki/context/dcp.md","quote":"Async children are always\npersisted sessions and use the normal journal. An in-memory (unpersisted) session\nmanager keeps decisions in memory only: no journal writes, no raw history mutation.","startLine":65,"endLine":67},"existing":{"path":"wiki/tools/agents/async-subagents.md","quote":"`external/pi-tools-suite/test/async-subagents/dcp.test.ts`: command-free child DCP, lifecycle activation, disabled configuration and actual in-memory compression without journal/session writes or raw-history mutation.","startLine":1335,"endLine":1335},"explanation":"Черновик утверждает, что асинхронные дочерние сессии всегда персистентны и используют обычный журнал, но допускает in-memory менеджер сессий без записи журнала. source-5 описывает тест дочернего DCP с фактическим in-memory сжатием без записи журнала. Не хватает информации о том, к какой категории относится тестируемый дочерний DCP: если это асинхронный child на персистентной сессии, тест противоречит утверждению черновика «всегда персистентны»; если же тест покрывает in-memory (неперсистентный) режим хоста, описанный в самом черновике, утверждения совместимы. Нужно уточнение, какой режим сессии покрывает этот тест."}],"reviewedSources":[{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n","startLine":1,"endLine":37},{"path":"wiki/tools/suite.md","quote":"      \"openai-codex/gpt-5*\": {\n        \"compress\": {\n          \"minContextPercent\": \"26%\",\n          \"maxContextPercent\": \"46%\"\n        }\n      },\n      \"openai-codex/gpt-5.4-mini\": {\n        \"compress\": {\n          \"minContextPercent\": \"20%\",\n          \"maxContextPercent\": \"38%\"\n        }\n      },\n      \"zai/*\": {\n        \"compress\": {\n          \"minContextPercent\": \"16%\",\n          \"maxContextPercent\": \"30%\"\n        }\n      },\n      \"antigravity/*sonnet*\": {\n        \"compress\": {\n          \"minContextPercent\": \"22%\",\n          \"maxContextPercent\": \"40%\"\n        }\n      },\n      \"antigravity/gemini-3.1-pro*\": {\n        \"compress\": {\n          \"minContextPercent\": \"24%\",\n          \"maxContextPercent\": \"42%\"\n        }\n      },\n      \"antigravity/gemini-3-flash*\": {\n        \"compress\": {\n          \"minContextPercent\": \"18%\",\n          \"maxContextPercent\": \"34%\"\n        }\n      },\n      \"antigravity/gemini-2.5-flash*\": {\n        \"compress\": {\n          \"minContextPercent\": \"18%\",\n          \"maxContextPercent\": \"32%\"\n        }\n      },\n      \"antigravity/antigravity-claude-opus-4-6-thinking\": {\n        \"compress\": {\n          \"minContextPercent\": \"26%\",\n          \"maxContextPercent\": \"44%\"\n        }\n      }\n    }\n  }\n}\n```\n\n`minContextPercent` / `maxContextPercent` accept legacy fractions (`0.25`), percent strings (`\"25%\"`), or absolute token counts when Pi knows the current model context window. `minContextLimit` / `maxContextLimit` and `modelMinContextLimits` / `modelMaxContextLimits` are explicit absolute-or-percent aliases. `modelOverrides` and the `modelMin*` / `modelMax*` maps support exact model keys plus `*` / `?` wildcard patterns; matching is applied from generic to specific so exact bare-model matches override bare wildcards, and exact `provider/model` matches override provider wildcards. Array fields are union-merged, so model-specific `protectedTools` extend the defaults instead of replacing them. If `compress.protectUserMessages` is enabled, range compression appends selected user messages verbatim instead of rejecting the range; individual message compression still skips protected raw user messages. Protected tool outputs are copied into summaries for tools protected by name or `protectedFilePatterns`; protected `subagents` result reads also try to include the saved `result.md` artifact when available.\n\n`compress.autoCompress.enabled` is `false` by default. When explicitly enabled, its `patience` counts completed correlated main-provider opportunities, not repeated context transforms; `summarizerModel` supplies the primary summarizer list and `summarizerFallbackModels` appends explicit ordered fallbacks. Existing multi-entry `summarizerModel` configs remain supported. When both lists are empty, DCP uses the bounded extractive fallback without a model call. A configured model summarizer receives a bounded sub-deadline (75% of `timeoutMs`) so deterministic extractive fallback and durable publication retain time inside the whole operation budget. After a failed model-backed auto-compression attempt, subsequent automatic attempts in that session skip the model summarizer and use deterministic extraction. Auto commit is accepted only when the full projected replacement has positive gain and meets the current budget-recovery target.\n\n`strategies.emergencyCurrentTurnPruning` is the default-enabled lossy safety floor for a single unfinished turn. DCP first emits emergency reminders and offers only safe old same-turn tool-result candidates. After `patience` completed ignored opportunities, at the model-independent `hardContextPercent`, or when exact auto-compression fails while input capacity is already exceeded, it replaces eligible oldest result bodies until the estimated provider context reaches `targetContextPercent` or a safe capacity margin. User messages, configured/protected data, the newest `keepRecentToolPairs`, and results without **completed** provider evidence are never selected. HTTP 2xx alone is not evidence; DCP promotes eligibility only after an unambiguously correlated successful finalized assistant response, and ambiguous retries/interleaving fail closed. If eligible recovery still cannot fit the request, DCP emits a user-visible blocked diagnostic with the capacity reason before abort/handoff. The raw session transcript is unchanged. Setting `enabled` to `false` disables same-turn candidates and lossy pruning, but keeps the non-destructive emergency reminder.\n\nDCP durable state is journaled as append-only `dcp-journal` custom entries in\nthe Pi session JSONL. Resume/reload replays that journal; the current\nimplementation has no legacy sidecar importer or dual-write path. Protected\nsubagent artifacts are optional bounded recovery input: reads are async, rooted\nat the session cwd, reject symlink escapes and oversized files, and never\nsilently truncate a required protected artifact.\n\nSet `dcp.debug: true` to write a JSONL debug log of DCP context/prune/compress events to `~/.pi/agent/dcp-debug.jsonl` (override the path with `PI_DCP_DEBUG_LOG`, or enable without config via `PI_DCP_DEBUG=1`); off by default. The log is size-limited and rotated: once it reaches `dcp.debugLog.maxBytes` (default `5242880` = 5 MB) it is renamed to `.1`, older backups shift down (`.1`→`.2`, …) and the oldest beyond `dcp.debugLog.maxBackups` (default `3`, minimum `1`) is dropped; override either with `PI_DCP_DEBUG_MAX_BYTES` / `PI_DCP_DEBUG_MAX_BACKUPS`.\n\n## LSP setup\n\nThe LSP module reads language-server definitions from `lsp.servers` in the shared config file:\n\n```text\n~/.config/pi/pi-tools-suite.jsonc\n```\n\nInstall the language servers used by the bundled example config. The commands below are written for macOS/Linux with a POSIX shell; most npm, `dotnet`, `pip`, and `rustup` commands also work on Windows, but paths and the GDScript wrapper differ.\n\n```bash\n# TypeScript / JavaScript\nnpm install -g typescript typescript-language-server\n\n# Svelte\nnpm install -g svelte-language-server\n\n# Vue\nnpm install -g @vue/language-server\n\n# Python\n","startLine":411,"endLine":499},{"path":"wiki/context/dcp-statistics.md","quote":"## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Report ownership\n\n`external/pi-tools-suite/src/dcp/statistics.js` is the shared, read-only ESM\nreducer/formatter for `/dcp stats`, the TUI dialog and ACP/Desktop. The compiled\nhost imports this shipped JavaScript directly, without loading the TypeScript\nextension runtime. Opening statistics never prunes history or calls a model.\n\nThe report separates these quantities:\n\n- SDK usage, which may lag, from the **last prepared DCP request**. Its scalar\n  snapshot includes the selected model, input capacity/output reserve, resolved\n  routine/strong/hard thresholds, modes and pressure reason, plus the routine\n  calibration fields `routineProjectedTokens` and `routineUsageAdjustmentTokens`\n  that expose post-compression routine adjustments separately from raw/projected\n  history counts. It is dated and is\n  not presented as live provider-measured token usage. A changed model makes an\n  old snapshot stale; an epoch boundary invalidates it until another request.\n  SDK usage itself may temporarily count raw history after a retry context edit;\n  the last prepared request uses the corroborated fallback rebasing described in\n  [DCP pressure policy](dcp.md#pressure-and-autonomous-policy), retaining system\n  overhead without applying routine calibration twice. That correction does not\n  overwrite the SDK status reading; a later measured response replaces its raw\n  fallback naturally.\n- Active/retired/total journal blocks, active summary estimates and distinct\n  pruned result bodies. Block count is not called an operation count. The\n  input/projection reduction covers message estimates, not the system prompt,\n  tool schemas, billing, or lifetime token occurrences.\n- Model/tool commits, autonomous commits and block-only consolidation commits.\n  Multi-block tool transactions count once by their call/operation identity.\n  Historical blocks without identifiable provenance are reported separately.\n- Measured positive commit gains. New transactions place one optional\n  `commitMetrics` record on their first block, in the same durable publication\n  as the rewrite. It contains operation ID, kind, before/after estimates and net\n  gain. Validation rejects malformed or non-positive metrics. Retries never\n  create a second measurement. Gains from old unmeasured blocks are unknown,\n  not inferred as zero. A sum of measured deltas is not current context savings\n  or saved billing.\n- The Desktop context-hover `DCP saved ~N tokens` value is intentionally a\n  different live runtime metric: the extension's `state.tokensSaved` estimate,\n  also used by `/dcp context`. It is not derived from `measuredGain`, does not\n  change this durable report's accounting, and is not a billing claim.\n- Desktop's token-volume map uses a separate, cached runtime observation,\n  not a durable statistics reducer output. It exposes only bounded scalar\n  metadata from the last completed context preparation: owner epoch, revision,\n  preparation time and estimated token totals for candidate/incomplete-group/\n  active-summary/retained content. Totals partition current projected messages,\n  with protection taking precedence over candidate, then summary, then retained;\n  summary volume is the current summary, not the removed source. It carries no\n  message bodies, tool arguments, position ranges or raw\n  history. A selected candidate is advisory compression guidance, not a deletion\n  authorization; actual compression still performs its normal closure and\n  stale-plan validation. Retained content does not imply eligibility. The\n  process-local getter and message-boundary transport do not read full history\n  or rerun candidate detection. See [desktop-runtime-status.md](../usage/desktop-runtime-status.md)\n  for presentation and freshness rules.\n- Journaled anchors and context projection events, versus recorded provider\n  attempts containing reminders and correlated successful completed\n  opportunities. Failed attempts may count as attempts, never as successful\n  completion. Repeated context callbacks do not invent provider opportunities.\n  The former `Sent` label and `Compliance proxy` ratio are removed.\n\n## Compression regret signals\n\n`/dcp stats` reports two scalar regret counts derived from `dcp-diagnostic`\n`regret` events (deduplicated by tool-call ID, durable across epochs):\n\n- `refetch`: a new tool call repeats a side-effect-free observation (file read\n  or repeatable shell inspection/test run, by exact arguments) whose earlier\n  result the latest DCP projection hides (compressed into a block, including a\n  message-mode body replacement, or pruned) while no result with the same key\n  is still visible;\n- `recovery`: `session` with action `search`, `read`, `overview`, or `recovery`\n  is called after DCP has compressed or pruned something in the current state.\n","startLine":8,"endLine":88},{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n","startLine":1,"endLine":30},{"path":"wiki/tools/agents/async-subagents.md","quote":"- `external/pi-tools-suite/src/async-subagents/core/process.ts`\n- `external/pi-tools-suite/src/async-subagents/core/attachment-bridge.ts`\n- `external/pi-tools-suite/src/async-subagents/core/structured-result.ts`\n- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`\n- `external/pi-tools-suite/src/async-subagents/delegated-evidence.ts`\n- `external/pi-tools-suite/src/async-subagents/commands.ts`\n- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`\n\n## Tests\n\n- `external/pi-tools-suite/test/async-subagents/dcp.test.ts`: command-free child DCP, lifecycle activation, disabled configuration and actual in-memory compression without journal/session writes or raw-history mutation.\n\n- `external/pi-tools-suite/test/async-subagents/work-tools.test.ts`: optional\n  policy, CLI removals, project replacements, read-only lifecycle/call guard,\n  AST preview-only execution and actual SDK inventories for Claude/Codex models.\n- `external/pi-tools-suite/test/ast-grep.test.ts`: existing search/apply behavior.\n- `external/pi-tools-suite/test/web-search.test.ts`: credential/provider,\n  fallback, timeout and cancellation behavior reused by child web tools.\n- `external/pi-tools-suite/test/async-subagents/todo.test.ts`: child-local state,\n  unchanged parent persistence, CLI restrictions, compaction and branch replay.\n- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`:\n  real offline child startup exposes todo and gated repo queries for default,\n  restricted and empty selections.\n- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`: common repo\n  registration, no setup, prerequisite gates, lifecycle selection and adapters.\n- `tests/heads-up-delegated.test.ts`: cross-package report bridge, launch ownership,\n  provenance labels, redaction and duplicate suppression.\n- `external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`:\n  tool-result/follow-up arbitration and reservation lifecycle regressions.\n- `external/pi-tools-suite/test/async-subagents/completion-sdk.test.ts`:\n  real SDK tool hooks, settlement continuation and provider-request counts\n  with a deterministic offline provider.\n- `external/pi-tools-suite/test/async-subagents/owned-launch/`: launcher\n  transport/parser units, real pipe/socket backpressure regression, and opt-in\n  native launchd crash/recovery tests.\n- `external/pi-tools-suite/test/async-subagents/owned-runtime.test.ts` and\n  `external/pi-tools-suite/test/async-subagents/owned-runtime-early.test.ts`:\n  mocked receipt recovery, pending state, and fail-closed retirement/deletion.\n- `external/pi-tools-suite/test/async-subagents/provider-owned-launch.test.ts`\n  and `external/pi-tools-suite/test/async-subagents/provider-owned-runtime.test.ts`:\n  opt-in real Pi/unmodified-provider offline lifecycle matrices, using a local\n  protocol fixture rather than live inference.\n- `external/pi-tools-suite/test/async-subagents/core.test.ts`: config/profile\n  loading, semaphore behavior, process lifecycle, retry, model fallback, running\n  stop behavior, structured results, and project-agent definitions.\n- `external/pi-tools-suite/test/async-subagents/knowledge-auditor.test.ts`: default\n  task-audit and explicit spec-review modes, tools, visibility and boundaries.\n- `external/pi-tools-suite/test/async-subagents/tools.test.ts`: public tool\n  validation and spawn/status/wait/result/stop integration.\n- `external/pi-tools-suite/test/async-subagents/routing.test.ts`: explicit and\n  automatic role routing, parent-model/project gates, unknown-role failures,\n  and confirmation that `browser-qa` has no built-in alias.\n- `external/pi-tools-suite/test/async-subagents/model-pools.test.ts` and\n  `external/pi-tools-suite/test/async-subagents/model-pool-contract.test.ts`: role candidate ordering, parent-provider policy,\n  runtime availability, and session fallback behavior.\n- `external/pi-tools-suite/test/async-subagents/ui.test.ts`: task normalization,\n  live-state tracking/rendering, polling, and slash-command UI.\n- `external/pi-tools-suite/test/async-subagents/selection-e2e.test.ts`: opt-in LLM\n  routing selection without spawning a real child.\n- `external/pi-tools-suite/test/async-subagents/e2e.test.ts`: opt-in real\n  subprocess workflows.\n\n## Gaps / risks\n1. **pid-check race**: `process.kill(pid,0)` is point-in-time; a process exiting\n   between checks flips status on the next poll, not immediately. `[inferred]`\n2. **Headless recovery**: without a stable host session key, parent records are\n","startLine":1325,"endLine":1390},{"path":"wiki/context/dcp-protected-continuity.md","quote":"kind: spec\nstatus: active\n---\n\n\n\n# DCP protected continuity\n\n## Behavior\n\nDCP separates raw-result deletion safety, explicit exact pins, and semantic\ncontinuity. Unknown effects are treated conservatively: DCP cannot safely\nclassify every extension tool. Results that need continuity get facts-oriented\nreceipts/digests, while ordinary observations and runtime progress are left for\nsemantic summaries rather than copied into the ledger.\n\nWhen a continuity-worthy tool result enters a compression block, DCP keeps a\nbounded, deterministic action receipt/digest, not a verbatim transcript:\n\n- explicit prompt/user protections remain exact;\n- outputs explicitly pinned by `compress.protectedTools` or matching\n  `protectedFilePatterns` remain exact; these are empty by default;\n- action receipts preserve source tool/call identity, outcome (including\n  `UNKNOWN` where an effect cannot be established), relevant paths, status and\n  available log/run/code-version references;\n- simple test/build digests are explicitly historical observations, not current\n  verification; observations and todo/result progress are not retained as\n  append-only event history, because their conclusions belong in semantic\n  summaries;\n- there is no hardcoded verbatim-tool list or smaller-of-verbatim rule. The\n  separate raw-deletion guard protects effects that lack a replacement fact.\n\nThe raw Pi session remains the exact historical source. Compression continuity\nis working memory for the next provider request, not a second archival copy.\nRecovery rehydrates raw tool-result text byte-for-byte like live capture,\nincluding empty/whitespace results and adjacent text parts; it does not add\npresentation separators.\n\nRepeated safe inspections can be superseded where the newest result is enough;\ntest/build runs are not latest-run-wins because they may cover different code\nrevisions. Mutations, unknown commands and effects are never safely treated as\nrepeatable observations.\n\nNew blocks store semantic summary core separately from `protectedFragments`.\nProvider projection renders the core plus the continuity ledger. Legacy v2\nblocks with an inline ledger remain readable; a later roll-up or maintenance\nrepack extracts their semantic core and re-applies the current continuity\npolicy without mutating the published old block.\n\nTool continuity has a block-wide provider-visible byte budget. The default is\n16 KiB and can be overridden with\n`dcp.compress.maxProtectedToolContinuityBytes`. Actionable failures and mutation\nreceipts preserve their required minimum text (`minimumText`) while optional\nevidence may be removed. For simple test/build digests the floor includes the\nexecution outcome, parsed counts and parser caveats when available, plus a\nbounded diagnostic excerpt (up to 768 characters); the full compact parsed\noutput is not retained. Up to the first two parsed diagnostics are included\nwithin that total bound, with an explicit omitted-diagnostic count and a\nrecover-source instruction when more exist; if no parsed diagnostics exist,\nbounded error evidence is the fallback. This floor survives budgeting and\njournal replay; if the floors exceed the budget, compression fails closed. There is no\nanonymous overflow aggregate and no silent loss of action identity or outcome.\n\nUnder compression pressure, candidate sizing uses estimated recoverable tokens\nafter protected-continuity retention rather than treating all source tokens as\nrecoverable. A single oversized active legacy block may be selected for a\ndeterministic continuity repack even though normal block consolidation requires\nmultiple adjacent blocks. Repack preserves the prior semantic summary core and\ndoes not invoke a summarizer model.\n\n## Constraints and failure cases\n\n- Inherited tool continuity is re-normalized only when its `tool:\u003ccallId\u003e`\n  provenance resolves to a current `ToolRecord`. Missing provenance keeps the\n  persisted fragment unchanged; legacy fragments without representation\n  provenance cannot be reshaped speculatively.\n- Pin ownership is released only through a replacement block covering the\n  sources; a missing source record cannot be silently downgraded to an\n  unpinned/optional fragment.\n- Expanded artifact pins carry policy-v3 owner call ID and raw-output hash\n  provenance. A replacement can release one only when the owner record's raw\n  output hash verifies and current configuration no longer pins that output;\n","startLine":2,"endLine":83},{"path":"wiki/context/assistant-prompt-composition.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Assistant prompt composition\n\n## Behavior\n\nThe suite removes the upstream SDK's automatic **Pi documentation** reference\nblock from provider-bound assistant prompts for every model, not only GLM.\nRemoval covers tagged `\u003cdocs\u003e` sections, the legacy flat block, initial requests,\nsubsequent tool-loop requests and new turns. The suite registers sanitization\nafter its other prompt hooks. Structured prompts remain structured: the request\ntransform removes only the upstream `docs` section. Existing forced/opaque prompt\noverrides are sanitized before the SDK's later forced-prompt projection.\n\nProject instructions, skill metadata/content, custom documentation sections,\nconversation messages and tool declarations are preserved. No replacement Pi\ndocumentation primer or recursive/full-document-reading instruction is added.\nExplicit project-owned Pi SDK skills are not the SDK boilerplate and remain\navailable when the task calls for them.\n\nThe full delegation policy has one emitted authority: the `subagents` tool\ndescription. The tool snippet refers there; strategy and role catalog do not\nrepeat the full policy. Short local role-selection, UI-QA/credentials/evidence,\nknowledge-audit and worker-briefing reminders remain. Disabling the strategy does\nnot remove the policy. Conditional review gates stay conditional on the effective\nrole catalog; this does not change role/model selection or authorize new gates.\n\nThe delegation policy instructs parents to write sub-agent task prompts and\ninstructions in English for token economy, regardless of the user's language.\nThis covers task, scope, parentObjective, promptAppend, promptOverride and\nfocus/attention text. Exact quotes, code, paths, identifiers and required\nuser-facing text retain their original language. Replies to the user stay in\nthe user's language. This is prompt guidance, not automatic translation or\nlanguage validation of tool arguments.\n\nRelated behavior: [search routing](../search/repo-knowledge-agent-workflow.md),\n[todo statuses and blocked-work handoff](../work-management/todos/todo-initial-status.md),\n[parent-first delegation and nonblocking spawn](../tools/agents/parent-first-subagent-routing.md).\nRationale: [decision 0033](../decisions/0033-assistant-prompt-hygiene.md).\n\n## Constraints and failure cases\n\nRecognition is intentionally limited to the SDK's documentation header/block,\nnot arbitrary mentions of Pi. Unknown future SDK formats require regression\nupdates rather than broad deletion of project text. Sanitization is request-time;\nit does not rewrite persisted historical transcripts. A later external extension\nthat replaces the prompt after the suite can override the suite's result.\n\n## Implementation\n\n- `external/pi-tools-suite/src/prompt-sanitizer.ts`\n- `external/pi-tools-suite/src/index.ts`\n- `external/pi-tools-suite/src/coding-discipline/index.ts`\n- `external/pi-tools-suite/src/tool-descriptions.ts`\n- `external/pi-tools-suite/src/async-subagents/core/agent-strategy.ts`\n- `external/pi-tools-suite/src/async-subagents/core/agent-catalog.ts`\n\n## Tests\n\n- `external/pi-tools-suite/test/prompt-sanitizer.test.ts`\n- `external/pi-tools-suite/test/prompt-sanitizer-sdk.test.ts`\n- `external/pi-tools-suite/test/coding-discipline.test.ts`\n- `external/pi-tools-suite/test/tool-descriptions.test.ts`\n- `external/pi-tools-suite/test/async-subagents/core.test.ts`\n- `external/pi-tools-suite/test/async-subagents/tools.test.ts`\n\n## Verification\n\nRun focused tests and suite typecheck, then the broad suite and smoke checks.\nThe installed-SDK test uses a local deterministic provider and exercises both\nstructured and forced prompts over tool-loop and new-turn requests. Assert docs\nabsence, preserved custom/skill text and tool declarations, and a single full\ndelegation policy with strategy enabled or disabled. Sync the source suite into\nthe live extension and check drift. Existing processes require reload/restart.\n","startLine":1,"endLine":77},{"path":"wiki/context/dcp-provider-cache-stability.md","quote":"- lifecycle reset between context construction and provider send, proving the\n  stale/raw payload is blocked until a fresh projection completes;\n- cancellation/stale owner/source/config/model faults before publication.\n\nThe implementation pass reached a green deterministic DCP suite and green\nrepository/host test gates. A live provider cache/quality canary has **not** been\nrun and is not implied by those results.\n\n## Risks / unknowns\n\n- Other extensions may independently change an old provider item.\n- Provider TTL/routing can miss the cache even for byte-identical inputs.\n- The installed SDK has no universal provider request identity, so ambiguous\n  interleaving remains fail-closed.\n- Session-manager persistence determines crash/power-loss durability of journal\n  entries; the DCP journal does not add its own fsync/WAL layer.\n- Lossy summary quality still requires task-level/live evaluation; local prefix\n  equality proves a cache invariant, not semantic quality.\n\n\n","startLine":257,"endLine":276},{"path":"wiki/decisions/0060-subagent-read-only-repo-tools.md","quote":"\n## Context\n\nOrdinary children disable automatic extensions. Role tool names alone cannot\nload indexed repository capabilities. Every current and future role should be\nable to retrieve contracts, code, tests and dependencies without adding general\nmutation, setup, web or recursive orchestration authority.\n\n## Observations and sources\n\nVerified: [common spawn](../../external/pi-tools-suite/src/async-subagents/core/spawn.ts)\nowns extension loading and [CLI normalization](../../external/pi-tools-suite/src/async-subagents/core/child-tools.ts).\nThe SDK's CLI allowlist also restricts registered extension tools. The existing\n[repo adapter](https://github.com/dnaroid/pix/blob/b489d7899bb8f0baa0cd7fee540ecff9117aa3d5/external/pi-tools-suite/src/repo-discovery/index.ts) gates\nregistration on an indexed project and executable idx; commands are separate\nfrom query tools. Actual SDK integration tests exposed duplicate registration\nwhen both general and council entrypoints loaded the same repo tools.\n\nEvidence: [child facade tests](../../external/pi-tools-suite/test/async-subagents/repo-tools.test.ts),\n[offline child inventory](../../external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts),\nand [council SDK composition](https://github.com/dnaroid/pix/blob/cb504ee7b1000e4ed8df8acedc91ef759dbe5fb3/external/pi-tools-suite/test/brainstorm/research-extension.test.ts).\nThese are capability/isolation checks, not measurements of model research quality.\n\n## Decision\n\nLoad one tools-only repo entrypoint for every child attempt through common spawn,\nreusing the eight current adapters, prerequisite gate and configured output\nprofile. Omit setup/update commands; do not implicitly install or initialize.\nAdd the eight queries alongside private todo to restricted CLI allowlists and\nremove their exclusions, preserving restrictions on other tools. Lifecycle\nselection adds only registered queries and does not replace work-tool selection.\n","startLine":17,"endLine":47},{"path":"wiki/assistants/observer/heads-up-observer.md","quote":"Any retained card, including a hidden one awaiting review, keeps the base interval\nfor the combined review/discovery request. Manual checks bypass adaptation as well\nas normal cadence. Removing/expiring the last card reschedules a queued opportunity\nunder the discovery interval; feedback never creates an opportunity by itself.\nExisting budgets, availability, physical request ownership and no-polling rules\nremain intact. Status explains negative-feedback slowing and the unchanged review/\nmanual paths; eligibility is not a promised launch time.\n\n### Strict visible freshness\n\nStarting a parent run or completing a meaningful user/tool/delegated evidence\nevent immediately hides the entire previous stack, without a projection rebuild\nor inference. User/tool `message_end` invalidation occurs even before persistence;\nordinary assistant progress does not trigger it. Projection comparisons additionally\ndetect changed or removed cited evidence at turn/check boundaries. Hidden cards\nremain private review candidates, not claims that a problem still exists or has\nbeen resolved. Their original identities and expiry times are retained.\n\nOnly a successful assessment against current evidence with the parent settled\ncan restore supported cards. Manual checks may start while the parent runs, but\ncannot publish claims while it is running; changed evidence or a new run across\nthe request invalidates its result. A bounded fresh opportunity waits for settlement.\nMissing/clipped evidence is not confirmation that a retained problem persists.\nErrors, malformed responses, unavailable context/model and budget refusals leave\nunconfirmed cards hidden. They do not schedule retries or polling. The existing\ninterval, hourly and input/output limits still apply. This is evidence freshness,\nnot a guarantee of model correctness or independently inspected repository state.\n\nDefault limits are twelve checks per rolling hour, a 16,000-character serialized\nobservation payload, 192,000 payload characters per rolling hour, 900 output\ntokens and a twenty-second request timeout. The fixed system instructions are\nadditional to the payload character budget. Reservations are made before the\nrequest and are not refunded on errors; toggling or changing models does not\nreset limits. These are initial experiment defaults, not measured optimal\nvalues. Full token usage is reported separately from payload character limits.\n\nImmediately before a real check, Pix reads its existing in-memory, active,\ncompaction-aware session projection. Context edits and branch changes are\nrespected instead of resurrecting raw history. It retains the first surviving\nuser request, recent user instructions and a bounded set of recent work records;\nuser requirements are separately tagged from assistant claims. Only bounded\ntext and bounded tool arguments/results are included, with real source-entry\nIDs. Thinking, image bytes and full logs are excluded. Omission/clipping is\nexplicit. No full-history scan occurs per render or per streamed token.\nSelected records are serialized in projection order. Apart from pinned user\ninstructions, work records form a contiguous recent suffix: a record that does\nnot fit ends selection, rather than allowing an older small failure to replace\na larger fresh retest. Shell and codemode results use the same bounded text path;\nnested codemode evidence is its returned aggregate text, not independently\ninvented child tool records. Prefix clipping still applies to long individual\nrecords; omitted text is never proof that no correction/retest exists.\n\n### Delegated work (first increment)\n\nThe suite publishes a runtime-only versioned `async-subagents:delegated-evidence`\nbridge independently of its generic completion messages, wait delivery and\nparent follow-up arbitration. Capture starts synchronously at spawn execution,\n","startLine":112,"endLine":168},{"path":"wiki/decisions/0065-native-repository-search.md","quote":"\n## Context\n\nDesktop and agent Code/Knowledge search previously depended on separate external\nadapters. The handoff proposed `.pi/search/index.sqlite` as a likely shared native index.\nThe first slice must work without API keys or an active Desktop chat session, preserve\nexisting vectors and indexes, and avoid copying unrelated search capabilities.\n\n## Observations and sources\n\n- `external/pi-tools-suite/src/project-search/semantic-index-writer.ts` holds a\n  `BEGIN IMMEDIATE` transaction across awaited embedding batches. Its busy timeout is\n  35 seconds. Using the same SQLite file would couple local file freshness to provider latency.\n- `acp/src/search/canonical-index.ts` and the session/task/commit stores already use\n  `.pi/search/index.sqlite`. Existing namespaced tables are not a file-search migration API.\n- `desktop/src-tauri/src/backend_runtime.rs` resolves the relocated tools-suite extension\n  in both development and packaged runtimes, providing a session-independent process boundary.\n- Independent repository checks confirmed that commit embedding configuration, repo context,\n  AST/dependency views and knowledge dirty/acknowledge were outside the first slice.\n- Assumption: bounded lexical retrieval is useful without semantic/AST parity. Its quality and\n  large-repository limits must be measured, not inferred from FTS5 availability.\n\n## Decision\n\nUse one standalone tools-suite JS engine and typed result contract. TUI/ACP calls it in\nan owned child process; Desktop invokes the same packaged entry through a small Tauri\ntransport, independent of ACP sessions. Parsing/hashing/SQLite never run on the UI thread.\n\nStore only local file chunks/FTS5 metadata in `.pi/search/files.sqlite`, a disposable,\nstrictly owned schema. Leave `index.sqlite` and provider settings untouched.\n","startLine":9,"endLine":38},{"path":"wiki/archive/workspace.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Conversation workspace — tool removed\n\n## Behavior\n\nPix TUI and Pix Desktop do not provide the bundled `workspace` tool.\nThe former `current`, `switch` and `back` actions, return stack, transactional\nruntime rebinding and transparent model continuation are removed.\n\nOrdinary project opening, session operations, context reload and workspace undo\nare unchanged. Legacy `workspace` state envelopes do not mutate ACP session cwd,\nthe translator, persisted session-map records or Desktop catalog cwd. Historical\n`pix.workspace` journal entries remain untouched, but are no longer restored by\na workspace host. Running processes must restart to unload the removed tool.\n\nSee [the removal decision](../decisions/0023-remove-workspace-tool.md), which\nsupersedes the [rebinding](../decisions/0014-conversation-workspace-rebinding.md)\nand [handoff](../decisions/0021-transparent-workspace-handoff.md) decisions.\n\n## Implementation\n\n- `src/app/runtime.ts`\n- `src/app/app.ts`\n- `src/app/session/session-lifecycle-controller.ts`\n- `acp/src/pi/pix-rpc-entry.js`\n- `acp/src/acp/pix-acp-agent.ts`\n- `acp/src/acp/session-state-bridge.ts`\n- `acp/src/acp/session-map.ts`\n- `desktop/src/app/session-coordinator.ts`\n- `desktop/src/app/desktop-session-orchestration.ts`\n\n## Tests\n\n- `tests/bundled-question-extension.test.ts`\n- `tests/session-lifecycle-controller.test.ts`\n- `acp/test/agent.test.ts`\n- `acp/test/session-state-bridge.test.ts`\n- `desktop/src/app/session-coordinator.test.ts`\n\n## Verification\n\nRoot, ACP and Desktop typechecks plus targeted bundled extension, session\nlifecycle and state bridge/coordinator regressions. These checks do not claim\ninteractive UI QA.\n","startLine":1,"endLine":48}],"notices":[],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":63,"excerptedSources":10,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"conflicts"}} -->

# dcp: dynamic context pruning (as-is spec)

> Risk classes: **data / cross-cutting / provider-context mutation**. DCP is
> headless. Raw Pi session messages remain the recovery source; DCP changes only
> the projected provider context and persists durable projection decisions as
> structured `dcp-journal` custom entries in the same session JSONL.

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

DCP keeps a long-running agent inside its context budget without rewriting the
raw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`
tool, can apply exact continuation summaries, and has a bounded emergency path.
Historical details are recovered through `session` history actions, not by expanding a
compressed block back into the provider prefix.

Only sessions created by the journal implementation are supported. There is no
sidecar importer, legacy state reader, dual-write mode, `decompress`, or
`recompress` compatibility path.

## Lifecycle and persistence

1. A confirmed new persistent session receives one `dcp-journal` `init` custom
   entry before DCP publishes provider-visible addressing/rewrite decisions.
   Ephemeral sessions use the same contract in memory for their lifetime.
2. `session_start` resets transient runtime state and replays the complete
   journal on the active branch. A non-empty persisted session without a valid
   journal is deliberately unsupported rather than adopted as a new DCP
   session. Unknown versions, broken predecessor chains, or conflicting
   operation IDs fail closed.
3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output
   needed by current policy can be reconstructed from the raw branch. Large raw
   tool bodies are not duplicated into the journal.
4. `context` builds a detached provider projection, applies already committed
   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and
   candidates, and publishes any new durable projection decision before the
   resulting bytes may be used by the provider.
5. `before_provider_request` records which tool results actually occur in the
   outgoing payload. `after_provider_response` treats HTTP status as diagnostic
   acceptance only. A successful finalized assistant `message_end` can promote
   provider evidence when the local attempt is unambiguous. This evidence is
   runtime-only and returns to unknown after restart.
6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.
   Durable decisions are appended at their mutation/publication boundary.

Plain `custom` entries are not provider messages. `dcp-journal` must never be
stored as `custom_message` or copied into a model-facing tool result.

Async-subagent common spawn explicitly loads `dcp/subagent.ts` for every role
and attempt, without interactive `/dcp` commands or the full suite. The normal
DCP configuration and model overrides still apply. Enabled `compress` survives
restricted/empty work-tool lists, CLI exclusions and model selection; read-only
child/council guards allow this context-only operation. Async children are always
persisted sessions and use the normal journal. An in-memory (unpersisted) session
manager keeps decisions in memory only: no journal writes, no raw history mutation. See [subagent spawn](../tools/agents/async-subagents.md#spawn-corespawnts).

Full-branch reads fail closed on errors, partial cursors and real session/branch
changes; they do not fall back to a lazy presentation tail. A bounded retry is
allowed when an async lazy-history read races only with descendant appends on
the same active branch, so a normal leaf advance cannot permanently block DCP.
The completed read must itself match that current lineage through the captured
leaf; a snapshot from a transient fork cannot authorize the retry.
Lazy `getBranch()` is a presentation/file tail, not necessarily that ancestry:
it can omit older ancestors and include abandoned side branches. Retry proof
walks `parentId` from the current leaf and checks the full read's immutable
parent links; it never compares tail positions or publishes merged tail data.
See the counterexample, required tests and prohibited shortcuts in the
[lazy-tail retry invariant](dcp-statistics.md#lazy-tail-retry-invariant).
Entry binding disambiguates equal-role/equal-timestamp messages using canonical
content. Model changes clear successful provider exposure as well as pending
evidence, and the selected model owns input capacity even while SDK usage still
reports the previous window. Actual lazy-manager resume/fork and async ownership
tests are specified in [dcp-statistics.md](dcp-statistics.md).

`/dcp stats`, TUI and Desktop share the read-only statistics formatter. It
separates dated context snapshots, durable block/commit metrics and recorded
provider reminder delivery; it never equates context callbacks with sends.
Optional commit metrics live on the first block of a journaled transaction.
Scalar `dcp-diagnostic` observations are not projection or recovery authority.

## Journal contract

The only supported durable format is `dcp-journal`, schema version 1. Operations
form an append-only predecessor chain beginning with `init`; later `delta`
records contain only changes required to reproduce the provider projection:

- newly allocated stable-message → `mNNN` assignments and the high-water mark;
- new exact v2 compression blocks and their active/superseded state;
- explicitly committed pruned tool-result IDs and reasons;
- the session-local manual-mode value when changed;
- frozen nudge anchor data required to reproduce already published control text.

Every modern compression block has `version: 2`, an explicit replacement mode,
ordered `sourceMembers` and `mutationMembers`, and canonical content hashes. New
blocks are immutable except for derived active/deactivation state. Reusing an
operation ID with identical bytes is idempotent; reusing it with different data
is a conflict.

The journal intentionally excludes full raw history, provider payloads, complete
tool records, provider-seen evidence, pressure counters, and periodic snapshots.
No-op context transforms do not grow it.

On replay, transient tool records are reconstructed from raw branch messages;
tool-result output text matches live capture byte-for-byte, including
empty/whitespace content and adjacent text parts (without presentation
separators). Provider-seen evidence remains unknown after restart.

Publication uses the host session append boundary. DCP validates and prepares a
detached state, revalidates owner/source/config/model, appends the operation, and
only then installs the committed projection in live state. The current host
contract does not claim stronger power-loss durability than the session manager
itself; DCP does not add a second WAL, file lock, or `fsync` persistence engine.

## Canonical identity and exact replacement

`conversation-index.ts` builds ordered identity from the actual current
projection. Stable session entry identity wins over timestamps; equal timestamps
are disambiguated by branch order and stable IDs. If the host exposes a lazy
tail-only branch view, DCP recovers those entry identities through the host's
full-branch reader before rebuilding the projection. A modern exact operation
is never widened by guessing a same-timestamp neighbour.

`sourceMembers` describe exactly what the summarizer inspected.
`mutationMembers` describe exactly which canonical raw messages a later replay
is allowed to replace. They remain distinct because prior pruning or an earlier
summary can make the two representations differ.

Range compression must cover a protocol-closed assistant/tool-result group.
Routine recommendations use the same closure authority even without a recovery
token target. Historical incomplete groups split eligible history into closed
runs; a too-small run does not prevent selection of later eligible work. The
planner never bridges an excluded block/message or widens into protected recent
turns to complete a group. An incomplete-group error names the blocking assistant
and missing result IDs, and lists bounded protocol-closed alternatives inside
the requested selection. It does not imply that an interrupted historical call
will finish by waiting, fabricate its result, or mutate a rejected selection.
Message-body compression can replace one supported tool-result body while
preserving its role, call ID, tool name, error status, position, and siblings.
Signed assistant content is never edited in place.

Manual `compress` batches are staged atomically. Missing exact membership,
overlap, stale source, owner/config/model changes, cancellation, non-positive
full-projection gain, or failed durable publication leave the live operation
uncommitted. A retry with the same tool-call ID and parameters is idempotent;
changed parameters are a conflict.

## Provider-cache stability

DCP treats prefix stability as a correctness constraint:

- assistant bytes, signatures, reasoning/tool-call ordering, and provider item
  shape are preserved;
- `mNNN` assignments are monotonic and never renumbered after rollup/restart;
- ID metadata is distributed over deterministic user/tool-result carriers and
  is not rebuilt as a moving payload-tail map;
- an ID assignment for a message of at least ~1k estimated tokens carries a
  coarse `~Nk` size hint (for example `m013=t~4k`), derived only from that raw
  message so it is as stable as the ID; block aliases carry none;
- a reminder is introduced on a fresh trailing user carrier or a positively
  fresh trailing tool result produced by a new local call in this epoch. A tool
  result loses freshness at the first provider **attempt**, even on failure;
  restart/ownership transitions never infer freshness from unknown exposure. Once
  published, its carrier and rendered bytes are frozen; stronger later pressure
  or lower usage does not rewrite it. Frozen tool reminders replay from the
  journal by stable identity and role, without timestamp fallback. If there is
  no cache-safe carrier, reminder creation is
  deferred rather than synthesizing a disappearing tail message;
- replaying an exact frozen reminder remains cache-safe even after its tool
  result loses freshness. Failed sends/retries do not use "reminder unavailable"
  as a shortcut past automatic-compression patience; hard pressure retains its
  independent safety override;
- a normal new user/tool append does not itself authorize retroactive
  dedup/error/age pruning of old provider items;
- one intentional compression/prune rewrite can rebuild the cache, but ordinary
  continuations after it must again keep the rewritten input as a stable prefix.

The installed OpenAI Responses conversion is covered by tests that compare
successive continuation inputs after an intentional exact rewrite. Actual
server-side cache hits still depend on provider routing/TTL and are not promised
by DCP.

Normal-mode guidance explicitly treats compression as a cache tradeoff, not
guaranteed usage/cost savings: batch newly closed stages early when substantial
work remains, rather than compressing each small result. Keep prior summaries
unchanged unless correction or context-limit recovery requires rewriting them;
this is a selection preference, not a prohibition on rollups. Skip optional
near-finish housekeeping when headroom is ample. Context-limit recovery and
explicit user requests take priority. This is qualitative guidance only; it
adds no price table, break-even estimate, threshold, cooldown or manual-tool gate.
The reminder and tool-description prompts do not repeat this explanation.

## Pressure and autonomous policy

Effective pressure is the maximum of fresh repository projection and usable
provider-native usage, so a stale low provider sample cannot hide newly appended
content. Capacity reserves provider output space before applying policy
thresholds; hard-capacity pressure is distinct from the routine soft threshold.

SDK context usage is not always provider-native: after an append-only
`context_edit` (including omission of a failed retry), the SDK can invalidate its
last usage sample and estimate the **uncompressed** session projection instead.
DCP recognizes that fallback only with a complete active-branch proof (no usable
assistant usage after the latest edit/compaction) **and** exact agreement with
the SDK's raw estimate. It then estimates the actual DCP projection with the same
SDK heuristic, retaining resolved system instructions, sections and tool schemas.
This estimate also accounts for new context-hook messages. A usable post-edit
sample, unknown/mismatched scalar, or unavailable usage is not reclassified.
The fresh repository projection remains a floor; actual oversized projections
and genuine measured usage still enforce capacity. The already-rebased estimate
is not eligible for an additional routine post-compression usage adjustment.
No persisted history, SDK dependency or percentage display is patched.
See [decision 0041](../decisions/0041-dcp-sdk-fallback-provenance.md).

Implementation: `external/pi-tools-suite/src/dcp/context-usage.ts` and
`external/pi-tools-suite/src/dcp/index.ts`.
Tests: `external/pi-tools-suite/test/dcp-context-usage.test.ts` and
`tests/dcp-usage-fallback.integration.test.ts` (installed SDK retry, normal/lazy
resume, retained blocks and genuine capacity violations).

Routine reminders additionally account for an intentional compression performed
after the latest measured provider response. Runtime-only calibration binds the
raw/projected token delta of a sent request to its correlated successful assistant
usage. While that exact assistant is still the SDK usage source, a newly applied
compression may subtract only the additional estimated raw/projected savings from
routine pressure. Already-accounted compression is not subtracted again; provider
overhead and newly appended content remain, with the fresh local projection as a
floor. This is not a cooldown and does not alter model-specific thresholds.

The calibration is discarded on session/model/compaction ownership changes and
restart, and is replaced by the next correlated measured response. Missing,
ambiguous or mismatched usage falls back to the conservative estimate. Strong
pressure, input capacity and emergency recovery continue to use the unadjusted
provider-native floor. No external recovery service is needed.
Request diagnostics expose `routineProjectedTokens` and
`routineUsageAdjustmentTokens` separately from raw/projected history counts.

Routine context construction only replays already committed pruning decisions.
It does not discover new retroactive dedup/error/age deletions at each user
turn. `/dcp sweep` is an explicit rewrite boundary.

Sweep also requires completed provider evidence for candidate tool results and
records its resulting rewrite/prune decision durably. Runtime protocol
ownership, cancellation and lifecycle guards are unchanged by this evidence
requirement.

`compress.autoCompress.enabled` remains **false by default**. When explicitly
enabled, an exact safe summary rewrite is preferred under hard pressure. It may
commit positive partial recovery and retain the remaining recovery debt for a
later block; one summary is not required to satisfy the entire accumulated
target. This avoids falling directly from a useful partial candidate to mass
tool-output deletion.

An exhausted routine-reminder patience budget is not emergency pressure. If
planning has no safe/economical candidate below the emergency threshold (for
example, a partial commit leaves only recent or protected content), DCP waits
for a new opportunity without a terminal blocked-progress warning. It retains
the outstanding goal and patience state, so eligible new history can resume
automatic recovery. Diagnostics mark this no-candidate pass as
`awaiting_opportunity`; emergency blocker classification and input-capacity
abort/handoff remain unchanged. The same waiting policy applies to an automatic
`non-positive-gain` or `budget-exhausted` rejection below emergency/capacity
pressure, unless that attempt also encountered a summary-model failure. The
rejection remains in diagnostics, does not publish a replacement, and retains
the recovery goal. Previously degraded extractive mode alone is not a new
model failure. Explicit auto-disabled and actual automatic preparation/model
failures remain reportable.

Blocked-progress warnings are deduplicated by reason within the live recovery
episode. A positive **partial** automatic commit does not rearm an already
reported warning while recovery debt remains; a different blocker reason is
still visible. Full automatic goal recovery, a below-threshold pass, a zero
outstanding recovery goal, or an owner/lifecycle reset rearms warnings. This
affects diagnostic notifications, not automatic recovery or capacity guards.
Covered by `external/pi-tools-suite/test/dcp-progress-opportunities.test.ts`.

Configured model summarizers receive only a bounded sub-deadline of the whole
auto-compression operation, leaving deterministic extractive fallback and
durable publication time inside the same operation budget. Once configured
summary models actually fail/unavailable and DCP falls back to deterministic
extraction, that live session degrades subsequent automatic attempts to
deterministic extraction instead of repeatedly spending the summarizer timeout
on each new tool result. A `non-positive-gain`/budget rejection after a
**successful** model summary is only an economics failure of that exact range
and does not by itself disable the summarizer for later sources.

Rejected automatic plans are memoized by their exact candidate membership, not
by the entire provider tail. If unrelated messages are appended while the same
old safe range remains unchanged, DCP reuses the prior rejection instead of
re-running summary preparation on every new tool result. A genuinely new or
changed source invalidates that memoized rejection.

Compression progress may retain cumulative debt across callbacks so new growth
is not forgotten, but any one automatic recovery plan is capped by the savings
required by the **current** budget. Under active progress/capacity pressure,
raw-tail range planning leaves already-materialized compression blocks in place
and selects only eligible raw history. This prevents a previously economical
summary from being folded together with a tiny new tail on every pass. A
separate automatic consolidation path may periodically merge a **batch of
physically adjacent block-only `bN` summaries**; it never spans raw messages and
is still subject to exact full-projection gain checks. Non-pressure/manual
consolidation can also address `bN` blocks explicitly.

The emergency path protects the current user request, newest live assistant
group, configured recent pairs, explicitly pinned tools/files, and results
without completed provider evidence. `compress.protectedTools` and
`protectedFilePatterns` are empty by default; explicit lists are opt-in and
replace earlier/model-layer values, so an empty list unpins. Independently, a
conservative raw-deletion guard prevents discarding action/effect evidence
without a safe replacement. It is not an exact-retention pin or a hardcoded
verbatim list. If a safe exact summary cannot be prepared and the
hard safety floor must prune eligible old result bodies, those decisions are
explicitly committed and replayed. If the remaining protected minimum itself
cannot fit, DCP records a blocked state and uses the headless abort/handoff path
instead of sending the same oversized request indefinitely. An exact
auto-compression failure at capacity does **not** jump directly to abort: DCP
first re-evaluates the bounded emergency current-turn body-prune floor and only
hands off when the post-recovery projection still exceeds input capacity.
Likewise, a positive partial auto-compression commit is not provider-send
permission when the request is still above input capacity: the same context pass
continues through eligible emergency recovery and otherwise fails closed rather
than sending the oversized projection.
Blocked handoffs emit a user-visible `progress-blocked` diagnostic containing
the reason and capacity figures before `ctx.abort()` is invoked.

Provider send has an additional lifecycle fail-closed gate. A journal-backed
session epoch must complete a provider-ready `context` projection in that same
epoch before `before_provider_request` may proceed. If a `session_start`,
compaction, model/session ownership transition, or equivalent lifecycle reset
occurs after context construction but before provider send, DCP aborts that
stale send with a diagnostic instead of allowing raw/unprojected session history
to bypass DCP. A fresh context pass in the new epoch re-enables provider send.

When emergency pressure has no normal compression candidate, DCP can still
derive same-turn candidates from old, complete assistant tool-call/result pairs.
It never selects user messages, protected/recent pairs, compressed members, or
results that lack completed provider evidence. A strong reminder may therefore
be emitted even when normal range/message detectors return nothing.

Emergency lossy pruning fires only after the configured hard threshold or after
enough completed provider opportunities ignored a strong reminder. Repeated
context transforms alone do not consume patience. Eligible result bodies are
processed deterministically oldest-first until the bounded recovery target is
met; structural tool-call/result pairing remains intact. Successful emergency
pruning clears reminder/progress state and journals the committed prune IDs.

Provider-seen evidence and ignored-reminder patience counters are runtime-only;
restart returns them to conservative unknown/zero state. Journal persistence
covers durable projection/prune decisions and frozen nudge anchors, not a legacy
sidecar snapshot of emergency runtime counters.

Diagnostic events distinguish the important blocked/emergency paths, including
`context.strong_nudge_without_candidate`,
`compress.auto_blocked_no_candidate`, and `prune.emergency_current_turn`.

Manual mode never enables autonomous summary creation. Failed/ambiguous provider
completion does not count as evidence that a result was seen.

OpenAI Responses delivery evidence recognizes both ordinary
`function_call_output` and grammar-tool `custom_tool_call_output` items (including
`codemode`). Their wire `call_id` matches the session's compound call/item ID.
Assistant call items alone are not result evidence. Both output formats still
require a correlated successful assistant completion; HTTP acceptance, failed
streams and aborted streams do not promote results. Completed grammar-tool
results can therefore participate in normal emergency recovery instead of
accumulating as permanently unknown evidence until capacity is exhausted.

## Summary quality and protected data

Agent-authored summaries discard incidental log lines without quoting their
markers or narrating their removal; actionable errors and continuity details
remain preserved.

Auto summary preparation uses a bounded source manifest containing visible
continuation-relevant text and non-secret tool metadata. Credential/header-like
fields and provider signatures are excluded/redacted. Tool groups are not split
merely to fit the summarizer input budget.

`summarizerModel` and `summarizerFallbackModels` are resolved as explicit
ordered arrays (empty arrays are valid); configured refs are de-duplicated and
tried in that order under a bounded model-summary sub-deadline before falling
back to the deterministic extractive continuity representation. The extractive
floor has no unrelated fixed 8192-token output ceiling: large source ranges may
need a larger continuation record to preserve every explicit checkpoint. Its
acceptance is governed by the same exact source/replacement and full-provider-
projection gain checks as other automatic summaries, while source-manifest and
operation deadlines remain bounded. A replacement with non-positive gain is
rejected.

The extractive floor is a continuity index, not a copy of the source. Free-text
checkpoint matching (decision/constraint/verification/next-step wording) applies
to user and assistant prose only; tool output (file reads, logs, search hits)
contributes only label-anchored checkpoints such as `Decision: ...`. Tool-call
string arguments longer than 240 characters (file bodies, patches) are replaced
by a size marker. Error excerpts are bounded to error-keyword lines plus the
tail. An errored result whose identical invocation (same tool and arguments)
later succeeds in the same range is recorded as `superseded_by=<src>` without
an excerpt, so a fixed failure never outranks the final outcome.

Because the extractive floor is much weaker than an agent-authored summary, the
DCP system prompt states who writes summaries: without a configured summarizer
model the agent is told to always write the `compress` `summary` itself; with
one, it may omit it. Protected user/tag/tool fragments and bounded subagent
artifacts are carried through a deduplicated ledger. Exact retention is opt-in
(`protectedTools: []`
by default); `protectTags` defaults true. The 16 KiB default block budget may
discard optional evidence, but policy-version-3 `minimumText` safety floors for
action identity/outcome survive budgeting and journal replay. Simple test/build
floors also preserve parsed counts and parser caveats when available, and a
basis-bounded diagnostic excerpt (up to 768 characters total); the full compact
parsed output is not retained. At most the first two parsed diagnostics are
included, with an omitted-diagnostic count and recover-source instruction when
more exist; bounded error evidence is used if no parsed diagnostics exist. If
those floors cannot fit, compression fails closed. There is no
smaller-of-verbatim policy, hardcoded verbatim-tool list, or anonymous overflow
aggregate. Legacy fragments without representation
provenance cannot be reshaped; missing source records cannot be silently
downgraded. Expanded artifact pins carry policy-v3 owner call ID and raw-output
hash provenance; replacement releases one only when that owner hash verifies
and current config no longer pins its output. Missing, legacy or mismatched
provenance stays retained. Published blocks remain immutable; replacement
creates new blocks and releases the old block's pins.

Mutations and other potentially effectful actions retain source IDs and
available outcome/UNKNOWN, paths, status, log/run/revision references so
continuation does not blindly replay an action; these receipts are not full raw
outputs. Simple test/build digests explicitly describe historical observations,
never current verification. Ordinary inspections and todo/subagent progress are
observations or runtime state, not append-only event history; semantic summaries
preserve their conclusions. Unknown effects remain conservative. Repeatable
observation deduplication does not apply as latest-test-wins across potentially
different code revisions. The raw session is the historical source.

For routine message-mode suggestions, stale reads/observations may be ranked by
projection order, and staleness raises suggestion priority only; it does not
prune by itself. Message-mode suggestions never include user messages. An
explicit `compress` call may select one unless `compress.protectUserMessages` is
set.

Exact v2 source/mutation membership hashes are canonicalized with JSONL-stable
value semantics before publication. In-memory-only `undefined` fields (notably
inside tool-result details), non-finite numbers, unsupported array/object values,
and `toJSON()` objects therefore hash as the representation that can actually
survive session serialization. Restart/reopen alone must not turn an unchanged
block into `exact-membership-mismatch`.

The archive is a safety net, not permission to write weak summaries: active
requirements, decisions, constraints, verification failures, and unresolved
work must remain usable in the working context.

When policy-v3 action-receipt minimums cannot fit the bounded block ledger,
DCP may publish one compact policy-v4 session reference instead of duplicating
those receipts into a second archive. The reference contains raw tool-call
identity hashes and/or addresses to immutable journal-leaf fragments; its
visible text directs recovery through `session action=read
entry_id="dcp:bN"`. Explicit pins and legacy records without proven
representation provenance remain inline and can still make compression fail
closed if their irreducible floors exceed the budget. References do not point
to other references. Replay validates their format, and resolution binds to
the original inputs, output, outcome, and structured details; a missing or
changed source is UNKNOWN and must not authorize repeating the action.

## Recovery instead of decompression

Raw session history remains unchanged by DCP. `session` history actions can navigate it
with bounded overview/search pages, read a known raw `entry_id` directly, and
continue long entry bodies using opaque cursors. DCP control custom entries are
excluded from archive output.

DCP continuity reads are a bounded specialization over that existing session
JSONL. Use `session action=read entry_id="dcp:bN"`; continue a long response
with its opaque `nextCursor`. Recovery is restricted to the active branch and
validates session, branch lineage, and source identity; `scope=all`, missing or
changed references, and stale cursors fail closed with an UNKNOWN warning.
Recovered material is historical context, not current verification, and does
not alter the session or compression blocks.

Recovery returns historical material as a **new tool result**. It never toggles
an old compression block, reinserts raw messages into their former provider
positions, or re-runs mutation tools. If the original source was truncated or
removed by another subsystem, DCP does not claim those unavailable bytes can be
recovered.

## Display filtering

The UI removes recognized DCP control blocks only from the display copy.
Provider/session bytes are untouched. Literal marker examples inside fenced code
or block quotes remain visible. An incomplete/ambiguous control block fails open
instead of hiding the remainder of the assistant answer.

## Configuration

DCP reads its supported configuration from `dcp` in the canonical
`pi-tools-suite.jsonc` configuration. Important defaults include:

- `enabled: true`, manual mode off;
- `compress.minContextPercent: 0.40`, `maxContextPercent: 0.65`;
- routine candidate/message suggestions enabled;
- `compress.autoCompress.enabled: false`, patience 2, no configured summarizer
  model by default;
- bounded emergency-current-turn protection enabled with its limits in
  `defaults.ts`;
- exact/wildcard model overrides where defined by the current schema.

Claude-family omission defaults and the generated starter config use bare-model
globs `*claude*sonnet*` (22%/40%), `*claude*opus*` (26%/44%), and
`*claude*haiku*` (20%/38%) for routine/strong-reminder pressure thresholds. Candidate
and message suggestions use the matching routine fraction. Provider-specific
and exact overrides retain precedence; other families retain their existing
policies. The thresholds scale with the runtime context capacity, not a fixed
token budget, including on large-window variants.

These are local engineering starting points, not Anthropic-certified optima or
the Anthropic API compaction trigger. They extend the existing Sonnet/Opus
policies to direct Anthropic and other Claude aliases without changing automatic
compression opt-in, summarizer selection, or pruning protections. The rationale
is [Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
retain high-signal context and summarize stale tool output while preserving
decisions, unresolved issues, and continuation state. Anthropic's
[API threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)
is a separate mechanism; its absolute-token trigger is not a DCP configuration
recommendation. Profile parity and provider/exact precedence are covered in
`external/pi-tools-suite/test/dcp-config.test.ts`.

The omission defaults above are owned by the browser-safe
`external/pi-tools-suite/src/dcp/defaults.ts`. TUI `loadConfig()` clones those
defaults and then merges the user `dcp` object on top. The generated starter
`pi-tools-suite.jsonc` is initial file content, not the fallback source for a
key that is later omitted from an existing config. Desktop Settings consumes
the same default object (plus the shared debug-log size/backup constants), so a
reset or absent DCP key displays the same effective value the TUI runtime will
use.

There is no persistence-backend selector, sidecar path, legacy state format, or
undo configuration.

## Current limitations / release state

- Old/pre-journal sessions are unsupported by design; create a new session to
  use this DCP format.
- Provider exposure is runtime evidence. After restart an older result is
  treated conservatively as unseen until a new completed request proves it.
- Emergency ignored-reminder counters are runtime state and restart from zero;
  durable pruning decisions still replay from the journal.
- Native compaction or external deletion can make raw archive material
  unavailable; journal replay never guesses replacement members.
- Host session persistence does not promise power-loss durability beyond the
  underlying session manager.
- `autoCompress.enabled` remains opt-in.
- No live provider quality/cache canary is claimed by this implementation pass.

## Implementation

- `external/pi-tools-suite/src/dcp/index.ts`
- `external/pi-tools-suite/src/dcp/subagent.ts`
- `external/pi-tools-suite/src/dcp/context-usage.ts`
- `external/pi-tools-suite/src/dcp/protected-continuity.ts`
- `external/pi-tools-suite/src/dcp/test-output-parser.ts`
- `external/pi-tools-suite/src/dcp/provider-tool-results.ts`

## Tests

- `external/pi-tools-suite/test/async-subagents/dcp.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`
- `external/pi-tools-suite/test/dcp-context-usage.test.ts`
- `external/pi-tools-suite/test/dcp-test-output-parser.test.ts`
- `tests/dcp-usage-fallback.integration.test.ts`
- `tests/dcp-provider-evidence.integration.test.ts`

## Related files

- `external/pi-tools-suite/src/dcp/index.ts`
- `external/pi-tools-suite/src/dcp/defaults.ts`
- `external/pi-tools-suite/src/dcp/config.ts`
- `external/pi-tools-suite/src/dcp/state.ts`
- `external/pi-tools-suite/src/dcp/journal.ts`
- `external/pi-tools-suite/src/dcp/pruner-emergency.ts`
- `external/pi-tools-suite/src/dcp/pruner-candidates.ts`
- `external/pi-tools-suite/src/dcp/stale-observations.ts`
- `external/pi-tools-suite/src/dcp/regret-signals.ts`
- `external/pi-tools-suite/src/dcp/pruner-tools.ts`
- `external/pi-tools-suite/src/dcp/auto-compress.ts`
- `external/pi-tools-suite/test/auto-compress.test.ts`
- `external/pi-tools-suite/test/compress-pruner.test.ts`
- `external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts`
- `external/pi-tools-suite/test/dcp-marathon-replay.test.ts`
- `external/pi-tools-suite/test/dcp-lifecycle-marathon.test.ts`
- `desktop/src/lib/markdown-dcp.ts`
- `desktop/src/lib/markdown-fences.ts`

## Verification

Deterministic coverage includes journal validation/replay, new-session
restart/fork without sidecars, exact membership and stale-owner faults, signed
assistant/provider-prefix invariants, direct paged recovery, UI marker examples,
and long one-user-turn marathons. The current implementation gate also exercises
the installed OpenAI Responses converter and repeated rollups while preserving
continuation-critical facts.

Live provider cache hit-rate/quality remains a separate canary gate and must not
be inferred from local serializer-prefix equality alone.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"928645b848bc2696ce6affb114cb60ae8e10a7297fe0c2d83c60e42167c93955","checkedAt":"2026-10-30T23:15:57.192Z","maxDocumentChars":128000} -->
