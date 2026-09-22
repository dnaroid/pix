import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { isNativePiTui } from "../lib/native-pi-tui.js";
import { setNativePiAboveWidget } from "../lib/native-pi-widget-order.js";
import type { AgentTaskPreview, SubagentsLiveStateEvent } from "./types.js";

export const SUBAGENTS_NATIVE_WIDGET_KEY = "pi-tools-suite:subagents";
const MAX_VISIBLE_AGENTS = 5;

interface SubagentWidgetRow {
	readonly id: string;
	readonly status: "planned" | "running" | "retrying" | "done" | "failed" | "stopped";
	readonly name: string;
	readonly activity: string | undefined;
}

interface SubagentWidgetModel {
	readonly counts: string;
	readonly rows: readonly SubagentWidgetRow[];
	readonly overflow: number;
}

export function updateSubagentsNativeWidget(
	ctx: ExtensionContext | undefined,
	state: SubagentsLiveStateEvent,
): void {
	if (!ctx || !isNativePiTui(ctx)) return;
	if (state.count === 0) {
		setNativePiAboveWidget(ctx, SUBAGENTS_NATIVE_WIDGET_KEY, undefined);
		return;
	}
	const model = prepareSubagentWidgetModel(state);

	setNativePiAboveWidget(ctx, SUBAGENTS_NATIVE_WIDGET_KEY, (_tui, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			const lines = [
				truncateToWidth(theme.fg("accent", theme.bold("Subagents")) + " " + theme.fg("dim", model.counts), width),
			];

			for (const agent of model.rows) {
				const glyph = agent.status === "running"
					? theme.fg("success", "●")
					: agent.status === "retrying"
						? theme.fg("warning", "↻")
						: theme.fg("dim", "○");
				const suffix = agent.activity ? theme.fg("dim", " · " + agent.activity) : theme.fg("dim", " · " + agent.status);
				lines.push(truncateToWidth("  " + glyph + " " + theme.fg("accent", agent.name) + suffix, width));
			}
			if (model.overflow > 0) {
				lines.push(truncateToWidth(theme.fg("dim", "  … " + model.overflow + " more"), width));
			}
			return lines;
		},
	}));
}

function prepareSubagentWidgetModel(state: SubagentsLiveStateEvent): SubagentWidgetModel {
	let running = 0;
	let retrying = 0;
	let planned = 0;
	let total = 0;
	const rows: SubagentWidgetRow[] = [];
	for (const run of state.runs) {
		const previews = new Map((run.tasks ?? []).map((task) => [task.id, task]));
		for (const agent of run.agents) {
			total++;
			if (agent.status === "running") running++;
			else if (agent.status === "retrying") retrying++;
			else if (agent.status === "planned") planned++;
			if (rows.length < MAX_VISIBLE_AGENTS) {
				rows.push(Object.freeze({
					id: agent.id,
					status: agent.status,
					name: previewLabel(previews.get(agent.id), agent.id),
					activity: agent.lastActivity?.label?.trim() || undefined,
				}));
			}
		}
	}
	const counts = [
		running > 0 ? String(running) + " running" : undefined,
		retrying > 0 ? String(retrying) + " retrying" : undefined,
		planned > 0 ? String(planned) + " queued" : undefined,
	].filter((value): value is string => value !== undefined).join(" · ");
	return Object.freeze({ counts, rows: Object.freeze(rows), overflow: total - rows.length });
}

export function clearSubagentsNativeWidget(ctx: ExtensionContext | undefined): void {
	if (!ctx || !isNativePiTui(ctx)) return;
	setNativePiAboveWidget(ctx, SUBAGENTS_NATIVE_WIDGET_KEY, undefined);
}

function previewLabel(preview: AgentTaskPreview | undefined, agentId: string): string {
	if (!preview) return agentId;
	const task = preview.task?.replace(/\s+/g, " ").trim();
	return task ? preview.id + " · " + task : preview.id;
}
