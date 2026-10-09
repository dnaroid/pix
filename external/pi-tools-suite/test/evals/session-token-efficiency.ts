import { readFileSync } from "node:fs";

import { COMPRESS_TOOL_PARAMETERS } from "../../src/dcp/compress-tool.js";
import type { DcpConfig } from "../../src/dcp/config.js";
import { loadConfig } from "../../src/dcp/config.js";
import { injectMessageIds } from "../../src/dcp/pruner-message-ids.js";
import { estimateMessageTokens, estimateTokens, messageText } from "../../src/dcp/pruner-metadata.js";
import { toolRecordContinuity } from "../../src/dcp/protected-continuity.js";
import { createState } from "../../src/dcp/state.js";
import type { CompressionBlock, ToolRecord } from "../../src/dcp/state.js";
import { previewCompressionContinuityRepack, renderCompressionBlockSummary } from "../../src/dcp/compression-blocks.js";
import {
	CONTEXT_LIMIT_NUDGE_SOFT,
	CONTEXT_LIMIT_NUDGE_STRONG,
	ITERATION_NUDGE,
	SYSTEM_PROMPT,
	TURN_NUDGE,
} from "../../src/dcp/prompts.js";
import { COMPRESS_TOOL_DESCRIPTION } from "../../src/tool-descriptions.js";

type UnknownRecord = Record<string, unknown>;

export interface SessionUsageTotals {
	assistantCalls: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokenOccurrences: number;
	output: number;
	reasoning: number;
	totalTokens: number;
	cost: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		total: number;
	};
}

export interface SessionDcpBlockMetrics {
	id: number;
	active: boolean;
	summaryChars: number;
	summaryTokenEstimate: number;
	protectedFragmentCount: number;
	protectedFragmentChars: number;
	coveredBlockCount: number;
}

export interface SessionCompressMetrics {
	toolCallId?: string;
	committed: boolean;
	projectedBeforeTokens?: number;
	projectedAfterTokens?: number;
	netGain?: number;
	totalSummaryTokens?: number;
	prunedTools?: number;
}

export interface SessionTokenEfficiencyReport {
	version: 1;
	entries: number;
	usage: SessionUsageTotals;
	tools: {
		calls: number;
		results: number;
		errors: number;
		callsByName: Record<string, number>;
		resultsByName: Record<string, number>;
	};
	dcp: {
		blocks: SessionDcpBlockMetrics[];
		compressResults: SessionCompressMetrics[];
		totalProtectedFragmentChars: number;
		manualSummaryDelegation: {
			compressCalls: number;
			compressAssistantCalls: number;
			compressAssistantOutputTokens: number;
			summaryArgumentChars: number;
			summaryArgumentEstimatedTokens: number;
			argumentEstimatedTokensBefore: number;
			argumentEstimatedTokensWithoutSummaries: number;
			estimatedArgumentTokenReduction: number;
		};
		continuityProjection?: {
			baselineProtectedChars: number;
			projectedProtectedChars: number;
			reductionChars: number;
			reductionPercent: number;
			activeSummaryBaselineTokens: number;
			activeSummaryProjectedTokens: number;
			activeSummaryTokenReduction: number;
			projectedLatestCompressionNetGain?: number;
			toolFragments: number;
			byMode: Record<"none" | "digest" | "receipt" | "verbatim", number>;
			byReason: Record<string, { fragments: number; baselineChars: number; projectedChars: number }>;
		};
		carrierProjection?: DcpCarrierMeasurement;
	};
	accounting: {
		historyCompressionGainTokens: number;
		recoveryTax: {
			exactRepeatReadsAfterContextReduction: number;
			sameSourceDifferentRangeReadsAfterContextReduction: number;
			unattributedCandidates: number;
			likelyRecoveryTaxReads: number;
		};
	};
}

