import { canonicalMessageHash } from "../../src/dcp/conversation-index.js";
import { recordCompressionProjection } from "../../src/dcp/compression-preview.js";
import type { DcpState } from "../../src/dcp/state.js";

/**
 * Older accounting/tool-contract tests seeded only timestamps and metadata.
 * Supply explicit canonical fixture entries too, as real context() now does.
 * This does not change production behavior. Projection tests must pass their
 * actual raw objects (rather than inventing hashes from timestamps).
 */
export function seedCanonicalFixture(state: DcpState, rawMessages?: any[]): void {
  if (state.conversationIndexSnapshot.length) return;
  const rows: Array<{ entry: any; message: any }> = [];
  for (const [visibleId, meta] of state.messageMetaSnapshot) {
    const raw = rawMessages?.find((message) =>
      meta.stableId === `id:${message.id}` || (!meta.stableId && message.timestamp === meta.timestamp),
    );
    const stableId = meta.stableId ?? `fixture:${visibleId}`;
    meta.stableId = stableId;
    state.messageIdsByStableId.set(stableId, visibleId);
    const ordinal = Number.parseInt(visibleId.replace(/^m/, ""), 10);
    if (Number.isFinite(ordinal)) state.nextMessageId = Math.max(state.nextMessageId, ordinal + 1);
    const text = meta.text ?? "fixture content";
    const targetLength = Math.max(text.length, Math.max(1, Math.round(meta.tokenEstimate ?? 1)) * 4);
    const message = raw ?? {
      role: meta.role,
      timestamp: meta.timestamp,
      content: [{ type: "text", text: text.padEnd(targetLength, "x") }],
      ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    };
    Object.defineProperty(message, "_dcpStableId", { value: stableId, enumerable: false, configurable: true });
    if (meta.blockId !== undefined) {
      Object.defineProperty(message, "_dcpOrigin", { value: "block", enumerable: false, configurable: true });
      Object.defineProperty(message, "_dcpBlockId", { value: meta.blockId, enumerable: false, configurable: true });
    }
    rows.push({ message, entry: {
      index: 0, stableId, visibleId, role: meta.role, timestamp: meta.timestamp,
      blockId: meta.blockId, toolCallId: meta.toolCallId, toolCallIds: meta.toolCallIds,
      passthrough: false, origin: meta.blockId === undefined ? "raw" : "block",
      signedAssistant: false, contentHash: canonicalMessageHash(message),
    } });
  }
  for (const block of state.compressionBlocks.filter((block) => block.active)) {
    if (!block.sourceMembers || !block.mutationMembers) {
      block.startMessageId ??= `fixture:b${block.id}:start`;
      block.endMessageId ??= `fixture:b${block.id}:end`;
      const members = [...new Set([block.startMessageId, block.endMessageId])].map((stableId) => ({
        stableId, hash: canonicalMessageHash({ role: "assistant", content: block.summary }),
      }));
      block.sourceMembers = members.map((member) => ({ ...member }));
      block.mutationMembers = members;
    }
    if (rows.some((row) => row.entry.blockId === block.id)) continue;
    const message = {
      role: "user",
      content: [{ type: "text", text: `[Compressed section: ${block.topic}]\n\n${block.summary}\n\n[dcp-block-id]: # (b${block.id})` }],
      timestamp: block.startTimestamp,
    };
    Object.defineProperty(message, "_dcpOrigin", { value: "block", enumerable: false, configurable: true });
    Object.defineProperty(message, "_dcpBlockId", { value: block.id, enumerable: false, configurable: true });
    rows.push({ message, entry: {
      index: 0, stableId: `block:${block.id}`, role: "user", timestamp: block.startTimestamp,
      blockId: block.id, passthrough: false, origin: "block", signedAssistant: false,
      contentHash: canonicalMessageHash(message),
    } });
  }
  rows.sort((left, right) => left.entry.timestamp - right.entry.timestamp);
  state.conversationIndexSnapshot = rows.map((row, index) => ({ ...row.entry, index }));
  // Preserve these older tests' explicit published aliases. Unlike a production
  // context they do not have a trailing carrier for every assistant. The source
  // is nevertheless concrete: preview checks its hashes and counts actual bytes,
  // conservatively including regenerated carrier costs in the replacement.
  recordCompressionProjection(state.conversationIndexSnapshot, rows.map((row) => row.message));
}
