// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — module entry point for pi-tools-suite
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadConfig, modelKeysFromContext, resolveModelConfig } from "./config.js"
import {
	createState,
	resetState,
	createInputFingerprint,
} from "./state.js"
import {
	appendDcpJournalDelta,
	appendDcpJournalOperation,
	buildDcpJournalDelta,
	createDcpJournalInit,
	createDcpJournalMirror,
	DcpJournalError,
	readDcpJournalBranch,
	replayDcpJournal,
	type DcpJournalMirror,
} from "./journal.js"
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
	hasCacheSafeNudgeCarrier,
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
	providerPayloadIncludesReminder,
	providerPayloadRevision,
	ProviderEvidenceTracker,
} from "./provider-tool-results.js"
import { rehydrateToolRecordsFromMessages } from "./recovery.js"
import { inferDcpBlockedReason, planDcpBudget, type DcpBlockedReason } from "./progress-controller.js"
import { createBudgetedAutoCompressionBlock } from "./auto-compress-budget.js"
import { outstandingCompressionTokens, resetCompressionProgress, routineRecoveryTokens, trackCompressionProgress } from "./compression-progress.js"
import { captureDcpTransactionGuard, cloneDcpTransactionState, runDcpStateTransaction, invalidateDcpStateOwner } from "./state-transaction.js"

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

// Diagnostic DCP custom messages are never provider context.
const DCP_CONTROL_PLANE_CUSTOM_TYPES = new Set(["dcp-nudge"])
const SUMMARY_BUFFER_MAX_CONTEXT_BONUS = 0.05

function isDcpControlPlaneMessage(message: any): boolean {
	return message?.role === "custom" && DCP_CONTROL_PLANE_CUSTOM_TYPES.has(message.customType)
}