export interface DcpControlPlaneMeasurement {
	version: 1;
	components: {
		systemPrompt: TextMeasurement;
		compressDescription: TextMeasurement;
		compressPromptSnippet: TextMeasurement;
		compressPromptGuidelines: TextMeasurement;
		compressSchema: TextMeasurement;
		turnNudge: TextMeasurement;
		iterationNudge: TextMeasurement;
		softLimitNudge: TextMeasurement;
		strongLimitNudge: TextMeasurement;
	};
	staticToolEnvelope: TextMeasurement;
	staticSystemPlusToolEnvelope: TextMeasurement;
}

export interface TextMeasurement {
	chars: number;
	bytes: number;
	estimatedTokens: number;
}

export interface DcpCarrierMeasurement {
	version: 1;
	messages: number;
	carriers: number;
	rawEstimatedTokens: number;
	withCarrierEstimatedTokens: number;
	overheadEstimatedTokens: number;
	legacyEquivalentOverheadEstimatedTokens: number;
	reductionVsLegacyPercent: number;
}

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readIdentity(input: Record<string, unknown>): { exact?: string; source?: string } {
	const rawPath = input.path ?? input.file ?? input.filePath;
	if (typeof rawPath !== "string" || !rawPath.trim()) return {};
	const raw = rawPath.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	const prefix = raw.startsWith("/") ? "/" : /^[A-Za-z]:\//.test(raw) ? raw.slice(0, 3).toLowerCase() : "";
	const body = prefix === "/" ? raw.slice(1) : prefix ? raw.slice(3) : raw;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
		else if (part === ".." && !prefix) parts.push(part);
		else if (part !== "..") parts.push(part);
	}
	const path = `${prefix}${parts.join("/")}` || prefix || ".";
	const rangeValue = (value: unknown): number | undefined => {
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
		if (typeof value === "string" && /^\d+$/.test(value.trim())) {
			const parsed = Number(value);
			if (Number.isSafeInteger(parsed)) return parsed;
		}
		return undefined;
	};
	const source = JSON.stringify({ path });
	const exact = JSON.stringify({
		path,
		offset: rangeValue(input.offset ?? input.start ?? input.line),
		limit: rangeValue(input.limit ?? input.lines ?? input.count),
	});
	return { source, exact };
}

function countByName(target: Record<string, number>, name: unknown): void {
	const key = typeof name === "string" && name.length > 0 ? name : "unknown";
	target[key] = (target[key] ?? 0) + 1;
}

function textMeasure(text: string): TextMeasurement {
	// Control-plane text is canonically LF. Windows checkouts may hand us
	// CRLF (core.autocrlf), and bun-on-Windows preserves CRLF inside module
	// string literals, which would inflate every estimate without changing
	// the shipped prompt. Measure the canonical form so the budget reflects
	// real prompt content, not checkout line endings.
	const canonical = text.replace(/\r\n?/g, "\n");
	return {
		chars: canonical.length,
		bytes: Buffer.byteLength(canonical, "utf8"),
		estimatedTokens: estimateTokens(canonical),
	};
}

function withoutCompressSummaries(input: Record<string, unknown>): {
	value: Record<string, unknown>;
	summaryChars: number;
	summaryEstimatedTokens: number;
} {
	const value = structuredClone(input);
	let summaryChars = 0;
	let summaryEstimatedTokens = 0;
	for (const key of ["ranges", "messages"] as const) {
		const entries = value[key];
		if (!Array.isArray(entries)) continue;
		for (const raw of entries) {
			if (!isRecord(raw) || typeof raw.summary !== "string") continue;
			summaryChars += raw.summary.length;
			summaryEstimatedTokens += estimateTokens(raw.summary);
			delete raw.summary;
		}
	}
	return { value, summaryChars, summaryEstimatedTokens };
}

