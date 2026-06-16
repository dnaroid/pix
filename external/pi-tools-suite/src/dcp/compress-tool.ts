// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { DcpState } from "./state.js"
import { modelKeysFromContext, resolveModelConfig, type DcpConfig } from "./config.js"
import { clearDcpNudgeAnchors } from "./pruner.js"
import type { DcpCompressionVisualDetails } from "./ui.js"
import { normalizeDcpContextUsage } from "./ui.js"
import { COMPRESS_TOOL_DESCRIPTION } from "../tool-descriptions.js"
import { safeGetContextUsage } from "../context-usage.js"
import {
  createRangeCompressionBlock,
  findCoveredAndPartialBlocks,
  formatCompressionIdDiagnostics,
  getMessageMeta,
  resolveAnchorBoundary,
  resolveIdToBoundary,
} from "./compression-blocks.js"

type MessageSkipKind =
  | "duplicate"
  | "unknown"
  | "block-id"
  | "non-finite"
  | "protected-user"
  | "already-compressed"

interface MessageSkipIssue {
  kind: MessageSkipKind
  messageId: string
  detail?: string
}

interface ResolvedRangePlan {
  startId: string
  endId: string
  summary: string
  startTimestamp: number
  endTimestamp: number
  startMessageId?: string
  endMessageId?: string
}

