import type { ToolRendererMiddleware } from "./types.js";
import { argsAndResultExpandedText, compactCommand, renderWithArgsAndResult, stringArg } from "./utils.js";

export const renderShellTool: ToolRendererMiddleware = (input) => {
	const command = compactCommand(stringArg(input, ["command", "cmd", "script"]));
	if (!command) return undefined;
	const result = input.output || (input.status === "running" ? "running…" : "(empty)");

	if (isGitDiffCommand(command)) {
		return {
			headerArgs: command,
			bodyStyle: "diff",
			preserveAnsi: true,
			collapsedBody: input.output,
			expandedText: result,
		};
	}

	const expanded = argsAndResultExpandedText(input, `$ ${command}`);
	return {
		headerArgs: command,
		preserveAnsi: true,
		collapsedBody: input.output || `$ ${command}`,
		...expanded,
	};
};

export const renderExecTool: ToolRendererMiddleware = (input) => renderWithArgsAndResult(input);

function isGitDiffCommand(command: string): boolean {
	return /(?:^|[;&|()]\s*)git\b[^;&|()]*\bdiff\b/.test(command);
}