// The compress tool parameters come from the runtime's TypeBox module, and
// different TypeBox generations serialize the same schema with different
// key shapes (classic `type`/`required`/`properties` versus wrapper-era
// `kind`/`options`/`schema`). The measurement must reflect the shipped
// schema content, not which representation the local runtime happens to
// produce, so project both representations onto one canonical shape.
function isSchemaRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJsonSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonSchema);
	if (!isSchemaRecord(value)) return value;
	// Wrapper-era optionals wrap their inner schema; unwrap so both
	// representations converge on the inner form.
	if (value.kind === "optional" && "schema" in value) return canonicalJsonSchema(value.schema);
	const kind = typeof value.type === "string" ? value.type : typeof value.kind === "string" ? value.kind : undefined;
	const options = isSchemaRecord(value.options) ? value.options : {};
	const canonical: Record<string, unknown> = {};
	if (kind !== undefined) canonical.type = kind;
	const properties = isSchemaRecord(value.properties) ? value.properties : undefined;
	if (Array.isArray(value.required)) canonical.required = [...value.required];
	else if (properties) {
		const required = Object.keys(properties).filter((name) => {
			const child = properties[name];
			return !(isSchemaRecord(child) && child.kind === "optional");
		});
		if (required.length > 0) canonical.required = required;
	}
	if (properties) {
		canonical.properties = Object.fromEntries(
			Object.entries(properties).map(([name, child]) => [name, canonicalJsonSchema(child)]),
		);
	}
	if ("items" in value) canonical.items = canonicalJsonSchema(value.items);
	// Inline option metadata (descriptions, defaults, ...) after the
	// structural keys, matching the classic TypeBox insertion order.
	for (const [key, option] of Object.entries(options)) {
		if (key in canonical) continue;
		canonical[key] = canonicalJsonSchema(option);
	}
	for (const [key, entry] of Object.entries(value)) {
		if (key === "kind" || key === "~kind" || key === "options" || key === "schema" || key in canonical) continue;
		canonical[key] = entry;
	}
	return canonical;
}

function canonicalSchemaText(schema: Record<string, unknown>): string {
	return JSON.stringify(canonicalJsonSchema(schema));
}

function toolEnvelopeText(): string {
	return JSON.stringify({
		name: COMPRESS_TOOL_DESCRIPTION.name,
		label: COMPRESS_TOOL_DESCRIPTION.label,
		description: COMPRESS_TOOL_DESCRIPTION.description,
		promptSnippet: COMPRESS_TOOL_DESCRIPTION.promptSnippet,
		promptGuidelines: COMPRESS_TOOL_DESCRIPTION.promptGuidelines,
		parameters: JSON.parse(canonicalSchemaText(COMPRESS_TOOL_PARAMETERS as unknown as Record<string, unknown>)),
	});
}

export function measureDcpControlPlane(): DcpControlPlaneMeasurement {
	const guidelines = (COMPRESS_TOOL_DESCRIPTION.promptGuidelines ?? []).join("\n");
	const schema = canonicalSchemaText(COMPRESS_TOOL_PARAMETERS as unknown as Record<string, unknown>);
	const envelope = toolEnvelopeText();
	return {
		version: 1,
		components: {
			systemPrompt: textMeasure(SYSTEM_PROMPT),
			compressDescription: textMeasure(COMPRESS_TOOL_DESCRIPTION.description),
			compressPromptSnippet: textMeasure(COMPRESS_TOOL_DESCRIPTION.promptSnippet ?? ""),
			compressPromptGuidelines: textMeasure(guidelines),
			compressSchema: textMeasure(schema),
			turnNudge: textMeasure(TURN_NUDGE),
			iterationNudge: textMeasure(ITERATION_NUDGE),
			softLimitNudge: textMeasure(CONTEXT_LIMIT_NUDGE_SOFT),
			strongLimitNudge: textMeasure(CONTEXT_LIMIT_NUDGE_STRONG),
		},
		staticToolEnvelope: textMeasure(envelope),
		staticSystemPlusToolEnvelope: textMeasure(`${SYSTEM_PROMPT}\n${envelope}`),
	};
}

