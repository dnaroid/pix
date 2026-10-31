---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T00:22:32.222Z","result":{"path":"wiki/assistants/observer/heads-up-observer.md","documentHash":"ccfa63da0540a8054d596e7deb7407366bec204ed71c77dc4a6774fac26df1ca","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (radar), Subagents, then Plan, with no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged.\n\n- Status-bar elements and their detail surfaces do not use browser-native `title` tooltips. Accessible labels remain. Usage shows recorded session spend, an integrated weekly cycle/remaining-quota timeline and a short-window Limits scale, not quota-description paragraphs; compact quota indicators remain in its trigger. See [quota limits](desktop-quota-calendar.md) and [decision 0039](../decisions/0039-quota-reset-calendar.md). Context, Usage and Observer popup lower edges match Plan, touching the top of their triggers with no visual gap. Sidebar tooltips are unchanged.\n\n- Once an active Desktop session runtime is ready, the status bar shows a slightly extended horizontal capacity track without an inline numeric percentage.\n- Compact status chrome labels context as `Context`, omits redundant hourly/weekly and `resets` text (window names and reset meaning remain in click details), and shows Claude Code provider model names without the `Claude Code ` prefix in the model/thinking display. Persistent model names use neutral foreground text and thinking uses muted text, leaving provider brand color to the icon; picker and usage-detail model colors are unchanged. Provider IDs and routing are unchanged. Context and quota use content-sized grid groups rather than equal columns; bounded inline controls clip excess content at very narrow widths instead of painting over neighboring controls, while detail panels remain unclipped.\n","startLine":1,"endLine":33},{"path":"wiki/decisions/0034-heads-up-observer.md","quote":"Desktop users of standalone `heads-up.jsonc` must set the new Desktop profile;\nno automatic migration or default enablement is performed.\n\nThis changes discoverability and configuration, not the observer's inference\nprompt, model-quality claims, or permission to act on findings. Browser\nintegration uses synthetic model/native IPC to verify the UI contract; native\nwindow behavior and real-model usefulness remain distinct verification scopes.\n\n## Desktop compact controls and persistence follow-up — 2026-10-04\n\nStatus: accepted; supersedes runtime-only Desktop enablement above, not TUI\nenablement or profile-default propagation. User approval is in this conversation:\nicon-only eye, grey off / primary enabled / flicker during work, dynamic-only popup,\nthe standard switch, and retaining enablement after application restart.\n\nEvidence: the old popup command called only `setEnabled`, and initialization read\nonly profile defaults, so toggling was lost on runtime recreation. Decision: save\nexplicit Desktop on/off as non-message custom session metadata via the SDK and\nrestore the last valid choice for that session before publishing enabled state.\nBranch navigation does not rewind a session-owned preference. Existing settings\nstill supply the model and limits. No automatic check runs simply on restoration.\n\nAlternatives: writing global defaults would affect unrelated/new sessions;\nbrowser-local storage would separate ownership from durable native sessions and\nrequire replaying commands after reconnect. Neither is necessary to retain the\ncurrent-session switch. Consequences: forks inherit metadata only when present\nin their copied branch, and drafts without a conversation are not persisted.\nTUI behavior, runtime counters/budgets and inference policy remain unchanged.\nRevisit if a global quick-toggle or explicit reset-to-default action is requested.\n\nKeep only the eye in chrome and live diagnostics in the popup; static model and\nbudget settings remain in Settings. This removes duplicated configuration rather\nthan hiding diagnostics. The standard switch preserves keyboard semantics.\n\n## Desktop limited indicator follow-up — 2026-10-04\n\nStatus: accepted; supersedes primary-for-all-enabled states in the compact\ncontrols decision above. User requested a static amber eye for budget-blocked\nchecks, with the limit and earliest known quota release in tooltip and popup.\nThe [current spec](../assistants/observer/heads-up-observer.md#presentation-and-feedback)\ndefines the presentation contract.\n\nEvidence: runtime publishes `limited` for both hourly check and input budgets;\n`windowResetsAt` is the earliest reservation expiry, not a full reset or scheduled\ncheck. Decision: use the semantic warning color, prioritize limited over a live\nnotice in status chrome, and restore primary only on a runtime state update.\nThe finding card remains untouched. Do not infer recovery from wall time, start\ninference, or add polling. Keeping primary hides blocked work; guessing a full\n","startLine":135,"endLine":182},{"path":"wiki/decisions/0048-status-bar-click-popups.md","quote":"- Use modal dialogs: unnecessarily blocks the workbench for status inspection.\n\n## Consequences\n\nDetails require intentional activation. Hover timers and pointer corridors are\nunnecessary. Existing telemetry, billing, quota refresh, controls and session\nownership guards remain authoritative.\n\n## Revisit when\n\nNative keyboard or narrow-window testing reveals unreachable actions or clipped\ndetails, or new status controls introduce a different activation policy.\n\n\n","startLine":45,"endLine":58},{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n  archive hash and version. This is not a GPG verification or an asset attestation.\n- Release preparation removes only the owned compiler outputs (`dist`, and\n  `acp/dist` when building Desktop) before compilation. Stale Vosk models and\n  obsolete emitted JavaScript must not survive a previous local build. Source\n  files and the user's `models/` directory are not deleted.\n- Pix uses the actual `npm pack` allowlist and locked production dependencies,\n  including required optional platform packages. Desktop additionally installs\n  ACP's locked dependencies before conservative deduplication. Development\n  node_modules, HOME, credentials and the checkout are never copied into the\n  payload. Production runtime compilers/loaders such as jiti, and esbuild when\n  present in the production dependency graph, are retained.\n- Layout is `pix/runtime/node[.exe]`, `pix/app/{bin,dist,node_modules,...}` and\n","startLine":1,"endLine":44},{"path":"wiki/configuration/guide.md","quote":"The setting covers model explanations, uncertainty prose, report labels and\nchecker-owned diagnostics. Quotations stay verbatim in their original language;\nfile paths, source IDs and JSON keys also remain unchanged. Unknown native or\nprovider diagnostic messages retain their original text. It does not change\nthe judge model or reasoning effort.\n\nSee [Wiki contradiction checks](../desktop/workbench/desktop-project-wiki.md#contradiction-checks).\n\n### Desktop Observer defaults\n\n**Settings → Desktop → Observer** edits the `headsUp` object in the Desktop\nprofile. For example:\n\n```jsonc\n{\n  \"headsUp\": {\n    \"enabled\": false,\n    \"model\": \"\u003cprovider\u003e/\u003cfast-model\u003e\",\n    \"minTurns\": 6,\n    \"minIntervalMs\": 60000,\n    \"maxChecksPerHour\": 12\n  }\n}\n```\n\nAdditional fields are `maxInputChars`, `maxInputCharsPerHour`, `maxTokens`,\n`timeoutMs` and `noticeTtlMs`. The settings UI shows time in seconds and saves\nmilliseconds. Model refs and numeric bounds are validated; fields can reset to\ndefaults. These settings apply to new or reloaded Desktop runtimes. The\nstatusbar popup's switch saves a per-session choice, restored after app restart,\nwithout changing configuration or other sessions. An explicit saved choice takes\nprecedence over the enable default; all other observer settings still use the\nprofile. A trusted project `.pi/pix-desktop.jsonc` can override defaults.\nDesktop does not inherit `heads-up.jsonc`; that remains the TUI observer config.\nEnabling an observer sends bounded conversation excerpts to its chosen provider.\n\n## pi-tools-suite configuration\n\nThe bundled suite loads:\n\n1. `~/.config/pi/pi-tools-suite.jsonc`;\n2. `$PI_CONFIG_DIR/pi-tools-suite.jsonc` when set;\n3. the nearest project `.pi/pi-tools-suite.jsonc`.\n\nLater files override earlier files.\n\nDisable individual modules with `disabledModules` or\n`PI_TOOLS_SUITE_DISABLED_MODULES`; disable the entire suite with\n`PI_TOOLS_SUITE_DISABLED=1`.\n\nTo hide selected bundled async-subagent roles without disabling the sub-agent\nmodule, use `disabledBuiltinAgents`. A later config layer can re-enable inherited\nnames with `enabledBuiltinAgents`. These keys affect bundled roles only;\nsame-named project roles in `.pi/agents/*.md` remain available.\nDesktop exposes the user-level `disabledBuiltinAgents` list under\n**Settings → Tools Suite → General → Built-in agents**.\nThe same General section exposes built-in suite modules as an enabled/disabled\n","startLine":345,"endLine":401},{"path":"wiki/providers/codex-reasoning-fix.md","quote":"The two cases have different evidence. [First-party Codex serialization](https://github.com/openai/codex/blob/7dae8c53/codex-rs/protocol/src/models.rs)\nomits *empty arrays*, but serializes *absent content as null*. The optional\nResponses `content` schema field does not admit null; [issue #47733](https://github.com/openai/codex/issues/47733)\nreports a **third-party** strict Responses provider rejecting that null. These\nsources motivate matching the first-party empty-array wire shape and omitting\nschema-invalid null respectively. Neither the issue nor our tests verify a\ncurrent ChatGPT Codex endpoint 400 for either shape. There was no backend A/B.\n\n## Exact contract\n\n`stripReasoningContentFromPayload(payload, model)` is active only when the\nselected context model's `api` is exactly `openai-responses` or\n`openai-codex-responses`, `payload` is an object (not an array), and\n`payload.input` is an array. Model provider, id, and any `payload.model` are\nnot gates. For an object entry of that input whose `type` is exactly\n`reasoning`, remove its **own** `content` property iff its value is exactly\n`null` or an empty array. Preserve all other properties, including `id`,\n`encrypted_content`, and `summary`.\n\n| Input / context | Result |\n| --- | --- |\n| Either exact API, reasoning item with own `content: null` or `content: []` | Omit that property only |\n| Reasoning with nonempty content (including a nonempty array), malformed content (`string`, object, number, `undefined`), or absent/inherited content | Preserve item |\n| `function_call_output`, `message`, unknown type, user entry, or non-object input entry | Preserve item even if content is null/empty |\n| `messages`, other payload fields, other APIs, missing/non-array `input`, or invalid model/payload | Preserve unchanged |\n\nOn a change, copy the payload, its input array, and only affected entries;\nnever mutate the original input, items, or nested values. Unaffected entries\nretain their references. On a no-op return the *original payload reference*;\nthe registered hook returns `undefined` in that case, rather than a redundant\nreplacement. The hook registers last in `src/index.ts::MODULES` **within this\nsuite**; a different extension can run later, so this is not a global\nlast-writer or final-payload guarantee. Do not patch `node_modules`.\n\nThe previous predicate removed own `content` from every explicitly typed\nnon-message item and accepted either `input` or `messages`. That was broader\nthan the demonstrated producer and could erase meaningful content on future\nor unknown item types. The installed SDK emits tool results with `output`,\nnot `function_call_output.content`; no real producer/repro justified keeping\na guard for that field. A hypothetical third-party hook is not enough reason\nfor blanket sanitization, particularly without a global hook-order guarantee.\n\nThis change deliberately **removed the existing cache-field stripping\nworkaround**. It never deletes or rewrites `prompt_cache_retention` (nor other\nunrelated fields). In the pinned 0.87.1 SDK, the OpenAI Responses builder uses\n`prompt_cache_options` for models whose compat declares\n`supportsExplicitPromptCacheMode`; with long retention it emits `ttl: \"30m\"`.\nThe pinned OpenAI catalog declares that flag on `gpt-5.6-luna`, `gpt-5.6-sol`,\nand `gpt-5.6-terra`. The Codex request builder does not emit legacy retention.\nThe direct OpenAI builder\nstill emits legacy `prompt_cache_retention: \"24h\"` for long retention when\n`supportsLongCacheRetention` is true and explicit cache mode is false, including\ncustom OpenAI-compatible models with that configuration. Owners of those\ncustom compat declarations, not this reasoning sanitizer, must determine\nwhether their endpoint accepts the legacy field. The offline real-builder\ntest proves retention in that configuration, **not** acceptance by a backend.\nThis evidence and catalog statement are scoped to installed pi-ai 0.87.1;\nrecheck after SDK upgrades.\n\n## Replay and cached WebSocket boundary\n\nThe installed converter's `convertResponsesMessages` parses\n`thinkingSignature` JSON and pushes the item as-is when replaying the same\nprovider/API/model identity. The real-converter test confirms both legacy\nvalues survive that path, while switching the selected model id, provider, or\nAPI drops the empty thinking in its tested fixture. The sanitizer keys off the\n*selected API*, not provider name: a proxy provider on the same API is still\neligible. This is a bounded fixture result, not a claim that every other\nsignature or identity switch behaves the same.\n\nOn the installed cached Codex WebSocket path, the full request body is passed\nthrough the hook before sending. The SDK keeps that sanitized body as\n","startLine":21,"endLine":92},{"path":"wiki/usage/session-usage.md","quote":"  usage still qualify. It opens a separate native modal with\n  rotating-chevron task disclosures, role icons, requested/recorded models,\n  tool-start counts, exact token categories and per-run token/cost totals.\n  Between `Session usage` and `Subagents`, active Claude Code routes or sessions\n  with recorded Claude Code calls additionally\n  show a compact OAuth-account select populated from the user-level\n  `pi-tools-suite.jsonc`. A named selection saves the preferred profile for\n  **future** model requests using a compare-and-swap JSONC write, without\n  changing any currently streaming request. `Default` or `Auto` clears that\n  preference depending on rotation mode. `Last: \u003cname\u003e` indicates the\n  profile most recently attempted in this session; it is not a billing/quota\n  attribution guarantee. Saved quota rows may still reflect a prior login,\n  and merely selecting a profile never triggers network quota polling.\n  Sessions without active or recorded Claude Code calls do not render this\n  selector. With no configured OAuth\n  profiles, the selector and last-attempted-account label are entirely hidden;\n  configuration remains in Tools Suite Settings. Details of profile selection\n  and bounded fallback belong in\n  [Claude Code provider](../providers/claude-code-provider.md).\n  The modal shows the list of subagent calls and their expandable details,\n  without run statuses, session-wide totals, main-agent comparisons or explanatory\n  banners/footer. The role icon sits directly before the role name in a fixed\n  semantic blue, independent of status or primary accent. Recognized providers\n  use shared provider logos before recorded/configured model labels in the summary;\n  expanded details do not repeat model labels or a model table. Unknown providers\n  keep text labels without an empty icon slot. Tool calls appear as a list of\n  names/counts only when nonempty, without a heading or unknown/empty-tool text.\n  The Run path is immediately clickable when project navigation is available,\n  without an existence check while rendering. Only activation validates that the\n  directory exists inside the current workspace; a valid target closes the modal\n  and reveals the folder in Project Files. Missing or inaccessible targets remain\n  plain text after a failed activation. Session/workspace changes and teardown\n  invalidate stale completions. Changed files and their coverage gaps are not\n  displayed in this modal; optional durable changes data remains available in\n  the usage protocol independently of presentation.\n  Completed runs remain visible; no active-only HUD or child-file\n  traversal is used. Old runtimes without the optional breakdown show an\n  unavailable message. Refresh uses the same guarded spend request, never quota\n  refresh or model inference, and retains the last snapshot on failure.\n  Escape/backdrop/close dismiss only the modal and return focus to its invoker;\n  the underlying Usage panel remains open, and session teardown removes both.\n  Backend accounting still conserves main, subagent, side-call and unattributed\n  usage independently of this list-only presentation. Estimated per-run costs\n  in this modal use `~` for API-equivalent pricing.\n  TUI exposes the same persisted child-run breakdown with a `Subagents (n)`\n  action, a keyboard-searchable selector and a separate per-run dialog.\n  It displays role icons, recorded/configured models, task/scope, available\n  tool-start counts, exact input/output/cache counters, per-run tokens/costs,\n  and run identity; unknown telemetry stays explicitly unknown. Estimated\n  child costs use `~`. As on Desktop, it omits statuses, main-agent comparisons,\n  explanatory banners and change-coverage summaries. `Open run` validates\n  existence and canonical containment in the current workspace only when\n  activated; failed targets cease to be actionable. The dialog can scroll\n  using the mouse wheel; leaving the selector returns to Usage, while a valid\n  opened run returns to its session summary. PageUp/PageDown also scroll\n  longer dialog details from the keyboard. Session/tab changes prevent\n  stale reads, menus and run validation from resurfacing an old popup.\n  Desktop displays monetary values without an approximation prefix; estimated\n  model values explain in an accessible label that these are original-model API rates, not\n  subscription charges. `costEstimated` propagates from calls to model, provider\n  and session totals through ACP.\n  Known subscription provider headings offer an accessible external-link icon:\n  Claude Code opens `https://claude.ai/code#settings/usage`; OpenAI Codex opens\n  `https://chatgpt.com/settings/usage?tab=overview`; z.ai (`zai`) opens\n  `https://z.ai/manage-apikey/coding-plan/personal/usage`. Unknown providers get no guessed URL.\n  The native external opener launches the page in the system browser, without\n  refreshing quota or making a model call. Failed opening shows a retryable error.\n- Model labels use the same model-color conventions as the rest of Pix. TUI\n  honors configured `modelColors` rules with the normal provider-palette\n  fallback; Desktop uses its matching model-ref tone mapping and shows the\n  shared provider glyph beside each recognized provider heading.\n- Desktop loads the spend report on demand through `pix/session/usage`; TUI reads\n  the owning session's complete persisted entries on demand. Opening the popup\n  does not start a model request and does not refresh provider quota. TUI\n  retains the last successful report after an explicit spend refresh fails.\n- For an active Claude Code provider session, Desktop also offers an explicit\n  `Refresh limits` action in this popover. This action is separate from opening\n  Usage and from recorded session spend; it nudges a bounded headless Claude\n","startLine":121,"endLine":198},{"path":"wiki/proposals/pix-code-health/brief.md","quote":"5. comment-checker extracts added comments from write/edit/multiedit/apply_patch; ast_apply skipped without cheap diff. Resolves approximate line anchors by reading postwrite files. lastNudgeTimestamp is module-scoped although comment says per-session: do not blindly copy its dedup ownership.\n6. Existing LSP has trusted project-execution config flow, lazy startup, canonical physical-root identity, POSIX project broker and owner leases; different real language workspaces stay distinct, Windows TUI fallback is local. Last owner closes; 15min idle measured from operation completion; monitoring never starts servers or prompts trust. sharedDiagnosticsForFile returns Promise\u003cstring\u003e, not public versioned structured Findings. Do not promise direct reuse as a structured store or fully sandboxed lint execution.\n7. Existing AST-grep suite module invokes external ast-grep executable through pi.exec (120s tool timeout). This is an available integration, not a guaranteed installed runtime parser library. TypeScript is a devDependency; don't assume portable runtime compiler availability without packaging analysis. Desktop Svelte checking exists but doesn't solve generic suite-language coverage.\n8. Disposable task output belongs under unique .pi/artifacts/, harness subagents/QA under .pi/subagents/. Initialized Desktop background cleanup TTL72h and manual cleanup immediate: durable baselines/suppressions must not live in scratch.\n\n## Source-reading guide (read exact sections, no broad repository dump)\nPrimary contract: wiki/assistants/observer/heads-up-observer.md sections Behavior, Constraints and failure cases, Architecture/Implementation; wiki/decisions/0034-heads-up-observer.md and explicitly linked follow-ups only if relevant. Implementation: src/bundled-extensions/heads-up/index.ts (event lifecycle/ownership), controller.ts (cancellation/generations/freshness/physical request ownership), context.ts and inference.ts (evidence bounds/no tools).\nSuite sources: external/pi-tools-suite/src/lsp/mutation-events.ts entirety; src/lsp/index.ts event handlers; src/lib/lsp.ts appendLspDiagnosticsToMutationResult; src/lsp/shared-manager.ts sharedDiagnosticsForFile/owner lifecycle; src/comment-checker/index.ts mutation extraction and final tool_result hook; src/ast-grep/tool.ts process invocation; src/module-catalog.ts and package.json only for availability/packaging questions.\nExisting contracts: wiki/operations/lsp-runtime-control.md; wiki/operations/lsp-trust.md; wiki/decisions/0057-lsp-reuse-idle-cleanup.md; wiki/tools/suite-codemode.md; wiki/operations/harness-artifact-storage.md.\nLive SDK definitions: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts ExtensionToolContext.executeTool, AgentBeforeSettleEvent, AgentSettledEvent, ToolResultEventBase, ToolExecution*Event; dist/core/extensions/runner.js emitToolResult; dist/core/agent-session.js _afterToolCall/_executeNestedToolCall.\nTest-source evidence: external/pi-tools-suite/test/codemode-sdk.test.ts nested event/cancellation tests; test/lsp.test.ts mutation append/dedup/deletion behavior; test/lsp-idle-cleanup.test.ts; tests/heads-up-controller.test.ts stale/ignored-abort/teardown tests. Reading tests is not running them.\n\n## Assumptions / open questions\n","startLine":24,"endLine":36},{"path":"wiki/development/testing/session-revision-evaluation.md","quote":"   may be superseded. `reported` means claimed in the transcript, not verified.\n4. Query vectors rank source spans. A small assertion-local overlay attaches later\n   decisions/reports to each of the top three spans without deleting history or\n   suppressing the whole source message. As-of queries exclude later spans and\n   edges; historical mode suppresses overlays. This is **not a general relation\n   graph**: reversals through intermediate nodes, reaffirmed latest reports and\n   non-assertion anchors remain unresolved. Raw rankings are retained for comparison.\n\n## Corpus and scoring\n\nThe JSON corpus is an array of cases, each with `id`, `split`, ordered\n`messages: [{id, role, text}]`, `expected`, and optional `queries`.\n\n- Relations: `{earlierId, laterId, relation, evidence}`. `evidence` is an exact\n  substring of the earlier message and must occur **inside the candidate span**,\n  not just context or another fact in the same message. Sparse gold annotations\n  measure recall of those particular spans; other semantically equivalent spans\n  are not automatically credited or deemed wrong.\n- Queries: `{text, decisionId, reportedId, asOfId?, historical?}`. Expected IDs\n  identify the user decision and most recent reported state, separately. Historical\n  IDs identify the state at that point. The overlay only approximates this contract;\n  failures are retained, including its inability to treat factual user assertions\n  as baseline reports or follow reversals transitively.\n- Report candidate recall on positive labels separately from classification on\n  retrieved annotations, false replacements on retrieved negatives, and unseen\n  negatives. Missing candidates never become classification successes.\n- Report raw/overlay top-1 decision and reported-state hits separately. This is a\n  small within-conversation retrieval eval, **not global session-search quality**.\n- `unannotatedAccepted` is mandatory review material, not precision evidence.\n\n`fixtures.json` contains 12 separately authored synthetic challenge cases (English\nand French). The research author did not inspect implementation or prior pilot\nartifacts. The parent checked the labels **before the first run**, correcting eight\ncontract mismatches (assistant promises, unchanged requested-value implementation,\nunmet conditions and failed attempts), preserving `originalRelation`; six explicit\nuser-change edges were added. Therefore this is an **independently authored,\nparent-adjudicated control set**, not a blind or statistically representative test.\nSynthetic controls and the real regression session are scored separately. Once\nobserved, these controls become development data for any subsequent tuning.\n\n## Reproducibility and storage\n\nEach run writes a unique `.pi/artifacts/session-revision-eval-*` directory:\n`plan.json` freezes corpus, prompts, hashes, parameters and Node/ICU versions;\n`results.json` records candidates, choices and source spans; `summary.json` separates\nmetrics by split; `requests.json` records new-call usage/cost, not credentials.\nReplay imports no provider/auth module and sends no network requests. Missing cache\ndata exits 2. Provider failures are sanitized; partial completed cases remain visible.\n\nSuccessful embeddings are cached by config identity and exact prefixed input;\nchoices by classifier version, model, prompt, state and full supplied branch hash.\nBranch edits/forks invalidate classification reuse. Changed vectors/prompts never\n","startLine":51,"endLine":102},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output\n   needed by current policy can be reconstructed from the raw branch. Large raw\n   tool bodies are not duplicated into the journal.\n4. `context` builds a detached provider projection, applies already committed\n   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and\n   candidates, and publishes any new durable projection decision before the\n   resulting bytes may be used by the provider.\n5. `before_provider_request` records which tool results actually occur in the\n   outgoing payload. `after_provider_response` treats HTTP status as diagnostic\n   acceptance only. A successful finalized assistant `message_end` can promote\n   provider evidence when the local attempt is unambiguous. This evidence is\n   runtime-only and returns to unknown after restart.\n6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.\n","startLine":1,"endLine":57},{"path":"wiki/desktop/guide.md","quote":"has its own side conversation. **New conversation** clears it. Closing/replacing\nthe parent runtime, reconnecting or exiting discards the temporary conversation;\nit is not saved into the main chat or restored after restart.\n\nUse **Copy** or **Insert** on an answer to reuse it. Insert requires an empty main\ncomposer with no attachments and only writes a draft; it never sends it. Model\nusage still counts towards the original session. See the [BTW contract](conversations/desktop-btw.md).\n\n## Observer (experimental)\n\nThe **binoculars** on the right of the statusbar are grey when Observer is off and primary-colored\nwhen enabled, except static amber binoculars while blocked by an Observer budget limit.\nThe tooltip and popup say «Достигнут лимит проверок» and show the earliest known\nquota release time (not a promised check or full reset). Once the runtime clears\nthe limit, the binoculars return to primary. They pulse only while checking (unless reduced motion is enabled).\nClick it for the **current-session switch**, **Check now**, current state/reason,\nlast check result and duration, and actual usage counters. The switch is saved\nwith this session and restored after restart; other sessions are unaffected.\nOpening this popup does not\ncall a model. Checking does consume the selected provider's tokens/quota.\n\nThe popup's **Observer settings** action opens **Settings → Desktop → Observer**.\nChoose the observer model independently of the main agent, set enablement for\nnew sessions and cadence, and expand advanced budgets/timing for input/output\nlimits, timeout and notice lifetime. Save applies defaults to new or reloaded\nsessions; it does not change the active session's switch. Trusted project\nconfiguration can override the user defaults. TUI settings are independent.\n\nFindings still appear above the composer with evidence and feedback. **Insert\nquestion** only fills an empty draft; it does not send it or change code. A\nwaiting observer may need more completed agent turns, not only elapsed time.\nSee the [feature contract](../assistants/observer/heads-up-observer.md) and the\n[reproducible evaluator](../assistants/observer/evaluation.md) for limitations and checks.\n\n## Updates\n\nPackaged production Desktop builds use Tauri Updater. On startup Pix checks the\nsigned release feed; when a newer version exists, the UI exposes an Update\naction with download progress.\n\nWindows uses the packaged installer flow. macOS/Linux offer Restart after the\nreplacement is ready. Development/watch builds do not run the production\nupdater, and Desktop never falls back to npm or the portable-TUI updater.\n\n## Linux AppImage blank window: `EGL_BAD_PARAMETER`\n\nThis issue was reproduced on a Fedora/Bazzite-family Wayland/Mesa system. The\nrepository keeps the original diagnostic handoff separately; the instructions\nbelow are the generalized user-facing fix.\n\n### Symptom\n\nPix Desktop launches a window, but the WebView remains blank. Starting the\nAppImage from a terminal shows:\n\n```text\nCould not create default EGL display: EGL_BAD_PARAMETER. Aborting...\n```\n\n","startLine":204,"endLine":262},{"path":"wiki/proposals/pix-code-health/discussion.md","quote":"\n### round-1-participant-2 — zai/glm-5.3\n\n## Coverage gaps\n\n- No `repo_context`/`repo_*` or web tools in this slot; only `read`/`grep` (exact paths). No index or semantic retrieval used, per constraints.\n- Brief's cited path `src/comment-checker/index.ts` does not exist; actual file is `external/pi-tools-suite/src/comment-checker/index.ts` (read in full).\n\n## Verified repository evidence (facts)\n\n- **P2-F1**: `lastNudgeTimestamp` is module-scoped (`let` at top level, comment \"Shared mutable state (module-scoped...)\") while the handler comment claims \"per-session\" — `external/pi-tools-suite/src/comment-checker/index.ts:259-287`. Copying this dedup pattern would cross-contaminate concurrent sessions/worktrees.\n- **P2-F2**: SDK confirms `AgentSettledEvent` carries only `aborted: boolean`; success/failure outcome lives on `AgentBeforeSettleEvent` via `BoundaryState.outcome` (`dist/core/extensions/types.d.ts:766-781`).\n- **P2-F3**: Observer spec confirms a complete off-critical-path scheduling contract: settlement-gated cadence (≥6 completed turns/60 s), rolling budgets, physical request lock, strict evidence-freshness invalidation, no injection into/resume of the parent, no independent file reads (`wiki/assistants/observer/heads-up-observer.md`, Behavior/Context-and-cadence).\n- **P2-F4**: `getEventPaths`/`isMutationToolResult` exactly as briefed — changed-files heuristics are candidates, not FS proof (`external/pi-tools-suite/src/lsp/mutation-events.ts`).\n- **P2-F5**: `editsFromAstApply` returns `[]` — even the existing delta consumer skips `ast_apply`; any new delta pipeline inherits this hole.\n\n## Ideas (assumptions and proposals, not facts)\n\n**P2-C1 (critical case)**: Before any engine: dirty worktrees mean no proven pre-edit baseline; child-reported edits don't establish parent authorship; syntax matches prove nothing (brief's own caveats, corroborated by P2-F4/F5). Precision below ~high would make cards noise and burn the Observer's hard-won trust. Cheap options (P2-A3/A4) likely cover most guardrail categories. *Test*: run any candidate detector over this repo's real history; measure findings a maintainer would act on. If unmeasurable, don't build the engine.\n\n","startLine":113,"endLine":132}],"notices":["Результат 1 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз.","Результат 2 не прошёл проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":64,"excerptedSources":12,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->

