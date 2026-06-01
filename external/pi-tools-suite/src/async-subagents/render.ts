import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentState } from "./lib.js";
import { modelName, plural, statusGlyph, statusLabel } from "./format.js";
import type { AgentTaskPreview, SubagentRunRenderDetails } from "./types.js";

interface Component {
	invalidate(): void;
	render(width: number): string[];
}

function statusColor(status: AgentState["status"]): string {
	if (status === "done") return "success";
	if (status === "failed" || status === "stopped") return "error";
	if (status === "running") return "warning";
	return "dim";
}

function statusVerb(status: AgentState["status"]): string {
	if (status === "done") return "Completed";
	if (status === "failed") return "Failed";
	if (status === "stopped") return "Stopped";
	if (status === "running") return "Started";
	return "Planned";
}

function statusSummary(agents: AgentState[], theme: any): string {
	const running = agents.filter((agent) => agent.status === "running").length;
	const done = agents.filter((agent) => agent.status === "done").length;
	const failed = agents.filter((agent) => agent.status === "failed" || agent.status === "stopped").length;
	const planned = agents.filter((agent) => agent.status === "planned").length;
	const summary: string[] = [];
	if (running) summary.push(theme.fg("warning", `${running} running`));
	if (done) summary.push(theme.fg("success", `${done} done`));
	if (failed) summary.push(theme.fg("error", `${failed} failed`));
	if (planned) summary.push(theme.fg("dim", `${planned} planned`));
	return summary.length ? theme.fg("dim", " · ") + summary.join(theme.fg("dim", ", ")) : "";
}

function appendDetailLine(text: string, prefix: string, line: string, theme: any): string {
	return text + `\n${theme.fg("dim", prefix + line)}`;
}

function outputLineSummary(agent: AgentState): string | undefined {
	const outputLines = (agent.resultLines ?? 0) + (agent.stderrLines ?? 0);
	if (outputLines > 0) return `${plural(outputLines, "output line")}`;
	if (agent.eventLines !== undefined) return `${plural(agent.eventLines, "event line")}`;
	return undefined;
}

