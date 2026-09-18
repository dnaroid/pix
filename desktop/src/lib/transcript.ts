export type {
  ActivityEntry,
  ActivityGroupItem,
  MessageItem,
  MessageRole,
  ThoughtItem,
  ToolItem,
  TranscriptDisplayItem,
  TranscriptItem,
  TranscriptState,
} from "./transcript-types";
export { emptyTranscript } from "./transcript-types";

export {
  appendLocalSystemMessage,
  appendLocalUserMessage,
  bindLocalUserMessageSessionEntry,
  hydrateTranscriptAttachment,
} from "./transcript-local";

export {
  applySessionUpdate,
  applySessionUpdates,
  transcriptFromSessionUpdates,
} from "./transcript-reducer";

export {
  applyDeferredToolResult,
  markDeferredToolResults,
  setToolResultLoading,
} from "./transcript-deferred";

export { finalizeTranscriptActivity } from "./transcript-timing";
export {
  activityGroupDuration,
  activityGroupPresentationLabels,
  formatTranscriptDuration,
  groupTranscriptItems,
} from "./transcript-presentation";
