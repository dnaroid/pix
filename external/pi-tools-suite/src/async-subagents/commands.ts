import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import { getAgentState, getRunState, stopAgents, validateBasename } from "./lib.js";
import { normalizeRunDir, resolveSubagentRunDir, scopeForContext } from "./core/lookup.js";
import { findRecordByChildSession, getRecord, listProjectRecords, listRunRecords, listScopeRunDirs } from "./core/store.js";
import { SUBAGENT_META_ENTRY, type SubagentMeta } from "./core/subagent-meta.js";
import { isTerminalAgentStatus } from "./core/notifications.js";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";
import { formatAgentStatus } from "./format.js";

interface CommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	waitForIdle?: () => Promise<void>;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionId?: () => string;
		getEntries?: () => ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
	};
	switchSession(sessionPath: string, options?: { withSession?: (ctx: CommandContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
}

type MessageSender = ExtensionAPI & {
	sendUserMessage?: (message: string) => void;
	sendMessage?: unknown;
};

export const ULTRAWORK_PROMPT = `Run ultrawork mode for the current objective.

Apply the delegation policy in the subagents tool description; this mode does not override it. An explicit user request for ultrawork authorizes scoped delegation, but an auto-classifier suggestion does not. Size, parallelism and token price alone are not implementation handoff grounds. Pick subagentType from the effective catalog: research for a named evidence/review question, implement-core for approved implementation handoffs, mechanical for sufficiently large prescribed transformations, verify for checks needing interpretation, ui-qa for real UI testing, and oracle for justified independent advice or architectural review. Prefer a matching project-local specialist. Keep decisions and integration in the parent.

Keep parent context lean: send bounded briefs, read compact results only when needed, and avoid duplicating the worker's investigation.`;

const HYPERPLAN_PROMPT = `Run hyperplan mode for the current objective.

Before implementation, use bounded research tasks to gather constraints and independently pressure-test the plan. Use oracle only when a strong second opinion is justified. Synthesize the evidence and objections in the parent before editing.`;

export function buildUltraworkPrompt(objective: string): string {
	const trimmed = objective.trim();
	return trimmed
		? `${ULTRAWORK_PROMPT}\n\nObjective:\n${trimmed}`
		: ULTRAWORK_PROMPT;
}

export function isUltraworkEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.ULTRAWORK;
	return typeof value === "string" && /^(1|true|yes|on|run)$/i.test(value.trim());
}

export function registerCommands(pi: ExtensionAPI): void {
	registerOrchestrationCommands(pi);

	pi.registerCommand("sub-status", {
		description: "Show status of async sub-agents in a run directory",
		handler: async (args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			let resolved: string;
			try {
				resolved = resolveSubagentRunDir(ctx, args.trim() || undefined);
			} catch {
				ctx.ui.notify("Usage: /sub-status [batch]", "warning");
				return;
			}
			const state = getRunState(resolved);

			if (state.agents.length === 0) {
				ctx.ui.notify(`No agents found in ${resolved}`, "warning");
				return;
			}

			const lines = state.agents.map((a) => `${formatAgentStatus(a.status)} ${a.id}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	registerSessionCommands(pi);

	pi.registerCommand("sub-stop", {
		description: "Stop running async sub-agents in a run directory",
		handler: async (args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			const parts = args.trim().split(/\s+/).filter(Boolean);
			const force = parts.includes("--force") || parts.includes("-f");
			const values = parts.filter((part) => part !== "--force" && part !== "-f");
			const runDirArg = values.shift();
			if (!runDirArg) {
				ctx.ui.notify("Usage: /sub-stop <batch> [agent-id ...] [--force]", "warning");
				return;
			}

			try {
				for (const id of values) validateBasename(id, "agentId");
				const resolved = normalizeRunDir(ctx.cwd, scopeForContext(ctx), runDirArg);
				const results = stopAgents(resolved, values.length ? values : undefined, { signal: force ? "SIGKILL" : "SIGTERM" });

				if (results.length === 0) {
					ctx.ui.notify(`No agents found in ${resolved}`, "warning");
					return;
				}

				const lines = results.map((result) => {
					if (result.stopped) return `[stopped] ${result.id}${result.pid ? ` (pid ${result.pid})` : ""}`;
					const suffix = result.error ? `error=${result.error}` : result.message;
					return `${formatAgentStatus(result.previousStatus)} ${result.id}: ${suffix}`;
				});
				ctx.ui.notify(lines.join("\n"), results.some((result) => result.error) ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function registerOrchestrationCommands(pi: MessageSender): void {
	pi.registerCommand("ultrawork", {
		description: "Start an oh-my-openagent-style parallel sub-agent workflow for the current objective",
		handler: async (args: string, ctx: CommandContext) => triggerOrchestrationPrompt(pi, ctx, args, ULTRAWORK_PROMPT, "ultrawork"),
	});

	pi.registerCommand("ulw", {
		description: "Alias for /ultrawork",
		handler: async (args: string, ctx: CommandContext) => triggerOrchestrationPrompt(pi, ctx, args, ULTRAWORK_PROMPT, "ultrawork"),
	});

	pi.registerCommand("hyperplan", {
		description: "Spawn hostile planning critics before implementation",
		handler: async (args: string, ctx: CommandContext) => triggerOrchestrationPrompt(pi, ctx, args, HYPERPLAN_PROMPT, "hyperplan"),
	});
}

async function triggerOrchestrationPrompt(
	pi: MessageSender,
	ctx: CommandContext,
	args: string,
	basePrompt: string,
	modeName: string,
): Promise<void> {
	await ctx.waitForIdle?.();
	const objective = args.trim();
	const prompt = modeName === "ultrawork"
		? buildUltraworkPrompt(objective)
		: objective
			? `${basePrompt}\n\nObjective:\n${objective}`
			: basePrompt;

	try {
		if (typeof pi.sendUserMessage === "function") {
			pi.sendUserMessage(prompt);
		} else if (typeof pi.sendMessage === "function") {
			pi.sendMessage({ customType: `async-subagents-${modeName}`, content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
		} else {
			ctx.ui.notify(`Cannot trigger /${modeName}: this Pi runtime does not expose sendUserMessage/sendMessage.`, "error");
			return;
		}
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}

	ctx.ui.notify(`Triggered /${modeName}.`, "info");
}

function registerSessionCommands(pi: ExtensionAPI): void {
	pi.registerCommand("sub-open", {
		description: "Switch to a persisted sub-agent session. Use /sub-back to return.",
		getArgumentCompletions: (prefix: string) => completeRunAndAgent(prefix, process.cwd()),
		handler: async (args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			try {
				const target = await chooseOpenTarget(args, ctx);
				if (!target) return;
				const state = getAgentState(target.runDir, target.agentId, { includeLineCounts: false });
				if (!state || !isTerminalAgentStatus(state.status)) {
					suiteDiagnostics.report("warn", "subagents", "session-open-active", ctx.cwd, {}, ctx);
					ctx.ui.notify("Wait for the sub-agent to finish before opening its session; only one process may write its transcript.", "warning");
					return;
				}

				const sessionFile = getRecord(target.runDir, target.agentId)?.childSessionFile ?? undefined;
				if (!sessionFile) {
					ctx.ui.notify(`No session file recorded for ${target.agentId}. The agent may not have produced a persisted session yet.`, "warning");
					return;
				}
				if (!fs.existsSync(sessionFile)) {
					ctx.ui.notify(`Sub-agent session is known but not flushed yet:\n${sessionFile}\nWait until the agent produces output or completes.`, "warning");
					return;
				}

				const currentSession = ctx.sessionManager.getSessionFile();
				if (!currentSession) {
					ctx.ui.notify("Current session is ephemeral; cannot open a sub-agent session with /sub-back return support.", "error");
					return;
				}

				returnSessions.set(sessionFile, currentSession);

				const runName = path.basename(target.runDir);
				const agentId = target.agentId;
				const result = await ctx.switchSession(sessionFile, {
					withSession: async (nextCtx) => {
						nextCtx.ui.notify(`Opened sub-agent ${agentId} from ${runName}. Use /sub-back to return.`, "info");
					},
				});
				if (result.cancelled) ctx.ui.notify("Sub-agent session switch cancelled.", "warning");
			} catch (error) {
				try {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} catch (notifyError) {
					// If switchSession succeeded before a later callback threw, the old ctx is stale.
					ignoreStaleExtensionContextError(notifyError);
				}
			}
		},
	});

	pi.registerCommand("sub-back", {
		description: "Return from a sub-agent session opened with /sub-open",
		handler: async (_args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			try {
				const record = currentSubagentSession(ctx);
				if (!record) {
					ctx.ui.notify("This session is not a known sub-agent session.", "warning");
					return;
				}

				const returnSession = record.returnSession;
				if (!returnSession) {
					ctx.ui.notify(`No return session recorded for ${record.agentId}.`, "error");
					return;
				}
				if (!fs.existsSync(returnSession)) {
					ctx.ui.notify(`Return session does not exist:\n${returnSession}`, "error");
					return;
				}

				const agentId = record.agentId;
				const runName = record.runName;
				const result = await ctx.switchSession(returnSession, {
					withSession: async (nextCtx) => {
						nextCtx.ui.notify(`Returned from sub-agent ${agentId} (${runName}).`, "info");
					},
				});
				if (result.cancelled) ctx.ui.notify("Return session switch cancelled.", "warning");
			} catch (error) {
				try {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} catch (notifyError) {
					// If switchSession succeeded before a later callback threw, the old ctx is stale.
					ignoreStaleExtensionContextError(notifyError);
				}
			}
		},
	});

	pi.registerCommand("sub-where", {
		description: "Show whether the current session belongs to a sub-agent",
		handler: async (_args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;
			const currentSession = ctx.sessionManager.getSessionFile();
			const record = currentSubagentSession(ctx);
			if (!record) {
				ctx.ui.notify(`Current session is not a known sub-agent session.\n${currentSession ?? "ephemeral session"}`, "info");
				return;
			}
			const returnSession = record.returnSession ?? "not recorded";
			ctx.ui.notify([
				`Sub-agent session: ${record.agentId}`,
				`Run: ${record.runDir}`,
				`Status: ${record.state ? formatAgentStatus(record.state.status) : "unknown"}`,
				`Return: ${returnSession}`,
			].join("\n"), "info");
		},
	});
}

/** Child session file -> session to return to with /sub-back (process-local). */
const returnSessions = new Map<string, string>();

interface CurrentSubagentSession {
	agentId: string;
	runDir: string;
	runName: string;
	returnSession?: string;
	state?: ReturnType<typeof getAgentState>;
}

/** Identify the current child session from the parent's records or the child's own `subagent_meta`. */
function currentSubagentSession(ctx: CommandContext): CurrentSubagentSession | undefined {
	const currentSession = ctx.sessionManager.getSessionFile();
	if (!currentSession) return undefined;
	const record = findRecordByChildSession(currentSession);
	let meta: SubagentMeta | undefined;
	try {
		const entry = ctx.sessionManager.getEntries?.().find((item) => item.type === "custom" && item.customType === SUBAGENT_META_ENTRY);
		meta = entry?.data as SubagentMeta | undefined;
	} catch {
		meta = undefined;
	}
	const agentId = record?.agentId ?? meta?.agentId;
	const runDir = record?.runDir ?? meta?.runDir;
	if (!agentId || !runDir) return undefined;
	return {
		agentId,
		runDir,
		runName: path.basename(runDir),
		returnSession: returnSessions.get(currentSession) ?? record?.parentSession ?? meta?.parentSession,
		state: record ? getAgentState(record.runDir, record.agentId, { includeLineCounts: false }) : undefined,
	};
}

async function chooseOpenTarget(args: string, ctx: CommandContext): Promise<{ runDir: string; agentId: string } | undefined> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let runDirArg = parts[0];
	let agentId = parts[1];

	if (parts.length > 2) throw new Error("Usage: /sub-open [batch] [agent-id]");

	const scope = scopeForContext(ctx);
	if (!runDirArg) {
		const batches = listScopeRunDirs(ctx.cwd, scope).map((runDir) => path.basename(runDir));
		if (batches.length === 0) throw new Error("This session has no sub-agent runs.");
		const selectedRun = await ctx.ui.select("Open sub-agent run:", batches);
		if (!selectedRun) return undefined;
		runDirArg = selectedRun;
	}

	const runDir = normalizeRunDir(ctx.cwd, scope, runDirArg);
	const agentIds = listRunRecords(runDir).map((record) => record.agentId).sort();
	if (agentIds.length === 0) throw new Error(`No agents found in batch ${path.basename(runDir)}`);

	if (!agentId) {
		const selectedAgent = await ctx.ui.select("Open sub-agent:", agentIds);
		if (!selectedAgent) return undefined;
		agentId = selectedAgent;
	}
	validateBasename(agentId, "agentId");
	if (!agentIds.includes(agentId)) throw new Error(`Agent "${agentId}" not found in batch ${path.basename(runDir)}`);

	return { runDir, agentId };
}

function completeRunAndAgent(prefix: string, cwd: string): { value: string; label: string; description?: string }[] | null {
	const items = listProjectRecords(cwd).map((record) => {
		const value = `${record.batch} ${record.agentId}`;
		return { value, label: value, description: record.status };
	});
	const filtered = items.filter((item) => item.value.startsWith(prefix) || item.label.includes(prefix));
	return filtered.length ? filtered : null;
}
