// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — module entry point for pi-tools-suite
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "./config.js"
import {
	createState,
	resetState,
	createInputFingerprint,
	serializeState,
	hashSerializedState,
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
	detectMessageCompressionCandidates,
	appendConcreteNudgeGuidance,
	applyAnchoredNudges,
	nudgeTypeLabel,
	upsertNudgeAnchor,
	getActiveSummaryTokenEstimate,
	resolveContextThresholds,
	estimateTokens,
} from "./pruner.js"
import type { DcpNudgeType } from "./pruner-types.js"
import { registerCompressTool } from "./compress-tool.js"
import { DCP_STATS_MESSAGE_TYPE, registerCommands } from "./commands.js"
import { normalizeDcpContextUsage } from "./ui.js"
import { safeGetContextUsage } from "../context-usage.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash of the last persisted dcp-state snapshot. Used to skip appending
 * identical snapshots when saveState is called repeatedly without state change.
 */
let lastPersistedStateHash: string | undefined

/**
 * Persist the current DCP runtime state as a custom session entry so it
 * survives session restarts and pi process restarts.
 *
 * Deduplication: serializes, hashes, and skips the append when the hash
 * matches the previously persisted snapshot. This avoids writing identical
 * multi-KB entries on every context event / nudge reapply.
 */