function withoutAutoSummaryModels(config: ReturnType<typeof loadConfig>): ReturnType<typeof loadConfig> {
	return {
		...config,
		compress: {
			...config.compress,
			autoCompress: {
				...config.compress.autoCompress,
				summarizerModel: [],
				summarizerFallbackModels: [],
			},
		},
	}
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

export default async function dcpModule(pi: ExtensionAPI, dependencies: { config?: ReturnType<typeof loadConfig>; state?: ReturnType<typeof createState> } = {}): Promise<void> {
	// ── 1. Load config ────────────────────────────────────────────────────────
	const config = dependencies.config ?? loadConfig()
	const configForContext = (ctx: unknown) => resolveModelConfig(config, modelKeysFromContext(ctx))
	const hasEnabledModelOverride = Object.values(config.modelOverrides).some(
		(override) => override.enabled === true,
	)

	if (!config.enabled && !hasEnabledModelOverride) return

	// ── 2. Create state ───────────────────────────────────────────────────────
	const state = dependencies.state ?? createState()
	let journalMirror: DcpJournalMirror | undefined
	let journalSupported = false
	let journalBlockedReason: string | undefined
	let journalPersistent = false
	const providerEvidenceTracker = new ProviderEvidenceTracker()
	let providerEvidenceCommitQueue = Promise.resolve()
	let latestProviderOpportunityAvailable = false
	let latestProviderOpportunityKind: "routine" | "emergency" | undefined
	let latestProviderReminder: string | undefined
	let autoSummarizerDegraded = false
	const warnedProgress = new Set<string>()
	const isJournalSessionSupported = () => journalSupported && journalBlockedReason === undefined
	const persistJournalState = async (
		ctx: ExtensionContext,
		targetState: ReturnType<typeof createState>,
		publication: { beforePublish?: () => void; onPublished?: () => void } = {},
	): Promise<void> => {
		if (!isJournalSessionSupported() || !journalMirror) {
			throw new DcpJournalError(journalBlockedReason ?? "DCP journal is not initialized for this session")
		}
		if (!journalPersistent) {
			const delta = buildDcpJournalDelta(targetState, journalMirror)
			if (!delta) return
			publication.beforePublish?.()
			journalMirror = createDcpJournalMirror(targetState, delta.operationId)
			publication.onPublished?.()
			return
		}
		journalMirror = appendDcpJournalDelta(pi, ctx, targetState, journalMirror, publication)
	}
	const branchHasConversation = (branch: readonly any[]): boolean => branch.some((entry) =>
		entry?.type === "message" || entry?.type === "custom_message" || entry?.type === "compaction" || entry?.type === "branch_summary",
	)
	const loadJournalState = async (ctx: ExtensionContext, allowInitialize: boolean): Promise<void> => {
		journalMirror = undefined
		journalSupported = false
		journalBlockedReason = undefined
		journalPersistent = false
		const branch = await readDcpJournalBranch(ctx)
		const manager = ctx.sessionManager as any
		const persistentSession = (typeof manager.isPersisted === "function" && manager.isPersisted())
			|| (typeof manager.getSessionFile === "function" && Boolean(manager.getSessionFile()))
		try {
			const replay = replayDcpJournal(branch, state)
			if (replay.initialized && replay.lastOperationId) {
				journalSupported = true
				journalPersistent = persistentSession
				journalMirror = createDcpJournalMirror(state, replay.lastOperationId)
				return
			}
			if (allowInitialize && !branchHasConversation(branch)) {
				const init = createDcpJournalInit()
				if (persistentSession) appendDcpJournalOperation(pi, ctx, init)
				journalSupported = true
				journalPersistent = persistentSession
				journalMirror = createDcpJournalMirror(state, init.operationId)
				return
			}
			// Clean break: a pre-journal conversation is deliberately unsupported.
			// Do not inspect external state, infer prior blocks, or create a
			// compatibility checkpoint from existing history.
			journalSupported = false
		} catch (error) {
			journalBlockedReason = error instanceof Error ? error.message : String(error)
			journalSupported = false
			journalMirror = undefined
		}
	}
	const ensureEphemeralJournal = (ctx: ExtensionContext): void => {
		if (journalSupported || journalBlockedReason) return
		const manager = ctx.sessionManager as any
		const persisted = typeof manager.isPersisted === "function" ? manager.isPersisted() : false
		const sessionFile = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined
		if (persisted || sessionFile) return
		let branch: unknown[] = []
		try {
			const current = manager.getBranch?.()
			branch = Array.isArray(current) ? current : []
		} catch { return }
		if (branch.length > 0) return
		const init = createDcpJournalInit()
		journalSupported = true
		journalPersistent = false
		journalMirror = createDcpJournalMirror(state, init.operationId)
	}
	const warnProgress = (ctx: ExtensionContext, reason: string, message: string) => {
		const key = `${state.sessionEpoch}:${reason}`
		if (warnedProgress.has(key)) return
		warnedProgress.add(key)
		writeDcpDebugLog(configForContext(ctx), "context.progress_warning", { reason, message }, ctx)
		try {
			pi.appendEntry("dcp-nudge", {
				event: "progress-blocked", reason, message,
				ignoredOpportunities: state.consecutiveIgnoredNudges,
				remainingRecoveryTokens: state.compressionProgress?.remainingTokens,
				createdAt: Date.now(),
			})
		} catch { /* Diagnostic only; do not turn an explicit blocked state into an extension failure. */ }
		try { ctx.ui.notify(message, "warning") } catch { /* Headless/notification failure is not a persistence failure. */ }
	}
	const invalidateOwner = () => {
			invalidateDcpStateOwner(state)
			providerEvidenceTracker.reset()
			latestProviderOpportunityAvailable = false
			latestProviderOpportunityKind = undefined
			latestProviderReminder = undefined
			autoSummarizerDegraded = false
			resetCompressionProgress(state)
			warnedProgress.clear()
	}
	pi.on("model_select", invalidateOwner)
	pi.on("session_tree", async (_event, ctx) => {
		invalidateOwner()
		resetState(state)
		if (config.manualMode.enabled) state.manualMode = true
		await loadJournalState(ctx, false)
	})
	pi.on("session_compact", invalidateOwner)
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
	registerCompressTool(pi, state, config, {
		persistState: persistJournalState,
		isSessionSupported: isJournalSessionSupported,
	})

	// ── 4. Register /dcp commands ─────────────────────────────────────────────
	registerCommands(pi, state, config, {
		persistState: persistJournalState,
		isSessionSupported: isJournalSessionSupported,
	})

	// ── 5. session_start: restore state from session entries ──────────────────
	pi.on("session_start", async (event, ctx) => {
		resetState(state)
		providerEvidenceTracker.reset()
		latestProviderOpportunityAvailable = false
		latestProviderOpportunityKind = undefined
		latestProviderReminder = undefined
		autoSummarizerDegraded = false
		warnedProgress.clear()
		if (config.manualMode.enabled) state.manualMode = true
		await loadJournalState(ctx, event.reason === "new" || event.reason === "startup")
		writeDcpDebugLog(configForContext(ctx), "session_start.journal", {
			reason: event.reason,
			supported: journalSupported,
			blockedReason: journalBlockedReason,
			operations: journalMirror ? "replayed" : "none",
		}, ctx)
		if (!journalSupported && !journalBlockedReason) {
			try {
				ctx.ui.notify(
					"DCP is disabled for this pre-journal session. Start a new session to use the current DCP implementation.",
					"warning",
				)
			} catch { /* Headless mode. */ }
		}
	})

	// Journal operations are committed at the mutation boundary; shutdown does
	// not write a full runtime snapshot.
	pi.on("session_shutdown", async () => {
		journalMirror = undefined
		journalSupported = false
		journalBlockedReason = undefined
		journalPersistent = false
	})

	// ── 7. before_agent_start: inject system prompt ───────────────────────────
	pi.on("before_agent_start", async (event, _ctx) => {
		const effectiveConfig = configForContext(_ctx)
		if (!effectiveConfig.enabled) return { systemPrompt: event.systemPrompt }
		ensureEphemeralJournal(_ctx)
		if (journalBlockedReason) throw new DcpJournalError(`DCP journal is blocked: ${journalBlockedReason}`)
		if (!journalSupported) return { systemPrompt: event.systemPrompt }

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
		const contextEpoch = state.sessionEpoch
		const effectiveConfig = configForContext(ctx)
		ensureEphemeralJournal(ctx)
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
		if (journalBlockedReason) {
			throw new DcpJournalError(`DCP journal is blocked: ${journalBlockedReason}`)
		}
		if (!journalSupported) {
			return { messages: event.messages.filter((message: any) => !isUserVisibleOnlyMessage(message)) }
		}
		latestProviderOpportunityKind = undefined
		latestProviderReminder = undefined
		annotateMessagesWithBranchEntryIds(contextMessages, ctx)
		const rehydration = rehydrateToolRecordsFromMessages(contextMessages, state)
		if (rehydration.recordsUpdated > 0) {
			writeDcpDebugLog(effectiveConfig, "context.rehydrated_tool_records", { ...rehydration }, ctx)
		}
		let prunedMessages = applyPruning(contextMessages, state, effectiveConfig)
		// Stable IDs and any pruning decisions that affect this provider-visible
		// projection must be committed before the request can use them.
		await persistJournalState(ctx, state)
		let candidate = null as ReturnType<typeof detectCompressionCandidate>
		let emergencyCompressionCandidate = null as ReturnType<typeof detectEmergencyCompressionCandidate>
		let messageCandidates = [] as ReturnType<typeof detectMessageCompressionCandidates>
		let emergencySelection = null as ReturnType<typeof analyzeEmergencyCurrentTurn> | null
		let emergencyPruneResult = null as ReturnType<typeof pruneEmergencyCurrentTurn> | null

		// Manual mode skips routine autonomous nudges and automatic summary
		// creation. The bounded emergency safety path remains separate, matching
		// the manual-mode prompt.
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
				const resetEmergencyPasses = state.consecutiveIgnoredStrongNudges > 0 || state.consecutiveIgnoredNudges > 0 || !!state.compressionProgress
				resetCompressionProgress(state)
				warnedProgress.clear()
				if (clearedAnchors > 0) await persistJournalState(ctx, state)
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
			if (contextWindowChanged) resetCompressionProgress(state)

			const requestedRecoveryTokens = emergencyPressureReached
				? budget.requiredSavingsTokens
				: routineRecoveryTokens(budget.projectedBeforeTokens, usage.contextWindow, thresholds.minContextPercent)
			const progressInput = {
				projectedTokens: repoProjectedTokens,
				observedTokens: budget.projectedBeforeTokens,
				contextWindow: usage.contextWindow,
				requiredTokens: requestedRecoveryTokens,
				kind: emergencyPressureReached ? "emergency" as const : "routine" as const,
				targetHeadroomTokens: emergencyPressureReached ? budget.targetHeadroomTokens : undefined,
			}
			const remainingRecoveryTokens = outstandingCompressionTokens(state, progressInput)
			if (remainingRecoveryTokens === 0) {
				resetCompressionProgress(state)
				warnedProgress.clear()
			}
			const planningRecoveryTokens = remainingRecoveryTokens !== undefined && remainingRecoveryTokens > 0
				? state.compressionProgress?.kind === progressInput.kind ? remainingRecoveryTokens : Math.max(remainingRecoveryTokens, requestedRecoveryTokens)
				: requestedRecoveryTokens
			const routineEscalated = !state.manualMode && routineNudgesAllowed &&
				state.consecutiveIgnoredNudges > Math.max(0, Math.floor(effectiveConfig.compress.autoCompress.patience))
			const progressPressureReached = emergencyPressureReached || routineEscalated
			// A marathon's first useful reminder must not depend on already having
			// ignored a reminder. Plan a closed, provider-seen same-turn prefix in
			// the routine zone too; only automatic publication waits for patience.
			const routineSameTurnPlanning = !state.manualMode && routineNudgesAllowed && effectiveConfig.compress.autoCandidates.enabled
			const sameTurnPlanningAllowed = emergencyPressureReached || routineSameTurnPlanning
			const planningThreshold = emergencyPressureReached
				? Math.min(thresholds.maxContextPercent, emergencySettings.hardContextPercent)
				: thresholds.minContextPercent

			const nudgeType = routineEscalated || (hardEmergencyReached && !contextLimitReached)
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
					progressPressureReached
						? { requiredSavingsTokens: planningRecoveryTokens }
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
				sameTurnPlanningAllowed &&
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

			if (sameTurnPlanningAllowed && !manualEmergencyOnly && candidate === null) {
				emergencyCompressionCandidate = detectEmergencyCompressionCandidate(
					prunedMessages,
					state,
					effectiveConfig,
					contextPercent,
					planningThreshold,
					{ requiredSavingsTokens: planningRecoveryTokens },
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
			if (!manualEmergencyOnly && (hasCompressionSuggestion || emergencyPressureReached)) {
				trackCompressionProgress(state, progressInput)
				latestProviderOpportunityKind = emergencyPressureReached ? "emergency" : !state.manualMode ? "routine" : undefined
			}
			const blockedReason = inferDcpBlockedReason({
				pressured: progressPressureReached,
				candidateAvailable: candidate !== null || emergencyCompressionCandidate !== null,
				messageCandidateCount: messageCandidates.length,
				requiredSavingsTokens: planningRecoveryTokens,
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
				if (routineEscalated) warnProgress(ctx, blockedReason,
					`DCP cannot safely meet its compression goal: ${blockedReason}. Context has not been recovered.`)
			}
			if (blockedReason && budget.capacityExceeded) {
				warnProgress(
					ctx,
					blockedReason,
					`DCP cannot fit the next provider request safely (${budget.projectedBeforeTokens} projected input tokens > ${budget.inputCapacityTokens} input capacity): ${blockedReason}. The current agent operation is being stopped instead of sending an oversized request.`,
				)
				state.progressRecovery = {
					blockedReason,
					projectedBeforeTokens: budget.projectedBeforeTokens,
					inputCapacityTokens: budget.inputCapacityTokens,
					requiredSavingsTokens: budget.requiredSavingsTokens,
					contextWindow: budget.contextWindow,
					createdAt: Date.now(),
				}
				clearDcpNudgeAnchors(state)
				await persistJournalState(ctx, state)
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
				if (clearedAnchors > 0) await persistJournalState(ctx, state)
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

			// Completed actionable routine opportunities also have a bound. Never
			// silently enable automatic summarization when the user disabled it.
			if (routineEscalated && !effectiveConfig.compress.autoCompress.enabled) {
				warnProgress(ctx, "auto-disabled", "DCP compression has not made enough progress. Automatic compression is disabled; use compress or enable compress.autoCompress explicitly.")
			}
			let autoCompressionFailure: { blockedReason?: DcpBlockedReason; error: string } | undefined
			if (!manualEmergencyOnly) {
				const autoCandidate = candidate ?? emergencyCompressionCandidate
				const cacheSafeReminderAvailable = hasCacheSafeNudgeCarrier(prunedMessages)
				const autoDecision = decideAutoCompress(
					state,
					effectiveConfig,
					contextPercent,
					thresholds.maxContextPercent,
					autoCandidate,
					{
						routinePressure: routineEscalated,
						hardPressure: hardEmergencyReached,
						reminderUnavailable: !cacheSafeReminderAvailable,
					},
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
						const largestSafeCandidate = candidate
							? detectCompressionCandidate(prunedMessages, state, effectiveConfig, contextPercent)
							: detectEmergencyCompressionCandidate(prunedMessages, state, effectiveConfig, contextPercent, planningThreshold)
						let preparedProjection: any[] | undefined
						const autoConfig = autoSummarizerDegraded
							? withoutAutoSummaryModels(effectiveConfig)
							: effectiveConfig
						const autoResult = await createBudgetedAutoCompressionBlock({
							candidate: autoCandidate,
							topic: "Auto-compressed slice",
							state,
							config: autoConfig,
							messages: prunedMessages,
							modelRegistry: (ctx as any).modelRegistry,
							signal: (ctx as any).signal,
							cwd: (ctx as any).cwd,
							requiredGainTokens: state.compressionProgress?.remainingTokens ?? planningRecoveryTokens,
							allowPartialGain: true,
							persistState: (preparedState, publication) => persistJournalState(ctx, preparedState, publication),
							prepareProjection: (preparedState) => {
								clearDcpNudgeAnchors(preparedState)
								preparedState.progressRecovery = undefined
								preparedProjection = applyPruning(contextMessages, preparedState, effectiveConfig)
								return preparedProjection
							},
						}, largestSafeCandidate)
						if (autoResult.ownerChangedAfterPublication || state.sessionEpoch !== autoOperationEpoch) {
							// The captured owner was durably committed; do not label it
							// failed or mutate/nudge the replacement session.
							return { messages: contextMessages }
						}
						// Re-apply pruning so the new block takes effect on this
						// same context pass instead of the next one.
						prunedMessages = preparedProjection ?? applyPruning(contextMessages, state, effectiveConfig)
						const clearedAnchors = clearDcpNudgeAnchors(state)
						warnedProgress.clear()
						state.progressRecovery = undefined
						writeDcpDebugLog(effectiveConfig, "compress.auto", {
							trigger: autoDecision.reason,
							blockId: `b${autoResult.blockId}`,
							summaryMode: autoResult.summaryMode,
							summarizerModelRef: autoResult.summarizerModelRef,
							summarizerAttempts: autoResult.summarizerAttempts,
							summaryTokens: autoResult.summaryTokens,
							removedTokenEstimate: autoResult.removedTokenEstimate,
							fullProjectionGain: autoResult.fullProjectionGain,
							pressureRelieved: autoResult.pressureRelieved,
							candidate: autoResult.effectiveCandidate,
							clearedAnchors,
							state: summarizeDcpState(state, effectiveConfig),
						}, ctx)
						return finishContext("compress.auto", prunedMessages, {
							candidate: autoResult.effectiveCandidate,
							messageCandidates,
							contextPercent,
							thresholds,
							clearedAnchors,
						})
					} catch (error) {
						if (state.sessionEpoch !== contextEpoch || ctx.signal?.aborted) return { messages: contextMessages }
						const autoBlockedReason = error instanceof AutoCompressionBlockedError
							? error.blockedReason
							: undefined
						const autoError = error instanceof Error ? error.message : String(error)
						autoCompressionFailure = { blockedReason: autoBlockedReason, error: autoError }
						const modelSummaryConfigured =
							effectiveConfig.compress.autoCompress.summarizerModel.length > 0 ||
							effectiveConfig.compress.autoCompress.summarizerFallbackModels.length > 0
						if (modelSummaryConfigured && !autoSummarizerDegraded) {
							autoSummarizerDegraded = true
							writeDcpDebugLog(effectiveConfig, "compress.auto_summarizer_degraded", {
								reason: autoBlockedReason ?? "auto-failed",
								nextMode: "deterministic-extractive",
							}, ctx)
						}
						writeDcpDebugLog(effectiveConfig, "compress.auto_failed", {
							trigger: autoDecision.reason,
							phase: autoBlockedReason ? "blocked" : "degraded",
							blocked_reason: autoBlockedReason,
							error: autoError,
							candidate: autoCandidate,
							state: summarizeDcpState(state, effectiveConfig),
						}, ctx)
						warnProgress(ctx, autoBlockedReason ?? "auto-failed",
							`DCP automatic compression failed (${autoBlockedReason ?? "preparation failed"}). ${modelSummaryConfigured ? "Future attempts in this session will skip the summary model and use deterministic extraction. " : ""}The current context is preserved; emergency pruning will be attempted before any capacity abort.`)
						if (budget.capacityExceeded && emergencySettings.enabled) {
							emergencySelection = analyzeEmergencyCurrentTurn(prunedMessages, state, effectiveConfig)
							messageCandidates = emergencyCurrentTurnMessageCandidates(emergencySelection, effectiveConfig)
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
				(candidate === null || autoCompressionFailure !== undefined) &&
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
					await persistJournalState(ctx, state)
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

			if (budget.capacityExceeded && autoCompressionFailure) {
				const recoveredTokens = emergencyPruneResult?.estimatedTokensRecovered ?? 0
				const projectedAfterRecovery = Math.max(0, budget.projectedBeforeTokens - recoveredTokens)
				if (projectedAfterRecovery > budget.inputCapacityTokens) {
					const finalBlockedReason = autoCompressionFailure.blockedReason ?? "auto-compress-failed"
					const capacityGap = projectedAfterRecovery - budget.inputCapacityTokens
					state.progressRecovery = {
						blockedReason: finalBlockedReason,
						projectedBeforeTokens: projectedAfterRecovery,
						inputCapacityTokens: budget.inputCapacityTokens,
						requiredSavingsTokens: capacityGap,
						contextWindow: budget.contextWindow,
						createdAt: Date.now(),
					}
					clearDcpNudgeAnchors(state)
					await persistJournalState(ctx, state)
					warnProgress(
						ctx,
						finalBlockedReason,
						`DCP recovery could not make the next request fit safely after auto-compression failed (${autoCompressionFailure.error}). ${projectedAfterRecovery} projected input tokens still exceed ${budget.inputCapacityTokens} input capacity by ${capacityGap}; the current agent operation is being stopped.`,
					)
					const abortSupported = typeof (ctx as any).abort === "function"
					if (abortSupported) (ctx as any).abort()
					writeDcpDebugLog(effectiveConfig, "context.progress_handoff", {
						phase: "blocked",
						blocked_reason: finalBlockedReason,
						autoCompressionFailure,
						recoveredTokens,
						projectedAfterRecovery,
						handoff: abortSupported ? "abort-current-agent-operation" : "abort-unavailable",
						budget,
						state: summarizeDcpState(state, effectiveConfig),
					}, ctx)
					return finishContext("progress.blocked_handoff", prunedMessages, {
						blocked_reason: finalBlockedReason,
						autoCompressionFailure,
						recoveredTokens,
						projectedAfterRecovery,
						handoff: abortSupported ? "abort-current-agent-operation" : "abort-unavailable",
						budget,
					})
				}
			}

			if (nudgeType && !manualEmergencyOnly && (hasCompressionSuggestion || emergencyPressureReached)) {
				latestProviderOpportunityAvailable = latestProviderOpportunityKind !== undefined
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
						await persistJournalState(ctx, state)
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
					// Do not rewrite an already-sent user message and do not create an
					// ephemeral synthetic tail that disappears from the next provider
					// continuation. The reminder is deferred until a fresh user tail; hard
					// pressure is handled by the bounded emergency path above.
					writeDcpDebugLog(effectiveConfig, "nudge.deferred_for_cache", {
						type: nudgeType,
						contextPercent,
						toolCallsSinceLastUser,
					}, ctx)
				}
				state.nudgeCounter = 0
				state.lastNudgeTurn = state.currentTurn
			} else {
				state.nudgeCounter++
			}

			// Persist patience/window changes even when an existing anchor was only
			// re-applied (that path intentionally emits telemetry without updating it).
			await persistJournalState(ctx, state)
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
		if (nudgeApplication.rendered && latestProviderOpportunityKind) {
			latestProviderOpportunityAvailable = true
			latestProviderReminder = state.nudgeAnchors[0]?.renderedReminder
		}
		if (state.nudgeAnchors.length !== anchorsBeforeFinalization || nudgeApplication.stateChanged) {
			await persistJournalState(ctx, state)
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
		const reminderDelivered = latestProviderOpportunityAvailable &&
			providerPayloadIncludesReminder(event.payload, latestProviderReminder)
		const pending = providerEvidenceTracker.begin({
			sessionEpoch: state.sessionEpoch,
			provider: typeof model?.provider === "string" ? model.provider : undefined,
			model: typeof model?.id === "string" ? model.id : undefined,
			contentRevision: providerPayloadRevision(event.payload),
			toolIds: pendingToolIds,
			opportunityAvailable: reminderDelivered,
			opportunityKind: reminderDelivered ? latestProviderOpportunityKind : undefined,
		})

		writeDcpDebugLog(effectiveConfig, "provider_payload.message_ids", {
			injected: false,
			delivery: "distributed-carriers",
			pendingToolResults: pendingToolIds.size,
			attempts: pending.attempts,
			ambiguous: pending.ambiguous,
			opportunityAvailable: pending.opportunityAvailable,
			opportunityKind: pending.opportunityKind,
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

		// Charge the completed opportunity before tool execution. A failed or
		// insufficient compress call cannot erase it; only a sufficient durable
		// commit settles the savings goal and resets patience.
		const ignoredCompressionOpportunity =
			completion.opportunityAvailable && message.stopReason !== "deferred"

		const commit = providerEvidenceCommitQueue
			.catch(() => {
				// Keep later evidence commits moving after a prior transaction failure.
			})
			.then(() => runDcpStateTransaction(state, async () => {
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
				const assertCurrent = captureDcpTransactionGuard(state, effectiveConfig, undefined, ctx)
				const workingState = cloneDcpTransactionState(state)
				for (const toolCallId of newlySeen) workingState.providerSeenToolIds.add(toolCallId)
				if (ignoredCompressionOpportunity) {
					workingState.consecutiveIgnoredNudges = state.consecutiveIgnoredNudges + 1
					if (completion.opportunityKind !== "routine") {
						workingState.consecutiveIgnoredStrongNudges = state.consecutiveIgnoredStrongNudges + 1
					}
				}

				// Provider-delivery evidence is intentionally runtime-only. After a
				// restart absence means unknown, never "seen". Persisting it would add
				// high-frequency journal churn without changing the durable projection.
				assertCurrent()

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
				state.consecutiveIgnoredNudges = workingState.consecutiveIgnoredNudges
				writeDcpDebugLog(effectiveConfig, "provider_payload.tool_results_seen", {
					attempts: completion.attempts,
					newlySeenToolResults: newlySeen.length,
					ignoredCompressionOpportunity,
					ignoredOpportunities: state.consecutiveIgnoredStrongNudges,
					allIgnoredOpportunities: state.consecutiveIgnoredNudges,
					state: summarizeDcpState(state, effectiveConfig),
				}, ctx)
			}))
		providerEvidenceCommitQueue = commit
		await commit
	})
}