# Heads up observer (experimental, opt-in)

Rationale and alternatives: [0034 — Bounded, opt-in Heads up observer](../../decisions/0034-heads-up-observer.md).

## Behavior

Pix offers an optional passive observer of a coding conversation. It looks for
up to three independent concrete, consequential, probably unnoticed contradictions or tradeoffs in
the current task. It is not a code reviewer or an enforcement mechanism: it
cannot inspect files independently and must not claim facts absent from its
input. The normal result is no notice.

The implementation uses one provider-neutral registry inference, not a child
agent, forked agent session, subprocess harness or tool loop. The request has
no tools, tool choice `none`, low reasoning, zero retries and no implicit model
fallback. The initial model reference is `openai-codex/gpt-6-luna`, a candidate
for evaluation rather than a measured quality winner. Missing credentials or
model availability is reported as a controlled status, never replaced silently
with the parent model. Ordinary work in the parent is never awaited or resumed
by an observer result.

It is off by default. `/heads-up on` enables the current runtime/session;
`/heads-up off` cancels work. `/heads-up check` explicitly checks an enabled
observer, and `/heads-up status` shows phase, model and recorded counters.
`/heads-up model provider/model-id` chooses its model without changing the main
agent. Commands are registered extension commands; ACP executes them out of
band without taking over the active parent run.

