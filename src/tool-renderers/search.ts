import type { ToolRendererMiddleware } from "./types.js";
import { argsRecord, formatArgsInline } from "./utils.js";

// Search tools (grep/Glob/find) show their arguments inline in the header. Rendering the
// arguments again as a muted body block (as defaultToolRender does) would dim the first output
// lines and duplicate the header, so these tools render the output only — like repo_* tools.
const PREFERRED_KEYS = ["pattern", "path", "glob", "type", "output_mode", "output_line_limit", "case_sensitive", "regex", "multiline", "-n", "context", "head_limit", "max_results"] as const;

export const renderSearchTool: ToolRendererMiddleware = (input) => {
	const args = argsRecord(input);
	const result = input.output || (input.status === "running" ? "running…" : "(empty)");
	const headerArgs = args ? formatArgsInline(args, PREFERRED_KEYS) : undefined;
	// Render the header arguments in the same color as the output body (statusForeground) so the
	// whole search block reads as a single uniform color instead of dimmed args + brighter output.
	const argsColor = input.colors?.statusForeground;
	return {
		...(headerArgs
			? {
					headerArgs,
					...(argsColor ? { headerArgsSegments: [{ start: 0, end: headerArgs.length, foreground: argsColor }] } : {}),
				}
			: {}),
		collapsedBody: input.output,
		expandedText: result,
	};
};
