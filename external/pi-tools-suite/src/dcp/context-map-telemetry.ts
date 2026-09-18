import { detectToolGroupSpans, findConversationIndexEntry } from "./conversation-index.js"
import { estimateMessageTokens, stripStaleDcpMetadataFromMessage } from "./pruner-metadata.js"
import type { CompressionCandidate } from "./pruner-types.js"
import type { DcpState } from "./state.js"

export interface DcpContextMapTelemetry {
  readonly revision: number
  readonly sessionEpoch: number
  readonly generatedAt: number
  readonly tokenEstimates: {
    readonly candidate: number
    readonly protected: number
    readonly compressed: number
    readonly retained: number
  }
}

type ContextMapKind = keyof DcpContextMapTelemetry["tokenEstimates"]

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Capture immediately after applyPruning, before any await or carrier changes. */
export function captureDcpContextTokenEstimates(
  entries: DcpState["conversationIndexSnapshot"],
  preparedMessages: readonly any[],
  metadata: DcpState["messageMetaSnapshot"],
): number[] | undefined {
  if (entries.length !== preparedMessages.length) return undefined
  const tokens: number[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const message = preparedMessages[index]
    if (entry.index !== index || entry.role !== (message?.role ?? "")) return undefined
    const cached = entry.visibleId ? metadata.get(entry.visibleId) : undefined
    // Reuse the body estimate made by this exact pruning pass. Non-addressable
    // messages have no cache; only these need the ordinary content estimator.
    const estimate = cached?.contentHash === entry.contentHash && cached.tokenEstimate !== undefined
      ? cached.tokenEstimate
      : estimateMessageTokens(stripStaleDcpMetadataFromMessage(message))
    if (!isSafeNonnegativeInteger(estimate)) return undefined
    tokens.push(estimate)
  }
  return tokens
}

/** Classifies the already-prepared provider projection without reading history or planning. */
export function projectDcpContextMapTelemetry(
  entries: DcpState["conversationIndexSnapshot"],
  candidate: CompressionCandidate | null,
  preparedTokenEstimates: readonly number[] | undefined,
  revision: number,
  sessionEpoch: number,
  generatedAt = Date.now(),
): DcpContextMapTelemetry | undefined {
  if (
    entries.length === 0 || entries.length !== preparedTokenEstimates?.length ||
    !isSafeNonnegativeInteger(revision) || revision === 0 || !isSafeNonnegativeInteger(sessionEpoch) ||
    !isSafeNonnegativeInteger(generatedAt) || generatedAt === 0 || !Number.isFinite(new Date(generatedAt).getTime())
  ) return undefined

  const protectedIndexes = new Set<number>()
  for (const group of detectToolGroupSpans(entries)) {
    if (!group.complete) {
      for (let index = group.startIndex; index <= group.endIndex; index++) protectedIndexes.add(index)
    }
  }
  const candidateIndexes = new Set<number>()
  if (candidate) {
    const start = findConversationIndexEntry(entries, candidate.startId)?.index
    const end = findConversationIndexEntry(entries, candidate.endId)?.index
    if (start !== undefined && end !== undefined) {
      for (let index = Math.min(start, end); index <= Math.max(start, end); index++) candidateIndexes.add(index)
    }
  }

  const tokenEstimates: Record<ContextMapKind, number> = {
    candidate: 0, protected: 0, compressed: 0, retained: 0,
  }
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    const tokens = preparedTokenEstimates[index]
    if (!isSafeNonnegativeInteger(tokens)) return undefined
    const kind: ContextMapKind = entry.origin === "dcp-control" ? "retained"
      : protectedIndexes.has(index) ? "protected"
      : candidateIndexes.has(index) ? "candidate"
      : entry.origin === "block" && entry.blockId !== undefined ? "compressed"
      : "retained"
    if (!Number.isSafeInteger(tokenEstimates[kind] + tokens)) return undefined
    tokenEstimates[kind] += tokens
  }
  const total = tokenEstimates.candidate + tokenEstimates.protected + tokenEstimates.compressed + tokenEstimates.retained
  if (!Number.isSafeInteger(total) || total <= 0) return undefined
  return { revision, sessionEpoch, generatedAt, tokenEstimates }
}
