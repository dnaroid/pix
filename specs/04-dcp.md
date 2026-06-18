# 04 — dcp: dynamic context pruning (as-is spec)

> Risk classes: **data / cross-cutting / irreversible context mutation**.
> Autonomous context-window management: monitors usage, prunes tool outputs,
> injects compression nudges, and provides the `compress` tool for LLM-driven
> summarisation. Headless (no TUI widgets).
>
> _Investigated by a read-only sub-agent; re-verify against current code.
> Line numbers are approximate._

## Purpose
Monitor context usage, prune tool outputs, inject compression nudges, and expose
a `compress` tool so the LLM can summarise conversation ranges/messages. `[confirmed by code: index.ts:1-4; confirmed by docs: CLAUDE.md]`

## Current behavior

### Lifecycle events (`index.ts`)
1. **session_start** — `resetState()` then `restoreState()` from sidecar; if no blocks and a `previousSessionFile` exists, inherits compression blocks from the prior session (`loadDcpStateFromSessionFile` + `inheritCompressionBlocks`). `[confirmed by code: index.ts 101-138]`
2. **session_shutdown** — force-flush sidecar (bypasses dedup hash). `[confirmed by code: index.ts 140-145]`
3. **before_agent_start** — appends DCP system prompt (manual-mode variant when enabled) to `event.systemPrompt`. `[confirmed by code]`
4. **tool_call** — records input args + fingerprint into `state.toolCalls`. `[confirmed by code]`
5. **tool_result** — finalises the tool record with `outputText`, `outputDetails`, `tokenEstimate`. `[confirmed by code]`
6. **message_end** — strips DCP metadata from assistant messages before persistence. `[confirmed by code]`
7. **context** — deep-clones messages, applies the pruning pipeline, manages nudge injection. `[confirmed by code]`
8. **before_provider_request** — injects the `<dcp-message-ids>` control block into the provider payload (Anthropic `system`, Google `config.systemInstruction`, OpenAI-style `messages`, or raw array) — **not** into the transcript. `[confirmed by code: index.ts 43-78, 313-330]`
9. **agent_end** — saves state to sidecar. `[confirmed by code]`

### Pruning pipeline (`pruner.ts`), applied every `context` event, in order
1. Count user turns → `state.currentTurn`. `[confirmed by code]`
2. `syncCompressionBlocks` — deactivate blocks whose origin compress `toolCallId` is gone or whose boundary messages disappeared. `[confirmed by code]`
3. `applyCompressionBlocks` — remove ranges covered by active blocks, insert synthetic `[Compressed section: …]` user messages with summaries, re-sort by timestamp; expands ranges to include preceding assistant messages whose toolCall ids are inside. `[confirmed by code]`
4. `repairOrphanedToolPairs` — remove toolResult/bashExecution whose assistant toolCall was removed; strip orphaned toolCall blocks from assistant messages. `[confirmed by code]`
5. `applyDeduplication` — for duplicate fingerprints, prune all but the last tool output. `[confirmed by code]`
6. `applyErrorPurging` — prune error tool results older than N user turns. `[confirmed by code]`
7. `applyAutoToolOutputPruning` — prune large old tool outputs (> `maxOutputTokens`, older than `keepRecentTurns`) and stale read-like tools (older than `readLikeTurns`). `[confirmed by code]`
8. `applyToolOutputPruning` — replace content of all `state.prunedToolIds` tool results with a placeholder. `[confirmed by code]`
9. `injectMessageIds` — rebuild `messageIdSnapshot`/`messageMetaSnapshot` with short ids `m001`,`m002`,… (ids are delivered via `before_provider_request`, not embedded in messages). `[confirmed by code]`

### Message IDs (`pruner-message-ids.ts`)
- Eligible roles: `user`, `assistant`, `toolResult`, `bashExecution`. Passthrough: `compaction`, `branch_summary`, `custom_message`. `[confirmed by code: pruner-metadata.ts]`
- 3-digit zero-padded, sequential. Stable ids derived from `msg.id`/`entryId`/`messageId`/`_dcpEntryId`/`metadata.*`, then `toolCallId`, then `ts:<timestamp>`, then `idx:<i>`. `[confirmed by code]`

