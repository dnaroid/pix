import { createHash } from "node:crypto"
import {
  hasExactCompressionMembership,
  type CompressionMember,
  type ConversationIndexEntry,
  type DcpState,
} from "./state.js"
import { PASSTHROUGH_ROLES, stripStaleDcpMetadataLines } from "./pruner-metadata.js"

export interface ToolGroupSpan {
  startIndex: number
  endIndex: number
  toolCallIds: string[]
  complete: boolean
}

export interface ClosedRangeSelection {
  requestedStartIndex: number
  requestedEndIndex: number
  startIndex: number
  endIndex: number
  startId?: string
  endId?: string
  expanded: boolean
  incompleteToolGroup: boolean
}

export interface ExactRangeMembership {
  /** Provider-projection entries that were actually given to the summarizer. */
  sourceMembers: CompressionMember[]
  /** Canonical raw entries that a future materialization may replace. */
  mutationMembers: CompressionMember[]
  /** Indices of selected non-control source entries in the supplied projection. */
  sourceIndexes: number[]
}

const IDENTITY_ONLY_MESSAGE_KEYS = new Set([
  "id",
  "entryId",
  "messageId",
  "_dcpEntryId",
  "_dcpStableId",
  "_dcpOrigin",
  "_dcpBlockId",
  // Timestamp is transport/order metadata. A stable branch identity + content
  // hash must survive hosts that normalize timestamps during reload/import.
  "timestamp",
])

function canonicalContentForMessageHash(message: any): unknown {
  if (!Array.isArray(message?.content)) {
    if (message?.role === "assistant") return message?.content ?? ""
    return stripDcpCarrierText(typeof message?.content === "string" ? message.content : "")
  }

  if (message?.role === "assistant") return message.content

  return message.content.flatMap((part: any) => {
    if (!part || typeof part !== "object") return [part]
    const next = { ...part }
    if (typeof next.text === "string") {
      const text = stripDcpCarrierText(next.text)
      if (!text && next.type === "text") return []
      next.text = text
    }
    if (typeof next.thinking === "string") {
      const thinking = stripDcpCarrierText(next.thinking)
      if (!thinking && next.type === "thinking") return []
      next.thinking = thinking
    }
    return [next]
  })
}

function stripDcpCarrierText(text: string): string {
  return stripStaleDcpMetadataLines(text)
}

function canonicalHashValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "undefined") return "[undefined]"
  if (typeof value === "function" || typeof value === "symbol") return String(value)
  if (Array.isArray(value)) return value.map((item) => canonicalHashValue(item, seen))
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[cycle]"
    seen.add(value as object)
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalHashValue((value as Record<string, unknown>)[key], seen)
    }
    seen.delete(value as object)
    return output
  }
  return String(value)
}

/**
 * Hash a message without mutating it. Assistant content is intentionally
 * copied byte-for-byte into the canonical value: signatures/thinking blocks
 * are never stripped or normalized by DCP membership accounting.
 */
export function canonicalMessageHash(message: any): string {
  const canonical: Record<string, unknown> = {}
  if (message && typeof message === "object") {
    for (const key of Object.keys(message).sort()) {
      if (IDENTITY_ONLY_MESSAGE_KEYS.has(key)) continue
      canonical[key] = key === "content"
        ? canonicalContentForMessageHash(message)
        : canonicalHashValue(message[key])
    }
  } else {
    canonical.value = canonicalHashValue(message)
  }
  return createHash("sha256").update(JSON.stringify(canonicalHashValue(canonical))).digest("hex")
}

function hasAssistantSignature(message: any): boolean {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false
  return message.content.some((part: any) =>
    part &&
    typeof part === "object" &&
    // These are the SDK's opaque replay fields. Presence is enough to freeze
    // the whole assistant message: a malformed/empty signature is not a
    // reason to rewrite the nested provider-owned content around it.
    (
      Object.prototype.hasOwnProperty.call(part, "textSignature") ||
      Object.prototype.hasOwnProperty.call(part, "thinkingSignature")
    ),
  )
}

