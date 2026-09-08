// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto"
import type { DcpNudgeType } from "./pruner-types.js"
import type { DcpBlockedReason } from "./progress-controller.js"

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
  /** Stable input fingerprint: `toolName::sha256:<hash>` over key-sorted args. */
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
  /** SHA-256 of canonical provider-visible content at snapshot publication. */
  contentHash?: string
  /** The message role at the time the id was injected. */
  role: string
  /** Present when this addressable message represents an active compression block. */
  blockId?: number
  /** Tool call metadata for tool-result-like messages. */
  toolCallId?: string
  toolName?: string
  /** Tool calls emitted by an assistant message; these messages are structurally coupled to their results. */
  toolCallIds?: string[]
  /** Plain text extracted from the message when the id was injected. */
  text?: string
  /** Rough token estimate for priority/candidate guidance. */
  tokenEstimate?: number
  /** Optional compression priority marker exposed with the model-visible message ID. */
  priority?: "low" | "medium" | "high"
}

export interface ConversationIndexEntry {
  /** Position in the current projected branch before DCP metadata carriers. */
  index: number
  /** Stable identity of this projected message. */
  stableId: string
  /** SHA-256 of the canonical provider-visible message content. */
  contentHash: string
  /**
   * Canonical hash of the raw session message before DCP rewrote this
   * projection entry's body (e.g. a tool-output placeholder). Equals
   * `contentHash` for untouched entries. Runtime-only; exact mutation
   * membership binds to this so a later raw pass still materializes the block.
   * Omitted when the raw and projected hashes are identical.
   */
  rawContentHash?: string
  /** Persistent mNNN identifier when the message is addressable as raw content. */
  visibleId?: string
  /** Message role in the current projection. */
  role: string
  /** Message timestamp when finite. */
  timestamp?: number
  /** Active block represented by this projected placeholder, when any. */
  blockId?: number
  /** Tool result identity for result-like messages. */
  toolCallId?: string
  /** Tool calls emitted by an assistant message. */
  toolCallIds?: string[]
  /** PI-internal entries are not directly addressable but remain part of range closure. */
  passthrough: boolean
  /** Provenance of this projected entry; never inferred from model-visible text. */
  origin: "raw" | "block" | "dcp-control"
  /** Signed assistant content must never be edited in place. */
  signedAssistant: boolean
}

export interface CompressionProtectedFragment {
  kind: "user" | "prompt" | "tool"
  /** Stable provenance key; not rendered into provider-visible context. */
  origin: string
  /** SHA-256 of the exact protected text. */
  hash: string
  /** Exact text that must survive rollups. */
  text: string
}

/**
 * An immutable source/mutation member recorded by modern compression blocks.
 *
 * `stableId` identifies one occurrence in the canonical branch sequence and
 * `hash` binds that identity to its original provider-visible content. The
 * timestamp is deliberately not part of this record: host imports/reloads can
 * normalize timestamps without changing the actual message.
 */
