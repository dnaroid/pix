import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import {
	ensureSessionFileLink,
	findSubagentSessionByFile,
	getRunState,
	listRunDirs,
	listSubagentSessionRecords,
	readParentSessionLink,
	readReturnSessionLink,
	resolveRunDir,
	shouldPersistSubagentSessions,
	stopAgents,
	validateBasename,
	writeParentSessionLink,
	writeReturnSessionLink,
} from "./lib.js";
import { formatAgentStatus } from "./format.js";

interface CommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
	};
	waitForIdle?: () => Promise<void>;
	sessionManager: { getSessionFile(): string | undefined };
	switchSession(sessionPath: string, options?: { withSession?: (ctx: CommandContext) => Promise<void> }): Promise<{ cancelled: boolean }>;
}

type MessageSender = ExtensionAPI & {
	sendUserMessage?: (message: string) => void;
	sendMessage?: unknown;
};

export const ULTRAWORK_PROMPT = `Run ultrawork mode for the current objective.

Use subagents when a lower-cost worker or isolation of noisy evidence helps, including one bounded sequential task. Pick subagentType from the effective catalog: research for reading/review, implement for code/docs/tests/UI changes, verify for running checks, ui-qa for real UI testing across browsers, TUIs, and desktop GUIs, and oracle only for a deliberate strong independent opinion. Prefer an appropriate project-local specialist. Keep decisions and integration in the parent; do not create agents just to assign a discipline.

Keep parent context lean: spawn for broad parallel work, read results only when needed, and finish unless genuinely blocked.`;

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
	const persistSessions = shouldPersistSubagentSessions();
	registerOrchestrationCommands(pi);

	pi.registerCommand("sub-status", {
		description: "Show status of async sub-agents in a run directory",
		handler: async (args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			const runDir = args.trim() || listRunDirs(ctx.cwd)[0] || "";
			if (!runDir) {
				ctx.ui.notify("Usage: /sub-status [run-dir]", "warning");
				return;
			}

			const resolved = resolveRunDir(ctx.cwd, runDir);
			const state = getRunState(resolved);

			if (state.agents.length === 0) {
				ctx.ui.notify(`No agents found in ${resolved}`, "warning");
				return;
			}

			const lines = state.agents.map((a) => `${formatAgentStatus(a.status)} ${a.id}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	if (persistSessions) registerSessionCommands(pi);

	pi.registerCommand("sub-stop", {
		description: "Stop running async sub-agents in a run directory",
		handler: async (args: string, ctx: CommandContext) => {
			if (!ctx.hasUI) return;

			const parts = args.trim().split(/\s+/).filter(Boolean);
			const force = parts.includes("--force") || parts.includes("-f");
			const values = parts.filter((part) => part !== "--force" && part !== "-f");
			const runDirArg = values.shift();
			if (!runDirArg) {
				ctx.ui.notify("Usage: /sub-stop <run-dir> [agent-id ...] [--force]", "warning");
				return;
			}

			try {
				for (const id of values) validateBasename(id, "agentId");
				const resolved = resolveRunDir(ctx.cwd, runDirArg);
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

				const sessionFile = ensureSessionFileLink(target.agentDir);
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

				writeReturnSessionLink(target.agentDir, currentSession);
				if (!readParentSessionLink(target.agentDir)) writeParentSessionLink(target.agentDir, currentSession);

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
				const currentSession = ctx.sessionManager.getSessionFile();
				const record = findSubagentSessionByFile(ctx.cwd, currentSession);
				if (!record) {
					ctx.ui.notify("This session is not a known sub-agent session.", "warning");
					return;
				}

				const returnSession = readReturnSessionLink(record.agentDir) ?? readParentSessionLink(record.agentDir);
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
			const record = findSubagentSessionByFile(ctx.cwd, currentSession);
			if (!record) {
				ctx.ui.notify(`Current session is not a known sub-agent session.\n${currentSession ?? "ephemeral session"}`, "info");
				return;
			}
			const returnSession = readReturnSessionLink(record.agentDir) ?? readParentSessionLink(record.agentDir) ?? "not recorded";
			ctx.ui.notify([
				`Sub-agent session: ${record.agentId}`,
				`Run: ${record.runDir}`,
				`Status: ${record.state ? formatAgentStatus(record.state.status) : "unknown"}`,
				`Return: ${returnSession}`,
			].join("\n"), "info");
		},
	});
}

async function chooseOpenTarget(args: string, ctx: CommandContext): Promise<{ runDir: string; agentDir: string; agentId: string } | undefined> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let runDirArg = parts[0];
	let agentId = parts[1];

	if (parts.length > 2) throw new Error("Usage: /sub-open [run-dir] [agent-id]");

	if (!runDirArg) {
		const selectedRun = await ctx.ui.select("Open sub-agent run:", listRunDirs(ctx.cwd));
		if (!selectedRun) return undefined;
		runDirArg = selectedRun;
	}

	const runDir = resolveRunDir(ctx.cwd, runDirArg);
	if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory())
		throw new Error(`Run directory not found: ${runDir}`);

	const agentIds = getRunState(runDir).agents.map((agent) => agent.id).sort();
	if (agentIds.length === 0) throw new Error(`No agents found in ${runDir}`);

	if (!agentId) {
		const selectedAgent = await ctx.ui.select("Open sub-agent:", agentIds);
		if (!selectedAgent) return undefined;
		agentId = selectedAgent;
	}
	validateBasename(agentId, "agentId");
	if (!agentIds.includes(agentId)) throw new Error(`Agent "${agentId}" not found in ${runDir}`);

	return { runDir, agentId, agentDir: path.join(runDir, agentId) };
}

function completeRunAndAgent(prefix: string, cwd: string): { value: string; label: string; description?: string }[] | null {
	const records = listSubagentSessionRecords(cwd);
	const items = records.map((record) => {
		const value = `${record.runDir} ${record.agentId}`;
		return {
			value,
			label: `${record.runName} ${record.agentId}`,
			description: record.state?.status,
		};
	});
	const filtered = items.filter((item) => item.value.startsWith(prefix) || item.label.includes(prefix));
	return filtered.length ? filtered : null;
}
