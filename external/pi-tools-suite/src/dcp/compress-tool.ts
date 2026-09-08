// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "typebox"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CompressionMember, DcpState } from "./state.js"
import { modelKeysFromContext, resolveModelConfig, type DcpConfig } from "./config.js"
import { captureDcpTransactionGuard, cloneDcpTransactionState, runDcpStateTransaction } from "./state-transaction.js"
import { createHash } from "node:crypto"
import { clearDcpNudgeAnchors } from "./pruner.js"
import type { DcpCompressionVisualDetails } from "./ui.js"
import { normalizeDcpContextUsage } from "./ui.js"
import { COMPRESS_TOOL_DESCRIPTION } from "../tool-descriptions.js"
import { safeGetContextUsage } from "../context-usage.js"
import { summarizeDcpState, writeDcpDebugLog } from "./debug-log.js"
import {
  compareCompressionBoundaries,
  createRangeCompressionBlock,
  findCoveredAndPartialBlocks,
  formatCompressionIdDiagnostics,
  getMessageMeta,
  prepareCompressionProtectedFragments,
  resolveAnchorBoundary,
  resolveExactRangeMembership,
  resolveIdToBoundary,
} from "./compression-blocks.js"
import {
  closeConversationRange,
  detectToolGroupSpans,
  findConversationIndexEntry,
} from "./conversation-index.js"
import { previewManualCompressionProjection } from "./compression-preview.js"
import { settleCompressionProgress } from "./compression-progress.js"

type MessageSkipKind =
  | "duplicate"
  | "unknown"
  | "block-id"
  | "non-finite"
  | "protected-user"
  | "already-compressed"
  | "tool-group"

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
  sourceMembers: CompressionMember[]
  mutationMembers: CompressionMember[]
}

interface ResolvedMessagePlan {
  messageId: string
  topic: string
  summary: string
  timestamp: number
  stableId?: string
  sourceMembers: CompressionMember[]
  mutationMembers: CompressionMember[]
}

type ResolvedRangeBoundaries = Omit<ResolvedRangePlan, "sourceMembers" | "mutationMembers">