function saveState(pi: ExtensionAPI, state: DcpState): void {
	const serialized = serializeState(state)
	const hash = hashSerializedState(serialized)
	if (hash === lastPersistedStateHash) return
	lastPersistedStateHash = hash
	pi.appendEntry("dcp-state", serialized)
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

function baseNudgeText(type: DcpNudgeType): string {
	if (type === "context-strong") return CONTEXT_LIMIT_NUDGE_STRONG
	if (type === "context-soft") return CONTEXT_LIMIT_NUDGE_SOFT
	if (type === "iteration") return ITERATION_NUDGE
	return TURN_NUDGE
}

function isUserVisibleOnlyMessage(message: any): boolean {
	if (message?.role !== "custom") return false
	if (message.customType !== DCP_STATS_MESSAGE_TYPE) return false
	return message.details?.userVisibleOnly === true
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export default async function dcpModule(pi: ExtensionAPI): Promise<void> {
	// ── 1. Load config ────────────────────────────────────────────────────────
	const config = loadConfig()

	if (!config.enabled) return

	// ── 2. Create state ───────────────────────────────────────────────────────
	const state = createState()
	const appendNudgeTelemetry = (
		event: "emitted" | "upgraded" | "reapplied",
		type: DcpNudgeType,
		anchor: { id: number; anchorTimestamp: number; anchorStableId?: string; anchorRole: string },
		usage: ReturnType<typeof normalizeDcpContextUsage>,
		toolCallsSinceLastUser: number,
	): void => {
		try {
			pi.appendEntry("dcp-nudge", {
				event,
				type,
				label: nudgeTypeLabel(type),
				anchorId: anchor.id,
				anchorTimestamp: anchor.anchorTimestamp,
				anchorStableId: anchor.anchorStableId,
				anchorRole: anchor.anchorRole,
				contextTokens: usage?.tokens,
				contextWindow: usage?.contextWindow,
				contextPercent: usage?.percent,
				toolCallsSinceLastUser,
				createdAt: Date.now(),
			})
		} catch {
			// Telemetry is diagnostic only; never block context construction.
		}
	}

	// Apply config baseline for manual mode before any session events fire.
	if (config.manualMode.enabled) {
		state.manualMode = true
	}

	// ── 3. Register compress tool ─────────────────────────────────────────────
	registerCompressTool(pi, state, config)

	// ── 4. Register /dcp commands ─────────────────────────────────────────────
	registerCommands(pi, state, config)

	// ── 5. session_start: restore state from session entries ──────────────────
	pi.on("session_start", async (_event, ctx) => {
		// Reset to a clean slate first.
		resetState(state)

		// Reset dedup hash so the first save after restore always writes.
		lastPersistedStateHash = undefined

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

		// Headless by design: no extension status/footer/widgets are rendered.
	})

	// ── 6. session_shutdown: save state ───────────────────────────────────────
	pi.on("session_shutdown", async (_event, _ctx) => {
		saveState(pi, state)
	})

	// ── 7. before_agent_start: inject system prompt ───────────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		const promptAddition = state.manualMode
			? MANUAL_MODE_SYSTEM_PROMPT
			: SYSTEM_PROMPT

		return {
			systemPrompt: event.systemPrompt + "\n\n" + promptAddition,
		}
	})

	// ── 8. tool_call: record input args for dedup / purge fingerprinting ───────
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
			state.totalToolCallCount++
		}
	})

	// ── 9. tool_result: finalise tool record with result info ─────────────────
	pi.on("tool_result", async (event, _ctx) => {
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
			state.totalToolCallCount++
		}

	})

	// ── 10. context: apply pruning and inject nudges ──────────────────────────
	pi.on("context", async (event, ctx) => {
		const contextMessages = event.messages.filter((message: any) => !isUserVisibleOnlyMessage(message))
		annotateMessagesWithBranchEntryIds(contextMessages, ctx)
		let prunedMessages = applyPruning(contextMessages, state, config)
		let candidate = null as ReturnType<typeof detectCompressionCandidate>
		let messageCandidates = [] as ReturnType<typeof detectMessageCompressionCandidates>

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
				if (state.manualMode) {
					state.nudgeAnchors = state.nudgeAnchors.filter((anchor) =>
						anchor.type === "context-strong" || anchor.type === "context-soft",
					)
				}
				applyAnchoredNudges(prunedMessages, state, (anchor) =>
					appendConcreteNudgeGuidance(baseNudgeText(anchor.type), candidate, messageCandidates, state),
				)
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

			candidate = detectCompressionCandidate(
				prunedMessages,
				state,
				config,
				contextPercent,
			)
			messageCandidates = detectMessageCompressionCandidates(
				prunedMessages,
				config,
				contextPercent,
			)

			if (nudgeType && !manualEmergencyOnly) {
				const nudgeText = appendConcreteNudgeGuidance(
					baseNudgeText(nudgeType),
					candidate,
					messageCandidates,
					state,
				)

				const anchorResult = upsertNudgeAnchor(
					prunedMessages,
					state,
					nudgeType,
					{ contextPercent },
				)
				if (anchorResult.anchor) {
					if (anchorResult.updated) {
						appendNudgeTelemetry(
							anchorResult.created ? "emitted" : "upgraded",
							nudgeType,
							anchorResult.anchor,
							usage,
							toolCallsSinceLastUser,
						)
						saveState(pi, state)
					} else {
						// Anchor already exists at >= priority; the reminder text is
						// re-applied below via applyAnchoredNudges on every context
						// event. Emit 'reapplied' so telemetry reflects every active
						// reminder delivery, not just creates/upgrades. Without this
						// branch the user/developer sees a single "emitted" entry even
						// when the LLM was reminded many times across a long autonomous
						// loop, which made auto-nudge look silent when it actually ran.
						appendNudgeTelemetry(
							"reapplied",
							anchorResult.anchor.type,
							anchorResult.anchor,
							usage,
							toolCallsSinceLastUser,
						)
					}
				} else {
					// No safe existing message could be anchored (rare); keep the older
					// synthetic reminder fallback so DCP never silently drops a nudge.
					injectNudge(prunedMessages, nudgeText)
				}
				state.nudgeCounter = 0
				state.lastNudgeTurn = state.currentTurn
			} else {
				state.nudgeCounter++
			}
		}

		if (state.manualMode) {
			state.nudgeAnchors = state.nudgeAnchors.filter((anchor) =>
				anchor.type === "context-strong" || anchor.type === "context-soft",
			)
		}
		applyAnchoredNudges(prunedMessages, state, (anchor) =>
			appendConcreteNudgeGuidance(baseNudgeText(anchor.type), candidate, messageCandidates, state),
		)

		return { messages: prunedMessages }
	})

	// ── 11. agent_end: persist state after each agent run ────────────────────
	pi.on("agent_end", async (_event, _ctx) => {
		saveState(pi, state)
	})
}
