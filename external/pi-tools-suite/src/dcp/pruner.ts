import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import { applyCompressionBlocks, repairOrphanedToolPairs, syncCompressionBlocks } from "./pruner-compression-blocks.js";
import { stripStaleDcpMetadataFromMessage } from "./pruner-metadata.js";
import { injectMessageIds } from "./pruner-message-ids.js";
import {
  applyAutoToolOutputPruning,
  applyDeduplication,
  applyErrorPurging,
  applyToolOutputPruning,
} from "./pruner-tools.js";

export type {
  CompressionCandidate,
  EmergencyCurrentTurnSelection,
  EmergencyCurrentTurnStats,
  MessageCompressionCandidate,
  MessagePriority,
  NudgeThresholds,
} from "./pruner-types.js";
export {
  analyzeEmergencyCurrentTurn,
  emergencyPressureState,
  emergencyCurrentTurnMessageCandidates,
  pruneEmergencyCurrentTurn,
} from "./pruner-emergency.js";
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
  detectEmergencyCompressionCandidate,
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
    return stripStaleDcpMetadataFromMessage(clone);
  });

  // 1. Count user turns → update state.currentTurn. Do this before inserting
  // synthetic compression summaries; the raw session is the source of truth.
  state.currentTurn = msgs.filter((m) => m.role === "user").length;

  // 2. Reconcile persisted compression blocks with the current raw context,
  // then apply active compression blocks.
  syncCompressionBlocks(msgs, state, config);
  applyCompressionBlocks(msgs, state);

  // 2b. Post-compression safety net: remove any orphaned tool pairs that the
  // expansion logic could not catch (e.g. multi-block interactions, pre-broken state).
  repairOrphanedToolPairs(msgs);

  // 3-5. Discover new automatic pruning decisions only at stable checkpoints.
  // Rewriting an old result after every same-turn duplicate breaks provider
  // continuation repeatedly. A new user turn or compression block already
  // establishes a natural history boundary where one prefix rebuild is
  // acceptable. Branches that move the turn count backwards also reopen the
  // checkpoint instead of suppressing pruning indefinitely.
  const newestBlockId = Math.max(0, state.nextBlockId - 1);
  const automaticPruneCheckpoint =
    state.currentTurn !== state.lastAutomaticPruneTurn ||
    newestBlockId !== state.lastAutomaticPruneBlockId;
  if (automaticPruneCheckpoint) {
    applyDeduplication(msgs, state, config);
    applyErrorPurging(msgs, state, config);
    applyAutoToolOutputPruning(msgs, state, config);
    state.lastAutomaticPruneTurn = state.currentTurn;
    state.lastAutomaticPruneBlockId = newestBlockId;
  }

  // 6. Apply explicit tool output pruning (prunedToolIds)
  applyToolOutputPruning(msgs, state);

  // 7. Refresh message ID snapshots and append stable distributed metadata to
  // user/tool-result carriers. Assistant items remain byte-stable.
  injectMessageIds(msgs, state, { config });

  // 8. state.messageIdSnapshot/messageMetaSnapshot are already updated by injectMessageIds

  return msgs;
}
