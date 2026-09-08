import type { DcpConfig } from "./config.js";
import { hasExactCompressionMembership, type CompressionBlock, type CompressionMember, type DcpState } from "./state.js";
import { estimateMessageTokens } from "./pruner-metadata.js";
import { stableMessageKeys } from "./pruner-message-ids.js";
import { writeDcpDebugLog } from "./debug-log.js";
import { canonicalMessageHash, rawMutationHashOf } from "./conversation-index.js";

function findBoundaryIndex(messages: any[], stableId: string | undefined, timestamp: number): number {
  if (stableId) {
    const stableKeys = stableMessageKeys(messages);
    return stableKeys.indexOf(stableId);
  }
  const matches = messages.flatMap((message, index) => message.timestamp === timestamp ? [index] : []);
  return matches.length === 1 ? matches[0]! : -1;
}

/**
 * Mutation identity of one message occurrence. A projection entry whose body
 * DCP replaced (tool-output placeholder) legitimately stands in for its
 * preserved raw content, so its identity is that recorded raw hash; every
 * other message is identified by its own canonical hash. Exactness is not
 * relaxed: the member hash must still match this identity, in order,
 * contiguously, and any changed raw content still fails closed.
 */
function mutationIdentity(message: any): string {
  return rawMutationHashOf(message) ?? canonicalMessageHash(message);
}

function exactMemberSpan(messages: any[], members: CompressionMember[]): { lo: number; hi: number } | undefined {
  const keys = stableMessageKeys(messages);
  const lo = keys.indexOf(members[0]!.stableId);
  if (lo < 0 || lo + members.length > messages.length) return undefined;
  for (let offset = 0; offset < members.length; offset++) {
    const member = members[offset]!;
    if (keys[lo + offset] !== member.stableId || mutationIdentity(messages[lo + offset]) !== member.hash) return undefined;
  }
  return { lo, hi: lo + members.length - 1 };
}

function exactStableIdSpan(messages: any[], members: CompressionMember[]): { lo: number; hi: number } | undefined {
  const keys = stableMessageKeys(messages);
  const lo = keys.indexOf(members[0]!.stableId);
  if (lo < 0 || lo + members.length > messages.length) return undefined;
  for (let offset = 0; offset < members.length; offset++) {
    if (keys[lo + offset] !== members[offset]!.stableId) return undefined;
  }
  return { lo, hi: lo + members.length - 1 };
}

function exactBlockSpan(messages: any[], block: CompressionBlock): { lo: number; hi: number } | undefined {
  if (!hasExactCompressionMembership(block)) return undefined;
  return exactMemberSpan(messages, block.mutationMembers!) ?? exactMemberSpan(messages, block.sourceMembers!);
}


export function syncCompressionBlocks(messages: any[], state: DcpState, config: DcpConfig): void {
  if (state.compressionBlocks.length === 0) return;

  // Determine the conversation's timestamp range so we can tell whether a
  // block's range is genuinely outside the current session history (which
  // warrants deactivation) vs merely having its boundary messages pruned
  // (which is normal and should NOT cause deactivation).
  let conversationMinTs = Infinity;
  let conversationMaxTs = -Infinity;
  for (const msg of messages) {
    const ts = msg?.timestamp;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      if (ts < conversationMinTs) conversationMinTs = ts;
      if (ts > conversationMaxTs) conversationMaxTs = ts;
    }
  }

  for (const block of state.compressionBlocks) {
    if (!block.active) continue;

    if (!hasExactCompressionMembership(block)) {
      block.active = false;
      block.deactivatedReason = "invalid-exact-membership";
      writeDcpDebugLog(config, "block.auto_deactivated", {
        blockId: `b${block.id}`,
        reason: block.deactivatedReason,
        topic: block.topic,
      });
      continue;
    }

    // If the same exact stable sequence still exists but the recorded source
    // and raw hashes no longer match, never widen or guess a replacement.
    if (
      exactStableIdSpan(messages, block.mutationMembers!) &&
      !exactMemberSpan(messages, block.mutationMembers!) &&
      !exactMemberSpan(messages, block.sourceMembers!)
    ) {
      block.active = false;
      block.deactivatedReason = "exact-membership-mismatch";
      writeDcpDebugLog(config, "block.auto_deactivated", {
        blockId: `b${block.id}`,
        reason: block.deactivatedReason,
        topic: block.topic,
      });
      continue;
    }

    // ── Skip the missing-origin-compress-call check ────────────────────
    // The compress tool-call that *created* this block is not the block's
    // content — once the block exists the tool-call is irrelevant and will
    // naturally be pruned by tool-output pruning, session compaction, or
    // nested compression.  Deactivating a valid block because its creation
    // tool-call was pruned silently loses the compressed summary and forces
    // the original (larger) messages to be re-sent, which also invalidates
    // the provider's prompt prefix cache.

    // ── Boundary validation ────────────────────────────────────────────
    // Only deactivate when the block's timestamp range falls entirely
    // outside the conversation's time range, meaning the session genuinely
    // does not contain that history (e.g. after a branch switch to a
    // completely different conversation).  When boundary messages are merely
    // absent because they were themselves pruned, compressed, or have
    // fragile timestamp-based stable IDs, the block is still valid —
    // applyCompressionBlocks already handles missing boundaries gracefully
    // by skipping splicing when findBoundaryIndex returns -1.
    if (
      Number.isFinite(block.startTimestamp) &&
      Number.isFinite(block.endTimestamp) &&
      Number.isFinite(conversationMinTs) &&
      Number.isFinite(conversationMaxTs)
    ) {
      // Block range is entirely before or entirely after the conversation
      const blockEntirelyOutside =
        block.endTimestamp < conversationMinTs ||
        block.startTimestamp > conversationMaxTs;

      if (blockEntirelyOutside) {
        // Before deactivating, check if boundary messages can still be
        // found by their stable ID — timestamps can change across
        // session reloads while the underlying message persists.
        const startFound = findBoundaryIndex(messages, block.startMessageId, block.startTimestamp) !== -1;
        const endFound = findBoundaryIndex(messages, block.endMessageId, block.endTimestamp) !== -1;

        if (!startFound && !endFound) {
          block.active = false;
          block.deactivatedReason = "outside-conversation-range";
          writeDcpDebugLog(config, "block.auto_deactivated", {
            blockId: `b${block.id}`,
            reason: "outside-conversation-range",
            topic: block.topic,
            blockRange: [block.startTimestamp, block.endTimestamp],
            conversationRange: [conversationMinTs, conversationMaxTs],
            activeBlocksAfter: state.compressionBlocks.filter((b) => b.active).length,
          });
        }
      }
    }
  }
}

