// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — module entry point for pi-tools-suite
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { loadConfig } from "./config.js"
import {
	createState,
	resetState,
	createInputFingerprint,
	serializeState,
	restoreState,
	type DcpState,
} from "./state.js"
import {
	SYSTEM_PROMPT,
	MANUAL_MODE_SYSTEM_PROMPT,
	CONTEXT_LIMIT_NUDGE_STRONG,
	CONTEXT_LIMIT_NUDGE_SOFT,
	TURN_NUDGE,
	ITERATION_NUDGE,
} from "./prompts.js"
import {
	applyPruning,
	injectNudge,
	getNudgeType,
	detectCompressionCandidate,
	formatCompressionCandidateHint,
	detectMessageCompressionCandidates,
	formatMessageCompressionCandidateHint,
	getActiveSummaryTokenEstimate,
	resolveContextThresholds,
	estimateTokens,
} from "./pruner.js"
import { registerCompressTool } from "./compress-tool.js"
import { registerCommands } from "./commands.js"
import { DcpUiController, normalizeDcpContextUsage } from "./ui.js"
import { registerTuiFilter } from "./dcp-tui-filter.js"
import { ignoreStaleExtensionContextError, safeGetContextUsage } from "../context-usage.js"

const DCP_CONTEXT_USAGE_EVENT = "pi-tools-suite:dcp-context-usage"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Persist the current DCP runtime state as a custom session entry so it
 * survives session restarts and pi process restarts.
 */
function saveState(pi: ExtensionAPI, state: DcpState): void {
	pi.appendEntry("dcp-state", serializeState(state))
}

