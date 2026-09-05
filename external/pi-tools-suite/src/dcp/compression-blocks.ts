import type { CompressionBlock, DcpState, MessageIdMeta } from "./state.js"
import type { DcpConfig } from "./config.js"
import { estimateTokens } from "./pruner-metadata.js"
import { isToolRecordProtected } from "./pruner-tools.js"
import * as fs from "node:fs"
import * as path from "node:path"

const MAX_PROTECTED_SUBAGENT_RESULT_CHARS = 50_000

export interface CompressionBlockCreationResult {
  block: CompressionBlock
  removedTokenEstimate: number
  summaryTokenEstimate: number
}

export interface CreateRangeCompressionBlockOptions {
  topic: string
  summary: string
  startTimestamp: number
  endTimestamp: number
  startMessageId?: string
  endMessageId?: string
  state: DcpState
  config: DcpConfig
  anchorTimestamp?: number
  anchorMessageId?: string
  createdByToolCallId?: string
  mode?: "range" | "message"
  validatePlaceholders?: boolean
  expandPlaceholders?: boolean
}

export interface ResolvedCompressionBoundary {
  timestamp: number
  stableId?: string
}

export interface ResolvedCompressionAnchor extends ResolvedCompressionBoundary {}

function messageOrdinal(stableId: string | undefined, state: DcpState): number | undefined {
  if (!stableId) return undefined
  const visibleId = state.messageIdsByStableId.get(stableId) ??
    [...state.messageMetaSnapshot.entries()].find(([, meta]) => meta.stableId === stableId)?.[0]
  const match = visibleId?.match(/^m(\d+)$/i)
  if (!match) return undefined
  const ordinal = Number.parseInt(match[1]!, 10)
  return Number.isFinite(ordinal) ? ordinal : undefined
}

/**
 * Compare two raw conversation boundaries. Timestamps remain the primary
 * ordering key for legacy state, while persistent mNNN order breaks ties for
 * modern snapshots where multiple adjacent messages can share a timestamp.
 */
export function compareCompressionBoundaries(
  left: ResolvedCompressionBoundary,
  right: ResolvedCompressionBoundary,
  state: DcpState,
): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp
  const leftOrdinal = messageOrdinal(left.stableId, state)
  const rightOrdinal = messageOrdinal(right.stableId, state)
  if (leftOrdinal !== undefined && rightOrdinal !== undefined && leftOrdinal !== rightOrdinal) {
    return leftOrdinal - rightOrdinal
  }
  return 0
}

export function isCompressionBoundaryWithinRange(
  boundary: ResolvedCompressionBoundary,
  start: ResolvedCompressionBoundary,
  end: ResolvedCompressionBoundary,
  state: DcpState,
): boolean {
  return compareCompressionBoundaries(boundary, start, state) >= 0 &&
    compareCompressionBoundaries(boundary, end, state) <= 0
}

function rangeBoundaries(
  startTimestamp: number,
  endTimestamp: number,
  ids: { startMessageId?: string; endMessageId?: string } = {},
): { start: ResolvedCompressionBoundary; end: ResolvedCompressionBoundary } {
  return {
    start: { timestamp: startTimestamp, stableId: ids.startMessageId },
    end: { timestamp: endTimestamp, stableId: ids.endMessageId },
  }
}

const BLOCK_PLACEHOLDER_RE = /\(b(\d+)\)|\{block_(\d+)\}/gi
const MAX_DIAGNOSTIC_IDS = 24

function idSortKey(id: string): [number, string] {
  const match = id.match(/^(\D+)(\d+)$/)
  if (!match) return [Number.MAX_SAFE_INTEGER, id]
  return [Number.parseInt(match[2]!, 10), match[1]!.toLowerCase()]
}

function sortIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const [aNumber, aPrefix] = idSortKey(a)
    const [bNumber, bPrefix] = idSortKey(b)
    return aNumber - bNumber || aPrefix.localeCompare(bPrefix) || a.localeCompare(b)
  })
}

