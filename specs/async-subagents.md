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

Headless system for running isolated async sub-agents. Each sub-agent is a
separate `pi --mode rpc` child process that receives a task prompt via stdin
JSONL and streams RPC events back on stdout. The parent tracks state on disk and
exposes tool + slash-command interfaces. `[confirmed by code]`

## Current behavior

### Spawn (`core/spawn.ts`)
1. Each sub-agent is spawned via `node:child_process.spawn()` running the pi binary in RPC mode. `[confirmed by code, spawn.ts ~188]`
2. **Pi invocation resolution** (`core/pi-invocation.ts`): detects how pi was launched (Bun virtual script, direct node script, or generic runtime). Direct pi entrypoint → `process.execPath + [currentScript, ...args]`; generic node/bun → `pi` from PATH; Windows → `process.execPath args`. `[confirmed by code]`
3. **Pi args**: `--mode rpc`, `--session-dir <dir>` or `--no-session`, `--no-extensions`, `--extension <model-tools>`, conditionally `--extension <antigravity-auth>`, `--model <model>`, `--tools <list>` (or `--no-tools`), `--thinking <level>`, extra user args, then `--extension <tool-guard>`. `[confirmed by code, spawn.ts; confirmed by tests, core.test.ts]`
4. **Stdin RPC**: sends two JSONL messages — `{type:"get_state",id:"sub_get_state"}` then `{type:"prompt",id:"sub_prompt",message:<prompt>[,images:<base64[]>]}`. Stdin stays open; EOF = pi shutdown. `[confirmed by code]`
5. **Extensions** loaded into children: `model-tools` (model-specific tool args) and `tool-guard` (strips parent-only tools: `question`, `subagents`, all `async_subagents_*`). `antigravity-auth` is restored after `--no-extensions` only when the effective explicit task/CLI model is `antigravity/<model>`; a model sourced only from `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL` does not opt it in. Later `--model`, `-m`, or `--model=...` extra args override the task model for this decision. `[confirmed by code, spawn.ts; confirmed by tests, core.test.ts]`
6. **Environment**: child inherits parent env plus `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION=1`, `PI_TERMINAL_BELL_DISABLED=1`, and `PI_TOOLS_SUITE_DISABLED_MODULES` appended with `async-subagents,coding-discipline,question`. `[confirmed by code, spawn.ts ~230-240]`
7. **Model selection**: explicit forced/task/CLI model wins. Otherwise the
   resolved role profile, parent-model mapping, and active preset contribute a
   ranked candidate list; pool presets filter that list to their allowed models,
   runtime model selection removes unavailable/image-incompatible candidates,
   and session fallback skips models/providers already exhausted by quota
   failures. Per-role environment model overrides are applied while loading the
   effective role catalog. `[confirmed by code, config.ts/model-selection.ts]`
8. **Session persistence**: only when `ASYNC_SUBAGENTS_ENABLE_SESSIONS` is truthy (child gets `--session-dir <agentDir>/sessions`; otherwise `--no-session`). `[confirmed by code]`
9. **Timeout**: default 30 min (`DEFAULT_AGENT_TIMEOUT_MS`). On timeout: writes `timeout_ms`/`timed_out_at`/result.md, SIGTERM, SIGKILL after 5s grace, exit code 124. `[confirmed by code, spawn.ts ~168-187]`
10. **agent_end**: writes result.md, SIGTERM after 50ms grace, SIGKILL after 1s fallback. `[confirmed by code]`
11. **RPC prompt failure** (`success=false`): writes result.md with error, `notifyComplete(1)`, SIGTERM. `[confirmed by code]`
12. **Exit handling**: waits 10ms for stdio flush, then finalizes. Exit-code resolution: timed_out→124, completedFromAgentEnd→0, lastAgentEndError→1, numeric→code, signal→128, else→1. `[confirmed by code]`

### Concurrency (`core/concurrency.ts`)
- `createSemaphore(limit)`: `limit ≤ 0` = unlimited. `acquire(signal?)` queues when full, rejects on abort. `[confirmed by code]`
- Project-scoped semaphores cached in a `PROJECT_SEMAPHORES` Map keyed by resolved cwd; reused if same limit or if active/waiting > 0. `[confirmed by code, tools/spawn.ts ~50-58]`
- Default max concurrent = 5 (`DEFAULT_MAX_CONCURRENT`); configurable via the top-level `maxConcurrent` field of the subagent config (project `.pi/agents/presets.jsonc` or the builtin presets file) or env `PI_SUBAGENTS_MAX_CONCURRENT` / `ASYNC_SUBAGENTS_MAX_CONCURRENT`. `[confirmed by code, core/config.ts:127,211,673-674]`

