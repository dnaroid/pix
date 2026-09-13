import { createRequire } from "node:module";

import { contextGatewayReadIdentity } from "./telemetry.js";
import type { ContextGatewayObservation } from "./types.js";

type ToolCallLike = {
	toolCallId?: unknown;
	toolName?: unknown;
	input?: unknown;
};

type ToolResultLike = {
	toolCallId?: unknown;
	toolName?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: unknown;
};

type AssistantMessageLike = {
	provider?: unknown;
	model?: unknown;
	stopReason?: unknown;
	usage?: unknown;
};

export type ContextGatewayRetrievalKind =
	| "artifact"
	| "session-recovery"
	| "repeat-read"
	| "read-continuation";

export interface ContextGatewayEfficiencySnapshot {
	toolCalls: number;
	toolResults: number;
	enforcedResults: number;
	sourceContentBytes: number;
	deliveredContentBytes: number;
	grossBytesSaved: number;
	grossEstimatedTokensSaved: number;
	retrievalCalls: number;
	retrievalResults: number;
	retrievalBytes: number;
	retrievalEstimatedTokens: number;
	conservativeNetBytes: number;
	conservativeNetEstimatedTokens: number;
	providerAttempts: number;
	providerCompletions: number;
	providerInputTokens: number;
	providerOutputTokens: number;
	providerCacheReadTokens: number;
	providerCacheWriteTokens: number;
	providerTotalTokens: number;
	providerCost: number;
	byToolClass: Partial<Record<ContextGatewayObservation["toolClass"], {
		results: number;
		enforcedResults: number;
		sourceContentBytes: number;
		deliveredContentBytes: number;
		grossBytesSaved: number;
		grossEstimatedTokensSaved: number;
	}>>;
	byRetrievalKind: Partial<Record<ContextGatewayRetrievalKind, {
		calls: number;
		results: number;
		bytes: number;
		estimatedTokens: number;
	}>>;
}

export interface ContextGatewayEfficiencyToolCall {
	callRef: string;
	toolName: string;
	retrievalKind?: ContextGatewayRetrievalKind;
}

export interface ContextGatewayEfficiencyToolResult extends ContextGatewayEfficiencyToolCall {
	toolClass: ContextGatewayObservation["toolClass"];
	outcome: ContextGatewayObservation["outcome"];
	representation: ContextGatewayObservation["delivery"]["representation"];
	overBudget: boolean;
	potentialBytesOverBudget: number;
	sourceContentBytes: number;
	deliveredContentBytes: number;
	sourceEstimatedTokens: number;
	deliveredEstimatedTokens: number;
	grossBytesSaved: number;
	grossEstimatedTokensSaved: number;
	retrievalBytes: number;
	retrievalEstimatedTokens: number;
}

export interface ContextGatewayProviderCompletion {
	provider?: string;
	model?: string;
	stopReason?: string;
	attemptsSincePreviousCompletion: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	};
}

type BoundCall = ContextGatewayEfficiencyToolCall;
type TokenCounter = ((text: string) => number) | undefined;

const MAX_TRACKED_BINDINGS = 4_096;
const MAX_TRACKED_READ_IDENTITIES = 4_096;
const MAX_TRACKED_ARTIFACT_SOURCES = 4_096;

let optionalTokenCounter: TokenCounter | null = null;

function loadOptionalTokenCounter(): TokenCounter {
	if (optionalTokenCounter !== null) return optionalTokenCounter;
	try {
		const require = createRequire(import.meta.url);
		const tokenizer = require("@anthropic-ai/tokenizer") as {
			countTokens?: unknown;
			default?: { countTokens?: unknown };
		};
		const counter = tokenizer.countTokens ?? tokenizer.default?.countTokens;
		optionalTokenCounter = typeof counter === "function" ? counter as (text: string) => number : undefined;
	} catch {
		optionalTokenCounter = undefined;
	}
	return optionalTokenCounter;
}

export function estimateContextGatewayTokens(text: string): number {
	if (!text) return 0;
	const counter = loadOptionalTokenCounter();
	if (counter) {
		try {
			const counted = counter(text);
			if (Number.isFinite(counted)) return Math.max(0, Math.round(counted));
		} catch {
			// Fall through to the same cheap approximation used when no tokenizer is installed.
		}
	}
	return Math.max(0, Math.round(text.length / 4));
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (!part || typeof part !== "object" || Array.isArray(part)) continue;
		const block = part as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function assistantUsage(message: AssistantMessageLike): ContextGatewayProviderCompletion["usage"] {
	const usage = message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
		? message.usage as Record<string, unknown>
		: {};
	const costValue = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
		? finiteNonNegative((usage.cost as Record<string, unknown>).total)
		: 0;
	return {
		input: finiteNonNegative(usage.input),
		output: finiteNonNegative(usage.output),
		cacheRead: finiteNonNegative(usage.cacheRead),
		cacheWrite: finiteNonNegative(usage.cacheWrite),
		totalTokens: finiteNonNegative(usage.totalTokens),
		cost: costValue,
	};
}

function retrievalKindForToolName(toolName: string): ContextGatewayRetrievalKind | undefined {
	if (toolName === "artifact_read" || toolName === "artifact_search") return "artifact";
	if (["session_overview", "session_read_section", "session_search", "session_recovery_context"].includes(toolName)) {
		return "session-recovery";
	}
	return undefined;
}

function artifactHandlePaths(details: unknown): string[] {
	if (!details || typeof details !== "object" || Array.isArray(details)) return [];
	const record = details as Record<string, unknown>;
	const paths: string[] = [];
	for (const key of ["fullOutputPath", "artifactPath", "outputPath"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) paths.push(value);
	}
	const artifacts = record.artifacts;
	if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
		for (const value of Object.values(artifacts as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim()) paths.push(value);
		}
	}
	return paths;
}