function compactList(items: string[], maxItems = MAX_DIAGNOSTIC_IDS): string {
  if (items.length === 0) return "none"
  if (items.length <= maxItems) return items.join(", ")

  const headCount = Math.max(1, Math.floor(maxItems * 0.65))
  const tailCount = Math.max(1, maxItems - headCount)
  return `${items.slice(0, headCount).join(", ")}, …, ${items.slice(-tailCount).join(", ")} (${items.length} total)`
}

function quoteTopic(topic: string): string {
  const singleLine = topic.replace(/\s+/g, " ").trim()
  if (!singleLine) return ""
  const truncated = singleLine.length > 48 ? `${singleLine.slice(0, 47)}…` : singleLine
  return ` "${truncated.replace(/"/g, "'")}"`
}

export function formatCompressionIdDiagnostics(state: DcpState): string {
  const rawIds = sortIds([
    ...new Set([
      ...state.messageIdSnapshot.keys(),
      ...state.messageMetaSnapshot.keys(),
    ]),
  ])
  const blockIds = state.compressionBlocks
    .filter((block) => block.active)
    .sort((a, b) => a.id - b.id)
    .map((block) => `b${block.id}${quoteTopic(block.topic)}`)

  return [
    `Current raw message IDs: ${compactList(rawIds)}.`,
    `Current active block IDs: ${compactList(blockIds)}.`,
    "Use only IDs from the latest visible context. If a raw range was already compressed, use the corresponding bN block ID instead of stale mNNN IDs.",
    "Retry at most once with a safe closed range from those IDs, or skip compression if none is safe.",
  ].join("\n")
}

export function unknownCompressionIdError(rawId: string, state: DcpState): Error {
  const id = rawId.trim()
  return new Error(
    `Unknown message ID: ${id}.\n` +
    "The ID is not present in the current DCP snapshot; it may be stale after compression, pruning, reload, or session switching.\n" +
    formatCompressionIdDiagnostics(state),
  )
}

function formatRestoredBlock(block: CompressionBlock): string {
  return `[Previously compressed: ${block.topic}]\n${block.summary}`
}

/**
 * Replace `(bN)` / legacy `{block_N}` placeholders in a summary with the
 * stored content of the referenced compression block. Unrecognised
 * placeholders are left as-is for backwards compatibility.
 */
export function expandBlockPlaceholders(summary: string, state: DcpState): string {
  return summary.replace(BLOCK_PLACEHOLDER_RE, (match, idStr, legacyIdStr) => {
    const id = parseInt(idStr ?? legacyIdStr, 10)
    const block = state.compressionBlocks.find((b) => b.id === id)
    return block ? formatRestoredBlock(block) : match
  })
}

function expandBlockPlaceholdersWithRecovery(
  summary: string,
  coveredBlocks: CompressionBlock[],
  state: DcpState,
): string {
  const coveredIds = new Set(coveredBlocks.map((block) => block.id))
  const consumed = new Set<number>()

  const expanded = summary.replace(BLOCK_PLACEHOLDER_RE, (_match, idStr, legacyIdStr) => {
    const id = parseInt(idStr ?? legacyIdStr, 10)
    if (!coveredIds.has(id) || consumed.has(id)) return ""

    const block = state.compressionBlocks.find((b) => b.id === id)
    if (!block) return ""

    consumed.add(id)
    return formatRestoredBlock(block)
  })

  const missing = coveredBlocks.filter((block) => !consumed.has(block.id))
  if (missing.length === 0) return expanded

  const recoveryHeading =
    "\n\nThe following previously compressed summaries were also part of this conversation section and were preserved automatically:"
  const recovery = missing
    .map((block) => `\n\n### b${block.id}\n${formatRestoredBlock(block)}`)
    .join("")

  return expanded + recoveryHeading + recovery
}

function preparePlaceholderSummary(
  summary: string,
  coveredBlocks: CompressionBlock[],
  state: DcpState,
  options: { validatePlaceholders: boolean; expandPlaceholders: boolean },
): string {
  if (!options.expandPlaceholders) return summary
  if (options.validatePlaceholders) {
    return expandBlockPlaceholdersWithRecovery(summary, coveredBlocks, state)
  }
  return expandBlockPlaceholders(summary, state)
}

