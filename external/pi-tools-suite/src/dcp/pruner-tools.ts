import type { DcpConfig } from "./config.js";
import type { DcpState, ToolRecord } from "./state.js";
import { estimateMessageTokens } from "./pruner-metadata.js";

// Tool outputs that must never be auto-pruned unless a future explicit user
// action intentionally changes that policy. They mutate state or control DCP.
const ALWAYS_PROTECTED_TOOLS = new Set(["compress", "write", "edit"]);

function buildProtectedTools(config: DcpConfig, extra: string[] = []): Set<string> {
  return new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.compress.protectedTools ?? []),
    ...extra,
  ]);
}

function collectStringValues(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, depth + 1);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringValues(item, out, depth + 1);
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function patternMatchesValue(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  const normalizedValue = value.replace(/\\/g, "/");

  // For plain path fragments, substring matching is more useful and less
  // surprising than exact matching.
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedValue.includes(normalizedPattern);
  }

  return globToRegExp(normalizedPattern).test(normalizedValue);
}

function isProtectedByFilePattern(record: ToolRecord | undefined, config: DcpConfig): boolean {
  if (!record || config.protectedFilePatterns.length === 0) return false;
  const values = collectStringValues(record.inputArgs);
  return values.some((value) =>
    config.protectedFilePatterns.some((pattern) => patternMatchesValue(pattern, value)),
  );
}

function recordForToolResult(msg: any, state: DcpState): ToolRecord | undefined {
  if (typeof msg.toolCallId !== "string") return undefined;
  return state.toolCalls.get(msg.toolCallId);
}

function toolNameForResult(msg: any, record: ToolRecord | undefined): string {
  return record?.toolName ?? msg.toolName ?? "";
}

function estimateToolResultTokens(msg: any, record: ToolRecord | undefined): number {
  return Math.max(record?.tokenEstimate ?? 0, estimateMessageTokens(msg));
}

function toolResultIsProtected(
  msg: any,
  record: ToolRecord | undefined,
  config: DcpConfig,
  extraProtectedTools: string[] = [],
): boolean {
  const protectedTools = buildProtectedTools(config, extraProtectedTools);
  const toolName = toolNameForResult(msg, record);
  if (protectedTools.has(toolName)) return true;
  return isProtectedByFilePattern(record, config);
}

export function isToolRecordProtected(
  record: ToolRecord,
  config: DcpConfig,
  extraProtectedTools: string[] = [],
): boolean {
  const protectedTools = buildProtectedTools(config, extraProtectedTools);
  if (protectedTools.has(record.toolName)) return true;
  return isProtectedByFilePattern(record, config);
}

export function markToolPruned(
  state: DcpState,
  toolCallId: string,
  reason: string,
  tokenEstimate = 0,
): boolean {
  const wasAlreadyPruned = state.prunedToolIds.has(toolCallId);
  if (!wasAlreadyPruned) state.prunedToolIds.add(toolCallId);
  if (!state.prunedToolReasons.has(toolCallId) || !wasAlreadyPruned) {
    state.prunedToolReasons.set(toolCallId, reason);
  }

  if (!state.accountedPrunedToolIds.has(toolCallId)) {
    state.accountedPrunedToolIds.add(toolCallId);
    state.totalPruneCount++;
    if (tokenEstimate > 0) state.tokensSaved += Math.max(0, Math.round(tokenEstimate));
  }

  return !wasAlreadyPruned;
}

