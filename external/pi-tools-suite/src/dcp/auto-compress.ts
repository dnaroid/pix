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
// list of summarizer models (e.g. a cheap model like zai/glm-5.3), with
// automatic fallback to the programmatic digest on any failure/timeout.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto"
import type { Model, Api, ProviderHeaders } from "@earendil-works/pi-ai"
import { completeWithModelRegistry, type ModelCompletionRegistry } from "../model-completion.js"
import type { DcpState } from "./state.js"
import type { DcpConfig } from "./config.js"
import type { CompressionCandidate } from "./pruner-types.js"
import { estimateMessageTokens, estimateTokens } from "./pruner-metadata.js"
import {
	createRangeCompressionBlock,
	findCoveredAndPartialBlocks,
	prepareCompressionProtectedFragments,
	isCompressionBoundaryWithinRange,
	resolveAnchorBoundary,
	resolveIdToBoundary,
} from "./compression-blocks.js"
import { estimateCompressionBlockReplacementTokens } from "./pruner-compression-blocks.js"
import { stableMessageKeys } from "./pruner-message-ids.js"
import { closeConversationRange } from "./conversation-index.js"
import { decideDcpProgress, type DcpBlockedReason } from "./progress-controller.js"

export class AutoCompressionBlockedError extends Error {
	readonly blockedReason: DcpBlockedReason

	constructor(blockedReason: DcpBlockedReason, message: string) {
		super(message)
		this.name = "AutoCompressionBlockedError"
		this.blockedReason = blockedReason
	}
}

/**
 * Pure decision: should the auto-compress fallback fire this pass?
 *
 * Fires when ALL hold:
 *  - the master switch `autoCompress.enabled` is on and runtime manual mode is off,
 *  - the main provider has completed more than `patience` correlated requests
 *    that actually contained an emergency DCP reminder without committing a
 *    compression (`consecutiveIgnoredStrongNudges > patience`),
 *  - context is still above the emergency threshold (maxContextPercent),
 *  - a safe compression candidate exists, either outside the recent user
 *    turns or as an emergency committed prefix inside a marathon turn.
 */
export function decideAutoCompress(
	state: DcpState,
	config: DcpConfig,
	contextPercent: number,
	maxContextPercent: number,
	candidate: CompressionCandidate | null,
): { shouldFire: boolean; reason: string } {
	const settings = config.compress.autoCompress
	const decision = decideDcpProgress({
		enabled: config.enabled,
		autoEnabled: Boolean(settings?.enabled) && !state.manualMode,
		pressure: contextPercent > maxContextPercent,
		candidateAvailable: candidate !== null,
		ignoredOpportunities: state.consecutiveIgnoredStrongNudges,
		patience: settings?.patience ?? 0,
	})
	return { shouldFire: decision.shouldPrepare, reason: decision.reason }
}

const SUMMARY_SOURCE_TEXT_MAX_CHARS = 4_000
const SUMMARY_SOURCE_ARG_STRING_MAX_CHARS = 1_000
const SUMMARY_SOURCE_MAX_ARRAY_ITEMS = 20
const SUMMARY_SOURCE_MAX_OBJECT_KEYS = 40
const SUMMARY_EXTRACT_SECTION_ITEMS = 6
const SUMMARY_EXTRACT_TOOL_ITEMS = 12
const SUMMARY_MODEL_MAX_INPUT_TOKENS = 24_000
const SUMMARY_MODEL_MAX_OUTPUT_TOKENS = 4_096
const SUMMARY_MODEL_CHUNK_OUTPUT_TOKENS = 2_048
const SUMMARY_MODEL_MAX_CHUNKS = 8
const SUMMARY_MODEL_MAX_REFS = 4
const SUMMARY_MODEL_PROMPT_OVERHEAD_TOKENS = 512
const SENSITIVE_SUMMARY_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|headers?)/i

export interface SummarySourceToolCall {
	id?: string
	name: string
	arguments?: unknown
}

export interface SummarySourceItem {
	sourceId: string
	role: string
	timestamp?: number
	text?: string
	textTruncated?: boolean
	toolCalls?: SummarySourceToolCall[]
	toolCallId?: string
	toolName?: string
	outcome?: "success" | "error" | "unknown"
	exitCode?: number
}

export interface SummarySourceCoverage {
	itemCount: number
	truncatedItems: number
	toolCallCount: number
	toolResultCount: number
}

