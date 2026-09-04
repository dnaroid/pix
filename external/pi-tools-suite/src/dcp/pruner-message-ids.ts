import { createHash } from "node:crypto";
import type { DcpState, MessageIdMeta } from "./state.js";
import type { DcpConfig } from "./config.js";
import {
  ID_ELIGIBLE_ROLES,
  PASSTHROUGH_ROLES,
  estimateMessageTokens,
  extractBlockId,
  messageText,
  stripStaleDcpMetadataLines,
} from "./pruner-metadata.js";

export interface InjectMessageIdsOptions {
  /** Config enables priority markers for message-mode candidates. */
  config?: DcpConfig;
}

const ID_CARRIER_ROLES = new Set(["user", "toolResult", "bashExecution"]);

function canonicalContentForStableId(msg: any): unknown {
  if (!Array.isArray(msg?.content)) {
    if (msg?.role === "assistant") return msg?.content ?? "";
    return stripStaleDcpMetadataLines(typeof msg?.content === "string" ? msg.content : "");
  }

  if (msg?.role === "assistant") return msg.content;

  return msg.content.flatMap((block: any) => {
    if (!block || typeof block !== "object") return [block];
    if (typeof block.text === "string") {
      const text = stripStaleDcpMetadataLines(block.text);
      return text.length > 0 ? [{ ...block, text }] : [];
    }
    if (typeof block.thinking === "string") {
      const thinking = stripStaleDcpMetadataLines(block.thinking);
      return thinking.length > 0 ? [{ ...block, thinking }] : [];
    }
    return [block];
  });
}

function fallbackContentFingerprint(msg: any): string {
  return createHash("sha256")
    .update(String(msg?.role ?? ""))
    .update("\u0000")
    .update(JSON.stringify(canonicalContentForStableId(msg)))
    .digest("hex")
    .slice(0, 20);
}

export function stableMessageId(msg: any, fallbackIndex = 0): string {
  const candidates = [
    msg?.id,
    msg?.entryId,
    msg?.messageId,
    msg?._dcpEntryId,
    msg?.metadata?.id,
    msg?.metadata?.entryId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return `id:${candidate.trim()}`;
    }
  }

  if (typeof msg?.toolCallId === "string" && msg.toolCallId.trim().length > 0) {
    return `tool:${msg.toolCallId.trim()}`;
  }

  const blockId = extractBlockId(messageText(msg));
  if (blockId !== undefined) return `block:${blockId}`;
  if (Number.isFinite(msg?.timestamp)) {
    return `ts:${msg.timestamp}:${fallbackContentFingerprint(msg)}`;
  }
  return `idx:${fallbackIndex}`;
}

/**
 * Return deterministic per-occurrence identities for a message sequence.
 * Session entry IDs and content-fingerprinted fallbacks are normally unique;
 * the suffix keeps byte-identical legacy messages from sharing one mNNN ID.
 */
export function stableMessageKeys(messages: any[]): string[] {
  const occurrences = new Map<string, number>();
  return messages.map((message, index) => {
    const base = stableMessageId(message, index);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return occurrence === 1 ? base : `${base}#${occurrence}`;
  });
}

function priorityForMessage(tokenEstimate: number, config: DcpConfig | undefined): "low" | "medium" | "high" {
  const settings = config?.compress?.messageMode;
  const mediumTokens = Math.max(1, settings?.mediumTokens ?? 500);
  const highTokens = Math.max(mediumTokens, settings?.highTokens ?? 5000);

  if (tokenEstimate >= highTokens) return "high";
  if (tokenEstimate >= mediumTokens) return "medium";
  return "low";
}

function persistentMessageId(stableKey: string, state: DcpState): string {
  const existing = state.messageIdsByStableId.get(stableKey);
  if (existing) return existing;

  const id = `m${String(state.nextMessageId++).padStart(3, "0")}`;
  state.messageIdsByStableId.set(stableKey, id);
  return id;
}