export function findCoveredAndPartialBlocks(
  startTimestamp: number,
  endTimestamp: number,
  state: DcpState,
  boundaries: { startMessageId?: string; endMessageId?: string } = {},
): { coveredBlocks: CompressionBlock[]; partialBlocks: CompressionBlock[] } {
  const coveredBlocks: CompressionBlock[] = []
  const partialBlocks: CompressionBlock[] = []
  const requestedStart = { timestamp: startTimestamp, stableId: boundaries.startMessageId }
  const requestedEnd = { timestamp: endTimestamp, stableId: boundaries.endMessageId }

  for (const existing of state.compressionBlocks) {
    if (!existing.active) continue
    if (!Number.isFinite(existing.startTimestamp) || !Number.isFinite(existing.endTimestamp)) continue

    const existingStart = { timestamp: existing.startTimestamp, stableId: existing.startMessageId }
    const existingEnd = { timestamp: existing.endTimestamp, stableId: existing.endMessageId }

    const overlaps =
      compareCompressionBoundaries(requestedStart, existingEnd, state) <= 0 &&
      compareCompressionBoundaries(existingStart, requestedEnd, state) <= 0
    if (!overlaps) continue

    const fullyCovered =
      compareCompressionBoundaries(requestedStart, existingStart, state) <= 0 &&
      compareCompressionBoundaries(existingEnd, requestedEnd, state) <= 0

    if (fullyCovered) coveredBlocks.push(existing)
    else partialBlocks.push(existing)
  }

  return { coveredBlocks, partialBlocks }
}

function firstAddressableRawIdAfterBlock(block: CompressionBlock, state: DcpState): string | undefined {
  const endOrdinal = messageOrdinal(block.endMessageId, state)
  if (endOrdinal === undefined) return undefined

  let best: { id: string; ordinal: number } | undefined
  for (const [id, meta] of state.messageMetaSnapshot) {
    if (meta.blockId !== undefined) continue
    const match = id.match(/^m(\d+)$/i)
    if (!match) continue
    const ordinal = Number.parseInt(match[1]!, 10)
    if (!Number.isFinite(ordinal) || ordinal <= endOrdinal) continue
    if (!best || ordinal < best.ordinal) best = { id, ordinal }
  }
  return best?.id
}

export function getMessageMeta(id: string, state: DcpState): MessageIdMeta | undefined {
  return state.messageMetaSnapshot.get(id.trim())
}

function extractProtectTagTexts(text: string): string[] {
  const protectedTexts: string[] = []
  for (const match of text.matchAll(/<protect>([\s\S]*?)<\/protect>/gi)) {
    const protectedText = match[1]?.trim()
    if (protectedText) protectedTexts.push(protectedText)
  }
  return protectedTexts
}

export function appendProtectedPromptInfo(
  summary: string,
  startTimestamp: number,
  endTimestamp: number,
  state: DcpState,
  config: DcpConfig,
  ids: { startMessageId?: string; endMessageId?: string } = {},
): string {
  if (!config.compress.protectTags) return summary

  const protectedTexts: string[] = []
  const seen = new Set<string>()
  const boundaries = rangeBoundaries(startTimestamp, endTimestamp, ids)

  for (const meta of state.messageMetaSnapshot.values()) {
    if (meta.role !== "user") continue
    if (meta.blockId !== undefined) continue
    if (!Number.isFinite(meta.timestamp)) continue
    if (!isCompressionBoundaryWithinRange(
      { timestamp: meta.timestamp, stableId: meta.stableId },
      boundaries.start,
      boundaries.end,
      state,
    )) continue

    for (const text of extractProtectTagTexts(meta.text ?? "")) {
      if (seen.has(text)) continue
      seen.add(text)
      protectedTexts.push(text)
    }
  }

  if (protectedTexts.length === 0) return summary

  const heading = "\n\nThe following protected prompt information appeared in the selected user message(s) and must be preserved verbatim:"
  return summary + heading + protectedTexts.map((text) => `\n${text}`).join("")
}