function elapsedSummary(agent: AgentState): string | undefined {
	if (!agent.startedAt) return undefined;
	const start = Date.parse(agent.startedAt);
	if (!Number.isFinite(start)) return undefined;
	const end = agent.finishedAt ? Date.parse(agent.finishedAt) : Date.now();
	if (!Number.isFinite(end) || end < start) return undefined;
	const totalSeconds = Math.floor((end - start) / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function commandVerbForMode(mode: SubagentRunRenderDetails["mode"]): string {
	if (mode === "spawn") return "Started";
	if (mode === "status") return "Checked";
	if (mode === "completion") return "Completed";
	return "Ran";
}

const SPAWN_PROMPT_COMPACT_TOTAL_LINE_LIMIT = 6;

function findTaskPreview(details: SubagentRunRenderDetails, agentId: string): AgentTaskPreview | undefined {
	return details.tasks?.find((task) => task.id === agentId);
}

class SubagentRunComponent implements Component {
	constructor(
		private details: SubagentRunRenderDetails,
		private options: { expanded?: boolean; isPartial?: boolean },
		private theme: any,
	) {}

	invalidate(): void {
		// Stateless; rebuilt on each render width.
	}

	render(width: number): string[] {
		return renderSubagentRunText(this.details, this.options, this.theme, width)
			.split("\n")
			.map((line) => truncateToWidth(line, width));
	}
}

class SubagentSpawnPromptComponent implements Component {
	constructor(
		private details: SubagentRunRenderDetails,
		private options: { expanded?: boolean; isPartial?: boolean },
		private theme: any,
	) {}

	invalidate(): void {
		// Stateless; rebuilt on each render width.
	}

	render(width: number): string[] {
		return renderSubagentSpawnPromptsText(this.details, this.options, this.theme, width)
			.split("\n")
			.map((line) => truncateToWidth(line, width));
	}
}

function renderSubagentRunText(details: SubagentRunRenderDetails, options: { expanded?: boolean; isPartial?: boolean }, theme: any, width: number): string {
	const agents = details.agents ?? [];
	const verb = commandVerbForMode(details.mode);
	let text = theme.fg("toolTitle", theme.bold(`${verb} ${plural(agents.length, "subagent")}, tracked 1 run`));
	text += statusSummary(agents, theme);

	const visibleAgents = options.expanded ? agents : agents.slice(0, 6);
	for (const [index, agent] of visibleAgents.entries()) {
		const isLastVisible = index === visibleAgents.length - 1 && (options.expanded || visibleAgents.length === agents.length);
		const branch = isLastVisible ? "└" : "├";
		const detailPrefix = isLastVisible ? "    " : "│   ";
		const preview = findTaskPreview(details, agent.id);
		const outputLines = outputLineSummary(agent);
		const elapsed = elapsedSummary(agent);
		const model = preview?.model ? modelName(preview.model) : undefined;
		const showElapsed = Boolean(elapsed && (options.expanded || agent.status === "running"));
		const prefixParts: string[] = [];
		prefixParts.push(theme.fg(statusColor(agent.status), statusGlyph(agent.status)));
		prefixParts.push(theme.fg("accent", agent.id));
		if (model) prefixParts.push(theme.fg("success", model));
		const suffixParts: string[] = [];
		if (outputLines) suffixParts.push(theme.fg("dim", `· ${outputLines}`));
		if (showElapsed) suffixParts.push(theme.fg("dim", `· ${elapsed}`));

		const parts: string[] = [...prefixParts];
		if (preview?.task) {
			const prefix = `${theme.fg("dim", branch)} ${prefixParts.join(" ")} `;
			const suffix = suffixParts.length ? ` ${suffixParts.join(" ")}` : "";
			const taskWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
			const task = truncateToWidth(preview.task, taskWidth);
			parts.push(theme.fg("dim", task));
		}
		parts.push(...suffixParts);
		text += `\n${theme.fg("dim", branch)} ${parts.join(" ")}`;

		if (options.expanded) {
			if (agent.pid) text = appendDetailLine(text, detailPrefix, `pid ${agent.pid}`, theme);
			if (agent.exitCode !== undefined) text = appendDetailLine(text, detailPrefix, `exit ${agent.exitCode}`, theme);
			if (preview?.scope) text = appendDetailLine(text, detailPrefix, `scope ${preview.scope}`, theme);
			if (agent.startedAt) text = appendDetailLine(text, detailPrefix, `started ${agent.startedAt}`, theme);
			if (agent.finishedAt) text = appendDetailLine(text, detailPrefix, `finished ${agent.finishedAt}`, theme);
		}
	}

	if (!options.expanded && agents.length > visibleAgents.length) {
		text += `\n${theme.fg("dim", "└")} ${theme.fg("muted", `… +${agents.length - visibleAgents.length} more`)}`;
	}

	if (options.expanded) {
		text += `\n${theme.fg("dim", `run ${details.runDir}`)}`;
	} else {
		text += `\n${theme.fg("dim", "ctrl+o to expand")}`;
	}

	return text;
}

export function renderSubagentRun(details: SubagentRunRenderDetails, options: { expanded?: boolean; isPartial?: boolean }, theme: any): Component {
	return new SubagentRunComponent(details, options, theme);
}

function spawnPromptCount(details: SubagentRunRenderDetails): number {
	return details.tasks?.length ?? details.agents?.length ?? 0;
}

function renderSubagentSpawnPromptsText(details: SubagentRunRenderDetails, options: { expanded?: boolean; isPartial?: boolean }, theme: any, width: number): string {
	const tasks = details.tasks ?? [];
	const count = spawnPromptCount(details);
	let text = theme.fg("toolTitle", theme.bold(renderSpawnChatSummary(details)));

	const compactPromptLineLimit = Math.max(0, SPAWN_PROMPT_COMPACT_TOTAL_LINE_LIMIT - 1);
	const promptLineLimit = options.expanded ? tasks.length : Math.min(tasks.length, compactPromptLineLimit);
	const visibleTasks = tasks.slice(0, promptLineLimit);
	const hiddenTasks = tasks.length - visibleTasks.length;
	const lines: string[] = [];
	for (const [index, task] of visibleTasks.entries()) {
		const isOverflowSummary = !options.expanded && hiddenTasks > 0 && index === compactPromptLineLimit - 1;
		const isLastVisible = index === visibleTasks.length - 1;
		const branch = isLastVisible ? "└" : "├";
		if (isOverflowSummary) {
			lines.push(`${theme.fg("dim", branch)} ${theme.fg("muted", `… +${hiddenTasks + 1} more prompts`)}`);
			break;
		}

		const prefix = `${theme.fg("dim", branch)} ${theme.fg("accent", `${task.id}:`)} `;
		const suffix = task.model ? ` ${theme.fg("success", modelName(task.model))}` : "";
		const promptWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
		const prompt = truncateToWidth(task.task ?? "(prompt unavailable)", promptWidth);
		lines.push(`${prefix}${theme.fg("dim", prompt)}${suffix}`);
	}

	if (lines.length === 0 && count > 0) {
		text += `\n${theme.fg("dim", `Prompts unavailable for ${plural(count, "subagent")}.`)}`;
	} else if (lines.length > 0) {
		text += `\n${lines.join("\n")}`;
	}

	return text;
}

export function renderSubagentSpawnPrompts(details: SubagentRunRenderDetails, options: { expanded?: boolean; isPartial?: boolean }, theme: any): Component {
	return new SubagentSpawnPromptComponent(details, options, theme);
}

export function renderPlainRunSummary(details: SubagentRunRenderDetails): string {
	const agents = details.agents ?? [];
	const verb = commandVerbForMode(details.mode);
	const lines = [`${verb} ${plural(agents.length, "subagent")}, tracked 1 run`];
	for (const agent of agents) {
		const outputLines = outputLineSummary(agent);
		lines.push(
			`${statusGlyph(agent.status)} ${statusVerb(agent.status)} ${agent.id} -> ${statusLabel(agent.status)}${outputLines ? ` · ${outputLines}` : ""}`,
		);
	}
	return lines.join("\n");
}

export function renderSpawnChatSummary(details: SubagentRunRenderDetails): string {
	return `Started ${plural(spawnPromptCount(details), "subagent")}.`;
}
