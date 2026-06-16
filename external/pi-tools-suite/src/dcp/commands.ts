import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import type { DcpState } from "./state.js"
import { modelKeysFromContext, resolveModelConfig, type DcpConfig } from "./config.js"
import type { DcpNudgeType } from "./pruner-types.js"
import { isToolRecordProtected, markToolPruned } from "./pruner.js"
import { safeGetContextUsage } from "../context-usage.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools whose outputs are always protected from sweep regardless of config. */
const ALWAYS_PROTECTED_TOOLS = ["compress", "write", "edit"] as const
export const DCP_STATS_MESSAGE_TYPE = "pix-system"
const DCP_STATS_DETAILS_KIND = "dcp-stats"

export interface DcpCommandHooks {
  onStateChanged?: (ctx: ExtensionCommandContext) => void
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString()
}

const NUDGE_TYPES: DcpNudgeType[] = ["turn", "iteration", "context-soft", "context-strong"]

function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "n/a"
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function nudgeLabel(type: DcpNudgeType): string {
  switch (type) {
    case "context-strong": return "context-strong"
    case "context-soft": return "context-soft"
    case "iteration": return "iteration"
    case "turn": return "turn"
  }
}

function isNudgeType(value: unknown): value is DcpNudgeType {
  return typeof value === "string" && (NUDGE_TYPES as string[]).includes(value)
}

function customEntryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
  const record = entry as { type?: unknown; customType?: unknown; data?: unknown }
  if (record?.type !== "custom" || record.customType !== customType) return undefined
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) return undefined
  return record.data as Record<string, unknown>
}

function branchEntries(ctx: ExtensionCommandContext): unknown[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.()
    return Array.isArray(branch) ? branch : []
  } catch {
    return []
  }
}

interface DcpNudgeStats {
  emitted: number
  upgraded: number
  clearedEvents: number
  clearedAnchors: number
  byType: Record<DcpNudgeType, number>
  activeByType: Record<DcpNudgeType, number>
  last?: {
    type: DcpNudgeType
    event: "emitted" | "upgraded"
    createdAt?: number
    contextPercent?: number | null
  }
}

function collectNudgeStats(ctx: ExtensionCommandContext, state: DcpState): DcpNudgeStats {
  const stats: DcpNudgeStats = {
    emitted: 0,
    upgraded: 0,
    clearedEvents: 0,
    clearedAnchors: 0,
    byType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
    activeByType: { "turn": 0, "iteration": 0, "context-soft": 0, "context-strong": 0 },
  }

  for (const anchor of state.nudgeAnchors) {
    if (isNudgeType(anchor.type)) stats.activeByType[anchor.type]++
  }

  for (const entry of branchEntries(ctx)) {
    const data = customEntryData(entry, "dcp-nudge")
    if (!data) continue
    const event = data.event
    if ((event === "emitted" || event === "upgraded") && isNudgeType(data.type)) {
      if (event === "emitted") stats.emitted++
      else stats.upgraded++
      stats.byType[data.type]++
      const createdAt = typeof data.createdAt === "number" ? data.createdAt : undefined
      const contextPercent = typeof data.contextPercent === "number" || data.contextPercent === null
        ? data.contextPercent
        : undefined
      if (!stats.last || (createdAt ?? 0) >= (stats.last.createdAt ?? 0)) {
        stats.last = { type: data.type, event, createdAt, contextPercent }
      }
    } else if (event === "cleared") {
      stats.clearedEvents++
      stats.clearedAnchors += typeof data.clearedAnchors === "number" ? Math.max(0, data.clearedAnchors) : 0
    }
  }

  if (!stats.last && state.lastNudge && isNudgeType(state.lastNudge.type)) {
    stats.last = {
      type: state.lastNudge.type,
      event: "emitted",
      createdAt: state.lastNudge.createdAt,
      contextPercent: typeof state.lastNudge.contextPercent === "number"
        ? state.lastNudge.contextPercent * 100
        : undefined,
    }
  }

  return stats
}

function formatDate(ts: number | undefined): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "unknown time"
  return new Date(ts).toLocaleString()
}

function formatContextPercent(value: number | null | undefined): string {
  if (value === null) return "unknown context"
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown context"
  return `${value.toFixed(1)}% context`
}