TUI configuration is read from the agent directory's `heads-up.jsonc`, followed
by a trusted working directory's `.pi/heads-up.jsonc`. Desktop instead reads the
`headsUp` object in `~/.config/pi/pix-desktop.jsonc`, followed by the same object
in a trusted working directory's `.pi/pix-desktop.jsonc`. Desktop never inherits
standalone `heads-up.jsonc` or TUI `pix.jsonc`; no automatic migration is made.
Invalid JSONC and oversized files are ignored. Standalone files are bounded at
16 KiB; a complete Desktop profile may be up to 1 MiB. Comments and trailing
commas are accepted. `enabled: true` explicitly opts new/reloaded runtimes in;
`model` is a provider/model reference and numeric settings are clamped.

Desktop Settings → Observer edits these saved defaults using the existing
conflict-checked JSONC save flow, preserving unrelated keys and comments. It
offers a model picker, default-enable switch, completed-turn cadence, minimum
interval, and an advanced group for per-check/hour input limits, checks per
hour, output tokens, timeout and notice lifetime. Timing fields display seconds
and persist milliseconds. Fields have labelled controls and reset-to-default
actions; settings search can reveal advanced fields. A trusted project override
can supersede user defaults. Saved changes apply to new or reloaded runtimes,
not silently to active sessions. Runtime toggles/commands never write config.
Desktop explicit on/off commands persist a versioned `pix-desktop-observer-enabled`
custom session entry (not a conversation message or model input). The last valid
boolean choice in that session overrides the configured enable default on reload
or app restart; unrelated sessions and profile defaults are unchanged. Branch
navigation does not rewind the session preference. Forks inherit only metadata
copied in their source branch; a fork without that entry uses defaults. Invalid
entries are ignored. A failed save must not publish a successful toggle. Drafts
without a conversation are not durable sessions. Restoring a choice never starts
inference by itself. TUI on/off remains runtime-local and ignores this Desktop
metadata. Deduplication, limits and check history reset on runtime recreation;
usage entries are durable. There is no cross-session knowledge profile.

