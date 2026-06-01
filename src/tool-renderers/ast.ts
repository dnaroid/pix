import type { ToolRendererMiddleware } from "./types.js";
import { compactCommand, renderWithArgsAndResult, stringArg } from "./utils.js";

export const renderAstTool: ToolRendererMiddleware = (input) => {
	const pattern = compactCommand(stringArg(input, ["pattern", "target", "command"]));
	return renderWithArgsAndResult(input, { headerArgs: pattern, collapsedBody: input.output });
};
