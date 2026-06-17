import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import { PASSTHROUGH_ROLES, estimateMessageTokens } from "./pruner-metadata.js";
import { stableMessageId } from "./pruner-message-ids.js";
import { writeDcpDebugLog } from "./debug-log.js";

function messageMatchesBoundary(msg: any, messageIndex: number, stableId: string | undefined, timestamp: number): boolean {
  if (stableId && stableMessageId(msg, messageIndex) === stableId) return true;
  return msg.timestamp === timestamp;
}

function findBoundaryIndex(messages: any[], stableId: string | undefined, timestamp: number): number {
  return messages.findIndex((m, index) => messageMatchesBoundary(m, index, stableId, timestamp));
}

function collectToolCallIds(messages: any[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (typeof msg?.toolCallId === "string") ids.add(msg.toolCallId);
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "toolCall" && typeof block.id === "string") ids.add(block.id);
    }
  }
  return ids;
}

export function syncCompressionBlocks(messages: any[], state: DcpState, config: DcpConfig): void {
  if (state.compressionBlocks.length === 0) return;

  const toolCallIds = collectToolCallIds(messages);

  for (const block of state.compressionBlocks) {
    if (!block.active || block.deactivatedByUser) continue;

    if (
      typeof block.createdByToolCallId === "string" &&
      state.toolCalls.has(block.createdByToolCallId) &&
      !toolCallIds.has(block.createdByToolCallId)
    ) {
      block.active = false;
      block.deactivatedReason = "missing-origin-compress-call";
      writeDcpDebugLog(config, "block.auto_deactivated", {
        blockId: `b${block.id}`,
        reason: "missing-origin-compress-call",
        topic: block.topic,
        createdByToolCallId: block.createdByToolCallId,
        activeBlocksAfter: state.compressionBlocks.filter((b) => b.active).length,
      });
      continue;
    }

    const hasStableBoundaries = !!block.startMessageId && !!block.endMessageId;
    if (!hasStableBoundaries) continue;

    const startIdx = findBoundaryIndex(messages, block.startMessageId, block.startTimestamp);
    const endIdx = findBoundaryIndex(messages, block.endMessageId, block.endTimestamp);
    if (startIdx === -1 || endIdx === -1) {
      block.active = false;
      block.deactivatedReason = "missing-origin-message";
      writeDcpDebugLog(config, "block.auto_deactivated", {
        blockId: `b${block.id}`,
        reason: "missing-origin-message",
        topic: block.topic,
        missingBoundary: startIdx === -1 ? "start" : "end",
        startMessageId: block.startMessageId,
        endMessageId: block.endMessageId,
        activeBlocksAfter: state.compressionBlocks.filter((b) => b.active).length,
      });
    }
  }
}

