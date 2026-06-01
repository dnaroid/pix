import type { AgentState } from "./lib.js";

export function formatAgentStatus(status: string): string {
	const icons: Record<string, string> = {
		planned: "[planned]",
		running: "[running]",
		retrying: "[retrying]",
		done: "[done]",
		failed: "[failed]",
		stopped: "[stopped]",
	};
	return icons[status] || `[${status}]`;
}

export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + "...";
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function statusGlyph(status: AgentState["status"]): string {
	if (status === "done") return "✓";
	if (status === "failed") return "✕";
	if (status === "stopped") return "■";
	if (status === "retrying") return "↻";
	if (status === "running") return "◐";
	return "○";
}

export function statusLabel(status: AgentState["status"]): string {
	return status === "running" ? "in progress" : status;
}

export function modelName(model?: string): string {
	if (!model) return "";
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}
