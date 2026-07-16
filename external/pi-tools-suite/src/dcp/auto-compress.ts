// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — auto-compress fallback
//
// When a model ignores repeated context-strong nudges above the emergency
// threshold (observed with gpt-5.5 in session 019edfe3: 59 strong nudges,
// 0 compress calls), DCP creates a compression block itself instead of
// waiting for the model. This is the model-independent safety net.
//
// Lossy and irreversible within a session; disabled by default and gated by a
// patience counter + the emergency threshold. The summary can be produced
// either by a deterministic programmatic digest (default) or by a configured
// list of summarizer models (e.g. a cheap model like zai/glm-5.2), with
// automatic fallback to the programmatic digest on any failure/timeout.
// ---------------------------------------------------------------------------

import type { Model, Api } from "@earendil-works/pi-ai"
import { completeWithModelRegistry, type ModelCompletionRegistry } from "../model-completion.js"
import type { DcpState } from "./state.js"
import type { DcpConfig } from "./config.js"
import type { CompressionCandidate } from "./pruner-types.js"
import {
	createRangeCompressionBlock,
	resolveAnchorBoundary,
} from "./compression-blocks.js"

/**
 * Pure decision: should the auto-compress fallback fire this pass?
 *
 * Fires when ALL hold:
 *  - the master switch `autoCompress.enabled` is on,
 *  - the model has ignored at least `patience` consecutive context-strong
 *    nudges (`consecutiveIgnoredStrongNudges > patience` — the model gets
 *    `patience` genuine strong chances before DCP takes over),
 *  - context is still above the emergency threshold (maxContextPercent),
 *  - a safe compression candidate exists outside the recent turns.
 */
export function decideAutoCompress(
	state: DcpState,
	config: DcpConfig,
	contextPercent: number,
	maxContextPercent: number,
	candidate: CompressionCandidate | null,
): { shouldFire: boolean; reason: string } {
	const settings = config.compress.autoCompress
	if (!settings?.enabled) return { shouldFire: false, reason: "disabled" }
	if (state.consecutiveIgnoredStrongNudges <= settings.patience) {
		return { shouldFire: false, reason: "below-patience" }
	}
	if (!(contextPercent > maxContextPercent)) {
		return { shouldFire: false, reason: "below-emergency-threshold" }
	}
	if (!candidate) return { shouldFire: false, reason: "no-candidate" }
	return { shouldFire: true, reason: "ignored-strongs" }
}

/** Flatten a single message's content blocks into plain text. */
function messageToText(message: any): string {
	const content = message?.content
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((block: any) => {
			if (typeof block === "string") return block
			if (block?.type === "text") return block.text ?? ""
			if (block?.type === "toolCall") {
				const name = block.name ?? block.function?.name ?? "tool"
				return `[tool call: ${name}]`
			}
			if (block?.type === "toolResult" || block?.role === "toolResult") {
				return block.text ?? ""
			}
			return ""
		})
		.join("\n")
		.trim()
}

/** Extract a short tool-usage digest from messages in the range. */
function toolUsageDigest(messages: any[]): string {
	const counts = new Map<string, number>()
	for (const msg of messages) {
		const content = msg?.content
		if (!Array.isArray(content)) continue
		for (const block of content) {
			if (block?.type === "toolCall" && typeof block.name === "string") {
				counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
			}
		}
	}
	if (counts.size === 0) return ""
	const entries = [...counts.entries()].sort((a, b) => b[1] - a[1])
	return entries.map(([name, n]) => `${name}×${n}`).join(", ")
}

/**
 * Deterministic, model-free summary of the compressed range. Deliberately
 * short: `createRangeCompressionBlock` appends protected user messages and
 * protected tool outputs on top of this, so the digest itself only needs to
 * label the slice and record the tool-call shape.
 */
export function buildProgrammaticSummary(
	topic: string,
	candidate: CompressionCandidate,
	messagesInRange: any[],
): string {
	const toolDigest = toolUsageDigest(messagesInRange)
	const lines = [
		`[Auto-compressed by DCP — model did not compress after repeated context-strong nudges]`,
		`Topic: ${topic}`,
		`Range: ${candidate.startId}..${candidate.endId} (${candidate.messageCount} messages, ~${candidate.estimatedTokens} tokens)`,
	]
	if (toolDigest) lines.push(`Tool calls in range: ${toolDigest}`)
	lines.push(
		`This slice was summarized automatically to protect the context window. Protected user messages and tool outputs are preserved below by the compression block.`,
	)
	return lines.join("\n")
}