export function buildConversationIndex(
  messages: any[],
  stableKeys: string[],
  state: DcpState,
): ConversationIndexEntry[] {
  const visibleByStableId = new Map<string, string>()
  for (const [visibleId, meta] of state.messageMetaSnapshot) {
    if (meta.stableId) visibleByStableId.set(meta.stableId, visibleId)
  }

  return messages.map((message, index) => {
    const stableId = stableKeys[index]!
    const visibleId = visibleByStableId.get(stableId)
    const meta = visibleId ? state.messageMetaSnapshot.get(visibleId) : undefined
    return {
      index,
      stableId,
      contentHash: canonicalMessageHash(message),
      visibleId,
      role: message?.role ?? "",
      timestamp: Number.isFinite(message?.timestamp) ? message.timestamp : undefined,
      blockId: meta?.blockId,
      toolCallId: typeof message?.toolCallId === "string" ? message.toolCallId : meta?.toolCallId,
      toolCallIds: message?.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === "toolCall" && typeof part.id === "string").map((part: any) => part.id)
        : undefined,
      passthrough: PASSTHROUGH_ROLES.has(message?.role ?? ""),
      origin: message?._dcpOrigin === "block"
        ? "block"
        : message?._dcpOrigin === "dcp-control"
          ? "dcp-control"
          : "raw",
      signedAssistant: hasAssistantSignature(message),
    }
  })
}

function addressableAliases(entry: ConversationIndexEntry): string[] {
  return [
    ...(entry.visibleId ? [entry.visibleId] : []),
    ...(entry.blockId !== undefined ? [`b${entry.blockId}`] : []),
  ]
}

export function findConversationIndexEntry(
  entries: ConversationIndexEntry[],
  id: string,
): ConversationIndexEntry | undefined {
  const normalized = id.trim().toLowerCase()
  return entries.find((entry) =>
    addressableAliases(entry).some((alias) => alias.toLowerCase() === normalized),
  )
}

/**
 * Return canonical branch order for two stable identities when both are
 * represented by the current projection. An active block's raw boundaries are
 * deliberately resolved to its single projected placeholder, so roll-ups use
 * projection order rather than timestamp or mNNN allocation order.
 */
export function compareConversationStableIds(
  entries: ConversationIndexEntry[],
  leftStableId: string | undefined,
  rightStableId: string | undefined,
  state: DcpState,
): number | undefined {
  if (!leftStableId || !rightStableId) return undefined
  if (leftStableId === rightStableId) return 0

  const projectedIndexFor = (stableId: string): number | undefined => {
    const direct = entries.find((entry) => entry.stableId === stableId)
    if (direct) return direct.index

    const block = state.compressionBlocks.find((candidate) =>
      candidate.active && candidate.version === 2 && hasExactCompressionMembership(candidate) &&
      (candidate.startMessageId === stableId || candidate.endMessageId === stableId),
    )
    if (!block) return undefined
    return entries.find((entry) => entry.blockId === block.id)?.index
  }

  const left = projectedIndexFor(leftStableId)
  const right = projectedIndexFor(rightStableId)
  if (left === undefined || right === undefined) return undefined
  return left - right
}

function appendUniqueMembers(
  target: CompressionMember[],
  members: CompressionMember[],
): boolean {
  const existing = new Map(target.map((member) => [member.stableId, member.hash]))
  for (const member of members) {
    const priorHash = existing.get(member.stableId)
    if (priorHash !== undefined) {
      if (priorHash !== member.hash) return false
      continue
    }
    target.push({ stableId: member.stableId, hash: member.hash })
    existing.set(member.stableId, member.hash)
  }
  return true
}

/**
 * Convert a closed projection selection into both source and raw mutation
 * membership. A synthetic block contributes its own visible source entry and
 * expands only through its already-persisted raw mutation membership. This is
 * what prevents a later materialization from rediscovering a timestamp span.
 */