export function appendProtectedUserMessages(
  summary: string,
  startTimestamp: number,
  endTimestamp: number,
  state: DcpState,
  enabled: boolean,
  ids: { startMessageId?: string; endMessageId?: string } = {},
): string {
  if (!enabled) return summary

  const userTexts: string[] = []
  const seen = new Set<string>()
  const boundaries = rangeBoundaries(startTimestamp, endTimestamp, ids)

  for (const meta of state.messageMetaSnapshot.values()) {
    if (meta.role !== "user") continue
    if (meta.blockId !== undefined) continue
    if (!Number.isFinite(meta.timestamp)) continue
    if (!isCompressionBoundaryWithinRange(
      { timestamp: meta.timestamp, stableId: meta.stableId },
      boundaries.start,
      boundaries.end,
      state,
    )) continue

    const text = meta.text?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    userTexts.push(text)
  }

  if (userTexts.length === 0) return summary

  const heading = "\n\nThe following user messages from this compressed range were preserved verbatim:"
  return summary + heading + userTexts.map((text) => `\n${text}`).join("")
}

function truncateProtectedOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const omitted = text.length - maxChars
  return text.slice(0, maxChars) + `\n[Protected output truncated; ${omitted} characters omitted]`
}

function resolveArtifactPath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
}

function readProtectedSubagentResult(details: unknown, fallbackText: string): string | undefined {
  if (!details || typeof details !== "object") return undefined
  const record = details as any
  const artifactPath = record.artifacts?.resultMd
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) return undefined

  const absolutePath = resolveArtifactPath(artifactPath.trim())
  let text: string
  try {
    text = fs.readFileSync(absolutePath, "utf8")
  } catch {
    return undefined
  }

  const trimmed = text.trim()
  if (!trimmed || fallbackText.includes(trimmed)) return undefined
  return `\n### Expanded subagent result: ${artifactPath}\n${truncateProtectedOutput(trimmed, MAX_PROTECTED_SUBAGENT_RESULT_CHARS)}`
}

function appendProtectedToolOutputs(
  summary: string,
  startTimestamp: number,
  endTimestamp: number,
  state: DcpState,
  config: DcpConfig,
  ids: { startMessageId?: string; endMessageId?: string } = {},
): string {
  const protectedOutputs: string[] = []
  const seenToolCallIds = new Set<string>()
  const boundaries = rangeBoundaries(startTimestamp, endTimestamp, ids)

  for (const meta of state.messageMetaSnapshot.values()) {
    if (meta.blockId !== undefined) continue
    if (!Number.isFinite(meta.timestamp)) continue
    if (!isCompressionBoundaryWithinRange(
      { timestamp: meta.timestamp, stableId: meta.stableId },
      boundaries.start,
      boundaries.end,
      state,
    )) continue
    if (meta.role !== "toolResult" && meta.role !== "bashExecution") continue

    const toolCallId = meta.toolCallId
    if (!toolCallId || seenToolCallIds.has(toolCallId)) continue
    const record = state.toolCalls.get(toolCallId)
    if (!record) continue

    // The compress tool's own JSON accounting output is control-plane data and
    // rarely useful in future summaries; avoid recursively copying it.
    if (record.toolName === "compress") continue
    if (!isToolRecordProtected(record, config)) continue

    const output = (record.outputText ?? meta.text ?? "").trim()
    if (!output) continue

    seenToolCallIds.add(toolCallId)
    const expandedSubagentResult =
      record.toolName === "subagents" || record.toolName === "async_subagents_result"
        ? readProtectedSubagentResult(record.outputDetails, output)
        : undefined
    protectedOutputs.push(`\n### Tool: ${record.toolName}\n${output}${expandedSubagentResult ?? ""}`)
  }

  if (protectedOutputs.length === 0) return summary
  const heading = "\n\nThe following protected tool outputs were included in this conversation section:"
  return summary + heading + protectedOutputs.join("")
}

