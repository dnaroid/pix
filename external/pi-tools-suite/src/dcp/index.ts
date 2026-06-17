// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — module entry point for pi-tools-suite
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig, modelKeysFromContext, resolveModelConfig } from "./config.js"
import {
	createState,
	resetState,
	createInputFingerprint,
	restoreState,
	inheritCompressionBlocks,
} from "./state.js"
import {
	cleanupStaleDcpStateFiles,
	loadDcpState,
	loadDcpStateFromSessionFile,
	resetDcpPersistenceDedup,
	saveDcpState,
} from "./state-persistence.js"
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
	clearDcpNudgeAnchors,
	nudgeTypeLabel,
	upsertNudgeAnchor,
	getActiveSummaryTokenEstimate,
	resolveContextThresholds,
	estimateTokens,
} from "./pruner.js"
import {
	stripStaleDcpMetadataFromAssistantMessage,
	stripStaleDcpMetadataFromMessage,
} from "./pruner-metadata.js"
import {
	DCP_MESSAGE_IDS_CUSTOM_TYPE,
	buildMessageIdControlText,
} from "./pruner-message-ids.js"
import { summarizeDcpState, writeDcpDebugLog } from "./debug-log.js"
import type { DcpNudgeType } from "./pruner-types.js"
import { registerCompressTool } from "./compress-tool.js"
import { DCP_STATS_MESSAGE_TYPE, registerCommands } from "./commands.js"
import { normalizeDcpContextUsage } from "./ui.js"
import { safeGetContextUsage } from "../context-usage.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const DCP_CONTROL_PLANE_CUSTOM_TYPES = new Set(["dcp-state", "dcp-nudge", DCP_MESSAGE_IDS_CUSTOM_TYPE])
const SUMMARY_BUFFER_MAX_CONTEXT_BONUS = 0.05

function isDcpControlPlaneMessage(message: any): boolean {
	return message?.role === "custom" && DCP_CONTROL_PLANE_CUSTOM_TYPES.has(message.customType)
}

const DCP_PROVIDER_CONTROL_HEADER = "DCP message ID control data (do not quote or output):"

function appendTextToContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return `${content}\n\n${text}`
	if (Array.isArray(content)) {
		const textType = content.some((part: any) => part?.type === "input_text") ? "input_text" : "text"
		return [...content, { type: textType, text }]
	}
	return text
}

function appendDcpControlToMessages(messages: unknown, text: string): unknown {
	if (!Array.isArray(messages)) return messages
	const existingIndex = messages.findIndex((message: any) =>
		message?.role === "system" || message?.role === "developer"
	)
	const block = `${DCP_PROVIDER_CONTROL_HEADER}\n${text}`
	if (existingIndex >= 0) {
		return messages.map((message: any, index) => index === existingIndex
			? { ...message, content: appendTextToContent(message.content, block) }
			: message)
	}
	return [{ role: "system", content: block }, ...messages]
}

function appendDcpControlToAnthropicSystem(system: unknown, text: string): unknown {
	const block = `${DCP_PROVIDER_CONTROL_HEADER}\n${text}`
	if (typeof system === "string") return `${system}\n\n${block}`
	if (Array.isArray(system)) return [...system, { type: "text", text: block }]
	if (system === undefined || system === null) return [{ type: "text", text: block }]
	return system
}

function appendDcpControlToGoogleSystemInstruction(systemInstruction: unknown, text: string): unknown {
	const block = `${DCP_PROVIDER_CONTROL_HEADER}\n${text}`
	if (typeof systemInstruction === "string") return `${systemInstruction}\n\n${block}`
	if (systemInstruction === undefined || systemInstruction === null) return block
	return systemInstruction
}