function boundedSourceText(text: string, maxChars = SUMMARY_SOURCE_TEXT_MAX_CHARS): { text: string; truncated: boolean } {
	const trimmed = text.trim()
	if (trimmed.length <= maxChars) return { text: trimmed, truncated: false }
	const markerBudget = 64
	const keep = Math.max(1, maxChars - markerBudget)
	const head = Math.ceil(keep / 2)
	const tail = Math.floor(keep / 2)
	const omitted = trimmed.length - head - tail
	return {
		text: `${trimmed.slice(0, head)}\n[... ${omitted} source chars omitted ...]\n${trimmed.slice(trimmed.length - tail)}`,
		truncated: true,
	}
}

function sanitizeSummaryValue(value: unknown, depth = 0): unknown {
	if (depth >= 5) return "[depth-limited]"
	if (value === null || typeof value === "number" || typeof value === "boolean") return value
	if (typeof value === "string") return boundedSourceText(value, SUMMARY_SOURCE_ARG_STRING_MAX_CHARS).text
	if (Array.isArray(value)) {
		const selected = value.slice(0, SUMMARY_SOURCE_MAX_ARRAY_ITEMS).map((item) => sanitizeSummaryValue(item, depth + 1))
		if (value.length > selected.length) selected.push(`[... ${value.length - selected.length} items omitted ...]`)
		return selected
	}
	if (typeof value === "object") {
		const output: Record<string, unknown> = {}
		const entries = Object.entries(value as Record<string, unknown>)
		for (const [key, nested] of entries.slice(0, SUMMARY_SOURCE_MAX_OBJECT_KEYS)) {
			output[key] = SENSITIVE_SUMMARY_KEY.test(key) ? "[redacted]" : sanitizeSummaryValue(nested, depth + 1)
		}
		if (entries.length > SUMMARY_SOURCE_MAX_OBJECT_KEYS) {
			output.__omittedKeys = entries.length - SUMMARY_SOURCE_MAX_OBJECT_KEYS
		}
		return output
	}
	return String(value)
}

function parseToolArguments(value: unknown): unknown {
	if (typeof value !== "string") return sanitizeSummaryValue(value)
	const trimmed = value.trim()
	if (!trimmed) return undefined
	try {
		return sanitizeSummaryValue(JSON.parse(trimmed))
	} catch {
		return sanitizeSummaryValue(trimmed)
	}
}

function messageVisibleText(message: any): string {
	const content = message?.content
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((block: any) => {
			if (typeof block === "string") return block
			if (block?.type === "text") return block.text ?? ""
			if (block?.type === "toolResult") return block.text ?? block.output ?? ""
			return ""
		})
		.filter(Boolean)
		.join("\n")
		.trim()
}

function sourceToolCalls(message: any): SummarySourceToolCall[] {
	if (!Array.isArray(message?.content)) return []
	const calls: SummarySourceToolCall[] = []
	for (const block of message.content) {
		if (block?.type !== "toolCall") continue
		const name = block.name ?? block.function?.name
		if (typeof name !== "string" || name.length === 0) continue
		const id = typeof block.id === "string"
			? block.id
			: typeof block.toolCallId === "string"
				? block.toolCallId
				: undefined
		const args = block.input ?? block.arguments ?? block.function?.arguments
		calls.push({ id, name, arguments: parseToolArguments(args) })
	}
	return calls
}

function sourceExitCode(message: any): number | undefined {
	const candidates = [message?.exitCode, message?.details?.exitCode, message?.details?.result?.exitCode]
	return candidates.find((value) => typeof value === "number" && Number.isFinite(value))
}

/** Build the single bounded source-of-truth representation used by all E06 summary paths. */
export function buildSummarySourceManifest(messages: any[]): SummarySourceItem[] {
	return messages.map((message, index) => {
		const visible = boundedSourceText(messageVisibleText(message))
		const toolCalls = sourceToolCalls(message)
		const exitCode = sourceExitCode(message)
		const isToolResult = message?.role === "toolResult" || message?.role === "bashExecution"
		const explicitError = message?.isError === true || (typeof exitCode === "number" && exitCode !== 0)
		const explicitSuccess = message?.isError === false || (typeof exitCode === "number" && exitCode === 0)
		return {
			sourceId: `src-${String(index + 1).padStart(4, "0")}`,
			role: typeof message?.role === "string" ? message.role : "message",
			timestamp: Number.isFinite(message?.timestamp) ? message.timestamp : undefined,
			text: visible.text || undefined,
			textTruncated: visible.truncated || undefined,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			toolCallId: typeof message?.toolCallId === "string" ? message.toolCallId : undefined,
			toolName: typeof message?.toolName === "string" ? message.toolName : undefined,
			outcome: isToolResult ? (explicitError ? "error" : explicitSuccess ? "success" : "unknown") : undefined,
			exitCode,
		}
	})
}

