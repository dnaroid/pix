import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import { applyCompressionBlocks, repairOrphanedToolPairs, syncCompressionBlocks } from "./pruner-compression-blocks.js";
import { stripStaleDcpMetadataFromAssistantMessage } from "./pruner-metadata.js";
import { injectMessageIds } from "./pruner-message-ids.js";
import {
  applyAutoToolOutputPruning,
  applyDeduplication,
  applyErrorPurging,
  applyToolOutputPruning,
} from "./pruner-tools.js";

export type {
  CompressionCandidate,
  MessageCompressionCandidate,
  MessagePriority,
  NudgeThresholds,
} from "./pruner-types.js";
export {
  estimateTokens,
  getActiveSummaryTokenEstimate,
  resolveContextThresholds,
} from "./pruner-metadata.js";
export {
  isToolRecordProtected,
  markToolPruned,
} from "./pruner-tools.js";
export {
  detectCompressionCandidate,
  detectMessageCompressionCandidates,
  formatCompressionCandidateHint,
  formatMessageCompressionCandidateHint,
} from "./pruner-candidates.js";
export {
  appendConcreteNudgeGuidance,
  applyAnchoredNudges,
  clearDcpNudgeAnchors,
  getNudgeType,
  injectNudge,
  nudgeTypeLabel,
  upsertNudgeAnchor,
} from "./pruner-nudge.js";

export function applyPruning(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
): any[] {
  // Deep-clone each message and its content to prevent mutations from
  // affecting the original objects across context events.
  const msgs: any[] = messages.map((m: any) => {
    const clone = { ...m };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((contentBlock: any) =>
        typeof contentBlock === "object" && contentBlock !== null ? { ...contentBlock } : contentBlock,
      );
    }
    return stripStaleDcpMetadataFromAssistantMessage(clone);
  });

  // 1. Count user turns → update state.currentTurn. Do this before inserting
  // synthetic compression summaries; the raw session is the source of truth.
  state.currentTurn = msgs.filter((m) => m.role === "user").length;

  // 2. Reconcile persisted compression blocks with the current raw context,
  // then apply active compression blocks.
  syncCompressionBlocks(msgs, state);
  applyCompressionBlocks(msgs, state);

  // 2b. Post-compression safety net: remove any orphaned tool pairs that the
  // expansion logic could not catch (e.g. multi-block interactions, pre-broken state).
  repairOrphanedToolPairs(msgs);

  // 3. Apply deduplication
  applyDeduplication(msgs, state, config);

  // 4. Apply error purging
  applyErrorPurging(msgs, state, config);

  // 5. Apply autonomous policy pruning for old/large/stale tool outputs
  applyAutoToolOutputPruning(msgs, state, config);

  // 6. Apply explicit tool output pruning (prunedToolIds)
  applyToolOutputPruning(msgs, state);

  // 7. Refresh visible message ID snapshots used by the compress tool.
  injectMessageIds(msgs, state, { config });

  // 8. state.messageIdSnapshot/messageMetaSnapshot are already updated by injectMessageIds

  return msgs;
}
