import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import {
	ensureSessionFileLink,
	findSubagentSessionByFile,
	getActiveSubagentPresetName,
	getBuiltinSubagentPresetsPath,
	getProjectSubagentPresetsPath,
	getSessionSubagentPresetOverride,
	getSubagentPresetSelectionPath,
	getRunState,
	listRunDirs,
	listSubagentSessionRecords,
	loadSubagentConfig,
	readParentSessionLink,
	readReturnSessionLink,
	resolveRunDir,
	setActiveSubagentPreset,
	setSessionSubagentPresetOverride,
	shouldPersistSubagentSessions,
	stopAgents,
	validateBasename,
	writeParentSessionLink,
	writeReturnSessionLink,
} from "./lib.js";
import { formatAgentStatus } from "./format.js";
import type { SubagentPreset } from "./lib.js";

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

const CLEAR_ACTIVE_PRESET_LABEL = "Use no active preset";

export const ULTRAWORK_PROMPT = `Run ultrawork mode for the current objective.

Use subagents when a lower-cost worker or isolation of noisy evidence helps, including one bounded sequential task. Pick subagentType from the effective catalog: research for reading/review, implement for code/docs/tests/UI changes, verify for running checks, browser-qa for real-browser testing, and oracle only for a deliberate strong independent opinion. Prefer an appropriate project-local specialist. Keep decisions and integration in the parent; do not create agents just to assign a discipline.

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
	registerPresetCommands(pi);
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

function registerPresetCommands(pi: ExtensionAPI): void {
	pi.registerCommand("subagent-preset", {
		description: "Select a sub-agent model-pool preset, or run session <name> for a process-only override",
		getArgumentCompletions: (prefix: string) => {
			const names = sortedPresetNames(loadSubagentConfig(process.cwd()).presets ?? {}, getActiveSubagentPresetName());
			return [...names, ...names.map((name) => `session ${name}`), "list", "path", "clear", "session", "session-clear"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
			handler: async (args: string, ctx: CommandContext) => {
			const name = args.trim();
			if (!name) return showSubagentPresetSelector(ctx);
			if (name === "session") return ctx.ui.notify("Usage: /subagent-preset session <name>", "warning");
			if (name.startsWith("session ")) return setSessionActiveSubagentPreset(ctx, name.slice("session ".length).trim());
			if (name === "session-clear") return clearSessionActiveSubagentPreset(ctx);
			if (name === "list") return listSubagentPresets(ctx);
			if (name === "path") return showSubagentPresetPaths(ctx);
			if (name === "clear") return clearActiveSubagentPreset(ctx);

			const config = loadSubagentConfig(ctx.cwd);
			const preset = config.presets?.[name];
			if (!preset) return ctx.ui.notify(`Unknown sub-agent preset "${name}". Run /subagent-preset list to see available pools.`, "error");
			setActiveSubagentPreset(name);
			notifyActiveSubagentPreset(ctx, name, preset);
		},
	});
}

async function showSubagentPresetSelector(ctx: CommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("Sub-agent preset selector requires interactive UI. Use /subagent-preset <name>.", "warning");

	const config = loadSubagentConfig(ctx.cwd);
	const activePreset = getActiveSubagentPresetName();
	const presets = config.presets ?? {};
	const names = sortedPresetNames(presets, activePreset);
	const presetLabels = names.map((name) => subagentPresetLabel(name, presets[name], activePreset));
	const labels = [...presetLabels];
	if (activePreset) labels.push(CLEAR_ACTIVE_PRESET_LABEL);
	if (labels.length === 0) {
		ctx.ui.notify("No sub-agent model-pool presets are available.", "warning");
		showSubagentPresetPaths(ctx);
		return;
	}
	const labelToName = new Map(presetLabels.map((label, index) => [label, names[index]]));
	const selected = await ctx.ui.select("Select active sub-agent preset", labels);
	if (!selected) return;
	if (selected === CLEAR_ACTIVE_PRESET_LABEL) return clearActiveSubagentPreset(ctx);

	const name = labelToName.get(selected);
	if (!name) return;
	setActiveSubagentPreset(name);
	notifyActiveSubagentPreset(ctx, name, presets[name]);
}
function listSubagentPresets(ctx: CommandContext): void {
	const config = loadSubagentConfig(ctx.cwd);
	const activePreset = getActiveSubagentPresetName();
	const presets = config.presets ?? {};
	const names = sortedPresetNames(presets, activePreset);
	if (names.length === 0) return ctx.ui.notify("No sub-agent model-pool presets are available.", "warning");
	ctx.ui.notify([
		"Sub-agent model-pool presets:",
		...names.map((name) => `- ${subagentPresetLabel(name, presets[name], activePreset)}`),
	].join("\n"), "info");
}

function showSubagentPresetPaths(ctx: CommandContext): void {
	ctx.ui.notify([
		`Bundled presets: ${getBuiltinSubagentPresetsPath()}`,
		`Project preset override: ${getProjectSubagentPresetsPath(ctx.cwd)}`,
		"Project presets are defined as model pools in .pi/agents/presets.jsonc; agent behavior stays in .pi/agents/*.md.",
		`Active selection state: ${getSubagentPresetSelectionPath()}`,
		`Session override: ${formatSessionPresetOverride()}`,
		"Use /subagent-preset session <name> to override only the current Pi process; use /subagent-preset session-clear to clear that runtime override.",
	].join("\n"), "info");
}

function clearActiveSubagentPreset(ctx: CommandContext): void {
	setActiveSubagentPreset(undefined);
	const override = getSessionSubagentPresetOverride();
	ctx.ui.notify(override
		? `Saved sub-agent preset selection cleared, but ${formatSessionPresetOverride()} still overrides this session.`
		: "Sub-agent presets disabled. Future sub-agents use task/profile/env defaults until another preset is selected.", "info");
}

function setSessionActiveSubagentPreset(ctx: CommandContext, name: string): void {
	if (!name) return ctx.ui.notify("Usage: /subagent-preset session <name>", "warning");
	const config = loadSubagentConfig(ctx.cwd);
	const preset = config.presets?.[name];
	if (!preset) return ctx.ui.notify(`Unknown sub-agent preset "${name}". Run /subagent-preset list to see available pools.`, "error");
	setSessionSubagentPresetOverride(name);
	ctx.ui.notify(`Session-only sub-agent preset "${name}": ${subagentPresetDescription(preset)}\nApplies to future sub-agent spawns only until this Pi process exits or /subagent-preset session-clear is run. Saved preset selection is unchanged.`, "info");
}

function clearSessionActiveSubagentPreset(ctx: CommandContext): void {
	setSessionSubagentPresetOverride(undefined);
	const envOverride = typeof process.env.AGENTS_PRESET === "string" && process.env.AGENTS_PRESET.trim() ? process.env.AGENTS_PRESET.trim() : undefined;
	ctx.ui.notify(envOverride
		? `Runtime session override cleared, but AGENTS_PRESET=${envOverride} still overrides this process.`
		: "Runtime session sub-agent preset override cleared. Future sub-agents use AGENTS_PRESET, saved preset, or task/profile/env defaults.", "info");
}

function formatSessionPresetOverride(): string {
	const override = getSessionSubagentPresetOverride();
	if (!override) return "not set";
	const envOverride = typeof process.env.AGENTS_PRESET === "string" && process.env.AGENTS_PRESET.trim() ? process.env.AGENTS_PRESET.trim() : undefined;
	return envOverride === override ? `AGENTS_PRESET=${override}` : `runtime=${override}`;
}

function notifyActiveSubagentPreset(ctx: CommandContext, name: string, preset: SubagentPreset): void {
	ctx.ui.notify(`Active sub-agent preset "${name}": ${subagentPresetDescription(preset)}\nApplies to future sub-agent spawns in all sessions until changed.`, "info");
}

function subagentPresetLabel(name: string, preset: SubagentPreset, activePreset?: string): string {
	return `${name} — ${subagentPresetDescription(preset)}${activePreset === name ? " ✓ active" : ""}`;
}

function sortedPresetNames(presets: Record<string, SubagentPreset>, activePreset?: string): string[] {
	const names = Object.keys(presets).sort();
	return activePreset && presets[activePreset]
		? [activePreset, ...names.filter((name) => name !== activePreset)]
		: names;
}

function subagentPresetDescription(preset: SubagentPreset): string {
	const parts: string[] = [];
	if (preset.description) parts.push(preset.description);
	if (preset.models !== undefined) {
		parts.push(`models:${preset.models.join(",") || "(none)"}`);
		return parts.join(", ");
	}
	if (preset.model) parts.push(`model:${preset.model}`);
	if (preset.fallbackModels && preset.fallbackModels.length > 0) parts.push(`fallbacks:${preset.fallbackModels.join(",")}`);
	if (preset.thinking) parts.push(`thinking:${preset.thinking}`);
	if (preset.extraArgs && preset.extraArgs.length > 0) parts.push(`args:${preset.extraArgs.join(" ")}`);
	if (preset.types && Object.keys(preset.types).length > 0) parts.push(`types:${Object.keys(preset.types).sort().join(",")}`);
	return parts.length > 0 ? parts.join(", ") : "empty";
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
