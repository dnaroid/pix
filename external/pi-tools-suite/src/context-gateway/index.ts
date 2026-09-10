import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyShellCommand, type ShellCommandClassification } from "../shell-command-policy.js";

import {
	contextGatewayBudgetForClass,
	loadContextGatewayConfig,
} from "./config.js";
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
}

export interface RegisteredContextGateway extends ContextGatewayRuntimeState {
	setRuntimeMode(mode: ContextGatewayMode): { ok: boolean; message: string };
}

function formatStatus(runtime: RegisteredContextGateway): string {
	const telemetry = runtime.telemetry.snapshot();
	return [
		`Context Gateway requested=${runtime.requestedMode}, effective=${runtime.effectiveMode}.`,
		`Observed results=${telemetry.results}, errors=${telemetry.errors}, upstreamTruncated=${telemetry.upstreamTruncatedResults}, overBudget=${telemetry.overBudgetResults}, enforced=${telemetry.enforcedResults}, unbound results=${telemetry.unboundResults}.`,
		`Repeat exact reads=${telemetry.repeatCandidateCount}, same-source different-range reads=${telemetry.sameSourceDifferentRangeCount}, retrieval calls=${telemetry.retrievalCalls}.`,
		`Native policy results=${telemetry.nativePolicy.results}, refusals=${telemetry.nativePolicy.refusals}, full overrides=${telemetry.nativePolicy.fullOverrides}.`,
		`Source contentBytes=${telemetry.contentBytes}, deliveredContentBytes=${telemetry.deliveredContentBytes}, actualBytesSaved=${telemetry.actualBytesSaved}, potentialBytesOverBudget=${telemetry.potentialBytesOverBudget}, detailsBytes=${telemetry.detailsBytes}.`,
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
	let requestedMode = config.mode;
	let effectiveMode: ContextGatewayEffectiveMode = requestedMode;
	type InFlight = { toolClass: ContextGatewayToolClass; shell: ShellCommandClassification };
	const inFlightToolCalls = new Map<string, InFlight>();

	const resetRuntimeTelemetry = (): void => {
		inFlightToolCalls.clear();
		telemetry.reset();
	};

	const runtime: RegisteredContextGateway = {
		get requestedMode() { return requestedMode; },
		get effectiveMode() { return effectiveMode; },
		config,
		telemetry,
		setRuntimeMode(mode) {
			if (mode !== effectiveMode && inFlightToolCalls.size > 0) {
				return {
					ok: false,
					message: `Context Gateway mode change requires a safe boundary; ${inFlightToolCalls.size} tool call(s) are still in flight.`,
				};
			}
			requestedMode = mode;
			effectiveMode = mode;
			telemetry.clearTransientBindings();
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
		if (effectiveMode === "observe" || effectiveMode === "enforce") telemetry.recordToolCall(event);
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
			telemetry.recordToolResult(event, config.budgets, {
				maxInlineBytes: config.budgets.maxInlineBytes,
				...(enforcement ? {
					delivery: {
						representation: enforcement.representation,
						contentBytes: enforcement.contentBytes,
						textBytes: enforcement.textBytes,
					},
				} : {}),
			});
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

	pi.on("session_start", async () => {
		resetRuntimeTelemetry();
		return undefined;
	});

	pi.on("session_tree", async () => {
		resetRuntimeTelemetry();
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		resetRuntimeTelemetry();
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
export { loadContextGatewayConfig } from "./config.js";
export { normalizeRedundantTruncationMetadata } from "./metadata-normalization.js";
export { STORELESS_CAPABILITIES, storelessCapability } from "./storeless-capabilities.js";
export { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "./test-output-parser.js";
export { ContextGatewayTelemetry, classifyContextGatewayTool, classifyRoleParts, observeToolResult } from "./telemetry.js";
export type * from "./types.js";