export interface CompressionMember {
  stableId: string
  hash: string
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
  /** Binds idempotent manual replay to the exact requested parameters. */
  operationRequestHash?: string
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
  /**
   * Exact projection semantics. New journal sessions only accept version 2
   * blocks, planned before commit without widening their mutation set.
   */
  version?: 2
  /** Exact v2 materialization behavior. */
  replacementMode?: "range" | "message-body"
  /**
   * Exact provider-projection entries that supplied this summary. For a
   * roll-up this can contain a synthetic block placeholder while
   * `mutationMembers` contains that placeholder's canonical raw provenance.
   */
  sourceMembers?: CompressionMember[]
  /**
   * Exact canonical raw entries that a v2 application is allowed to replace.
   * The apply path requires every member, in this order and with this hash, to
   * be present contiguously before it mutates the projection.
   */
  mutationMembers?: CompressionMember[]
  /** E06 provenance for automatically prepared summaries. */
  autoSummaryRepresentation?: "model" | "extractive" | "extractive-fallback"
  /** SHA-256 of the bounded source manifest used by the auto summary. */
  sourceHash?: string
  /** Bounded source-manifest coverage recorded at auto-summary commit. */
  sourceCoverage?: {
    itemCount: number
    truncatedItems: number
    toolCallCount: number
    toolResultCount: number
  }
  /** Exact protected continuity fragments carried across rollups. */
  protectedFragments?: CompressionProtectedFragment[]
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
  /** Frozen provider-visible reminder text for cache-stable reapplication. */
  renderedReminder?: string
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
export interface DcpProgressRecovery {
  blockedReason: DcpBlockedReason
  projectedBeforeTokens: number
  inputCapacityTokens: number
  requiredSavingsTokens: number
  contextWindow: number
  createdAt: number
}

/** Outstanding net savings goal; a small successful block is not necessarily relief. */
export interface DcpCompressionProgress {
  remainingTokens: number
  projectedTokens: number
  contextWindow: number
  kind: "routine" | "emergency"
  /** Last budget observation; unchanged native usage must not undo partial savings. */
  observedTokens?: number
  targetHeadroomTokens?: number
}

export interface DcpState {
  /** Runtime-only owner epoch. Incremented whenever the active session state is replaced. */
  sessionEpoch: number
  // ── Tool tracking ──────────────────────────────────────────────────────────
  /** toolCallId → ToolRecord, populated when a tool_result event fires */
  toolCalls: Map<string, ToolRecord>
  /** Set of toolCallIds whose result messages should be suppressed in context */
  prunedToolIds: Set<string>
  /** toolCallId → reason used for human-readable pruning placeholders/stats. */
  prunedToolReasons: Map<string, string>
  /** Tool results consumed by at least one successfully completed provider response stream. */
  providerSeenToolIds: Set<string>

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
  /** Ephemeral canonical projection index from the latest context pass. */
  conversationIndexSnapshot: ConversationIndexEntry[]
  /** Stable message identity → persistent model-visible mNNN assignment. */
  messageIdsByStableId: Map<string, string>
  /** Monotonic counter for persistent message IDs. */
  nextMessageId: number

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
   * When true, DCP will not autonomously create summaries or routine nudges.
   * The explicit compress tool and bounded emergency safety behavior retain
   * their separate contracts.
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
   * How many completed, correlated main-provider opportunities contained an
   * emergency DCP reminder without sufficient committed compression/pruning gain.
   * Repeated `context` transforms and retries do not advance this counter.
   */
  consecutiveIgnoredStrongNudges: number
  /** Completed provider opportunities with any actionable reminder, including failed compress attempts. */
  consecutiveIgnoredNudges: number
  compressionProgress?: DcpCompressionProgress
  /** Last terminal E05 handoff, persisted so restart does not hide why progress stopped. */
  progressRecovery?: DcpProgressRecovery
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a fresh, zeroed DcpState instance. */
export function createState(): DcpState {
  return {
    sessionEpoch: 1,
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    prunedToolReasons: new Map(),
    providerSeenToolIds: new Set(),
    compressionBlocks: [],
    nextBlockId: 1,
    messageIdSnapshot: new Map(),
    messageMetaSnapshot: new Map(),
    conversationIndexSnapshot: [],
    messageIdsByStableId: new Map(),
    nextMessageId: 1,
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
    consecutiveIgnoredNudges: 0,
    compressionProgress: undefined,
    progressRecovery: undefined,
  }
}

/**
 * Reset `state` back to its initial values **in-place**.
 * Preserves the object reference so other modules holding a reference see the
 * reset immediately.
 */
export function resetState(state: DcpState): void {
  state.sessionEpoch = Math.max(1, Math.floor(state.sessionEpoch || 0) + 1)
  state.toolCalls.clear()
  state.prunedToolIds.clear()
  state.prunedToolReasons.clear()
  state.providerSeenToolIds.clear()
  state.compressionBlocks = []
  state.nextBlockId = 1
  state.messageIdSnapshot.clear()
  state.messageMetaSnapshot.clear()
  state.conversationIndexSnapshot = []
  state.messageIdsByStableId.clear()
  state.nextMessageId = 1
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
  state.consecutiveIgnoredNudges = 0
  state.compressionProgress = undefined
  state.progressRecovery = undefined
}

const COMPRESSION_MEMBER_HASH_RE = /^[a-f0-9]{64}$/i

function isCompressionMember(value: unknown): value is CompressionMember {
  if (!value || typeof value !== "object") return false
  const member = value as Partial<CompressionMember>
  return (
    typeof member.stableId === "string" &&
    member.stableId.length > 0 &&
    typeof member.hash === "string" &&
    COMPRESSION_MEMBER_HASH_RE.test(member.hash)
  )
}

function isCompressionMemberList(value: unknown): value is CompressionMember[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isCompressionMember)) return false
  return new Set(value.map((member) => member.stableId)).size === value.length
}

/** True only for a complete, unambiguous modern v2 membership record. */
export function hasExactCompressionMembership(block: Pick<CompressionBlock, "sourceMembers" | "mutationMembers">): boolean {
  return isCompressionMemberList(block.sourceMembers) && isCompressionMemberList(block.mutationMembers)
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

/** Create a stable fingerprint for a tool call and canonicalized input args. */
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
