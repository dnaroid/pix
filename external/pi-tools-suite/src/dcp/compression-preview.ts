import type { DcpConfig } from "./config.js"
import { canonicalMessageHash } from "./conversation-index.js"
import { cloneDcpTransactionState } from "./state-transaction.js"
import type { CompressionBlock, ConversationIndexEntry, DcpState } from "./state.js"
import { stripStaleDcpMetadataFromMessage, estimateMessageTokens } from "./pruner-metadata.js"
import { injectMessageIds, stableMessageKeys } from "./pruner-message-ids.js"
import { applyCompressionBlocks } from "./pruner-compression-blocks.js"

/** The latest provider projection is runtime-only and intentionally never persisted. */
const projectionSnapshots = new WeakMap<ConversationIndexEntry[], any[]>()

const DCP_PROVENANCE_KEYS = ["_dcpOrigin", "_dcpStableId", "_dcpBlockId"] as const

function copyDcpProvenance(source: any, target: any): any {
  if (!source || !target || typeof source !== "object" || typeof target !== "object") return target
  for (const key of DCP_PROVENANCE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) Object.defineProperty(target, key, descriptor)
  }
  return target
}

/** Clone message objects while retaining the non-enumerable DCP provenance used by exact spans. */
export function cloneProjectionMessages(messages: readonly any[]): any[] {
  return messages.map((message) => {
    const clone = message && typeof message === "object" ? { ...message } : message
    if (!clone || typeof clone !== "object") return clone
    if (message.content && typeof message.content === "object") clone.content = structuredClone(message.content)
    return copyDcpProvenance(message, clone)
  })
}

/** Store a detached copy of the exact provider projection that produced this index. */
export function recordCompressionProjection(
  entries: ConversationIndexEntry[],
  messages: readonly any[],
): void {
  projectionSnapshots.set(entries, cloneProjectionMessages(messages))
}

function verifiedSnapshot(state: DcpState): any[] {
  const snapshot = projectionSnapshots.get(state.conversationIndexSnapshot)
  if (!snapshot || snapshot.length !== state.conversationIndexSnapshot.length) {
    throw new Error(
      "Manual compression requires a current verifiable provider projection; refresh the DCP context and retry.",
    )
  }
  const stableKeys = stableMessageKeys(snapshot)
  for (let index = 0; index < snapshot.length; index++) {
    const entry = state.conversationIndexSnapshot[index]
    if (!entry || entry.stableId !== stableKeys[index] || entry.contentHash !== canonicalMessageHash(snapshot[index])) {
      throw new Error(
        "Manual compression provider projection no longer matches the current DCP snapshot; refresh the context and retry.",
      )
    }
  }
  return snapshot
}

function stripProjectionMetadata(message: any): any {
  const stripped = stripStaleDcpMetadataFromMessage(message)
  return copyDcpProvenance(message, stripped)
}

export interface ManualCompressionProjection {
  projectedBeforeTokens: number
  projectedAfterTokens: number
  netGain: number
}

/**
 * Materialize only an operation's new blocks against the exact current
 * provider projection. Existing blocks are already represented there as
 * synthetic entries, so replaying them would double-count and hide a bad
 * manual summary behind unrelated automatic pruning.
 */
export function previewManualCompressionProjection(
  state: DcpState,
  config: DcpConfig,
  newBlocks: CompressionBlock[],
): ManualCompressionProjection {
  const source = verifiedSnapshot(state)
  const before = cloneProjectionMessages(source)
  const after = cloneProjectionMessages(source).map(stripProjectionMetadata)
  const previewState = cloneDcpTransactionState(state)
  previewState.compressionBlocks = newBlocks.map((block) => structuredClone(block))
  previewState.accountedCompressionBlockIds = new Set()
  previewState.compressionTokenSavings = new Map()

  applyCompressionBlocks(after, previewState)
  const appliedBlockIds = new Set(
    after.flatMap((message) => Number.isInteger(message?._dcpBlockId) ? [message._dcpBlockId as number] : []),
  )
  const missing = newBlocks.filter((block) => !appliedBlockIds.has(block.id))
  if (missing.length > 0) {
    throw new Error(
      `Manual compression could not materialize ${missing.map((block) => `b${block.id}`).join(", ")} in the current provider projection; no state was published.`,
    )
  }

  // Recreate carrier overhead on a detached state. This deliberately happens
  // after applying the wrapper so the comparison includes the full delivered
  // provider projection rather than just summary text.
  injectMessageIds(after, previewState, { config })
  const projectedBeforeTokens = before.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const projectedAfterTokens = after.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  return {
    projectedBeforeTokens,
    projectedAfterTokens,
    netGain: projectedBeforeTokens - projectedAfterTokens,
  }
}
