---
kind: spec
status: active
---

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

Decision rationale: [0001 — Subagent coding roles](../docs/decisions/0001-subagent-coding-roles.md).

Headless system for running isolated async sub-agents. Each sub-agent is a
separate `pi --mode rpc` child process that receives a task prompt via stdin
JSONL and streams RPC events back on stdout. The parent tracks state on disk and
exposes tool + slash-command interfaces. `[confirmed by code]`

## Current behavior

### Parent orchestration guidance

- For non-UI work, the injected cost-aware strategy tells the parent to do the
  shortest discovery pass needed to resolve user intent, semantics, and the main
  causal path before delegating. When a few targeted repository/context searches
  or reads already establish the diagnosis and desired behavior, the parent
  continues directly rather than spawning research that duplicates the same
  investigation. `[confirmed by code, core/agent-strategy.ts]`
- The parent writes code by default. Implementation delegation requires an
  explicit user request or a substantial independent task that can run alongside
  useful parent work; size, isolation, lower cost, or worker availability alone
  are insufficient. Research addresses named uncertainties or independent
  evidence tracks. Mandatory UI QA, review and knowledge-audit gates remain
  exceptions. Implementation delegation begins only after cause,
  desired behavior, and acceptance criteria are settled; the prompt prefers the
  smallest coherent slice over broad speculative cross-layer edits. Product/UX
  decisions and integration stay with the parent. `[confirmed by code,
  core/agent-strategy.ts and tool-descriptions.ts]`
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
- Delegated coding uses `implement` (Luna, then Sol for availability/quota),
  `implement-core` (Sol only for complex core changes or ambiguous bugs), and
  `mechanical` (GLM-5.3 only for small prescribed behavior-preserving edits with
  deterministic checks). Broad migrations and semantic test changes must not
  go to `mechanical`. Workers verify interfaces/types and focused regressions
  after an early coherent slice, preserve negative/hidden-blocker assertions,
  and report partial work honestly. These are prompt contracts, not automatic
  rollback/checkpoint enforcement. Parents compare cost per accepted verified
  change including failed attempts, review and rework, not token price alone.
  Research/verification/UI QA/knowledge-auditor/oracle candidate policies are
  unchanged. `[confirmed by agents/*.md, core/agent-strategy.ts;
  tests: test/async-subagents/model-pools.test.ts,
  test/prompt-evals/async-routing-e2e.test.ts under external/pi-tools-suite/]`

