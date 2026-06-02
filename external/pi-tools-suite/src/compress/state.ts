// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { DcpNudgeType } from "./pruner-types.js"

/**
 * A record of a single tool call, keyed by toolCallId in DcpState.toolCalls.
 */
export interface ToolRecord {
  /** Matches ToolResultMessage.toolCallId */
  toolCallId: string
  /** Matches ToolResultMessage.toolName */
  toolName: string
  /** The arguments passed to the tool (from the corresponding ToolCall) */
  inputArgs: Record<string, unknown>
  /**
   * Deduplication fingerprint: `toolName::JSON(sortedArgs)`
   * Two calls with the same name + identical args share the same fingerprint.
   */
  inputFingerprint: string
  /** Whether the tool result was an error */
  isError: boolean
  /**
   * Zero-based index of the user turn during which this tool was called.
   * Incremented each time a user message is encountered in the context stream.
   */
  turnIndex: number
  /** message.timestamp from the ToolResultMessage */
  timestamp: number
  /** Rough token estimate: sum of result text content lengths divided by 4 */
  tokenEstimate: number
  /** Completed textual tool output captured for protected-summary preservation. */
  outputText?: string
  /** Optional tool-specific result details captured for protected-summary preservation. */
  outputDetails?: unknown
}

export interface MessageIdMeta {
  /** The actual message.timestamp associated with the visible DCP id. */
  timestamp: number
  /** Stable raw message key when available; falls back to timestamp-derived key. */
  stableId?: string
  /** The message role at the time the id was injected. */
  role: string
  /** Present when this visible message represents an active compression block. */
  blockId?: number
  /** Tool call metadata for tool-result-like messages. */
  toolCallId?: string
  toolName?: string
  /** Plain text extracted from the message when the id was injected. */
  text?: string
  /** Rough token estimate for priority/candidate guidance. */
  tokenEstimate?: number
  /** Optional compression priority marker exposed with the visible message ID. */
  priority?: "low" | "medium" | "high"
}

/**
 * A compression block created by the `compress` tool.
 * Tracks the range of messages that were summarised and where to inject the
 * summary back into the context.
 */
export interface CompressionBlock {
  /** Auto-incrementing integer ID */
  id: number
  /** Short human-readable topic label */
  topic: string
  /** LLM-generated summary text */
  summary: string
  /** Timestamp of the first message in the compressed range */
  startTimestamp: number
  /** Timestamp of the last message in the compressed range */
  endTimestamp: number
  /** Stable key of the first raw message when known. */
  startMessageId?: string
  /** Stable key of the last raw message when known. */
  endMessageId?: string
  /**
   * Timestamp of the first message *after* the range — the summary is injected
   * immediately before this message.  Set to `Infinity` when the range extends
   * to the end of the conversation.
   */
  anchorTimestamp: number
  /** Stable key of the raw message immediately after the range when known. */
  anchorMessageId?: string
  /** Tool call ID of the compress invocation that created this block. */
  createdByToolCallId?: string
  /** Whether this block is still being applied (false = soft-deleted) */
  active: boolean
  /** Token estimate for the summary text itself */
  summaryTokenEstimate: number
  /** Wall-clock time the block was created (Date.now()) */
  createdAt: number
  /** Older compression blocks subsumed by this block during roll-up. */
  coveredBlockIds?: number[]
  /** Whether this block was created from a range or a single raw message. */
  mode?: "range" | "message"
  /** Set when a user explicitly decompressed this block via /dcp decompress. */
  deactivatedByUser?: boolean
  /** Internal reason for automatic soft-deactivation. */
  deactivatedReason?: string
}

export interface DcpNudgeAnchor {
  /** Monotonic local identifier for persisted reminder anchors. */
  id: number
  /** Kind of reminder that should be re-injected at this anchor. */
  type: DcpNudgeType
  /** Timestamp of the message that owns the reminder. */
  anchorTimestamp: number
  /** Stable raw message key for the anchor when available. */
  anchorStableId?: string
  /** Role of the anchored message at creation time. */
  anchorRole: string
  /** User turn index at creation time. */
  turnIndex: number
  /** Approximate context usage that triggered the reminder, as a 0-1 fraction. */
  contextPercent?: number
  /** Wall-clock creation time. */
  createdAt: number
  /** Wall-clock time of the latest re-application/update. */
  updatedAt: number
}

