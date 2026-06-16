import { matchingModelEntries, type DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import type { NudgeThresholds } from "./pruner-types.js";
import { createRequire } from "node:module";

// Roles that get message IDs injected
export const ID_ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"]);

// Roles that are PI-internal and should pass through unchanged
export const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"]);
const DCP_ID_TAG_MATCH_RE = /<dcp-id(?:>|=)(m\d+)<\/dcp-id>/gi;
const DCP_BLOCK_ID_TAG_MATCH_RE = /<dcp-block-id(?:>|=)b(\d+)<\/dcp-block-id>/gi;
const DCP_ID_MARKDOWN_REF_MATCH_RE = /^\s*\[dcp-id\]:\s*#\s*\((m\d+)(?:\s+priority=(low|medium|high))?\)(?:\s+priority=(low|medium|high))?\s*$/gim;
const DCP_BLOCK_ID_MARKDOWN_REF_MATCH_RE = /^\s*\[dcp-block-id\]:\s*#\s*\(b(\d+)\)\s*$/gim;
const DCP_ID_METADATA_LINE_RE = /^\s*<dcp-id(?:>|=)m\d+(?:<\/dcp-id>|\s+dcp-id>)\s*$/i;
const DCP_BLOCK_ID_METADATA_LINE_RE = /^\s*<dcp-block-id(?:>|=)b\d+(?:<\/dcp-block-id>|\s+dcp-block-id>)\s*$/i;
const DCP_ID_MARKDOWN_REF_LINE_RE = /^\s*\[dcp-id\]:\s*#\s*\(m\d+(?:\s+priority=(?:low|medium|high))?\)(?:\s+priority=(?:low|medium|high))?\s*$/i;
const DCP_BLOCK_ID_MARKDOWN_REF_LINE_RE = /^\s*\[dcp-block-id\]:\s*#\s*\(b\d+\)\s*$/i;
const DCP_MARKDOWN_REF_FRAGMENT_LINE_RE = /^\s*\[dcp[^\n]*$/i;
const DCP_MESSAGE_IDS_START_LINE_RE = /^\s*<dcp-message-ids>/i;
const DCP_MESSAGE_IDS_END_LINE_RE = /<\/dcp-message-ids>\s*$/i;
const DCP_SYSTEM_REMINDER_START_LINE_RE = /^\s*<dcp-system-reminder>/i;
const DCP_SYSTEM_REMINDER_END_LINE_RE = /(?:<\/dcp-system-reminder>|(?<!<)dcp-system-reminder>)\s*$/i;
const MARKDOWN_FENCE_LINE_RE = /^\s*(```|~~~)/;

type TokenCounter = ((text: string) => number) | undefined;

let optionalTokenCounter: TokenCounter | null = null;

function loadOptionalTokenCounter(): TokenCounter {
  if (optionalTokenCounter !== null) return optionalTokenCounter;

  try {
    const require = createRequire(import.meta.url);
    const tokenizer = require("@anthropic-ai/tokenizer") as {
      countTokens?: unknown;
      default?: { countTokens?: unknown };
    };
    const counter = tokenizer.countTokens ?? tokenizer.default?.countTokens;
    optionalTokenCounter = typeof counter === "function"
      ? (counter as (text: string) => number)
      : undefined;
  } catch {
    optionalTokenCounter = undefined;
  }

  return optionalTokenCounter;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const counter = loadOptionalTokenCounter();
  if (counter) {
    try {
      const counted = counter(text);
      if (Number.isFinite(counted)) return Math.max(0, Math.round(counted));
    } catch {
      // Fall through to the cheap heuristic if the optional tokenizer fails for
      // a particular input or runtime.
    }
  }
  return Math.round(text.length / 4);
}

/**
 * Estimate tokens from a message's content, whatever shape it takes.
 */
export function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;
  const content = msg.content;
  if (!content) return 0;
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        if (typeof part.text === "string") total += estimateTokens(part.text);
        else if (typeof part.thinking === "string") total += estimateTokens(part.thinking);
        else if (part.type === "image") total += 500; // rough estimate for images
      }
    }
    return total;
  }
  return 0;
}

export function messageText(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((part: any) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.thinking === "string") return part.thinking;
      return "";
    })
    .join("\n");
}

export function getActiveSummaryTokenEstimate(state: DcpState): number {
  return state.compressionBlocks
    .filter((block) => block.active)
    .reduce((sum, block) => sum + Math.max(0, block.summaryTokenEstimate ?? 0), 0);
}

export function resolveContextThresholds(
  config: DcpConfig,
  modelKeys: Array<string | undefined> = [],
  contextWindow?: number,
): Required<NudgeThresholds> {
  const resolveThresholdValue = (value: number | string | undefined): number | undefined => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.endsWith("%")) {
        const percent = Number.parseFloat(trimmed.slice(0, -1));
        return Number.isFinite(percent) ? percent / 100 : undefined;
      }
      const parsed = Number.parseFloat(trimmed);
      if (!Number.isFinite(parsed)) return undefined;
      value = parsed;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    if (value <= 1) return value;
    if (contextWindow && Number.isFinite(contextWindow) && contextWindow > 0) {
      return value / contextWindow;
    }
    return undefined;
  };

  const resolveOverride = (map: Record<string, number | string> | undefined): number | undefined => {
    let resolved: number | undefined;
    for (const [, rawValue] of matchingModelEntries(map, modelKeys)) {
      const value = resolveThresholdValue(rawValue);
      if (value !== undefined) resolved = value;
    }
    return resolved;
  };

  const min =
    resolveOverride(config.compress.modelMinContextLimits) ??
    resolveOverride(config.compress.modelMinContextPercent);
  const max =
    resolveOverride(config.compress.modelMaxContextLimits) ??
    resolveOverride(config.compress.modelMaxContextPercent);

  return {
    minContextPercent: min ??
      resolveThresholdValue(config.compress.minContextLimit) ??
      resolveThresholdValue(config.compress.minContextPercent) ??
      0.25,
    maxContextPercent: max ??
      resolveThresholdValue(config.compress.maxContextLimit) ??
      resolveThresholdValue(config.compress.maxContextPercent) ??
      0.65,
  };
}

function lastRegexMatch(text: string, regex: RegExp): RegExpExecArray | undefined {
  regex.lastIndex = 0;
  let last: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    last = match;
  }
  regex.lastIndex = 0;
  return last;
}

export function extractBlockId(text: string): number | undefined {
  const match =
    lastRegexMatch(text, DCP_BLOCK_ID_MARKDOWN_REF_MATCH_RE) ??
    lastRegexMatch(text, DCP_BLOCK_ID_TAG_MATCH_RE);
  return match ? parseInt(match[1]!, 10) : undefined;
}

export function extractMessageId(text: string): string | undefined {
  return (
    lastRegexMatch(text, DCP_ID_MARKDOWN_REF_MATCH_RE) ??
    lastRegexMatch(text, DCP_ID_TAG_MATCH_RE)
  )?.[1];
}

function stripStaleDcpMetadataLines(text: string): string {
  if (!text.includes("<dcp-") && !text.includes("[dcp-")) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  let inMessageIds = false;
  let inSystemReminder = false;
  let inMarkdownFence = false;

  for (const line of lines) {
    if (MARKDOWN_FENCE_LINE_RE.test(line)) {
      kept.push(line);
      inMarkdownFence = !inMarkdownFence;
      continue;
    }

    if (inMarkdownFence) {
      kept.push(line);
      continue;
    }

    if (inMessageIds) {
      if (DCP_MESSAGE_IDS_END_LINE_RE.test(line)) inMessageIds = false;
      continue;
    }

    if (DCP_MESSAGE_IDS_START_LINE_RE.test(line)) {
      if (!DCP_MESSAGE_IDS_END_LINE_RE.test(line)) inMessageIds = true;
      continue;
    }

    if (inSystemReminder) {
      if (DCP_SYSTEM_REMINDER_END_LINE_RE.test(line)) inSystemReminder = false;
      continue;
    }

    if (DCP_SYSTEM_REMINDER_START_LINE_RE.test(line)) {
      if (!DCP_SYSTEM_REMINDER_END_LINE_RE.test(line)) inSystemReminder = true;
      continue;
    }

    if (
      DCP_ID_METADATA_LINE_RE.test(line) ||
      DCP_BLOCK_ID_METADATA_LINE_RE.test(line) ||
      DCP_ID_MARKDOWN_REF_LINE_RE.test(line) ||
      DCP_BLOCK_ID_MARKDOWN_REF_LINE_RE.test(line) ||
      DCP_MARKDOWN_REF_FRAGMENT_LINE_RE.test(line)
    ) continue;
    kept.push(line);
  }

  return kept.join("\n").trimEnd();
}

function stripStaleDcpMetadataFromAssistantBlock(block: any): any | undefined {
  if (!block || typeof block !== "object") return block;
  const next = { ...block };
  let touched = false;

  if (typeof next.text === "string") {
    const stripped = stripStaleDcpMetadataLines(next.text);
    if (stripped !== next.text) {
      touched = true;
      next.text = stripped;
      delete next.textSignature;
    }
  }

  if (typeof next.thinking === "string") {
    const stripped = stripStaleDcpMetadataLines(next.thinking);
    if (stripped !== next.thinking) {
      touched = true;
      next.thinking = stripped;
      delete next.thinkingSignature;
    }
  }

  if (touched && next.type === "text" && typeof next.text === "string" && next.text.trim() === "") return undefined;
  if (touched && next.type === "thinking" && typeof next.thinking === "string" && next.thinking.trim() === "") return undefined;
  return next;
}

export function stripStaleDcpMetadataFromAssistantMessage(message: any): any {
  if (!message || typeof message !== "object" || message.role !== "assistant") return message;
  return stripStaleDcpMetadataFromMessage(message);
}

export function stripStaleDcpMetadataFromMessage(message: any): any {
  if (!message || typeof message !== "object") return message;
  if (typeof message.content === "string") {
    return { ...message, content: stripStaleDcpMetadataLines(message.content) };
  }
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content
      .map(stripStaleDcpMetadataFromAssistantBlock)
      .filter((block: any) => block !== undefined),
  };
}