### Spawn (`core/spawn.ts`)
1. Each sub-agent is spawned via `node:child_process.spawn()` running the pi binary in RPC mode. `[confirmed by code, spawn.ts ~188]`
2. **Pi invocation resolution** (`core/pi-invocation.ts`): detects how pi was launched (Bun virtual script, direct node script, or generic runtime). Direct pi entrypoint → `process.execPath + [currentScript, ...args]`; generic node/bun → `pi` from PATH; Windows → `process.execPath args`. `[confirmed by code]`
3. **Pi args**: `--mode rpc`, `--session-dir <dir>` or `--no-session`, `--no-extensions`, `--extension <model-tools>`, the allowlisted provider dependencies of the final model (`--extension <antigravity-auth>` or the suite-local `claude-code-provider/index.ts` entrypoint), `--no-skills`, `--model <model>`, `--tools <list>` (or `--no-tools`), `--thinking <level>`, filtered extra user args, `--models <effective-model>`, then `--extension <tool-guard>`. The final model scope prevents persisted `enabledModels` or an extra `--models` value from resolving unrelated providers in the isolated child. Skill flags from `extraArgs` are stripped, so child agents never discover or receive skills. Before anything else, `-m value`, `--model=value` and `--provider=value` in extra args are normalized to `--model value` / `--provider value` (the installed Pi CLI documents the long, space-separated forms), so owned-launch selection, provider dependencies and the child all see the same final model. `[confirmed by code, spawn.ts, provider-extensions.ts; confirmed by tests, core.test.ts, provider-extensions.test.ts]`
4. **Stdin RPC**: sends two JSONL messages — `{type:"get_state",id:"sub_get_state"}` then `{type:"prompt",id:"sub_prompt",message:<prompt>[,images:<base64[]>]}`. Stdin stays open; EOF = pi shutdown. `[confirmed by code]`
5. **Extensions** loaded into children: `model-tools` (model-specific tool args) and `tool-guard` (strips parent-only tools: `question`, `subagents`, all `async_subagents_*`). Provider dependencies come from an explicit allowlist in `core/provider-extensions.ts`, recomputed on every attempt (retry and provider-changing fallback) from that attempt's final model:
   - `todo/subagent.ts` is also loaded for **every role**, including project-local roles such as `frontier-review`, and automatically for future roles. It exposes regular `todo` actions with a private child-session/attempt list. This is a planning exception to work-tool restrictions: restricted/empty role tool selections and extra CLI tool flags retain `todo` while preserving restrictions on work tools. Children neither read nor write the parent's project `.pi/todo-plan.json`. Retries/new attempts start with a new list; optional child session history stores local snapshots, branch navigation replays only that branch, and compaction retains unfinished tasks with a fresh snapshot. The lean entrypoint does not load persistence commands, UI widgets, thinking overrides, auto-follow-up turns or the parent's knowledge-audit reminder. Recursive delegation and interactive user questions remain denied. Children use todos for non-trivial multi-step work and report unfinished work/blockers to the parent; trivial work needs no plan. See [decision 0059](../docs/decisions/0059-subagent-private-todos.md), with the common-capability exception expanded by [decision 0060](../docs/decisions/0060-subagent-read-only-repo-tools.md). `[confirmed by todo/subagent.ts, core/child-tools.ts; tests: test/async-subagents/todo.test.ts, provider-child-inventory.test.ts]`
   - `repo-discovery/subagent.ts` is explicitly loaded at the same common boundary for **every role and attempt**, independent of role names, visibility or project-local replacements. It exposes the eight existing read-only queries (`repo_context`, `repo_audit`, `repo_architecture`, `repo_structure`, `repo_ast`, `repo_search`, `repo_explain`, `repo_deps`) only when the launch project is already indexed and `idx` is executable. It reuses normal adapters, project selection, output profile and cancellation, without setup/update commands or implicit installation/index initialization. Missing prerequisites leave ordinary role tools and private todo usable. Explicit CLI allowlists, empty/no-tools selections and exclusions retain these common capabilities but do not grant other work tools. Lifecycle activation adds only registered queries to the existing selection. Child audit guidance reports evidence/gaps to the parent rather than requesting nested delegation. Read-only refers to product-source mutation; idx cache/index refresh side effects are not an OS sandbox. Council children reuse this common repo entrypoint and keep their separate web/read-only call guard (with private todo allowed), avoiding duplicate tool registration. See [decision 0060](../docs/decisions/0060-subagent-read-only-repo-tools.md). `[confirmed by repo-discovery/subagent.ts, core/child-tools.ts, core/spawn.ts, brainstorm/research-extension.ts; tests: test/async-subagents/repo-tools.test.ts, provider-child-inventory.test.ts, test/brainstorm/research-extension.test.ts]`
   - `dcp/subagent.ts` loads DCP for **every role and attempt**, including project-local replacements and read-only council participants. It uses normal DCP configuration/model overrides, prompts, compression and lifecycle hooks but registers no interactive `/dcp` commands. `compress` is a common capability alongside private todo and gated repo queries: empty/restricted tool lists, CLI exclusions and model changes cannot remove it when DCP is enabled. Read-only guards permit context compression, not product-source mutation. Disabled DCP configuration still suppresses registration. Default `--no-session` children keep DCP decisions only in memory, preserving raw history without session files or journal writes; each retry/new attempt starts fresh. Opted-in persisted child sessions use the normal journal contract. This does not enable session persistence or load the whole suite. See [DCP lifecycle](dcp.md#lifecycle-and-persistence). `[confirmed by dcp/subagent.ts, core/child-tools.ts, core/spawn.ts, brainstorm/research-extension.ts; tests: test/async-subagents/dcp.test.ts, provider-child-inventory.test.ts, work-tools.test.ts, test/brainstorm/research-extension.test.ts]`
   - Optional work capabilities are tool-driven, not universal or granted by role
     name. Bundled `research`, `implement`, `implement-core`, `mechanical` and
     `frontier-review` opt into read-only `ast_grep`; only bundled `research`
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
     Council web registration shares this loader; its separate stricter guard
     still excludes AST and all mutations. Inventory tests do not prove research
     quality/live services; privacy guidance is not a network/filesystem sandbox.
     See [decision 0061](../docs/decisions/0061-subagent-scoped-ast-web-tools.md).
     `[confirmed by core/child-tools.ts, core/spawn.ts, work-tools.ts, agents/*.md;
     tests: test/async-subagents/work-tools.test.ts, provider-child-inventory.test.ts,
     test/brainstorm/research-extension.test.ts]`
   - `antigravity-auth` is restored after `--no-extensions` only when the effective explicit task/CLI model is `antigravity/<model>`; a model sourced only from `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` does not opt it in. Later `--model`, `-m`, or `--model=...` extra args override the task model for this decision.
   - A final model on `pi-claude-code-provider` (including the environment model) injects exactly one trusted suite-relative `src/claude-code-provider/index.ts`. No user/project settings or npm package lookup participates. The local manifest retains the characterized `0.5.0` identity; standalone and declared entrypoints must stay inside the module's realpath root. Explicit `--extension`/`-e` entries are inspected against the child cwd: one local entry is reused, distinct local entry aliases or any external/npm copy of this provider are rejected before launch. Owned launch, dependency injection and the child share `selectsClaudeProvider` over the trimmed task/environment model and normalized final CLI model/provider/scope. The legacy locator injection remains only as a test seam, not a production discovery path.
   - A missing local module, invalid metadata or unsupported version raises `ProviderExtensionError` (`provider_not_installed` / `provider_metadata_invalid` / `provider_version_unsupported`, bounded message with model, package and an action hint) before any child artifact or process exists. The synchronous throw is permanent: no retry and no model fallback, the concurrency slot is released and the bounded launch-failure artifacts are written.
   `[confirmed by code, spawn.ts, provider-extensions.ts; confirmed by tests, core.test.ts, provider-extensions.test.ts]`
6. **Environment**: child inherits parent env plus `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION=1`, `PI_TERMINAL_BELL_DISABLED=1`, and `PI_TOOLS_SUITE_DISABLED_MODULES` appended with `async-subagents,coding-discipline,question`. `[confirmed by code, spawn.ts ~230-240]`
7. **Model selection**: explicit forced/task/CLI model wins. Otherwise the
   resolved role profile and optional parent-model mapping produce the ranked
   candidate list (roles with `modelSelection: frontier` use the suite config's
   `frontierModels` list). Economy mode removes `expensive` frontier models.
   `parentProviderPolicy` then applies `any`, `prefer-other`, strict
   `require-other`, or `require-other-if-frontier` semantics relative to the
   known parent model's vendor (model family, not provider string).
   Runtime model selection removes unavailable/image-incompatible candidates,
   and session fallback skips models/providers already exhausted by quota
   failures. The fallback layer follows the already-resolved chain; it does not
   independently force a provider change. Per-role environment model overrides
   are applied while loading the effective role catalog.
   `[confirmed by code, config.ts/model-selection.ts/model-fallback.ts]`
   Legacy singular role selectors normalize with an explicit `fallbackModels`
   array (including `[]`), and every normalized `modelByParent` entry carries
   its own fallback array. Modern `models` profiles already encode the complete
   ordered candidate chain. `[confirmed by code, config.ts]`
   The bundled `oracle` uses `modelSelection: frontier` with
   `parentProviderPolicy: require-other-if-frontier`: for a frontier parent its
   entire initial/fallback chain excludes the parent's vendor; for other parents
   other vendors are preferred. A new frontier model is a `frontierModels` config
   entry, not an oracle edit. `[confirmed by oracle.md and frontier-models.test.ts]`
   The shipped frontier list is Astra, GLM-5.3, and
   `anthropic/claude-opus-5-5` with alias `*opus*` (any serving provider).
   Sol is not frontier; the bundled `frontier-review` explicitly excludes
   `*gpt-6.1-sol*` parents independently of the frontier list. The `implement`
   role uses Luna then Sol; `implement-core`, `frontier-review` and
   `delivery-review` use their own Sol-only model lists rather than the frontier
   candidate list. `mechanical` uses GLM-5.3 only.
   GPT-6 Sol is not an alias for GPT-6.1 Sol. Existing user/project model
   lists still override defaults and are not rewritten by this rollover.
   `[confirmed by frontier-models.ts and agents/implement.md]`
8. **Role router / auto-ultrawork classifier**: the role router and the
   `ULTRAWORK_AUTO` classifier both try `routing.model`, then
   `routing.fallbackModels`, then the current parent model, de-duplicating refs
   and continuing past unavailable/provider-error candidates. Abort remains
   terminal. `[confirmed by code, routing.ts/ultrawork-auto.ts]`
9. **UI QA special role**: `ui-qa` is the only built-in real-UI role for
   browser, terminal/TUI, and desktop-GUI verification. `browser-qa` is not an
   alias; a project may define that name only as an ordinary independent role.
   Like every async sub-agent, `ui-qa` runs without skills. UI QA additionally receives
   `PI_SUBAGENT_AGENT_DIR` plus launcher-owned `PI_UI_QA_RUNNER` and
   `PI_BROWSER_QA_RUNNER` paths, and gets private `ui-qa/flows/` plus
   browser-backend `ui-qa/browser/flows/` workspaces.
   The start prompt is a thin common contract: the child loads exactly one
   backend guide (`browser`/`tui`/`desktop`, plus `browser --topic auth` only
   when authentication is required) through the read-only allowlisted
   `PI_UI_QA_RUNNER guide` command before any UI action. The unified runner
   selects browser, PTY/TUI, or macOS Accessibility backends from a declarative
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
    Role profiles may additionally set `requiresIndexedProject: true`.
    This project-context gate requires only `.indexer-cli/` at the resolved
    project root and filters the parent catalog, automatic router, and explicit
    role validation. It does not require the `idx` executable and does not
    initialize anything. The bundled `knowledge-auditor` uses this gate.
    `[confirmed by code, config.ts/agent-catalog.ts/routing.ts]`
    `knowledge-auditor` is a low-thinking economical docs-only finalization
    role: the parent supplies a behavior/result summary and exact task-changed
    paths; the child runs task-scoped `idx audit`, fixes only small confirmed
    documentation drift, and escalates substantial or ambiguous drift rather
    than inventing a contract.
    It also accepts explicit **spec-review** assignments for bounded global
    knowledge-review slices: the parent supplies exact spec paths, review goal
    and pass budget rather than changed product paths. The child reviews every
    declared dependency, repairs only small proven documentation drift, and
    returns actual coverage, gaps and evidence (inline or as disposable reports
    under `.pi/artifacts/`). In this mode only the parent may acknowledge after
    integrated, stable review coverage; the child must not own a global cleanup
    loop. Project-local replacements must explicitly support this mode.
11. **Session persistence**: only when `ASYNC_SUBAGENTS_ENABLE_SESSIONS` is truthy (child gets `--session-dir <agentDir>/sessions`; otherwise `--no-session`). `[confirmed by code]`
12. **Timeout**: default 30 min (`DEFAULT_AGENT_TIMEOUT_MS`). On timeout: writes `timeout_ms`/`timed_out_at`/result.md, SIGTERM, SIGKILL after 5s grace, exit code 124. `[confirmed by code, spawn.ts ~168-187]`
13. **agent_end**: writes result.md, SIGTERM after 50ms grace, SIGKILL after 1s fallback. `[confirmed by code]`
14. **RPC prompt failure** (`success=false`): writes result.md with error, `notifyComplete(1)`, SIGTERM. `[confirmed by code]`
15. **Exit handling**: waits 10ms for stdio flush, then finalizes. Exit-code resolution: timed_out→124, completedFromAgentEnd→0, lastAgentEndError→1, numeric→code, signal→128, else→1. `[confirmed by code]`
16. **Parent billing accounting**: every finalized child assistant `message_end` with valid provider/model/usage is mirrored into the originating parent session through a durable `appendUsage("async-subagent", ...)` record. The spawn tool uses the captured parent session manager rather than whichever tab/session is active when a background child later finishes. Retries and provider/model fallbacks therefore record every billable child call. `[confirmed by code and async-subagents-usage.test.ts]`

### Parent completion delivery

- Decision: [0044 — Retractable parent completion delivery](../docs/decisions/0044-retractable-subagent-completions.md), superseding [0031](../docs/decisions/0031-subagent-completion-delivery.md).
- The optional parent [Heads Up observer](heads-up-observer.md#delegated-work-first-increment)
  receives a separate runtime-only evidence bridge: spawn captures session/anchor
  ownership before routing awaits, and final retry/fallback completion publishes
  a bounded child-reported result. This is not a parent message, wakeup, verified
  mutation/test receipt or an additional completion-delivery channel. It does not
  change wait/watch arbitration and does not replay adopted launches. Rationale:
  [0034 — Heads Up observer](../docs/decisions/0034-heads-up-observer.md#delegated-evidence-follow-up--2026-10-04).
- A tracked child's terminal status (`done`, `failed`, or `stopped`) remains
  extension-owned and retractable while the parent is busy, rather than entering
  the SDK follow-up queue immediately. At the successful `agent_before_settle`
  boundary, still-unconsumed completions become `async-subagents-agent-completion`
  custom-message drafts with one continuation request. An idle parent is woken
  via `triggerTurn: true`, `deliverAs: "followUp"`; only one idle wakeup is submitted
  per reconciliation. Completions arriving after the boundary remain eligible at
  settlement or the next two-second watcher tick. `[confirmed by code,
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
  `read` calls acknowledge only a registered launch's complete `result.md`, read
  from the beginning, whose returned text exactly matches the bounded (50 KiB)
  artifact captured before execution and rechecked afterward. Partial/truncated,
  failed, aborted, nonterminal, foreign-session or changed-result reads do not
  acknowledge completion. Reads of unrelated files and progress/status calls do
  not acknowledge it. Receipts inspect `tool_execution_end`, after all `tool_result`
  transformations, so downstream truncation or rejection cannot acknowledge a
  full artifact read. Tool hooks also cover nested tool calls; acknowledgement is
  tool-execution evidence, not proof that an outer script printed the result.
  Reads split across several calls are not accumulated. Already delivered SDK
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

### Concurrency (`core/concurrency.ts`)
- `createSemaphore(limit)`: `limit ≤ 0` = unlimited. `acquire(signal?)` queues when full, rejects on abort. `[confirmed by code]`
- Project-scoped semaphores cached in a `PROJECT_SEMAPHORES` Map keyed by resolved cwd; reused if same limit or if active/waiting > 0. `[confirmed by code, tools/spawn.ts ~50-58]`
- Default max concurrent = 5 (`DEFAULT_MAX_CONCURRENT`); configurable only through `PI_SUBAGENTS_MAX_CONCURRENT` or `ASYNC_SUBAGENTS_MAX_CONCURRENT`. Preset files configure model pools only and do not accept `maxConcurrent`. `[confirmed by code, core/config.ts:673-699]`

### Retry (`core/retry.ts`)
- `spawnAgentWithRetry()` wraps `spawnAgent` with retry + model-fallback loops. `[confirmed by code]`
- **Retry eligibility** (`shouldRetry`): status not `stopped`, exitCode ≠ 0; if `retryableExitCodes` is set the code must be in it; `undefined` → retry any non-zero; empty array → disable. `[confirmed by code, retry.ts ~140-148]`
- **Backoff**: exponential `delayMs = retry.backoffMs * 2^(attempt-1)`. `[confirmed by code]`
- **Retry metadata files**: `retry_count`, `retry_pending` (timestamp), `next_retry_at` (ISO), `retry.log` (append). Cleared on settle. `[confirmed by code]`
- **Model fallback** (before retry): if `isQuotaLimitCompletion` and a fallback exists, respawns immediately (no backoff), logs to `model_fallback.log`/`model_fallback_from`/`model_fallback_to`. `[confirmed by code, retry.ts ~78-97]`
- `AbortSignal` cancels pending retry timer and settles immediately. Returns `{initial, done}`; `done` resolves when all attempts finish or abort. `[confirmed by code]`

### Model fallback (`core/model-fallback.ts`)
- In-memory session state: `exhaustedModels`/`exhaustedProviders` Sets, `fallbackByModel`/`fallbackByProvider` Maps; resettable via `resetSessionModelFallbacks()`. `[confirmed by code]`
- `selectSessionModelWithFallback` / `nextFallbackModel` walk the resolved chain skipping exhausted models/providers. They do not independently require a different provider; remembered provider exhaustion can exclude same-provider candidates. `[confirmed by code; model-pool-contract.test.ts]`
- `isQuotaLimitCompletion` scans result.md + stderr.log + last 20 events.jsonl lines for: HTTP 429, "rate limit", "quota exceeded", "insufficient quota", "resource exhausted", "usage limit", "billing limit"; for the antigravity provider also "antigravity_all_accounts_exhausted". `[confirmed by code, model-fallback.ts ~40-66]`
- Antigravity providers are **never** marked exhausted at the provider level (`shouldRememberProviderExhaustion` returns false) — each account is tried individually. `[confirmed by code]`

### State (`core/state.ts`)
- **Statuses**: `planned` (prompt.md in `prompts/`, no agent dir), `running` (pid file + alive pid), `done` (exit_code=0), `failed` (exit_code≠0), `stopped` (exit_code="stopped" or dead pid without exit_code), `retrying` (retry_pending present). `[confirmed by code, state.ts 14-68]`
- Live pid check via `process.kill(pid, 0)`; ESRCH → `stopped`. `[confirmed by code]`
- `readResult` returns `{resultAvailable, result?, stderrAvailable, stderr?, exitCode, state, structured?}` (structured from `result.json`). `[confirmed by code]`
- `waitForAgents` polls `getRunState` until all terminal or timeout. `[confirmed by code]`

### Registry (`core/registry.ts`)
- **Location**: `<cwd>/.pi/subagents/registry.json`, `{version:1, latestRunId?, latestRunDir?, runs:{}, agents:{}}`. `[confirmed by code]`
- **Concurrent writers**: run recording and cleanup removal take a project-local
  exclusive `registry.json.lock` (owner pid/token). They retry for at most two
  seconds and reclaim a lock whose owner process is dead. A parseable lock whose
  PID is still alive is never reclaimed solely because of lock age; this fails
  closed on PID reuse rather than risking concurrent writers. Malformed owner
  metadata must remain unchanged for 30 seconds before recovery. Writers then
  read-modify-write while holding the lock.
  Registry replacement is same-directory temp-file + rename, so readers see
  either the previous complete JSON or the replacement, never a truncated write.
  `[confirmed by code and core.test.ts]`
- `resolveSubagentRunDir`: provided runDir → registry `latestRunDir` → scan `.pi/subagents/` by mtime. `[confirmed by code]`
- `loadSubagentRegistry` still treats unreadable or malformed registry content as
  empty so resolution safely falls back to directory scanning; normal registry
  writers cannot create that state because replacement is atomic. `[confirmed by code]`

### Cleanup (`core/cleanup.ts`) / Stop (`core/stop.ts`, `core/process.ts`)
- Normal session shutdown stops that session's subagents but preserves run
  directories, reports, QA screenshots/videos, bridged image attachments and
  registry pointers. A newly opened session can still resolve retained results
  by agent ID. Sibling-session agents are not stopped; reload/fork continue to
  skip shutdown stopping. Process cancellation/ownership safeguards are unchanged.
  Shutdown itself never authorizes evidence deletion. Explicit `subagents cleanup`
  and Desktop's existing 72-hour background TTL/manual Clean policy remain
  separate deletion mechanisms; this is not indefinite retention.
  `[confirmed by index.ts and tools.test.ts]`
  Decision: [0043 — Preserve subagent evidence on session shutdown](../docs/decisions/0043-subagent-evidence-retention.md).
- `findCleanupCandidates(runRoot, days=7, keep=20)`: only dirs where **all** agents have `exit_code` files, older than `days` by mtime, skipping the newest `keep`. `[confirmed by code]`
- `deleteRunDirs` = `fs.rmSync(dir,{recursive:true,force:true})`. Cleanup tool refuses paths outside the canonical `.pi/subagents/` prefix and defaults to **dry-run** (needs `delete=true`). `[confirmed by code, tools/cleanup.ts]`
- `stopAgents`: planned/retrying → writes `stop_requested`/`stop_signal`, removes retry files, writes result.md, `exit_code="stopped"`; running → signals the owned process group when `process_group` metadata exists, otherwise `terminateProcess(pid, signal)`. POSIX `process.kill`; Windows `taskkill /pid <pid> /T /F`. `validateStopSignal` allows only SIGTERM/SIGINT/SIGKILL. ESRCH handled gracefully. `[confirmed by code]`
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
manifest. Local SDK peers are symlinked without installing or fetching.

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

### Structured results (`core/structured-result.ts`) / Log limits (`core/log-limits.ts`)
- On completion writes `result.json` (summary, findings, file refs, risks, next actions, confidence); `resultText` truncated at `maxResultBytes` (default 100KB); `result.md` is always full. `[confirmed by code]`
- `events.jsonl` default 0 bytes (32MB only if `ASYNC_SUBAGENTS_DEBUG_LOGS`); `stderr.log` default 8MB; RPC line max 8MB (oversized dropped with a marker). `[confirmed by code]`

## Public contracts / inputs / outputs

### Tools (`tools/*.ts`)
- **spawn**: `{tasks: AgentTask[], runDir?, slug?, thinking?, extraArgs?, timeoutSeconds?, watchSeconds?}`. `AgentTask = {id?, task, scope?, subagentType?, model?, thinking?, promptAppend?, promptOverride?, focus?, imagePaths?, tools?, extraArgs?, timeoutSeconds?, parentObjective?}`. `[confirmed by code]`
- `ui-qa` is an explicit built-in role and has no compatibility alias. UI-QA tasks require
  confirmed image-capable model candidates even when `imagePaths` is empty.
  `[confirmed by code, routing.ts/model-selection.ts]`
- **status** `{runDir?, agentIds?}`, **wait** `{runDir?, agentIds?, timeout?, interval?, failFast?}`, **result** `{runDir?, agentId}`, **stop** `{runDir?, agentIds?, force?, signal?}`, **cleanup** `{runRoot?, days?, keep?, delete?}`. `[confirmed by code]`

### Disk layout
```
<cwd>/.pi/subagents/
  registry.json
  registry.json.lock  (transient while updating)
  <YYYY-MM-DDTHH-MM-SS>[-slug]/
    prompts/<agentId>.md
    <agentId>/
      prompt.md, pid, started_at, pi_args, project_cwd, subagent_type, model,
      image_paths, session_dir?, session_file?, parent_session?, return_session?,
      events.jsonl, progress.jsonl, stderr.log, result.md, result.json, exit_code, finished_at,
      process_group?  (non-Windows process-group leader PID),
      stop_requested?, stop_signal?, timeout_ms?, timed_out_at?,
      retry_count?, retry_pending?, next_retry_at?, retry.log?,
      model_fallback_from?, model_fallback_to?, model_fallback.log?,
      sessions/   (if ASYNC_SUBAGENTS_ENABLE_SESSIONS)
      ui-qa/flows/ (for ui-qa; unified flows plus native/TUI evidence)
      ui-qa/browser/flows/ (for ui-qa; trusted browser backend workspace)
```
`[confirmed by code]`

## Invariants
- Agent IDs match `/^[A-Za-z0-9._-]+$/` and must not contain `..`. `[confirmed by code, paths.ts ~36-43]`
- `exit_code` is a numeric string or literal `"stopped"`. `[confirmed by code]`
- Registry `version` is always 1. `[confirmed by code]`
- Concurrent `recordSubagentRun` and registry cleanup updates preserve unrelated
  run and agent mappings. `[confirmed by code and core.test.ts]`
- Sub-agents never receive the `subagents` tool → recursive spawning is impossible. `[confirmed by code, tool-guard.ts]`
- Sub-agents never keep the Claude provider's `pi_claude_code_provider_web_search` tool active (approved policy: no provider web search in any child). The provider registers it in its own `session_start`; the tool guard, loaded last, removes it from the active set, restricted `--tools` lists drop it, and a `tool_call` handler blocks every denied tool at execution as defense in depth. The opt-in real-Pi test checks the inventory actually handed to the provider for default, restricted and no-tools roles. `[confirmed by code, tool-guard.ts; confirmed by tests, provider-child-inventory.test.ts]`
- Semaphore is project-wide (keyed by resolved cwd). `[confirmed by code]`
- `ui-qa` tests the requested user-facing surface through the capability-first
  runner: browser delegates to the trusted backend, TUI uses a real PTY plus
  headless ANSI/VT screen model, and macOS desktop uses the bundled semantic
  Accessibility/CGWindow driver. Missing capabilities return `BLOCKED`; static
  or mock checks never replace requested UI execution. `[confirmed by code and
  agent contract]`

## Edge cases
- **No runDir**: registry `latestRunDir` → mtime scan → throw if nothing. `[confirmed by code]`
- **Implicit Antigravity model with isolated extensions**: if Antigravity is selected only through the model environment fallback or pi's persisted default, the child keeps `--no-extensions` and does not load `antigravity-auth`; callers must explicitly select an Antigravity model in task/CLI arguments. `[confirmed by code; confirmed by tests]`
- **Oversized RPC lines**: agent_end oversized lines still trigger termination with a fallback result; others dropped with a marker. `[confirmed by code]`
- **Prompt failure without exit_code**: `hasRpcPromptFailure` scans events.jsonl for `success=false`. `[confirmed by code]`
- **Retry + stop**: `stop_requested` cancels pending retries; stop also deletes `retry_pending`/`next_retry_at`. `[confirmed by code]`
- **Windows termination**: `taskkill /T /F` (tree kill) with 1s timeout, fallback `process.kill`. `[confirmed by code]`

## Side effects
- Writes the per-agent files listed above; deletes retry/stop metadata and the `session_dir` tree on respawn. `[confirmed by code]`
- Spawns one `pi --mode rpc` child per task; SIGTERM primary, SIGKILL fallback. `[confirmed by code]`
- On respawn (same runDir/agentId) unlinks prior exit_code/finished_at/result.*/events.jsonl/stderr.log/session links/timeout+stop+retry metadata. `[confirmed by code, spawn.ts ~38-51]`
- Sets `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION`, `PI_TERMINAL_BELL_DISABLED`, `PI_TOOLS_SUITE_DISABLED_MODULES` in child env. `[confirmed by code]`

## Implementation

- `external/pi-tools-suite/src/async-subagents/completion-delivery.ts`
- `external/pi-tools-suite/src/async-subagents/completion-receipts.ts`
- `external/pi-tools-suite/src/async-subagents/index.ts`
- `external/pi-tools-suite/src/async-subagents/polling.ts`
- `external/pi-tools-suite/src/async-subagents/tools/wait.ts`
- `external/pi-tools-suite/src/async-subagents/tools/subagents.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/src/dcp/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/work-tools.ts`
- `external/pi-tools-suite/src/ast-grep/tool.ts`
- `external/pi-tools-suite/src/web-search/index.ts`
- `external/pi-tools-suite/src/async-subagents/agents/research.md`
- `external/pi-tools-suite/src/async-subagents/agents/implement.md`
- `external/pi-tools-suite/src/async-subagents/agents/implement-core.md`
- `external/pi-tools-suite/src/async-subagents/agents/mechanical.md`
- `external/pi-tools-suite/src/async-subagents/agents/knowledge-auditor.md`
- `external/pi-tools-suite/src/async-subagents/agents/frontier-review.md`
- `external/pi-tools-suite/src/todo/subagent.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/repo-discovery/index.ts`
- `external/pi-tools-suite/src/brainstorm/research-extension.ts`
- `external/pi-tools-suite/src/todo/todo.ts`
- `external/pi-tools-suite/src/todo/state/store.ts`
- `external/pi-tools-suite/src/todo/state/replay.ts`
- `external/pi-tools-suite/src/async-subagents/core/owned-launch/`
- `external/pi-tools-suite/src/async-subagents/core/owned-launch-integration.ts`
- `external/pi-tools-suite/src/async-subagents/core/owned-retirement.ts`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `external/pi-tools-suite/src/async-subagents/core/agent-catalog.ts`
- `external/pi-tools-suite/src/async-subagents/core/routing.ts`
- `external/pi-tools-suite/src/async-subagents/core/ultrawork-auto.ts`
- `external/pi-tools-suite/src/async-subagents/core/model-selection.ts`
- `external/pi-tools-suite/src/async-subagents/core/ui-qa.ts`
- `external/pi-tools-suite/src/async-subagents/core/model-fallback.ts`
- `external/pi-tools-suite/src/async-subagents/core/retry.ts`
- `external/pi-tools-suite/src/async-subagents/core/concurrency.ts`
- `external/pi-tools-suite/src/async-subagents/core/state.ts`
- `external/pi-tools-suite/src/async-subagents/core/registry.ts`
- `external/pi-tools-suite/src/async-subagents/core/cleanup.ts`
- `external/pi-tools-suite/src/async-subagents/core/stop.ts`
- `external/pi-tools-suite/src/async-subagents/core/process.ts`
- `external/pi-tools-suite/src/async-subagents/core/attachment-bridge.ts`
- `external/pi-tools-suite/src/async-subagents/core/structured-result.ts`
- `external/pi-tools-suite/src/async-subagents/tools/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/delegated-evidence.ts`
- `external/pi-tools-suite/src/async-subagents/commands.ts`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`

## Tests

- `external/pi-tools-suite/test/async-subagents/dcp.test.ts`: command-free child DCP, lifecycle activation, disabled configuration and actual in-memory compression without journal/session writes or raw-history mutation.

- `external/pi-tools-suite/test/async-subagents/work-tools.test.ts`: optional
  policy, CLI removals, project replacements, read-only lifecycle/call guard,
  AST preview-only execution and actual SDK inventories for Claude/Codex models.
- `external/pi-tools-suite/test/ast-grep.test.ts`: existing search/apply behavior.
- `external/pi-tools-suite/test/web-search.test.ts`: credential/provider,
  fallback, timeout and cancellation behavior reused by child web tools.
- `external/pi-tools-suite/test/async-subagents/todo.test.ts`: child-local state,
  unchanged parent persistence, CLI restrictions, compaction and branch replay.
- `external/pi-tools-suite/test/async-subagents/provider-child-inventory.test.ts`:
  real offline child startup exposes todo and gated repo queries for default,
  restricted and empty selections.
- `external/pi-tools-suite/test/async-subagents/repo-tools.test.ts`: common repo
  registration, no setup, prerequisite gates, lifecycle selection and adapters.
- `external/pi-tools-suite/test/brainstorm/research-extension.test.ts`: common
  repo/todo composition without duplicate registration or weakening council guards.
- `tests/heads-up-delegated.test.ts`: cross-package report bridge, launch ownership,
  provenance labels, redaction and duplicate suppression.
- `external/pi-tools-suite/test/async-subagents/completion-delivery.test.ts`:
  tool-result/follow-up arbitration and reservation lifecycle regressions.
- `external/pi-tools-suite/test/async-subagents/completion-sdk.test.ts`:
  real SDK tool hooks, settlement continuation and provider-request counts
  with a deterministic offline provider.
- `external/pi-tools-suite/test/async-subagents/owned-launch/`: launcher
  transport/parser units, real pipe/socket backpressure regression, and opt-in
  native launchd crash/recovery tests.
- `external/pi-tools-suite/test/async-subagents/owned-runtime.test.ts` and
  `external/pi-tools-suite/test/async-subagents/owned-runtime-early.test.ts`:
  mocked receipt recovery, pending state, and fail-closed retirement/deletion.
- `external/pi-tools-suite/test/async-subagents/provider-owned-launch.test.ts`
  and `external/pi-tools-suite/test/async-subagents/provider-owned-runtime.test.ts`:
  opt-in real Pi/unmodified-provider offline lifecycle matrices, using a local
  protocol fixture rather than live inference.
- `external/pi-tools-suite/test/async-subagents/core.test.ts`: config/profile
  loading, semaphore behavior, process lifecycle, retry, model fallback, running
  stop behavior, structured results, and project-agent definitions.
- `external/pi-tools-suite/test/async-subagents/knowledge-auditor.test.ts`: default
  task-audit and explicit spec-review modes, tools, visibility and boundaries.
- `external/pi-tools-suite/test/async-subagents/tools.test.ts`: public tool
  validation and spawn/status/wait/result/stop integration.
- `external/pi-tools-suite/test/async-subagents/routing.test.ts`: explicit and
  automatic role routing, parent-model/project gates, unknown-role failures,
  and confirmation that `browser-qa` has no built-in alias.
- `external/pi-tools-suite/test/async-subagents/model-pools.test.ts` and
  `external/pi-tools-suite/test/async-subagents/model-pool-contract.test.ts`: role candidate ordering, parent-provider policy,
  runtime availability, and session fallback behavior.
- `external/pi-tools-suite/test/async-subagents/ui.test.ts`: task normalization,
  live-state tracking/rendering, polling, and slash-command UI.
- `external/pi-tools-suite/test/async-subagents/selection-e2e.test.ts`: opt-in LLM
  routing selection without spawning a real child.
- `external/pi-tools-suite/test/async-subagents/e2e.test.ts`: opt-in real
  subprocess workflows.

## Gaps / risks
1. **pid-check race**: `process.kill(pid,0)` is point-in-time; a process exiting
   between checks flips status on the next poll, not immediately. `[inferred]`
2. **Externally corrupted registry fallback**: malformed registry content still
   loads as empty and therefore loses registry history until the next write,
   although normal writers use atomic replacement and cannot expose partial JSON.
   `[confirmed by code]`
3. **`model_fallback_from`/`model_fallback_to` are diagnostic metadata** and are
   not a durable source for later routing decisions. `[confirmed by code]`
4. **Polling minimum interval is bounded in code**, so very short waits cannot
   become high-frequency busy polling. `[confirmed by code]`
5. **External process death remains asynchronous**: a child killed outside the
   launcher is observed on the next state reconciliation/poll. `[inferred]`
6. **`resolveSubagentRunDir` fallback scan is O(n)** over `.pi/subagents/` dirs
   by mtime. `[inferred]`
7. **Structured-result file-ref extraction is best-effort** and can produce
   false positives. `[confirmed by code]`

## Suggested verification
1. Add an integration test for externally killed children across semaphore/state
   reconciliation boundaries.
2. Decide whether corrupt `registry.json` should remain fail-open/empty or gain a
   visible recovery/backup path, then test that contract.
3. Keep opt-in real-subprocess E2E coverage for routing/model fallback and
   cleanup on supported CI/provider environments.
