# 03 — async-subagents (as-is spec)

> Risk classes: **background jobs / concurrency / process management**. Spawns,
> monitors, stops, retries (with model fallback), and cleans up child pi
> processes ("sub-agents") from a parent pi session.
>
> _Investigated by a read-only sub-agent; re-verify claims against current code
> before relying on them. Line numbers are approximate._

## Purpose

Headless system for running isolated async sub-agents. Each sub-agent is a
separate `pi --mode rpc` child process that receives a task prompt via stdin
JSONL and streams RPC events back on stdout. The parent tracks state on disk and
exposes tool + slash-command interfaces. `[confirmed by code]`

## Current behavior

### Spawn (`core/spawn.ts`)
1. Each sub-agent is spawned via `node:child_process.spawn()` running the pi binary in RPC mode. `[confirmed by code, spawn.ts ~188]`
2. **Pi invocation resolution** (`core/pi-invocation.ts`): detects how pi was launched (Bun virtual script, direct node script, or generic runtime). Direct pi entrypoint → `process.execPath + [currentScript, ...args]`; generic node/bun → `pi` from PATH; Windows → `process.execPath args`. `[confirmed by code]`
3. **Pi args**: `--mode rpc`, `--session-dir <dir>` or `--no-session`, `--no-extensions`, `--extension <model-tools>`, `--model <model>`, `--tools <list>` (or `--no-tools`), `--thinking <level>`, extra user args, then `--extension <tool-guard>`. `[confirmed by code, spawn.ts ~67-95]`
4. **Stdin RPC**: sends two JSONL messages — `{type:"get_state",id:"sub_get_state"}` then `{type:"prompt",id:"sub_prompt",message:<prompt>[,images:<base64[]>]}`. Stdin stays open; EOF = pi shutdown. `[confirmed by code]`
5. **Extensions** loaded into children: `model-tools` (model-specific tool args) and `tool-guard` (strips parent-only tools: `question`, `subagents`, all `async_subagents_*`). `[confirmed by code, tool-guard.ts:3-10]`
6. **Environment**: child inherits parent env plus `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION=1`, `PI_TERMINAL_BELL_DISABLED=1`, and `PI_TOOLS_SUITE_DISABLED_MODULES` appended with `async-subagents,coding-discipline,question`. `[confirmed by code, spawn.ts ~230-240]`
7. **Model selection**: task model → preset-type model → global preset model → profile model; env override `ASYNC_SUBAGENTS_MODEL` / `PI_SUBAGENTS_MODEL`. `[confirmed by code, config.ts resolveAgentTaskConfig]`
8. **Session persistence**: only when `ASYNC_SUBAGENTS_ENABLE_SESSIONS` is truthy (child gets `--session-dir <agentDir>/sessions`; otherwise `--no-session`). `[confirmed by code]`
9. **Timeout**: default 30 min (`DEFAULT_AGENT_TIMEOUT_MS`). On timeout: writes `timeout_ms`/`timed_out_at`/result.md, SIGTERM, SIGKILL after 5s grace, exit code 124. `[confirmed by code, spawn.ts ~168-187]`
10. **agent_end**: writes result.md, SIGTERM after 50ms grace, SIGKILL after 1s fallback. `[confirmed by code]`
11. **RPC prompt failure** (`success=false`): writes result.md with error, `notifyComplete(1)`, SIGTERM. `[confirmed by code]`
12. **Exit handling**: waits 10ms for stdio flush, then finalizes. Exit-code resolution: timed_out→124, completedFromAgentEnd→0, lastAgentEndError→1, numeric→code, signal→128, else→1. `[confirmed by code]`

### Concurrency (`core/concurrency.ts`)
- `createSemaphore(limit)`: `limit ≤ 0` = unlimited. `acquire(signal?)` queues when full, rejects on abort. `[confirmed by code]`
- Project-scoped semaphores cached in a `PROJECT_SEMAPHORES` Map keyed by resolved cwd; reused if same limit or if active/waiting > 0. `[confirmed by code, tools/spawn.ts ~50-58]`
- Default max concurrent = 5 (`DEFAULT_MAX_CONCURRENT`); configurable via `asyncSubagents.maxConcurrent`. `[confirmed by code, config.ts ~72]`

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
- Source: `external/pi-tools-suite/src/async-subagents/` — `lib.ts`, `core/spawn.ts`, `core/registry.ts`, `core/state.ts`, `core/retry.ts`, `core/model-fallback.ts`, `core/concurrency.ts`, `core/cleanup.ts`, `core/sessions.ts`, `core/stop.ts`, `core/process.ts`, `core/prompt.ts`, `core/config.ts`, `core/pi-invocation.ts`, `core/paths.ts`, `core/structured-result.ts`, `core/log-limits.ts`, `core/tool-guard.ts`, `core/routing.ts`, `core/presets.ts`, `tasks.ts`, `tools/*.ts`, `commands.ts`, `constants.ts`
- Tests: `external/pi-tools-suite/test/async-subagents/ui.test.ts`, `selection-e2e.test.ts`

## Existing tests
- `ui.test.ts` `[confirmed by tests]`: format helpers (status glyphs ○◐✓✕■, labels), task normalization (empty/non-object/missing-text/duplicate-id/path-traversal rejection, auto-id skipping reserved ids, `toTaskPreviews`), live-run tracking (`getLiveRun`, `SubagentOverlay` pruning), rendering (compact/expanded/plain summaries, width truncation, public `subagents` renderResult), polling (`clampWatchSeconds`, terminal/timeout/abort), slash commands (`/subagent-preset`, `/sub-status`, `/sub-open` `/sub-back` `/sub-where` via `return_session`).
- `selection-e2e.test.ts` `[confirmed by tests, opt-in via ASYNC_SUBAGENTS_SELECTION_E2E=1]`: LLM routing selection; intercepts the tool call before spawn (no real subprocess). `[confirmed by tests]`

## Gaps / risks
1. **No unit test for the semaphore** (acquire/release, queue ordering, abort-while-queued, double-release, limit=0). `[inferred]`
2. **Retry + model-fallback integration untested** (retry→fallback→retry-again). `[inferred]`
3. **pid-check race**: `process.kill(pid,0)` is point-in-time; a process exiting between checks flips status on the next poll, not immediately. `[inferred]`
4. **Registry corruption silently loses history** (`loadSubagentRegistry` swallows parse errors). `[confirmed by code]`
5. **`model_fallback_from`/`model_fallback_to` written but never read** by production code. `[inferred]`
6. **No test for stopping a *running* child** (only planned agents are covered). `[inferred]`
7. **Polling minimum interval hardcoded to 250ms** (`pollRunWithUpdates`). `[confirmed by code]`
8. **Semaphore never reset for the process lifetime** → a child killed externally (SIGKILL) without `onComplete` can leak a slot. `[inferred]`
9. **`resolveSubagentRunDir` fallback scan is O(n)** over all `.pi/subagents/` dirs by mtime. `[inferred]`
10. **Structured-result file-ref extraction is best-effort regex** → false positives possible. `[confirmed by code]`

## Suggested verification
1. Unit tests for `createSemaphore` (basic/queue/abort/double-release/limit=0).
2. Unit test for `spawnAgentWithRetry` with a mock `spawnAgent`: retry on non-zero, no retry on success/stopped, backoff timing, model-fallback bypasses backoff, abort cancels retry.
3. Integration test: external SIGKILL of a child does not leak a semaphore slot.
4. Test registry recovery on corrupt `registry.json`.
5. Test cleanup candidate selection with partially-completed runs (must not be candidates).