function validateNonOverlappingRanges(plans: ResolvedRangePlan[]): void {
  const sorted = [...plans].sort((a, b) =>
    a.startTimestamp - b.startTimestamp ||
    a.endTimestamp - b.endTimestamp,
  )
  const issues: string[] = []

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!
    const current = sorted[i]!
    if (current.startTimestamp > previous.endTimestamp) continue
    issues.push(
      `${previous.startId}..${previous.endId} overlaps ${current.startId}..${current.endId}`,
    )
  }

  if (issues.length > 0) {
    throw new Error(
      `Overlapping ranges cannot be compressed in the same call:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    )
  }
}

function formatSkippedMessages(issues: MessageSkipIssue[]): string[] {
  const grouped = new Map<MessageSkipKind, string[]>()
  for (const issue of issues) {
    grouped.set(issue.kind, [...(grouped.get(issue.kind) ?? []), issue.messageId])
  }

  const descriptions: Record<MessageSkipKind, string> = {
    duplicate: "selected more than once in this batch",
    unknown: "not available in the current conversation context",
    "block-id": "is a compressed block ID; message compression accepts raw mNNN IDs only",
    "non-finite": "resolved to a corrupted non-finite timestamp",
    "protected-user": "is a raw user message protected by compress.protectUserMessages",
    "already-compressed": "already belongs to an active compression block",
  }

  return Array.from(grouped.entries()).map(([kind, ids]) => {
    const details = [
      ...new Set(
        issues
          .filter((issue) => issue.kind === kind)
          .map((issue) => issue.detail)
          .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0),
      ),
    ]
    const suffix = details.length > 0 ? `\n${details.join("\n")}` : ""
    return `${ids.join(", ")} ${descriptions[kind]}.${suffix}`
  })
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompressTool(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
): void {
  pi.registerTool({
    name: "compress",
    label: COMPRESS_TOOL_DESCRIPTION.label,
    description: COMPRESS_TOOL_DESCRIPTION.description,
    promptSnippet: COMPRESS_TOOL_DESCRIPTION.promptSnippet ?? "Compress ranges of conversation into summaries to manage context",
    parameters: Type.Object({
      topic: Type.String({
        description:
          "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
      }),
      ranges: Type.Optional(Type.Array(
        Type.Object({
          startId: Type.String({
            description:
              "Message ID marking start of range (e.g. m001, b2)",
          }),
          endId: Type.String({
            description:
              "Message ID marking end of range (e.g. m042, b5)",
          }),
          summary: Type.String({
            description:
              "Continuation-focused technical summary; avoid raw JSON/code/diffs unless a short literal is required",
          }),
        }),
        { description: "One or more ranges to compress" },
      )),
      messages: Type.Optional(Type.Array(
        Type.Object({
          messageId: Type.String({
            description: "Raw message ID to compress individually (e.g. m001)",
          }),
          topic: Type.Optional(Type.String({
            description: "Short label for this one-message summary; defaults to top-level topic",
          })),
          summary: Type.String({
            description: "Continuation-focused technical summary replacing this raw message; avoid raw JSON/code/diffs unless required",
          }),
        }),
        { description: "Individual raw messages to compress surgically" },
      )),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const effectiveConfig = resolveModelConfig(config, modelKeysFromContext(ctx))
      if (!effectiveConfig.enabled) {
        throw new Error("DCP is disabled for the active model")
      }

      const newBlockIds: number[] = []
      const ranges = Array.isArray(params.ranges) ? params.ranges : []
      const messages = Array.isArray(params.messages) ? params.messages : []
      let operationRemovedTokens = 0
      let operationSummaryTokens = 0

      if (ranges.length === 0 && messages.length === 0) {
        throw new Error("compress requires at least one ranges[] or messages[] entry")
      }

      const rangePlans: ResolvedRangePlan[] = ranges.map((range) => {
        const { startId, endId, summary } = range

        // ── Resolve boundary timestamps ──────────────────────────────────
        const startBoundary = resolveIdToBoundary(startId, "startTimestamp", state)
        const endBoundary = resolveIdToBoundary(endId, "endTimestamp", state)
        const startTimestamp = startBoundary.timestamp
        const endTimestamp = endBoundary.timestamp

        if (startTimestamp > endTimestamp) {
          throw new Error(
            `Range start "${startId}" must appear before end "${endId}" in the conversation`,
          )
        }

        // ── Validate timestamps are finite ──────────────────────────────
        if (!Number.isFinite(startTimestamp)) {
          throw new Error(
            `Start ID "${startId}" resolved to a non-finite timestamp (${startTimestamp}). ` +
            `This usually means the referenced message has a corrupted timestamp.`,
          )
        }
        if (!Number.isFinite(endTimestamp)) {
          throw new Error(
            `End ID "${endId}" resolved to a non-finite timestamp (${endTimestamp}). ` +
            `This usually means the referenced message has a corrupted timestamp.`,
          )
        }

        return {
          startId,
          endId,
          summary,
          startTimestamp,
          endTimestamp,
          startMessageId: startBoundary.stableId,
          endMessageId: endBoundary.stableId,
        }
      })

      validateNonOverlappingRanges(rangePlans)

      for (const range of rangePlans) {
        const anchor = resolveAnchorBoundary(range.endTimestamp, state)

        const created = createRangeCompressionBlock({
          topic: params.topic,
          summary: range.summary,
          startTimestamp: range.startTimestamp,
          endTimestamp: range.endTimestamp,
          startMessageId: range.startMessageId,
          endMessageId: range.endMessageId,
          anchorTimestamp: anchor.timestamp,
          anchorMessageId: anchor.stableId,
          createdByToolCallId: _toolCallId,
          state,
          config: effectiveConfig,
          mode: "range",
        })
        const block = created.block
        newBlockIds.push(block.id)
        operationRemovedTokens += created.removedTokenEstimate
        operationSummaryTokens += created.summaryTokenEstimate
      }

      const skippedMessageIssues: MessageSkipIssue[] = []
      const seenMessageIds = new Set<string>()

      for (const entry of messages) {
        const { summary } = entry
        const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : ""
        if (seenMessageIds.has(messageId)) {
          skippedMessageIssues.push({ kind: "duplicate", messageId })
          continue
        }
        seenMessageIds.add(messageId)

        if (/^b\d+$/i.test(messageId)) {
          skippedMessageIssues.push({ kind: "block-id", messageId })
          continue
        }

        const meta = getMessageMeta(messageId, state)
        if (!meta) {
          skippedMessageIssues.push({
            kind: "unknown",
            messageId,
            detail:
              "The ID is not present in the current DCP snapshot; it may be stale after compression, pruning, reload, or session switching.\n" +
              formatCompressionIdDiagnostics(state),
          })
          continue
        }
        if (meta.blockId !== undefined) {
          skippedMessageIssues.push({ kind: "block-id", messageId })
          continue
        }
        if (!Number.isFinite(meta.timestamp)) {
          skippedMessageIssues.push({ kind: "non-finite", messageId })
          continue
        }
        if (effectiveConfig.compress.protectUserMessages && meta.role === "user") {
          skippedMessageIssues.push({ kind: "protected-user", messageId })
          continue
        }

        const { coveredBlocks, partialBlocks } = findCoveredAndPartialBlocks(
          meta.timestamp,
          meta.timestamp,
          state,
        )
        if (coveredBlocks.length > 0 || partialBlocks.length > 0) {
          const blockList = [...coveredBlocks, ...partialBlocks]
            .map((block) => `b${block.id} "${block.topic}"`)
            .join(", ")
          skippedMessageIssues.push({ kind: "already-compressed", messageId, detail: blockList })
          continue
        }

        const anchor = resolveAnchorBoundary(meta.timestamp, state)

        const created = createRangeCompressionBlock({
          topic: entry.topic ?? params.topic,
          summary,
          startTimestamp: meta.timestamp,
          endTimestamp: meta.timestamp,
          startMessageId: meta.stableId,
          endMessageId: meta.stableId,
          anchorTimestamp: anchor.timestamp,
          anchorMessageId: anchor.stableId,
          createdByToolCallId: _toolCallId,
          state,
          config: effectiveConfig,
          mode: "message",
          validatePlaceholders: false,
          expandPlaceholders: false,
        })
        const block = created.block
        newBlockIds.push(block.id)
        operationRemovedTokens += Math.max(0, Math.round(meta.tokenEstimate ?? 0))
        operationSummaryTokens += created.summaryTokenEstimate
      }

      if (newBlockIds.length === 0 && skippedMessageIssues.length > 0) {
        throw new Error(
          `Unable to compress any requested messages. Skipped ${skippedMessageIssues.length}:\n` +
          formatSkippedMessages(skippedMessageIssues).map((issue) => `- ${issue}`).join("\n"),
        )
      }

      const clearedNudgeAnchors = newBlockIds.length > 0 ? clearDcpNudgeAnchors(state) : 0
      if (clearedNudgeAnchors > 0) {
        try {
          pi.appendEntry("dcp-nudge", {
            event: "cleared",
            reason: "compress",
            clearedAnchors: clearedNudgeAnchors,
            blockIds: newBlockIds,
            createdAt: Date.now(),
          })
        } catch {
          // Diagnostic telemetry should never affect a successful compression.
        }
      }

      const usage = normalizeDcpContextUsage(safeGetContextUsage(ctx))
      const operationTokensSaved = Math.max(0, operationRemovedTokens - operationSummaryTokens)
      const itemCount = ranges.length + messages.length
      const totalSummaryTokens = newBlockIds.reduce((sum, id) => {
        const b = state.compressionBlocks.find((block) => block.id === id)
        return sum + (b?.summaryTokenEstimate ?? 0)
      }, 0)
      const visualDetails: DcpCompressionVisualDetails = {
        blockIds: newBlockIds,
        topic: params.topic,
        ranges: ranges.length,
        messages: messages.length,
        itemCount,
        totalSummaryTokens,
        activeBlocks: state.compressionBlocks.filter((b) => b.active).length,
        totalBlocks: state.compressionBlocks.length,
        prunedTools: state.prunedToolIds.size,
        tokensSaved: operationTokensSaved,
        contextTokens: usage?.tokens,
        contextWindow: usage?.contextWindow,
        contextPercent: usage?.percent,
        skippedMessages: skippedMessageIssues.length,
        skippedMessageIssues: formatSkippedMessages(skippedMessageIssues),
      }
      const resultDetails = {
        ...visualDetails,
        outputFormat: "json" as const,
      }

      // ── Return result ───────────────────────────────────────────────────
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(resultDetails, null, 2),
          },
        ],
        details: resultDetails,
      }
    },
  })
}
