import type { DcpConfig } from "./config.js";
import type { DcpState, ToolRecord } from "./state.js";
import { preserveRawMutationHash } from "./conversation-index.js";

export const EMERGENCY_CURRENT_TURN_PLACEHOLDER =
  "[Older tool output removed during current-turn context emergency; re-run the tool if exact content is needed]";

// Tool outputs whose effects may mutate the workspace/process or control DCP.
// Normalize names so provider/extension casing and aliases cannot bypass the
// safety policy. Unknown tools are handled conservatively by autonomous
// supersession below rather than assumed read-only.
const ALWAYS_PROTECTED_TOOLS = new Set([
  "compress", "write", "edit", "apply_patch", "patch",
  "bash", "shell", "powershell", "exec", "execute",
]);

function normalizeToolName(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function buildProtectedTools(config: DcpConfig, extra: string[] = []): Set<string> {
  return new Set([
    ...ALWAYS_PROTECTED_TOOLS,
    ...(config.compress.protectedTools ?? []).map(normalizeToolName),
    ...extra.map(normalizeToolName),
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

export function isToolRecordProtectedByFilePattern(record: ToolRecord | undefined, config: DcpConfig): boolean {
  if (!record || config.protectedFilePatterns.length === 0) return false;
  const values = collectStringValues(record.inputArgs);
  return values.some((value) =>
    config.protectedFilePatterns.some((pattern) => patternMatchesValue(pattern, value)),
  );
}

export function isToolRecordPruningProtected(
  record: ToolRecord,
  config: DcpConfig,
  extraProtectedTools: string[] = [],
): boolean {
  const protectedTools = buildProtectedTools(config, extraProtectedTools);
  if (protectedTools.has(normalizeToolName(record.toolName))) return true;
  return isToolRecordProtectedByFilePattern(record, config);
}

/** Backward-compatible name for callers that mean pruning protection. */
export const isToolRecordProtected = isToolRecordPruningProtected;

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

function placeholderForPrunedTool(msg: any, state: DcpState): string {
  const reason = state.prunedToolReasons.get(msg.toolCallId);
  if (reason === "manual-sweep") {
    return "[Output removed by /dcp sweep to save context]";
  }
  if (reason === "emergency-current-turn") {
    return EMERGENCY_CURRENT_TURN_PLACEHOLDER;
  }
  return "[Output removed to save context - information superseded or no longer needed]";
}

/**
 * Apply explicit tool output pruning from state.prunedToolIds.
 * Replaces content of matching toolResult messages in place.
 *
 * The canonical hash of the un-pruned raw message is preserved on the
 * projection entry (runtime-only) before the body is replaced: exact mutation
 * membership for compression blocks must bind to the raw content a later
 * materialization pass will actually see, not to this placeholder.
 */
export function applyToolOutputPruning(messages: any[], state: DcpState): void {
  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    if (!state.prunedToolIds.has(msg.toolCallId)) continue;

    preserveRawMutationHash(msg);
    msg.content = [
      {
        type: "text",
        text: placeholderForPrunedTool(msg, state),
      },
    ];
  }
}