## Context and cadence

Automatic checks need at least six new completed agent turns and sixty seconds
since the last check (or initial runtime creation). `turn_end` accumulates cadence
and evidence, but does not launch inference. A successful final `agent_settled`
opens the automatic opportunity, after repairs, retries and queued continuations.
The outcome comes from the final `agent_before_settle`; abort/error settlement
does not launch a check. Pending automatic work waits while the parent runs.
No inference promise is returned to the parent hook. A manual check can run
immediately, even during the parent run, bypassing cadence but not enablement,
concurrency, availability or budgets. Todo boundaries are not observer triggers.

A newly accepted delegated completion is another coalesced automatic opportunity:
it does not require six more primary turns or wake the parent. A single timer
waits for the same minimum interval and physical request lock. An idle parent
needs no synthetic settlement; a running parent must settle successfully first.
Arrivals during a request remain pending for a later check. All
availability, input and rolling-hour limits still apply; a refused opportunity
does not poll until a budget becomes available. Invalidation cancels the timer.

An open stack does not suppress discovery. Successful settlement after new completed turns, or a delegated
completion while idle, can queue a review without another six-turn threshold.
Changed bounded evidence (user/tool/delegated records or cited assistant
text), or a retained stack suspended by a new parent run, permits automatic review;
ordinary assistant progress alone does not create an opportunity.
The same request/input/hour/output limits apply. One request both reviews all active
cards and discovers new independent findings, returning the complete supported set
of at most three, not a delta. Existing IDs, titles and consequences are untrusted
`activeNotices` within the payload budget. Descriptors may be explicitly clipped
to reserve evidence space at small limits; identities are not silently dropped.
Supported unresolved cards retain ID, creation time and expiry; omitted cards are
removed and `none` clears the set. A successful unrelated check does not imply
resolution. Retained cards keep their relative order before new discoveries;
the prompt prioritizes supported active cards over filling slots. Exact normalized
issue-identity duplicates are merged (including a new candidate matching an active card),
and previously closed topics remain subject to bounded deduplication. Semantic
independence/deduplication still relies on the model, not a deterministic classifier.
Invalid/error/unavailable/budget-refused assessments preserve retained identities under
the original per-card TTLs, but never restore unconfirmed cards to visibility.
No extra request is made per card and no periodic
polling is added. Manual Check now reviews and discovers even without new evidence.

