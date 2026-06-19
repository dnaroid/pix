// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto"
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
   * Deduplication fingerprint: `toolName::sha256:<hash>` where the hash is
   * computed over recursively key-sorted args. Two calls with the same name +
   * identical args share the same fingerprint without persisting full args.
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
  /** The actual message.timestamp associated with the model-visible DCP id. */
  timestamp: number
  /** Stable raw message key when available; falls back to timestamp-derived key. */
  stableId?: string
  /** The message role at the time the id was injected. */
  role: string
  /** Present when this addressable message represents an active compression block. */
  blockId?: number
  /** Tool call metadata for tool-result-like messages. */
  toolCallId?: string
  toolName?: string
  /** Plain text extracted from the message when the id was injected. */
  text?: string
  /** Rough token estimate for priority/candidate guidance. */
  tokenEstimate?: number
  /** Optional compression priority marker exposed with the model-visible message ID. */
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
  /** Extra metadata for the model-visible DCP message IDs in messageIdSnapshot. */
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
  /**
   * Total number of tool calls observed during the session lifetime.
   * Persisted so `/dcp stats` can show an approximate total even when the
   * toolCalls map has been trimmed for compactness.
   */
  totalToolCallCount: number
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
  /**
   * The context window observed on the previous `context` event, used to
   * detect a mid-session model/window downgrade (e.g. switch from a 1M model
   * to a 275K model). When the window shrinks and inherited tokens already
   * exceed `minContextPercent`, the context handler forces a pre-emptive
   * strong nudge so the model is told to compress before the window fills.
   * `undefined` until the first context event records a window.
   */
  lastContextWindow?: number
  /**
   * How many consecutive `context-strong` nudges have been emitted without a
   * subsequent successful `compress` (model- or DCP-initiated). When this
   * reaches `compress.autoCompress.patience` while context is above the
   * emergency threshold, the auto-compress fallback creates a block without
   * waiting for the model. Reset to 0 on any successful compression, when
   * pressure drops below the emergency threshold, or on a window change.
   */
  consecutiveIgnoredStrongNudges: number
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
    totalToolCallCount: 0,
    accountedCompressionBlockIds: new Set(),
    compressionTokenSavings: new Map(),
    accountedPrunedToolIds: new Set(),
    manualMode: false,
    nudgeCounter: 0,
    lastNudgeTurn: -1,
    nudgeAnchors: [],
    nextNudgeAnchorId: 1,
    lastNudge: undefined,
    lastContextWindow: undefined,
    consecutiveIgnoredStrongNudges: 0,
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
  state.totalToolCallCount = 0
  state.accountedCompressionBlockIds.clear()
  state.compressionTokenSavings.clear()
  state.accountedPrunedToolIds.clear()
  state.manualMode = false
  state.nudgeCounter = 0
  state.lastNudgeTurn = -1
  state.nudgeAnchors = []
  state.nextNudgeAnchorId = 1
  state.lastNudge = undefined
  state.lastContextWindow = undefined
  state.consecutiveIgnoredStrongNudges = 0
}

/**
 * Merge compression blocks (and their accounting) from a source sidecar into
 * the current state without clobbering other fields. Used at session_start to
 * carry compression state across fork/resume/new into a session whose own
 * sidecar is empty.
 *
 * Returns the number of newly added blocks (blocks whose id already exists are
 * skipped). Accounting is carried over so inherited blocks are neither lost
 * nor double-counted when later folded by a new compression range.
 */
