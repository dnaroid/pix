import { resolveColor, resolveToolRule, type PixConfig, type ResolvedToolRule } from "../config.js";
import { formatMarkdownTables, markdownSyntaxHighlightsForText } from "../markdown-format.js";
import { renderToolDisplay } from "../tool-renderers/index.js";
import { DEFAULT_THINKING_TOOL_RULE, SUBAGENT_STATUSES, THINKING_TOOL_NAME, TODO_TOOL_NAME } from "./constants.js";
import { attachImageClickTargets } from "./image-click-targets.js";
import { formatStructuredText } from "./message-content.js";
import {
	formatSubagentTimestamp,
	isSubagentRunRenderDetails,
	isSubagentsToolName,
	subagentRunName,
	subagentStatusIcon,
	taskPreviewMap,
} from "./subagents-model.js";
import { formatTodoTaskLine, isTodoDetails, visibleTodoTasks } from "./todo-model.js";
import { renderToolBlock } from "./tool-block-renderer.js";
import type { Theme } from "../theme.js";
import type {
	Entry,
	RenderedLine,
	SubagentAgentState,
	SubagentRunRenderDetails,
	SubagentStatus,
	SubagentTaskPreview,
	TodoDetails,
} from "./types.js";

export type ConversationToolRenderOptions = {
	cwd: string;
	pixConfig: PixConfig;
	colors: Theme["colors"];
	superCompactTools?: boolean;
	allThinkingExpanded?: boolean;
};

export function renderConversationToolEntry(
	entry: Extract<Entry, { kind: "tool" }>,
	width: number,
	options: ConversationToolRenderOptions,
): RenderedLine[] {
	const todoLines = renderTodoToolEntry(entry, width, options);
	if (todoLines) return todoLines;

	const subagentsLines = renderSubagentsToolEntry(entry, width, options);
	if (subagentsLines) return subagentsLines;

	const display = renderToolDisplay({
		toolName: entry.toolName,
		argsText: entry.argsText,
		output: entry.output,
		details: entry.details,
		isError: entry.isError,
		status: entry.status,
		cwd: options.cwd,
		colors: options.colors,
		toolColor: resolveColor(resolveToolRule(entry.toolName, options.pixConfig.toolRenderer).color, options.colors),
	});
	const toolName = display.toolName ?? entry.toolName;
	const rule = resolveToolRule(toolName, options.pixConfig.toolRenderer);
	const lines = renderToolBlock({
		id: entry.id,
		toolName,
		headerArgs: display.headerArgs,
		headerArgsSegments: display.headerArgsSegments,
		bodyLineStyles: display.bodyLineStyles,
		bodyStyle: display.bodyStyle,
		preserveAnsi: display.preserveAnsi,
		expanded: entry.expanded,
		status: entry.status,
		isError: entry.isError,
		output: entry.output,
		collapsedBody: display.collapsedBody,
		expandedText: display.expandedText,
		syntaxHighlight: display.syntaxHighlight,
	}, rule, width, options.colors, { superCompact: Boolean(options.superCompactTools) });
	return attachImageClickTargets(lines, entry.id, entry.images, { foreground: options.colors.info, underline: true });
}

export function renderThinkingEntry(
	entry: Extract<Entry, { kind: "thinking" }>,
	width: number,
	options: ConversationToolRenderOptions,
): RenderedLine[] {
	const rule = resolveThinkingToolRule(options.pixConfig);
	const markdownText = entry.text ? formatMarkdownTables(entry.text, Math.max(1, width - 2)) : "";
	const expandedText = trimTrailingBlankLines(markdownText);
	const compactExpandedText = options.superCompactTools ? removeBlankLines(expandedText) : expandedText;
	const forceExpanded = Boolean(options.allThinkingExpanded);
	return renderToolBlock({
		id: entry.id,
		toolName: THINKING_TOOL_NAME,
		expanded: entry.expanded || forceExpanded,
		status: entry.status,
		isError: false,
		output: markdownText,
		collapsedBody: markdownText,
		expandedText: compactExpandedText || "(empty)",
		bodyWrap: "word",
		syntaxHighlight: compactExpandedText ? markdownSyntaxHighlightsForText(compactExpandedText) : undefined,
	}, rule, width, options.colors, { superCompact: Boolean(options.superCompactTools && !forceExpanded) });
}

function trimTrailingBlankLines(text: string): string {
	return text.replace(/(?:\r?\n[ \t]*)+$/u, "");
}

function removeBlankLines(text: string): string {
	return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).join("\n");
}

function renderTodoToolEntry(
	entry: Extract<Entry, { kind: "tool" }>,
	width: number,
	options: ConversationToolRenderOptions,
): RenderedLine[] | undefined {
	if (entry.toolName !== TODO_TOOL_NAME) return undefined;
	if (!isTodoDetails(entry.details)) return undefined;

	const rule = resolveToolRule(TODO_TOOL_NAME, options.pixConfig.toolRenderer);
	const body = todoDetailsText(entry.details);
	return renderToolBlock({
		id: entry.id,
		toolName: TODO_TOOL_NAME,
		headerArgs: `action=${entry.details.action} nextId=${entry.details.nextId}`,
		expanded: entry.expanded,
		status: entry.status,
		isError: entry.isError || Boolean(entry.details.error),
		output: body,
		collapsedBody: body,
		expandedText: body,
	}, rule, width, options.colors, { superCompact: Boolean(options.superCompactTools) });
}

