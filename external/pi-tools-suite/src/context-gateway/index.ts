import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { classifyShellCommand, type ShellCommandClassification } from "../shell-command-policy.js";

import {
	contextGatewayAccountingLogDrain,
	contextGatewayAccountingLogEnabled,
	writeContextGatewayAccountingLog,
} from "./accounting-log.js";
import {
	contextGatewayBudgetForClass,
	loadContextGatewayConfig,
} from "./config.js";
import { ContextGatewayEfficiencyTracker } from "./efficiency.js";
import { planContextGatewayEnforcement } from "./enforcement.js";
import { classifyContextGatewayTool, ContextGatewayTelemetry } from "./telemetry.js";
import type {
	ContextGatewayEffectiveMode,
	ContextGatewayMode,
	ContextGatewayResolvedConfig,
	ContextGatewayRuntimeState,
	ContextGatewayToolClass,
} from "./types.js";

export interface RegisterContextGatewayOptions {
	loadConfig?: () => ContextGatewayResolvedConfig;
	telemetry?: ContextGatewayTelemetry;
	efficiency?: ContextGatewayEfficiencyTracker;
}

export interface RegisteredContextGateway extends ContextGatewayRuntimeState {
	readonly efficiency: ContextGatewayEfficiencyTracker;
	setRuntimeMode(mode: ContextGatewayMode): { ok: boolean; message: string };
}

function formatStatus(runtime: RegisteredContextGateway): string {
	const telemetry = runtime.telemetry.snapshot();
	const efficiency = runtime.efficiency.snapshot();
	return [
		`Context Gateway requested=${runtime.requestedMode}, effective=${runtime.effectiveMode}.`,
		`Observed results=${telemetry.results}, errors=${telemetry.errors}, upstreamTruncated=${telemetry.upstreamTruncatedResults}, overBudget=${telemetry.overBudgetResults}, enforced=${telemetry.enforcedResults}, unbound results=${telemetry.unboundResults}.`,
		`Repeat exact reads=${telemetry.repeatCandidateCount}, same-source different-range reads=${telemetry.sameSourceDifferentRangeCount}, retrieval calls=${telemetry.retrievalCalls}.`,
		`Native policy results=${telemetry.nativePolicy.results}, refusals=${telemetry.nativePolicy.refusals}, full overrides=${telemetry.nativePolicy.fullOverrides}.`,
		`Source contentBytes=${telemetry.contentBytes}, deliveredContentBytes=${telemetry.deliveredContentBytes}, actualBytesSaved=${telemetry.actualBytesSaved}, potentialBytesOverBudget=${telemetry.potentialBytesOverBudget}, detailsBytes=${telemetry.detailsBytes}.`,
		`Efficiency gross≈${efficiency.grossEstimatedTokensSaved} tokens/${efficiency.grossBytesSaved} bytes, retrieval tax≈${efficiency.retrievalEstimatedTokens} tokens/${efficiency.retrievalBytes} bytes, conservative net≈${efficiency.conservativeNetEstimatedTokens} tokens/${efficiency.conservativeNetBytes} bytes.`,
		`Provider attempts=${efficiency.providerAttempts}, completions=${efficiency.providerCompletions}, input=${efficiency.providerInputTokens}, cacheRead=${efficiency.providerCacheReadTokens}, cacheWrite=${efficiency.providerCacheWriteTokens}, output=${efficiency.providerOutputTokens}, total=${efficiency.providerTotalTokens}.`,
	].join("\n");
}