export interface DcpLastNudge {
  type: DcpNudgeType
  anchorId: number
  anchorTimestamp: number
  anchorStableId?: string
  contextPercent?: number
  createdAt: number
}

/**
 * Full runtime state for the DCP extension.
 */
export interface DcpState {
  // ── Tool tracking ──────────────────────────────────────────────────────────
  /** toolCallId → ToolRecord, populated when a tool_result event fires */
  toolCalls: Map<string, ToolRecord>
  /** Set of toolCallIds whose result messages should be suppressed in context */
  prunedToolIds: Set<string>
  /** toolCallId → reason used for human-readable pruning placeholders/stats. */
  prunedToolReasons: Map<string, string>

  // ── Compression ────────────────────────────────────────────────────────────
  /** All compression blocks (both active and soft-deleted) */
  compressionBlocks: CompressionBlock[]
  /** Monotonically increasing counter used to assign CompressionBlock.id */
  nextBlockId: number

  // ── Message ID snapshot ────────────────────────────────────────────────────
  /**
   * Maps the short LLM-visible message IDs (e.g. "m001") to the actual
   * `timestamp` of that message as seen in the last `context` event.
   *
   * The `compress` tool receives ID strings from the LLM; this map lets us
   * translate them back to real timestamps so compression blocks can reference
   * message positions by timestamp (which is stable across pruning passes).
   */
  messageIdSnapshot: Map<string, number>
  /** Extra metadata for the visible DCP message IDs in messageIdSnapshot. */
  messageMetaSnapshot: Map<string, MessageIdMeta>

  // ── Turn tracking ──────────────────────────────────────────────────────────
  /**
   * Zero-based index of the current user turn.
   * Incremented each time a user message is encountered while processing the
   * context array in the `context` event handler.
   */
  currentTurn: number

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Running total of tokens estimated to have been saved by pruning/compression */
  tokensSaved: number
  /** Number of discrete pruning operations performed */
  totalPruneCount: number
  /** Compression block IDs already counted in tokensSaved/totalPruneCount. */
  accountedCompressionBlockIds: Set<number>
  /** compressionBlockId → raw active-token savings estimate for that block. */
  compressionTokenSavings: Map<number, number>
  /** Tool result IDs already counted in tokensSaved/totalPruneCount. */
  accountedPrunedToolIds: Set<string>
  // ── Mode ───────────────────────────────────────────────────────────────────
  /**
   * When true, the extension will not autonomously emit compress nudges.
   * Automatic deduplication/error-purge strategies may still run depending on
   * the `manualMode.automaticStrategies` config flag.
   */
  manualMode: boolean

  // ── Nudge state ────────────────────────────────────────────────────────────
  /**
   * How many `context` events have fired since the last compress nudge was
   * emitted.  Reset to 0 after each nudge.
   */
  nudgeCounter: number
  /**
   * The value of `currentTurn` at the time the last nudge was emitted.
   * Kept as diagnostic/session state only. Nudges are intentionally not
   * throttled to once per user turn: long autonomous work loops can consume a
   * lot of context before the next user message, so nudgeFrequency must be able
   * to emit repeated reminders inside the same turn.
   */
  lastNudgeTurn: number
  /** Persisted anchors where active reminders are injected until compression happens. */
  nudgeAnchors: DcpNudgeAnchor[]
  /** Next monotonic anchor ID. */
  nextNudgeAnchorId: number
  /** Diagnostic/telemetry snapshot for the latest emitted reminder. */
  lastNudge?: DcpLastNudge
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a fresh, zeroed DcpState instance. */
export function createState(): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    prunedToolReasons: new Map(),
    compressionBlocks: [],
    nextBlockId: 1,
    messageIdSnapshot: new Map(),
    messageMetaSnapshot: new Map(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    accountedCompressionBlockIds: new Set(),
    compressionTokenSavings: new Map(),
    accountedPrunedToolIds: new Set(),
    manualMode: false,
    nudgeCounter: 0,
    lastNudgeTurn: -1,
    nudgeAnchors: [],
    nextNudgeAnchorId: 1,
    lastNudge: undefined,
  }
}

