import { resolveToolRule } from "../../config.js";
import { renderToolBlock } from "./tool-block-renderer.js";
import type { Entry, RenderedLine } from "../types.js";
import type { ConversationToolRenderOptions } from "./conversation-tool-renderer.js";

export function renderConversationShellEntry(
	entry: Extract<Entry, { kind: "shell" }>,
	width: number,
	options: ConversationToolRenderOptions,
): RenderedLine[] {
	const body = shellEntryBody(entry);
	return renderToolBlock({
		id: entry.id,
		toolName: "shell",
		headerArgs: entry.command,
		expanded: entry.expanded,
		status: entry.status,
		isError: shellEntryIsError(entry),
		output: body,
		collapsedBody: body,
		expandedText: body,
		preserveAnsi: true,
	}, resolveToolRule("shell", options.pixConfig.toolRenderer), width, options.colors, { superCompact: Boolean(options.superCompactTools) });
}

function shellEntryBody(entry: Extract<Entry, { kind: "shell" }>): string {
	const output = entry.output.trimEnd();
	const status = shellEntryStatusLine(entry);
	if (!output) return status;
	return `${output}\n${status}`;
}

function shellEntryStatusLine(entry: Extract<Entry, { kind: "shell" }>): string {
	return `\x1b[90m[pix] ${shellEntryStatusText(entry)}\x1b[0m`;
}

function shellEntryStatusText(entry: Extract<Entry, { kind: "shell" }>): string {
	if (entry.status === "running") return "running — submit editor text to send stdin, Ctrl-C to interrupt";
	if (entry.error) return `failed to start: ${entry.error}`;
	if (entry.signal) return `terminated by ${entry.signal}`;
	return `exit ${entry.exitCode ?? 0}`;
}

function shellEntryIsError(entry: Extract<Entry, { kind: "shell" }>): boolean {
	if (entry.status !== "done") return false;
	if (entry.error || entry.signal) return true;
	return (entry.exitCode ?? 0) !== 0;
}
