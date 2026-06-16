import type { DcpState } from "./state.js";
import type { DcpConfig } from "./config.js";
import {
  ID_ELIGIBLE_ROLES,
  PASSTHROUGH_ROLES,
  estimateMessageTokens,
  extractBlockId,
  messageText,
} from "./pruner-metadata.js";

export interface InjectMessageIdsOptions {
  /**
   * When false, rebuild internal mNNN snapshots without appending visible
   * DCP marker lines to provider-visible message content.
   */
  visible?: boolean;
  /** Config enables priority markers for message-mode candidates. */
  config?: DcpConfig;
}

export const DCP_MESSAGE_IDS_CUSTOM_TYPE = "dcp-message-ids";

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

function formatIdTag(id: string, _priority: "low" | "medium" | "high"): string {
  // Keep the provider-visible marker itself short and single-line. Priority is
  // retained in state and emitted in message-compression candidate hints.
  return `\n[dcp-id]: # (${id})`;
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

export function buildMessageIdControlMessage(state: DcpState): any | undefined {
  const ids = [...state.messageIdSnapshot.keys()];
  if (ids.length === 0) return undefined;

  const text = [
    "<dcp-message-ids>",
    "DCP metadata for the preceding conversation messages. These IDs are model-visible but UI-hidden control data.",
    "Use only these current IDs with the compress tool; do not quote or output this metadata.",
    `Current raw message IDs: ${ids.join(", ")}`,
    ...ids.map((id) => controlLineForMessageId(id, state)),
    "</dcp-message-ids>",
  ].join("\n");

  return {
    role: "custom",
    customType: DCP_MESSAGE_IDS_CUSTOM_TYPE,
    display: false,
    content: text,
    timestamp: Date.now(),
    details: { dcpControlPlane: true, messageIds: ids },
  };
}

export function injectMessageIds(
  messages: any[],
  state: DcpState,
  options: InjectMessageIdsOptions = {},
): void {
  const visible = options.visible ?? true;

  // Clear the snapshots and rebuild
  state.messageIdSnapshot.clear();
  state.messageMetaSnapshot.clear();

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
    const idTag = formatIdTag(id, priority);
    const rawStableId = stableMessageId(msg, messageIndex);

    if (!visible) {
      // Snapshot-only mode: keep mNNN mappings fresh for DCP internals, but
      // do not expose synthetic IDs to the agent.
    } else if (role === "user") {
      if (typeof msg.content === "string") {
        msg.content = msg.content + `\n${idTag}`;
      } else if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: idTag }];
      }
    } else if (role === "toolResult" || role === "bashExecution") {
      if (Array.isArray(msg.content)) {
        msg.content = [...msg.content, { type: "text", text: idTag }];
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + idTag;
      }
    } else if (role === "assistant") {
      if (Array.isArray(msg.content)) {
        // Insert the ID tag before any tool_use (toolCall) blocks.
        // Anthropic requires: thinking → text → tool_use.
        // Appending after tool_use blocks violates that constraint.
        const firstToolCallIdx = msg.content.findIndex(
          (b: any) => b.type === "toolCall",
        );
        const idBlock = { type: "text", text: idTag };
        if (firstToolCallIdx === -1) {
          // No tool_use blocks — append as usual
          msg.content = [...msg.content, idBlock];
        } else {
          // Insert immediately before the first tool_use block
          msg.content = [
            ...msg.content.slice(0, firstToolCallIdx),
            idBlock,
            ...msg.content.slice(firstToolCallIdx),
          ];
        }
      } else if (typeof msg.content === "string") {
        msg.content = msg.content + idTag;
      }
    }

    if (msg.timestamp !== undefined) {
      state.messageIdSnapshot.set(id, msg.timestamp);
      state.messageMetaSnapshot.set(id, {
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
}