export function summarySourceCoverage(manifest: SummarySourceItem[]): SummarySourceCoverage {
	return {
		itemCount: manifest.length,
		truncatedItems: manifest.filter((item) => item.textTruncated).length,
		toolCallCount: manifest.reduce((sum, item) => sum + (item.toolCalls?.length ?? 0), 0),
		toolResultCount: manifest.filter((item) => item.toolCallId || item.role === "toolResult" || item.role === "bashExecution").length,
	}
}

export function hashSummarySourceManifest(manifest: SummarySourceItem[]): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

function renderSummarySourceTranscript(manifest: SummarySourceItem[]): string {
	return manifest.map((item) => {
		const header = [`### ${item.sourceId}`, `role=${item.role}`]
		if (item.timestamp !== undefined) header.push(`timestamp=${item.timestamp}`)
		const lines = [header.join(" ")]
		if (item.text) lines.push(`text:\n${item.text}`)
		for (const call of item.toolCalls ?? []) {
			const args = call.arguments === undefined ? "" : ` args=${JSON.stringify(call.arguments)}`
			lines.push(`tool_call: call_id=${call.id ?? "unknown"} name=${call.name}${args}`)
		}
		if (item.toolCallId || item.role === "toolResult" || item.role === "bashExecution") {
			lines.push(
				`tool_result: call_id=${item.toolCallId ?? "unknown"} tool=${item.toolName ?? "unknown"} ` +
				`outcome=${item.outcome ?? "unknown"}${item.exitCode === undefined ? "" : ` exit_code=${item.exitCode}`}`,
			)
		}
		if (item.textTruncated) lines.push("source_note: text was bounded with an explicit omission marker")
		return lines.join("\n")
	}).join("\n\n")
}

export interface SummaryManifestChunkPlan {
	chunks: SummarySourceItem[][]
	inputBudgetTokens: number
	oversizedGroup?: { sourceIds: string[]; estimatedTokens: number }
	incompleteToolGroup?: { sourceIds: string[]; pendingToolCallIds: string[] }
}

function summaryModelOutputTokens(model: Model<Api>, chunk = false): number {
	const configured = typeof (model as any)?.maxTokens === "number" && Number.isFinite((model as any).maxTokens) && (model as any).maxTokens > 0
		? Math.floor((model as any).maxTokens)
		: SUMMARY_MODEL_MAX_OUTPUT_TOKENS
	return Math.max(1, Math.min(configured, chunk ? SUMMARY_MODEL_CHUNK_OUTPUT_TOKENS : SUMMARY_MODEL_MAX_OUTPUT_TOKENS))
}

function summaryModelInputBudgetTokens(model: Model<Api>): number {
	const contextWindow = typeof (model as any)?.contextWindow === "number" && Number.isFinite((model as any).contextWindow) && (model as any).contextWindow > 0
		? Math.floor((model as any).contextWindow)
		: 128_000
	const outputReserve = summaryModelOutputTokens(model, false)
	const promptReserve = estimateTokens(SUMMARIZER_SYSTEM_PROMPT) + SUMMARY_MODEL_PROMPT_OVERHEAD_TOKENS
	return Math.max(256, Math.min(SUMMARY_MODEL_MAX_INPUT_TOKENS, contextWindow - outputReserve - promptReserve))
}

function summaryManifestAtomicGroups(manifest: SummarySourceItem[]): {
	groups: SummarySourceItem[][]
	incompleteToolGroup?: { sourceIds: string[]; pendingToolCallIds: string[] }
} {
	const groups: SummarySourceItem[][] = []
	for (let index = 0; index < manifest.length;) {
		const first = manifest[index]!
		const group = [first]
		const pending = new Set((first.toolCalls ?? []).map((call) => call.id).filter((id): id is string => Boolean(id)))
		if (pending.size === 0) {
			groups.push(group)
			index++
			continue
		}

		let cursor = index + 1
		for (; cursor < manifest.length && pending.size > 0; cursor++) {
			const item = manifest[cursor]!
			group.push(item)
			if (item.toolCallId && pending.has(item.toolCallId)) pending.delete(item.toolCallId)
		}
		if (pending.size > 0) {
			return {
				groups,
				incompleteToolGroup: {
					sourceIds: group.map((item) => item.sourceId),
					pendingToolCallIds: [...pending],
				},
			}
		}
		groups.push(group)
		index = cursor
	}
	return { groups }
}