export function estimateVisibleRangeTokens(
  startTimestamp: number,
  endTimestamp: number,
  coveredBlocks: CompressionBlock[],
  state: DcpState,
  ids: { startMessageId?: string; endMessageId?: string } = {},
): number {
  let total = 0
  const boundaries = rangeBoundaries(startTimestamp, endTimestamp, ids)
  for (const meta of state.messageMetaSnapshot.values()) {
    if (meta.blockId !== undefined) continue
    if (!Number.isFinite(meta.timestamp)) continue
    if (!isCompressionBoundaryWithinRange(
      { timestamp: meta.timestamp, stableId: meta.stableId },
      boundaries.start,
      boundaries.end,
      state,
    )) continue
    total += Math.max(0, Math.round(meta.tokenEstimate ?? 0))
  }
  for (const block of coveredBlocks) {
    total += Math.max(0, Math.round(block.summaryTokenEstimate ?? 0))
  }
  return total
}

/**
 * Resolve a user-supplied ID string (e.g. "m001" or "b3") to an actual
 * message timestamp.
 */
export function resolveIdToTimestamp(
  rawId: string,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState,
): number {
  return resolveIdToBoundary(rawId, field, state).timestamp
}

export function resolveIdToBoundary(
  rawId: string,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState,
): ResolvedCompressionBoundary {
  const id = rawId.trim()

  const blockMatch = id.match(/^b(\d+)$/i)
  if (blockMatch) {
    const blockId = parseInt(blockMatch[1]!, 10)
    const block = state.compressionBlocks.find((b) => b.id === blockId && b.active)
    if (!block) throw unknownCompressionIdError(id, state)
    return {
      timestamp: block[field],
      stableId: field === "startTimestamp" ? block.startMessageId : block.endMessageId,
    }
  }

  const meta = state.messageMetaSnapshot.get(id)
  if (meta) return resolveMetaBoundary(meta, field, state)

  const ts = state.messageIdSnapshot.get(id)
  if (ts !== undefined) return { timestamp: ts }

  throw unknownCompressionIdError(id, state)
}

/**
 * Resolve a `MessageIdMeta` to a compression boundary. When the meta is a
 * synthetic placeholder for an active compression block (`meta.blockId` is
 * set), resolve to that block's stored boundary so the caller rolls the
 * block up instead of nesting a new block on top of the placeholder. This
 * A model-visible mNNN may itself represent a previously compressed section.
 */
function resolveMetaBoundary(
  meta: MessageIdMeta,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState,
): ResolvedCompressionBoundary {
  if (meta.blockId !== undefined) {
    const block = state.compressionBlocks.find((b) => b.id === meta.blockId && b.active)
    if (block) {
      return {
        timestamp: block[field],
        stableId: field === "startTimestamp" ? block.startMessageId : block.endMessageId,
      }
    }
  }
  return { timestamp: meta.timestamp, stableId: meta.stableId }
}

/**
 * Determine the anchor timestamp for a compression block — the timestamp of
 * the first raw message that appears strictly after `endTimestamp`.
 */
export function resolveAnchorTimestamp(endTimestamp: number, state: DcpState): number {
  return resolveAnchorBoundary(endTimestamp, state).timestamp
}

export function resolveAnchorBoundary(
  endTimestamp: number,
  state: DcpState,
  endMessageId?: string,
): ResolvedCompressionAnchor {
  const endBoundary = { timestamp: endTimestamp, stableId: endMessageId }
  let anchor: ResolvedCompressionAnchor | null = null
  for (const meta of state.messageMetaSnapshot.values()) {
    if (meta.blockId !== undefined || !Number.isFinite(meta.timestamp)) continue
    const candidate = { timestamp: meta.timestamp, stableId: meta.stableId }
    if (compareCompressionBoundaries(candidate, endBoundary, state) <= 0) continue
    if (anchor === null || compareCompressionBoundaries(candidate, anchor, state) < 0) anchor = candidate
  }
  if (anchor === null) {
    for (const ts of state.messageIdSnapshot.values()) {
      if (ts > endTimestamp && (anchor === null || ts < anchor.timestamp)) anchor = { timestamp: ts }
    }
  }
  return anchor ?? { timestamp: endTimestamp + 1 }
}