export function measureDcpCarrierOverhead(messages: unknown[]): DcpCarrierMeasurement {
	const raw = structuredClone(messages) as any[];
	const projected = structuredClone(messages) as any[];
	const rawEstimatedTokens = raw.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	injectMessageIds(projected, createState());
	const withCarrierEstimatedTokens = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	const carriers = projected.filter((message) => messageText(message).includes("<dcp-message-ids>")).length;
	const legacyProjected = structuredClone(projected) as any[];
	for (const message of legacyProjected) rewriteCarrierTags(message, legacyCarrierText);
	const legacyWithCarrierEstimatedTokens = legacyProjected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
	const legacyEquivalentOverheadEstimatedTokens = Math.max(0, legacyWithCarrierEstimatedTokens - rawEstimatedTokens);
	const overheadEstimatedTokens = Math.max(0, withCarrierEstimatedTokens - rawEstimatedTokens);
	return {
		version: 1,
		messages: projected.length,
		carriers,
		rawEstimatedTokens,
		withCarrierEstimatedTokens,
		overheadEstimatedTokens,
		legacyEquivalentOverheadEstimatedTokens,
		reductionVsLegacyPercent: legacyEquivalentOverheadEstimatedTokens > 0
			? ((legacyEquivalentOverheadEstimatedTokens - overheadEstimatedTokens) / legacyEquivalentOverheadEstimatedTokens) * 100
			: 0,
	};
}

const COMPACT_CARRIER_RE = /<dcp-message-ids>([^<]*)<\/dcp-message-ids>/g;

function legacyCarrierText(compactBody: string): string {
	const assignments: string[] = [];
	let blockId: string | undefined;
	for (const item of compactBody.split(";")) {
		const [id, code] = item.split("=");
		if (!id || !code) continue;
		if (code === "b") {
			blockId = id;
			continue;
		}
		const label = code === "a"
			? "preceding assistant message"
			: code === "t"
				? "this tool result"
				: code === "x"
					? "this bash result"
					: "this user message";
		assignments.push(`${id}=${label}`);
	}
	return [
		"<dcp-message-ids>",
		`Stable DCP IDs (use with compress; do not quote/output): ${assignments.join("; ")}`,
		...(blockId ? [`Active compressed block alias: ${blockId}`] : []),
		"</dcp-message-ids>",
	].join("\n");
}

function rewriteCarrierTags(message: any, transform: (body: string) => string): void {
	const rewrite = (text: string): string => text.replace(COMPACT_CARRIER_RE, (_whole, body: string) => transform(body));
	if (typeof message?.content === "string") {
		message.content = rewrite(message.content);
		return;
	}
	if (!Array.isArray(message?.content)) return;
	for (const part of message.content) {
		if (part && typeof part === "object" && typeof part.text === "string") part.text = rewrite(part.text);
	}
}