export function applyDeduplication(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.deduplication.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  // fingerprint → array of toolCallIds in timestamp order
  const fingerprintMap = new Map<string, Array<{ id: string; tokens: number }>>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const record = recordForToolResult(msg, state);
    if (!record) continue;
    if (toolResultIsProtected(msg, record, config, config.strategies.deduplication.protectedTools ?? [])) continue;

    const fp = record.inputFingerprint;
    if (!fingerprintMap.has(fp)) {
      fingerprintMap.set(fp, []);
    }
    fingerprintMap.get(fp)!.push({ id: msg.toolCallId, tokens: estimateToolResultTokens(msg, record) });
  }

  // For each fingerprint with duplicates, prune all but the last
  for (const [, ids] of fingerprintMap) {
    if (ids.length <= 1) continue;
    // Keep the last one; prune the rest
    for (let i = 0; i < ids.length - 1; i++) {
      markToolPruned(state, ids[i]!.id, "duplicate", ids[i]!.tokens);
    }
  }
}

/**
 * Apply error purging: mark old error tool outputs for pruning.
 * Mutates state.prunedToolIds.
 */
export function applyErrorPurging(messages: any[], state: DcpState, config: DcpConfig): void {
  if (!config.strategies.purgeErrors.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const turnsThreshold = config.strategies.purgeErrors.turns ?? 3;

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!msg.isError) continue;

    const record = recordForToolResult(msg, state);
    if (!record) continue;
    if (toolResultIsProtected(msg, record, config, config.strategies.purgeErrors.protectedTools ?? [])) continue;

    if (state.currentTurn - record.turnIndex >= turnsThreshold) {
      markToolPruned(state, msg.toolCallId, "old-error", estimateToolResultTokens(msg, record));
    }
  }
}

/**
 * Policy-based autonomous tool-output pruning. This is the non-LLM half of
 * DCP: large, old, repeated, or stale discovery outputs can be replaced with
 * placeholders without waiting for the model to call `compress`.
 */
export function applyAutoToolOutputPruning(messages: any[], state: DcpState, config: DcpConfig): void {
  const strategy = config.strategies.autoToolPruning;
  if (!strategy.enabled) return;
  if (state.manualMode && !config.manualMode.automaticStrategies) return;

  const maxOutputTokens = Math.max(1, strategy.maxOutputTokens ?? 2000);
  const keepRecentTurns = Math.max(0, strategy.keepRecentTurns ?? 2);
  const readLikeTurns = Math.max(0, strategy.readLikeTurns ?? 3);
  const readLikeTools = new Set(strategy.readLikeTools ?? []);

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (typeof msg.toolCallId !== "string") continue;

    const record = recordForToolResult(msg, state);
    if (!record) continue;
    if (toolResultIsProtected(msg, record, config, strategy.protectedTools ?? [])) continue;

    const ageTurns = Math.max(0, state.currentTurn - record.turnIndex);
    const tokenEstimate = estimateToolResultTokens(msg, record);
    const toolName = toolNameForResult(msg, record);

    if (tokenEstimate > maxOutputTokens && ageTurns >= keepRecentTurns) {
      markToolPruned(state, msg.toolCallId, "large-output", tokenEstimate);
    } else if (readLikeTools.has(toolName) && ageTurns >= readLikeTurns) {
      markToolPruned(state, msg.toolCallId, "stale-read", tokenEstimate);
    }
  }
}

function placeholderForPrunedTool(msg: any, state: DcpState): string {
  const reason = state.prunedToolReasons.get(msg.toolCallId);
  if (reason === "duplicate") {
    return "[Output removed to save context - duplicate tool call; latest matching result kept]";
  }
  if (reason === "large-output") {
    return "[Large tool output removed to save context after it aged out of the active working set]";
  }
  if (reason === "stale-read") {
    return "[Stale read/search output removed to save context; re-read if exact content is needed again]";
  }
  if (reason === "manual-sweep") {
    return "[Output removed by /dcp sweep to save context]";
  }
  if (reason === "old-error" || msg.isError) {
    return "[Error output removed - tool failed more than the configured number of turns ago]";
  }
  return "[Output removed to save context - information superseded or no longer needed]";
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult messages in place.
 */
export function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;

    msg.content = [
      {
        type: "text",
        text: placeholderForPrunedTool(msg, state),
      },
    ];
  }
}