### Retry (`core/retry.ts`)
- `spawnAgentWithRetry()` wraps `spawnAgent` with retry + model-fallback loops. `[confirmed by code]`
- **Retry eligibility** (`shouldRetry`): status not `stopped`, exitCode ≠ 0; if `retryableExitCodes` is set the code must be in it; `undefined` → retry any non-zero; empty array → disable. `[confirmed by code, retry.ts ~140-148]`
- **Backoff**: exponential `delayMs = retry.backoffMs * 2^(attempt-1)`. `[confirmed by code]`
- **Retry metadata files**: `retry_count`, `retry_pending` (timestamp), `next_retry_at` (ISO), `retry.log` (append). Cleared on settle. `[confirmed by code]`
- **Model fallback** (before retry): if `isQuotaLimitCompletion` and a fallback exists, respawns immediately (no backoff), logs to `model_fallback.log`/`model_fallback_from`/`model_fallback_to`. `[confirmed by code, retry.ts ~78-97]`
- `AbortSignal` cancels pending retry timer and settles immediately. Returns `{initial, done}`; `done` resolves when all attempts finish or abort. `[confirmed by code]`

### Model fallback (`core/model-fallback.ts`)
- In-memory session state: `exhaustedModels`/`exhaustedProviders` Sets, `fallbackByModel`/`fallbackByProvider` Maps; resettable via `resetSessionModelFallbacks()`. `[confirmed by code]`
- `selectSessionModelWithFallback` / `nextFallbackModel` walk the chain skipping exhausted models/providers (fallback must be a different provider). `[confirmed by code]`
- `isQuotaLimitCompletion` scans result.md + stderr.log + last 20 events.jsonl lines for: HTTP 429, "rate limit", "quota exceeded", "insufficient quota", "resource exhausted", "usage limit", "billing limit"; for the antigravity provider also "antigravity_all_accounts_exhausted". `[confirmed by code, model-fallback.ts ~40-66]`
- Antigravity providers are **never** marked exhausted at the provider level (`shouldRememberProviderExhaustion` returns false) — each account is tried individually. `[confirmed by code]`

### State (`core/state.ts`)
- **Statuses**: `planned` (prompt.md in `prompts/`, no agent dir), `running` (pid file + alive pid), `done` (exit_code=0), `failed` (exit_code≠0), `stopped` (exit_code="stopped" or dead pid without exit_code), `retrying` (retry_pending present). `[confirmed by code, state.ts 14-68]`
- Live pid check via `process.kill(pid, 0)`; ESRCH → `stopped`. `[confirmed by code]`
- `readResult` returns `{resultAvailable, result?, stderrAvailable, stderr?, exitCode, state, structured?}` (structured from `result.json`). `[confirmed by code]`
- `waitForAgents` polls `getRunState` until all terminal or timeout. `[confirmed by code]`

### Registry (`core/registry.ts`)
- **Location**: `<cwd>/.pi/subagents/registry.json`, `{version:1, latestRunId?, latestRunDir?, runs:{}, agents:{}}`. `[confirmed by code]`
- `resolveSubagentRunDir`: provided runDir → registry `latestRunDir` → scan `.pi/subagents/` by mtime. `[confirmed by code]`
- `loadSubagentRegistry` catches parse errors and returns an empty registry (silently losing history). `[confirmed by code]`

### Cleanup (`core/cleanup.ts`) / Stop (`core/stop.ts`, `core/process.ts`)
- `findCleanupCandidates(runRoot, days=7, keep=20)`: only dirs where **all** agents have `exit_code` files, older than `days` by mtime, skipping the newest `keep`. `[confirmed by code]`
- `deleteRunDirs` = `fs.rmSync(dir,{recursive:true,force:true})`. Cleanup tool refuses paths outside the canonical `.pi/subagents/` prefix and defaults to **dry-run** (needs `delete=true`). `[confirmed by code, tools/cleanup.ts]`
- `stopAgents`: planned/retrying → writes `stop_requested`/`stop_signal`, removes retry files, writes result.md, `exit_code="stopped"`; running → `terminateProcess(pid, signal)`. POSIX `process.kill`; Windows `taskkill /pid <pid> /T /F`. `validateStopSignal` allows only SIGTERM/SIGINT/SIGKILL. ESRCH handled gracefully. `[confirmed by code]`