/** Partition the source only between complete protocol groups; never split a tool group. */
export function partitionSummarySourceManifest(
	manifest: SummarySourceItem[],
	inputBudgetTokens: number,
): SummaryManifestChunkPlan {
	const budget = Math.max(1, Math.floor(inputBudgetTokens))
	const atomic = summaryManifestAtomicGroups(manifest)
	if (atomic.incompleteToolGroup) {
		return { chunks: [], inputBudgetTokens: budget, incompleteToolGroup: atomic.incompleteToolGroup }
	}

	const chunks: SummarySourceItem[][] = []
	let current: SummarySourceItem[] = []
	let currentTokens = 0
	for (const group of atomic.groups) {
		const groupTokens = estimateTokens(renderSummarySourceTranscript(group))
		if (groupTokens > budget) {
			return {
				chunks,
				inputBudgetTokens: budget,
				oversizedGroup: { sourceIds: group.map((item) => item.sourceId), estimatedTokens: groupTokens },
			}
		}
		if (current.length > 0 && currentTokens + groupTokens > budget) {
			chunks.push(current)
			current = []
			currentTokens = 0
		}
		current.push(...group)
		currentTokens += groupTokens
	}
	if (current.length > 0) chunks.push(current)
	return { chunks, inputBudgetTokens: budget }
}

function selectEdgeItems<T>(items: T[], maxItems: number): T[] {
	if (items.length <= maxItems) return items
	const head = Math.floor(maxItems / 3)
	const tail = maxItems - head
	return [...items.slice(0, head), ...items.slice(items.length - tail)]
}

function explicitSourceLines(
	manifest: SummarySourceItem[],
	pattern: RegExp,
	maxItems = SUMMARY_EXTRACT_SECTION_ITEMS,
): string[] {
	const matches: string[] = []
	const seen = new Set<string>()
	for (const item of manifest) {
		for (const rawLine of item.text?.split(/\r?\n/) ?? []) {
			const line = rawLine.trim()
			if (!line || !pattern.test(line)) continue
			const bounded = boundedSourceText(line, 600).text
			const rendered = `[${item.sourceId}] ${bounded}`
			if (seen.has(rendered)) continue
			seen.add(rendered)
			matches.push(rendered)
		}
	}
	return selectEdgeItems(matches, maxItems)
}

function toolEvidenceLines(manifest: SummarySourceItem[]): string[] {
	const lines: string[] = []
	for (const item of manifest) {
		for (const call of item.toolCalls ?? []) {
			lines.push(
				`[${item.sourceId}] call ${call.id ?? "unknown"} ${call.name}` +
				(call.arguments === undefined ? "" : ` args=${JSON.stringify(call.arguments)}`),
			)
		}
		if (item.toolCallId || item.role === "toolResult" || item.role === "bashExecution") {
			// Large successful outputs are exactly the material DCP is trying to
			// retire; repeating an arbitrary head/tail excerpt defeats compression
			// and can resurrect incidental log noise. Keep exact excerpts for
			// actionable errors and already-small results only.
			const includeExcerpt = Boolean(item.text) && (item.outcome === "error" || item.text!.length <= 300)
			const excerpt = includeExcerpt ? ` excerpt=${JSON.stringify(boundedSourceText(item.text!, 300).text)}` : ""
			lines.push(
				`[${item.sourceId}] result ${item.toolCallId ?? "unknown"} ${item.toolName ?? "unknown"} ` +
				`outcome=${item.outcome ?? "unknown"}${item.exitCode === undefined ? "" : ` exit_code=${item.exitCode}`}${excerpt}`,
			)
		}
	}
	return selectEdgeItems(lines, SUMMARY_EXTRACT_TOOL_ITEMS)
}

