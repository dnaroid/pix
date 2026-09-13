import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentControlState } from "./agent-control";
import type { SessionStateNotification } from "./session-state";

export interface AcpExit {
  readonly generation: number;
  readonly code: number | null;
  readonly success: boolean;
  readonly requested: boolean;
  readonly error: string | null;
}

export interface AcpTransportHandlers {
  readonly onLine: (line: string) => void;
  readonly onStderr: (line: string) => void;
  readonly onExit: (exit: AcpExit) => void;
}

export interface AcpTransport {
  start(handlers: AcpTransportHandlers): Promise<void>;
  send(line: string): Promise<void>;
  stop(): Promise<void>;
}

export interface AcpClientHandlers {
  readonly onSessionUpdate: (notification: SessionNotification) => void;
  readonly onSessionState?: (notification: SessionStateNotification) => void;
  readonly onQueueState?: (state: QueueState) => void;
  readonly onQueueConsumed?: (sessionId: string, message: QueuedUserMessage) => void;
  readonly onElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  readonly onDiagnostic?: (message: string) => void;
  readonly onExit?: (exit: AcpExit) => void;
}

export interface AutocompleteSettings {
  readonly enabled: boolean;
  readonly debounceMs: number;
}

export interface ForkMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface ForkSessionResult {
  readonly sessionId: string;
  readonly configOptions: SessionConfigOption[];
  readonly selectedText?: string;
}

export interface DraftSessionConfig {
  readonly modelRef: string;
  readonly thinkingLevel: string;
}

export type UserMessageAction = "copy" | "undo";

export interface UserMessageActionResult {
  readonly status: "ok" | "warning" | "cancelled";
  readonly editorText?: string;
  readonly revertedChanges?: number;
  readonly changedFiles?: number;
  readonly warning?: string;
}

export interface LazySessionImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptFileImage {
  readonly uri: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly name?: string;
}

export type QueueSource = "sdk-steering" | "sdk-follow-up" | "auto" | "deferred";
export type QueueAction = "cancel" | "edit" | "send-now";

export interface QueuedImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface QueuedUserMessage {
  readonly id: string;
  readonly promptText: string;
  readonly displayText: string;
  readonly images: readonly QueuedImage[];
}

export interface QueueItem {
  readonly id: string;
  readonly source: QueueSource;
  readonly mode: "steering" | "follow-up";
  readonly index: number;
  readonly text: string;
  readonly message?: QueuedUserMessage;
}

export interface QueueState {
  readonly sessionId: string;
  readonly items: QueueItem[];
}

export interface LazySessionHistory {
  readonly updates: readonly SessionUpdate[];
  readonly deferredToolCallIds: readonly string[];
}

export interface AgentControlStatus {
  readonly sessionId: string;
  readonly state: AgentControlState;
}

export interface ContextUsageStatus {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export interface ModelUsageLimitWindow {
  readonly remainingPercent: number;
  readonly resetAt: number;
  readonly windowSeconds: number;
  readonly hasKnownWindowDuration?: boolean;
}

export interface ModelUsageStatus {
  readonly modelKey: string;
  readonly provider: "openai" | "zhipu" | "google-antigravity";
  readonly updatedAt: number;
  readonly accountEmail?: string;
  readonly hourly?: ModelUsageLimitWindow;
  readonly weekly?: ModelUsageLimitWindow;
}

export type ModelUsageRefresh = "skipped" | "ready" | "unavailable" | "failed";

export interface RuntimeStatus {
  readonly sessionId: string;
  readonly context?: ContextUsageStatus;
  readonly dcpStats?: string;
  readonly modelUsageRefresh: ModelUsageRefresh;
  readonly modelUsage?: ModelUsageStatus;
}

export interface DcpStatsStatus {
  readonly sessionId: string;
  readonly dcpStats?: string;
}