### Structured results (`core/structured-result.ts`) / Log limits (`core/log-limits.ts`)
- On completion writes `result.json` (summary, findings, file refs, risks, next actions, confidence); `resultText` truncated at `maxResultBytes` (default 100KB); `result.md` is always full. `[confirmed by code]`
- `events.jsonl` default 0 bytes (32MB only if `ASYNC_SUBAGENTS_DEBUG_LOGS`); `stderr.log` default 8MB; RPC line max 8MB (oversized dropped with a marker). `[confirmed by code]`

## Public contracts / inputs / outputs

### Tools (`tools/*.ts`)
- **spawn**: `{tasks: AgentTask[], runDir?, slug?, thinking?, extraArgs?, timeoutSeconds?, watchSeconds?}`. `AgentTask = {id?, task, scope?, subagentType?, model?, thinking?, promptAppend?, promptOverride?, focus?, imagePaths?, tools?, extraArgs?, timeoutSeconds?, parentObjective?}`. `[confirmed by code]`
- **status** `{runDir?, agentIds?}`, **wait** `{runDir?, agentIds?, timeout?, interval?, failFast?}`, **result** `{runDir?, agentId}`, **stop** `{runDir?, agentIds?, force?, signal?}`, **cleanup** `{runRoot?, days?, keep?, delete?}`. `[confirmed by code]`

### Disk layout
```
<cwd>/.pi/subagents/
  registry.json
  <YYYY-MM-DDTHH-MM-SS>[-slug]/
    prompts/<agentId>.md
    <agentId>/
      prompt.md, pid, started_at, pi_args, project_cwd, subagent_type, model,
      image_paths, session_dir?, session_file?, parent_session?, return_session?,
      events.jsonl, stderr.log, result.md, result.json, exit_code, finished_at,
      stop_requested?, stop_signal?, timeout_ms?, timed_out_at?,
      retry_count?, retry_pending?, next_retry_at?, retry.log?,
      model_fallback_from?, model_fallback_to?, model_fallback.log?,
      sessions/   (if ASYNC_SUBAGENTS_ENABLE_SESSIONS)
```
`[confirmed by code]`

## Invariants
- Agent IDs match `/^[A-Za-z0-9._-]+$/` and must not contain `..`. `[confirmed by code, paths.ts ~36-43]`
- `exit_code` is a numeric string or literal `"stopped"`. `[confirmed by code]`
- Registry `version` is always 1. `[confirmed by code]`
- Sub-agents never receive the `subagents` tool → recursive spawning is impossible. `[confirmed by code, tool-guard.ts]`
- Semaphore is project-wide (keyed by resolved cwd). `[confirmed by code]`

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

## Related files

- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `external/pi-tools-suite/src/async-subagents/core/agent-catalog.ts`
- `external/pi-tools-suite/src/async-subagents/core/routing.ts`
- `external/pi-tools-suite/src/async-subagents/core/model-selection.ts`
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
- `external/pi-tools-suite/src/async-subagents/commands.ts`

## Existing tests

- `external/pi-tools-suite/test/async-subagents/core.test.ts`: config/profile
  loading, semaphore behavior, process lifecycle, retry, model fallback, running
  stop behavior, structured results, and project-agent definitions.
- `external/pi-tools-suite/test/async-subagents/tools.test.ts`: public tool
  validation and spawn/status/wait/result/stop integration.
- `external/pi-tools-suite/test/async-subagents/routing.test.ts`: explicit and
  automatic role routing, parent-model gates, and routing failures.
- `external/pi-tools-suite/test/async-subagents/model-pools.test.ts` and
  `model-pool-contract.test.ts`: pool filtering and session fallback behavior.
- `external/pi-tools-suite/test/async-subagents/ui.test.ts`: task normalization,
  live-state tracking/rendering, polling, and slash-command UI.
- `external/pi-tools-suite/test/async-subagents/selection-e2e.test.ts`: opt-in LLM
  routing selection without spawning a real child.
- `external/pi-tools-suite/test/async-subagents/e2e.test.ts`: opt-in real
  subprocess workflows.

## Gaps / risks
1. **pid-check race**: `process.kill(pid,0)` is point-in-time; a process exiting
   between checks flips status on the next poll, not immediately. `[inferred]`
2. **Registry corruption silently loses history** (`loadSubagentRegistry`
   returns an empty registry on parse failure). `[confirmed by code]`
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