export function inheritCompressionBlocks(state: DcpState, data: unknown): number {
  if (!data || typeof data !== "object") return 0
  const saved = data as Partial<SerializedDcpState>
  if (!Array.isArray(saved.compressionBlocks) || saved.compressionBlocks.length === 0) return 0

  const existingIds = new Set(state.compressionBlocks.map((b) => b.id))
  const validBlocks = saved.compressionBlocks
    .filter(
      (b: any) =>
        b && Number.isFinite(b.startTimestamp) && Number.isFinite(b.endTimestamp),
    )
    .map((b: any) => ({
      ...b,
      anchorTimestamp: Number.isFinite(b.anchorTimestamp)
        ? b.anchorTimestamp
        : b.endTimestamp + 1,
    })) as CompressionBlock[]

  const toAdd = validBlocks.filter((b) => !existingIds.has(b.id))
  if (toAdd.length === 0) return 0

  state.compressionBlocks.push(...toAdd)
  state.nextBlockId =
    Math.max(state.nextBlockId, ...state.compressionBlocks.map((b) => b.id)) + 1

  if (Array.isArray(saved.accountedCompressionBlockIds)) {
    for (const id of saved.accountedCompressionBlockIds) {
      if (typeof id === "number") state.accountedCompressionBlockIds.add(id)
    }
  }
  if (Array.isArray(saved.compressionTokenSavings)) {
    for (const [id, val] of saved.compressionTokenSavings) {
      if (
        typeof id === "number" &&
        typeof val === "number" &&
        !state.compressionTokenSavings.has(id)
      ) {
        state.compressionTokenSavings.set(id, val)
      }
    }
  }
  if (typeof saved.tokensSaved === "number" && saved.tokensSaved > state.tokensSaved) {
    state.tokensSaved = saved.tokensSaved
  }

  return toAdd.length
}

/**
 * Compact tool record for persistence — strips outputText, outputDetails,
 * and truncates/summarises inputArgs to keep serialized state bounded.
 */
export interface CompactToolRecord {
  toolCallId: string
  toolName: string
  inputFingerprint: string
  isError: boolean
  turnIndex: number
  timestamp: number
  tokenEstimate: number
  /**
   * Extracted string values from inputArgs that could match file-protection
   * patterns, persisted so `isProtectedByFilePattern` still works after
   * session restore. Capped to avoid bloating state with huge arg values.
   */
  inputStringValues?: string[]
}

/**
 * Maximum number of recent tool records retained in persisted state.
 * Older records are still kept when referenced by active compression blocks,
 * pruned tool IDs, or accounted prune IDs.
 */
export const PERSISTED_TOOL_CALLS_MAX_RECENT = 200

/**
 * Maximum length of individual string values extracted from inputArgs
 * for file-pattern matching. Longer values are truncated.
 */
const INPUT_STRING_VALUE_MAX_LENGTH = 512

/**
 * Maximum number of inputStringValues to keep per tool record.
 */
const INPUT_STRING_VALUES_MAX_COUNT = 20

export interface SerializedDcpState {
  compressionBlocks: CompressionBlock[]
  nextBlockId: number
  prunedToolIds: string[]
  prunedToolReasons: Array<[string, string]>
  /** Full tool records — present in legacy snapshots. */
  toolCalls?: ToolRecord[]
  /** Compact tool records — present in new compact snapshots. */
  compactToolCalls?: CompactToolRecord[]
  /**
   * Total number of tool calls observed during the session, including those
   * trimmed from the persisted snapshot. Allows `/dcp stats` to report
   * approximate totals.
   */
  totalToolCallCount?: number
  tokensSaved: number
  totalPruneCount: number
  accountedCompressionBlockIds: number[]
  compressionTokenSavings: Array<[number, number]>
  accountedPrunedToolIds: string[]
  manualMode: boolean
  nudgeAnchors?: DcpNudgeAnchor[]
  nextNudgeAnchorId?: number
  lastNudge?: DcpLastNudge
  /**
   * Persisted since v??. `context` events re-seed currentTurn from raw
   * messages, but keeping it across session restarts gives diagnostics and
   * telemetry a contiguous turn counter instead of resetting to 0.
   */
  currentTurn?: number
  /**
   * Persisted since v?.?. Without persistence a pi process restart silently
   * reset the nudge cadence counter to 0, which could suppress the next
   * reminder on a session that was already near a context threshold.
   */
  nudgeCounter?: number
  /** Persisted since v?.?. Diagnostic turn of the last emitted nudge. */
  lastNudgeTurn?: number
  /**
   * Persisted so a mid-session window downgrade (model switch to a smaller
   * context window) is still detectable after a pi process restart / resume.
   */
  lastContextWindow?: number
  /**
   * Persisted so the auto-compress fallback's patience counter survives a pi
   * process restart / resume, preventing a stuck "model ignores strong nudges"
   * state from being silently cleared by a reload.
   */
  consecutiveIgnoredStrongNudges?: number
  /** Hash of the last persisted serialized state, used for dedup. */
  _stateHash?: string
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

function isCompactToolRecord(value: unknown): value is CompactToolRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<CompactToolRecord>
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

// ---------------------------------------------------------------------------
// Compact tool-record helpers
// ---------------------------------------------------------------------------

/**
 * Recursively extract string values from a nested object, matching the
 * logic in `pruner-tools.ts::collectStringValues`. Depth-limited to 6.
 */
function extractStringValues(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out
  if (typeof value === "string") {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) extractStringValues(item, out, depth + 1)
    return out
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      extractStringValues(item, out, depth + 1)
    }
  }
  return out
}