function rememberBounded(set: Set<string>, value: string, maximum: number): void {
	if (set.delete(value)) {
		set.add(value);
		return;
	}
	if (set.size >= maximum) {
		const oldest = set.values().next().value;
		if (oldest !== undefined) set.delete(oldest);
	}
	set.add(value);
}

function bindBounded(map: Map<string, BoundCall>, key: string, value: BoundCall): void {
	if (!map.has(key) && map.size >= MAX_TRACKED_BINDINGS) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}

function emptySnapshot(): ContextGatewayEfficiencySnapshot {
	return {
		toolCalls: 0,
		toolResults: 0,
		enforcedResults: 0,
		sourceContentBytes: 0,
		deliveredContentBytes: 0,
		grossBytesSaved: 0,
		grossEstimatedTokensSaved: 0,
		retrievalCalls: 0,
		retrievalResults: 0,
		retrievalBytes: 0,
		retrievalEstimatedTokens: 0,
		conservativeNetBytes: 0,
		conservativeNetEstimatedTokens: 0,
		providerAttempts: 0,
		providerCompletions: 0,
		providerInputTokens: 0,
		providerOutputTokens: 0,
		providerCacheReadTokens: 0,
		providerCacheWriteTokens: 0,
		providerTotalTokens: 0,
		providerCost: 0,
		byToolClass: {},
		byRetrievalKind: {},
	};
}

export class ContextGatewayEfficiencyTracker {
	private totals = emptySnapshot();
	private bindings = new Map<string, BoundCall>();
	private seenExactReads = new Set<string>();
	private seenReadSources = new Set<string>();
	private artifactReadSources = new Set<string>();
	private callSequence = 0;
	private attemptsAtPreviousCompletion = 0;

	recordToolCall(event: ToolCallLike): ContextGatewayEfficiencyToolCall | undefined {
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return undefined;
		const toolName = event.toolName.trim().toLowerCase();
		let retrievalKind = retrievalKindForToolName(toolName);
		if (toolName === "read") {
			const identity = contextGatewayReadIdentity(event.input);
			if (identity.source && this.artifactReadSources.has(identity.source)) {
				retrievalKind = "artifact";
				rememberBounded(this.artifactReadSources, identity.source, MAX_TRACKED_ARTIFACT_SOURCES);
			}
			else if (identity.exact && this.seenExactReads.has(identity.exact)) retrievalKind = "repeat-read";
			else if (identity.source && this.seenReadSources.has(identity.source)) retrievalKind = "read-continuation";
			if (identity.exact) rememberBounded(this.seenExactReads, identity.exact, MAX_TRACKED_READ_IDENTITIES);
			if (identity.source) rememberBounded(this.seenReadSources, identity.source, MAX_TRACKED_READ_IDENTITIES);
		}

		const binding: BoundCall = {
			callRef: `c${++this.callSequence}`,
			toolName,
			...(retrievalKind ? { retrievalKind } : {}),
		};
		bindBounded(this.bindings, event.toolCallId, binding);
		this.totals.toolCalls += 1;
		if (retrievalKind) {
			this.totals.retrievalCalls += 1;
			const counters = this.totals.byRetrievalKind[retrievalKind] ?? { calls: 0, results: 0, bytes: 0, estimatedTokens: 0 };
			counters.calls += 1;
			this.totals.byRetrievalKind[retrievalKind] = counters;
		}
		return { ...binding };
	}