/**
 * Reset `state` back to its initial values **in-place**.
 * Preserves the object reference so other modules holding a reference see the
 * reset immediately.
 */
export function resetState(state: DcpState): void {
  state.toolCalls.clear()
  state.prunedToolIds.clear()
  state.prunedToolReasons.clear()
  state.compressionBlocks = []
  state.nextBlockId = 1
  state.messageIdSnapshot.clear()
  state.messageMetaSnapshot.clear()
  state.currentTurn = 0
  state.tokensSaved = 0
  state.totalPruneCount = 0
  state.accountedCompressionBlockIds.clear()
  state.compressionTokenSavings.clear()
  state.accountedPrunedToolIds.clear()
  state.manualMode = false
  state.nudgeCounter = 0
  state.lastNudgeTurn = -1
  state.nudgeAnchors = []
  state.nextNudgeAnchorId = 1
  state.lastNudge = undefined
}

export interface SerializedDcpState {
  compressionBlocks: CompressionBlock[]
  nextBlockId: number
  prunedToolIds: string[]
  prunedToolReasons: Array<[string, string]>
  toolCalls: ToolRecord[]
  tokensSaved: number
  totalPruneCount: number
  accountedCompressionBlockIds: number[]
  compressionTokenSavings: Array<[number, number]>
  accountedPrunedToolIds: string[]
  manualMode: boolean
  nudgeAnchors?: DcpNudgeAnchor[]
  nextNudgeAnchorId?: number
  lastNudge?: DcpLastNudge
}

function isToolRecord(value: unknown): value is ToolRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<ToolRecord>
  return (
    typeof record.toolCallId === "string" &&
    typeof record.toolName === "string" &&
    typeof record.inputFingerprint === "string"
  )
}

function isNudgeAnchor(value: unknown): value is DcpNudgeAnchor {
  if (!value || typeof value !== "object") return false
  const anchor = value as Partial<DcpNudgeAnchor>
  return (
    typeof anchor.id === "number" &&
    typeof anchor.type === "string" &&
    Number.isFinite(anchor.anchorTimestamp) &&
    typeof anchor.anchorRole === "string" &&
    typeof anchor.turnIndex === "number" &&
    typeof anchor.createdAt === "number" &&
    typeof anchor.updatedAt === "number"
  )
}

function isLastNudge(value: unknown): value is DcpLastNudge {
  if (!value || typeof value !== "object") return false
  const nudge = value as Partial<DcpLastNudge>
  return (
    typeof nudge.type === "string" &&
    typeof nudge.anchorId === "number" &&
    Number.isFinite(nudge.anchorTimestamp) &&
    typeof nudge.createdAt === "number"
  )
}

/** Serialize runtime state into a JSON-safe object for pi.appendEntry(). */
export function serializeState(state: DcpState): SerializedDcpState {
  return {
    compressionBlocks: state.compressionBlocks,
    nextBlockId: state.nextBlockId,
    prunedToolIds: Array.from(state.prunedToolIds),
    prunedToolReasons: Array.from(state.prunedToolReasons.entries()),
    toolCalls: Array.from(state.toolCalls.values()),
    tokensSaved: state.tokensSaved,
    totalPruneCount: state.totalPruneCount,
    accountedCompressionBlockIds: Array.from(state.accountedCompressionBlockIds),
    compressionTokenSavings: Array.from(state.compressionTokenSavings.entries()),
    accountedPrunedToolIds: Array.from(state.accountedPrunedToolIds),
    manualMode: state.manualMode,
    nudgeAnchors: state.nudgeAnchors,
    nextNudgeAnchorId: state.nextNudgeAnchorId,
    lastNudge: state.lastNudge,
  }
}

/**
 * Restore persisted DCP state into an already-reset state object.
 * Handles older persisted payloads that did not include the newer accounting
 * and tool-call fingerprint fields.
 */