/** Extract a short tool-usage digest from a source manifest. */
function toolUsageDigest(manifest: SummarySourceItem[]): string {
	const counts = new Map<string, number>()
	for (const item of manifest) {
		for (const call of item.toolCalls ?? []) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
	}
	if (counts.size === 0) return ""
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}×${n}`).join(", ")
}

function appendExtractiveSection(lines: string[], heading: string, items: string[]): void {
	if (items.length === 0) return
	lines.push(`${heading}:`)
	for (const item of items) lines.push(`- ${item}`)
}

/**
 * Bounded deterministic continuation record used when no verified model
 * summary is available. Categories are based only on explicit source wording;
 * they are not claimed to be exhaustive semantic understanding.
 */
export function buildExtractiveSummary(
	topic: string,
	candidate: CompressionCandidate,
	manifest: SummarySourceItem[],
): string {
	const coverage = summarySourceCoverage(manifest)
	const lines = [
		`[Auto-compressed by DCP — extractive continuation record]`,
		`Topic: ${topic}`,
		`Range: ${candidate.startId}..${candidate.endId} (${candidate.messageCount} messages, ~${candidate.estimatedTokens} tokens)`,
		`Source coverage: ${coverage.itemCount} items; ${coverage.truncatedItems} item(s) contain explicit bounded-text markers.`,
		`The sections below preserve source excerpts and metadata; category labels reflect explicit wording only and are not exhaustive semantic claims.`,
	]
	const digest = toolUsageDigest(manifest)
	if (digest) lines.push(`Tool calls in range: ${digest}`)

	appendExtractiveSection(
		lines,
		"User constraints / requests (source excerpts)",
		selectEdgeItems(
			manifest.filter((item) => item.role === "user" && item.text).map((item) => `[${item.sourceId}] ${boundedSourceText(item.text!, 1_200).text}`),
			SUMMARY_EXTRACT_SECTION_ITEMS,
		),
	)
	appendExtractiveSection(lines, "Explicit decisions", explicitSourceLines(manifest, /\b(?:decision|decided|chosen|selected|we will|will use)\b/i))
	appendExtractiveSection(lines, "Explicit hypotheses / uncertainty", explicitSourceLines(manifest, /\b(?:hypothesis|suspect|possibly|maybe|likely|unverified|not verified|uncertain)\b/i))
	appendExtractiveSection(lines, "Reported changes", explicitSourceLines(manifest, /\b(?:changed|updated|modified|implemented|patched|created|deleted|renamed|wrote)\b/i))
	appendExtractiveSection(lines, "Verification / errors", explicitSourceLines(manifest, /\b(?:test|tests|verified|verification|passed|failed|failure|error|exit code|status)\b/i))
	appendExtractiveSection(lines, "Pending / next steps", explicitSourceLines(manifest, /\b(?:next step|next:|todo|pending|remaining|still need|must still|follow[- ]?up)\b/i))
	appendExtractiveSection(lines, "Tool evidence", toolEvidenceLines(manifest))
	return lines.join("\n")
}

/** Backward-compatible export name; implementation is now extractive rather than frequency-only. */
export function buildProgrammaticSummary(
	topic: string,
	candidate: CompressionCandidate,
	messagesInRange: any[],
): string {
	return buildExtractiveSummary(topic, candidate, buildSummarySourceManifest(messagesInRange))
}

const SUMMARIZER_SYSTEM_PROMPT = `You summarize a slice of a coding agent's conversation so it can replace the raw messages in context. Produce a dense, continuation-focused summary: preserve user intent, decisions made, files/symbols changed or inspected, exact errors still actionable, verification status, and next steps. Preserve exact identifiers and explicit continuity markers verbatim, including uppercase labels before colons; never paraphrase or omit those labels. Do not infer, invent, or add facts absent from the source; preserve uncertainty instead of filling gaps. Drop full logs, repeated output, and incidental detail without quoting or naming the discarded log lines or their markers. Be concise (roughly 4-10 bullets). Output ONLY the summary text, no preamble.`

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

async function awaitSummaryDeadline<T>(
	promise: Promise<T>,
	deadline: number,
	parentSignal?: AbortSignal,
): Promise<T> {
	const remaining = deadline - Date.now()
	if (remaining <= 0) throw new Error("summarizer operation deadline exceeded")
	return await new Promise<T>((resolve, reject) => {
		let settled = false
		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (parentSignal) parentSignal.removeEventListener("abort", onAbort)
			fn()
		}
		const timer = setTimeout(() => finish(() => reject(new Error("summarizer operation deadline exceeded"))), remaining)
		const onAbort = () => finish(() => reject(new Error("summarizer operation aborted")))
		if (parentSignal) {
			if (parentSignal.aborted) return onAbort()
			parentSignal.addEventListener("abort", onAbort, { once: true })
		}
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		)
	})
}

type ModelSummaryRegistry = ModelCompletionRegistry & {
	find(provider: string, modelId: string): Model<Api> | undefined
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> }
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
function summaryPromptForManifest(topic: string, manifest: SummarySourceItem[], prefix = "Summarize this conversation slice"): string {
	const transcript = renderSummarySourceTranscript(manifest)
	const coverage = summarySourceCoverage(manifest)
	return (
		`${prefix} (topic: ${topic}).\n` +
		`Source manifest coverage: ${coverage.itemCount} items, ${coverage.truncatedItems} bounded-text item(s), ` +
		`${coverage.toolCallCount} tool call(s), ${coverage.toolResultCount} tool result(s).\n\n` +
		`Transcript from the bounded source manifest:\n${transcript}`
	)
}

async function completeSummaryPrompt(
	modelRegistry: ModelSummaryRegistry,
	model: Model<Api>,
	auth: { apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> },
	prompt: string,
	deadline: number,
	parentSignal: AbortSignal | undefined,
	maxTokens: number,
): Promise<string | undefined> {
	const controller = new AbortController()
	const remainingMs = Math.max(0, deadline - Date.now())
	if (remainingMs <= 0) throw new Error("summarizer operation deadline exceeded")
	const timer = setTimeout(() => controller.abort(), remainingMs)
	const onParentAbort = () => controller.abort()
	if (parentSignal) {
		if (parentSignal.aborted) controller.abort()
		else parentSignal.addEventListener("abort", onParentAbort, { once: true })
	}
	try {
		const completion = completeWithModelRegistry(
			modelRegistry,
			model,
			{ systemPrompt: SUMMARIZER_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: controller.signal,
				maxRetries: 0,
				maxTokens,
			} as any,
		)
		const result = await awaitSummaryDeadline(completion, deadline, controller.signal)
		return extractAssistantText(result)
	} finally {
		clearTimeout(timer)
		if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort)
	}
}

