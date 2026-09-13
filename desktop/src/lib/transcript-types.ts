import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type { Attachment } from "./attachments";
import type { ToolDiff } from "./diff";

export type MessageRole = "user" | "assistant" | "thought" | "system";

export interface MessageItem {
  readonly type: "message";
  readonly id: string;
  readonly messageId?: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly sessionEntryId?: string;
  /** Renderer-only user row that has no corresponding Pi session entry. */
  readonly localOnly?: boolean;
}

export interface ToolItem {
  readonly type: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly name?: string;
  readonly title: string;
  readonly kind: string;
  readonly status: ToolCallStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content: string;
  readonly diffs: readonly ToolDiff[];
  readonly attachments: readonly Attachment[];
  readonly path?: string;
  readonly deferredResult?: boolean;
  readonly resultLoading?: boolean;
  readonly resultError?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

export type TranscriptItem = MessageItem | ToolItem;

export interface ToolGroupItem {
  readonly type: "tool-group";
  readonly id: string;
  readonly tools: readonly [ToolItem, ...ToolItem[]];
  readonly status: ToolCallStatus;
  readonly active: boolean;
  readonly durationMs?: number;
}

export type TranscriptDisplayItem = MessageItem | ToolGroupItem;

export interface TranscriptState {
  readonly items: readonly TranscriptItem[];
}

export const emptyTranscript: TranscriptState = { items: [] };