export function restoreState(state: DcpState, data: unknown): void {
  if (!data || typeof data !== "object") return
  const saved = data as Partial<SerializedDcpState>

  if (Array.isArray(saved.compressionBlocks)) {
    const validBlocks = saved.compressionBlocks
      .filter((b: any) => Number.isFinite(b?.startTimestamp) && Number.isFinite(b?.endTimestamp))
      .map((b: any) => ({
        ...b,
        anchorTimestamp: Number.isFinite(b.anchorTimestamp)
          ? b.anchorTimestamp
          : b.endTimestamp + 1,
      })) as CompressionBlock[]
    state.compressionBlocks = validBlocks
    state.nextBlockId =
      typeof saved.nextBlockId === "number"
        ? saved.nextBlockId
        : validBlocks.length > 0
          ? Math.max(0, ...validBlocks.map((b) => b.id)) + 1
          : 1
  }

  if (Array.isArray(saved.prunedToolIds)) {
    state.prunedToolIds = new Set(saved.prunedToolIds.filter((id): id is string => typeof id === "string"))
  }

  if (Array.isArray(saved.prunedToolReasons)) {
    state.prunedToolReasons = new Map(
      saved.prunedToolReasons.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    )
  }

  if (Array.isArray(saved.toolCalls)) {
    state.toolCalls = new Map(
      saved.toolCalls
        .filter(isToolRecord)
        .map((record) => [record.toolCallId, record] as const),
    )
  }

  if (typeof saved.tokensSaved === "number") state.tokensSaved = saved.tokensSaved
  if (typeof saved.totalPruneCount === "number") state.totalPruneCount = saved.totalPruneCount

  if (Array.isArray(saved.accountedCompressionBlockIds)) {
    state.accountedCompressionBlockIds = new Set(
      saved.accountedCompressionBlockIds.filter((id): id is number => typeof id === "number"),
    )
  } else {
    // Old payloads already persisted aggregate stats but not per-block accounting.
    // Treat existing active blocks as accounted to avoid inflated stats after reload.
    state.accountedCompressionBlockIds = new Set(state.compressionBlocks.map((b) => b.id))
  }

  if (Array.isArray(saved.compressionTokenSavings)) {
    state.compressionTokenSavings = new Map(
      saved.compressionTokenSavings.filter(
        (entry): entry is [number, number] =>
          Array.isArray(entry) && typeof entry[0] === "number" && typeof entry[1] === "number",
      ),
    )
  }

  if (Array.isArray(saved.accountedPrunedToolIds)) {
    state.accountedPrunedToolIds = new Set(
      saved.accountedPrunedToolIds.filter((id): id is string => typeof id === "string"),
    )
  } else {
    // Same migration safety for pre-accounting payloads.
    state.accountedPrunedToolIds = new Set(state.prunedToolIds)
  }

  if (typeof saved.manualMode === "boolean") {
    state.manualMode = saved.manualMode
  }

  if (Array.isArray(saved.nudgeAnchors)) {
    const seen = new Set<string>()
    state.nudgeAnchors = saved.nudgeAnchors
      .filter(isNudgeAnchor)
      .filter((anchor) => {
        const key = `${anchor.anchorStableId ?? ""}|${anchor.anchorTimestamp}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  if (typeof saved.nextNudgeAnchorId === "number" && saved.nextNudgeAnchorId > 0) {
    state.nextNudgeAnchorId = Math.floor(saved.nextNudgeAnchorId)
  } else if (state.nudgeAnchors.length > 0) {
    state.nextNudgeAnchorId = Math.max(...state.nudgeAnchors.map((anchor) => anchor.id)) + 1
  }

  if (isLastNudge(saved.lastNudge)) {
    state.lastNudge = saved.lastNudge
  }
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Recursively sort the keys of a plain object so that two argument objects
 * with the same entries in different key-insertion order produce the same JSON.
 */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys)
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
  }
  return value
}

/**
 * Create a stable deduplication fingerprint for a tool call.
 *
 * Two calls with the same `toolName` and semantically identical `args`
 * (regardless of key ordering) will produce the same fingerprint.
 *
 * Format: `<toolName>::<JSON of recursively key-sorted args>`
 */
export function createInputFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const sorted = sortObjectKeys(args)
  return `${toolName}::${JSON.stringify(sorted)}`
}