function annotateMessagesWithBranchEntryIds(messages: any[], ctx: ExtensionContext): void {
	let branch: any[] = []
	try {
		branch = ctx.sessionManager.getBranch()
	} catch {
		return
	}

	const entries = branch.filter((entry) => entry?.type === "message" && entry.message)
	let searchFrom = 0
	for (const msg of messages) {
		for (let i = searchFrom; i < entries.length; i++) {
			const entry = entries[i]
			const entryMsg = entry.message
			if (entryMsg?.role !== msg?.role) continue
			if (
				Number.isFinite(entryMsg?.timestamp) &&
				Number.isFinite(msg?.timestamp) &&
				entryMsg.timestamp !== msg.timestamp
			) continue
			msg._dcpEntryId = entry.id
			searchFrom = i + 1
			break
		}
	}
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export default async function dcpModule(pi: ExtensionAPI): Promise<void> {
	// ── 1. Load config ────────────────────────────────────────────────────────
	const config = loadConfig(process.cwd())

	if (!config.enabled) return

	// ── 2. Create state ───────────────────────────────────────────────────────
	const state = createState()
	const ui = new DcpUiController(state)
	const updateUi = (ctx: ExtensionContext): void => {
		try {
			if (!ctx?.hasUI) return
			ui.setUICtx(ctx.ui)
			ui.update(ctx)
		} catch (error) {
			ignoreStaleExtensionContextError(error)
		}
	}
	const emitContextUsage = (ctx: ExtensionContext): void => {
		const usage = safeGetContextUsage(ctx)
		if (!usage) return
		try {
			;(pi as { events?: { emit?: (name: string, data: unknown) => void } }).events?.emit?.(DCP_CONTEXT_USAGE_EVENT, usage)
		} catch (error) {
			ignoreStaleExtensionContextError(error)
		}
	}

	// Apply config baseline for manual mode before any session events fire.
	if (config.manualMode.enabled) {
		state.manualMode = true
	}

	// ── 3. Register TUI filter (strip DCP tags from displayed messages) ───────
	registerTuiFilter(pi)

	// ── 4. Register compress tool ─────────────────────────────────────────────
	registerCompressTool(pi, state, config)

	// ── 5. Register /dcp commands ─────────────────────────────────────────────
	registerCommands(pi, state, config, {
		onStateChanged(ctx) {
			updateUi(ctx)
		},
	})

	// ── 6. session_start: restore state from session entries ──────────────────
	pi.on("session_start", async (_event, ctx) => {
		// Reset to a clean slate first.
		resetState(state)

		// Re-apply config baseline so manual mode survives a session_start reset.
		if (config.manualMode.enabled) {
			state.manualMode = true
		}

		// Walk the branch looking for the most-recent persisted dcp-state entry.
		let latestDcpState: unknown
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "dcp-state") {
				latestDcpState = entry.data
			}
		}

		restoreState(state, latestDcpState)

		// Show a rich status indicator + floating cleaned-context widget in the pi TUI.
		updateUi(ctx)
	})

	// ── 7. session_shutdown: save state ───────────────────────────────────────
	pi.on("session_shutdown", async (_event, _ctx) => {
		saveState(pi, state)
		ui.dispose()
	})

	// ── 8. before_agent_start: inject system prompt ───────────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		const promptAddition = state.manualMode
			? MANUAL_MODE_SYSTEM_PROMPT
			: SYSTEM_PROMPT

		return {
			systemPrompt: event.systemPrompt + "\n\n" + promptAddition,
		}
	})

	// ── 9. tool_call: record input args for dedup / purge fingerprinting ───────
	pi.on("tool_call", async (event, _ctx) => {
		if (!state.toolCalls.has(event.toolCallId)) {
			state.toolCalls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputArgs: event.input as Record<string, unknown>,
				inputFingerprint: createInputFingerprint(
					event.toolName,
					event.input as Record<string, unknown>,
				),
				isError: false,
				turnIndex: state.currentTurn,
				timestamp: 0,
				tokenEstimate: 0,
			})
		}
	})

	// ── 10. tool_result: finalise tool record with result info ─────────────────
	pi.on("tool_result", async (event, ctx) => {
		const record = state.toolCalls.get(event.toolCallId)

		const outputText = event.content
			.map((c: any) => (c.type === "text" ? c.text : ""))
			.join("")
		const tokenEstimate = estimateTokens(outputText)

		if (record) {
			record.isError = event.isError
			record.timestamp = Date.now()
			record.tokenEstimate = tokenEstimate
			record.outputText = outputText
			record.outputDetails = event.details
		} else {
			state.toolCalls.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				inputArgs: {},
				inputFingerprint: createInputFingerprint(event.toolName, {}),
				isError: event.isError,
				turnIndex: state.currentTurn,
				timestamp: Date.now(),
				tokenEstimate,
				outputText,
				outputDetails: event.details,
			})
		}

		if (event.toolName === "compress" && ctx.hasUI) {
			updateUi(ctx)
			emitContextUsage(ctx)
		}
	})

	// ── 11. context: apply pruning and inject nudges ──────────────────────────
	pi.on("context", async (event, ctx) => {
		annotateMessagesWithBranchEntryIds(event.messages, ctx)
		let prunedMessages = applyPruning(event.messages, state, config)

		// In manual mode we still apply pruning strategies (if
		// automaticStrategies is on) but skip routine autonomous nudges. Emergency
		// max-context nudges are still allowed, matching the manual-mode prompt.
		const usage = normalizeDcpContextUsage(safeGetContextUsage(ctx))
		if (usage) {
			const contextPercent = typeof usage.percent === "number" && Number.isFinite(usage.percent)
				? usage.percent / 100
				: typeof usage.tokens === "number"
					? usage.tokens / usage.contextWindow
					: undefined

			if (contextPercent === undefined) {
				updateUi(ctx)
				emitContextUsage(ctx)
				return { messages: prunedMessages }
			}

			const ctxModel = (ctx as any).model
			const provider = ctxModel?.provider ?? ctxModel?.providerId ?? ctxModel?.providerID
			const model = ctxModel?.id ?? ctxModel?.model ?? ctxModel?.modelId ?? ctxModel?.modelID
			const thresholds = resolveContextThresholds(config, [
				provider && model ? `${provider}/${model}` : undefined,
				model,
			], usage.contextWindow)
			if (config.compress.summaryBuffer) {
				thresholds.maxContextPercent += getActiveSummaryTokenEstimate(state) / usage.contextWindow
			}

			let toolCallsSinceLastUser = 0
			for (let i = prunedMessages.length - 1; i >= 0; i--) {
				const msg = prunedMessages[i] as any
				if (msg.role === "user") break
				if (msg.role === "toolResult") toolCallsSinceLastUser++
			}

			const nudgeType = getNudgeType(
				contextPercent,
				state,
				config,
				toolCallsSinceLastUser,
				thresholds,
			)

			const manualEmergencyOnly =
				state.manualMode &&
				(nudgeType !== "context-strong" && nudgeType !== "context-soft")

			if (nudgeType && !manualEmergencyOnly) {
				let nudgeText: string

				if (nudgeType === "context-strong") {
					nudgeText = CONTEXT_LIMIT_NUDGE_STRONG
				} else if (nudgeType === "context-soft") {
					nudgeText = CONTEXT_LIMIT_NUDGE_SOFT
				} else if (nudgeType === "iteration") {
					nudgeText = ITERATION_NUDGE
				} else {
					nudgeText = TURN_NUDGE
				}

				const candidate = detectCompressionCandidate(
					prunedMessages,
					state,
					config,
					contextPercent,
				)
				if (candidate) {
					nudgeText += formatCompressionCandidateHint(candidate)
				}

				const messageCandidates = detectMessageCompressionCandidates(
					prunedMessages,
					config,
					contextPercent,
				)
				nudgeText += formatMessageCompressionCandidateHint(messageCandidates)

				injectNudge(prunedMessages, nudgeText)
				state.nudgeCounter = 0
				state.lastNudgeTurn = state.currentTurn
			} else {
				state.nudgeCounter++
			}
		}


		// Update footer status and floating widget after each context event.
		updateUi(ctx)
		emitContextUsage(ctx)

		return { messages: prunedMessages }
	})

	// ── 12. turn_end: refresh DCP status from Pi's final context percentage ───
	pi.on("turn_end", async (_event, ctx) => {
		updateUi(ctx)
		emitContextUsage(ctx)
	})

	// ── 13. agent_end: persist state after each agent run ────────────────────
	pi.on("agent_end", async (_event, ctx) => {
		updateUi(ctx)
		emitContextUsage(ctx)
		saveState(pi, state)
	})
}
