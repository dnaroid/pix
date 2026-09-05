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
	captureDcpPersistenceTarget,
	loadDcpState,
	loadDcpStateFromSessionFile,
	resetDcpPersistenceDedup,
	saveDcpState,
	saveDcpStateToTarget,
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
	detectEmergencyCompressionCandidate,
	detectMessageCompressionCandidates,
	analyzeEmergencyCurrentTurn,
	emergencyPressureState,
	emergencyCurrentTurnMessageCandidates,
	pruneEmergencyCurrentTurn,
	appendConcreteNudgeGuidance,
	applyAnchoredNudges,
	clearDcpNudgeAnchors,
	nudgeTypeLabel,
	upsertNudgeAnchor,
	getActiveSummaryTokenEstimate,
	resolveContextThresholds,
	estimateTokens,
} from "./pruner.js"
import { estimateMessageTokens, stripStaleDcpMetadataFromMessage } from "./pruner-metadata.js"
import { summarizeDcpState, writeDcpDebugLog } from "./debug-log.js"
import type { DcpNudgeType } from "./pruner-types.js"
import { registerCompressTool } from "./compress-tool.js"
import {
	AutoCompressionBlockedError,
	decideAutoCompress,
	createAutoCompressionBlock,
} from "./auto-compress.js"
import { DCP_STATS_MESSAGE_TYPE, registerCommands } from "./commands.js"
import { normalizeDcpContextUsage } from "./ui.js"
import { safeGetContextUsage } from "../context-usage.js"
import {
	collectProviderToolResultEvidence,
	providerPayloadIncludesToolResult,
	providerPayloadRevision,
	ProviderEvidenceTracker,
} from "./provider-tool-results.js"
import { reconcileInheritedCompressionBlocks } from "./pruner-compression-blocks.js"
import { rehydrateToolRecordsFromMessages } from "./recovery.js"
import { inferDcpBlockedReason, planDcpBudget } from "./progress-controller.js"

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

// Control-plane custom message types filtered out of the transcript.
// `dcp-message-ids` is retained only for backward-compat with logs written by
// the removed inline control-message path.
const DCP_CONTROL_PLANE_CUSTOM_TYPES = new Set(["dcp-state", "dcp-nudge", "dcp-message-ids"])
const SUMMARY_BUFFER_MAX_CONTEXT_BONUS = 0.05