### Nudges (`pruner-nudge.ts`)
- `getNudgeType`: `context-strong`/`context-soft` when `contextPercent > maxContextPercent`; `iteration` when `toolCallsSinceLastUser >= iterationNudgeThreshold`; `turn` when `nudgeCounter+1 >= nudgeFrequency` and `contextPercent > minContextPercent`. `[confirmed by code]`
- Nudges are **anchored** to the latest real user message (or assistant fallback) and mutated in-place each context event; anchors upgrade (low→high) but never downgrade. Cleared after a successful `compress`. `[confirmed by code; confirmed by tests]`
- Manual mode: only `context-strong`/`context-soft` nudges; routine `turn`/`iteration` suppressed; non-emergency anchors filtered each event. `[confirmed by code]`

### Metadata stripping (`pruner-metadata.ts`)
- Removes `<dcp-id>`, `[dcp-id]:`, `<dcp-block-id>`, `[dcp-block-id]:`, `<dcp-message-ids>`, `<dcp-system-reminder>` from text/thinking; **preserves** content inside markdown fences. Empty blocks dropped; signatures removed when text is modified. `[confirmed by code; confirmed by tests]`

### Compress tool (`compress-tool.ts`)
- Params: `topic` (string), `ranges[]` (`startId`,`endId`,`summary`), `messages[]` (`messageId`,`topic?`,`summary`). Range ids may be `mNNN` or `bN`; message ids must be raw `mNNN`. `[confirmed by code]`
- Overlapping ranges in one call rejected; partial overlap with an existing active block throws; fully-covered blocks are rolled up; missing/duplicate placeholders auto-recovered. `[confirmed by code; confirmed by tests]`
- Protected tool outputs (`protectedTools` ∪ `{compress,write,edit}`) appended verbatim to summaries. `<protect>…</protect>` extracted when `compress.protectTags`. `compress.protectUserMessages` appends user text verbatim and rejects per-message compression of user messages. `[confirmed by code; confirmed by tests]`
- Subagent result artifacts (`.pi/subagents/run/*/result.md`) read synchronously from disk and appended for `subagents`/`async_subagents_result` tools, capped at 50,000 chars. `[confirmed by code]`
- On success: clears nudge anchors, persists sidecar immediately, returns JSON with `tokensSaved` (per-op delta), context usage, skipped-message diagnostics. `[confirmed by code]`

## Public contracts / inputs / outputs

### Config (`config.ts`) — loaded from `~/.config/pi/pi-tools-suite.jsonc` under `"dcp"` only
Key fields and defaults: `enabled:true`, `debug:false`, `manualMode.enabled:false` (`.automaticStrategies:true`); `compress.maxContextPercent:0.65`, `minContextPercent:0.40`, `nudgeFrequency:2`, `iterationNudgeThreshold:8`, `nudgeForce:"soft"`, `protectedTools:["compress","write","edit"]`, `protectTags:false`, `protectUserMessages:false`, `summaryBuffer:true`; `compress.autoCandidates.{enabled:true, minContextPercent:0.40, keepRecentTurns:1, minMessages:6, minTokens:1500}`; `compress.messageMode.{enabled:true, minContextPercent:0.40, keepRecentTurns:1, mediumTokens:500, highTokens:5000, maxSuggestions:5}`; `strategies.deduplication.enabled:true`; `strategies.purgeErrors.{enabled:true, turns:4}`; `strategies.autoToolPruning.{enabled:true, maxOutputTokens:1200, keepRecentTurns:1, readLikeTurns:3}`; `protectedFilePatterns:[]`; per-model `modelOverrides`/`modelMaxContextPercent`/`modelMinContextPercent` with wildcard support. Env: `PI_DCP_DEBUG`, `PI_TOOLS_SUITE_DCP_DEBUG`, `PI_DCP_DEBUG_LOG`, `PI_DCP_DEBUG_MAX_BYTES`, `PI_DCP_DEBUG_MAX_BACKUPS`. `[confirmed by code: config.ts; confirmed by tests: dcp-config.test.ts]`