New-discovery-only automatic opportunities use a runtime-local adaptive interval:
each explicit `irrelevant` or `incorrect` verdict raises the multiplier from 1 to 2
to 4 (capped); `useful` resets it to 1. Already-known, dismiss, expiry, silence,
ordinary work and successful/empty assessments do not change it. The completed-turn
threshold is unchanged; delegated opportunities still bypass only that threshold.
Any retained card, including a hidden one awaiting review, keeps the base interval
for the combined review/discovery request. Manual checks bypass adaptation as well
as normal cadence. Removing/expiring the last card reschedules a queued opportunity
under the discovery interval; feedback never creates an opportunity by itself.
Existing budgets, availability, physical request ownership and no-polling rules
remain intact. Status explains negative-feedback slowing and the unchanged review/
manual paths; eligibility is not a promised launch time.

### Strict visible freshness

Starting a parent run or completing a meaningful user/tool/delegated evidence
event immediately hides the entire previous stack, without a projection rebuild
or inference. User/tool `message_end` invalidation occurs even before persistence;
ordinary assistant progress does not trigger it. Projection comparisons additionally
detect changed or removed cited evidence at turn/check boundaries. Hidden cards
remain private review candidates, not claims that a problem still exists or has
been resolved. Their original identities and expiry times are retained.

