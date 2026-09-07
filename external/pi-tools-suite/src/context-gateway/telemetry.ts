import { createHash } from "node:crypto";

import { accountContextGatewayParts } from "./accounting.js";
import { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "./test-output-parser.js";
import type {
	ContextGatewayClassTelemetry,
	ContextGatewayNativePolicyReason,
	ContextGatewayNativePolicyTelemetry,
	ContextGatewayObservation,
	ContextGatewayTelemetrySnapshot,
	ContextGatewayTestOutputTelemetry,
	ContextGatewayToolClass,
} from "./types.js";

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

const NATIVE_POLICY_REASONS = new Set<ContextGatewayNativePolicyReason>([
	"invalid-wrapper-budget",
	"unknown-flag",
	"missing-flag-value",
	"duplicate-flag",
	"invalid-flag-value",
	"conflicting-flags",
	"compact-limit-exceeded",
	"full-limit-exceeded",
]);

type CallBinding = {
	toolClass: ContextGatewayToolClass;
	inputFingerprint?: string;
	shellCommandScope?: "simple" | "compound" | "unknown";
};

export interface ContextGatewayRolePartBytes {
	userTextBytes: number;
	assistantProseBytes: number;
	assistantThinkingBytes: number;
	assistantToolCallArgumentBytes: number;
	toolResultTextBytes: number;
	controlOrUnknownTextBytes: number;
	metadataDetailsBytes: number;
	messageWrapperBytes: number;
	unknownParts: number;
}

function emptyCounters(): ContextGatewayClassTelemetry {
	return {
		results: 0,
		errors: 0,
		contentBytes: 0,
		textBytes: 0,
		imageBytes: 0,
		detailsBytes: 0,
		upstreamTruncatedResults: 0,
		overBudgetResults: 0,
		potentialBytesOverBudget: 0,
	};
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			result[key] = stableValue((value as Record<string, unknown>)[key]);
		}
		return result;
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

function inputFingerprint(toolName: string, input: unknown): string {
	let encoded = "";
	try {
		encoded = JSON.stringify(stableValue(input)) ?? "";
	} catch {
		encoded = "[unserializable]";
	}
	return createHash("sha256").update(`${toolName}\u0000${encoded}`).digest("hex");
}

function shellCommandScope(input: unknown): "simple" | "compound" | "unknown" {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "unknown";
	const command = (input as Record<string, unknown>).command;
	if (typeof command !== "string" || command.trim().length === 0) return "unknown";
	// Conservative only: false positives merely keep passthrough. This does not
	// parse, rewrite, approve, or execute the shell command.
	return /[\r\n;|`]|&&|\$\(/.test(command) ? "compound" : "simple";
}

function byteLengthJson(value: unknown): number {
	if (value === undefined) return 0;
	try {
		const seen = new WeakSet<object>();
		const json = JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") return item.toString();
			if (item !== null && typeof item === "object") {
				if (seen.has(item)) return "[Circular]";
				seen.add(item);
			}
			return item;
		});
		return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
	} catch {
		return 0;
	}
}

function contentSizes(content: unknown): { textBytes: number; imageBytes: number; contentBytes: number } {
	let textBytes = 0;
	let imageBytes = 0;
	if (Array.isArray(content)) {
		for (const raw of content) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const block = raw as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") {
				textBytes += Buffer.byteLength(block.text, "utf8");
			} else if (block.type === "image" && typeof block.data === "string") {
				imageBytes += Math.floor((block.data.length * 3) / 4);
			}
		}
	}
	return { textBytes, imageBytes, contentBytes: byteLengthJson(content) };
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const raw of content) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const block = raw as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

function emptyTestOutputTelemetry(): ContextGatewayTestOutputTelemetry {
	return {
		parserVersion: 1,
		results: 0,
		scanLimitedResults: 0,
		compactCandidates: 0,
		passthroughRecommended: 0,
		byClassification: { recognised: 0, partial: 0, unrecognised: 0 },
		byFormat: { "bun-test": 0, tap: 0, typescript: 0, mixed: 0, unknown: 0 },
	};
}

function isTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object" || Array.isArray(details)) return false;
	const truncation = (details as Record<string, unknown>).truncation;
	return Boolean(
		truncation
		&& typeof truncation === "object"
		&& !Array.isArray(truncation)
		&& (truncation as Record<string, unknown>).truncated === true,
	);
}

function nativePolicyFromResult(event: ToolResultLike): {
	refused: boolean;
	outputMode: "compact" | "full";
	reason?: ContextGatewayNativePolicyReason;
} | undefined {
	const toolName = typeof event.toolName === "string" ? event.toolName.trim().toLowerCase() : "";
	if (!toolName.startsWith("repo_")) return undefined;
	if (!event.details || typeof event.details !== "object" || Array.isArray(event.details)) return undefined;
	const candidate = (event.details as Record<string, unknown>).nativePolicy;
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
	const policy = candidate as Record<string, unknown>;
	if (policy.version !== 1 || policy.profile !== "native-compact") return undefined;
	if (policy.outputMode !== "compact" && policy.outputMode !== "full") return undefined;
	if (typeof policy.refused !== "boolean") return undefined;
	const rawReason = typeof policy.reason === "string" ? policy.reason : undefined;
	const reason = rawReason
		? (NATIVE_POLICY_REASONS.has(rawReason as ContextGatewayNativePolicyReason)
			? rawReason as ContextGatewayNativePolicyReason
			: "unknown")
		: undefined;
	return { refused: policy.refused, outputMode: policy.outputMode, ...(reason ? { reason } : {}) };
}

export function classifyContextGatewayTool(toolName: string): ContextGatewayToolClass {
	const normalized = toolName.trim().toLowerCase();
	if (normalized === "read") return "code-read";
	if (["bash", "shell", "powershell"].includes(normalized)) return "shell";
	if (normalized === "repo_search") return "repo-search";
	if (normalized === "repo_ast") return "repo-ast";
	if (normalized === "repo_structure") return "repo-structure";
	if (normalized === "ast_grep") return "ast-grep";
	if (["write", "edit", "apply_patch", "ast_apply", "multiedit"].includes(normalized)) return "mutation";
	if (["web_search", "web_fetch"].includes(normalized)) return "web";
	if (normalized === "subagents" || normalized.startsWith("async_subagents_")) return "subagent";
	return "other";
}

export function observeToolResult(
	event: ToolResultLike,
	maxResultBytes: number,
	options: { toolClass?: ContextGatewayToolClass; shellCommandScope?: "simple" | "compound" | "unknown" } = {},
): ContextGatewayObservation {
	const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
	const sizes = contentSizes(event.content);
	const detailsBytes = byteLengthJson(event.details);
	const potentialBytesOverBudget = Math.max(0, sizes.contentBytes - maxResultBytes);
	const toolClass = options.toolClass ?? classifyContextGatewayTool(toolName);
	const completeness = isTruncated(event.details) ? "upstream-truncated" : "unknown";
	const observation: ContextGatewayObservation = {
		version: 1,
		toolClass,
		outcome: event.isError === true ? "error" : "success",
		source: {
			kind: "tool-result-boundary",
			completeness,
			contentBytes: sizes.contentBytes,
			textBytes: sizes.textBytes,
			imageBytes: sizes.imageBytes,
			detailsBytes,
		},
		view: { kind: "text-content", textBytes: sizes.textBytes },
		delivery: {
			representation: "passthrough",
			contentBytes: sizes.contentBytes,
			textBytes: sizes.textBytes,
		},
		overBudget: sizes.contentBytes > maxResultBytes,
		potentialBytesOverBudget,
	};
	if (toolClass === "shell") {
		const parsed = parseTestBuildOutput({
			text: contentText(event.content),
			hostOutcome: observation.outcome,
			upstreamTruncated: completeness === "upstream-truncated",
		});
		const commandScope = options.shellCommandScope ?? "unknown";
		const prospective = planProspectiveTestOutputDelivery(parsed, maxResultBytes, { commandScope });
		observation.testOutput = {
			parserVersion: 1,
			classification: parsed.classification,
			format: parsed.format,
			scanLimited: parsed.scanLimited,
			terminalSummarySeen: parsed.terminalSummarySeen,
			diagnosticCount: parsed.diagnostics.filter((entry) => entry.severity === "error").length,
			warningCount: parsed.diagnostics.filter((entry) => entry.severity === "warning").length,
			commandScope,
			prospectiveDecision: prospective.decision,
			prospectiveReason: prospective.reason,
		};
	}
	return observation;
}

export class ContextGatewayTelemetry {
	private totals = emptyCounters();
	private byClass: Partial<Record<ContextGatewayToolClass, ContextGatewayClassTelemetry>> = {};
	private bindings = new Map<string, CallBinding>();
	private seenInputFingerprints = new Set<string>();
	private unboundResults = 0;
	private repeatCandidateCount = 0;
	private retrievalCalls = 0;
	private nativePolicy: ContextGatewayNativePolicyTelemetry = {
		results: 0,
		refusals: 0,
		fullOverrides: 0,
		byReason: {},
	};
	private testOutput = emptyTestOutputTelemetry();
	private lastObservation: ContextGatewayObservation | undefined;

	recordToolCall(event: ToolCallLike): void {
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
		const normalizedToolName = event.toolName.trim().toLowerCase();
		if (normalizedToolName === "artifact_read" || normalizedToolName === "artifact_search") {
			this.retrievalCalls += 1;
		}
		const fingerprint = normalizedToolName === "read"
			? inputFingerprint(event.toolName, event.input)
			: undefined;
		if (fingerprint) {
			if (this.seenInputFingerprints.has(fingerprint)) this.repeatCandidateCount += 1;
			else this.seenInputFingerprints.add(fingerprint);
		}
		this.bindings.set(event.toolCallId, {
			toolClass: classifyContextGatewayTool(event.toolName),
			inputFingerprint: fingerprint,
			...(classifyContextGatewayTool(event.toolName) === "shell"
				? { shellCommandScope: shellCommandScope(event.input) }
				: {}),
		});
	}

	recordToolResult(event: ToolResultLike, maxResultBytes: number): ContextGatewayObservation {
		const binding = typeof event.toolCallId === "string" ? this.bindings.get(event.toolCallId) : undefined;
		const observation = observeToolResult(event, maxResultBytes, {
			...(binding ? { toolClass: binding.toolClass } : {}),
			...(binding?.shellCommandScope ? { shellCommandScope: binding.shellCommandScope } : {}),
		});
		if (typeof event.toolCallId !== "string" || !binding) {
			this.unboundResults += 1;
			// Lifecycle/reload can route a late final result to a runner that did not
			// observe the originating tool_call. Keep the diagnostic count, but do
			// not attribute its bytes/class/parser policy to the current session or
			// branch. `record()` remains the explicit API for standalone fixtures.
			return observation;
		}
		this.bindings.delete(event.toolCallId);
		this.aggregateObservation(event, observation);
		return observation;
	}

	pendingCallCount(): number {
		return this.bindings.size;
	}

	clearTransientBindings(): void {
		this.bindings.clear();
	}

	private aggregateObservation(event: ToolResultLike, observation: ContextGatewayObservation): void {
		this.lastObservation = observation;
		const nativePolicy = nativePolicyFromResult(event);
		if (nativePolicy) {
			this.nativePolicy.results += 1;
			if (nativePolicy.outputMode === "full") this.nativePolicy.fullOverrides += 1;
			if (nativePolicy.refused) {
				this.nativePolicy.refusals += 1;
				const reason = nativePolicy.reason ?? "unknown";
				this.nativePolicy.byReason[reason] = (this.nativePolicy.byReason[reason] ?? 0) + 1;
			}
		}
		if (observation.testOutput) {
			const parsed = observation.testOutput;
			this.testOutput.results += 1;
			if (parsed.scanLimited) this.testOutput.scanLimitedResults += 1;
			this.testOutput.byClassification[parsed.classification] += 1;
			this.testOutput.byFormat[parsed.format] += 1;
			if (parsed.prospectiveDecision === "compact-candidate") this.testOutput.compactCandidates += 1;
			else this.testOutput.passthroughRecommended += 1;
		}
		this.add(this.totals, observation);
		const classCounters = this.byClass[observation.toolClass] ?? emptyCounters();
		this.byClass[observation.toolClass] = classCounters;
		this.add(classCounters, observation);
	}

	/** Backward-compatible convenience for observation-only callers without a tool_call event. */
	record(event: ToolResultLike, maxResultBytes: number): ContextGatewayObservation {
		const observation = observeToolResult(event, maxResultBytes);
		this.aggregateObservation(event, observation);
		return observation;
	}

	reset(): void {
		this.totals = emptyCounters();
		this.byClass = {};
		this.bindings.clear();
		this.seenInputFingerprints.clear();
		this.unboundResults = 0;
		this.repeatCandidateCount = 0;
		this.retrievalCalls = 0;
		this.nativePolicy = { results: 0, refusals: 0, fullOverrides: 0, byReason: {} };
		this.testOutput = emptyTestOutputTelemetry();
		this.lastObservation = undefined;
	}

	snapshot(): ContextGatewayTelemetrySnapshot {
		return {
			version: 1,
			...this.totals,
			pendingCalls: this.bindings.size,
			unboundResults: this.unboundResults,
			repeatCandidateCount: this.repeatCandidateCount,
			retrievalCalls: this.retrievalCalls,
			nativePolicy: {
				...this.nativePolicy,
				byReason: { ...this.nativePolicy.byReason },
			},
			testOutput: {
				...this.testOutput,
				byClassification: { ...this.testOutput.byClassification },
				byFormat: { ...this.testOutput.byFormat },
			},
			byClass: Object.fromEntries(
				Object.entries(this.byClass).map(([key, value]) => [key, value ? { ...value } : value]),
			) as ContextGatewayTelemetrySnapshot["byClass"],
			...(this.lastObservation ? { lastObservation: structuredClone(this.lastObservation) } : {}),
		};
	}

	private add(target: ContextGatewayClassTelemetry, observation: ContextGatewayObservation): void {
		target.results += 1;
		if (observation.outcome === "error") target.errors += 1;
		target.contentBytes += observation.source.contentBytes;
		target.textBytes += observation.source.textBytes;
		target.imageBytes += observation.source.imageBytes;
		target.detailsBytes += observation.source.detailsBytes;
		if (observation.source.completeness === "upstream-truncated") target.upstreamTruncatedResults += 1;
		if (observation.overBudget) target.overBudgetResults += 1;
		target.potentialBytesOverBudget += observation.potentialBytesOverBudget;
	}
}

export function classifyRoleParts(messages: readonly unknown[]): ContextGatewayRolePartBytes {
	const accounting = accountContextGatewayParts(messages);
	return {
		userTextBytes: accounting.categories.userText.bytes,
		assistantProseBytes: accounting.categories.assistantProse.bytes,
		assistantThinkingBytes: accounting.categories.assistantThinking.bytes,
		assistantToolCallArgumentBytes: accounting.categories.assistantToolCallArguments.bytes,
		toolResultTextBytes: accounting.categories.toolResultText.bytes,
		controlOrUnknownTextBytes: accounting.categories.controlOrUnknownText.bytes,
		metadataDetailsBytes: accounting.metadataDetailsBytes,
		messageWrapperBytes: accounting.messageWrapperBytes,
		unknownParts: accounting.unknownParts,
	};
}