### Persisted state (`state-persistence.ts`, `state.ts`)
- Path `<sessionDir>/dcp-state/<sanitizedSessionId>.json` (non-`[a-zA-Z0-9._-]` → `_`). Overwrite semantics; deduped by DJB2 hash of serialized content (unchanged state skips write). `[confirmed by code]`
- Fields (`SerializedDcpState`): `compressionBlocks`, `nextBlockId`, `prunedToolIds`, `prunedToolReasons`, `compactToolCalls`, `totalToolCallCount`, `tokensSaved`, `totalPruneCount`, `accountedCompressionBlockIds`, `compressionTokenSavings`, `accountedPrunedToolIds`, `manualMode`, `nudgeAnchors`, `nextNudgeAnchorId`, `lastNudge`, `currentTurn`, `nudgeCounter`, `lastNudgeTurn`, `_stateHash`. `[confirmed by code: state.ts 211-262]`
- `CompactToolRecord` strips heavy fields (`outputText`/`outputDetails`/full `inputArgs`); caps string values at 512 chars / 20 per record; keeps ≤200 recent + all referenced-by-block/pruned/accounted. `[confirmed by code]`
- Save triggers: `agent_end`, successful `compress`, `session_shutdown` (force). `[confirmed by code]`
- `cleanupStaleDcpStateFiles` deletes sidecars for non-existent sessions or older than 7 days. `[confirmed by code; confirmed by tests]`

### Inheritance across fork/resume/new (`state.ts`, `state-persistence.ts`)
A session starting with zero blocks and a `previousSessionFile` loads the prior sidecar and merges blocks + accounting via `inheritCompressionBlocks`, then persists into its own sidecar. `[confirmed by code]`

## Invariants
- `state.compressionBlocks` is the single source of truth; active blocks are applied every `context` event. `[confirmed by code]`
- `state.prunedToolIds` is monotonic for the session lifetime. `[confirmed by code]`
- Token accounting is idempotent (re-pruning/re-applying does not double-count). `[confirmed by code; confirmed by tests]`
- Message-id snapshot is rebuilt from scratch every `context` event. `[confirmed by code]`
- `currentTurn` is re-derived from raw user-message count each event. `[confirmed by code]`

## Edge cases
- **Unknown compress ids**: throws with a diagnostic listing valid ids + active blocks. `[confirmed by code; confirmed by tests]`
- **Partial block overlap**: throws, no mutation. `[confirmed by code; confirmed by tests]`
- **Missing boundary messages / missing origin compress call**: block auto-deactivated with `deactivatedReason`. `[confirmed by code]`
- **Non-finite timestamps**: blocks skipped during application; restored `anchorTimestamp` defaults to `endTimestamp + 1`. `[confirmed by code]`
- **Negative `nudgeCounter`**: clamped to 0 on restore. `[confirmed by code]`
- **Empty/corrupt sidecar**: `restoreState` tolerates null/`{}`/wrong types → defaults. `[confirmed by code; confirmed by tests]`

## Side effects
- **Sidecar writes** on `agent_end`, successful compress, `session_shutdown`. `[confirmed by code]`
- **Debug log** `~/.pi/agent/dcp-debug.jsonl` (or `PI_DCP_DEBUG_LOG`), rotated at `maxBytes` with `maxBackups`. `[confirmed by code]`
- **Stale-sidecar cleanup** on `session_start`. `[confirmed by code]`
- **Context mutations (several irreversible — see Gaps)**: tool results replaced with placeholders; compressed ranges removed and replaced with synthetic summary user messages; DCP metadata stripped from assistant text; nudge text appended in-place to real user/assistant anchor messages (re-applied every event, not once). `[confirmed by code]`
- Appends `dcp-nudge` custom session entries (telemetry). `[confirmed by code]`

## Related files
`external/pi-tools-suite/src/dcp/`: `index.ts`, `pruner.ts`, `pruner-tools.ts`, `pruner-compression-blocks.ts`, `pruner-message-ids.ts`, `pruner-metadata.ts`, `pruner-nudge.ts`, `pruner-types.ts`, `pruner-candidates.ts`, `state.ts`, `state-persistence.ts`, `config.ts`, `debug-log.ts`, `compress-tool.ts`, `compression-blocks.ts`, `prompts.ts`, `commands.ts`, `ui.ts`, `tool-descriptions.ts`.

