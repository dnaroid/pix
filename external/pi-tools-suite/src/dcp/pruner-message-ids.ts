import type { DcpState, MessageIdMeta } from "./state.js";
import type { DcpConfig } from "./config.js";
import {
  ID_ELIGIBLE_ROLES,
  PASSTHROUGH_ROLES,
  estimateMessageTokens,
  extractBlockId,
  messageText,
} from "./pruner-metadata.js";

export interface InjectMessageIdsOptions {
  /** Config enables priority markers for message-mode candidates. */
  config?: DcpConfig;
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

  if (Number.isFinite(msg?.timestamp)) return `ts:${msg.timestamp}`;
  return `idx:${fallbackIndex}`;
}

function priorityForMessage(tokenEstimate: number, config: DcpConfig | undefined): "low" | "medium" | "high" {
  const settings = config?.compress?.messageMode;
  const mediumTokens = Math.max(1, settings?.mediumTokens ?? 500);
  const highTokens = Math.max(mediumTokens, settings?.highTokens ?? 5000);

  if (tokenEstimate >= highTokens) return "high";
  if (tokenEstimate >= mediumTokens) return "medium";
  return "low";
}

function controlLineForMessageId(id: string, state: DcpState): string {
  const meta = state.messageMetaSnapshot.get(id);
  if (!meta) return `- ${id}`;

  const details: string[] = [meta.role];
  if (meta.blockId !== undefined) details.push(`block=b${meta.blockId}`);
  if (meta.toolName) details.push(`tool=${meta.toolName}`);
  if (meta.priority) details.push(`priority=${meta.priority}`);
  return `- ${id}: ${details.join(", ")}`;
}

export function buildMessageIdControlText(state: DcpState): string | undefined {
  const ids = [...state.messageIdSnapshot.keys()];
  if (ids.length === 0) return undefined;

  return [
    "<dcp-message-ids>",
    "DCP metadata for the preceding conversation messages. These IDs are model-visible but UI-hidden control data.",
    "Use only these current IDs with the compress tool; do not quote or output this metadata.",
    `Current raw message IDs: ${ids.join(", ")}`,
    ...ids.map((id) => controlLineForMessageId(id, state)),
    "</dcp-message-ids>",
  ].join("\n");
}

export function injectMessageIds(
  messages: any[],
  state: DcpState,
  options: InjectMessageIdsOptions = {},
): void {
  // Rebuild into local maps and assign once at the end, so readers (compress
  // tool, candidates, provider payload builder) never observe a transiently
  // empty snapshot mid-rebuild. The previous clear()-then-set loop exposed a
  // window where any concurrent reader saw `messageIdSnapshot` as empty,
  // which surfaced to the model as `Current raw message IDs: none`.
  const nextIdSnapshot = new Map<string, number>()
  const nextMetaSnapshot = new Map<string, MessageIdMeta>()

  let counter = 1;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    const role: string = msg.role ?? "";

    // Skip PI-internal passthrough messages
    if (PASSTHROUGH_ROLES.has(role)) continue;
    // Skip non-eligible roles
    if (!ID_ELIGIBLE_ROLES.has(role)) continue;

    const id = "m" + String(counter).padStart(3, "0");
    counter++;

    const originalText = messageText(msg);
    const blockId = extractBlockId(originalText);
    const tokenEstimate = estimateMessageTokens(msg);
    const priority = priorityForMessage(tokenEstimate, options.config);
    const rawStableId = stableMessageId(msg, messageIndex);

    if (msg.timestamp !== undefined) {
      nextIdSnapshot.set(id, msg.timestamp);
      nextMetaSnapshot.set(id, {
        timestamp: msg.timestamp,
        stableId: rawStableId,
        role,
        blockId,
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : undefined,
        toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
        text: originalText,
        tokenEstimate,
        priority,
      });
    }
  }

  state.messageIdSnapshot = nextIdSnapshot
  state.messageMetaSnapshot = nextMetaSnapshot
}