function sendChatSystemMessage(pi: ExtensionAPI, customType: string, content: string, details?: Record<string, unknown>): void {
	pi.sendMessage({
		customType,
		content,
		display: true,
		details: {
			kind: DCP_STATS_DETAILS_KIND,
			userVisibleOnly: true,
			...(details ?? {}),
		},
	})
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP_TEXT = `DCP — Dynamic Context Pruning

Commands:
  /dcp context      — Show context window usage breakdown
  /dcp stats        — Show pruning statistics for this session
  /dcp sweep [N]    — Prune last N tool outputs (default: all since last user msg)
  /dcp manual       — Show manual mode status
  /dcp manual on    — Enable manual mode (disable autonomous compression nudges)
  /dcp manual off   — Disable manual mode (enable autonomous compression nudges)
  /dcp decompress   — List active compression blocks
  /dcp decompress N — Restore compression block N
  /dcp recompress    — List blocks restored by /dcp decompress
  /dcp recompress N  — Re-apply a user-restored compression block
  /dcp compress     — Trigger compression (sends compress tool invocation to LLM)`

function handleHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(HELP_TEXT, "info")
}

// ---------------------------------------------------------------------------
// Context usage
// ---------------------------------------------------------------------------

function handleContext(ctx: ExtensionCommandContext, state: DcpState): void {
  const usage = safeGetContextUsage(ctx)

  const lines: string[] = []

	if (usage && typeof usage.contextWindow === "number") {
		if (typeof usage.tokens === "number") {
			const pct = ((usage.tokens / usage.contextWindow) * 100).toFixed(1)
			lines.push(
				`Context Usage: ${pct}% (${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens)`,
      )
    } else {
      lines.push(`Context Usage: unknown / ${fmt(usage.contextWindow)} tokens`)
    }
  } else {
    lines.push("Context Usage: unavailable")
  }

  lines.push("")
  lines.push("Session Stats:")
  lines.push(`  Tool calls tracked: ${fmt(state.totalToolCallCount)} (${fmt(state.toolCalls.size)} in memory)`)
  lines.push(`  Pruned tools: ${fmt(state.prunedToolIds.size)}`)
  lines.push(`  Compression blocks: ${state.compressionBlocks.filter((b) => b.active).length}`)
  lines.push(`  Tokens saved (estimated): ${fmt(state.tokensSaved)}`)

  ctx.ui.notify(lines.join("\n"), "info")
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function handleStats(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: DcpState): void {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active).length
  const totalBlocks = state.compressionBlocks.length
  const nudgeStats = collectNudgeStats(ctx, state)
  const totalNudgeEvents = nudgeStats.emitted + nudgeStats.upgraded
  const activeAnchors = state.nudgeAnchors.length
  const lines: string[] = []
  lines.push("DCP Session Statistics:")
  lines.push(`  Tokens saved (estimated): ${fmt(state.tokensSaved)}`)
  lines.push(`  Total pruning operations: ${fmt(state.totalPruneCount)}`)
  lines.push(`  Compression blocks active: ${activeBlocks} / ${totalBlocks} total`)
  lines.push(`  Manual mode: ${state.manualMode ? "on" : "off"}`)
  lines.push("")
  lines.push("Nudge telemetry:")
  lines.push(`  Sent: ${fmt(nudgeStats.emitted)} emitted, ${fmt(nudgeStats.upgraded)} upgraded`)
  lines.push(
    `  By type: ${NUDGE_TYPES.map((type) => `${nudgeLabel(type)}=${fmt(nudgeStats.byType[type])}`).join(", ")}`,
  )
  lines.push(
    `  Active anchors: ${fmt(activeAnchors)}${activeAnchors > 0
      ? ` (${NUDGE_TYPES.map((type) => `${nudgeLabel(type)}=${fmt(nudgeStats.activeByType[type])}`).join(", ")})`
      : ""}`,
  )
  lines.push(`  Cleared after compress: ${fmt(nudgeStats.clearedEvents)} time${nudgeStats.clearedEvents === 1 ? "" : "s"} (${fmt(nudgeStats.clearedAnchors)} anchor${nudgeStats.clearedAnchors === 1 ? "" : "s"})`)
  lines.push(`  Compliance proxy: ${fmt(nudgeStats.clearedEvents)} compress-after-nudge / ${fmt(totalNudgeEvents)} nudge event${totalNudgeEvents === 1 ? "" : "s"} (${pct(nudgeStats.clearedEvents, totalNudgeEvents)})`)
  if (nudgeStats.last) {
    lines.push(
      `  Last nudge: ${nudgeLabel(nudgeStats.last.type)} ${nudgeStats.last.event} at ${formatDate(nudgeStats.last.createdAt)} (${formatContextPercent(nudgeStats.last.contextPercent)})`,
    )
  } else {
    lines.push("  Last nudge: none recorded")
  }

  sendChatSystemMessage(pi, DCP_STATS_MESSAGE_TYPE, lines.join("\n"), {
    generatedAt: new Date().toISOString(),
    activeAnchors,
    nudgeEvents: totalNudgeEvents,
  })
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function handleSweep(
  ctx: ExtensionCommandContext,
  state: DcpState,
  config: DcpConfig,
  n: number,
): Promise<void> {
  await ctx.waitForIdle()

  const branch = ctx.sessionManager.getBranch()

  // Build the full set of protected tool names.
  const protectedTools = new Set<string>([
    ...ALWAYS_PROTECTED_TOOLS,
    ...config.compress.protectedTools,
    ...config.strategies.deduplication.protectedTools,
    ...config.strategies.purgeErrors.protectedTools,
    ...config.strategies.autoToolPruning.protectedTools,
  ])

  // Walk the branch (root → leaf) collecting toolCallIds in encounter order,
  // and tracking where the last real user message was.
  const allToolCallIds: string[] = []
  const toolCallIdsSinceLastUser: string[] = []
  const toolNamesByCallId = new Map<string, string>()
  let lastUserMsgBranchIndex = -1

  // First pass: find the last user message index.
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]
    if (entry.type !== "message") continue
    const msg = (entry as any).message
    if (msg.role === "user") {
      lastUserMsgBranchIndex = i
    }
  }

  // Second pass: collect tool result IDs in encounter order.
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i]
    if (entry.type !== "message") continue
    const msg = (entry as any).message
    if (msg.role !== "toolResult") continue

    const toolCallId = msg.toolCallId as string
    allToolCallIds.push(toolCallId)
    if (typeof msg.toolName === "string") toolNamesByCallId.set(toolCallId, msg.toolName)

    if (lastUserMsgBranchIndex >= 0 && i > lastUserMsgBranchIndex) {
      toolCallIdsSinceLastUser.push(toolCallId)
    }
  }

  // Determine the candidate set based on the N argument.
  let candidates: string[]
  if (n > 0) {
    // Last N tool results from the full session branch.
    candidates = allToolCallIds.slice(-n)
  } else {
    // All tool results since the last user message (or everything if no user
    // message exists yet — e.g. in a purely agentic session).
    candidates =
      lastUserMsgBranchIndex >= 0 ? toolCallIdsSinceLastUser : allToolCallIds
  }

  // Filter: skip already-pruned IDs and protected tool names.
  const toAdd = candidates.filter((toolCallId) => {
    if (state.prunedToolIds.has(toolCallId)) return false

    // Tool name lookup: prefer the DCP tool-call record if tracked; fall back
    // to the AgentMessage itself (msg.toolName is present on ToolResultMessage).
    const record = state.toolCalls.get(toolCallId)
    const toolName = record?.toolName ?? toolNamesByCallId.get(toolCallId)

    if (record && isToolRecordProtected(record, config, Array.from(protectedTools))) return false
    if (toolName !== undefined && protectedTools.has(toolName)) return false

    return true
  })

  let count = 0
  for (const toolCallId of toAdd) {
    const record = state.toolCalls.get(toolCallId)
    if (markToolPruned(state, toolCallId, "manual-sweep", record?.tokenEstimate ?? 0)) {
      count++
    }
  }

  ctx.ui.notify(`Swept ${count} tool output${count === 1 ? "" : "s"}`, "info")
}