Only a successful assessment against current evidence with the parent settled
can restore supported cards. Manual checks may start while the parent runs, but
cannot publish claims while it is running; changed evidence or a new run across
the request invalidates its result. A bounded fresh opportunity waits for settlement.
Missing/clipped evidence is not confirmation that a retained problem persists.
Errors, malformed responses, unavailable context/model and budget refusals leave
unconfirmed cards hidden. They do not schedule retries or polling. The existing
interval, hourly and input/output limits still apply. This is evidence freshness,
not a guarantee of model correctness or independently inspected repository state.

Default limits are twelve checks per rolling hour, a 16,000-character serialized
observation payload, 192,000 payload characters per rolling hour, 900 output
tokens and a twenty-second request timeout. The fixed system instructions are
additional to the payload character budget. Reservations are made before the
request and are not refunded on errors; toggling or changing models does not
reset limits. These are initial experiment defaults, not measured optimal
values. Full token usage is reported separately from payload character limits.

Immediately before a real check, Pix reads its existing in-memory, active,
compaction-aware session projection. Context edits and branch changes are
respected instead of resurrecting raw history. It retains the first surviving
user request, recent user instructions and a bounded set of recent work records;
user requirements are separately tagged from assistant claims. Only bounded
text and bounded tool arguments/results are included, with real source-entry
IDs. Thinking, image bytes and full logs are excluded. Omission/clipping is
explicit. No full-history scan occurs per render or per streamed token.
Selected records are serialized in projection order. Apart from pinned user
instructions, work records form a contiguous recent suffix: a record that does
not fit ends selection, rather than allowing an older small failure to replace
a larger fresh retest. Shell and codemode results use the same bounded text path;
nested codemode evidence is its returned aggregate text, not independently
invented child tool records. Prefix clipping still applies to long individual
records; omitted text is never proof that no correction/retest exists.

### Delegated work (first increment)

The suite publishes a runtime-only versioned `async-subagents:delegated-evidence`
bridge independently of its generic completion messages, wait delivery and
parent follow-up arbitration. Capture starts synchronously at spawn execution,
before routing/authentication awaits, with a unique launch ID, captured parent
session/branch anchor and child ID. The final retry/fallback completion binds the
actual run directory and reads the child result from the session-native store:
live final text, a parent-authored completion message, the last non-error assistant
message in the child session JSONL, or an owned-launch result. A compact structured
summary is the fallback; the retired per-agent `result.json` sidecar is not read.
Only the final visible report is used, never hidden thinking, full logs or
shared-working-tree diffs. The bridge clips reports at 6,000 characters and marks
them as clipped; unreadable, empty, foreign or mismatched results produce no
evidence. No replay or adoption of previously launched workers occurs.
Prelaunch exits (routing/model errors, aborts or setup errors) retire unbound
captures; cancelled/failed launches retire their captures without invented reports.
Returning from a successful spawn does not retire background children.

The enabled parent observer must have observed that launch in its current
lifecycle. Evidence additionally requires the anchor in the active projection
when input is assembled. It holds at most 64 pending launches and 64 completed
reports; duplicate completions are ignored. Disable, new user request, stop/error,
model change, branch/session replacement, compaction and shutdown retire captured
ownership. Enabling again does not adopt an earlier child. This conservative rule
can omit a still-running child's late report after a task boundary.

Records have a `delegated:` launch ID and are explicitly **child-reported, not
verified mutation/test evidence**. Process status and “done/tests pass” do not
prove correctness. A concrete reported design change can contradict a user
requirement; any notice must attribute it to the report rather than claim an
independent inspection. Generic custom completion notices alone are ignored.
Reports use the same redaction, 3,000-character record bound and total input budget;
clipping is explicit and missing text is not proof of failure. Read retained
corrections/retests in order, rather than extracting old risk fragments. Verified
per-child changed-file or test-command/outcome provenance is not implemented:
current compact child artifacts do not provide it. Children never run an observer.

Verification contradictions must match actor, assigned scope, run/check and time.
A research-only child's “I did not run it” is not evidence against a later parent
run. Consult retained parent tool results and corrections; delegated reports are
appended after projected parent records, not a global chronological event stream.
Missing or clipped run evidence means unknown, not failed/not run; default to
silence without a concrete supported conflict. Conversely, an explicit failure
for the same run/check is not overridden by an unsupported parent success claim.
Diagnostics (LSP, lint, type errors) inside one tool result or script can be
stale: a later step of the same output, or a later result showing the file
exists, the check passes or the agent verified it, supersedes them. Superseded
diagnostics are not grounds for a notice.

Common credential patterns, private-key blocks and control sequences are
filtered. This is best-effort redaction, not proof that arbitrary project text
contains no secrets or personal data. Enabling an observer sends the selected
conversation excerpts to its configured model provider. Input data is not
trusted instruction text; unknown evidence IDs, extra fields, malformed or
truncated replies and tool calls are rejected. Valid evidence IDs establish
provenance, not the correctness of a model inference.

## Presentation and feedback

At most three notices are active, with only one short card visible above the
composer. Multiple cards show a position counter and previous/next navigation.
Navigation is local and free: TUI uses `/heads-up prev` and `/heads-up next`;
Desktop uses accessible buttons. Selection remains stable by ID through updates;
removing/expiring the selected card selects its next surviving neighbor (or the
last survivor). TUI uses a keyed widget;
Desktop consumes the structured `heads-up` session-state channel. Desktop
validates bounded payloads, rejects stale revisions of the current instance, and
rejects snapshots from the 32 most recently retired instances per session.
Snapshot version 1 adds optional `notices` and `awaitingReview`; older singleton snapshots remain
readable. New arrays contain at most three unique validated cards; `notice` is
the selected member or null for an empty array. `awaitingReview: true` requires an
enabled observer and an empty visible stack (`notice: null`); no retained claim
text is published. TUI shows a neutral “Awaiting fresh review” widget; Desktop
removes the card and exposes the wait reason in Observer status. Desktop selection is runtime/session
scoped, survives same-owner updates, and resets on replacement. Each card expires
independently even when hidden. Feedback and discussion target the displayed ID;
Desktop rejects callbacks captured from a replaced instance. This
bounded in-memory retirement history is not an arbitrary-history replay guard:
an instance evicted from it is no longer rejected solely by its instance ID.
Feedback actions include `known` (already understood), `irrelevant` (not useful to
this task), `incorrect` (disputed accuracy), `useful` and `dismiss` (no accuracy or
relevance verdict). Each removes only its target ID so a stale action cannot clear
a newer card. TUI exposes these `/heads-up` commands; Desktop has labelled buttons.
Shown is recorded separately from explicit feedback. Nothing is inferred from silence.