/**
 * Produce a compact tool record for persistence: strip outputText,
 * outputDetails, and reduce inputArgs to just extracted string values
 * for file-pattern protection checking.
 */
export function compactifyToolRecord(record: ToolRecord): CompactToolRecord {
  const stringValues = extractStringValues(record.inputArgs)
  // Truncate individual values and limit total count
  const cappedValues = stringValues
    .slice(0, INPUT_STRING_VALUES_MAX_COUNT)
    .map((v) => (v.length > INPUT_STRING_VALUE_MAX_LENGTH ? v.slice(0, INPUT_STRING_VALUE_MAX_LENGTH) : v))

  const compact: CompactToolRecord = {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    inputFingerprint: record.inputFingerprint,
    isError: record.isError,
    turnIndex: record.turnIndex,
    timestamp: record.timestamp,
    tokenEstimate: record.tokenEstimate,
  }
  if (cappedValues.length > 0) {
    compact.inputStringValues = cappedValues
  }
  return compact
}

/**
 * Determine which tool-call IDs are referenced by active compression blocks
 * (via createdByToolCallId) or by pruned/accounted sets, and therefore must
 * be retained even when trimming old records.
 */
function referencedToolCallIds(state: DcpState): Set<string> {
  const refs = new Set<string>()
  // Tool IDs referenced by active compression blocks
  for (const block of state.compressionBlocks) {
    if (block.active && block.createdByToolCallId) {
      refs.add(block.createdByToolCallId)
    }
  }
  // Pruned tool IDs
  for (const id of state.prunedToolIds) refs.add(id)
  // Accounted pruned tool IDs (superset of prunedToolIds in some cases)
  for (const id of state.accountedPrunedToolIds) refs.add(id)
  return refs
}