// ---------------------------------------------------------------------------
// Manual mode
// ---------------------------------------------------------------------------

function handleManual(
  ctx: ExtensionCommandContext,
  state: DcpState,
  subArg: string | undefined,
): void {
  if (subArg === "on") {
    state.manualMode = true
    ctx.ui.notify(
      "Manual mode: on\nAutonomous compression nudges are disabled. Use /dcp compress to trigger manually.",
      "info",
    )
  } else if (subArg === "off") {
    state.manualMode = false
    ctx.ui.notify("Manual mode: off\nAutonomous compression is enabled.", "info")
  } else {
    // Status display (no argument).
    const status = state.manualMode ? "on" : "off"
    ctx.ui.notify(
      `Manual mode: ${status}\nWhen on: compress tool only fires when you explicitly request it.`,
      "info",
    )
  }
}

// ---------------------------------------------------------------------------
// Decompress
// ---------------------------------------------------------------------------

function handleDecompress(
  ctx: ExtensionCommandContext,
  state: DcpState,
  nArg: string | undefined,
): void {
  if (nArg === undefined) {
    // List all active compression blocks.
    const activeBlocks = state.compressionBlocks.filter((b) => b.active)

    if (activeBlocks.length === 0) {
      ctx.ui.notify("No active compression blocks.", "info")
      return
    }

    const lines: string[] = ["Active compression blocks:"]
    for (const block of activeBlocks) {
      lines.push(
        `  b${block.id} — "${block.topic}" (est. ${fmt(block.summaryTokenEstimate)} tokens)`,
      )
    }
    lines.push("")
    lines.push("Run /dcp decompress N to restore a block.")

    ctx.ui.notify(lines.join("\n"), "info")
  } else {
    // Restore block N.
    const id = parseInt(nArg, 10)

    if (isNaN(id)) {
      ctx.ui.notify(
        `Invalid block ID: "${nArg}". Usage: /dcp decompress N`,
        "error",
      )
      return
    }

    const block = state.compressionBlocks.find((b) => b.id === id)

    if (!block) {
      ctx.ui.notify(`No compression block found with id ${id}.`, "error")
      return
    }

    if (!block.active) {
      ctx.ui.notify(`Compression block b${id} is already decompressed.`, "info")
      return
    }

    block.active = false
    block.deactivatedByUser = true
    ctx.ui.notify(`Decompressed block b${id}: "${block.topic}"`, "info")
  }
}