export function applyCompressionBlocks(messages: any[], state: DcpState): any[] {
  const activeBlocks = state.compressionBlocks
    .filter((b) => b.active)
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
  if (activeBlocks.length === 0) return messages;

  for (const block of activeBlocks) {
    // Skip blocks with corrupted timestamps (from pre-fix sessions)
    if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) continue;

    // Find start and end indices by timestamp
    const startIdx = findBoundaryIndex(messages, block.startMessageId, block.startTimestamp);
    const endIdx = findBoundaryIndex(messages, block.endMessageId, block.endTimestamp);

    if (startIdx === -1 || endIdx === -1) continue;

    let lo = Math.min(startIdx, endIdx);
    let hi = Math.max(startIdx, endIdx);

    // Expand lo backward: if there is an assistant before lo whose tool_use
    // blocks have matching tool_results inside [lo..hi], pull the entire
    // assistant + any intermediate result messages into the range so the
    // group is always removed atomically.
    //
    // Critically we must skip backward past any toolResult / bashExecution
    // messages before lo, because an assistant with multiple tool_calls emits
    // N consecutive result messages — the assistant itself sits further back.
    while (lo > 0) {
      // Walk backward past tool-result messages to find the preceding assistant
      let scanIdx = lo - 1;
      while (scanIdx >= 0) {
        const r = (messages[scanIdx] as any).role as string;
        if (r !== "toolResult" && r !== "bashExecution" && !PASSTHROUGH_ROLES.has(r)) break;
        scanIdx--;
      }
      if (scanIdx < 0 || (messages[scanIdx] as any).role !== "assistant") break;

      const prev = messages[scanIdx] as any;
      const toolCallIdsInRange = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const m = messages[i] as any;
        if (
          (m.role === "toolResult" || m.role === "bashExecution") &&
          typeof m.toolCallId === "string"
        ) {
          toolCallIdsInRange.add(m.toolCallId);
        }
      }
      const prevContent: any[] = Array.isArray(prev.content) ? prev.content : [];
      const hasMatchingToolCalls = prevContent.some(
        (contentBlock: any) => contentBlock.type === "toolCall" && toolCallIdsInRange.has(contentBlock.id),
      );
      if (!hasMatchingToolCalls) break;
      // Pull assistant + all intermediate result messages into the range
      lo = scanIdx;
    }

    // Expand hi forward: for every assistant message in [lo..hi] that has
    // tool_use blocks, include any immediately-following tool_result messages
    // that correspond to those blocks. Loop to fixed point because expanding
    // hi could expose more assistants in theory.
    let prevHi: number;
    do {
      prevHi = hi;
      const assistantToolCallIds = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const m = messages[i] as any;
        if (m.role !== "assistant") continue;
        const content: any[] = Array.isArray(m.content) ? m.content : [];
        for (const contentBlock of content) {
          if (contentBlock.type === "toolCall" && typeof contentBlock.id === "string") {
            assistantToolCallIds.add(contentBlock.id);
          }
        }
      }
      while (hi + 1 < messages.length) {
        const next = messages[hi + 1] as any;
        if (
          (next.role === "toolResult" || next.role === "bashExecution") &&
          assistantToolCallIds.has(next.toolCallId)
        ) {
          hi++;
        } else if (PASSTHROUGH_ROLES.has(next.role)) {
          hi++;
        } else {
          break;
        }
      }
    } while (hi !== prevHi);

    // Estimate tokens removed
    let removedTokens = 0;
    for (let i = lo; i <= hi; i++) {
      removedTokens += estimateMessageTokens(messages[i]);
    }

    // Remove the range (inclusive)
    messages.splice(lo, hi - lo + 1);

    // Build synthetic user message for the compressed block
    const syntheticMsg = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "[Compressed section: " +
            block.topic +
            "]\n\n" +
            block.summary +
            "\n\n[dcp-block-id]: # (b" +
            block.id +
            ")",
        },
      ],
      // anchorTimestamp is always finite (resolveAnchorTimestamp returns
      // endTimestamp + 1 instead of Infinity), but guard against corrupted
      // state from older sessions where Infinity/null could leak in.
      timestamp: Number.isFinite(block.anchorTimestamp) ? block.anchorTimestamp - 0.5 : block.endTimestamp + 0.5,
    };

    // Estimate tokens added by the summary
    const addedTokens = estimateMessageTokens(syntheticMsg);

    // Insert the synthetic message
    messages.push(syntheticMsg);

    // Re-sort by timestamp
    messages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

    // Update tokens saved exactly once per compression block.
    if (!state.accountedCompressionBlockIds.has(block.id)) {
      state.accountedCompressionBlockIds.add(block.id);
      state.totalPruneCount++;
      const rawSaved = Math.max(0, removedTokens - addedTokens);
      const coveredSavings = (block.coveredBlockIds ?? []).reduce(
        (sum, id) => sum + (state.compressionTokenSavings.get(id) ?? 0),
        0,
      );
      const adjustment = rawSaved - coveredSavings;
      state.tokensSaved = Math.max(0, state.tokensSaved + adjustment);
      state.compressionTokenSavings.set(block.id, rawSaved);
    }
  }

  return messages;
}

/**
 * Remove orphaned toolResult/bashExecution messages whose corresponding
 * assistant toolCall was removed, and strip orphaned toolCall blocks from
 * assistant messages whose toolResult was removed.
 *
 * This is a safety net that runs after all compression blocks are applied.
 */
export function repairOrphanedToolPairs(messages: any[]): void {
  // 1. Build set of all toolCall IDs present in assistant messages
  const assistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    for (const contentBlock of content) {
      if (contentBlock.type === "toolCall" && typeof contentBlock.id === "string") {
        assistantToolCallIds.add(contentBlock.id);
      }
    }
  }

  // 2. Build set of all toolCallIds present in toolResult/bashExecution messages
  const resultToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string") {
      resultToolCallIds.add(msg.toolCallId);
    }
  }

  // 3. Remove orphaned toolResult/bashExecution messages (no matching assistant toolCall)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "toolResult" && msg.role !== "bashExecution") continue;
    if (typeof msg.toolCallId === "string" && !assistantToolCallIds.has(msg.toolCallId)) {
      messages.splice(i, 1);
    }
  }

  // 4. Strip orphaned toolCall blocks from assistant messages (no matching toolResult)
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const hasToolCalls = content.some((b: any) => b.type === "toolCall");
    if (!hasToolCalls) continue;

    const filtered = content.filter((contentBlock: any) => {
      if (contentBlock.type !== "toolCall") return true;
      return typeof contentBlock.id === "string" && resultToolCallIds.has(contentBlock.id);
    });

    // Only update if we actually removed something
    if (filtered.length !== content.length) {
      // If the assistant has no content left at all, keep at least an empty array
      msg.content = filtered.length > 0 ? filtered : [];
    }
  }
}
