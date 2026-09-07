import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	CONTEXT_GATEWAY_ENFORCE_UNAVAILABLE,
	loadContextGatewayConfig,
} from "./config.js";
import { ContextGatewayTelemetry } from "./telemetry.js";
import type {
	ContextGatewayEffectiveMode,
	ContextGatewayMode,
	ContextGatewayResolvedConfig,
	ContextGatewayRuntimeState,
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
		`Observed results=${telemetry.results}, errors=${telemetry.errors}, upstreamTruncated=${telemetry.upstreamTruncatedResults}, overBudget=${telemetry.overBudgetResults}, unbound results=${telemetry.unboundResults}.`,
		`Repeat candidates=${telemetry.repeatCandidateCount}, retrieval calls=${telemetry.retrievalCalls}.`,
		`Native policy results=${telemetry.nativePolicy.results}, refusals=${telemetry.nativePolicy.refusals}, full overrides=${telemetry.nativePolicy.fullOverrides}.`,
		`Observed contentBytes=${telemetry.contentBytes}, textBytes=${telemetry.textBytes}, detailsBytes=${telemetry.detailsBytes}, potentialBytesOverBudget=${telemetry.potentialBytesOverBudget}.`,
	].join("\n");
}

function formatDoctor(runtime: RegisteredContextGateway): string {
	const lines = [
		`Context Gateway doctor: requested=${runtime.requestedMode}, effective=${runtime.effectiveMode}.`,
		"Capture: read=limited; bash=limited+temp-output; repo_*=suite-adapter-not-wired; ast_grep=suite-adapter-not-wired.",
		"External paths: MCP=current Pix adapter unsupported; direct parent browser capture=unsupported.",
		"Storage: disabled; no durable archive, index, quota reservation, or retrieval tools are active.",
	];
	if (runtime.requestedMode === "enforce") {
		lines.push("BLOCKED: enforce is unavailable in P01; effective mode is off.");
	}
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
	let effectiveMode: ContextGatewayEffectiveMode = requestedMode === "enforce" ? "off" : requestedMode;
	const inFlightToolCalls = new Set<string>();

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
			if (mode === "enforce") {
				return { ok: false, message: CONTEXT_GATEWAY_ENFORCE_UNAVAILABLE };
			}
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
		if (typeof event.toolCallId === "string") inFlightToolCalls.add(event.toolCallId);
		if (effectiveMode === "observe") telemetry.recordToolCall(event);
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		try {
			if (effectiveMode === "observe") telemetry.recordToolResult(event, config.budgets.maxResultBytes);
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
		description: "Show Context Gateway status/doctor output or change the runtime-only off/observe mode.",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);
			const action = (args[0] ?? "status").toLowerCase();
			if (action === "status") {
				notify(ctx, formatStatus(runtime));
				return;
			}
			if (action === "doctor") {
				notify(ctx, formatDoctor(runtime), runtime.requestedMode === "enforce" ? "warning" : "info");
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