function formatDoctor(runtime: RegisteredContextGateway): string {
	const lines = [
		`Context Gateway doctor: requested=${runtime.requestedMode}, effective=${runtime.effectiveMode}.`,
		"Budgets: read=maxExactReadBytes; repo search/AST/structure=maxSearchBytes; other results=maxResultBytes; compact inline view=maxInlineBytes.",
		"Enforce: recognised complete simple test/build output=bounded parser compact; over-budget web_search/web_fetch with structured raw details=bounded recoverable compact; unsupported/unsafe results remain passthrough.",
		"Read: full passthrough even when over budget; exact recovery/archive is not wired, so irreversible read truncation is disabled.",
		"Repo tools: producer-native compact is supported with repoDiscovery.profile=native-compact; Gateway never post-hoc slices repo output.",
		"External paths: MCP=current Pix adapter unsupported; direct parent browser capture=unsupported.",
		"Storage: disabled; no durable archive, index, quota reservation, or retrieval tools are active.",
		`Accounting log: ${contextGatewayAccountingLogEnabled(runtime.config) ? "enabled" : "disabled"}; scalar-only JSONL with bounded rotation, no result bodies, paths, or tool arguments.`,
	];
	for (const issue of runtime.config.issues) lines.push(`Config issue: ${issue}`);
	return lines.join("\n");
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

export function registerContextGateway(
	pi: ExtensionAPI,
	options: RegisterContextGatewayOptions = {},
): RegisteredContextGateway {
	const config = (options.loadConfig ?? (() => loadContextGatewayConfig()))();
	const telemetry = options.telemetry ?? new ContextGatewayTelemetry();
	const efficiency = options.efficiency ?? new ContextGatewayEfficiencyTracker();
	let requestedMode = config.mode;
	let effectiveMode: ContextGatewayEffectiveMode = requestedMode;
	type InFlight = { toolClass: ContextGatewayToolClass; shell: ShellCommandClassification };
	const inFlightToolCalls = new Map<string, InFlight>();
	const runtimeId = randomUUID();
	let accountingEpoch = 0;
	let accountingEpochStartedAt = Date.now();
	let accountingEpochActive = false;

	const writeAccounting = (event: string, details: Record<string, unknown> = {}): void => {
		writeContextGatewayAccountingLog(config, event, {
			runtimeId,
			sessionEpoch: accountingEpoch,
			mode: effectiveMode,
			...details,
		});
	};

	const accountingSummary = (): Record<string, unknown> => ({
		durationMs: Math.max(0, Date.now() - accountingEpochStartedAt),
		totals: efficiency.snapshot(),
	});

	const finalizeAccountingEpoch = (reason: string): void => {
		if (!accountingEpochActive || effectiveMode === "off") return;
		writeAccounting("session.summary", { reason, ...accountingSummary() });
		accountingEpochActive = false;
	};

	const beginAccountingEpoch = (reason: string): void => {
		efficiency.reset();
		accountingEpoch += 1;
		accountingEpochStartedAt = Date.now();
		accountingEpochActive = effectiveMode !== "off";
		if (accountingEpochActive) writeAccounting("session.start", { reason });
	};

	const resetRuntimeTelemetry = (): void => {
		inFlightToolCalls.clear();
		telemetry.reset();
		efficiency.clearTransientBindings();
	};

	const runtime: RegisteredContextGateway = {
		get requestedMode() { return requestedMode; },
		get effectiveMode() { return effectiveMode; },
		config,
		telemetry,
		efficiency,
		setRuntimeMode(mode) {
			if (mode !== effectiveMode && inFlightToolCalls.size > 0) {
				return {
					ok: false,
					message: `Context Gateway mode change requires a safe boundary; ${inFlightToolCalls.size} tool call(s) are still in flight.`,
				};
			}
			const previousMode = effectiveMode;
			if (previousMode !== mode) finalizeAccountingEpoch("mode-change");
			requestedMode = mode;
			effectiveMode = mode;
			telemetry.clearTransientBindings();
			efficiency.clearTransientBindings();
			if (previousMode !== mode) {
				writeContextGatewayAccountingLog(config, "mode.change", {
					runtimeId,
					sessionEpoch: accountingEpoch,
					from: previousMode,
					to: mode,
				});
				beginAccountingEpoch("mode-change");
			}
			return { ok: true, message: `Context Gateway runtime mode set to ${mode}; config was not changed.` };
		},
	};

	pi.on("tool_call", async (event) => {
		if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
			const toolClass = classifyContextGatewayTool(event.toolName);
			inFlightToolCalls.set(event.toolCallId, {
				toolClass,
				shell: toolClass === "shell"
					? classifyShellCommand(event.input)
					: { scope: "unknown", kind: "unknown" },
			});
		}
		if (effectiveMode === "observe" || effectiveMode === "enforce") {
			telemetry.recordToolCall(event);
			const accountingCall = efficiency.recordToolCall(event);
			if (accountingCall) writeAccounting("tool.call", { ...accountingCall });
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		try {
			if (effectiveMode === "off") return undefined;
			const binding = typeof event.toolCallId === "string"
				? inFlightToolCalls.get(event.toolCallId)
				: undefined;
			const classBudget = binding
				? contextGatewayBudgetForClass(binding.toolClass, config.budgets)
				: config.budgets.maxResultBytes;
			const enforcement = effectiveMode === "enforce" && binding
				? planContextGatewayEnforcement({
					event,
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
					toolClass: binding.toolClass,
					shell: binding.shell,
					budgetBytes: classBudget,
					maxInlineBytes: Math.min(
						config.budgets.maxInlineBytes,
						classBudget,
					),
				})
				: undefined;
			const observation = telemetry.recordToolResult(event, config.budgets, {
				maxInlineBytes: config.budgets.maxInlineBytes,
				...(enforcement ? {
					delivery: {
						representation: enforcement.representation,
						contentBytes: enforcement.contentBytes,
						textBytes: enforcement.textBytes,
					},
				} : {}),
			});
			const accountingResult = efficiency.recordToolResult(
				event,
				observation,
				enforcement?.content ?? event.content,
			);
			if (accountingResult) {
				const efficiencySnapshot = efficiency.snapshot();
				writeAccounting("tool.result", {
					...accountingResult,
					cumulative: {
						grossBytesSaved: efficiencySnapshot.grossBytesSaved,
						grossEstimatedTokensSaved: efficiencySnapshot.grossEstimatedTokensSaved,
						retrievalBytes: efficiencySnapshot.retrievalBytes,
						retrievalEstimatedTokens: efficiencySnapshot.retrievalEstimatedTokens,
						conservativeNetBytes: efficiencySnapshot.conservativeNetBytes,
						conservativeNetEstimatedTokens: efficiencySnapshot.conservativeNetEstimatedTokens,
					},
				});
			}
			if (enforcement && enforcement.representation !== "passthrough") {
				const originalDetails = event.details && typeof event.details === "object" && !Array.isArray(event.details)
					? event.details as Record<string, unknown>
					: {};
				return {
					content: enforcement.content as any,
					details: {
						...originalDetails,
						contextGateway: {
							version: 1,
							representation: enforcement.representation,
							sourceContentBytes: enforcement.sourceContentBytes,
							deliveredContentBytes: enforcement.contentBytes,
						},
					},
				};
			}
		} finally {
			if (typeof event.toolCallId === "string") inFlightToolCalls.delete(event.toolCallId);
		}
		return undefined;
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (effectiveMode === "off") return undefined;
		const attempt = efficiency.recordProviderAttempt();
		const model = (ctx as any)?.model;
		writeAccounting("provider.request", {
			attempt,
			provider: typeof model?.provider === "string" ? model.provider : undefined,
			model: typeof model?.id === "string" ? model.id : undefined,
		});
		return undefined;
	});

	pi.on("message_end", async (event) => {
		if (effectiveMode === "off" || event.message?.role !== "assistant") return;
		const completion = efficiency.recordProviderCompletion(event.message as any);
		const snapshot = efficiency.snapshot();
		writeAccounting("provider.completion", {
			...completion,
			cumulative: {
				providerInputTokens: snapshot.providerInputTokens,
				providerOutputTokens: snapshot.providerOutputTokens,
				providerCacheReadTokens: snapshot.providerCacheReadTokens,
				providerCacheWriteTokens: snapshot.providerCacheWriteTokens,
				providerTotalTokens: snapshot.providerTotalTokens,
				providerCost: snapshot.providerCost,
				grossEstimatedTokensSaved: snapshot.grossEstimatedTokensSaved,
				retrievalEstimatedTokens: snapshot.retrievalEstimatedTokens,
				conservativeNetEstimatedTokens: snapshot.conservativeNetEstimatedTokens,
			},
		});
	});

	pi.on("session_start", async () => {
		finalizeAccountingEpoch("session-start-reset");
		resetRuntimeTelemetry();
		beginAccountingEpoch("session-start");
		return undefined;
	});

	pi.on("session_tree", async () => {
		finalizeAccountingEpoch("session-tree");
		resetRuntimeTelemetry();
		beginAccountingEpoch("session-tree");
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		finalizeAccountingEpoch("session-shutdown");
		resetRuntimeTelemetry();
		efficiency.reset();
		accountingEpochActive = false;
		await contextGatewayAccountingLogDrain();
		return undefined;
	});

	pi.registerCommand("context-gateway", {
		description: "Show Context Gateway status/doctor output or change runtime-only off/observe/enforce mode.",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);
			const action = (args[0] ?? "status").toLowerCase();
			if (action === "status") {
				notify(ctx, formatStatus(runtime));
				return;
			}
			if (action === "doctor") {
				notify(ctx, formatDoctor(runtime), runtime.config.issues.length > 0 ? "warning" : "info");
				return;
			}
			if (action === "mode") {
				const mode = args[1]?.toLowerCase() as ContextGatewayMode | undefined;
				if (mode !== "off" && mode !== "observe" && mode !== "enforce") {
					notify(ctx, "Usage: /context-gateway mode off|observe|enforce", "error");
					return;
				}
				const result = runtime.setRuntimeMode(mode);
				notify(ctx, result.message, result.ok ? "info" : "error");
				return;
			}
			notify(ctx, "Usage: /context-gateway status|doctor|mode off|observe|enforce", "error");
		},
	});

	return runtime;
}

export default function contextGatewayExtension(pi: ExtensionAPI): void {
	registerContextGateway(pi);
}

export { accountContextGatewayParts } from "./accounting.js";
export {
	contextGatewayAccountingLogDrain,
	contextGatewayAccountingLogEnabled,
	contextGatewayAccountingLogMaxBackups,
	contextGatewayAccountingLogMaxBytes,
	contextGatewayAccountingLogPath,
	writeContextGatewayAccountingLog,
} from "./accounting-log.js";
export { loadContextGatewayConfig } from "./config.js";
export { ContextGatewayEfficiencyTracker, estimateContextGatewayTokens } from "./efficiency.js";
export { normalizeRedundantTruncationMetadata } from "./metadata-normalization.js";
export { STORELESS_CAPABILITIES, storelessCapability } from "./storeless-capabilities.js";
export { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "./test-output-parser.js";
export { ContextGatewayTelemetry, classifyContextGatewayTool, classifyRoleParts, observeToolResult } from "./telemetry.js";
export type * from "./types.js";