function todoDetailsText(details: TodoDetails): string {
	const lines: string[] = [];
	if (details.error) lines.push(`error: ${details.error}`);

	const tasks = visibleTodoTasks(details);
	if (tasks.length === 0) {
		lines.push("todo: no tasks");
	} else {
		for (const task of tasks) lines.push(formatTodoTaskLine(task));
	}

	return lines.join("\n");
}

function renderSubagentsToolEntry(
	entry: Extract<Entry, { kind: "tool" }>,
	width: number,
	options: ConversationToolRenderOptions,
): RenderedLine[] | undefined {
	if (!isSubagentsToolName(entry.toolName)) return undefined;
	if (!isSubagentRunRenderDetails(entry.details)) return undefined;

	const rule = resolveToolRule(entry.toolName, options.pixConfig.toolRenderer);
	const collapsedBody = subagentsCollapsedText(entry.details);
	const expandedText = subagentsExpandedText(entry, entry.details);
	return renderToolBlock({
		id: entry.id,
		toolName: entry.toolName,
		headerArgs: subagentsToolHeaderArgs(entry.details),
		expanded: entry.expanded,
		status: entry.status,
		isError: entry.isError,
		output: expandedText,
		collapsedBody,
		expandedText,
	}, rule, width, options.colors, { superCompact: Boolean(options.superCompactTools) });
}

function subagentsToolHeaderArgs(details: SubagentRunRenderDetails): string {
	const parts = [`started=${subagentsStartedCount(details)}/${details.agents.length}`, `run=${subagentRunName(details.runDir)}`];
	if (details.mode) parts.unshift(`mode=${details.mode}`);
	if (details.agentId) parts.push(`agent=${details.agentId}`);
	return parts.join(" ");
}

function subagentsStartedCount(details: SubagentRunRenderDetails): number {
	return details.agents.filter((agent) => agent.status !== "planned").length;
}

function subagentsCollapsedText(details: SubagentRunRenderDetails): string {
	const total = details.agents.length;
	const label = total === 1 ? "subagent" : "subagents";
	const statusCounts = new Map<SubagentStatus, number>();
	for (const agent of details.agents) statusCounts.set(agent.status, (statusCounts.get(agent.status) ?? 0) + 1);
	const statuses = SUBAGENT_STATUSES
		.map((status) => {
			const count = statusCounts.get(status) ?? 0;
			return count > 0 ? `${status}:${count}` : undefined;
		})
		.filter((status): status is string => status !== undefined)
		.join(" ");
	const started = subagentsStartedCount(details);
	const statusSuffix = statuses ? ` — ${statuses}` : "";
	return `started ${started}/${total} ${label}${statusSuffix} — run ${subagentRunName(details.runDir)}`;
}

function subagentsExpandedText(entry: Extract<Entry, { kind: "tool" }>, details: SubagentRunRenderDetails): string {
	const sections = [
		subagentsCollapsedText(details),
		formatStructuredText(entry.argsText),
		subagentsDetailsText(details),
		formatStructuredText(details),
	];

	if (entry.output.trim()) sections.push(entry.isError ? `error\n${entry.output.trimEnd()}` : entry.output.trimEnd());
	return sections.join("\n\n");
}

function subagentsDetailsText(details: SubagentRunRenderDetails): string {
	if (details.agents.length === 0) return `run ${details.runDir}: no agents`;

	const previewById = taskPreviewMap(details.tasks);
	const lines: string[] = [];
	for (const agent of details.agents) {
		lines.push(formatSubagentToolLine(agent, previewById.get(agent.id)));
	}
	return lines.join("\n");
}

function formatSubagentToolLine(agent: SubagentAgentState, preview: SubagentTaskPreview | undefined): string {
	const parts = [subagentStatusIcon(agent.status), agent.status, agent.id];
	if (preview?.model) parts.push(`model:${preview.model}`);
	if (preview?.task) parts.push(`task:${preview.task}`);
	else if (preview?.scope) parts.push(`scope:${preview.scope}`);
	else parts.push("task:unavailable");
	if (agent.pid !== undefined) parts.push(`pid:${agent.pid}`);
	if (agent.exitCode !== undefined) parts.push(`exitCode:${agent.exitCode}`);
	const startedAt = formatSubagentTimestamp(agent.startedAt);
	if (startedAt) parts.push(`started:${startedAt}`);
	const finishedAt = formatSubagentTimestamp(agent.finishedAt);
	if (finishedAt) parts.push(`finished:${finishedAt}`);
	if (agent.nextRetryAt) parts.push(`nextRetry:${agent.nextRetryAt}`);
	if (agent.retryCount !== undefined) parts.push(`retry:${agent.retryCount}`);
	return parts.join(" ");
}

function resolveThinkingToolRule(pixConfig: PixConfig): ResolvedToolRule {
	const configured = pixConfig.toolRenderer.tools[THINKING_TOOL_NAME];
	if (!configured) return DEFAULT_THINKING_TOOL_RULE;

	const rule: ResolvedToolRule = {
		previewLines: configured.previewLines ?? DEFAULT_THINKING_TOOL_RULE.previewLines,
		direction: configured.direction ?? DEFAULT_THINKING_TOOL_RULE.direction,
		color: configured.color ?? DEFAULT_THINKING_TOOL_RULE.color,
	};
	if (configured.compactHidden != null) rule.compactHidden = configured.compactHidden;
	if (configured.hidden != null) rule.hidden = configured.hidden;
	return rule;
}