const SUMMARIZER_SYSTEM_PROMPT = `You summarize a slice of a coding agent's conversation so it can replace the raw messages in context. Produce a dense, continuation-focused summary: preserve user intent, decisions made, files/symbols changed or inspected, exact errors still actionable, verification status, and next steps. Do not infer, invent, or add facts absent from the source; preserve uncertainty instead of filling gaps. Drop full logs, repeated output, and incidental detail. Be concise (roughly 4-10 bullets). Output ONLY the summary text, no preamble.`

/** Outcome of one summarizer-model attempt, surfaced in DCP debug logs. */
export interface ModelSummaryAttempt {
	ref: string
	outcome: "ok" | "no-model" | "no-auth" | "empty" | "error"
	error?: string
}

/** Result of {@link generateModelSummary}: optional text plus per-model attempts. */
export interface ModelSummaryResult {
	text?: string
	/** Model ref that produced {@link text}, if any. */
	usedModelRef?: string
	/** One entry per model ref tried, in order, for debug visibility. */
	attempts: ModelSummaryAttempt[]
}

type ModelSummaryRegistry = ModelCompletionRegistry & {
	find(provider: string, modelId: string): Model<Api> | undefined
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>
}

/**
 * Try to produce a model-generated summary by calling each model in
 * `modelRefs` in order. On success returns `{ text, usedModelRef, attempts }`;
 * if every model fails, returns `{ attempts }` with `text` undefined so the
 * caller falls back to the programmatic digest while still recording which
 * models were tried and why.
 *
 * Never throws: a summarizer failure must never block the agent — the
 * programmatic digest is always available as a floor.
 */
export async function generateModelSummary(
	modelRefs: string[],
	modelRegistry: ModelSummaryRegistry | undefined,
	signal: AbortSignal | undefined,
	topic: string,
	messagesInRange: any[],
	timeoutMs: number,
): Promise<ModelSummaryResult> {
	const attempts: ModelSummaryAttempt[] = []
	if (!modelRefs || modelRefs.length === 0) return { attempts }
	if (!modelRegistry || typeof modelRegistry.find !== "function" || typeof modelRegistry.getApiKeyAndHeaders !== "function") {
		return { attempts }
	}

	// Build a compact transcript from the range. Cap token budget so the
	// summarizer call stays cheap and bounded.
	const transcript = messagesInRange
		.map((msg, i) => {
			const role = msg?.role ?? "message"
			return `### ${role} #${i + 1}\n${messageToText(msg)}`
		})
		.join("\n\n")
	const userPrompt = `Summarize this conversation slice (topic: ${topic}).\n\nTranscript:\n${transcript}`

	let lastError: unknown
	for (const ref of modelRefs) {
		const parsed = parseModelRef(ref)
		if (!parsed) continue
		const model: Model<Api> | undefined = modelRegistry.find(parsed.provider, parsed.id)
		if (!model) {
			attempts.push({ ref, outcome: "no-model" })
			continue
		}

		let auth: Awaited<ReturnType<ModelSummaryRegistry["getApiKeyAndHeaders"]>>
		try {
			auth = await modelRegistry.getApiKeyAndHeaders(model)
		} catch (error) {
			lastError = error
			attempts.push({ ref, outcome: "no-auth", error: error instanceof Error ? error.message : String(error) })
			continue
		}
		if (auth.ok === false) {
			attempts.push({ ref, outcome: "no-auth" })
			continue
		}

		// Combine the agent signal with a local timeout so a slow summarizer
		// cannot stall the context event indefinitely.
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
		const onParentAbort = () => controller.abort()
		if (signal) {
			if (signal.aborted) controller.abort()
			else signal.addEventListener("abort", onParentAbort, { once: true })
		}

		try {
			const result = await completeWithModelRegistry(
				modelRegistry,
				model,
				{ systemPrompt: SUMMARIZER_SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal: controller.signal,
					maxRetries: 0,
				} as any,
			)
			const text = extractAssistantText(result)
			if (text) {
				attempts.push({ ref, outcome: "ok" })
				return { text, usedModelRef: ref, attempts }
			}
			attempts.push({ ref, outcome: "empty" })
		} catch (error) {
			lastError = error
			attempts.push({ ref, outcome: "error", error: error instanceof Error ? error.message : String(error) })
			// try next model in the fallback list
		} finally {
			clearTimeout(timer)
			if (signal) signal.removeEventListener("abort", onParentAbort)
		}
	}

	if (lastError) {
		// Swallowed on purpose: callers use the programmatic digest floor.
	}
	return { attempts }
}