export function createRangeCompressionBlock(
  options: CreateRangeCompressionBlockOptions,
): CompressionBlockCreationResult {
  const {
    topic,
    summary,
    startTimestamp,
    endTimestamp,
    startMessageId,
    endMessageId,
    state,
    config,
    anchorTimestamp: requestedAnchorTimestamp,
    anchorMessageId: requestedAnchorMessageId,
    createdByToolCallId,
    mode = "range",
    validatePlaceholders = true,
    expandPlaceholders = true,
  } = options
  const defaultAnchor = resolveAnchorBoundary(endTimestamp, state, endMessageId)
  const anchorTimestamp = requestedAnchorTimestamp ?? defaultAnchor.timestamp
  const anchorMessageId = requestedAnchorMessageId ?? defaultAnchor.stableId
  const ids = { startMessageId, endMessageId }

  if (compareCompressionBoundaries(
    { timestamp: startTimestamp, stableId: startMessageId },
    { timestamp: endTimestamp, stableId: endMessageId },
    state,
  ) > 0) {
    throw new Error("Compression range start must appear before end in the conversation")
  }

  if (!Number.isFinite(startTimestamp)) {
    throw new Error(`Compression range start resolved to a non-finite timestamp (${startTimestamp})`)
  }
  if (!Number.isFinite(endTimestamp)) {
    throw new Error(`Compression range end resolved to a non-finite timestamp (${endTimestamp})`)
  }

  const { coveredBlocks, partialBlocks } = findCoveredAndPartialBlocks(
    startTimestamp,
    endTimestamp,
    state,
    { startMessageId, endMessageId },
  )

  if (partialBlocks.length > 0) {
    const blockList = partialBlocks.map((block) => `b${block.id} "${block.topic}"`).join(", ")
    const freeHints = partialBlocks
      .map((block) => {
        const firstFreeId = firstAddressableRawIdAfterBlock(block, state)
        return firstFreeId ? `first raw ID after b${block.id} is ${firstFreeId}` : undefined
      })
      .filter((hint): hint is string => typeof hint === "string")
    const freeHint = freeHints.length > 0 ? ` ${freeHints.join("; ")}.` : ""
    throw new Error(
      `Compression range partially overlaps existing block(s): ${blockList}. ` +
      `Select the whole block or choose non-overlapping boundaries.${freeHint}`,
    )
  }

  const placeholderSummary = preparePlaceholderSummary(
    summary,
    coveredBlocks,
    state,
    { validatePlaceholders, expandPlaceholders },
  )

  const userPreservedSummary = mode === "range"
    ? appendProtectedUserMessages(
      placeholderSummary,
      startTimestamp,
      endTimestamp,
      state,
      config.compress.protectUserMessages,
      ids,
    )
    : placeholderSummary

  const promptPreservedSummary = appendProtectedPromptInfo(
    userPreservedSummary,
    startTimestamp,
    endTimestamp,
    state,
    config,
    ids,
  )

  const expandedSummary = appendProtectedToolOutputs(
    promptPreservedSummary,
    startTimestamp,
    endTimestamp,
    state,
    config,
    ids,
  )

  const block: CompressionBlock = {
    id: state.nextBlockId++,
    topic,
    summary: expandedSummary,
    startTimestamp,
    endTimestamp,
    startMessageId,
    endMessageId,
    anchorTimestamp,
    anchorMessageId,
    createdByToolCallId,
    active: true,
    summaryTokenEstimate: estimateTokens(expandedSummary),
    createdAt: Date.now(),
    coveredBlockIds: coveredBlocks.map((covered) => covered.id),
    mode,
  }

  state.compressionBlocks.push(block)
  for (const covered of coveredBlocks) {
    covered.active = false
  }

  return {
    block,
    removedTokenEstimate: estimateVisibleRangeTokens(startTimestamp, endTimestamp, coveredBlocks, state, ids),
    summaryTokenEstimate: Math.max(0, Math.round(block.summaryTokenEstimate ?? 0)),
  }
}
