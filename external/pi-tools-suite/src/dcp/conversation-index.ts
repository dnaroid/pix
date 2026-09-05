import type { ConversationIndexEntry, DcpState } from "./state.js"
import { PASSTHROUGH_ROLES } from "./pruner-metadata.js"

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

function hasAssistantSignature(message: any): boolean {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false
  return message.content.some((part: any) =>
    part && typeof part === "object" && (
      typeof part.thinkingSignature === "string" ||
      typeof part.signature === "string"
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
      visibleId,
      role: message?.role ?? "",
      timestamp: Number.isFinite(message?.timestamp) ? message.timestamp : undefined,
      blockId: meta?.blockId,
      toolCallId: typeof message?.toolCallId === "string" ? message.toolCallId : meta?.toolCallId,
      toolCallIds: meta?.toolCallIds,
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