function extractAssistantText(result: any): string | undefined {
	const content = result?.content
	if (!Array.isArray(content)) return undefined
	const text = content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n")
		.trim()
	return text.length > 0 ? text : undefined
}

function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const trimmed = ref.trim()
	const slash = trimmed.lastIndexOf("/")
	if (slash <= 0 || slash === trimmed.length - 1) return undefined
	return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) }
}

export interface CreateAutoCompressionBlockOptions {
	candidate: CompressionCandidate
	topic: string
	state: DcpState
	config: DcpConfig
	messages: any[]
	modelRegistry?: any
	signal?: AbortSignal
}

export interface AutoCompressionResult {
	blockId: number
	summaryMode: "programmatic" | "model" | "programmatic_fallback"
	summaryTokens: number
	removedTokenEstimate: number
	/** Model ref that produced the summary; set only when `summaryMode === "model"`. */
	summarizerModelRef?: string
	/** Per-model attempts, surfaced for DCP debug visibility on fallback. */
	summarizerAttempts?: ModelSummaryAttempt[]
}

/**
 * Create the auto-compression block. Selects the summary source based on
 * `config.compress.autoCompress.summarizerModel`: empty → programmatic digest;
 * non-empty → model summary with programmatic fallback. Then delegates block
 * creation to the shared `createRangeCompressionBlock` path so protected
 * content (user messages, tool outputs, prompt info) is handled identically to
 * a model-initiated compress.
 */
export async function createAutoCompressionBlock(
	options: CreateAutoCompressionBlockOptions,
): Promise<AutoCompressionResult> {
	const { candidate, topic, state, config, messages, modelRegistry, signal } = options
	const settings = config.compress.autoCompress

	// Resolve candidate message IDs (mNNN) to timestamps via the snapshot.
	const startMeta = state.messageMetaSnapshot.get(candidate.startId)
	const endMeta = state.messageMetaSnapshot.get(candidate.endId)
	const rawStart = startMeta?.timestamp ?? state.messageIdSnapshot.get(candidate.startId)
	const rawEnd = endMeta?.timestamp ?? state.messageIdSnapshot.get(candidate.endId)

	if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
		throw new Error(
			`Auto-compress candidate ${candidate.startId}..${candidate.endId} did not resolve to finite timestamps`,
		)
	}
	const startTimestamp: number = rawStart as number
	const endTimestamp: number = rawEnd as number

	const messagesInRange = messages.filter(
		(msg) =>
			Number.isFinite(msg?.timestamp) && msg.timestamp >= startTimestamp && msg.timestamp <= endTimestamp,
	)

	// Summary source selection. `summaryMode` distinguishes three cases so the
	// DCP debug log can tell a real model summary from a programmatic fallback
	// caused by summarizer failure:
	//   - "model": a configured model produced the summary.
	//   - "programmatic": no summarizer models configured (floor by design).
	//   - "programmatic_fallback": models were configured but all failed/empty.
	let summary = buildProgrammaticSummary(topic, candidate, messagesInRange)
	let summaryMode: "programmatic" | "model" | "programmatic_fallback" = "programmatic"
	let summarizerModelRef: string | undefined
	let summarizerAttempts: ModelSummaryAttempt[] | undefined

	const modelRefs = settings.summarizerModel
	if (modelRefs.length > 0) {
		const modelResult = await generateModelSummary(
			modelRefs,
			modelRegistry,
			signal,
			topic,
			messagesInRange,
			settings.timeoutMs,
		)
		summarizerAttempts = modelResult.attempts.length > 0 ? modelResult.attempts : undefined
		if (modelResult.text) {
			summary = modelResult.text
			summaryMode = "model"
			summarizerModelRef = modelResult.usedModelRef
		} else {
			// All configured models failed or returned empty — fall back to the
			// programmatic digest, but mark the mode distinctly so the fallback
			// is visible in DCP debug logs.
			summaryMode = "programmatic_fallback"
		}
	}

	const anchor = resolveAnchorBoundary(endTimestamp, state)
	const created = createRangeCompressionBlock({
		topic,
		summary,
		startTimestamp,
		endTimestamp,
		startMessageId: startMeta?.stableId,
		endMessageId: endMeta?.stableId,
		anchorTimestamp: anchor.timestamp,
		anchorMessageId: anchor.stableId,
		createdByToolCallId: undefined,
		state,
		config,
		mode: "range",
	})

	return {
		blockId: created.block.id,
		summaryMode,
		summaryTokens: created.summaryTokenEstimate,
		removedTokenEstimate: created.removedTokenEstimate,
		summarizerModelRef,
		summarizerAttempts,
	}
}
