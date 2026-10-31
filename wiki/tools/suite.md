<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T00:48:03.100Z","result":{"path":"wiki/tools/suite.md","documentHash":"85afcf9eab67ff5fe2965530a714fce125ceb9e0b932e9737cb7f47da2049b04","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"chunkCoverage":{"totalChunks":2,"checkedChunks":2,"totalComparisons":3,"checkedComparisons":3},"status":"conflicts","conflicts":[{"draft":{"path":"wiki/tools/suite.md","quote":"stores project-local run files and a registry under `.pi/subagents/` so result/status collection can recover after compaction or reload while the main session remains alive","startLine":45,"endLine":45},"existing":{"path":"wiki/tools/suite.md","quote":"Run and agent records are kept session-natively as lifecycle entries in the parent session; there is no `registry.json`, and legacy run directories are ignored.","startLine":1184,"endLine":1184},"explanation":"Оба утверждения касаются одного и того же механизма хранения записей запусков sub-агентов в `.pi/subagents/`. Черновик утверждает, что там хранится реестр (registry), используемый для восстановления результатов и статусов; тот же документ во второй части явно отрицает существование `registry.json` и говорит, что записи о запусках и агентах ведутся нативно в сессии как lifecycle-записи, а устаревшие run-каталоги игнорируются. Эти два утверждения о структуре хранения не могут одновременно быть верными в одном контексте."}],"uncertainties":[],"reviewedSources":[{"path":"wiki/operations/lsp-trust.md","quote":"  by a model or project file.\n- Automatic registrations are written to the trusted user\n  `~/.config/pi/pi-tools-suite.jsonc` layer with an absolute installed binary\n  path. Project-local config remains trust-gated exactly as described above and\n  is never auto-trusted or rewritten by onboarding.\n\n## Public contracts / inputs / outputs\n\n### Config locations & format\n- Global: `$HOME/.config/pi/pi-tools-suite.jsonc` (JSONC, `lsp.servers[]`); alt `$PI_CONFIG_DIR/pi-tools-suite.jsonc`; project: `\u003cproject\u003e/.pi/pi-tools-suite.jsonc` at the nearest matching ancestor (via `findUp`). `[confirmed by code]`\n- Schema `{ lsp: { servers: LspServerConfig[] } }`; `LspServerConfig` fields: `id`, `enabled`, `bin`, `args`, `cwd`, `env`, `config`, `include`, `exclude`, `rootMarkers`, `languageIdByExtension`, `startupTimeoutMs`, `diagnosticsWaitMs`, `pullDiagnostics`, `waitForPublishDiagnostics`, `initializationOptions`, `settings`, `maxFileSizeBytes`. `[confirmed by code: types.ts 27-44]`\n\n### Trust store\n- Path `$PI_AGENT_DIR/trust/lsp.json` (default `$HOME/.pi/agent/trust/lsp.json`). `[confirmed by code: trust.ts 21-24]`\n- Format `{ \"version\": 1, \"trustedHashes\": string[] }`; hashes are SHA-256 hex of the full raw JSONC text. `[confirmed by code]`\n- `writeTrustStore` uses `fs.writeFile` **without** an explicit `mode` (defaults to umask). `[confirmed by code]`\n\n### What is hashed\n- The entire file content (`raw`), not individual entries, not a canonical form. `[confirmed by code: config.ts 107]`\n\n## Invariants\n- Global config servers are **never** trust-gated. `[confirmed by code]`\n- Trust is checked **once per file load**, not per server within the file. `[confirmed by code]`\n- Session-trusted hashes (Trust once) live in a module-level in-process `Set` and reset on restart. `[confirmed by code: trust.ts 15]`\n- Persisted trusts survive across sessions. `[confirmed by code]`\n- Rejected hashes are **not** cached/persisted — rejection re-prompts every time. `[confirmed by code; confirmed by tests]`\n\n## Edge cases\n- **ENOENT on trust store**: empty store (first run). `[confirmed by code: trust.ts 34-37]`\n- **Malformed trust store JSON**: thrown (not gracefully handled beyond ENOENT). `[confirmed by code: trust.ts 34-39]`\n","startLine":75,"endLine":104},{"path":"wiki/desktop/design.md","quote":"- dialogs and substantial floating surfaces: usually `rounded-lg`;\n- `rounded-xl` and larger require a specific composed/floating-object reason;\n- avoid pill shapes unless the semantic object is actually a chip/tag/status capsule.\n\nPrefer a subtle border before adding a shadow.\n\nUse shadows only to communicate elevation. Do not stack strong borders and strong shadows together.\n\n### 6.1 Native pointer behavior\n\nButtons, tabs, menu rows, tree rows, and other controls keep the default arrow\ncursor, as in native macOS applications. The pointing-hand cursor is a web\nhyperlink affordance and is reserved for real links (`a[href]`). Do not add\n`cursor-pointer` to controls. Images and links are not draggable by default,\nand the window does not rubber-band/overscroll.\n\n## 7. Spacing and density\n\nDesign for a desktop window, not a marketing page.\n\nPrefer compact controls and stable pane geometry.\n\nTypical local spacing SHOULD cluster around Tailwind's standard 1–4 spacing steps. Larger spacing is appropriate for section separation, empty states, or modal composition.\n\nDo not create large empty whitespace solely to make the UI look \"premium\".\n\n### One-shot action feedback\n\nShow one-shot action results (success, information, warning, or error) through\nthe shared Desktop toast/notification center rather than temporary inline panel\nstatus. Keep form validation and persistent state beside the control that owns\nthem.\n\n## 8. Application layout\n\nPrefer persistent desktop regions:\n\n- tab/title area;\n- sidebar when navigation breadth warrants it;\n- main content/workspace;\n- contextual toolbar when actions are persistent;\n- bottom status region for low-priority runtime information;\n- independently scrollable transcript/content panes.\n\nKeep the application window itself stable. Prefer scrolling inside content regions rather than allowing the entire desktop shell to behave like a web page.\n\n### 8.1 Desktop application model\n\nTreat the product as a stable workbench:\n\n```text\nwindow\n├─ titlebar / session tabs\n├─ activity rail + optional navigation pane\n├─ primary workspace\n│  ├─ transcript/document surface","startLine":238,"endLine":293},{"path":"wiki/tools/agents/subagent-model-pools.md","quote":"\nAgent frontmatter can independently gate whether a role exists for the current\nparent model. `forParentModels` is an optional allow-list and\n`notForParentModels` is an optional deny-list; deny wins when both match. These\nfields accept model patterns such as `zai/*` and affect the parent catalog,\nexplicit role validation, and automatic routing. They do not choose the child\nmodel; `models` and the provider policy do that.\n\n## Project-local customization and compatibility\n\nProjects customize role behavior by adding or replacing\n`\u003cproject\u003e/.pi/agents/\u003crole\u003e.md`. There is no `.pi/agents/presets.jsonc`, saved\nsub-agent preset selection, `AGENTS_PRESET`, or `/subagent-preset` runtime\nsurface. A project that wants different worker economics changes the ordered\ncandidate list of the relevant role instead of selecting a global model pool.\n\nA project-local file with the same name as a bundled role replaces that bundled\nprofile completely. Omitted fields do not fall through to the built-in\ndefinition. The effective parent catalog explicitly reports active same-name\nreplacements so the parent knows it is seeing project-owned semantics. There\nare no role-name aliases or partial-merge exceptions.\n\nOld role names are not implicit aliases. `quick`, `scan`, `review`, `deep`,\n`docs`, `frontend`, and `tests` work only when explicitly defined as ordinary\nproject types. This keeps the effective catalog and accepted names exact.\n\nLegacy `model` plus `fallbackModels` and `modelByParent` still load when declared\nin an agent Markdown file. A modern `models` profile is the complete ordered\ncandidate chain. Empty `models` means no candidates, not permission to inherit\nthe parent model. Legacy singular selectors normalize with an explicit fallback\narray, including `[]`.\n\nThe removed `asyncSubagents` section is no longer part of the public config\nschema and is not read at runtime. Existing legacy files are left untouched but\nhave no effect. Migrate role definitions and model candidate choices to\n`\u003cproject\u003e/.pi/agents/*.md`. To hide only selected bundled roles, use top-level\n`disabledBuiltinAgents` in `pi-tools-suite.jsonc`; later config layers may\nre-enable names with `enabledBuiltinAgents`. The filter runs before project-local\nMarkdown is applied, so a same-named project role can intentionally replace a\ndisabled built-in.\n\n## Compact handoff\n\n### Coding quality and acceptance\n\n`implement-core` (Sol only) and `mechanical` (GLM-5.3 only) are the retained\nimplementation roles. Mechanical is for prescribed behavior-preserving work\nlarge enough to amortize handoff overhead. Research, verification, UI QA,\ndocumentation maintenance and the cross-vendor oracle retain their separate\ncandidate policies. Project replacements and explicit model overrides still\nfollow the normal precedence rules. Bundled `implement` and `delivery-review`\nare retired without aliases; project-local profiles with those names remain valid.\n\nGive migrations coherent slices and an early affected typecheck plus focused\nregression before expanding the diff. Preserve regression meaning, negative\ncases and hidden-blocker checks; changed expectations require a contract reason\nand equivalent coverage. Workers stop expanding the diff near their execution\nlimit and report incomplete slices, interface mismatches, checks and next steps.\nThese are workflow instructions, not rollback or checkpoint guarantees: a hard\ntimeout can still leave partial edits for the parent to inspect and rescope.\nReview compares old/new assertions and both sides of migrated interfaces.\n\n","startLine":169,"endLine":230},{"path":"wiki/tools/agents/async-subagents.md","quote":"   instruction policy, not a runtime complexity classifier. This replaces the\n   code-review portion of [decision 0001](../../decisions/0001-subagent-coding-roles.md);\n   the parent-owned implementation and role-retirement policy is recorded in\n   [decision 0069](../../decisions/0069-parent-owned-implementation.md).\n   The retained `implement-core` role uses Sol; `mechanical` uses GLM-5.3.\n   Other retained role candidate policies are unchanged. Project-local profiles\n   with retired names remain valid; there are no aliases.\n   GPT-6 Sol is not an alias for GPT-6.1 Sol. Existing user/project model\n   lists still override defaults and are not rewritten by this rollover.\n   `[confirmed by frontier-models.ts and agents/*.md]`\n8. **Role router / auto-ultrawork classifier**: the role router and the\n   `ULTRAWORK_AUTO` classifier both try `routing.model`, then\n   `routing.fallbackModels`, then the current parent model, de-duplicating refs\n   and continuing past unavailable/provider-error candidates. Abort remains\n   terminal. `[confirmed by code, routing.ts/ultrawork-auto.ts]`\n9. **UI QA special role**: `ui-qa` is the only built-in real-UI role for\n   browser, terminal/TUI, and desktop-GUI verification. `browser-qa` is not an\n   alias; a project may define that name only as an ordinary independent role.\n   Like every async sub-agent, `ui-qa` runs without skills. UI QA additionally receives\n   `PI_SUBAGENT_AGENT_DIR` plus launcher-owned `PI_UI_QA_RUNNER` and\n   `PI_BROWSER_QA_RUNNER` paths, and gets private `ui-qa/flows/` plus\n   browser-backend `ui-qa/browser/flows/` workspaces.\n   The start prompt is a thin common contract: the child loads exactly one\n   backend guide (`browser`/`tui`/`desktop`, plus `browser --topic auth` only\n   when authentication is required) through the read-only allowlisted\n   `PI_UI_QA_RUNNER guide` command before any UI action. The unified runner\n   selects browser, PTY/TUI, or macOS Accessibility backends from a declarative\n   target and owns bounded execution/evidence cleanup.\n   `[confirmed by code,\n   config.ts/routing.ts/spawn.ts/ui-qa-runner.mjs]`\n10. **Bundled-role visibility**: top-level pi-tools-suite config may list role\n    names in `disabledBuiltinAgents`. The list follows the normal suite config\n    layer order; a later `enabledBuiltinAgents` entry removes an inherited\n    disable. Filtering happens after the bundled Markdown catalog is cloned and\n    before project `.pi/agents/*.md` definitions merge, so a project-local role\n    may intentionally reuse a disabled built-in name. Disabled built-ins are\n    absent from the parent catalog, explicit-role validation, and automatic\n    routing. A project-local role whose filename exactly matches a bundled role\n    replaces that bundled profile completely; omitted fields are not inherited.\n    The parent catalog explicitly lists active project replacements. There are\n    no role-name aliases or partial-merge exceptions. `[confirmed by code,\n    config.ts/agent-catalog.ts; confirmed by tests, core.test.ts]`\n    `knowledge-auditor` is a low-thinking economical docs-only role with a\n    20-minute default timeout. Before task completion the parent supplies the final\n    behavior/result and exact task-changed paths. The child updates affected\n    documentation from relevant implementation/tests, fixes small proven drift\n    and returns substantial or ambiguous discrepancies to the parent.\n    It also accepts explicit **spec-review** assignments with exact documentation\n    paths and a review goal. Neither mode runs knowledge dirty/acknowledgment,\n    index refreshes or exhaustive dependency traversal. No search installation,\n    initialized index, global clean verdict or review receipt is required.\n    Results contain changed documentation paths and concrete unresolved questions,\n    not global knowledge-state reporting. Preserve concurrent work and keep\n    disposable reports under `.pi/artifacts/`.\n11. **Session persistence and parent state**: every child is a full Pi session stored at `\u003ccwd\u003e/.pi/subagents/\u003cparentSessionId\u003e/\u003cchildSessionId\u003e.jsonl`. `agentId` is the subagent launch identifier (often supplied as `task.id`), distinct from the UUID Pi assigns to the child session; the parent records the session file reported by the child, and `subagent_meta` maps that session back to `agentId`. The parent stores durable lifecycle/index patches as custom entries in its own session and reconstructs records by folding them in order. Process handles, live activity, full result text and other transient data remain in a live in-memory overlay; there are no regular-agent sidecars or `registry.json`. A batch is an identity label, not a directory. Legacy run directories are ignored and are not migrated. `[confirmed by code and tests]`\n11a. **Follow-up turns (`send`)**: the parent may continue a child's conversation by `agentId`.\n    - **Live delivery** — while the child process is still running and its live channel is open, the message is written to the child's RPC stdin as `{type:\"prompt\", message, streamingBehavior: \"followUp\"|\"steer\"}` (default `followUp`). Pi queues it while streaming, or starts a new run when idle; the tool returns the reported disposition. The latest turn's full result text is read from the child session.\n    - **Settled race** — when `agent_settled` arrives while a live send is pending or was accepted during the current run, termination is deferred: the child is asked for `get_state` and terminated only if it is neither streaming nor has pending messages. Once settled termination is scheduled the channel is closing; new live sends are refused and the tool waits (up to 15 s) for the process to finish, then falls back to cold resume.\n    - **Cold resume** — a terminal child with a persisted session is relaunched under the project concurrency semaphore using that session. The send increments the turn, clears prior process identity while queued, and replaces the current result with the latest turn's text; no turn archives or launch-spec sidecars are created. Launch failures are recorded in the parent session state. In headless mode, cold `send` runs through the detached broker like `spawn`; the broker tracks the resumed `agentId` until its final completion receipt.\n    - Before relaunch, cancellation is refreshed from the parent's durable entries (or a fresh read of the stable-key headless journal), without replacing other in-memory record fields. It is checked after the semaphore wait and again after any awaited owned-provider preflight; a requested stop cancels the queued relaunch without spawning a child.\n","startLine":242,"endLine":301},{"path":"wiki/decisions/0038-focus-on-hover.md","quote":"# 0038 — Focus on hover\n\n- Status: superseded\n- Recorded: 2026-10-04\n- Decided: 2026-10-04\n- Owner / approval evidence: user reported “не работает” and requested\n  “передавать фокус окна при ховере над ним”.\n- Governing spec: [Desktop focus on hover](../desktop/workbench/desktop-inactive-hover.md)\n- Replaces / replaced by: replaces [0036](0036-inactive-window-hover.md);\n  replaced by [0045](0045-remove-hover-focus.md)\n\nSuperseded on 2026-10-05: the user reported that accidental hover raised Pix over\nother windows and requested removal. The rationale below is historical.\n\n## Context\n\nInactive-only WebKit event forwarding did not work according to the user. The\nprevious constraint against focus stealing is explicitly removed by the new\nrequest. Scope is exposed macOS Pix webview bounds, including custom chrome.\n\n## Observations and sources\n\n- Reported evidence: user says the previous approach does not work; no native\n  automated reproduction was obtained.\n- Source evidence: `inactive_hover.rs` already installs a passive ActiveAlways\n  tracking child in the shared startup window builder. `desktop_notification.rs`\n  already uses AppKit app activation followed by exact-window key/front ordering.\n- Assumption requiring native QA: making the hovered window key restores normal\n  WebKit CSS hover and native title tooltips. Compile/policy tests do not prove it.\n\n## Decision\n\nReplace opaque WebKit owner forwarding with app activation and exact-window\n`makeKeyAndOrderFront` on pointer enter/move. Skip already-key active windows and\nhidden/minimized/detached windows. Preserve hit-test transparency and native view\nownership, do not enable tracking during drag, and do not change first responder\nexplicitly. No focus restoration on exit, timers or global monitors.\n\n## Alternatives\n\n- Continue inactive forwarding: user reports failure and requests focus instead.\n- Focus only on click: does not satisfy the requested hover behavior.\n- Global pointer monitoring: adds coordinate/lifecycle complexity unnecessarily.\n\n## Consequences\n\nHover now deliberately steals keyboard focus and raises the hovered Pix window.\nAn enter or move event may activate Pix from another app. This simplifies delivery\nby removing dependency on WebKit's tracking owner metadata. Actual native focus,\ntooltips, resizing and teardown behavior still need runtime verification.\n\n## Revisit when\n\nNative QA shows missing focus/hover/tooltips, drag interference, focus oscillation,\nor the user requests opt-in/no-focus behavior again.\n\n\n","startLine":1,"endLine":57},{"path":"wiki/tools/web-search-tavily-fallback.md","quote":"- Preserve the existing tool names, parameters, formatted text, timeout, cancellation, and truncation behavior.\n\n## Non-goals\n\n- Accepting API keys through tool parameters or storing them in project files.\n- Retrying a failed Tavily request through Ollama again.\n- Adding a Tavily SDK dependency.\n\n## Behavior\n\n1. Each operation calls Ollama first. Without an Ollama key it uses the existing local experimental endpoint; with a key and no explicit `OLLAMA_HOST` it uses the official Ollama cloud endpoint with bearer authentication.\n2. If Ollama succeeds, Tavily is not contacted.\n3. If Ollama fails and no Tavily key is configured, the original Ollama error is returned.\n4. If Ollama fails and a Tavily key is configured, the operation calls Tavily with bearer authentication.\n5. Tavily Search results are normalized to the current title/URL/content result shape.\n6. Tavily Extract content is normalized to the current title/content/links shape; Tavily does not supply page title or links, so the requested URL is used as the title and links are empty.\n7. If both providers fail, the error reports both provider failures without including the API key.\n8. Result details identify the provider used and, for fallback results, include the Ollama failure message.\n9. `/web-credentials` stores or clears one provider key at a time and reports only whether each source is configured, never its value.\n\n## Contracts\n\n- Secret inputs: `/web-credentials`, `OLLAMA_API_KEY`, and `TAVILY_API_KEY`; environment variables take precedence over stored keys.\n- Key pages shown by `/web-credentials`: `https://ollama.com/settings/keys` and `https://app.tavily.com/home`.\n- Stored credential path: user-level `~/.config/pi/pi-tools-suite-credentials.json`, written atomically with file mode `0600`.\n- Ollama cloud endpoints: `POST https://ollama.com/api/web_search` and `POST https://ollama.com/api/web_fetch`.\n- Tavily endpoints: `POST https://api.tavily.com/search` and `POST https://api.tavily.com/extract`.\n- Authentication: provider-specific `Authorization: Bearer \u003cAPI key\u003e`.\n- Existing `timeout_ms` and `PI_WEB_SEARCH_TIMEOUT_MS` apply independently to each provider request.\n\n## Edge cases\n\n- Parent cancellation cancels the active provider request and does not start a fallback after cancellation.\n- Invalid Tavily JSON, non-success HTTP responses, and unexpected response shapes produce provider-specific errors.\n- Tavily Search supports at most 20 results; fallback requests clamp `max_results` to that documented maximum.\n- A Tavily Extract response with only `failed_results` is treated as an error.\n- Clearing a stored key does not unset an environment override; status and notifications make that precedence visible without exposing the key.\n\n## Related files\n\n- `external/pi-tools-suite/src/web-search/index.ts`\n- `external/pi-tools-suite/src/tool-descriptions.ts`\n- `external/pi-tools-suite/test/web-search.test.ts`\n- `wiki/tools/suite.md`\n\n","startLine":25,"endLine":69},{"path":"wiki/assistants/observer/evaluation.md","quote":"time: parent execution passes after child-only research; parent execution evidence\nis absent (unknown, not a failure); and an explicit parent run failure conflicts\nwith its success summary. The last rubric requires both the failed result and\nthe parent's claim, not the child's non-execution. Delegated reports remain\nappended after parent records, matching production assembly; array position alone\ndoes not establish cross-actor event chronology. Fixture/oracle tests validate\ninput and scoring, not whether a real model follows these distinctions.\n\n## Delegated increment observation (2026-10-04)\n\nA single bounded live Luna pass covered 21 fixtures: the three new delegated\ncontrols passed, with the breaking-API notice correctly attributed to the child\nreport. Automated result was 20/21 (8/8 positive proxy matches, 1/13 false positives,\nno invalid/error/unrun calls; p50/p95 2,770/4,751 ms). Manual review confirmed the\n`failed-edit` false positive: it warned about a rejected change while acknowledging\nthat the current source was unchanged. The `api-break` proxy match also reversed\nthe requested direction, so it is not a semantic success despite matching IDs and\nkeywords. Do not equate this result with production readiness or verified mutation\ncoverage. Retained run: `.pi/artifacts/heads-up-eval-2ZKA7s/report.md` (disposable).\n\nThe production context builder bounds/redacts messages; the production inference\nfunction sends the prompt; the production parser validates the reply and evidence\nIDs. Expected labels, reference answers, scenario names and grading instructions\nare not sent to the model. Previous notices are input only in the feedback case.\nReferences are checked *after* context budgeting so lost required evidence cannot\nsilently make a positive fixture impossible.\n\nA positive `tp` requires a valid warning, required supporting sources and all\nconfigured consequence-anchor groups for each one-to-one matched issue. Each\nanchor group accepts several English or Russian substrings. This is a **lexical\nproxy**, not proof that the explanation is correct. Real IDs alone are not proof\neither. A correct paraphrase can fail the proxy; conversely, a misleading warning\ncontaining the right words can pass. A targeted regression catches the previously\nobserved reversed API-direction wording; it is a narrow lexical tripwire, not a\ngeneral semantic judge. Human reviewers must verify contract direction (what was\nrequired versus what changed), whether a mutation was actually applied, whether a\nrejected mutation left current state unchanged, whether later fixes resolve it,\nand whether explicit user approval supersedes the concern. Read all emitted cards,\nincluding automated passes; automated match scores do not assess semantic truth.\n\nThe production reply contains a bounded `notices` array (up to three) and can\nreview existing cards while discovering others. Positive scoring requires a\none-to-one matching between expected and emitted notices; order is irrelevant, but\nmissing, detected duplicate, or extra cards fail. Retained IDs must match the\nexpected surviving card; a new issue cannot repurpose a resolved card's ID.\nDuplicate structured identities or exact wording fail even if keyword groups\noverlap. Detecting other semantic paraphrases still requires human review.\nActive-card descriptors are untrusted\nproduction-shaped input, never grading rubrics. Runtime deterministic tests cover\nstack revalidation and selection separately. Historical live results below predate\nthe current prompt/schema/corpus and do not establish current model quality.\n\nReport outcomes are `tp`, `tn`, `fp`, `fn`, `wrong_notice`, `invalid`, `error`,\n`timeout`, `cancelled` and `not_run`. `wrong_notice` means rubric mismatch,\nnot an independent semantic verdict. Missing attributable usage is a transport or\naccounting failure, matching the production controller's refusal to display it.\n\nMetrics are deliberately separate:\n\n- Precision proxy = `tp / (tp + fp + wrong_notice)`; it is `null`/`n/a` when no\n  notice was emitted. Recall = `tp / all planned positive cases`, conservatively\n  including failed/unrun positives. An always-silent model therefore fails.\n- False-positive rate = `fp / planned negative cases`; correct-silence rate =\n  `tn / planned negative cases`. Inspect these together with coverage: failed\n  negative requests are not evidence that a model knows when to remain silent.\n- Valid-response coverage, per-case latency, p50/p95 latency, input/cache/output\n  usage and provider-reported cost remain separate. Zero reported cost does not\n  imply free subscription usage; missing usage is explicit and not reconstructed.\n\n**Read every emitted notice, including automated passes.** Check whether it names\nthe actual consequence, attributes the change to the correct actor/time, avoids\nunsupported claims, and warrants interrupting the user. Record accept/reject/unsure\nwith a reason beside each notice. Do not call this small development set a\nheld-out benchmark or extrapolate its precision to real coding sessions. Keep the\nsame corpus/prompt/config hashes when comparing runs; after tuning on failures,\nadd fresh cases before claiming generalization.\n\n## Reports and exit status\n\nEach live run creates a unique `.pi/artifacts/heads-up-eval-*/` with:\n\n```text\nresults.jsonl     Incremental visible responses and results\ninputs.json       Sanitized model inputs and separate, model-hidden rubrics\nreport.json       Results, metrics, served model, config and source hashes\nreport.md         Readable comparison plus all responses, including passes\nempty-workspace/  Provider-discovery cwd; no session transcript\n```\n\nJSON metadata records selected models, repetitions, code hashes, corpus hash,\nsystem-prompt hash, Git HEAD, timing and whether hashed files changed during the","startLine":94,"endLine":184},{"path":"wiki/providers/claude-code-provider.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Local Claude Code provider\n\n## Behavior\n\nThe maintained `claude-code-provider` module of pi-tools-suite owns the Claude\nCode adapter. Provider `pi-claude-code-provider`, API\n`pi-claude-code-provider-headless`, model aliases and `PI_CLAUDE_CODE_PROVIDER_*`\nconfiguration remain compatible with upstream 0.5.0. Authentication remains\nClaude Code's subscription login; migration never reads or copies credentials.\nOrigin, license, local differences and update procedure live in the module's\n`UPSTREAM.md`. The imported installed source already contained Pix patches;\nit is not represented as pristine upstream.\n\nThe suite catalog enables the module by default. Pix TUI autoloads the personal\nsuite (its bootstrap installs/links bundled source); Desktop/ACP prefers that\ninstalled personal suite and otherwise uses the\nbundled copy. Run the suite sync after updating source. Isolated async children\nload only the suite-relative standalone module entrypoint, not the whole suite\nand not a user/project npm package. Existing owned-launch, tool-guard and\nprovider-web-search policies continue to apply.\n\n### Multiple Claude subscription profiles\n\nOpt-in `claudeCodeProvider` settings live **only** in the user-level\n`~/.config/pi/pi-tools-suite.jsonc`, shared by Pix Desktop/ACP and TUI. A\nworkspace's project config cannot supply OAuth paths. Desktop Settings → Tools\nSuite → Claude Accounts edits this file through the existing validated settings\neditor; no login tokens are read, copied, stored, or displayed by Pix. The\naccount editor supports naming, ordering, adding, removing and copying CLI\ncommands to log in/check status with a separate `CLAUDE_CONFIG_DIR`. The toggle\nis disabled until at least two profiles are listed. Saving changes takes effect\non the next provider request; an existing in-flight request keeps its snapshot.\n\nDesktop Session usage, when the active model is Claude Code or the session\nhas recorded Claude Code calls, includes a\ncompact account selector between `Session usage` and `Subagents`. It reads\nonly the user-level Tools Suite config when opened. `Default` with rotation\noff uses the ordinary Claude CLI login; `Auto` with rotation on clears the\nmanual preference. Choosing a named profile writes `selectedAccount` under\n`claudeCodeProvider` via a compare-and-swap JSONC edit that preserves other\nsettings and detects concurrent saves. This is a global **preferred account\nfor the next model request**, not a change to an in-flight call; it also works\nwhile automatic rotation is off. With rotation enabled, the selected account\nis attempted first, and its quota rejection still triggers the bounded\nfallback and optional pause. Explicit preference changes clear only that\naccount's process-local cooldown once; no account is retried twice in one\nrequest. Renaming/removing the preferred profile in Settings clears it, and an\ninvalid stale name in manually edited JSONC falls back instead of blocking\nthe provider.\n\nEach attempt publishes only a profile label and timestamp through the\nsession-owned `claude-code-account` event, allowing Desktop to show\n`Last: \u003clabel\u003e`. This identifies an attempted account, not a confirmed\nsuccessful login. The selector does not automatically refresh subscription\nusage or relabel existing quota bars: previously displayed quotas may belong\nto the prior login. The UI displays no OAuth tokens or private config paths.\nAll file reads/writes are asynchronous and scoped to the lifetime of the\npopup, and a concurrent-file conflict does not overwrite newer settings.\n\nExample (each directory must first be authenticated with Claude Code CLI):\n\n```jsonc\n\"claudeCodeProvider\": {\n  \"autoRotate\": true,\n  \"rotationDelaySeconds\": 60,\n  \"accounts\": [\n    { \"name\": \"Personal\", \"configDir\": \"~/.claude-personal\" },\n    { \"name\": \"Work\", \"configDir\": \"~/.claude-work\" }\n  ]\n}\n```\n\n","startLine":1,"endLine":77},{"path":"wiki/operations/desktop-lsp-onboarding.md","quote":"\n## Goal\n\nWhen an agent creates or edits a source file for a language that has no\nregistered matching LSP, warn in the active conversation, pause safely on user\nrequest, and offer a trusted automatic installation flow in a dedicated\nworkbench tab.\n\n## Trigger\n\n- Onboarding is driven by successful mutation tool results, not repository\n  discovery or reads. `write`, `edit`, `apply_patch`, and `ast_apply` participate\n  through the existing LSP mutation-path extractor.\n- The changed path must exist after the mutation and map to a language in the\n  trusted automatic-installer catalog.\n- The LSP module loads the same effective LSP configuration used for diagnostics.\n  If any enabled configured server can match the edited file by include/exclude\n  rules, the language is considered registered and no onboarding warning is\n  published. Root-marker availability and server startup health are intentionally\n  not used to classify a server as missing: a configured-but-broken LSP is an\n  operational error, not an installation suggestion.\n- Initial automatic installers cover TypeScript/JavaScript, Svelte, Vue, Python,\n  Go, Rust, and Ruby. Languages without a trusted installer remain unchanged\n  until an explicit installer recipe is added.\n\n## Desktop interaction\n\n- The LSP extension publishes a private session-scoped\n  `pi-tools-suite:lsp-missing` state event containing only a trusted installer\n  identifier plus presentation metadata and the edited path.\n- Desktop validates the installer identifier against its own allowlist before\n  accepting the event.\n- The active conversation shows one centered warning surface for the current\n  project/language. Repeated mutation events update/dedupe the same suggestion\n  rather than stacking toasts. **Not now** suppresses that project/language for\n  the current Desktop workspace lifecycle.\n- If the owning agent is running, the primary action is **Pause & install** and\n  uses the existing turn-boundary pause request. It does not call Stop/cancel.\n  The installation tab is not opened until the session actually reaches\n  `paused`; if the run is already idle/paused, installation may start\n  immediately.\n- The LSP installer is a UI-only workbench tab anchored next to the conversation\n  that triggered it. It is not an ACP/TUI session and is not persisted in the\n  session-tab list.\n- While installation is active the installer tab is not closable. It shows the\n  selected server, progress, bounded install output, success/failure, and Retry\n  after failure. Success/error states may be closed normally.\n- Successful installation never continues the agent automatically. A paused\n","startLine":12,"endLine":59},{"path":"wiki/tools/agents/index.md","quote":"# Sub-agents\n\nRole selection, lifecycle, model pools and project-local roles. Read current contracts before relying on older delegation decisions.\n\n[Wiki home](../../index.md)\n\n## Pages\n\n- [async-subagents (as-is spec)](async-subagents.md) — active\n- [Parent-first sub-agent role selection](parent-first-subagent-routing.md)\n- [Project-local sub-agents from `.pi/agents/*.md` (delta spec)](project-agents-dir.md)\n- [Sub-agent model candidates and provider policy](subagent-model-pools.md)\n\n- [owned-launch containment architecture](owned-launch.md) — candidate; G1/T3 acceptance remains open\n\n\n","startLine":1,"endLine":16},{"path":"wiki/development/testing/desktop-qa-isolated-launch.md","quote":"- `scripts/qa-sandbox.mjs`\n- `fixtures/qa/pix-project/`\n- `wiki/development/testing/qa-sandbox.md`\n- `desktop/src-tauri/src/qa_profile.rs`\n- `desktop/src-tauri/src/startup_theme.rs`\n- `desktop/src-tauri/src/lib.rs`\n- `.pi/skills/pix-desktop-qa/SKILL.md`\n\n## Tests and verification\n\n- `tests/qa-desktop-doctor.test.ts`\n- `tests/qa-desktop-prepare.test.ts`\n- `tests/qa-desktop-launch.test.ts`\n- `tests/qa-desktop-persistent.test.ts`\n- `scripts/release/test/qa-workspace.test.mjs`\n- `desktop/src-tauri/src/qa_profile.rs` (unit tests)\n\nRun the focused Node tests and native profile/lifecycle tests. Native acceptance\nmust identify the pinned source and actual QA PID, verify a real rendered UI in\nthe separate QA project, retain accessibility/pixel evidence, verify owned cleanup,\nand show that the working Desktop executable/PID was not restarted or closed.\n\n\n","startLine":211,"endLine":233},{"path":"wiki/configuration/model-selector-fallbacks.md","quote":"## Execution contract\n\n- Helper workflows that advertise a fallback chain try candidates in order and de-duplicate repeated refs.\n- Pix default-model fallbacks apply only to brand-new sessions. An explicit runtime model and a model restored from session history remain strict user/session choices and do not silently fall through to configured defaults.\n- A fallback model without an explicit thinking suffix inherits the configured default-model thinking level; an explicit fallback suffix wins.\n- Autocomplete, prompt enhancement, Desktop/TUI Git helpers, lookup, session-title generation, DCP summaries, and async-subagent routing use their configured candidate chains rather than storing unused fallback metadata.\n- Cancellation/abort remains terminal and must not be converted into a fallback attempt.\n\n## Compatibility\n\n- Existing object or legacy-string configs that omit fallback arrays continue to load. Resolved selectors always expose an array; where no inherited or explicitly configured fallback exists, it is `[]`.\n- Existing DCP multi-entry `summarizerModel` configurations remain valid; `summarizerFallbackModels` extends that ordered list.\n- Existing async-subagent modern `models` chains retain their meaning and are not rewritten into a primary-plus-fallback object.\n\n## Related files\n\n- `src/config.ts`\n- `src/default-pix-config.ts`\n- `src/app/runtime.ts`\n- `src/app/input/autocomplete-controller.ts`\n- `src/app/input/prompt-enhancer-controller.ts`\n- `src/app/commands/command-git-actions.ts`\n- `src/bundled-extensions/session-title/`\n- `acp/src/acp/default-model.ts`\n- `acp/src/acp/pix-settings.ts`\n- `acp/src/acp/autocomplete.ts`\n- `acp/src/acp/prompt-enhancer.ts`\n- `acp/src/acp/git-assistant.ts`\n- `acp/src/acp/pix-acp-agent.ts`\n- `external/pi-tools-suite/src/config.ts`\n- `external/pi-tools-suite/src/coding-discipline/index.ts`\n- `external/pi-tools-suite/src/dcp/`\n- `external/pi-tools-suite/src/async-subagents/core/`\n- `src/schemas/pix-schema.ts`\n- `src/schemas/pix-desktop-schema.ts`\n- `src/schemas/pi-tools-suite-schema.ts`\n- `desktop/src/components/settings/SettingsModelSelect.svelte`\n- `desktop/src/components/settings/SettingsModelList.svelte`\n","startLine":45,"endLine":82}],"notices":["Связанные фрагменты Wiki недоступны; проверены только противоречия внутри этого черновика.","Не удалось выполнить поиск связанных документов.","Истекло время поиска связанных документов.","Нет доступных актуальных фрагментов связанных источников; согласованность между документами не установлена.","Неопределённость 1 не прошла проверку: цитата отсутствует или встречается в предоставленном тексте несколько раз."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":64,"excerptedSources":10,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]}}} -->
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

Every sub-agent is a full persisted Pi session stored at `<cwd>/.pi/subagents/<parentSessionId>/<childSessionId>.jsonl` (see [async-subagents](agents/async-subagents.md)); there is no opt-out. The session backs `subagents action=send` cold resume of finished agents, Desktop read-only sub-agent viewer tabs and the session-navigation slash commands (`/sub-open`, `/sub-back`, `/sub-where`).

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

Sub-agent runs are stored in the current project's `.pi/subagents/` directory and survive main-session shutdown. Run and agent records are kept session-natively as lifecycle entries in the parent session; there is no `registry.json`, and legacy run directories are ignored. `subagents({ action: "status" })`, `wait`, and `stop` can omit `runDir` to target the latest batch of the current parent scope, and `subagents({ action: "result", agentId: "..." })` resolves the latest-launched record for that `agentId` even if the exact `runDir` was lost during compaction or the session closed. Result reads always return a summary-first response with artifact paths; raw `result.md` and `stderr.log` are not inlined, which avoids IPC/socket buffer overflows. Include `runDir` when you need an older or non-latest run, and use `cleanup` with `delete=true` to remove collected old runs. On normal main-session shutdown, Pi stops that session's sub-agents but preserves run files, reports, attachments and session records; reload and fork shutdowns also skip stopping. Desktop's separate 72-hour background TTL and immediate manual Clean remain unchanged. The draft macOS owned launcher prevents explicit cleanup while containment or either UUID launchd service's retirement is uncertain; stopping the bridge alone never authorizes deletion. This candidate remains gated on G1/T3 acceptance (see `wiki/tools/agents/async-subagents.md` in the Pix repository).

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

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"be10804d-802a-4a0d-81f8-ba18fd60f930","contentHash":"85afcf9eab67ff5fe2965530a714fce125ceb9e0b932e9737cb7f47da2049b04","checkedAt":"2026-10-31T00:48:03.110Z","maxDocumentChars":128000} -->
