import { stringDisplayWidth } from "../../terminal-width.js";
import type { Theme } from "../../theme.js";
import { SUBAGENTS_WIDGET_MAX_ROWS } from "../constants.js";
import { ellipsizeDisplay, padOrTrimPlain, wrapLine } from "./render-text.js";
import { thinkingLevelThemeColor } from "./status-line-renderer.js";
import {
	activeSubagentStates,
	formatElapsedSince,
	formatSubagentsPanelStats,
	subagentModelThinkingLabel,
	subagentRunName,
	subagentStatusIcon,
	taskPreviewMap,
} from "../subagents/subagents-model.js";
import {
	formatTodoPanelStats,
	formatTodoTaskLine,
	hasOpenTodoTasks,
	shiftSegmentsToSlice,
	todoTaskLineSegments,
	visibleTodoTaskRows,
	visibleTodoTasks,
} from "../todo/todo-model.js";
import type { RenderedLine, StyledSegment, SubagentsWidgetState, SubagentStatus, TodoDetails } from "../types.js";

export function renderTodoPanel(details: TodoDetails | undefined, expanded: boolean, width: number, colors: Theme["colors"]): RenderedLine[] {
	if (!details) return [];

	const tasks = visibleTodoTasks(details);
	if (tasks.length === 0) return [];
	if (!hasOpenTodoTasks(details)) return [];

	const contentWidth = Math.max(1, width);
	const target = { kind: "todo-panel" as const };
	const activeTask = tasks.find((task) => task.status === "in_progress");
	const stats = formatTodoPanelStats(tasks);
	const headerText = `todos ${expanded ? "▾" : "▸"}${stats ? ` ${stats}` : ""}`;
	const todoPanelColor = colors.warning;
	const todoMetaColor = colors.muted;
	const todoThinkingColor = (level: string) => thinkingLevelThemeColor(level, colors);
	const todoStatusThemeColor = (status: import("../types.js").TodoStatus) => {
		switch (status) {
			case "pending": return colors.muted;
			case "in_progress": return colors.warning;
			case "deferred": return colors.muted;
			case "completed": return colors.success;
			case "deleted": return colors.error;
		}
	};

	if (!expanded) {
		const prefix = `${headerText} — current: `;
		const current = activeTask ? formatTodoTaskLine(activeTask) : "no active todo";
		const collapsedText = `${prefix}${current}`;
		const segments: StyledSegment[] = [
			{ start: 0, end: headerText.length, foreground: todoPanelColor },
			{ start: headerText.length, end: prefix.length, foreground: todoMetaColor },
		];
		if (activeTask) {
			const activeSegments = todoTaskLineSegments(activeTask, todoMetaColor, { thinkingColor: todoThinkingColor, statusColor: todoStatusThemeColor }).map((segment) => ({
				...segment,
				start: segment.start + prefix.length,
				end: segment.end + prefix.length,
			}));
			segments.push(...activeSegments);
		}
		const line: RenderedLine = {
			text: padOrTrimPlain(ellipsizeDisplay(collapsedText, contentWidth), width),
			segments,
			target,
		};
		return [line];
	}

	const lines: RenderedLine[] = [];
	for (const { task, depth } of visibleTodoTaskRows(details)) {
		const text = formatTodoTaskLine(task, { depth });
		const segments = todoTaskLineSegments(task, todoMetaColor, { depth, thinkingColor: todoThinkingColor, statusColor: todoStatusThemeColor });
		let start = 0;
		for (const wrapped of wrapLine(text, contentWidth)) {
			lines.push({
				text: padOrTrimPlain(wrapped, width),
				segments: shiftSegmentsToSlice(segments, start, wrapped.length),
				target,
			});
			start += wrapped.length;
		}
	}
	return lines;
}

export function renderSubagentsPanel(state: SubagentsWidgetState | undefined, expanded: boolean, width: number, colors: Theme["colors"]): RenderedLine[] {
	if (!state) return [];

	const activeAgents = activeSubagentStates(state.agents);
	if (activeAgents.length === 0) return [];

	const target = { kind: "subagents-panel" as const };
	const previewById = taskPreviewMap(state.tasks);
	const runName = subagentRunName(state.runDir);
	const titleSuffix = state.live ? "" : " (snapshot)";
	const stats = formatSubagentsPanelStats(activeAgents);
	const headerText = `subagents ${expanded ? "▾" : "▸"}${stats ? ` ${stats}` : ""}${titleSuffix}`;
	const contentWidth = Math.max(1, width);

	if (!expanded) {
		const collapsedText = `${headerText} — ${runName}`;
		return [{ text: padOrTrimPlain(ellipsizeDisplay(collapsedText, contentWidth), width), colorOverride: colors.accent, target }];
	}

	const lines: RenderedLine[] = [];
	const visibleAgents = activeAgents.slice(0, SUBAGENTS_WIDGET_MAX_ROWS);
	const rowWidth = contentWidth;
	const now = Date.now();

	for (const agent of visibleAgents) {
		const preview = previewById.get(agent.id);
		const model = subagentModelThinkingLabel(preview);
		const task = preview?.task?.trim() || preview?.scope?.trim() || "task unavailable";
		const icon = subagentStatusIcon(agent.status);
		const prefix = `${icon} ${agent.id} ${model} `;
		const suffix = ` ${formatElapsedSince(agent.startedAt, now)}`;
		const taskWidth = Math.max(8, rowWidth - stringDisplayWidth(prefix) - stringDisplayWidth(suffix));
		const taskText = ellipsizeDisplay(task, taskWidth);
		const text = `${prefix}${taskText}${suffix}`;
		lines.push({
			text: padOrTrimPlain(text, width),
			colorOverride: colors.muted,
			segments: subagentPanelLineSegments({ text, icon, agentId: agent.id, model, taskText, prefix, status: agent.status }, colors),
			target,
		});
	}

	const hidden = activeAgents.length - visibleAgents.length;
	if (hidden > 0) lines.push({ text: padOrTrimPlain(`+${hidden} more`, width), variant: "muted", target });
	return lines;
}

function subagentPanelLineSegments(input: {
	text: string;
	icon: string;
	agentId: string;
	model: string;
	taskText: string;
	prefix: string;
	status: SubagentStatus;
}, colors: Theme["colors"]): StyledSegment[] {
	const iconStart = input.text.indexOf(input.icon);
	const nameStart = input.text.indexOf(input.agentId, iconStart + input.icon.length);
	const modelStart = input.text.indexOf(input.model, nameStart + input.agentId.length);
	const taskStart = input.prefix.length;
	const suffixStart = taskStart + input.taskText.length;
	return [
		{ start: iconStart, end: iconStart + input.icon.length, foreground: subagentStatusColor(input.status, colors), bold: true },
		{ start: nameStart, end: nameStart + input.agentId.length, foreground: colors.accent, bold: true },
		{ start: modelStart, end: modelStart + input.model.length, foreground: colors.info },
		{ start: taskStart, end: suffixStart, foreground: colors.muted },
		{ start: suffixStart, end: input.text.length, foreground: colors.muted },
	].filter((segment) => segment.start >= 0 && segment.end > segment.start);
}

function subagentStatusColor(status: SubagentStatus, colors: Theme["colors"]): string {
	switch (status) {
		case "planned":
			return colors.muted;
		case "running":
			return colors.info;
		case "retrying":
			return colors.warning;
		case "done":
			return colors.success;
		case "failed":
			return colors.error;
		case "stopped":
			return colors.muted;
	}
}
