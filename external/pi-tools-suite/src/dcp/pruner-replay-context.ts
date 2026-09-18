import type { DcpState } from "./state.js";
import { stableMessageKeys } from "./pruner-message-ids.js";

/** Match the SDK provider transform, not UI visibility or tool-result errors. */
export function isReplayableContextMessage(message: any): boolean {
  return !(message?.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted"));
}

/**
 * SDK retry removes failed attempts from live agent state but keeps them in
 * JSONL. Reload restores them; the provider later omits error/aborted assistants.
 * Normalize before exact block replay so those history-only attempts cannot
 * split a range that was committed from the live, post-retry context.
 *
 * Older blocks may explicitly include such an attempt. Keep every referenced
 * occurrence until the existing matcher has checked its exact ID/order/hash;
 * neither membership arrays nor signed message contents are rewritten. Any
 * remaining attempts are omitted after replay, before new IDs/plans are built.
 */
export function prepareDcpReplayMessages(messages: any[], state: DcpState): any[] {
  if (messages.every(isReplayableContextMessage)) return messages;

  const referencedIds = new Set<string>();
  for (const block of state.compressionBlocks) {
    if (!block.active) continue;
    for (const members of [block.mutationMembers, block.sourceMembers]) {
      for (const member of members ?? []) referencedIds.add(member.stableId);
    }
  }
  const keys = stableMessageKeys(messages);
  return messages.filter((message, index) =>
    isReplayableContextMessage(message) || referencedIds.has(keys[index]!),
  );
}