export function analyzeSessionJsonlText(
	text: string,
	options: { dcpConfig?: DcpConfig } = {},
): SessionTokenEfficiencyReport {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const entries = lines.map((line, index) => {
		try {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed)) throw new Error("entry is not an object");
			return parsed;
		} catch (error) {
			throw new Error(`Invalid session JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	const usage: SessionUsageTotals = {
		assistantCalls: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		promptTokenOccurrences: 0,
		output: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
	};
	const callsByName: Record<string, number> = {};
	const resultsByName: Record<string, number> = {};
	let toolCalls = 0;
	let toolResults = 0;
	let toolErrors = 0;
	const blocksById = new Map<number, UnknownRecord>();
	const compressResults: SessionCompressMetrics[] = [];
	const preCompressionMessages: unknown[] = [];
	let firstCompressSeen = false;
	const calls = new Map<string, { toolName: string; input: Record<string, unknown>; entryIndex: number }>();
	const records = new Map<string, ToolRecord>();
	const readCalls: Array<{ entryIndex: number; exact?: string; source?: string }> = [];
	const contextReductionIndexes: number[] = [];
	const manualSummaryDelegation = {
		compressCalls: 0,
		compressAssistantCalls: 0,
		compressAssistantOutputTokens: 0,
		summaryArgumentChars: 0,
		summaryArgumentEstimatedTokens: 0,
		argumentEstimatedTokensBefore: 0,
		argumentEstimatedTokensWithoutSummaries: 0,
		estimatedArgumentTokenReduction: 0,
	};

	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type === "custom" && entry.customType === "dcp-journal" && isRecord(entry.data)) {
			const blocks = entry.data.blocks;
			if (Array.isArray(blocks)) {
				for (const block of blocks) {
					if (!isRecord(block) || !Number.isSafeInteger(block.id)) continue;
					blocksById.set(block.id as number, block);
				}
			}
			const blockStates = entry.data.blockStates;
			if (Array.isArray(blockStates)) {
				for (const item of blockStates) {
					if (!isRecord(item) || !Number.isSafeInteger(item.id) || typeof item.active !== "boolean") continue;
					const block = blocksById.get(item.id as number);
					if (!block) continue;
					block.active = item.active;
					if (typeof item.deactivatedReason === "string") block.deactivatedReason = item.deactivatedReason;
				}
			}
			continue;
		}

		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		const startsCompression = message.role === "assistant" && Array.isArray(message.content)
			&& message.content.some((part) => isRecord(part) && part.type === "toolCall" && part.name === "compress");
		if (!firstCompressSeen && startsCompression) firstCompressSeen = true;
		else if (!firstCompressSeen) preCompressionMessages.push(structuredClone(message));
		if (message.role === "assistant") {
			usage.assistantCalls += 1;
			if (startsCompression) {
				manualSummaryDelegation.compressAssistantCalls += 1;
				manualSummaryDelegation.compressAssistantOutputTokens += isRecord(message.usage)
					? finiteNumber(message.usage.output)
					: 0;
			}
			if (isRecord(message.usage)) {
				const item = message.usage;
				usage.input += finiteNumber(item.input);
				usage.cacheRead += finiteNumber(item.cacheRead);
				usage.cacheWrite += finiteNumber(item.cacheWrite);
				usage.output += finiteNumber(item.output);
				usage.reasoning += finiteNumber(item.reasoning);
				usage.totalTokens += finiteNumber(item.totalTokens);
				if (isRecord(item.cost)) {
					usage.cost.input += finiteNumber(item.cost.input);
					usage.cost.cacheRead += finiteNumber(item.cost.cacheRead);
					usage.cost.cacheWrite += finiteNumber(item.cost.cacheWrite);
					usage.cost.output += finiteNumber(item.cost.output);
					usage.cost.total += finiteNumber(item.cost.total);
				}
			}
			if (Array.isArray(message.content)) {
				for (const part of message.content) {
					if (!isRecord(part) || part.type !== "toolCall") continue;
					toolCalls += 1;
					countByName(callsByName, part.name);
					const toolCallId = typeof part.id === "string" ? part.id : `missing-${toolCalls}`;
					const toolName = typeof part.name === "string" ? part.name : "unknown";
					const rawInput = isRecord(part.arguments) ? part.arguments : isRecord(part.input) ? part.input : {};
					if (toolName === "compress") {
						manualSummaryDelegation.compressCalls += 1;
						const stripped = withoutCompressSummaries(rawInput);
						const beforeTokens = estimateTokens(JSON.stringify(rawInput));
						const afterTokens = estimateTokens(JSON.stringify(stripped.value));
						manualSummaryDelegation.summaryArgumentChars += stripped.summaryChars;
						manualSummaryDelegation.summaryArgumentEstimatedTokens += stripped.summaryEstimatedTokens;
						manualSummaryDelegation.argumentEstimatedTokensBefore += beforeTokens;
						manualSummaryDelegation.argumentEstimatedTokensWithoutSummaries += afterTokens;
						manualSummaryDelegation.estimatedArgumentTokenReduction += Math.max(0, beforeTokens - afterTokens);
					}
					calls.set(toolCallId, { toolName, input: rawInput, entryIndex });
					if (toolName.trim().toLowerCase() === "read") {
						const identity = readIdentity(rawInput);
						readCalls.push({ entryIndex, ...identity });
					}
				}
			}
			continue;
		}

		if (message.role !== "toolResult" && message.role !== "bashExecution") continue;
		toolResults += 1;
		if (message.isError === true) toolErrors += 1;
		countByName(resultsByName, message.toolName);
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : `missing-result-${toolResults}`;
		const bound = calls.get(toolCallId);
		const outputText = messageText(message);
		records.set(toolCallId, {
			toolCallId,
			toolName: typeof message.toolName === "string" ? message.toolName : bound?.toolName ?? "unknown",
			inputArgs: bound?.input ?? {},
			inputFingerprint: "offline-session-replay",
			isError: message.isError === true,
			turnIndex: 0,
			timestamp: finiteNumber(message.timestamp),
			tokenEstimate: estimateTokens(outputText),
			outputText,
			outputDetails: message.details,
		});

		if (message.toolName === "compress" && isRecord(message.details)) {
			const compressResult: SessionCompressMetrics = {
				toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
				committed: message.details.committed === true,
				projectedBeforeTokens: optionalFiniteNumber(message.details.projectedBeforeTokens),
				projectedAfterTokens: optionalFiniteNumber(message.details.projectedAfterTokens),
				netGain: optionalFiniteNumber(message.details.netGain),
				totalSummaryTokens: optionalFiniteNumber(message.details.totalSummaryTokens),
				prunedTools: optionalFiniteNumber(message.details.prunedTools),
			};
			compressResults.push(compressResult);
			if (compressResult.committed) contextReductionIndexes.push(entryIndex);
		}
	}

	usage.promptTokenOccurrences = usage.input + usage.cacheRead + usage.cacheWrite;
	const blocks = [...blocksById.values()]
		.map((block): SessionDcpBlockMetrics => {
			const fragments = Array.isArray(block.protectedFragments) ? block.protectedFragments : [];
			const renderedSummary = typeof block.summary === "string"
				? renderCompressionBlockSummary(block as unknown as CompressionBlock)
				: "";
			return {
				id: block.id as number,
				active: block.active === true,
				summaryChars: renderedSummary.length,
				summaryTokenEstimate: finiteNumber(block.summaryTokenEstimate),
				protectedFragmentCount: fragments.length,
				protectedFragmentChars: fragments.reduce((sum, fragment) =>
					sum + (isRecord(fragment) && typeof fragment.text === "string" ? fragment.text.length : 0), 0),
				coveredBlockCount: Array.isArray(block.coveredBlockIds) ? block.coveredBlockIds.length : 0,
			};
		})
		.sort((a, b) => a.id - b.id);
	const dcpConfig = options.dcpConfig;
	let continuityProjection: SessionTokenEfficiencyReport["dcp"]["continuityProjection"];
	if (dcpConfig) {
		let baselineProtectedChars = 0;
		let projectedProtectedChars = 0;
		let activeSummaryBaselineTokens = 0;
		let activeSummaryProjectedTokens = 0;
		let toolFragments = 0;
		const byMode = { none: 0, digest: 0, receipt: 0, verbatim: 0 };
		const byReason: Record<string, { fragments: number; baselineChars: number; projectedChars: number }> = {};
		const replayState = createState();
		replayState.toolCalls = new Map(records);
		replayState.compressionBlocks = [...blocksById.values()] as unknown as CompressionBlock[];
		for (const rawBlock of blocksById.values()) {
			if (typeof rawBlock.summary !== "string") continue;
			const block = rawBlock as unknown as CompressionBlock;
			const originalSummary = renderCompressionBlockSummary(block);
			let projectedSummary = originalSummary;
			const fragments = Array.isArray(rawBlock.protectedFragments) ? rawBlock.protectedFragments : [];
			for (const fragment of fragments) {
				if (!isRecord(fragment) || typeof fragment.text !== "string") continue;
				baselineProtectedChars += fragment.text.length;
				const match = typeof fragment.origin === "string" ? /^tool:(.+)$/.exec(fragment.origin) : null;
				if (!match) continue;
				toolFragments += 1;
				const record = records.get(match[1]!);
				if (!record) {
					byMode.verbatim += 1;
					continue;
				}
				const decision = toolRecordContinuity(record, dcpConfig);
				byMode[decision.mode] += 1;
				const projectedChars = decision.text?.length ?? 0;
				const reason = byReason[decision.reason] ?? { fragments: 0, baselineChars: 0, projectedChars: 0 };
				reason.fragments += 1;
				reason.baselineChars += fragment.text.length;
				reason.projectedChars += projectedChars;
				byReason[decision.reason] = reason;
			}
			let projectedFragments = fragments;
			try {
				const preview = previewCompressionContinuityRepack(block, replayState, dcpConfig);
				projectedSummary = preview.renderedSummary;
				projectedFragments = preview.protectedFragments;
			} catch {
				// Exact continuity that cannot fit the configured policy remains a
				// fail-closed no-op in the projection, matching runtime behavior.
			}
			projectedProtectedChars += projectedFragments.reduce((sum, fragment) =>
				sum + (isRecord(fragment) && typeof fragment.text === "string" ? fragment.text.length : 0), 0);
			if (rawBlock.active === true) {
				activeSummaryBaselineTokens += estimateTokens(originalSummary);
				activeSummaryProjectedTokens += estimateTokens(projectedSummary);
			}
		}
		const reductionChars = Math.max(0, baselineProtectedChars - projectedProtectedChars);
		const activeSummaryTokenReduction = Math.max(0, activeSummaryBaselineTokens - activeSummaryProjectedTokens);
		const latestCommittedNetGain = [...compressResults].reverse().find((result) => result.committed)?.netGain;
		continuityProjection = {
			baselineProtectedChars,
			projectedProtectedChars,
			reductionChars,
			reductionPercent: baselineProtectedChars > 0 ? (reductionChars / baselineProtectedChars) * 100 : 0,
			activeSummaryBaselineTokens,
			activeSummaryProjectedTokens,
			activeSummaryTokenReduction,
			...(latestCommittedNetGain !== undefined
				? { projectedLatestCompressionNetGain: latestCommittedNetGain + activeSummaryTokenReduction }
				: {}),
			toolFragments,
			byMode,
			byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => a.localeCompare(b))),
		};
	}
	contextReductionIndexes.sort((a, b) => a - b);
	const hasReductionBetween = (start: number, end: number): boolean =>
		contextReductionIndexes.some((index) => index > start && index < end);
	let exactRepeatReadsAfterContextReduction = 0;
	let sameSourceDifferentRangeReadsAfterContextReduction = 0;
	const lastExact = new Map<string, number>();
	const lastSource = new Map<string, { entryIndex: number; exact?: string }>();
	for (const read of readCalls) {
		const previousExact = read.exact ? lastExact.get(read.exact) : undefined;
		if (previousExact !== undefined && hasReductionBetween(previousExact, read.entryIndex)) {
			exactRepeatReadsAfterContextReduction += 1;
		} else if (read.source) {
			const previousSource = lastSource.get(read.source);
			if (
				previousSource
				&& previousSource.exact !== read.exact
				&& hasReductionBetween(previousSource.entryIndex, read.entryIndex)
			) {
				sameSourceDifferentRangeReadsAfterContextReduction += 1;
			}
		}
		if (read.exact) lastExact.set(read.exact, read.entryIndex);
		if (read.source) lastSource.set(read.source, { entryIndex: read.entryIndex, exact: read.exact });
	}
	const unattributedCandidates = exactRepeatReadsAfterContextReduction
		+ sameSourceDifferentRangeReadsAfterContextReduction;
	const historyCompressionGainTokens = compressResults
		.filter((result) => result.committed)
		.reduce((sum, result) => sum + (result.netGain ?? 0), 0);

	return {
		version: 1,
		entries: entries.length,
		usage,
		tools: {
			calls: toolCalls,
			results: toolResults,
			errors: toolErrors,
			callsByName: Object.fromEntries(Object.entries(callsByName).sort(([a], [b]) => a.localeCompare(b))),
			resultsByName: Object.fromEntries(Object.entries(resultsByName).sort(([a], [b]) => a.localeCompare(b))),
		},
		dcp: {
			blocks,
			compressResults,
			totalProtectedFragmentChars: blocks.reduce((sum, block) => sum + block.protectedFragmentChars, 0),
			manualSummaryDelegation,
			...(continuityProjection ? { continuityProjection } : {}),
			...(preCompressionMessages.length > 0
				? { carrierProjection: measureDcpCarrierOverhead(preCompressionMessages) }
				: {}),
		},
		accounting: {
			historyCompressionGainTokens,
			recoveryTax: {
				exactRepeatReadsAfterContextReduction,
				sameSourceDifferentRangeReadsAfterContextReduction,
				unattributedCandidates,
				// Intent is not inferable from tool arguments alone. Keep candidates
				// unattributed rather than automatically labeling verification as tax.
				likelyRecoveryTaxReads: 0,
			},
		},
	};
}

export function analyzeSessionFile(
	filePath: string,
	options: { dcpConfig?: DcpConfig } = {},
): SessionTokenEfficiencyReport {
	return analyzeSessionJsonlText(readFileSync(filePath, "utf8"), options);
}

export function renderSessionEfficiencySummary(report: SessionTokenEfficiencyReport): string {
	const latestCompress = report.dcp.compressResults.at(-1);
	return [
		`entries=${report.entries} assistantCalls=${report.usage.assistantCalls}`,
		`promptTokens=${report.usage.promptTokenOccurrences} input=${report.usage.input} cacheRead=${report.usage.cacheRead} output=${report.usage.output}`,
		`toolCalls=${report.tools.calls} toolResults=${report.tools.results} errors=${report.tools.errors}`,
		`dcpBlocks=${report.dcp.blocks.length} protectedChars=${report.dcp.totalProtectedFragmentChars}`,
		...(report.dcp.continuityProjection ? [
			`continuityProtectedChars=${report.dcp.continuityProjection.baselineProtectedChars}->${report.dcp.continuityProjection.projectedProtectedChars} reduction=${report.dcp.continuityProjection.reductionPercent.toFixed(1)}%`,
			`continuityActiveSummaryTokens=${report.dcp.continuityProjection.activeSummaryBaselineTokens}->${report.dcp.continuityProjection.activeSummaryProjectedTokens} projectedNetGain=${report.dcp.continuityProjection.projectedLatestCompressionNetGain ?? 0}`,
		] : []),
		...(report.dcp.carrierProjection ? [
			`carrierOverhead=${report.dcp.carrierProjection.legacyEquivalentOverheadEstimatedTokens}->${report.dcp.carrierProjection.overheadEstimatedTokens} tokens (${report.dcp.carrierProjection.reductionVsLegacyPercent.toFixed(1)}% reduction) across ${report.dcp.carrierProjection.carriers} carriers`,
		] : []),
		`manualSummaryOpportunity calls=${report.dcp.manualSummaryDelegation.compressCalls} parentOutput=${report.dcp.manualSummaryDelegation.compressAssistantOutputTokens} summaryChars=${report.dcp.manualSummaryDelegation.summaryArgumentChars} summaryTokens=${report.dcp.manualSummaryDelegation.summaryArgumentEstimatedTokens} argumentReduction=${report.dcp.manualSummaryDelegation.estimatedArgumentTokenReduction}`,
		`compressGain=${latestCompress?.netGain ?? 0} projectedBefore=${latestCompress?.projectedBeforeTokens ?? 0} projectedAfter=${latestCompress?.projectedAfterTokens ?? 0}`,
		`accounting historyCompressionGainTokens=${report.accounting.historyCompressionGainTokens} recoveryCandidates=${report.accounting.recoveryTax.unattributedCandidates} likelyRecoveryTaxReads=${report.accounting.recoveryTax.likelyRecoveryTaxReads}`,
	].join("\n");
}

export function loadLocalDcpConfigForEfficiencyReplay(): DcpConfig {
	return loadConfig();
}
