import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import type { DcpState } from "./state.js"
import { modelKeysFromContext, resolveModelConfig, type DcpConfig } from "./config.js"
import { isToolRecordProtected, markToolPruned } from "./pruner.js"
import { ignoreStaleExtensionContextError, safeGetContextUsage } from "../context-usage.js"
import { captureDcpTransactionGuard, cloneDcpTransactionState, runDcpStateTransaction } from "./state-transaction.js"
import { readDcpJournalBranch } from "./journal.js"
import { formatDcpStatistics } from "./statistics.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools whose outputs are always protected from sweep regardless of config. */
const ALWAYS_PROTECTED_TOOLS = ["compress", "write", "edit"] as const
export const DCP_STATS_MESSAGE_TYPE = "pix-system"
const DCP_STATS_DETAILS_KIND = "dcp-stats"

export interface DcpCommandHooks {
  onStateChanged?: (ctx: ExtensionCommandContext) => void
  persistState?: (
    ctx: ExtensionCommandContext,
    state: DcpState,
    publication?: { beforePublish?: () => void; onPublished?: () => void },
  ) => Promise<void> | void
  isSessionSupported?: () => boolean
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString()
}

async function staleSafe(action: () => void | Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    ignoreStaleExtensionContextError(error)
  }
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
  /dcp doctor       — Show config compatibility diagnostics
  /dcp sweep [N]    — Prune last N tool outputs (default: all since last user msg)
  /dcp manual       — Show manual mode status
  /dcp manual on    — Enable manual mode (disable autonomous compression nudges)
  /dcp manual off   — Disable manual mode (enable autonomous compression nudges)
  /dcp compress     — Trigger compression (sends compress tool invocation to LLM)`

function handleHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(HELP_TEXT, "info")
}

function handleDoctor(ctx: ExtensionCommandContext, config: DcpConfig): void {
  const issues = config.issues ?? []
  const lines = ["DCP Doctor", ""]
  if (issues.length === 0) {
    lines.push("Config: no removed or ignored DCP settings detected.")
  } else {
    lines.push(`Config: ${issues.length} removed/ignored setting${issues.length === 1 ? "" : "s"}:`)
    for (const issue of issues) lines.push(`  - ${issue}`)
  }
  ctx.ui.notify(lines.join("\n"), issues.length > 0 ? "warning" : "info")
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

async function handleStats(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: DcpState): Promise<void> {
  const epoch = state.sessionEpoch
  let branch: unknown[] = []
  let historyStatus: "full" | "unavailable" = "full"
  try { branch = await readDcpJournalBranch(ctx) }
  catch { historyStatus = "unavailable" }
  if (state.sessionEpoch !== epoch) return
  sendChatSystemMessage(pi, DCP_STATS_MESSAGE_TYPE,
    formatDcpStatistics({ branch, historyStatus, model: ctx.model, usage: safeGetContextUsage(ctx) }),
    { generatedAt: new Date().toISOString() })
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

  const branch = await readDcpJournalBranch(ctx) as any[]

  // Build the full set of protected tool names.
  const protectedTools = new Set<string>([
    ...ALWAYS_PROTECTED_TOOLS,
    ...config.compress.protectedTools,
    ...config.strategies.emergencyCurrentTurnPruning.protectedTools,
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

  await staleSafe(() => {
    ctx.ui.notify(`Swept ${count} tool output${count === 1 ? "" : "s"}`, "info")
  })
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
// Compress (trigger)
// ---------------------------------------------------------------------------

async function handleCompress(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle()

  await staleSafe(() => {
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
  })
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
  const persistState = hooks.persistState ?? (async (
    _ctx: ExtensionCommandContext,
    _state: DcpState,
    publication?: { beforePublish?: () => void; onPublished?: () => void },
  ) => {
    publication?.beforePublish?.()
    publication?.onPublished?.()
  })
  const isSessionSupported = hooks.isSessionSupported ?? (() => true)
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning — manage context window usage",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const subcommands: AutocompleteItem[] = [
        { value: "context", label: "context", description: "Show context window usage breakdown" },
        { value: "stats", label: "stats", description: "Show pruning statistics" },
        { value: "doctor", label: "doctor", description: "Show config compatibility diagnostics" },
        { value: "sweep", label: "sweep", description: "Prune tool outputs" },
        { value: "manual", label: "manual", description: "Toggle manual mode" },
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
      const mutating = sub === "sweep" || sub === "manual" || sub === "compress"
      if (mutating && !isSessionSupported()) {
        ctx.ui.notify("DCP is unavailable in this session. Start a new session to use the current DCP journal format.", "error")
        return
      }
      const execute = async (state: DcpState, ctx: ExtensionCommandContext): Promise<void> => {
        switch (sub) {
          case "":
          case "help":
            handleHelp(ctx)
            break

          case "context":
            handleContext(ctx, state)
            break

          case "stats":
            await handleStats(pi, ctx, state)
            break

          case "doctor":
            handleDoctor(ctx, config)
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
      }

      try {
        if (["sweep", "manual"].includes(sub)) {
          // Wait outside the commit queue: the active run may need that same
          // queue to complete provider evidence or a compression transaction.
          if (sub === "sweep") await ctx.waitForIdle()
          const assertCurrent = captureDcpTransactionGuard(state, effectiveConfig, undefined, ctx)
          const epoch = state.sessionEpoch
          await runDcpStateTransaction(state, async () => {
            assertCurrent()
            const working = cloneDcpTransactionState(state)
            const notifications: Array<Parameters<typeof ctx.ui.notify>> = []
            const stagedContext = {
              ...ctx,
              waitForIdle: async () => {},
              ui: { ...ctx.ui, notify: (...args: Parameters<typeof ctx.ui.notify>) => { notifications.push(args) } },
            } as ExtensionCommandContext
            await execute(working, stagedContext)
            assertCurrent()
            let published = false
            await persistState(ctx, working, {
              beforePublish: assertCurrent,
              onPublished: () => { published = true },
            })
            if (!published) assertCurrent()
            if (state.sessionEpoch === epoch) {
              Object.assign(state, working)
              for (const notification of notifications) await staleSafe(() => ctx.ui.notify(...notification))
            }
          })
        } else {
          await execute(state, ctx)
        }
      } finally {
        await staleSafe(() => {
          hooks.onStateChanged?.(ctx)
        })
      }
    },
  })
}
