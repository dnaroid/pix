import type { ToolRendererMiddleware } from "./types.js";
import { argsRecord, formatArgsInline } from "./utils.js";

const PREFERRED_KEYS = ["target", "path", "args", "maxLines", "maxBytes"] as const;

export const renderRepoTool: ToolRendererMiddleware = (input) => {
	const args = argsRecord(input);
	if (!args) return undefined;
	const result = input.output || (input.status === "running" ? "running…" : "(empty)");
	return {
		headerArgs: formatArgsInline(args, PREFERRED_KEYS),
		collapsedBody: input.output,
		expandedText: result,
	};
};