// ---------------------------------------------------------------------------
// Recompress
// ---------------------------------------------------------------------------

function handleRecompress(
  ctx: ExtensionCommandContext,
  state: DcpState,
  nArg: string | undefined,
): void {
  const recompressible = state.compressionBlocks.filter((b) => !b.active && b.deactivatedByUser)

  if (nArg === undefined) {
    if (recompressible.length === 0) {
      ctx.ui.notify("No user-decompressed compression blocks are available to recompress.", "info")
      return
    }

    const lines: string[] = ["Recompressible blocks:"]
    for (const block of recompressible) {
      lines.push(
        `  b${block.id} — "${block.topic}" (est. ${fmt(block.summaryTokenEstimate)} tokens)`,
      )
    }
    lines.push("")
    lines.push("Run /dcp recompress N to re-apply a block.")
    ctx.ui.notify(lines.join("\n"), "info")
    return
  }

  const id = parseInt(nArg, 10)
  if (isNaN(id)) {
    ctx.ui.notify(`Invalid block ID: "${nArg}". Usage: /dcp recompress N`, "error")
    return
  }

  const block = state.compressionBlocks.find((b) => b.id === id)
  if (!block) {
    ctx.ui.notify(`No compression block found with id ${id}.`, "error")
    return
  }
  if (block.active) {
    ctx.ui.notify(`Compression block b${id} is already active.`, "info")
    return
  }
  if (!block.deactivatedByUser) {
    ctx.ui.notify(`Compression block b${id} was superseded by another block and cannot be recompressed directly.`, "error")
    return
  }

  for (const coveredId of block.coveredBlockIds ?? []) {
    const covered = state.compressionBlocks.find((candidate) => candidate.id === coveredId)
    if (covered) covered.active = false
  }
  block.active = true
  block.deactivatedByUser = false
  ctx.ui.notify(`Recompressed block b${id}: "${block.topic}"`, "info")
}

// ---------------------------------------------------------------------------
// Compress (trigger)
// ---------------------------------------------------------------------------

async function handleCompress(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()

  pi.sendMessage(
    {
      customType: "dcp-compress-trigger",
      content:
        "Please compress stale conversation sections using the compress tool now.",
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  )

  ctx.ui.notify("Triggered compression", "info")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerCommands(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  hooks: DcpCommandHooks = {},
): void {
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning — manage context window usage",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const subcommands: AutocompleteItem[] = [
        { value: "context", label: "context", description: "Show context window usage breakdown" },
        { value: "stats", label: "stats", description: "Show pruning statistics" },
        { value: "sweep", label: "sweep", description: "Prune tool outputs" },
        { value: "manual", label: "manual", description: "Toggle manual mode" },
        { value: "decompress", label: "decompress", description: "List or restore compression blocks" },
        { value: "recompress", label: "recompress", description: "Re-apply a decompressed block" },
        { value: "compress", label: "compress", description: "Trigger LLM compression" },
        { value: "help", label: "help", description: "Show help" },
      ]
      const matched = subcommands
        .filter((s) => typeof s.value === "string")
        .filter((s) => s.value.startsWith(prefix))
      return matched.length > 0 ? matched : null
    },

    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? ""
      const effectiveConfig = resolveModelConfig(config, modelKeysFromContext(ctx))

      try {
        switch (sub) {
          case "":
          case "help":
            handleHelp(ctx)
            break

          case "context":
            handleContext(ctx, state)
            break

          case "stats":
            handleStats(pi, ctx, state)
            break

          case "sweep": {
            const rawN = parts[1] !== undefined ? parseInt(parts[1], 10) : 0
            const n = isNaN(rawN) || rawN < 0 ? 0 : rawN
            await handleSweep(ctx, state, effectiveConfig, n)
            break
          }

          case "manual":
            handleManual(ctx, state, parts[1])
            break

          case "decompress":
            handleDecompress(ctx, state, parts[1])
            break

          case "recompress":
            handleRecompress(ctx, state, parts[1])
            break

          case "compress":
            await handleCompress(pi, ctx)
            break

          default:
            ctx.ui.notify(
              `Unknown DCP command: "${sub}". Run /dcp help for available commands.`,
              "error",
            )
            break
        }
      } finally {
        hooks.onStateChanged?.(ctx)
      }
    },
  })
}