function isDcpControlPlaneMessage(message: any): boolean {
	return message?.role === "custom" && DCP_CONTROL_PLANE_CUSTOM_TYPES.has(message.customType)
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
	let pendingInheritedBlockReconciliation = false
	const providerEvidenceTracker = new ProviderEvidenceTracker()
	let providerEvidenceCommitQueue = Promise.resolve()
	let latestProviderOpportunityAvailable = false
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
		providerEvidenceTracker.reset()
		latestProviderOpportunityAvailable = false
		const sessionStartEpoch = state.sessionEpoch
		pendingInheritedBlockReconciliation = false

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
		const loadedState = await loadDcpState(ctx)
		if (state.sessionEpoch !== sessionStartEpoch) return
		restoreState(state, loadedState)
		pendingInheritedBlockReconciliation = state.compressionBlocks.length > 0

		// fork/resume/new sessions inherit the source conversation but get a fresh
		// sidecar; inherit the previous session's compression blocks so they are
		// not silently lost (which previously forced re-compressing all history).
		if (state.compressionBlocks.length === 0 && event.previousSessionFile) {
			try {
				const inherited = await loadDcpStateFromSessionFile(event.previousSessionFile)
				if (state.sessionEpoch !== sessionStartEpoch) return
				const added = inheritCompressionBlocks(state, inherited)
				if (added > 0) {
					pendingInheritedBlockReconciliation = true
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
				messageIdControl: "distributed-carriers",
				state: summarizeDcpState(state, effectiveConfig),
				...details,
			}, ctx)
			return { messages }
		}

		writeDcpDebugLog(effectiveConfig, "context.start", {
			inputMessages: event.messages.length,
			filteredMessages: contextMessages.length,
			filteredDcpControlPlaneMessages: event.messages.length - contextMessages.length,
		}, ctx)
		latestProviderOpportunityAvailable = false
		if (!effectiveConfig.enabled) {
			writeDcpDebugLog(effectiveConfig, "context.disabled", {
				inputMessages: event.messages.length,
				filteredMessages: contextMessages.length,
			}, ctx)
			return { messages: contextMessages }
		}
		annotateMessagesWithBranchEntryIds(contextMessages, ctx)
		const rehydration = rehydrateToolRecordsFromMessages(contextMessages, state)
		if (rehydration.recordsUpdated > 0) {
			writeDcpDebugLog(effectiveConfig, "context.rehydrated_tool_records", { ...rehydration }, ctx)
		}
		if (pendingInheritedBlockReconciliation) {
			pendingInheritedBlockReconciliation = false
			const reconciliation = reconcileInheritedCompressionBlocks(contextMessages, state)
			writeDcpDebugLog(
				effectiveConfig,
				"context.reconciled_inherited_blocks",
				{ ...reconciliation },
				ctx,
			)
			if (
				reconciliation.activatedBlockIds.length > 0 ||
				reconciliation.deactivatedBlockIds.length > 0
			) {
				await saveDcpState(ctx, state)
			}
		}
		const prunedToolCountBeforeCheckpoint = state.prunedToolIds.size
		let prunedMessages = applyPruning(contextMessages, state, effectiveConfig)
		const automaticPrunesCommitted = state.prunedToolIds.size - prunedToolCountBeforeCheckpoint
		if (automaticPrunesCommitted > 0) {
			const clearedAnchors = clearDcpNudgeAnchors(state)
			await saveDcpState(ctx, state)
			writeDcpDebugLog(effectiveConfig, "prune.tool_checkpoint", {
				committed: automaticPrunesCommitted,
				clearedAnchors,
				turn: state.currentTurn,
				blockId: state.lastAutomaticPruneBlockId,
				state: summarizeDcpState(state, effectiveConfig),
			}, ctx)
		}
		let candidate = null as ReturnType<typeof detectCompressionCandidate>
		let emergencyCompressionCandidate = null as ReturnType<typeof detectEmergencyCompressionCandidate>
		let messageCandidates = [] as ReturnType<typeof detectMessageCompressionCandidates>
		let emergencySelection = null as ReturnType<typeof analyzeEmergencyCurrentTurn> | null
		let emergencyPruneResult = null as ReturnType<typeof pruneEmergencyCurrentTurn> | null

		// In manual mode we still apply pruning strategies (if
		// automaticStrategies is on) but skip routine autonomous nudges. Emergency
		// max-context nudges are still allowed, matching the manual-mode prompt.
		const nativeUsage = normalizeDcpContextUsage(safeGetContextUsage(ctx))
		const ctxModel = (ctx as any).model
		const fallbackContextWindow = nativeUsage?.contextWindow ?? (
			typeof ctxModel?.contextWindow === "number" && Number.isFinite(ctxModel.contextWindow) && ctxModel.contextWindow > 0
				? ctxModel.contextWindow
				: undefined
		)
		const repoProjectedTokens = prunedMessages.reduce(
			(sum, message) => sum + estimateMessageTokens(message),
			0,
		)
		const usage = nativeUsage ?? (fallbackContextWindow
			? { tokens: null, contextWindow: fallbackContextWindow, percent: null }
			: undefined)
		if (usage) {
			// Record the observed context window on EVERY context event (before
			// any early return) so a mid-session model/window downgrade is
			// detectable even when earlier passes were below threshold. We
			// snapshot the previous value first so the downgrade check below
			// compares against the window the prior pass actually saw.
			const currentContextWindow = usage.contextWindow
			const previousContextWindow = state.lastContextWindow
			if (
				typeof currentContextWindow === "number" &&
				Number.isFinite(currentContextWindow) &&
				currentContextWindow > 0
			) {
				state.lastContextWindow = currentContextWindow
			}

			const provider = ctxModel?.provider ?? ctxModel?.providerId ?? ctxModel?.providerID
			const model = ctxModel?.id ?? ctxModel?.model ?? ctxModel?.modelId ?? ctxModel?.modelID
			const thresholds = resolveContextThresholds(effectiveConfig, [
				provider && model ? `${provider}/${model}` : undefined,
				model,
			], usage.contextWindow)
			const emergencySettings = effectiveConfig.strategies.emergencyCurrentTurnPruning
			const estimatorMarginTokens = Math.max(256, Math.ceil(usage.contextWindow * 0.0025))
			const budget = planDcpBudget({
				providerUsageTokens: nativeUsage?.tokens,
				repoProjectedTokens,
				contextWindow: usage.contextWindow,
				reservedOutputTokens: typeof ctxModel?.maxTokens === "number" ? ctxModel.maxTokens : 0,
				reservedToolTokens: 0,
				maxContextPercent: thresholds.maxContextPercent,
				hardContextPercent: emergencySettings.hardContextPercent,
				targetContextPercent: Math.min(
					Math.max(0, emergencySettings.targetContextPercent),
					Math.max(0, thresholds.maxContextPercent * 0.9),
				),
				summaryBufferEnabled: effectiveConfig.compress.summaryBuffer,
				activeSummaryTokens: getActiveSummaryTokenEstimate(state),
				summaryBufferMaxBonusRatio: SUMMARY_BUFFER_MAX_CONTEXT_BONUS,
				estimatorMarginTokens,
			})
			thresholds.maxContextPercent = budget.softHeadroomTokens / usage.contextWindow
			const contextPercent = budget.projectedBeforeTokens / usage.contextWindow
			const nativePressure = emergencyPressureState(
				contextPercent,
				thresholds.maxContextPercent,
				emergencySettings.hardContextPercent,
			)
			const hardEmergencyReached = nativePressure.hardEmergencyReached || budget.hardPressure
			const contextLimitReached = nativePressure.contextLimitReached || budget.pressured
			const emergencyPressureReached = nativePressure.emergencyPressureReached || budget.pressured
			const routineNudgesAllowed = contextPercent > thresholds.minContextPercent
			if (!budget.capacityExceeded && state.progressRecovery) state.progressRecovery = undefined
			if (!emergencyPressureReached && !routineNudgesAllowed) {
				const clearedAnchors = clearDcpNudgeAnchors(state)
				const resetEmergencyPasses = state.consecutiveIgnoredStrongNudges > 0
				state.consecutiveIgnoredStrongNudges = 0
				if (clearedAnchors > 0 || resetEmergencyPasses) await saveDcpState(ctx, state)
				return finishContext("below-threshold", prunedMessages, {
					contextPercent,
					thresholds,
					clearedAnchors,
					resetEmergencyPasses,
				})
			}

			let toolCallsSinceLastUser = 0
			for (let i = prunedMessages.length - 1; i >= 0; i--) {
				const msg = prunedMessages[i] as any
				if (msg.role === "user") break
				if (msg.role === "toolResult") toolCallsSinceLastUser++
			}

			// Switch-aware pre-emptive nudge: detect a mid-session context-window
			// downgrade (e.g. model switch from a 1M window to a 275K window).
			// Inherited tokens that were cheap on the larger window can suddenly
			// sit above minContextPercent on the smaller one. When that happens,
			// force a strong nudge on this pass so the model is told to compress
			// before the smaller window fills, instead of waiting for cadence.
			const windowDowngraded =
				typeof previousContextWindow === "number" &&
				Number.isFinite(previousContextWindow) &&
				previousContextWindow > 0 &&
				typeof currentContextWindow === "number" &&
				Number.isFinite(currentContextWindow) &&
				currentContextWindow < previousContextWindow * 0.9 &&
				contextPercent > thresholds.minContextPercent
			const contextWindowChanged =
				typeof previousContextWindow === "number" &&
				Number.isFinite(previousContextWindow) &&
				typeof currentContextWindow === "number" &&
				Number.isFinite(currentContextWindow) &&
				currentContextWindow !== previousContextWindow
			if (contextWindowChanged) state.consecutiveIgnoredStrongNudges = 0

			const nudgeType = hardEmergencyReached && !contextLimitReached
				? "context-strong"
				: windowDowngraded
				? "context-strong"
				: getNudgeType(
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
					budget.pressured
						? { requiredSavingsTokens: budget.requiredSavingsTokens }
						: undefined,
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
					budget,
					nudgeType,
					candidate,
					messageCandidates,
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
			}

			const hasNormalCompressionSuggestion =
				candidate !== null || messageCandidates.length > 0
			if (
				emergencySettings.enabled &&
				emergencyPressureReached &&
				!manualEmergencyOnly &&
				!hasNormalCompressionSuggestion
			) {
				emergencySelection = analyzeEmergencyCurrentTurn(
					prunedMessages,
					state,
					effectiveConfig,
				)
				messageCandidates = emergencyCurrentTurnMessageCandidates(
					emergencySelection,
					effectiveConfig,
				)
			}

			if (contextLimitReached && !manualEmergencyOnly && candidate === null) {
				emergencyCompressionCandidate = detectEmergencyCompressionCandidate(
					prunedMessages,
					state,
					effectiveConfig,
					contextPercent,
					thresholds.maxContextPercent,
					{ requiredSavingsTokens: budget.requiredSavingsTokens },
				)
				if (emergencyCompressionCandidate) {
					writeDcpDebugLog(effectiveConfig, "context.emergency_compression_candidate", {
						contextPercent,
						thresholds,
						candidate: emergencyCompressionCandidate,
						...(emergencySelection?.stats ?? {}),
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
				}
			}

			if (
				emergencySelection &&
				candidate === null &&
				emergencyCompressionCandidate === null
			) {
				writeDcpDebugLog(effectiveConfig, "context.strong_nudge_without_candidate", {
					contextPercent,
					thresholds,
					nudgeType,
					emergencyCandidates: messageCandidates.length,
					...emergencySelection.stats,
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
			}

			let hasCompressionSuggestion =
				candidate !== null || emergencyCompressionCandidate !== null || messageCandidates.length > 0
			const blockedReason = inferDcpBlockedReason({
				pressured: emergencyPressureReached,
				candidateAvailable: candidate !== null || emergencyCompressionCandidate !== null,
				messageCandidateCount: messageCandidates.length,
				requiredSavingsTokens: budget.requiredSavingsTokens,
				capacityExceeded: budget.capacityExceeded,
				emergencyStats: emergencySelection?.stats,
			})
			if (blockedReason) {
				writeDcpDebugLog(effectiveConfig, "context.progress_blocked", {
					phase: "blocked",
					blocked_reason: blockedReason,
					contextPercent,
					thresholds,
					budget,
					...(emergencySelection?.stats ?? {}),
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
			}
			if (blockedReason && budget.capacityExceeded) {
				state.progressRecovery = {
					blockedReason,
					projectedBeforeTokens: budget.projectedBeforeTokens,
					inputCapacityTokens: budget.inputCapacityTokens,
					requiredSavingsTokens: budget.requiredSavingsTokens,
					contextWindow: budget.contextWindow,
					createdAt: Date.now(),
				}
				clearDcpNudgeAnchors(state)
				await saveDcpState(ctx, state)
				const abortSupported = typeof (ctx as any).abort === "function"
				if (abortSupported) (ctx as any).abort()
				writeDcpDebugLog(effectiveConfig, "context.progress_handoff", {
					phase: "blocked",
					blocked_reason: blockedReason,
					handoff: abortSupported ? "abort-current-agent-operation" : "abort-unavailable",
					budget,
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
				return finishContext("progress.blocked_handoff", prunedMessages, {
					blocked_reason: blockedReason,
					handoff: abortSupported ? "abort-current-agent-operation" : "abort-unavailable",
					budget,
				})
			}
			if (!manualEmergencyOnly && !emergencyPressureReached && !hasCompressionSuggestion) {
				const clearedAnchors = clearDcpNudgeAnchors(state)
				if (clearedAnchors > 0) await saveDcpState(ctx, state)
				if (nudgeType || clearedAnchors > 0) {
					writeDcpDebugLog(effectiveConfig, "context.no_compression_candidate", {
						contextPercent,
						thresholds,
						nudgeType,
						clearedAnchors,
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
				}
			}

			// E05 patience advances only after a correlated main-provider response
			// completes. Repeated context transforms merely make the reminder
			// available; they do not consume another model opportunity.
			if (!emergencyPressureReached) state.consecutiveIgnoredStrongNudges = 0

			// Auto-compress fallback: if the model has ignored enough strong
			// nudges while above the emergency threshold, DCP creates a
			// compression block itself instead of nudging again.
			if (!manualEmergencyOnly) {
				const autoCandidate = candidate ?? emergencyCompressionCandidate
				const autoDecision = decideAutoCompress(
					state,
					effectiveConfig,
					contextPercent,
					thresholds.maxContextPercent,
					autoCandidate,
				)
				if (contextLimitReached && autoCandidate === null) {
					writeDcpDebugLog(effectiveConfig, "compress.auto_blocked_no_candidate", {
						autoCompressEnabled: effectiveConfig.compress.autoCompress.enabled,
						decisionReason: autoDecision.reason,
						blocked_reason: blockedReason,
						contextPercent,
						thresholds,
						consecutiveEmergencyPasses: state.consecutiveIgnoredStrongNudges,
						...(emergencySelection?.stats ?? {}),
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
				}
				if (autoDecision.shouldFire && autoCandidate) {
					try {
						const autoOperationEpoch = state.sessionEpoch
						const autoPersistenceTarget = captureDcpPersistenceTarget(ctx)
						const autoResult = await createAutoCompressionBlock({
							candidate: autoCandidate,
							topic: "Auto-compressed slice",
							state,
							config: effectiveConfig,
							messages: prunedMessages,
							modelRegistry: (ctx as any).modelRegistry,
							signal: (ctx as any).signal,
							cwd: (ctx as any).cwd,
							requiredGainTokens: budget.requiredSavingsTokens,
							persistState: autoPersistenceTarget
								? (preparedState) => saveDcpStateToTarget(autoPersistenceTarget, preparedState)
								: undefined,
						})
						if (state.sessionEpoch !== autoOperationEpoch) {
							throw new Error("Auto-compression result became stale because the active session changed after commit")
						}
						// Re-apply pruning so the new block takes effect on this
						// same context pass instead of the next one.
						prunedMessages = applyPruning(prunedMessages, state, effectiveConfig)
						const clearedAnchors = clearDcpNudgeAnchors(state)
						state.consecutiveIgnoredStrongNudges = 0
						state.progressRecovery = undefined
						if (autoPersistenceTarget) {
							await saveDcpStateToTarget(autoPersistenceTarget, state)
						}
						if (state.sessionEpoch !== autoOperationEpoch) {
							throw new Error("Auto-compression final publication became stale because the active session changed")
						}
						writeDcpDebugLog(effectiveConfig, "compress.auto", {
							trigger: autoDecision.reason,
							blockId: `b${autoResult.blockId}`,
							summaryMode: autoResult.summaryMode,
							summarizerModelRef: autoResult.summarizerModelRef,
							summarizerAttempts: autoResult.summarizerAttempts,
							summaryTokens: autoResult.summaryTokens,
							removedTokenEstimate: autoResult.removedTokenEstimate,
							candidate: autoCandidate,
							clearedAnchors,
							state: summarizeDcpState(state, effectiveConfig),
						}, ctx)
						return finishContext("compress.auto", prunedMessages, {
							candidate: autoCandidate,
							messageCandidates,
							contextPercent,
							thresholds,
							clearedAnchors,
						})
					} catch (error) {
						const autoBlockedReason = error instanceof AutoCompressionBlockedError
							? error.blockedReason
							: undefined
						writeDcpDebugLog(effectiveConfig, "compress.auto_failed", {
							trigger: autoDecision.reason,
							phase: autoBlockedReason ? "blocked" : "degraded",
							blocked_reason: autoBlockedReason,
							error: error instanceof Error ? error.message : String(error),
							candidate: autoCandidate,
							state: summarizeDcpState(state, effectiveConfig),
						}, ctx)
						if (autoBlockedReason && budget.capacityExceeded) {
							state.progressRecovery = {
								blockedReason: autoBlockedReason,
								projectedBeforeTokens: budget.projectedBeforeTokens,
								inputCapacityTokens: budget.inputCapacityTokens,
								requiredSavingsTokens: budget.requiredSavingsTokens,
								contextWindow: budget.contextWindow,
								createdAt: Date.now(),
							}
							clearDcpNudgeAnchors(state)
							await saveDcpState(ctx, state)
							const abortSupported = typeof (ctx as any).abort === "function"
							if (abortSupported) (ctx as any).abort()
							return finishContext("progress.blocked_handoff", prunedMessages, {
								blocked_reason: autoBlockedReason,
								handoff: abortSupported ? "abort-current-agent-operation" : "abort-unavailable",
								budget,
							})
						}
						// Recoverable failures fall through to normal nudge emission.
					}
				}
			}

			// Model-independent safety floor for an unfinished active turn. Only
			// result bodies are replaced; user messages and structural tool pairs
			// stay intact. Fresh results are ineligible until before_provider_request
			// records that the model has had a chance to consume them.
			const emergencyPatienceExceeded =
				state.consecutiveIgnoredStrongNudges > Math.max(0, Math.floor(emergencySettings.patience))
			if (
				emergencySettings.enabled &&
				emergencyPressureReached &&
				candidate === null &&
				emergencySelection &&
				emergencySelection.eligible.length > 0 &&
				(hardEmergencyReached || emergencyPatienceExceeded)
			) {
				const selectionStatsBeforePrune = emergencySelection.stats
				const configuredTarget = Math.max(0, Math.min(1, emergencySettings.targetContextPercent))
				const emergencyMarginTarget = Math.max(0, thresholds.maxContextPercent * 0.9)
				const targetContextPercent = Math.min(configuredTarget, emergencyMarginTarget)
				const targetRecoveryTokens = Math.max(
					1,
					Math.ceil((contextPercent - targetContextPercent) * usage.contextWindow),
				)
				emergencyPruneResult = pruneEmergencyCurrentTurn(
					emergencySelection,
					state,
					targetRecoveryTokens,
				)
				if (emergencyPruneResult.prunedToolCallIds.length > 0) {
					prunedMessages = applyPruning(contextMessages, state, effectiveConfig)
					const clearedAnchors = clearDcpNudgeAnchors(state)
					state.consecutiveIgnoredStrongNudges = 0
					state.progressRecovery = undefined
					emergencySelection = analyzeEmergencyCurrentTurn(prunedMessages, state, effectiveConfig)
					messageCandidates = emergencyCurrentTurnMessageCandidates(emergencySelection, effectiveConfig)
					emergencyCompressionCandidate = detectEmergencyCompressionCandidate(
						prunedMessages,
						state,
						effectiveConfig,
						contextPercent,
						thresholds.maxContextPercent,
						{ requiredSavingsTokens: budget.requiredSavingsTokens },
					)
					hasCompressionSuggestion =
						candidate !== null || emergencyCompressionCandidate !== null || messageCandidates.length > 0
					await saveDcpState(ctx, state)
					writeDcpDebugLog(effectiveConfig, "prune.emergency_current_turn", {
						trigger: hardEmergencyReached ? "hard-context-percent" : "ignored-emergency-reminders",
						contextPercent,
						thresholds,
						targetContextPercent,
						targetRecoveryTokens,
						prunedOutputs: emergencyPruneResult.prunedToolCallIds.length,
						clearedAnchors,
						estimatedTokensRecovered: emergencyPruneResult.estimatedTokensRecovered,
						estimatedContextPercentAfter: Math.max(
							0,
							((usage.tokens ?? contextPercent * usage.contextWindow) -
								emergencyPruneResult.estimatedTokensRecovered) /
							usage.contextWindow,
						),
						targetMet: emergencyPruneResult.estimatedTokensRecovered >= targetRecoveryTokens,
						eligibleExhausted:
							emergencyPruneResult.prunedToolCallIds.length >= selectionStatsBeforePrune.eligiblePairs,
						...selectionStatsBeforePrune,
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
				}
			}

			if (nudgeType && !manualEmergencyOnly && (hasCompressionSuggestion || emergencyPressureReached)) {
				latestProviderOpportunityAvailable = emergencyPressureReached
				const nudgeText = appendConcreteNudgeGuidance(
					baseNudgeText(nudgeType),
					candidate ?? emergencyCompressionCandidate,
					messageCandidates,
					state,
				)

				const anchorResult = upsertNudgeAnchor(
					prunedMessages,
					state,
					nudgeType,
					{ contextPercent, renderedReminder: nudgeText },
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

			// Persist patience/window changes even when an existing anchor was only
			// re-applied (that path intentionally emits telemetry without updating it).
			await saveDcpState(ctx, state)
		}

		const anchorsBeforeFinalization = state.nudgeAnchors.length
		if (state.manualMode) {
			state.nudgeAnchors = state.nudgeAnchors.filter((anchor) =>
				anchor.type === "context-strong" || anchor.type === "context-soft",
			)
		}
		const nudgeApplication = applyAnchoredNudges(prunedMessages, state, (anchor) =>
			appendConcreteNudgeGuidance(
				baseNudgeText(anchor.type),
				candidate ?? emergencyCompressionCandidate,
				messageCandidates,
				state,
			),
		)
		if (state.nudgeAnchors.length !== anchorsBeforeFinalization || nudgeApplication.stateChanged) {
			await saveDcpState(ctx, state)
		}

		return finishContext("complete", prunedMessages, {
			candidate,
			messageCandidates,
			emergencyCurrentTurn: emergencySelection?.stats,
			emergencyPrune: emergencyPruneResult,
		})
	})

	// ── 10b. provider lifecycle evidence ─────────────────────────────────────
	pi.on("before_provider_request", async (event, ctx) => {
		const effectiveConfig = configForContext(ctx)
		if (!effectiveConfig.enabled) {
			providerEvidenceTracker.reset()
			return undefined
		}

		const providerEvidence = collectProviderToolResultEvidence(event.payload)
		const pendingToolIds = new Set<string>()
		for (const meta of state.messageMetaSnapshot.values()) {
			if (meta.role !== "toolResult") continue
			if (!meta.toolCallId || state.prunedToolIds.has(meta.toolCallId)) continue
			if (state.providerSeenToolIds.has(meta.toolCallId)) continue
			const record = state.toolCalls.get(meta.toolCallId)
			if (record && providerPayloadIncludesToolResult(providerEvidence, record)) {
				pendingToolIds.add(meta.toolCallId)
			}
		}

		const model = (ctx as any)?.model
		const target = captureDcpPersistenceTarget(ctx)
		const pending = providerEvidenceTracker.begin({
			sessionEpoch: state.sessionEpoch,
			provider: typeof model?.provider === "string" ? model.provider : undefined,
			model: typeof model?.id === "string" ? model.id : undefined,
			contentRevision: providerPayloadRevision(event.payload),
			statePath: target?.statePath,
			sessionId: target?.sessionId,
			toolIds: pendingToolIds,
			opportunityAvailable: latestProviderOpportunityAvailable,
		})

		writeDcpDebugLog(effectiveConfig, "provider_payload.message_ids", {
			injected: false,
			delivery: "distributed-carriers",
			pendingToolResults: pendingToolIds.size,
			attempts: pending.attempts,
			ambiguous: pending.ambiguous,
			opportunityAvailable: pending.opportunityAvailable,
			provider: pending.provider,
			model: pending.model,
			state: summarizeDcpState(state, effectiveConfig),
		}, ctx)
		// IDs are already attached to deterministic user/tool-result context
		// carriers. Replacing the payload here would move metadata from the old
		// tail to the new one and break strict append-only Responses continuation.
		return undefined
	})

	// HTTP acceptance is deliberately diagnostic only. The SDK fires this hook
	// before consuming the response body, so 2xx cannot prove that the provider
	// actually completed the assistant stream.
	pi.on("after_provider_response", async (event, ctx) => {
		const effectiveConfig = configForContext(ctx)
		const pending = providerEvidenceTracker.snapshot()
		writeDcpDebugLog(effectiveConfig, "provider_payload.http_response", {
			status: event.status,
			accepted: event.status >= 200 && event.status < 300,
			pendingToolResults: pending?.toolIds.size ?? 0,
			attempts: pending?.attempts ?? 0,
			ambiguous: pending?.ambiguous ?? false,
			state: summarizeDcpState(state, effectiveConfig),
		}, ctx)
	})

	// message_end is emitted for the finalized assistant message after the
	// response stream settles. Without a provider request ID in SDK 0.85.1, only
	// one unambiguous request shape (or identical retries) is safe to promote.
	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "assistant") return
		const effectiveConfig = configForContext(ctx)
		if (!effectiveConfig.enabled) {
			providerEvidenceTracker.reset()
			return
		}

		const message = event.message as any
		const completion = providerEvidenceTracker.complete({
			sessionEpoch: state.sessionEpoch,
			provider: typeof message.provider === "string" ? message.provider : undefined,
			model: typeof message.model === "string" ? message.model : undefined,
			stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		})
		latestProviderOpportunityAvailable = false

		if (completion.status !== "promote") {
			writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_not_promoted", {
				reason: completion.reason,
				attempts: completion.attempts,
				stopReason: message.stopReason,
				state: summarizeDcpState(state, effectiveConfig),
			}, ctx)
			return
		}

		const assistantInvokedCompress = Array.isArray(message.content) && message.content.some(
			(part: any) => part?.type === "toolCall" && part?.name === "compress",
		)
		const ignoredCompressionOpportunity =
			completion.opportunityAvailable && message.stopReason !== "deferred" && !assistantInvokedCompress

		const commit = providerEvidenceCommitQueue
			.catch(() => {
				// Keep later evidence commits moving after a persistence failure.
			})
			.then(async () => {
				if (state.sessionEpoch !== completion.sessionEpoch) {
					writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_not_promoted", {
						reason: "stale-session",
						attempts: completion.attempts,
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
					return
				}

				const newlySeen = [...completion.toolIds].filter((toolCallId) => !state.providerSeenToolIds.has(toolCallId))
				if (newlySeen.length === 0 && !ignoredCompressionOpportunity) return
				const workingState = {
					...state,
					providerSeenToolIds: new Set(state.providerSeenToolIds),
				}
				for (const toolCallId of newlySeen) workingState.providerSeenToolIds.add(toolCallId)
				if (ignoredCompressionOpportunity) {
					workingState.consecutiveIgnoredStrongNudges = state.consecutiveIgnoredStrongNudges + 1
				}

				try {
					if (completion.statePath) {
						await saveDcpStateToTarget({ statePath: completion.statePath, sessionId: completion.sessionId }, workingState)
					}
				} catch (error) {
					writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_not_promoted", {
						reason: "persistence-failed",
						attempts: completion.attempts,
						error: error instanceof Error ? error.message : String(error),
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
					return
				}

				if (state.sessionEpoch !== completion.sessionEpoch) {
					writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_not_promoted", {
						reason: "stale-session",
						attempts: completion.attempts,
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
					return
				}

				state.providerSeenToolIds = workingState.providerSeenToolIds
				state.consecutiveIgnoredStrongNudges = workingState.consecutiveIgnoredStrongNudges
				writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_seen", {
					attempts: completion.attempts,
					newlySeenToolResults: newlySeen.length,
					ignoredCompressionOpportunity,
					ignoredOpportunities: state.consecutiveIgnoredStrongNudges,
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
			})
		providerEvidenceCommitQueue = commit
		await commit
	})

	// ── 11. agent_end: persist state after each agent run ────────────────────
	pi.on("agent_end", async (_event, ctx) => {
		await saveDcpState(ctx, state)
	})
}
