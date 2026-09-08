import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import { applyCompressionBlocks, syncCompressionBlocks } from "./pruner-compression-blocks.js";
import { stripStaleDcpMetadataFromMessage } from "./pruner-metadata.js";
import { injectMessageIds } from "./pruner-message-ids.js";
import { copyRawMutationHash } from "./conversation-index.js";
import { applyToolOutputPruning } from "./pruner-tools.js";

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
  hasCacheSafeNudgeCarrier,
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
    const stripped = stripStaleDcpMetadataFromMessage(clone);
    for (const key of ["_dcpOrigin", "_dcpBlockId", "_dcpStableId"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(m, key);
      if (descriptor) Object.defineProperty(stripped, key, descriptor);
    }
    copyRawMutationHash(m, stripped);
    return stripped;
  });

  // 1. Count user turns → update state.currentTurn. Do this before inserting
  // synthetic compression summaries; the raw session is the source of truth.
  state.currentTurn = msgs.filter((m) => m.role === "user").length;

  // 2. Reconcile persisted compression blocks with the current raw context,
  // then apply active compression blocks.
  syncCompressionBlocks(msgs, state, config);
  applyCompressionBlocks(msgs, state);

  // Existing explicit/emergency pruning decisions are replayed, but routine
  // context construction never discovers new retroactive deletions. A new user
  // turn must remain append-only for provider prefix caching; destructive
  // rewrites happen only through an explicit compress/sweep boundary or the
  // bounded emergency path.
  applyToolOutputPruning(msgs, state);

  // Refresh message ID snapshots and append stable distributed metadata to
  // user/tool-result carriers. Assistant items remain byte-stable.
  injectMessageIds(msgs, state, { config });

  // 8. state.messageIdSnapshot/messageMetaSnapshot are already updated by injectMessageIds

  return msgs;
}