## Existing tests
- `compress-pruner.test.ts` (27): pruning effectiveness, dedup idempotency, auto-pruning, `protectedFilePatterns`, nudge cadence, anchored nudges, candidate detection, metadata stripping, compress tool (rollup, recovery, overlap rejection, stale ids, per-op savings, sidecar persistence, `protectUserMessages`, message-mode, protect tags, skipped diagnostics), `/dcp` recompress, `/dcp` stats, context-transform integration. `[confirmed by tests]`
- `dcp-state-persistence.test.ts` (5): save/load, overwrite, missing file, stale-session cleanup, 7-day age cleanup. `[confirmed by tests]`
- `dcp-state-serialization.test.ts` (14): `compactifyToolRecord`, `createInputFingerprint`, `serializeState` (bounded <1MB for 500 records), `restoreState` (compact + legacy + graceful), round-trip, `hashSerializedState`. `[confirmed by tests]`
- `dcp-config.test.ts` (6): defaults, user config, model overrides, wildcard precedence, `modelKeysFromContext`, ignores legacy/project config files. `[confirmed by tests]`
- `dcp-debug-log.test.ts` (4): rotation, backup content, env/config resolution, disabled=no-write. `[confirmed by tests]`
- `compress-ui.test.ts` (1): `normalizeDcpContextUsage`. `[confirmed by tests]`

## Gaps / risks
### Data loss (irreversible)
1. **Tool-output pruning**: pruned result content is replaced with a placeholder; the original `outputText` is kept only in the **live** `ToolRecord` and is **not persisted** (`compactifyToolRecord` strips it). After a session restart, the pruned output is gone. `[confirmed by code]`
2. **Compression blocks**: messages in a compressed range are removed; only the LLM-generated summary survives. `[confirmed by code]`
3. **Protected outputs after restart**: `appendProtectedToolOutputs` reads live `outputText`; after restart it is `undefined`, so future rollups would not preserve them. `[confirmed by code]`
4. **Subagent result artifacts** read synchronously at compress time; deleting the run dir before a rollup loses that content. `[confirmed by code]`
5. **Message-text metadata** (`messageMetaSnapshot.text`) used for candidate detection and protect-tag extraction is **not persisted**; protect-tag recovery fails silently after restart. `[inferred]`
6. **Nudge-anchor mutation**: real user/assistant messages are mutated every context event, not once. `[confirmed by code]`

### State consistency
7. **Sidecar dedup bypass**: if the in-memory hash gets out of sync (e.g. after a write failure resets it), an identical-state write can be suppressed. `[confirmed by code]`
8. **Save-queue error swallowing**: failed writes reset `lastPersistedStateHash` to undefined but swallow the error. `[confirmed by code]`
9. **Fork-inheritance race**: inheriting during `session_start` while the source sidecar is being written can read partial JSON (handled by try/catch → `undefined`). `[confirmed by code]`
10. **`currentTurn` re-derivation**: persisted value is overwritten on the first context event. `[confirmed by code]`

### Operational
11. **No config reload** — `loadConfig()` runs once at module init; changes need a pi restart. `[confirmed by code]`
12. **Debug log uses async `fs.appendFile`** (serialized via chain) — may be incomplete on crash. `[confirmed by code]`

## Suggested verification
1. **Restart data loss**: prune tool outputs, restart, confirm `/dcp stats` shows pruned ids but original output is gone (roll up a covering block → protected-output section absent). `[addresses #3]`
2. **Compress-then-reload roundtrip**: compress a range, restart, confirm the synthetic summary appears on the next context event. `[addresses #2]`
3. **Protect-tag survival**: `<protect>` a message, compress, restart, compress a covering range — confirm protected text is absent (metaSnapshot.text lost). `[addresses #5]`
4. **Fork inheritance**: fork a session with active blocks; confirm the new session inherits and persists them. `[addresses #9]`
5. **Bounded state at scale**: 500+ large tool calls; confirm serialized state <1MB and `totalToolCallCount` survives reload. `[addresses serialization tests]`
6. **Manual-mode nudge suppression**: drive context above `maxContextPercent` in manual mode; confirm only context-limit nudges fire. `[addresses nudge behavior]`
7. **Stale-sidecar cleanup**: create a sidecar for a non-existent session, trigger `session_start`; confirm deletion. `[addresses persistence tests]`