function mergeChunkPrompt(topic: string, chunkSummaries: Array<{ sourceIds: string[]; text: string }>): string {
	const body = chunkSummaries.map((chunk, index) =>
		`### Chunk ${index + 1} sources ${chunk.sourceIds[0]}..${chunk.sourceIds[chunk.sourceIds.length - 1]}\n${chunk.text}`,
	).join("\n\n")
	return (
		`Merge these independently produced summaries for one conversation slice (topic: ${topic}). ` +
		`Preserve explicit user constraints, decisions, exact errors, verification status, paths/identifiers, tool outcomes, uncertainty, and pending next steps. ` +
		`Do not invent facts or drop a chunk. Output only the merged continuation summary.\n\n${body}`
	)
}

export async function generateModelSummary(
	modelRefs: string[],
	modelRegistry: ModelSummaryRegistry | undefined,
	signal: AbortSignal | undefined,
	topic: string,
	messagesInRange: any[],
	timeoutMs: number,
	sourceManifest?: SummarySourceItem[],
): Promise<ModelSummaryResult> {
	const attempts: ModelSummaryAttempt[] = []
	if (!modelRefs || modelRefs.length === 0) return { attempts }
	if (!modelRegistry || typeof modelRegistry.find !== "function" || typeof modelRegistry.getApiKeyAndHeaders !== "function") {
		return { attempts }
	}

	const manifest = sourceManifest ?? buildSummarySourceManifest(messagesInRange)

	const operationTimeoutMs = Math.max(1, Math.floor(Number.isFinite(timeoutMs) ? timeoutMs : 1))
	const deadline = Date.now() + operationTimeoutMs
	let lastError: unknown
	for (const ref of modelRefs.slice(0, SUMMARY_MODEL_MAX_REFS)) {
		const parsed = parseModelRef(ref)
		if (!parsed) continue
		const model: Model<Api> | undefined = modelRegistry.find(parsed.provider, parsed.id)
		if (!model) {
			attempts.push({ ref, outcome: "no-model" })
			continue
		}

		let auth: Awaited<ReturnType<ModelSummaryRegistry["getApiKeyAndHeaders"]>>
		try {
			auth = await awaitSummaryDeadline(modelRegistry.getApiKeyAndHeaders(model), deadline, signal)
		} catch (error) {
			lastError = error
			attempts.push({ ref, outcome: "no-auth", error: error instanceof Error ? error.message : String(error) })
			continue
		}
		if (auth.ok === false) {
			attempts.push({ ref, outcome: "no-auth" })
			continue
		}

		const inputBudgetTokens = summaryModelInputBudgetTokens(model)
		const chunkPlan = partitionSummarySourceManifest(manifest, inputBudgetTokens)
		if (chunkPlan.incompleteToolGroup) {
			attempts.push({
				ref,
				outcome: "error",
				error: `source manifest contains incomplete tool group: ${chunkPlan.incompleteToolGroup.pendingToolCallIds.join(",")}`,
			})
			continue
		}
		if (chunkPlan.oversizedGroup) {
			attempts.push({
				ref,
				outcome: "error",
				error: `protocol group exceeds summarizer input budget (${chunkPlan.oversizedGroup.estimatedTokens} > ${inputBudgetTokens})`,
			})
			continue
		}
		if (chunkPlan.chunks.length === 0) {
			attempts.push({ ref, outcome: "empty" })
			continue
		}
		if (chunkPlan.chunks.length > SUMMARY_MODEL_MAX_CHUNKS) {
			attempts.push({
				ref,
				outcome: "error",
				error: `source requires ${chunkPlan.chunks.length} summarizer chunks; max is ${SUMMARY_MODEL_MAX_CHUNKS}`,
			})
			continue
		}

		try {
			let text: string | undefined
			if (chunkPlan.chunks.length === 1) {
				text = await completeSummaryPrompt(
					modelRegistry,
					model,
					auth,
					summaryPromptForManifest(topic, chunkPlan.chunks[0]!),
					deadline,
					signal,
					summaryModelOutputTokens(model, false),
				)
			} else {
				const chunkSummaries: Array<{ sourceIds: string[]; text: string }> = []
				for (let chunkIndex = 0; chunkIndex < chunkPlan.chunks.length; chunkIndex++) {
					const chunk = chunkPlan.chunks[chunkIndex]!
					const chunkText = await completeSummaryPrompt(
						modelRegistry,
						model,
						auth,
						summaryPromptForManifest(
							topic,
							chunk,
							`Summarize source chunk ${chunkIndex + 1}/${chunkPlan.chunks.length} without dropping any source item`,
						),
						deadline,
						signal,
						summaryModelOutputTokens(model, true),
					)
					if (!chunkText) throw new Error(`summarizer chunk ${chunkIndex + 1}/${chunkPlan.chunks.length} returned empty`)
					chunkSummaries.push({ sourceIds: chunk.map((item) => item.sourceId), text: chunkText })
				}
				const mergePrompt = mergeChunkPrompt(topic, chunkSummaries)
				if (estimateTokens(mergePrompt) > inputBudgetTokens) {
					throw new Error(`chunk merge exceeds summarizer input budget (${estimateTokens(mergePrompt)} > ${inputBudgetTokens})`)
				}
				text = await completeSummaryPrompt(
					modelRegistry,
					model,
					auth,
					mergePrompt,
					deadline,
					signal,
					summaryModelOutputTokens(model, false),
				)
			}
			if (text) {
				attempts.push({ ref, outcome: "ok" })
				return { text, usedModelRef: ref, attempts }
			}
			attempts.push({ ref, outcome: "empty" })
		} catch (error) {
			lastError = error
			attempts.push({ ref, outcome: "error", error: error instanceof Error ? error.message : String(error) })
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
	/** Session cwd used for bounded E07 artifact recovery. */
	cwd?: string
	/** Minimum full-projection gain required by the current E05 budget plan. */
	requiredGainTokens?: number
	/** Optional durable publication hook. Live state is not changed unless it succeeds. */
	persistState?: (preparedState: DcpState) => Promise<void>
}

export interface AutoCompressionResult {
	blockId: number
	summaryMode: "programmatic" | "model" | "programmatic_fallback"
	summaryTokens: number
	removedTokenEstimate: number
	/** Full-projection estimator values using the same message estimator before/after. */
	sourceExactEstimate: number
	replacementExactEstimate: number
	projectedGain: number
	/** Stable E06 representation semantics independent of legacy summaryMode names. */
	summaryRepresentation: "model" | "extractive" | "extractive-fallback"
	sourceHash: string
	sourceCoverage: SummarySourceCoverage
	/** Model ref that produced the summary; set only when `summaryMode === "model"`. */
	summarizerModelRef?: string
	/** Per-model attempts, surfaced for DCP debug visibility on fallback. */
	summarizerAttempts?: ModelSummaryAttempt[]
}

function createAutoCompressionWorkingState(state: DcpState): DcpState {
	return {
		...state,
		compressionBlocks: state.compressionBlocks.map((block) => ({
			...block,
			coveredBlockIds: block.coveredBlockIds ? [...block.coveredBlockIds] : undefined,
		})),
	}
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
	const operationEpoch = state.sessionEpoch
	const settings = config.compress.autoCompress
	const closure = closeConversationRange(state.conversationIndexSnapshot, candidate.startId, candidate.endId)
	if (closure?.incompleteToolGroup) {
		throw new Error(
			`Auto-compress candidate ${candidate.startId}..${candidate.endId} intersects an incomplete tool group`,
		)
	}
	let effectiveCandidate: CompressionCandidate = closure?.expanded
		? {
			...candidate,
			startId: closure.startId ?? candidate.startId,
			endId: closure.endId ?? candidate.endId,
			reason: `${candidate.reason}; protocol-closed tool group`,
		}
		: candidate

	const startBoundary = resolveIdToBoundary(effectiveCandidate.startId, "startTimestamp", state)
	const endBoundary = resolveIdToBoundary(effectiveCandidate.endId, "endTimestamp", state)
	if (!Number.isFinite(startBoundary.timestamp) || !Number.isFinite(endBoundary.timestamp)) {
		throw new AutoCompressionBlockedError(
			"missing-source",
			`Auto-compress candidate ${effectiveCandidate.startId}..${effectiveCandidate.endId} did not resolve to finite timestamps`,
		)
	}
	const startTimestamp = startBoundary.timestamp
	const endTimestamp = endBoundary.timestamp

	const stableKeys = stableMessageKeys(messages)
	const messagesInRange = messages.filter((msg, index) =>
		Number.isFinite(msg?.timestamp) &&
		isCompressionBoundaryWithinRange(
			{ timestamp: msg.timestamp, stableId: stableKeys[index] },
			startBoundary,
			endBoundary,
			state,
		),
	)
	if (closure?.expanded) {
		effectiveCandidate = {
			...effectiveCandidate,
			messageCount: messagesInRange.length,
			estimatedTokens: messagesInRange.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
		}
	}

	// Summary source selection. `summaryMode` distinguishes three cases so the
	// DCP debug log can tell a real model summary from a programmatic fallback
	// caused by summarizer failure:
	//   - "model": a configured model produced the summary.
	//   - "programmatic": no summarizer models configured (floor by design).
	//   - "programmatic_fallback": models were configured but all failed/empty.
	const sourceManifest = buildSummarySourceManifest(messagesInRange)
	let summary = buildExtractiveSummary(topic, effectiveCandidate, sourceManifest)
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
			sourceManifest,
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

	const workingState = createAutoCompressionWorkingState(state)
	const anchor = resolveAnchorBoundary(endTimestamp, workingState, endBoundary.stableId)
	const coveredBeforeCreate = findCoveredAndPartialBlocks(
		startTimestamp, endTimestamp, workingState,
		{ startMessageId: startBoundary.stableId, endMessageId: endBoundary.stableId },
	).coveredBlocks
	const preparedProtectedFragments = await prepareCompressionProtectedFragments({
		startTimestamp,
		endTimestamp,
		startMessageId: startBoundary.stableId,
		endMessageId: endBoundary.stableId,
		state: workingState,
		config,
		mode: "range",
		cwd: options.cwd,
	})
	// New blocks have an explicit protected-fragment ledger, so auto rollups can
	// summarize the old synthetic block instead of recursively expanding its
	// entire summary verbatim. Legacy blocks without a ledger keep the old
	// expansion path for compatibility and loss-avoidance.
	const canCompactCoveredSummaries =
		coveredBeforeCreate.length > 0 && coveredBeforeCreate.every((block) => block.protectedFragments !== undefined)
	const created = createRangeCompressionBlock({
		topic,
		summary,
		startTimestamp,
		endTimestamp,
		startMessageId: startBoundary.stableId,
		endMessageId: endBoundary.stableId,
		anchorTimestamp: anchor.timestamp,
		anchorMessageId: anchor.stableId,
		createdByToolCallId: undefined,
		state: workingState,
		config,
		mode: "range",
		version: 2,
		replacementMode: "range",
		validatePlaceholders: !canCompactCoveredSummaries,
		expandPlaceholders: !canCompactCoveredSummaries,
		preparedProtectedFragments,
	})

	const summaryRepresentation: "model" | "extractive" | "extractive-fallback" = summaryMode === "model"
		? "model"
		: summaryMode === "programmatic_fallback"
			? "extractive-fallback"
			: "extractive"
	const sourceHash = hashSummarySourceManifest(sourceManifest)
	const sourceCoverage = summarySourceCoverage(sourceManifest)
	created.block.autoSummaryRepresentation = summaryRepresentation
	created.block.sourceHash = sourceHash
	created.block.sourceCoverage = sourceCoverage

	const sourceExactEstimate = messagesInRange.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
	const replacementExactEstimate = estimateCompressionBlockReplacementTokens(created.block)
	const projectedGain = sourceExactEstimate - replacementExactEstimate
	if (projectedGain <= 0) {
		throw new AutoCompressionBlockedError(
			"non-positive-gain",
			`Auto-compress rejected non-positive full-projection gain for ${effectiveCandidate.startId}..${effectiveCandidate.endId}: ` +
			`source ${sourceExactEstimate} tokens, replacement ${replacementExactEstimate} tokens`,
		)
	}
	const requiredGainTokens = Math.max(0, Math.floor(options.requiredGainTokens ?? 0))
	if (projectedGain < requiredGainTokens) {
		throw new AutoCompressionBlockedError(
			"budget-exhausted",
			`Auto-compress projected gain for ${effectiveCandidate.startId}..${effectiveCandidate.endId} is below required budget recovery: ` +
			`${projectedGain} < ${requiredGainTokens} tokens`,
		)
	}

	if (options.persistState) await options.persistState(workingState)
	if (state.sessionEpoch !== operationEpoch) {
		throw new Error("Auto-compression result became stale because the active session changed before commit")
	}
	state.compressionBlocks = workingState.compressionBlocks
	state.nextBlockId = workingState.nextBlockId

	return {
		blockId: created.block.id,
		summaryMode,
		summaryTokens: created.summaryTokenEstimate,
		removedTokenEstimate: created.removedTokenEstimate,
		sourceExactEstimate,
		replacementExactEstimate,
		projectedGain,
		summaryRepresentation,
		sourceHash,
		sourceCoverage,
		summarizerModelRef,
		summarizerAttempts,
	}
}
