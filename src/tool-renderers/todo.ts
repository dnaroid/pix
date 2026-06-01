import type { ToolRendererMiddleware } from "./types.js";
import { renderWithArgsAndResult, stringArg } from "./utils.js";

export const renderTodoTool: ToolRendererMiddleware = (input) => {
	const action = stringArg(input, ["action"]);
	const subject = stringArg(input, ["subject"]);
	return renderWithArgsAndResult(input, {
		headerArgs: [action, subject].filter(Boolean).join(" · "),
		collapsedBody: input.output,
	});
};
