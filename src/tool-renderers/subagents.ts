import type { ToolRenderInput, ToolRendererMiddleware } from "./types.js";
import { argsRecord, renderWithArgsAndResult, stringArg } from "./utils.js";

export const renderSubagentsTool: ToolRendererMiddleware = (input) => {
	const action = stringArg(input, ["action"]);
	const args = argsRecord(input);
	const taskCount = Array.isArray(args?.tasks) ? args.tasks.length : undefined;
	const headerArgs = [action, taskCount != null ? `${taskCount} task${taskCount === 1 ? "" : "s"}` : undefined].filter(Boolean).join(" · ");
	const collapsedBody = taskCount != null
		? `${input.status === "running" ? "starting" : "started"} ${taskCount} subagent${taskCount === 1 ? "" : "s"}`
		: oneLineSummary(action, input);
	return renderWithArgsAndResult(input, { headerArgs, collapsedBody });
};

function oneLineSummary(action: string | undefined, input: ToolRenderInput): string {
	if (!input.output) return input.status === "running" ? "running…" : "done";
	if (input.isError) return firstLine(input.output);
	switch (action) {
		case "status": return compactStatus(input.output);
		case "result": return compactResult(input.output);
		case "wait": return compactStatus(input.output);
		case "stop": return firstLine(input.output);
		case "cleanup": return firstLine(input.output);
		default: return firstLine(input.output);
	}
}

function compactStatus(output: string): string {
	// Extract agent status lines into a compact one-liner
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return "done";
	const running = lines.filter((l) => /running/i.test(l)).length;
	const completed = lines.filter((l) => /completed|done/i.test(l)).length;
	const failed = lines.filter((l) => /failed|error/i.test(l)).length;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (completed > 0) parts.push(`${completed} completed`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.length > 0 ? parts.join(", ") : `${lines.length} agent${lines.length === 1 ? "" : "s"}`;
}

function compactResult(output: string): string {
	// Summarize: show first meaningful line
	const first = firstLine(output);
	// Truncate very long lines
	return first.length > 200 ? first.slice(0, 197) + "…" : first;
}

function firstLine(text: string): string {
	return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
