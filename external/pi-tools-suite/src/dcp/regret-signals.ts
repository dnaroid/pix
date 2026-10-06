import type { DcpConfig } from "./config.js";
import { createInputFingerprint, type DcpState, type ToolRecord } from "./state.js";
import { observationKey } from "./stale-observations.js";
import { isSessionRecoveryCall } from "../session/actions.js";

export type CompressionRegretKind = "refetch" | "recovery";

/**
 * Runtime-only detector for "compressed too early / summary too thin":
 * the agent re-runs an identical observation whose result DCP currently hides
 * (compressed into a block or pruned), or reaches for session recovery after
 * DCP has compressed something. Signals are scalar diagnostics for tuning
 * thresholds and prompts; they never affect projection or recovery.
 */
export class CompressionRegretTracker {
  private hidden = new Set<string>();
  private visible = new Set<string>();
  /** Observation key per hidden result; tool inputs are immutable once recorded. */
  private keys = new Map<string, string | null>();

  reset(): void {
    this.hidden.clear();
    this.visible.clear();
    this.keys.clear();
  }

  /** Record which raw tool results the latest projection does not show verbatim. */
  observeProjection(raw: readonly any[], projected: readonly any[], state: DcpState): void {
    const visible = new Set<string>();
    for (const message of projected) {
      // A message-mode block keeps the result's role/call ID but replaces its
      // body (`_dcpOrigin: "block"`); a pruned result keeps only a placeholder.
      if (message?.role === "toolResult" && typeof message.toolCallId === "string" &&
        message._dcpOrigin !== "block" && !state.prunedToolIds.has(message.toolCallId)) visible.add(message.toolCallId);
    }
    const hidden = new Set<string>();
    for (const message of raw) {
      if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
      if (!visible.has(message.toolCallId)) hidden.add(message.toolCallId);
    }
    this.hidden = hidden;
    this.visible = visible;
  }

  private keyFor(toolCallId: string, state: DcpState, config: DcpConfig): string | null {
    let key = this.keys.get(toolCallId);
    if (key === undefined) {
      const record = state.toolCalls.get(toolCallId);
      key = record ? observationKey(record, config) ?? null : null;
      if (record) this.keys.set(toolCallId, key);
    }
    return key;
  }

  classifyToolCall(
    toolName: string,
    input: Record<string, unknown>,
    state: DcpState,
    config: DcpConfig,
  ): CompressionRegretKind | undefined {
    if (isSessionRecoveryCall(toolName, input)) {
      return state.compressionBlocks.length > 0 || state.prunedToolIds.size > 0 ? "recovery" : undefined;
    }
    if (this.hidden.size === 0) return undefined;
    const probe: ToolRecord = {
      toolCallId: "", toolName, inputArgs: input ?? {}, inputFingerprint: createInputFingerprint(toolName, input ?? {}),
      isError: false, turnIndex: 0, timestamp: 0, tokenEstimate: 0,
    };
    const key = observationKey(probe, config);
    if (!key) return undefined;
    // Re-reading something still visible verbatim is not caused by DCP.
    for (const toolCallId of this.visible) {
      if (this.keyFor(toolCallId, state, config) === key) return undefined;
    }
    for (const toolCallId of this.hidden) {
      if (this.keyFor(toolCallId, state, config) === key) return "refetch";
    }
    return undefined;
  }
}