function carrierSelfLabel(role: string): string {
  if (role === "toolResult") return "this tool result";
  if (role === "bashExecution") return "this bash result";
  return "this user message";
}

function buildCarrierControlText(
  precedingAssistantIds: string[],
  ownId: string,
  ownRole: string,
  blockId: number | undefined,
): string {
  const assignments = [
    ...precedingAssistantIds.map((id) => `${id}=preceding assistant message`),
    `${ownId}=${carrierSelfLabel(ownRole)}`,
  ];
  return [
    "<dcp-message-ids>",
    `Stable DCP IDs (use with compress; do not quote/output): ${assignments.join("; ")}`,
    ...(blockId === undefined ? [] : [`Active compressed block alias: b${blockId}`]),
    "</dcp-message-ids>",
  ].join("\n");
}

function appendControlToCarrier(message: any, controlText: string): void {
  const suffix = `\n\n${controlText}`;
  if (typeof message.content === "string") {
    message.content += suffix;
    return;
  }
  if (Array.isArray(message.content)) {
    message.content = [...message.content, { type: "text", text: suffix }];
    return;
  }
  message.content = [{ type: "text", text: controlText }];
}

/**
 * Build the current addressability snapshot and distribute immutable ID
 * metadata over append-only user/tool-result carriers. Assistant messages are
 * never modified: provider-signed reasoning and function-call items must replay
 * byte-for-byte for Responses continuation.
 */
export function injectMessageIds(
  messages: any[],
  state: DcpState,
  options: InjectMessageIdsOptions = {},
): void {
  const nextIdSnapshot = new Map<string, number>();
  const nextMetaSnapshot = new Map<string, MessageIdMeta>();
  const stableKeys = stableMessageKeys(messages);
  const assignedIds = new Map<number, string>();
  const assignedMeta = new Map<number, MessageIdMeta>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    const role: string = msg?.role ?? "";
    if (PASSTHROUGH_ROLES.has(role) || !ID_ELIGIBLE_ROLES.has(role)) continue;
    if (!Number.isFinite(msg?.timestamp)) continue;

    const stableKey = stableKeys[messageIndex]!;
    const id = persistentMessageId(stableKey, state);
    const originalText = messageText(msg);
    const blockId = extractBlockId(originalText);
    const tokenEstimate = estimateMessageTokens(msg);

    assignedIds.set(messageIndex, id);
    assignedMeta.set(messageIndex, {
      timestamp: msg.timestamp,
      stableId: stableKey,
      role,
      blockId,
      toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
      toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
      text: originalText,
      tokenEstimate,
      priority: priorityForMessage(tokenEstimate, options.config),
    });
  }

  const publish = (messageIndex: number): void => {
    const id = assignedIds.get(messageIndex);
    const meta = assignedMeta.get(messageIndex);
    if (!id || !meta) return;
    nextIdSnapshot.set(id, meta.timestamp);
    nextMetaSnapshot.set(id, meta);
  };
  const pendingAssistantIndexes: number[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    const role: string = message?.role ?? "";
    const id = assignedIds.get(messageIndex);
    if (!id) continue;

    if (role === "assistant") {
      pendingAssistantIndexes.push(messageIndex);
      continue;
    }
    if (!ID_CARRIER_ROLES.has(role)) continue;

    for (const pendingIndex of pendingAssistantIndexes) publish(pendingIndex);
    publish(messageIndex);
    const pendingAssistantIds = pendingAssistantIndexes
      .map((pendingIndex) => assignedIds.get(pendingIndex))
      .filter((pendingId): pendingId is string => pendingId !== undefined);
    const blockId = assignedMeta.get(messageIndex)?.blockId;
    appendControlToCarrier(
      message,
      buildCarrierControlText(pendingAssistantIds, id, role, blockId),
    );
    pendingAssistantIndexes.length = 0;
  }

  state.messageIdSnapshot = nextIdSnapshot;
  state.messageMetaSnapshot = nextMetaSnapshot;
}