Each notice may carry the paired bounded `topic` (issue kind, 80 characters) and
`subject` (affected symbol/path, 160 characters). The prompt requests both; legacy
four-field responses remain accepted and use normalized title/consequence identity.
Malformed pairs/unknown fields reject the whole reply. A retained ID cannot change
its existing topic/subject; a legacy reply omitting the pair inherits it. A legacy
card without a pair may gain one during review, preserving its ID, TTL and shown
count; the pair is immutable thereafter. Same-key
paraphrases merge while preserving active ID/order/TTL. Subject punctuation/case
is preserved; distinct subjects may have independent issues of the same kind.
Model-provided identity is a hint, not a semantic correctness guarantee.

Task memory contains at most 32 structured records: shown/verdict, issue identity,
title/consequence and supporting IDs. Internal bounded evidence-text fingerprints
(case/whitespace-normalized, independent of citation IDs/order) suppress the same
issue on the same evidence, including after dismissal or expiry. Changed evidence
can make it eligible again, but the prompt requires materially new circumstances,
not extra irrelevant citations or mere rewording. Known is not permission to violate
a requirement. The model must still establish relevance; deterministic identity/
fingerprint matching is not a semantic classifier. New non-extension user input
is a conservative task boundary and clears this memory, as does lifecycle context
clearing (branch/switch/fork/compaction). Off/on and model changes retain it within
the task. Runtime recreation resets it; no persistence or cross-session profile exists.

Up to 16 recent structured records share at most a quarter of the serialized input
budget with legacy textual history. Evidence keeps priority; active descriptors
can omit optional topic/subject when space is tight, explicitly marked clipped,
without dropping active IDs. Feedback is untrusted data, not repository evidence.
Counters for shown/useful/known/irrelevant/incorrect/dismiss and the discovery
multiplier are runtime-local, survive task boundaries, and reset on runtime
recreation. Status shows them locally; no external analytics, transcript feedback
logging or automatic judgments of user expertise are added. Optional snapshot
details and notice identity fields preserve readability of older snapshots.
Shown counts accepted new cards, not navigation impressions or retained-card reviews.

`/heads-up explain` expands existing evidence in TUI. Desktop has an evidence
expander and feedback actions; expansion never makes another model request.
Desktop management lives in a persistent statusbar Observer item, not in the
composer actions menu. The trigger contains only a 16px telescope: grey when off/unready,
primary when enabled (including waiting and error states), except a static amber
telescope while budget-limited. Limited status takes precedence over an existing finding
in the trigger/popup; the finding card remains separate. The limit label is
«Достигнут лимит проверок»; accessible label and popup include the earliest known reservation
expiry (or explicitly unknown), not a promised check time or full reset. Input
budget exhaustion is distinguished in the detail. A runtime update clearing the
limit restores primary; wall-clock expiry alone does not claim recovery. The same telescope
pulses only during a real checking phase, respecting reduced motion; no spinner,
visible status label or notice badge is shown. Accessible label and popup
distinguish off, waiting, checking, finding, unavailable/error and limited states. A draft
or unready runtime still allows opening settings, but not session controls.
Cards expire after five minutes by default, including while the main agent is
idle; the existing evidence/feedback card stays above the composer.

The statusbar popup contains the standard SettingsSwitch for the current session,
explicit Check now and an Observer settings deep link. It shows dynamic state and
wait/error reasons in plain language, with last check time and its outcome visible
by default. A no-finding outcome means nothing new to flag, not a guarantee that
the work is correct. A keyboard-reachable Technical details disclosure holds
duration, raw runtime reason, new completed turns, actual rolling/total checks,
used input characters, recorded input/cache/output tokens, feedback counts and
discovery slowdown. Details start collapsed on each opening; toggling them is
presentation-only and never requests inference. Waiting copy explains remaining
agent replies and interval gates without promising a timed check.
It toggles on button activation (click, Enter or Space), never pointer hover or
mere focus. Pointer departure leaves it open; repeat activation, outside click,
Escape or focus leaving the trigger/popup dismisses it. Opening does not steal
focus. The popup lower edge touches the trigger's top, matching Plan
without a visual gap or intervening dead pointer region.
The trigger has no browser-native tooltip. See [status-bar click popups](../../decisions/0048-status-bar-click-popups.md).
Configured model, cadence, interval and budget ceilings stay in Settings, not the
popup. Earliest reservation expiry is shown only while limited. Never-run,
no finding, finding, suppressed duplicate, malformed reply, error, timeout and
cancellation are distinct results. Older snapshots without optional `details`
remain readable; missing details are unavailable, not claimed successful checks.
Eligibility time is not a promised launch time: automatic work still requires
a successful final settlement or a pending evidence opportunity while idle, and the
remaining gates must pass. The earliest reservation expiry is not a full reset.

Opening the popup may issue `/heads-up snapshot`, a quiet out-of-band state
refresh with no inference, context assembly, transcript notification, or parent
run. Without a snapshot it is sent only for a registered extension command.
Opening cannot enable the feature or alter the composer. Counter refreshes can
clear a fully expired limit without starting a check. Its display clock only
runs while the popup is open. Pending button requests, session switches,
disconnects and retired runtime instances are ownership-guarded. The popup
closes on owner replacement/unready transitions; a first snapshot completing
initial loading does not close it. Escape restores trigger focus; outside
click dismisses; popup controls are keyboard reachable. Closed UI does not
intercept Escape. Popup geometry stays inside narrow viewports. Settings deep
links wait for asynchronously loaded sections and focus the Observer heading.

`/heads-up discuss` in Pix TUI, or Desktop's Insert question action, only fills
an empty composer with no attachments and no blocking dialogue. It never sends
the draft, overwrites user text or starts a parent turn. The draft contains only
the note title and consequence (no wrapper, evidence records or internal IDs);
attachment mentions and effort-shortcut words are neutralized.
No number-key interception, automatic modal dialogue, generated learning page
or auto-fix exists in this experiment.

## Lifecycle, accounting and failure cases