function validateNonOverlappingRanges(plans: ResolvedRangeBoundaries[], state: DcpState): void {
  const sorted = [...plans].sort((a, b) =>
    compareCompressionBoundaries(
      { timestamp: a.startTimestamp, stableId: a.startMessageId },
      { timestamp: b.startTimestamp, stableId: b.startMessageId },
      state,
    ) ||
    compareCompressionBoundaries(
      { timestamp: a.endTimestamp, stableId: a.endMessageId },
      { timestamp: b.endTimestamp, stableId: b.endMessageId },
      state,
    ),
  )
  const issues: string[] = []

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!
    const current = sorted[i]!
    if (compareCompressionBoundaries(
      { timestamp: current.startTimestamp, stableId: current.startMessageId },
      { timestamp: previous.endTimestamp, stableId: previous.endMessageId },
      state,
    ) > 0) continue
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

function validateProtocolClosedRanges(plans: ResolvedRangeBoundaries[], state: DcpState): void {
  if (state.conversationIndexSnapshot.length === 0) return

  for (const plan of plans) {
    const closure = closeConversationRange(state.conversationIndexSnapshot, plan.startId, plan.endId)
    if (!closure) continue
    if (closure.incompleteToolGroup) {
      throw new Error(
        `Compression range ${plan.startId}..${plan.endId} intersects an incomplete tool group. ` +
        "Wait until the complete assistant/tool-result group is present or choose another closed range.",
      )
    }
    if (closure.expanded) {
      const safeStart = closure.startId ?? plan.startId
      const safeEnd = closure.endId ?? plan.endId
      throw new Error(
        `Compression range ${plan.startId}..${plan.endId} cuts through a tool group. ` +
        `The protocol-safe closed range is ${safeStart}..${safeEnd}. ` +
        "Retry with the complete range so the supplied summary covers every message that will be removed.",
      )
    }
  }
}

function selectionMemberKeys(membership: Pick<ResolvedRangePlan | ResolvedMessagePlan, "sourceMembers" | "mutationMembers">): Set<string> {
  return new Set(
    [...membership.sourceMembers, ...membership.mutationMembers]
      .map((member) => `${member.stableId}:${member.hash}`),
  )
}

function assertDisjointSelections(
  ranges: ResolvedRangePlan[],
  messages: ResolvedMessagePlan[],
): void {
  const selections = [
    ...ranges.map((range) => ({ label: `${range.startId}..${range.endId}`, membership: range })),
    ...messages.map((message) => ({ label: message.messageId, membership: message })),
  ]
  for (let leftIndex = 0; leftIndex < selections.length; leftIndex++) {
    const left = selections[leftIndex]!
    const leftKeys = selectionMemberKeys(left.membership)
    for (let rightIndex = leftIndex + 1; rightIndex < selections.length; rightIndex++) {
      const right = selections[rightIndex]!
      if ([...selectionMemberKeys(right.membership)].some((key) => leftKeys.has(key))) {
        throw new Error(
          `Overlapping compression selections cannot be committed in the same call: ${left.label} overlaps ${right.label}.`,
        )
      }
    }
  }
}

function messageTouchesIncompleteToolGroup(messageId: string, state: DcpState): boolean {
  const entry = findConversationIndexEntry(state.conversationIndexSnapshot, messageId)
  if (!entry) return false
  return detectToolGroupSpans(state.conversationIndexSnapshot).some((group) =>
    !group.complete && entry.index >= group.startIndex && entry.index <= group.endIndex,
  )
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
    "tool-group": "belongs to a structurally coupled tool group and cannot be replaced as one isolated message",
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

function createCompressionWorkingState(state: DcpState): DcpState {
  return cloneDcpTransactionState(state)
}

function commitCompressionWorkingState(state: DcpState, workingState: DcpState): void {
  state.compressionBlocks = workingState.compressionBlocks
  state.nextBlockId = workingState.nextBlockId
  state.nudgeAnchors = workingState.nudgeAnchors
  state.nudgeCounter = workingState.nudgeCounter
  state.lastNudge = workingState.lastNudge
  state.consecutiveIgnoredStrongNudges = workingState.consecutiveIgnoredStrongNudges
  state.consecutiveIgnoredNudges = workingState.consecutiveIgnoredNudges
  state.compressionProgress = workingState.compressionProgress
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export interface CompressToolDependencies {
  persistState?: (
    ctx: ExtensionContext,
    state: DcpState,
    publication?: { beforePublish?: () => void; onPublished?: () => void },
  ) => Promise<void> | void
  isSessionSupported?: () => boolean
}

export function registerCompressTool(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  dependencies: CompressToolDependencies = {},
): void {
  const persistState = dependencies.persistState ?? (async (
    _ctx: ExtensionContext,
    _state: DcpState,
    publication?: { beforePublish?: () => void; onPublished?: () => void },
  ) => {
    publication?.beforePublish?.()
    publication?.onPublished?.()
  })
  const isSessionSupported = dependencies.isSessionSupported ?? (() => true)
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
              "First ID (mNNN/bN); never start inside a tool group—include its calling assistant.",
          }),
          endId: Type.String({
            description:
              "Last ID (mNNN/bN); include all results of the final tool group, including parallel calls.",
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
      _signal?.throwIfAborted()
      if (!isSessionSupported()) {
        throw new Error("DCP is unavailable in this session. Start a new session to use the current DCP journal format.")
      }
      const assertCurrent = captureDcpTransactionGuard(state, config, _signal, ctx)
      const requestHash = createHash("sha256").update(JSON.stringify(params)).digest("hex")
      return runDcpStateTransaction(state, async () => {
      assertCurrent()
      const operationEpoch = state.sessionEpoch
      const effectiveConfig = resolveModelConfig(config, modelKeysFromContext(ctx))
      if (!effectiveConfig.enabled) {
        throw new Error("DCP is disabled for the active model")
      }

      const newBlockIds: number[] = []
      const ranges = Array.isArray(params.ranges) ? params.ranges : []
      const messages = Array.isArray(params.messages) ? params.messages : []
      const workingState = createCompressionWorkingState(state)
      const committedRangeLogs: Array<Record<string, unknown>> = []
      let operationRemovedTokens = 0
      let operationSummaryTokens = 0

      const log = (event: string, details: Record<string, unknown> = {}) =>
        writeDcpDebugLog(effectiveConfig, event, details, ctx)

      log("compress.request", {
        toolCallId: _toolCallId,
        topic: params.topic,
        ranges: ranges.map((range) => ({ startId: range.startId, endId: range.endId })),
        messages: messages.map((entry) => ({ messageId: entry.messageId, topic: entry.topic })),
        state: summarizeDcpState(state, effectiveConfig),
      })

      const replayBlocks = state.compressionBlocks.filter((block) => block.createdByToolCallId === _toolCallId)
      if (replayBlocks.length > 0) {
        if (replayBlocks.some((block) => block.operationRequestHash !== requestHash)) {
          throw new Error("Compression operation identity conflict: tool call was reused with different or unverifiable parameters")
        }
        const replayBlockIds = replayBlocks.map((block) => block.id)
        const usage = normalizeDcpContextUsage(safeGetContextUsage(ctx))
        const visualDetails: DcpCompressionVisualDetails = {
          blockIds: replayBlockIds,
          topic: params.topic,
          ranges: ranges.length,
          messages: messages.length,
          itemCount: ranges.length + messages.length,
          totalSummaryTokens: replayBlocks.reduce((sum, block) => sum + (block.summaryTokenEstimate ?? 0), 0),
          activeBlocks: state.compressionBlocks.filter((block) => block.active).length,
          totalBlocks: state.compressionBlocks.length,
          prunedTools: state.prunedToolIds.size,
          tokensSaved: replayBlockIds.reduce((sum, id) => sum + (state.compressionTokenSavings.get(id) ?? 0), 0),
          contextTokens: usage?.tokens,
          contextWindow: usage?.contextWindow,
          contextPercent: usage?.percent,
          skippedMessages: 0,
          skippedMessageIssues: [],
          idempotentReplay: true,
        }
        const resultDetails = { ...visualDetails, outputFormat: "json" as const }
        log("compress.idempotent_replay", {
          toolCallId: _toolCallId,
          blockIds: replayBlockIds.map((id) => `b${id}`),
          state: summarizeDcpState(state, effectiveConfig),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(resultDetails, null, 2) }],
          details: resultDetails,
        }
      }

      if (ranges.length === 0 && messages.length === 0) {
        throw new Error("compress requires at least one ranges[] or messages[] entry")
      }

      let rangePlans: ResolvedRangePlan[]
      try {
        const boundaryPlans: ResolvedRangeBoundaries[] = ranges.map((range) => {
          const { startId, endId, summary } = range

          // ── Resolve boundary timestamps ──────────────────────────────────
          const startBoundary = resolveIdToBoundary(startId, "startTimestamp", state)
          const endBoundary = resolveIdToBoundary(endId, "endTimestamp", state)
          const startTimestamp = startBoundary.timestamp
          const endTimestamp = endBoundary.timestamp

          if (compareCompressionBoundaries(startBoundary, endBoundary, state) > 0) {
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

        validateNonOverlappingRanges(boundaryPlans, state)
        validateProtocolClosedRanges(boundaryPlans, state)
        rangePlans = boundaryPlans.map((range) => {
          const { partialBlocks } = findCoveredAndPartialBlocks(range.startTimestamp, range.endTimestamp, state, range)
          if (partialBlocks.length > 0) {
            throw new Error(
              `Compression range partially overlaps existing block(s): ${partialBlocks.map((block) => `b${block.id}`).join(", ")}. ` +
              `Select the whole block or non-overlapping boundaries.\n${formatCompressionIdDiagnostics(state)}`,
            )
          }
          const membership = resolveExactRangeMembership(range.startId, range.endId, state)
          if (!membership) {
            throw new Error(
              `Manual compression requires exact source membership for ${range.startId}..${range.endId}; refresh the current DCP context and retry.`,
            )
          }
          return { ...range, ...membership }
        })
      } catch (error) {
        log("compress.resolve_failed", {
          toolCallId: _toolCallId,
          error: error instanceof Error ? error.message : String(error),
          state: summarizeDcpState(state, effectiveConfig),
        })
        throw error
      }

      // Reject a batch that would claim the same provider-visible source more
      // than once before any detached block is created. Invalid message-mode
      // entries retain their established soft-skip behavior below.
      const preflightMessages: ResolvedMessagePlan[] = []
      const preflightSeenMessageIds = new Set<string>()
      for (const entry of messages) {
        const messageId = typeof entry.messageId === "string" ? entry.messageId.trim() : ""
        if (preflightSeenMessageIds.has(messageId)) continue
        preflightSeenMessageIds.add(messageId)
        if (/^b\d+$/i.test(messageId)) continue
        const meta = getMessageMeta(messageId, state)
        const indexEntry = findConversationIndexEntry(state.conversationIndexSnapshot, messageId)
        if (!meta || meta.blockId !== undefined || !Number.isFinite(meta.timestamp) ||
          (effectiveConfig.compress.protectUserMessages && meta.role === "user") ||
          (meta.role === "assistant" && ((meta.toolCallIds?.length ?? 0) > 0 || indexEntry?.signedAssistant)) ||
          messageTouchesIncompleteToolGroup(messageId, state)) continue
        const membership = resolveExactRangeMembership(messageId, messageId, state, true)
        if (!membership) {
          throw new Error(
            `Manual message compression requires exact source membership for ${messageId}; refresh the current DCP context and retry.`,
          )
        }
        preflightMessages.push({
          messageId,
          topic: entry.topic ?? params.topic,
          summary: entry.summary,
          timestamp: meta.timestamp,
          stableId: meta.stableId,
          sourceMembers: membership.sourceMembers,
          mutationMembers: membership.mutationMembers,
        })
      }
      assertDisjointSelections(rangePlans, preflightMessages)

      for (const range of rangePlans) {
        try {
          const anchor = resolveAnchorBoundary(range.endTimestamp, workingState, range.endMessageId)
          const preparedProtectedFragments = await prepareCompressionProtectedFragments({
            startTimestamp: range.startTimestamp,
            endTimestamp: range.endTimestamp,
            startMessageId: range.startMessageId,
            endMessageId: range.endMessageId,
            state: workingState,
            config: effectiveConfig,
            mode: "range",
            cwd: (ctx as any).cwd,
          })

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
            state: workingState,
            config: effectiveConfig,
            mode: "range",
            version: 2,
            replacementMode: "range",
            preparedProtectedFragments,
            sourceMembers: range.sourceMembers,
            mutationMembers: range.mutationMembers,
          })
          const block = created.block
          newBlockIds.push(block.id)
          operationRemovedTokens += created.removedTokenEstimate
          operationSummaryTokens += created.summaryTokenEstimate
          committedRangeLogs.push({
            toolCallId: _toolCallId,
            range: { startId: range.startId, endId: range.endId },
            blockId: `b${block.id}`,
            coveredBlockIds: block.coveredBlockIds ?? [],
            anchorMessageId: block.anchorMessageId,
          })
        } catch (error) {
          log("compress.range_failed", {
            toolCallId: _toolCallId,
            range: { startId: range.startId, endId: range.endId },
            error: error instanceof Error ? error.message : String(error),
            state: summarizeDcpState(state, effectiveConfig),
          })
          throw error
        }
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

        const meta = getMessageMeta(messageId, workingState)
        if (!meta) {
          skippedMessageIssues.push({
            kind: "unknown",
            messageId,
            detail:
              "The ID is not present in the current DCP snapshot; it may be stale after compression, pruning, reload, or session switching.\n" +
              formatCompressionIdDiagnostics(workingState),
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
        const indexEntry = findConversationIndexEntry(workingState.conversationIndexSnapshot, messageId)
        if (meta.role === "assistant" && ((meta.toolCallIds?.length ?? 0) > 0 || indexEntry?.signedAssistant)) {
          skippedMessageIssues.push({
            kind: "tool-group",
            messageId,
            detail:
              "Signed assistant content and assistants containing tool calls cannot be edited in place; use ranges[] with a complete protocol-safe group.",
          })
          continue
        }
        if (messageTouchesIncompleteToolGroup(messageId, workingState)) {
          skippedMessageIssues.push({
            kind: "tool-group",
            messageId,
            detail: "The selected message belongs to an incomplete in-flight tool group and is not safe to replace yet.",
          })
          continue
        }

        const { coveredBlocks, partialBlocks } = findCoveredAndPartialBlocks(
          meta.timestamp,
          meta.timestamp,
          workingState,
          { startMessageId: meta.stableId, endMessageId: meta.stableId },
        )
        if (coveredBlocks.length > 0 || partialBlocks.length > 0) {
          const blockList = [...coveredBlocks, ...partialBlocks]
            .map((block) => `b${block.id} "${block.topic}"`)
            .join(", ")
          skippedMessageIssues.push({ kind: "already-compressed", messageId, detail: blockList })
          continue
        }

        const anchor = resolveAnchorBoundary(meta.timestamp, workingState, meta.stableId)
        const preparedProtectedFragments = await prepareCompressionProtectedFragments({
          startTimestamp: meta.timestamp,
          endTimestamp: meta.timestamp,
          startMessageId: meta.stableId,
          endMessageId: meta.stableId,
          state: workingState,
          config: effectiveConfig,
          mode: "message",
          cwd: (ctx as any).cwd,
        })

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
          state: workingState,
          config: effectiveConfig,
          mode: "message",
          version: 2,
          replacementMode: "message-body",
          validatePlaceholders: false,
          expandPlaceholders: false,
          preparedProtectedFragments,
          sourceMembers: preflightMessages.find((plan) => plan.messageId === messageId)?.sourceMembers,
          mutationMembers: preflightMessages.find((plan) => plan.messageId === messageId)?.mutationMembers,
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

      let projection: ReturnType<typeof previewManualCompressionProjection> | undefined
      let pressureRelieved = false
      let clearedNudgeAnchors = 0
      if (newBlockIds.length > 0) {
        const newBlocks = workingState.compressionBlocks.filter((block) => newBlockIds.includes(block.id))
        projection = previewManualCompressionProjection(state, effectiveConfig, newBlocks)
        if (projection.netGain <= 0) {
          log("compress.projection_rejected", {
            toolCallId: _toolCallId,
            projectedBeforeTokens: projection.projectedBeforeTokens,
            projectedAfterTokens: projection.projectedAfterTokens,
            netGain: projection.netGain,
            state: summarizeDcpState(state, effectiveConfig),
          })
          throw new Error(
            `Manual compression rejected non-positive full-projection gain: ` +
            `${projection.projectedBeforeTokens} before, ${projection.projectedAfterTokens} after, ${projection.netGain} net. ` +
            "No DCP state was published.",
          )
        }
        // This is deliberately after the full projection proof. Partial
        // progress retains its outstanding recovery debt and patience.
        pressureRelieved = settleCompressionProgress(
          workingState,
          projection.netGain,
          projection.projectedAfterTokens,
        )
        // The selected IDs may have been replaced, so one old reminder may be
        // invalidated at this rewrite boundary. The next context pass will
        // render a fresh anchor without erasing the patience counters above.
        clearedNudgeAnchors = clearDcpNudgeAnchors(workingState)
        if (!pressureRelieved) workingState.nudgeCounter = Math.max(1, effectiveConfig.compress.nudgeFrequency)
        for (const block of workingState.compressionBlocks) {
          if (newBlockIds.includes(block.id)) block.operationRequestHash = requestHash
        }
        assertCurrent()
        let published = false
        await persistState(ctx, workingState, {
          beforePublish: assertCurrent,
          onPublished: () => { published = true },
        })
        if (!published) assertCurrent()
        if (state.sessionEpoch === operationEpoch) commitCompressionWorkingState(state, workingState)
        for (const details of committedRangeLogs) log("compress.range_created", details)
      }
      if (clearedNudgeAnchors > 0 && state.sessionEpoch === operationEpoch) {
        try {
          pi.appendEntry("dcp-nudge", {
            event: "cleared",
            reason: pressureRelieved ? "compress" : "compress-partial",
            pressureRelieved,
            remainingRecoveryTokens: workingState.compressionProgress?.remainingTokens ?? 0,
            clearedAnchors: clearedNudgeAnchors,
            blockIds: newBlockIds,
            createdAt: Date.now(),
          })
        } catch {
          // Diagnostic telemetry should never affect a successful compression.
        }
      }

      log("compress.success", {
        toolCallId: _toolCallId,
        newBlockIds: newBlockIds.map((id) => `b${id}`),
        skippedMessages: skippedMessageIssues.length,
        projectedBeforeTokens: projection?.projectedBeforeTokens,
        projectedAfterTokens: projection?.projectedAfterTokens,
        netGain: projection?.netGain,
        pressureRelieved,
        remainingRecoveryTokens: workingState.compressionProgress?.remainingTokens ?? 0,
        state: summarizeDcpState(state, effectiveConfig),
      })

      const usage = state.sessionEpoch === operationEpoch ? normalizeDcpContextUsage(safeGetContextUsage(ctx)) : undefined
      const operationTokensSaved = Math.max(0, projection?.netGain ?? operationRemovedTokens - operationSummaryTokens)
      const itemCount = ranges.length + messages.length
      const totalSummaryTokens = newBlockIds.reduce((sum, id) => {
        const b = workingState.compressionBlocks.find((block) => block.id === id)
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
        projectedBeforeTokens: projection?.projectedBeforeTokens,
        projectedAfterTokens: projection?.projectedAfterTokens,
        netGain: projection?.netGain,
        pressureRelieved,
        remainingRecoveryTokens: workingState.compressionProgress?.remainingTokens ?? 0,
        committed: true,
        ownerChangedAfterPublication: state.sessionEpoch !== operationEpoch,
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
      })
    },
  })
}