	recordToolResult(
		event: ToolResultLike,
		observation: ContextGatewayObservation,
		deliveredContent: unknown = event.content,
	): ContextGatewayEfficiencyToolResult | undefined {
		if (typeof event.toolCallId !== "string") return undefined;
		const binding = this.bindings.get(event.toolCallId);
		if (!binding) return undefined;
		this.bindings.delete(event.toolCallId);

		const sourceEstimatedTokens = estimateContextGatewayTokens(contentText(event.content));
		const deliveredEstimatedTokens = estimateContextGatewayTokens(contentText(deliveredContent));
		const grossEstimatedTokensSaved = Math.max(0, sourceEstimatedTokens - deliveredEstimatedTokens);
		const grossBytesSaved = observation.actualBytesSaved;
		const retrievalBytes = binding.retrievalKind ? observation.delivery.contentBytes : 0;
		const retrievalEstimatedTokens = binding.retrievalKind ? deliveredEstimatedTokens : 0;

		this.totals.toolResults += 1;
		this.totals.sourceContentBytes += observation.source.contentBytes;
		this.totals.deliveredContentBytes += observation.delivery.contentBytes;
		if (observation.delivery.representation !== "passthrough") this.totals.enforcedResults += 1;
		this.totals.grossBytesSaved += grossBytesSaved;
		this.totals.grossEstimatedTokensSaved += grossEstimatedTokensSaved;
		const classCounters = this.totals.byToolClass[observation.toolClass] ?? {
			results: 0,
			enforcedResults: 0,
			sourceContentBytes: 0,
			deliveredContentBytes: 0,
			grossBytesSaved: 0,
			grossEstimatedTokensSaved: 0,
		};
		classCounters.results += 1;
		if (observation.delivery.representation !== "passthrough") classCounters.enforcedResults += 1;
		classCounters.sourceContentBytes += observation.source.contentBytes;
		classCounters.deliveredContentBytes += observation.delivery.contentBytes;
		classCounters.grossBytesSaved += grossBytesSaved;
		classCounters.grossEstimatedTokensSaved += grossEstimatedTokensSaved;
		this.totals.byToolClass[observation.toolClass] = classCounters;
		if (binding.retrievalKind) {
			this.totals.retrievalResults += 1;
			this.totals.retrievalBytes += retrievalBytes;
			this.totals.retrievalEstimatedTokens += retrievalEstimatedTokens;
			const counters = this.totals.byRetrievalKind[binding.retrievalKind]
				?? { calls: 0, results: 0, bytes: 0, estimatedTokens: 0 };
			counters.results += 1;
			counters.bytes += retrievalBytes;
			counters.estimatedTokens += retrievalEstimatedTokens;
			this.totals.byRetrievalKind[binding.retrievalKind] = counters;
		}
		this.refreshNet();
		for (const artifactPath of artifactHandlePaths(event.details)) {
			const source = contextGatewayReadIdentity({ path: artifactPath }).source;
			if (source) rememberBounded(this.artifactReadSources, source, MAX_TRACKED_ARTIFACT_SOURCES);
		}

		return {
			...binding,
			toolClass: observation.toolClass,
			outcome: observation.outcome,
			representation: observation.delivery.representation,
			overBudget: observation.overBudget,
			potentialBytesOverBudget: observation.potentialBytesOverBudget,
			sourceContentBytes: observation.source.contentBytes,
			deliveredContentBytes: observation.delivery.contentBytes,
			sourceEstimatedTokens,
			deliveredEstimatedTokens,
			grossBytesSaved,
			grossEstimatedTokensSaved,
			retrievalBytes,
			retrievalEstimatedTokens,
		};
	}

	recordProviderAttempt(): number {
		this.totals.providerAttempts += 1;
		return this.totals.providerAttempts;
	}

	recordProviderCompletion(message: AssistantMessageLike): ContextGatewayProviderCompletion {
		const usage = assistantUsage(message);
		this.totals.providerCompletions += 1;
		this.totals.providerInputTokens += usage.input;
		this.totals.providerOutputTokens += usage.output;
		this.totals.providerCacheReadTokens += usage.cacheRead;
		this.totals.providerCacheWriteTokens += usage.cacheWrite;
		this.totals.providerTotalTokens += usage.totalTokens;
		this.totals.providerCost += usage.cost;
		const attemptsSincePreviousCompletion = this.totals.providerAttempts - this.attemptsAtPreviousCompletion;
		this.attemptsAtPreviousCompletion = this.totals.providerAttempts;
		return {
			...(typeof message.provider === "string" ? { provider: message.provider } : {}),
			...(typeof message.model === "string" ? { model: message.model } : {}),
			...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
			attemptsSincePreviousCompletion,
			usage,
		};
	}

	clearTransientBindings(): void {
		this.bindings.clear();
	}

	reset(): void {
		this.totals = emptySnapshot();
		this.bindings.clear();
		this.seenExactReads.clear();
		this.seenReadSources.clear();
		this.artifactReadSources.clear();
		this.callSequence = 0;
		this.attemptsAtPreviousCompletion = 0;
	}

	snapshot(): ContextGatewayEfficiencySnapshot {
		return structuredClone(this.totals);
	}

	private refreshNet(): void {
		this.totals.conservativeNetBytes = this.totals.grossBytesSaved - this.totals.retrievalBytes;
		this.totals.conservativeNetEstimatedTokens = this.totals.grossEstimatedTokensSaved - this.totals.retrievalEstimatedTokens;
	}
}
