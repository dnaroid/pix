import { readFileSync } from "node:fs";

import { DEFAULT_CONTEXT_GATEWAY_BUDGETS } from "../../src/context-gateway/config.js";
import { contextGatewayReadIdentity, ContextGatewayTelemetry } from "../../src/context-gateway/telemetry.js";
import type { ContextGatewayTelemetrySnapshot } from "../../src/context-gateway/types.js";
import { COMPRESS_TOOL_PARAMETERS } from "../../src/dcp/compress-tool.js";
import type { DcpConfig } from "../../src/dcp/config.js";
import { loadConfig } from "../../src/dcp/config.js";
import { injectMessageIds } from "../../src/dcp/pruner-message-ids.js";
import { estimateMessageTokens, estimateTokens, messageText } from "../../src/dcp/pruner-metadata.js";
import { toolRecordContinuity } from "../../src/dcp/protected-continuity.js";
import { createState } from "../../src/dcp/state.js";
import type { ToolRecord } from "../../src/dcp/state.js";
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
			byMode: Record<"none" | "digest" | "verbatim", number>;
			byReason: Record<string, { fragments: number; baselineChars: number; projectedChars: number }>;
		};
		carrierProjection?: DcpCarrierMeasurement;
	};
	contextGateway: ContextGatewayTelemetrySnapshot;
	accounting: {
		ingressAvoidedBytes: number;
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

function gatewayCompactionMarker(details: unknown): {
	sourceContentBytes: number;
	deliveredContentBytes: number;
} | undefined {
	if (!isRecord(details) || !isRecord(details.contextGateway)) return undefined;
	const marker = details.contextGateway;
	if (marker.version !== 1 || marker.representation !== "test-build-compact") return undefined;
	const sourceContentBytes = optionalFiniteNumber(marker.sourceContentBytes);
	const deliveredContentBytes = optionalFiniteNumber(marker.deliveredContentBytes);
	if (sourceContentBytes === undefined || deliveredContentBytes === undefined) return undefined;
	return { sourceContentBytes, deliveredContentBytes };
}

function countByName(target: Record<string, number>, name: unknown): void {
	const key = typeof name === "string" && name.length > 0 ? name : "unknown";
	target[key] = (target[key] ?? 0) + 1;
}

function textMeasure(text: string): TextMeasurement {
	return {
		chars: text.length,
		bytes: Buffer.byteLength(text, "utf8"),
		estimatedTokens: estimateTokens(text),
	};
}

function toolEnvelopeText(): string {
	return JSON.stringify({
		name: COMPRESS_TOOL_DESCRIPTION.name,
		label: COMPRESS_TOOL_DESCRIPTION.label,
		description: COMPRESS_TOOL_DESCRIPTION.description,
		promptSnippet: COMPRESS_TOOL_DESCRIPTION.promptSnippet,
		promptGuidelines: COMPRESS_TOOL_DESCRIPTION.promptGuidelines,
		parameters: COMPRESS_TOOL_PARAMETERS,
	});
}

export function measureDcpControlPlane(): DcpControlPlaneMeasurement {
	const guidelines = (COMPRESS_TOOL_DESCRIPTION.promptGuidelines ?? []).join("\n");
	const schema = JSON.stringify(COMPRESS_TOOL_PARAMETERS);
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
	const gateway = new ContextGatewayTelemetry();
	const preCompressionMessages: unknown[] = [];
	let firstCompressSeen = false;
	const calls = new Map<string, { toolName: string; input: Record<string, unknown>; entryIndex: number }>();
	const records = new Map<string, ToolRecord>();
	const readCalls: Array<{ entryIndex: number; exact?: string; source?: string }> = [];
	const contextReductionIndexes: number[] = [];
	let ingressAvoidedBytes = 0;

	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type === "custom" && entry.customType === "dcp-journal" && isRecord(entry.data)) {
			const blocks = entry.data.blocks;
			if (Array.isArray(blocks)) {
				for (const block of blocks) {
					if (!isRecord(block) || !Number.isSafeInteger(block.id)) continue;
					blocksById.set(block.id as number, block);
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
					calls.set(toolCallId, { toolName, input: rawInput, entryIndex });
					if (toolName.trim().toLowerCase() === "read") {
						const identity = contextGatewayReadIdentity(rawInput);
						readCalls.push({ entryIndex, ...identity });
					}
					gateway.recordToolCall({
						toolCallId,
						toolName,
						input: rawInput,
					});
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
		gateway.recordToolResult({
			toolCallId,
			toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
			content: message.content,
			details: message.details,
			isError: message.isError === true,
		}, DEFAULT_CONTEXT_GATEWAY_BUDGETS);
		const gatewayMarker = gatewayCompactionMarker(message.details);
		if (gatewayMarker) {
			contextReductionIndexes.push(entryIndex);
			ingressAvoidedBytes += Math.max(
				0,
				gatewayMarker.sourceContentBytes - gatewayMarker.deliveredContentBytes,
			);
		}

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
			return {
				id: block.id as number,
				active: block.active === true,
				summaryChars: typeof block.summary === "string" ? block.summary.length : 0,
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
		const byMode = { none: 0, digest: 0, verbatim: 0 };
		const byReason: Record<string, { fragments: number; baselineChars: number; projectedChars: number }> = {};
		for (const rawBlock of blocksById.values()) {
			const originalSummary = typeof rawBlock.summary === "string" ? rawBlock.summary : "";
			let projectedSummary = originalSummary;
			const fragments = Array.isArray(rawBlock.protectedFragments) ? rawBlock.protectedFragments : [];
			for (const fragment of fragments) {
				if (!isRecord(fragment) || typeof fragment.text !== "string") continue;
				baselineProtectedChars += fragment.text.length;
				const match = typeof fragment.origin === "string" ? /^tool:(.+)$/.exec(fragment.origin) : null;
				if (!match) {
					projectedProtectedChars += fragment.text.length;
					continue;
				}
				toolFragments += 1;
				const record = records.get(match[1]!);
				if (!record) {
					projectedProtectedChars += fragment.text.length;
					byMode.verbatim += 1;
					continue;
				}
				const decision = toolRecordContinuity(record, dcpConfig);
				byMode[decision.mode] += 1;
				const projectedChars = decision.text?.length ?? 0;
				projectedProtectedChars += projectedChars;
				if (originalSummary.includes(fragment.text)) {
					projectedSummary = projectedSummary.replace(fragment.text, decision.text ?? "");
				}
				const reason = byReason[decision.reason] ?? { fragments: 0, baselineChars: 0, projectedChars: 0 };
				reason.fragments += 1;
				reason.baselineChars += fragment.text.length;
				reason.projectedChars += projectedChars;
				byReason[decision.reason] = reason;
			}
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
			...(continuityProjection ? { continuityProjection } : {}),
			...(preCompressionMessages.length > 0
				? { carrierProjection: measureDcpCarrierOverhead(preCompressionMessages) }
				: {}),
		},
		contextGateway: gateway.snapshot(),
		accounting: {
			ingressAvoidedBytes,
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
		`compressGain=${latestCompress?.netGain ?? 0} projectedBefore=${latestCompress?.projectedBeforeTokens ?? 0} projectedAfter=${latestCompress?.projectedAfterTokens ?? 0}`,
		`gatewayResults=${report.contextGateway.results} gatewayOverBudget=${report.contextGateway.overBudgetResults} gatewayPotentialBytes=${report.contextGateway.potentialBytesOverBudget} repeatedReads=${report.contextGateway.repeatCandidateCount}`,
		`accounting ingressAvoidedBytes=${report.accounting.ingressAvoidedBytes} historyCompressionGainTokens=${report.accounting.historyCompressionGainTokens} recoveryCandidates=${report.accounting.recoveryTax.unattributedCandidates} likelyRecoveryTaxReads=${report.accounting.recoveryTax.likelyRecoveryTaxReads}`,
	].join("\n");
}

export function loadLocalDcpConfigForEfficiencyReplay(): DcpConfig {
	return loadConfig();
}