export function buildExactRangeMembership(
  entries: ConversationIndexEntry[],
  startId: string,
  endId: string,
  state: DcpState,
  messageBody = false,
): ExactRangeMembership | undefined {
  const entry = messageBody ? findConversationIndexEntry(entries, startId) : undefined
  const closure = messageBody
    ? entry && { startIndex: entry.index, endIndex: entry.index, incompleteToolGroup: false }
    : closeConversationRange(entries, startId, endId)
  if (!closure || closure.incompleteToolGroup) return undefined

  const sourceMembers: CompressionMember[] = []
  const mutationMembers: CompressionMember[] = []
  const sourceIndexes: number[] = []
  for (let index = closure.startIndex; index <= closure.endIndex; index++) {
    const entry = entries[index]!
    // DCP control-plane entries are never source material and must not become
    // accidental raw mutation members merely because they sit between IDs.
    if (entry.origin === "dcp-control") continue
    if (!entry.stableId || !entry.contentHash) return undefined
    sourceMembers.push({ stableId: entry.stableId, hash: entry.contentHash })
    sourceIndexes.push(entry.index)

    if (entry.origin === "raw") {
      if (!appendUniqueMembers(mutationMembers, [{ stableId: entry.stableId, hash: entry.contentHash }])) {
        return undefined
      }
      continue
    }

    if (entry.origin !== "block" || entry.blockId === undefined) return undefined
    const block = state.compressionBlocks.find((candidate) => candidate.id === entry.blockId && candidate.active)
    if (!block || !hasExactCompressionMembership(block)) return undefined
    if (!appendUniqueMembers(mutationMembers, block.mutationMembers!)) return undefined
  }

  if (sourceMembers.length === 0 || mutationMembers.length === 0) return undefined
  return { sourceMembers, mutationMembers, sourceIndexes }
}

export function detectToolGroupSpans(entries: ConversationIndexEntry[]): ToolGroupSpan[] {
  const groups: ToolGroupSpan[] = []

  for (let i = 0; i < entries.length; i++) {
    const assistant = entries[i]!
    if (assistant.role !== "assistant" || !assistant.toolCallIds?.length) continue

    const pending = new Set(assistant.toolCallIds)
    let endIndex = i
    for (let j = i + 1; j < entries.length; j++) {
      const entry = entries[j]!
      if (entry.passthrough) {
        endIndex = j
        continue
      }
      if (
        (entry.role === "toolResult" || entry.role === "bashExecution") &&
        entry.toolCallId &&
        pending.has(entry.toolCallId)
      ) {
        pending.delete(entry.toolCallId)
        endIndex = j
        if (pending.size === 0) break
        continue
      }
      break
    }

    groups.push({
      startIndex: i,
      endIndex,
      toolCallIds: [...assistant.toolCallIds],
      complete: pending.size === 0,
    })
  }

  return groups
}

function nearestAddressableId(
  entries: ConversationIndexEntry[],
  index: number,
  direction: 1 | -1,
): string | undefined {
  for (let i = index; i >= 0 && i < entries.length; i += direction) {
    const entry = entries[i]!
    if (entry.blockId !== undefined) return `b${entry.blockId}`
    if (entry.visibleId) return entry.visibleId
  }
  return undefined
}

export function closeConversationRange(
  entries: ConversationIndexEntry[],
  startId: string,
  endId: string,
): ClosedRangeSelection | undefined {
  const startEntry = findConversationIndexEntry(entries, startId)
  const endEntry = findConversationIndexEntry(entries, endId)
  if (!startEntry || !endEntry) return undefined

  const requestedStartIndex = Math.min(startEntry.index, endEntry.index)
  const requestedEndIndex = Math.max(startEntry.index, endEntry.index)
  let startIndex = requestedStartIndex
  let endIndex = requestedEndIndex
  let incompleteToolGroup = false
  const groups = detectToolGroupSpans(entries)

  let changed: boolean
  do {
    changed = false
    for (const group of groups) {
      const overlaps = group.startIndex <= endIndex && group.endIndex >= startIndex
      if (!overlaps) continue
      if (!group.complete) incompleteToolGroup = true
      const nextStart = Math.min(startIndex, group.startIndex)
      const nextEnd = Math.max(endIndex, group.endIndex)
      if (nextStart !== startIndex || nextEnd !== endIndex) changed = true
      startIndex = nextStart
      endIndex = nextEnd
    }
  } while (changed)

  return {
    requestedStartIndex,
    requestedEndIndex,
    startIndex,
    endIndex,
    startId: nearestAddressableId(entries, startIndex, 1),
    endId: nearestAddressableId(entries, endIndex, -1),
    expanded: startIndex !== requestedStartIndex || endIndex !== requestedEndIndex,
    incompleteToolGroup,
  }
}
