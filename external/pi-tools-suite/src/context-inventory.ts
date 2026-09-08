import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	currentModelRef,
	filterSubagentConfigForParentModel,
	loadSubagentConfig,
} from "./async-subagents/lib.js";
import { publishRpcSessionState } from "./lib/rpc-session-state.js";

export const CONTEXT_INVENTORY_EVENT = "pi-tools-suite:context-inventory";

export interface ContextInventoryState {
	version: 1;
	reason?: "startup" | "reload" | "new" | "resume" | "fork" | "model_select";
	sessionId?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	tools: string[];
	skills: string[];
	agents?: string[];
}

export function createContextInventoryState(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getCommands">,
	ctx: Pick<ExtensionContext, "cwd" | "model" | "sessionManager">,
	reason?: ContextInventoryState["reason"],
): ContextInventoryState {
	const tools = unique(pi.getActiveTools());
	const skillsReadable = tools.includes("read") || tools.includes("bash");
	const skills = skillsReadable
		? unique(pi.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => command.name.replace(/^skill:/u, "")))
			.sort(compareText)
		: [];
	const model = currentModelRef(ctx.model);
	const thinking = typeof (ctx as { thinkingLevel?: unknown }).thinkingLevel === "string"
		? (ctx as { thinkingLevel?: string }).thinkingLevel?.trim() || undefined
		: undefined;
	const agents = tools.includes("subagents") ? effectiveAgentTypes(ctx.cwd, model) : [];
	const sessionId = safeSessionId(ctx.sessionManager);
	const sessionFile = safeSessionFile(ctx.sessionManager);
	return {
		version: 1,
		...(reason ? { reason } : {}),
		...(sessionId ? { sessionId } : {}),
		...(sessionFile ? { sessionFile } : {}),
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		tools,
		skills,
		...(agents === undefined ? {} : { agents }),
	};
}

export function publishContextInventoryState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason?: ContextInventoryState["reason"],
): void {
	const state = createContextInventoryState(pi, ctx, reason);
	pi.events?.emit?.(CONTEXT_INVENTORY_EVENT, state);
	publishRpcSessionState(ctx, CONTEXT_INVENTORY_EVENT, state);
}

function effectiveAgentTypes(cwd: string, model: string | undefined): string[] | undefined {
	try {
		const config = filterSubagentConfigForParentModel(loadSubagentConfig(cwd), model);
		return Object.keys(config.types).sort(compareText);
	} catch {
		return undefined;
	}
}

function safeSessionId(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
	try {
		const sessionId = sessionManager.getSessionId();
		return sessionId?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function safeSessionFile(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
	try {
		const sessionFile = sessionManager.getSessionFile();
		return sessionFile?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compareText(left: string, right: string): number {
	return left.localeCompare(right);
}