/** Serialize runtime state into a JSON-safe object for pi.appendEntry(). */
export function serializeState(state: DcpState): SerializedDcpState {
  // Build compact tool records, keeping referenced + recent ones.
  const allRecords = Array.from(state.toolCalls.values())
  const refs = referencedToolCallIds(state)

  // Sort by timestamp descending so we can pick the most recent ones
  const sorted = allRecords
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)

  const compactToolCalls: CompactToolRecord[] = []
  const seen = new Set<string>()

  // First pass: always include referenced records
  for (const record of sorted) {
    if (refs.has(record.toolCallId)) {
      compactToolCalls.push(compactifyToolRecord(record))
      seen.add(record.toolCallId)
    }
  }

  // Second pass: add recent records up to the limit
  for (const record of sorted) {
    if (seen.has(record.toolCallId)) continue
    if (compactToolCalls.length >= PERSISTED_TOOL_CALLS_MAX_RECENT) break
    compactToolCalls.push(compactifyToolRecord(record))
    seen.add(record.toolCallId)
  }

  return {
    compressionBlocks: state.compressionBlocks,
    nextBlockId: state.nextBlockId,
    prunedToolIds: Array.from(state.prunedToolIds),
    prunedToolReasons: Array.from(state.prunedToolReasons.entries()),
    compactToolCalls,
    totalToolCallCount: allRecords.length,
    tokensSaved: state.tokensSaved,
    totalPruneCount: state.totalPruneCount,
    accountedCompressionBlockIds: Array.from(state.accountedCompressionBlockIds),
    compressionTokenSavings: Array.from(state.compressionTokenSavings.entries()),
    accountedPrunedToolIds: Array.from(state.accountedPrunedToolIds),
    manualMode: state.manualMode,
    nudgeAnchors: state.nudgeAnchors,
    nextNudgeAnchorId: state.nextNudgeAnchorId,
    lastNudge: state.lastNudge,
    currentTurn: state.currentTurn,
    nudgeCounter: state.nudgeCounter,
    lastNudgeTurn: state.lastNudgeTurn,
    lastContextWindow: state.lastContextWindow,
    consecutiveIgnoredStrongNudges: state.consecutiveIgnoredStrongNudges,
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

  if (Array.isArray(saved.compactToolCalls)) {
    // New compact format: restore CompactToolRecords as ToolRecords with
    // synthetic inputArgs derived from inputStringValues.
    state.toolCalls = new Map(
      saved.compactToolCalls
        .filter(isCompactToolRecord)
        .map((compact) => {
          const record: ToolRecord = {
            toolCallId: compact.toolCallId,
            toolName: compact.toolName,
            // Reconstruct minimal inputArgs from persisted string values
            // so isProtectedByFilePattern still works.
            inputArgs: compact.inputStringValues
              ? { _restoredValues: compact.inputStringValues }
              : {},
            inputFingerprint: compact.inputFingerprint,
            isError: compact.isError,
            turnIndex: compact.turnIndex,
            timestamp: compact.timestamp,
            tokenEstimate: compact.tokenEstimate,
            // outputText and outputDetails intentionally not restored —
            // they are only used during live compression block creation.
          }
          return [record.toolCallId, record] as const
        }),
    )
  } else if (Array.isArray(saved.toolCalls)) {
    // Legacy full format: restore as-is for backward compatibility.
    state.toolCalls = new Map(
      saved.toolCalls
        .filter(isToolRecord)
        .map((record) => [record.toolCallId, record] as const),
    )
  }

  if (typeof saved.tokensSaved === "number") state.tokensSaved = saved.tokensSaved
  if (typeof saved.totalPruneCount === "number") state.totalPruneCount = saved.totalPruneCount

  // Restore totalToolCallCount from the persisted snapshot, or fall back to
  // the number of restored tool records (which may be a trimmed subset).
  if (typeof saved.totalToolCallCount === "number" && saved.totalToolCallCount >= 0) {
    state.totalToolCallCount = saved.totalToolCallCount
  } else {
    state.totalToolCallCount = state.toolCalls.size
  }

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

  // nudgeCounter: clamp to a non-negative integer so a corrupted payload
  // cannot stall reminders by going negative. Default 0 keeps older sessions
  // behaving like a fresh cadence on first post-restart context event.
  if (typeof saved.nudgeCounter === "number" && Number.isFinite(saved.nudgeCounter) && saved.nudgeCounter >= 0) {
    state.nudgeCounter = Math.floor(saved.nudgeCounter)
  }

  // lastNudgeTurn and currentTurn default to createState() values when absent
  // (lastNudgeTurn = -1, currentTurn = 0). currentTurn is re-derived from
  // raw messages on every `context` event, so persistence here is best-effort
  // for telemetry continuity rather than authoritative.
  if (typeof saved.lastNudgeTurn === "number" && Number.isFinite(saved.lastNudgeTurn)) {
    state.lastNudgeTurn = Math.floor(saved.lastNudgeTurn)
  }
  if (typeof saved.currentTurn === "number" && Number.isFinite(saved.currentTurn) && saved.currentTurn >= 0) {
    state.currentTurn = Math.floor(saved.currentTurn)
  }
  if (typeof saved.lastContextWindow === "number" && Number.isFinite(saved.lastContextWindow) && saved.lastContextWindow > 0) {
    state.lastContextWindow = saved.lastContextWindow
  }
  if (typeof saved.consecutiveIgnoredStrongNudges === "number" && Number.isFinite(saved.consecutiveIgnoredStrongNudges) && saved.consecutiveIgnoredStrongNudges >= 0) {
    state.consecutiveIgnoredStrongNudges = Math.floor(saved.consecutiveIgnoredStrongNudges)
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
 * Format: `<toolName>::sha256:<hash of recursively key-sorted args>`
 */
export function createInputFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const sorted = sortObjectKeys(args)
  const hash = createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
  return `${toolName}::sha256:${hash}`
}

// ---------------------------------------------------------------------------
// State hashing for save deduplication
// ---------------------------------------------------------------------------

/**
 * Compute a fast hash of serialized state for deduplication.
 * Uses a simple DJB2-like hash over the JSON string. This is not
 * cryptographic — it's only used to avoid writing identical snapshots.
 */
export function hashSerializedState(serialized: SerializedDcpState): string {
  const json = JSON.stringify(serialized)
  let hash = 5381
  for (let i = 0; i < json.length; i++) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}