function compressedBlockText(block: CompressionBlock, label: "section" | "message"): string {
  return [
    `[Compressed ${label}: ${block.topic}]`,
    "",
    block.summary,
    "",
    `[dcp-block-id]: # (b${block.id})`,
  ].join("\n");
}

/** Exact estimator cost of the synthetic v2 range replacement, including the
 * DCP wrapper/carrier text that is not part of block.summaryTokenEstimate. */
export function estimateCompressionBlockReplacementTokens(block: CompressionBlock): number {
  return estimateMessageTokens({
    role: "user",
    content: [{ type: "text", text: compressedBlockText(block, "section") }],
    timestamp: block.startTimestamp,
  });
}

function accountCompressionBlock(
  block: CompressionBlock,
  removedTokens: number,
  addedTokens: number,
  state: DcpState,
): void {
  if (state.accountedCompressionBlockIds.has(block.id)) return;
  state.accountedCompressionBlockIds.add(block.id);
  state.totalPruneCount++;
  const rawSaved = Math.max(0, removedTokens - addedTokens);
  const coveredSavings = (block.coveredBlockIds ?? []).reduce(
    (sum, id) => sum + (state.compressionTokenSavings.get(id) ?? 0),
    0,
  );
  state.tokensSaved = Math.max(0, state.tokensSaved + rawSaved - coveredSavings);
  state.compressionTokenSavings.set(block.id, rawSaved);
}

function preserveProjectedStableId(message: any, stableId: string | undefined): void {
  if (!stableId || !message || typeof message !== "object") return;
  Object.defineProperty(message, "_dcpStableId", {
    value: stableId,
    enumerable: false,
    configurable: true,
  });
}

function markProjectedOrigin(message: any, origin: "block" | "dcp-control", blockId?: number): void {
  if (!message || typeof message !== "object") return;
  Object.defineProperty(message, "_dcpOrigin", {
    value: origin,
    enumerable: false,
    configurable: true,
  });
  if (blockId !== undefined) {
    Object.defineProperty(message, "_dcpBlockId", {
      value: blockId,
      enumerable: false,
      configurable: true,
    });
  }
}

function applyExactMessageBodyBlock(messages: any[], block: CompressionBlock, state: DcpState): boolean {
  const span = exactBlockSpan(messages, block);
  if (!span || span.lo !== span.hi) return false;
  const targetIndex = span.lo;
  const target = messages[targetIndex];
  const removedTokens = estimateMessageTokens(target);
  const text = compressedBlockText(block, "section");

  if (typeof target?.content === "string") target.content = text;
  else target.content = [{ type: "text", text }];
  preserveProjectedStableId(target, block.startMessageId);
  markProjectedOrigin(target, "block", block.id);

  const addedTokens = estimateMessageTokens(target);
  accountCompressionBlock(block, removedTokens, addedTokens, state);
  return true;
}

function applyExactRangeBlock(messages: any[], block: CompressionBlock, state: DcpState): boolean {
  const span = exactBlockSpan(messages, block);
  if (!span) return false;
  const { lo, hi } = span;
  let removedTokens = 0;
  for (let i = lo; i <= hi; i++) removedTokens += estimateMessageTokens(messages[i]);

  const syntheticMsg = {
    role: "user",
    content: [{ type: "text", text: compressedBlockText(block, "section") }],
    timestamp: block.startTimestamp,
  };
  markProjectedOrigin(syntheticMsg, "block", block.id);
  messages.splice(lo, hi - lo + 1, syntheticMsg);

  const addedTokens = estimateMessageTokens(syntheticMsg);
  accountCompressionBlock(block, removedTokens, addedTokens, state);
  return true;
}

export function applyCompressionBlocks(messages: any[], state: DcpState): any[] {
  const activeBlocks = state.compressionBlocks
    .filter((b) => b.active)
    .sort((a, b) => a.startTimestamp - b.startTimestamp);
  if (activeBlocks.length === 0) return messages;

  for (const block of activeBlocks) {
    if (!hasExactCompressionMembership(block)) continue;

    if (block.version === 2 && block.replacementMode === "message-body") {
      applyExactMessageBodyBlock(messages, block, state);
      continue;
    }
    if (block.version === 2 && block.replacementMode === "range") {
      applyExactRangeBlock(messages, block, state);
    }
  }

  return messages;
}