function appendDcpControlToProviderPayload(payload: unknown, text: string): unknown {
	if (Array.isArray(payload)) return appendDcpControlToMessages(payload, text)
	if (!payload || typeof payload !== "object") return payload
	const record = payload as Record<string, unknown>

	if ("system" in record) {
		return { ...record, system: appendDcpControlToAnthropicSystem(record.system, text) }
	}

	if (Array.isArray(record.input)) {
		return { ...record, input: appendDcpControlToMessages(record.input, text) }
	}

	if (Array.isArray(record.messages)) {
		return { ...record, messages: appendDcpControlToMessages(record.messages, text) }
	}

	if (record.config && typeof record.config === "object") {
		const config = record.config as Record<string, unknown>
		return {
			...record,
			config: {
				...config,
				systemInstruction: appendDcpControlToGoogleSystemInstruction(config.systemInstruction, text),
			},
		}
	}

	return payload
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export default async function dcpModule(pi: ExtensionAPI): Promise<void> {
	// ── 1. Load config ────────────────────────────────────────────────────────
	const config = loadConfig()
	const configForContext = (ctx: unknown) => resolveModelConfig(config, modelKeysFromContext(ctx))
	const hasEnabledModelOverride = Object.values(config.modelOverrides).some(
		(override) => override.enabled === true,
	)

	if (!config.enabled && !hasEnabledModelOverride) return

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
	pi.on("session_start", async (event, ctx) => {
		// Reset to a clean slate first.
		resetState(state)

		// Reset dedup hash before loading the sidecar state for this session.
		resetDcpPersistenceDedup()

		// Re-apply config baseline so manual mode survives a session_start reset.
		if (config.manualMode.enabled) {
			state.manualMode = true
		}

		// Restore from an overwrite sidecar file keyed by session id. Legacy
		// append-only custom `dcp-state` entries are intentionally ignored.
		void cleanupStaleDcpStateFiles(ctx).catch(() => {
			// Cleanup is opportunistic; stale sidecars must not block session startup.
		})
		restoreState(state, await loadDcpState(ctx))

		// fork/resume/new sessions inherit the source conversation but get a fresh
		// sidecar; inherit the previous session's compression blocks so they are
		// not silently lost (which previously forced re-compressing all history).
		if (state.compressionBlocks.length === 0 && event.previousSessionFile) {
			try {
				const inherited = await loadDcpStateFromSessionFile(event.previousSessionFile)
				const added = inheritCompressionBlocks(state, inherited)
				if (added > 0) {
					writeDcpDebugLog(configForContext(ctx), "session_start.inherited_blocks", {
						reason: event.reason,
						previousSessionFile: event.previousSessionFile,
						added,
						totalBlocks: state.compressionBlocks.length,
					}, ctx)
					// Persist inherited state into this session's own sidecar so a later
					// reload restores it directly.
					await saveDcpState(ctx, state)
				}
			} catch {
				// Inheritance is best-effort; never block session startup.
			}
		}

		// Headless by design: no extension status/footer/widgets are rendered.
	})

	// ── 6. session_shutdown: save state ───────────────────────────────────────
	pi.on("session_shutdown", async (_event, ctx) => {
		// Force-flush: bypass the dedup hash so the final snapshot is always
		// written, guaranteeing the next session_start can restore it.
		resetDcpPersistenceDedup()
		await saveDcpState(ctx, state)
	})

	// ── 7. before_agent_start: inject system prompt ───────────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		const effectiveConfig = configForContext(_ctx)
		if (!effectiveConfig.enabled) return { systemPrompt: event.systemPrompt }

		const promptAddition = state.manualMode
			? MANUAL_MODE_SYSTEM_PROMPT
			: SYSTEM_PROMPT

		return {
			systemPrompt: event.systemPrompt + "\n\n" + promptAddition,
		}
	})

	// ── 7b. message_end: never persist provider-echoed DCP control markers ─────
	pi.on("message_end", async (event, ctx) => {
		const effectiveConfig = configForContext(ctx)
		if (!effectiveConfig.enabled || event.message?.role !== "assistant") return undefined

		const sanitized = stripStaleDcpMetadataFromAssistantMessage(event.message)
		return { message: sanitized }
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
		const effectiveConfig = configForContext(ctx)
		const contextMessages = event.messages
			.filter((message: any) => !isUserVisibleOnlyMessage(message) && !isDcpControlPlaneMessage(message))
			.map((message: any) => stripStaleDcpMetadataFromMessage(message))
		const finishContext = (reason: string, messages: any[], details: Record<string, unknown> = {}) => {
			writeDcpDebugLog(effectiveConfig, "context.result", {
				reason,
				inputMessages: event.messages.length,
				filteredMessages: contextMessages.length,
				outputMessages: messages.length,
				messageIdControl: "provider-payload",
				state: summarizeDcpState(state),
				...details,
			}, ctx)
			return { messages }
		}

		writeDcpDebugLog(effectiveConfig, "context.start", {
			inputMessages: event.messages.length,
			filteredMessages: contextMessages.length,
			filteredDcpControlPlaneMessages: event.messages.length - contextMessages.length,
		}, ctx)
		if (!effectiveConfig.enabled) {
			writeDcpDebugLog(effectiveConfig, "context.disabled", {
				inputMessages: event.messages.length,
				filteredMessages: contextMessages.length,
			}, ctx)
			return { messages: contextMessages }
		}
		annotateMessagesWithBranchEntryIds(contextMessages, ctx)
		let prunedMessages = applyPruning(contextMessages, state, effectiveConfig)
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
				const clearedAnchors = clearDcpNudgeAnchors(state)
				if (clearedAnchors > 0) await saveDcpState(ctx, state)
				return finishContext("unknown-context-percent", prunedMessages, { clearedAnchors })
			}

			const ctxModel = (ctx as any).model
			const provider = ctxModel?.provider ?? ctxModel?.providerId ?? ctxModel?.providerID
			const model = ctxModel?.id ?? ctxModel?.model ?? ctxModel?.modelId ?? ctxModel?.modelID
			const thresholds = resolveContextThresholds(effectiveConfig, [
				provider && model ? `${provider}/${model}` : undefined,
				model,
			], usage.contextWindow)
			if (effectiveConfig.compress.summaryBuffer) {
				const summaryBonus = getActiveSummaryTokenEstimate(state) / usage.contextWindow
				thresholds.maxContextPercent += Math.min(summaryBonus, SUMMARY_BUFFER_MAX_CONTEXT_BONUS)
			}

			const contextLimitReached = contextPercent > thresholds.maxContextPercent
			const routineNudgesAllowed = contextPercent > thresholds.minContextPercent
			if (!contextLimitReached && !routineNudgesAllowed) {
				const clearedAnchors = clearDcpNudgeAnchors(state)
				if (clearedAnchors > 0) await saveDcpState(ctx, state)
				return finishContext("below-threshold", prunedMessages, {
					contextPercent,
					thresholds,
					clearedAnchors,
				})
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
				effectiveConfig,
				toolCallsSinceLastUser,
				thresholds,
			)

			const manualEmergencyOnly =
				state.manualMode &&
				(nudgeType !== "context-strong" && nudgeType !== "context-soft")

			if (!manualEmergencyOnly) {
				candidate = detectCompressionCandidate(
					prunedMessages,
					state,
					effectiveConfig,
					contextPercent,
				)
				messageCandidates = detectMessageCompressionCandidates(
					prunedMessages,
					state,
					effectiveConfig,
					contextPercent,
				)
				writeDcpDebugLog(effectiveConfig, "context.candidates", {
					contextPercent,
					thresholds,
					nudgeType,
					candidate,
					messageCandidates,
					state: summarizeDcpState(state),
				}, ctx)
			}

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
						await saveDcpState(ctx, state)
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

		return finishContext("complete", prunedMessages, {
			candidate,
			messageCandidates,
		})
	})

	// ── 10b. before_provider_request: inject DCP IDs outside transcript ────────
	pi.on("before_provider_request", async (event, ctx) => {
		const effectiveConfig = configForContext(ctx)
		if (!effectiveConfig.enabled) return undefined

		const controlText = buildMessageIdControlText(state)
		if (!controlText) return undefined

		const payload = appendDcpControlToProviderPayload(event.payload, controlText)
		writeDcpDebugLog(effectiveConfig, "provider_payload.message_ids", {
			injected: payload !== event.payload,
			state: summarizeDcpState(state),
		}, ctx)
		return payload === event.payload ? undefined : payload
	})

	// ── 11. agent_end: persist state after each agent run ────────────────────
	pi.on("agent_end", async (_event, ctx) => {
		await saveDcpState(ctx, state)
	})
}
