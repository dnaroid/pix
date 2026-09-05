import { canonicalMessageHash } from "../../src/dcp/conversation-index.js";
import type { DcpState } from "../../src/dcp/state.js";

/**
 * Older accounting/tool-contract tests seeded only timestamps and metadata.
 * Supply explicit canonical fixture entries too, as real context() now does.
 * This does not change production behavior. Projection tests must pass their
 * actual raw objects (rather than inventing hashes from timestamps).
 */
export function seedCanonicalFixture(state: DcpState, rawMessages?: any[]): void {
  if (state.conversationIndexSnapshot.length) return;
  const entries: any[] = [];
  for (const [visibleId, meta] of state.messageMetaSnapshot) {
    const raw = rawMessages?.find((message) =>
      meta.stableId === `id:${message.id}` || (!meta.stableId && message.timestamp === meta.timestamp),
    );
    const stableId = meta.stableId ?? `fixture:${visibleId}`;
    meta.stableId = stableId;
    state.messageIdsByStableId.set(stableId, visibleId);
    const message = raw ?? {
      role: meta.role,
      timestamp: meta.timestamp,
      content: [{ type: "text", text: meta.text ?? "fixture content" }],
      ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    };
    entries.push({
      index: 0, stableId, visibleId, role: meta.role, timestamp: meta.timestamp,
      blockId: meta.blockId, toolCallId: meta.toolCallId, toolCallIds: meta.toolCallIds,
      passthrough: false, origin: meta.blockId === undefined ? "raw" : "block",
      signedAssistant: false, contentHash: canonicalMessageHash(message),
    });
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
    if (!entries.some((entry) => entry.blockId === block.id)) entries.push({
      index: 0, stableId: `block:${block.id}`, role: "user", timestamp: block.startTimestamp,
      blockId: block.id, passthrough: false, origin: "block", signedAssistant: false,
      contentHash: canonicalMessageHash({ role: "user", content: block.summary }),
    });
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);
  state.conversationIndexSnapshot = entries.map((entry, index) => ({ ...entry, index }));
}