Each controller owns one runtime/session. New genuine user input, stop/error,
disable, model changes, compaction, branching or shutdown invalidates pending
results. Before publishing a finding or applying an existing-card review, the
observer refreshes the projection and compares bounded evidence with that used
for inference. New/edited/removed evidence discards the completion and coalesces
a fresh assessment under the same interval/budgets; unrelated success does not
automatically declare an old failure resolved. Any finding/review, including manual,
waits for a fresh assessment if the parent has resumed. An evidence-event revision
also rejects changes observed before their message is persisted. Ordinary uncited assistant
progress does not invalidate a result. Generation remains a lifecycle/request
guard and revision remains UI snapshot ordering, not evidence freshness.
Dismissed/expired cards cannot be resurrected by a late assessment: any membership
change discards that assessment atomically rather than overwriting survivors or
resurrecting a closed card. Navigation alone does not invalidate inference. Session replacement
cannot publish a late result to the new session. Teardown clears timers and abort
listeners. Previously displayed assertions are hidden immediately on invalidating
evidence or parent start; reassessment waits for settlement and can remain
limited/unavailable until the retained cards expire.

Timeout actively aborts inference. If a provider ignores cancellation, the UI
stops waiting but the physical in-flight lock remains until the request settles;
no queue of overlapping requests is created. A permanently non-settling provider
therefore requires runtime recreation before checking again.

Finalized replies with valid usage are recorded as `appendUsage("heads-up", ...)`
on the captured originating session manager, including stale/aborted replies
that still supply usage. Provider errors without usage cannot be reconstructed.
An absent accounting capability refuses work; an accounting failure blocks
subsequent checks. Spend is never attributed to whichever tab happens to be
active. There is no external feature analytics or transcript logging; structured
runtime status is local UI state, not a new external telemetry service.

`PI_OFFLINE` is a hard stop. Print/JSON, standalone RPC without the Desktop
bridge, UI-less draft runtimes and suite subagent runtimes do not activate the
observer. This feature does not inherit into ordinary async-subagent workers.

## Implementation

- `src/bundled-extensions/heads-up/index.ts`
- `src/bundled-extensions/heads-up/desktop-preference.ts`
- `src/bundled-extensions/heads-up/controller.ts`
- `src/bundled-extensions/heads-up/notices.ts`
- `src/bundled-extensions/heads-up/feedback.ts`
- `src/bundled-extensions/heads-up/config.ts`
- `src/bundled-extensions/heads-up/context.ts`
- `src/bundled-extensions/heads-up/delegated.ts`
- `external/pi-tools-suite/src/async-subagents/delegated-evidence.ts`
- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/tools/subagents.ts`
- `src/bundled-extensions/heads-up/inference.ts`
- `src/bundled-extensions/heads-up/parser.ts`
- `src/bundled-extensions/heads-up/presentation.ts`
- `src/bundled-extensions/heads-up/settings.ts`
- `src/bundled-extensions/heads-up/usage.ts`
- `src/bundled-extensions/heads-up/contract.ts`
- `src/app/runtime.ts`
- `desktop/src/app/heads-up.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/components/HeadsUpCard.svelte`
- `desktop/src/lib/heads-up.ts`
- `desktop/src/lib/observer-status.ts`
- `desktop/src/components/ObserverStatus.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/app/desktop-shell-view-model-services.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/settings/SettingsObserver.svelte`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsNumberInput.svelte`
- `desktop/src/components/settings/SettingsSwitch.svelte`
- `desktop/src/lib/settings.ts`
- `desktop/src/lib/settings-viewport.ts`
- `desktop/src/lib/settings-navigation.ts`
- `desktop/src/lib/default-desktop-config.ts`
- `src/schemas/pix-desktop-schema.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src-tauri/src/backend_runtime.rs`
- `scripts/heads-up-eval/cases.ts`
- `scripts/heads-up-eval/scoring.ts`
- `scripts/heads-up-eval/runner.ts`
- `scripts/heads-up-eval/options.ts`
- `scripts/heads-up-eval/run.ts`

## Tests

- `tests/heads-up-controller.test.ts`
- `tests/heads-up-notices.test.ts`
- `tests/heads-up-feedback.test.ts`
- `tests/heads-up-context.test.ts`
- `tests/heads-up-extension.test.ts`
- `tests/heads-up-delegated.test.ts`
- `external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`
- `tests/bundled-question-extension.test.ts`
- `desktop/src/app/heads-up.svelte.test.ts`
- `desktop/src/app/heads-up-reactivity.test.ts`
- `desktop/src/app/desktop-workbench-prop-builders.test.ts`
- `desktop/src/lib/heads-up.test.ts`
- `desktop/src/components/HeadsUpCard.test.ts`
- `desktop/src/components/ObserverStatus.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/config.test.ts`
- `tests/heads-up-eval.test.ts`
- `tests/heads-up-status.test.ts`
- `tests/heads-up-settings.test.ts`
- `desktop/src/app/observer-status-integration.test.ts`
- `desktop/src/lib/observer-status.test.ts`
- `desktop/src/components/settings/SettingsObserver.test.ts`
- `desktop/src/lib/settings-viewport.test.ts`
- `desktop/scripts/observer-smoke.mjs`
- `desktop/scripts/fixtures/ObserverSmoke.svelte`

## Verification

Deterministic tests use fake clocks/providers, real in-memory session projection,
out-of-band ACP command fixtures and server-rendered UI. They establish runtime
behavior, not real-model precision, usefulness, latency or pricing. Live model
quality needs a separate opt-in evaluation on representative coding sessions.

`npm --prefix desktop run test:observer` exercises real Svelte components, browser
events, model selection and the settings save contract using synthetic IPC/state.
It checks read-only popup opening, explicit controls, cancellation, tab/runtime
replacement, Escape/Tab focus, cold settings navigation, seconds conversion,
comment/parent-model preservation and narrow popup bounds. Evidence is written
under `.pi/artifacts/observer-ui-*`. This is not a native Tauri/window-system
test and never contacts a model or writes a real user profile.

Known verification gap: browser QA reproduced the popup closing after Check now
when the focused button becomes disabled and focus leaves the popup. The smoke
currently reopens the popup to continue its assertions; that workaround is not a
product fix or proof that the popup stays open during checking. The failed run
did not establish the disabled Checking button, enabled Off control or draft
preservation after cancellation. Those interactions still need a product fix
and a fresh real-UI verification; native Tauri QA has not been performed.

The [Heads up evaluator](evaluation.md) supplies a synthetic development
corpus and an opt-in, sequential live-model runner. `npm run eval:heads-up` only
validates/lists fixtures; `--live` authorizes real inference using the production
context builder, prompt and parser. The CLI has a whole-matrix request ceiling,
no retries/fallback or judge model, and never reads real conversation histories.
It reports false positives, missed warnings, source/consequence-anchor matches,
invalid replies, incomplete runs, latency and recorded usage separately. Lexical
scoring is a proxy; every emitted notice still requires human semantic review.
The prompt requires current requirement → observed state → concrete consequence,
with the correct direction, and distinguishes proposals, applied changes, rejected
mutations, later fixes and explicit approvals. The corpus covers these pairs,
opposite API directions and multiple independent/duplicate findings. Order-independent
one-to-one rubric matching and narrow known-inversion checks reject covered errors;
they do not establish general semantic accuracy. Historical live scores predate
the current prompt/schema/corpus and are not a current quality measurement.
See that guide for commands, limits, interpretation and artifact retention.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"ccfa63da0540a8054d596e7deb7407366bec204ed71c77dc4a6774fac26df1ca","checkedAt":"2026-10-31T00:22:32.229Z","maxDocumentChars":128000} -->
